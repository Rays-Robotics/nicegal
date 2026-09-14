"""Run the native image-index benchmark with private traces and aggregate-only reports."""
import argparse
import csv
import datetime
import json
import os
from pathlib import Path
import sqlite3
import statistics
import subprocess
import time

from index_models import INDEX_MODELS, ROOT, save

MODELS = ('metaclip-b32', 'metaclip-b16', 'siglip2', 'swinv2-frozen',
          'swinv2-unfrozen', 'eva02', 'dinov3')
RUST_LOG = 'warn,ocrlocate=trace,nicegal_core=trace,nicegal_server=trace,image_index=trace,fastembed=trace,ort=trace,nom_exif=off'


def backup(source, destination):
    with sqlite3.connect(f'{source.as_uri()}?mode=ro', uri=True) as incoming:
        with sqlite3.connect(destination) as outgoing:
            incoming.backup(outgoing)


def parse_output(path):
    metadata = {}
    runs = []
    allowed = {'model', 'dimensions', 'configured_provider', 'threads', 'batch_size',
               'model_load_seconds', 'catalog_seconds', 'warmup_seconds', 'cataloged', 'image_limit'}
    for line in path.read_text(encoding='utf-8').splitlines():
        if '=' in line:
            key, value = line.split('=', 1)
            if key in allowed:
                metadata[key] = value
        else:
            fields = line.split(',')
            if len(fields) == 10 and fields[0].isdigit():
                runs.append(dict(run=int(fields[0]), provider=fields[1], threads=int(fields[2]),
                    batchSize=int(fields[3]), embedded=int(fields[4]), failed=int(fields[5]),
                    seconds=float(fields[6]), imagesPerSecond=float(fields[7]),
                    workingSetBytes=int(fields[8]) if fields[8].isdigit() else None,
                    peakWorkingSetBytes=int(fields[9]) if fields[9].isdigit() else None))
    return metadata, runs


