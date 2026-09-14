"""Index each local encoder pair sequentially. Public progress contains aggregate counts only."""
import argparse
import json
import os
from pathlib import Path
import queue
import secrets
import sqlite3
import subprocess
import threading
import time
import urllib.error
import urllib.request

from export_models import MODELS, ROOT, slug
from siglip_beta import CHECKPOINTS, model_id
from dinov3 import MODEL_ID as DINO_MODEL_ID

HF_MODELS = {key: (model_id(key), size, 128, dimensions, 'apache-2.0')
             for key, (_, size, dimensions) in CHECKPOINTS.items()}
INDEX_MODELS = {**MODELS, **HF_MODELS, 'dinov3': (DINO_MODEL_ID, 224, 0, 768, 'DINOv3 License')}
DEFAULT_MODELS = tuple(CHECKPOINTS)

def save(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2), encoding='utf-8')
    temporary.replace(path)

class Server:
    def __init__(self, args, model, log):
        self.token = secrets.token_hex(32)
        env = dict(os.environ, NICEGAL_RPC_TOKEN=self.token,
                   NICEGAL_LOCAL_MODELS_DIR=str((ROOT / 'exports').resolve()),
                   NICEGAL_LOG='error', RUST_LOG='error')
        env.pop('NICEGAL_IMAGE_MODEL', None)
        command = [str(args.server), '--asset-database', str(args.state / 'assets.db'),
                   '--ocr-database', str(args.state / 'index.db'),
                   '--thumbnail-database', str(args.state / 'thumbnails.db'),
                   '--runtime-config', str(args.runtime_config), '--image-model', model]
        if args.provider:
            command += ['--execution-provider', args.provider]
        self.process = subprocess.Popen(command, cwd=args.server.parent, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        ready = queue.Queue()
        def read_stdout():
            for line in self.process.stdout:
                try:
                    item = json.loads(line)
                    if 'endpoint' in item:
                        ready.put(item)
                except ValueError:
                    pass
        threading.Thread(target=read_stdout, daemon=True).start()
        try:
            self.endpoint = ready.get(timeout=90)['endpoint']
            self.request('/v1/health')
        except Exception:
            self.close()
            raise RuntimeError('Server did not become ready; see private server log') from None

    def request(self, path, body=None):
        req = urllib.request.Request(self.endpoint + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Authorization': f'Bearer {self.token}', 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=180) as response:
            data = response.read()
            return json.loads(data) if data else None

    def close(self):
        if self.process.stdin:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=45)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=15)

def run_job(server, kind, root, emit, private_log, debug_limit=None):
    params = {'root': str(root)}
    if debug_limit is not None:
        params['debugLimit'] = debug_limit
    job = server.request('/v1/jobs', {'type': kind, 'params': params})
    job_id = job['jobId']
    while True:
        snapshot = server.request(f'/v1/jobs/{job_id}')
        # Never copy activeAssetPaths, error strings, or per-file diagnostics into public output.
        emit({'job': kind, 'status': snapshot['status'], 'phase': snapshot['phase'], 'progress': snapshot['progress']})
        if snapshot['status'] in ('completed', 'failed', 'cancelled'):
            if snapshot.get('error') or snapshot.get('errors'):
                private_log.write(json.dumps(snapshot) + '\n')
                private_log.flush()
            if snapshot['status'] != 'completed':
                raise RuntimeError('Indexing job did not complete; see private diagnostics')
            return snapshot['progress']
        if server.process.poll() is not None:
            raise RuntimeError('Server exited while indexing')
        time.sleep(5)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(os.environ['USERPROFILE']) / 'Pictures')
    parser.add_argument('--state', type=Path, help='Defaults to the desktop app databases in AppData')
    parser.add_argument('--runtime-config', type=Path)
    parser.add_argument('--report-dir', type=Path)
    parser.add_argument('--server', type=Path, default=ROOT.parent.parent / 'nicegal-server' / 'target' / 'release' / 'nicegal-server.exe')
    parser.add_argument('--provider', choices=['cpu', 'directml', 'openvino'])
    parser.add_argument('--models', nargs='+', choices=INDEX_MODELS, default=list(DEFAULT_MODELS))
    parser.add_argument('--debug-limit', type=int, help='Maximum pending images to embed per model')
    parser.add_argument('--select-model', choices=INDEX_MODELS, help='Select this evaluated model in the app after a successful run')
    args = parser.parse_args()
    if args.debug_limit is not None and args.debug_limit <= 0:
        parser.error('--debug-limit must be positive')
    if args.select_model and args.select_model not in args.models:
        parser.error('--select-model must be one of the models being indexed')
    args.root = args.root.absolute()
    regular_state = args.state is None
    args.state = (args.state or Path(os.environ['APPDATA']) / 'nicegal' / 'nicegal-server').resolve()
    args.runtime_config = (args.runtime_config or
        (Path(os.environ['LOCALAPPDATA']) / 'nicegal-server' / 'runtime.json' if regular_state else args.state / 'runtime.json')).resolve()
    args.report_dir = (args.report_dir or (ROOT / 'state' / 'pictures' if regular_state else args.state)).resolve()
    args.server = args.server.resolve()
    args.state.mkdir(parents=True, exist_ok=True)
    args.report_dir.mkdir(parents=True, exist_ok=True)
    # The launcher never enumerates or opens source files; the gallery service owns that work.
    for key in args.models:
        if key in MODELS:
            manifest = ROOT / 'exports' / slug(INDEX_MODELS[key][0]) / 'manifest.json'
            if not manifest.is_file():
                raise SystemExit(f'{key}: missing validated export')
    report = {'startedAt': time.time(), 'models': {}, 'status': 'running'}
    errors = False
    for key in args.models:
        model = INDEX_MODELS[key][0]
        def emit(update):
            report['models'][key] = update
            report['updatedAt'] = time.time()
            save(args.report_dir / 'progress.json', report)
            print(json.dumps({'model': key, **update}), flush=True)
        with (args.report_dir / f'{key}-private.log').open('a', encoding='utf-8') as log:
            server = None
            try:
                emit({'status': 'starting'})
                server = Server(args, model, log)
                if server.request('/v1/runtime')['imageModel']['activeModel'] != model:
                    raise RuntimeError('Server loaded the wrong model selection')
                emit({'status': 'serverReady'})
                run_job(server, 'catalogSync', args.root, emit, log)
                counts = run_job(server, 'imageEmbed', args.root, emit, log, args.debug_limit)
                emit({'status': 'completed', 'progress': counts})
                errors |= counts.get('failed', 0) > 0
            except Exception as error:
                # Network exceptions and server diagnostics can contain private paths.
                log.write(repr(error) + '\n')
                emit({'status': 'failed', 'message': 'See private diagnostics'})
                errors = True
            finally:
                if server:
                    server.close()
            if report['models'][key]['status'] == 'completed':
                database = args.state / (slug(model) + '.db')
                with sqlite3.connect(f'{database.as_uri()}?mode=ro', uri=True) as db:
                    count = db.execute('SELECT count(*) FROM image_embedding_state').fetchone()[0]
                emit({**report['models'][key], 'indexedTotal': count})
    # Initial app selection; future changes are persisted by the app's runtime API.
    selection = args.runtime_config.with_name('image-model.json')
    if args.select_model and not errors:
        save(selection, {'model': INDEX_MODELS[args.select_model][0]})
    elif not selection.exists():
        save(selection, {'model': INDEX_MODELS[args.models[0]][0]})
    report.update(status='completedWithErrors' if errors else 'completed', finishedAt=time.time())
    save(args.report_dir / 'progress.json', report)
    print(report['status'], flush=True)
    return 1 if errors else 0

if __name__ == '__main__':
    raise SystemExit(main())