def report_files(output, report):
    save(output / 'results.json', report)
    rows = []
    for key, result in report['models'].items():
        runs = result.get('runs', [])
        rows.append(dict(model=key, status=result['status'], runs=len(runs),
            images=min((run['embedded'] for run in runs), default=0),
            failures=sum(run['failed'] for run in runs),
            medianImagesPerSecond=round(statistics.median(run['imagesPerSecond'] for run in runs), 2) if runs else '',
            medianSeconds=round(statistics.median(run['seconds'] for run in runs), 2) if runs else '',
            peakProcessMiB=round(max((run['peakWorkingSetBytes'] or 0 for run in runs), default=0) / 1048576, 1),
            modelLoadSeconds=result.get('metadata', {}).get('model_load_seconds', ''),
            traceMiB=round(result.get('traceBytes', 0) / 1048576, 1)))
    with (output / 'results.csv').open('w', newline='', encoding='utf-8') as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]) if rows else ['model'])
        writer.writeheader()
        writer.writerows(rows)
    lines = ['# Image model benchmark', '',
        f"Up to {report['limit']} images per run; {report['runsPerModel']} runs per model; "
        f"{report['provider']}; batch {report['batchSize']}; {report['threads']} threads.", '',
        'All models use copies of one catalog snapshot, the same asset-ID ordering, fresh vector indexes, '
        'and a full-batch warmup. Timings include decoding, preprocessing, inference, SQLite writes, '
        'and tracing overhead. Model loading and warmup are measured separately. '
        'Memory is process working set, not GPU VRAM. This measures speed, not retrieval quality.', '',
        '| Model | Status | Images/run | Failed total | Median img/s | Median seconds | Peak process MiB |',
        '| --- | --- | ---: | ---: | ---: | ---: | ---: |']
    lines += [f"| {r['model']} | {r['status']} | {r['images']} | {r['failures']} | "
              f"{r['medianImagesPerSecond']} | {r['medianSeconds']} | {r['peakProcessMiB']} |" for r in rows]
    lines += ['', f"RUST_LOG: `{report['rustLog']}`", '', 'Private per-model traces are in `*-trace-private.jsonl`. They may contain source paths.', '']
    (output / 'results.md').write_text('\n'.join(lines), encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corpus', type=Path, default=Path(os.environ['USERPROFILE']) / 'Pictures')
    parser.add_argument('--asset-database', type=Path, default=Path(os.environ['APPDATA']) / 'nicegal' / 'nicegal-server' / 'assets.db')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--local-models-dir', type=Path, default=ROOT / 'exports')
    parser.add_argument('--limit', type=int, default=2000)
    parser.add_argument('--runs', type=int, default=3)
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--batch-size', type=int, default=8)
    parser.add_argument('--provider', choices=['cpu', 'directml', 'openvino'], default='directml')
    parser.add_argument('--models', nargs='+', choices=MODELS, default=list(MODELS))
    args = parser.parse_args()
    if min(args.limit, args.runs, args.threads, args.batch_size) < 1:
        parser.error('limit, runs, threads and batch size must be positive')
    executables = list((ROOT.parent.parent / 'nicegal-server' / 'target' / 'release' / 'deps').glob('image_index-*.exe'))
    if not executables:
        parser.error('Build the image_index benchmark first with dev.cmd bench --bench image_index --no-run')
    executable = max(executables, key=lambda path: path.stat().st_mtime)
    output = (args.output or ROOT / 'state' / 'benchmarks' / datetime.datetime.now().strftime('%Y%m%d-%H%M%S')).resolve()
    output.mkdir(parents=True, exist_ok=False)
    temporary = output / 'tmp'
    temporary.mkdir()
    baseline = output / 'catalog-private.db'
    backup(args.asset_database.resolve(), baseline)
    report = dict(status='running', limit=args.limit, runsPerModel=args.runs, threads=args.threads,
                  batchSize=args.batch_size, provider=args.provider, rustLog=RUST_LOG, startedAt=time.time(), models={})
    env = dict(os.environ, RUST_LOG=RUST_LOG, NICEGAL_LOCAL_MODELS_DIR=str(args.local_models_dir.resolve()),
               TEMP=str(temporary), TMP=str(temporary), TMPDIR=str(temporary))
    for key in args.models:
        private_catalog = output / f'{key}-catalog-private.db'
        backup(baseline, private_catalog)
        trace = output / f'{key}-trace-private.jsonl'
        stdout = output / f'{key}-stdout.log'
        report['models'][key] = dict(status='running')
        report_files(output, report)
        print(json.dumps(dict(model=key, status='starting', limit=args.limit, runs=args.runs)), flush=True)
        command = [str(executable), '--corpus', str(args.corpus.resolve()), '--model', INDEX_MODELS[key][0],
                   '--provider', args.provider, '--threads', str(args.threads), '--batch-size', str(args.batch_size),
                   '--runs', str(args.runs), '--warmup-runs', '1', '--limit', str(args.limit),
                   '--asset-database', str(private_catalog), '--trace-jsonl', str(trace)]
        with stdout.open('w', encoding='utf-8') as out, (output / f'{key}-stderr-private.log').open('w', encoding='utf-8') as err:
            process = subprocess.run(command, env=env, stdout=out, stderr=err,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        metadata, runs = parse_output(stdout)
        valid = process.returncode == 0 and len(runs) == args.runs and all(
            run['provider'] == args.provider and run['failed'] == 0 and run['embedded'] == args.limit for run in runs)
        report['models'][key] = dict(status='completed' if valid else 'needsAttention', metadata=metadata,
            runs=runs, exitCode=process.returncode, traceBytes=trace.stat().st_size if trace.exists() else 0)
        report_files(output, report)
        print(json.dumps(dict(model=key, status=report['models'][key]['status'], runs=runs)), flush=True)
    report.update(status='completed' if all(x['status'] == 'completed' for x in report['models'].values()) else 'needsAttention',
                  finishedAt=time.time())
    report_files(output, report)
    print(json.dumps(dict(status=report['status'], report=str(output / 'results.md'))), flush=True)
    return 0 if report['status'] == 'completed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
