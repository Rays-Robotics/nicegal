"""Isolated SwinV2 precision experiment; only reads public catcopy images.

Use the isolated uv environment documented in quantize_swinv2_report.md.
Never changes the active model, HF cache, application, or private catalog.
"""
import argparse
from collections import Counter
import gc
import json
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import time

import numpy as np
import onnx
import onnxruntime as ort
from PIL import Image

from siglip_beta import CHECKPOINTS, REVISION, model_id, source_file

ROOT = Path(__file__).resolve().parent
STATE = ROOT / 'state' / 'swinv2-quantization'
KEY = 'swinv2-frozen'
PROMPTS = ['cat', 'dog', 'orange cat', 'black cat', 'white cat', 'animal',
           'cat, green eyes', 'cat, blue eyes', 'cartoon', 'anime', 'photo',
           'cat, sitting', 'cat, sleeping', 'cat, outdoors', 'close-up, face']


def images():
    corpus = ROOT.parent.parent / 'testdata' / 'catcopy'
    paths = sorted(p for p in corpus.iterdir() if p.suffix.lower() in {'.jpg', '.jpeg', '.png'})
    arrays = []
    for path in paths:
        with Image.open(path) as image:
            rgba = image.convert('RGBA')
            white = Image.new('RGBA', rgba.size, 'white')
            white.alpha_composite(rgba)
            rgb = white.convert('RGB')
            width, height = rgb.size
            scale = 448 / min(width, height)
            width, height = int(width * scale), int(height * scale)
            if max(width, height) > 448:
                scale = 448 / max(width, height)
                width, height = int(width * scale), int(height * scale)
            rgb = rgb.resize((width, height), Image.Resampling.BICUBIC)
            padded = Image.new('RGB', (448, 448), (0, 0, 0))
            padded.paste(rgb, ((448 - width) // 2, (448 - height) // 2))
            arrays.append((np.asarray(padded, dtype=np.float32).transpose(2, 0, 1) / 255 - .5) / .5)
    return np.stack(arrays)


def model_path(variant, kind):
    if variant == 'original':
        return Path(source_file(KEY, f'{kind}_encode.onnx'))
    return STATE / variant / f'{kind}_encode.onnx'


def convert(variant):
    from onnxconverter_common import float16
    from onnxruntime.quantization import quantize_dynamic, QuantType
    for kind in ('image', 'text'):
        destination = model_path(variant, kind)
        destination.parent.mkdir(parents=True, exist_ok=True)
        source = model_path('original', kind)
        if variant in {'fp16', 'fp16-mixed', 'fp16-layernorm'}:
            model = onnx.load(source)
            # encodings is both an intermediate and an extra graph output. The
            # converter's keep_io_types cast otherwise leaves its consumers
            # incorrectly typed. The application only consumes embeddings.
            outputs = [output for output in model.graph.output if output.name == 'embeddings']
            del model.graph.output[:]
            model.graph.output.extend(outputs)
            blocked = list(float16.DEFAULT_OP_BLOCK_LIST)
            if variant == 'fp16-mixed':
                blocked += ['ReduceL2', 'LayerNormalization', 'Softmax', 'Exp']
            if variant == 'fp16-layernorm':
                blocked += ['LayerNormalization']
            model = float16.convert_float_to_float16(model, keep_io_types=True, op_block_list=blocked)
            onnx.save(model, destination)
            del model
        elif variant == 'int8-dynamic':
            quantize_dynamic(str(source), str(destination), per_channel=True,
                             weight_type=QuantType.QInt8, op_types_to_quantize=['MatMul'])
        else:
            raise ValueError(variant)
        onnx.checker.check_model(str(destination))
        print(f'{variant}/{kind}: {destination.stat().st_size} bytes', flush=True)
        gc.collect()


def session(path, profile=False):
    if 'DmlExecutionProvider' not in ort.get_available_providers():
        raise RuntimeError('This experiment requires onnxruntime-directml')
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    options.enable_mem_pattern = False
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.log_severity_level = 3
    options.enable_profiling = profile
    options.profile_file_prefix = str(STATE / 'profile')
    return ort.InferenceSession(str(path), sess_options=options,
                               providers=['DmlExecutionProvider', 'CPUExecutionProvider'])


def normalized(raw):
    raw = raw.astype(np.float32)
    if not np.isfinite(raw).all():
        raise ValueError('Non-finite output')
    return raw / np.linalg.norm(raw, axis=-1, keepdims=True)


def evaluate(variant):
    from tokenizers import Tokenizer
    STATE.mkdir(parents=True, exist_ok=True)
    report = {'variant': variant, 'ortVersion': ort.__version__, 'providers': ort.get_available_providers(),
              'batch': 8, 'corpus': 'testdata/catcopy', 'precisionOnlyTiming': True}
    try:
        pixels = images()
        report['images'] = len(pixels)
        image_session = session(model_path(variant, 'image'))
        image_session.run(['embeddings'], {'pixel_values': pixels[:8]})
        runs = []
        vectors = None
        for run in range(3):
            output = []
            started = time.perf_counter()
            for index in range(0, len(pixels), 8):
                output.append(image_session.run(['embeddings'], {'pixel_values': pixels[index:index+8]})[0])
            elapsed = time.perf_counter() - started
            vectors = normalized(np.concatenate(output))
            runs.append(elapsed)
            print(f'{variant}: run {run+1}: {len(pixels)/elapsed:.2f} img/s', flush=True)
        np.save(STATE / f'{variant}-images.npy', vectors)
        single = normalized(image_session.run(['embeddings'], {'pixel_values': pixels[:1]})[0])
        report['batchSingleCosine'] = float(np.sum(single[0] * vectors[0]))
        report['imageSeconds'] = runs
        report['imageMedianPerSecond'] = len(pixels) / statistics.median(runs)
        del image_session
        gc.collect()
        tokenizer = Tokenizer.from_file(source_file(KEY, 'tokenizer.json'))
        ids = np.array([item.ids for item in tokenizer.encode_batch(PROMPTS)], dtype=np.int64)
        text_session = session(model_path(variant, 'text'))
        text_session.run(['embeddings'], {'input_ids': ids[:1]})
        started = time.perf_counter()
        text_vectors = normalized(text_session.run(['embeddings'], {'input_ids': ids})[0])
        report['textSeconds'] = time.perf_counter() - started
        np.save(STATE / f'{variant}-text.npy', text_vectors)
        report['bytes'] = {kind: model_path(variant, kind).stat().st_size for kind in ('image', 'text')}
        report['status'] = 'success'
    except Exception as error:
        report['status'] = 'failed'
        report['error'] = str(error)
    (STATE / f'{variant}-results.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2), flush=True)
    if report['status'] != 'success':
        raise SystemExit(1)


def quality(variant):
    reference = np.load(STATE / 'original-images.npy')
    candidate = np.load(STATE / f'{variant}-images.npy')
    ref_text = np.load(STATE / 'original-text.npy')
    cand_text = np.load(STATE / f'{variant}-text.npy')
    result = {}
    for name, left, right in [('image', reference, candidate), ('text', ref_text, cand_text)]:
        cosine = (left * right).sum(axis=1)
        result[name + 'Cosine'] = {'min': float(cosine.min()), 'mean': float(cosine.mean())}
    def retrieval(left, right):
        a, b = np.argsort(-left, axis=1), np.argsort(-right, axis=1)
        changed = a[:, 0] != b[:, 0]
        return {'top1Agreement': float(np.mean(a[:,0] == b[:,0])),
                'top10Overlap': float(np.mean([len(set(x[:10]) & set(y[:10])) / 10 for x,y in zip(a,b)])),
                'changedTop1BaselineMargins': [float(left[i,a[i,0]]-left[i,b[i,0]]) for i in np.flatnonzero(changed)],
                'maxCosineScoreDrift': float(np.max(np.abs(left-right)))}
    a, b = reference @ reference.T, candidate @ candidate.T
    np.fill_diagonal(a, -2)
    np.fill_diagonal(b, -2)
    result['imageRetrievalExcludingSelf'] = retrieval(a,b)
    result['textRetrievalBothConverted'] = retrieval(ref_text @ reference.T, cand_text @ candidate.T)
    result['textRetrievalImageOnlyConverted'] = retrieval(ref_text @ reference.T, ref_text @ candidate.T)
    (STATE / f'{variant}-quality.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result, indent=2))


def native(variant):
    """Run the existing Rust benchmark against an isolated HF cache, never the app cache."""
    cache = STATE / f'{variant}-hf-cache'
    snapshot = cache / 'models--deepghs--siglip_beta' / 'snapshots' / REVISION / 'smilingwolf' / CHECKPOINTS[KEY][0]
    snapshot.mkdir(parents=True, exist_ok=True)
    for name in ('image_encode.onnx', 'text_encode.onnx', 'meta.json', 'preprocessor.json', 'tokenizer.json'):
        source = model_path(variant, name.split('_')[0]) if name.endswith('_encode.onnx') else Path(source_file(KEY, name))
        shutil.copy2(source, snapshot / name)
    env = os.environ.copy()
    env['HF_HUB_CACHE'] = str(cache)
    env['HF_HOME'] = str(STATE / f'{variant}-hf-home')
    env['RUST_LOG'] = 'error,ort=off'
    root = ROOT.parent.parent
    executable = root / 'nicegal-server/target/release/deps/image_index-6fcef9b6e8224fab.exe'
    command = [str(executable), '--corpus', str(root / 'testdata/catcopy'), '--model', model_id(KEY),
               '--provider', 'directml', '--threads', '4', '--batch-size', '8', '--runs', '3', '--warmup-runs', '1']
    result = subprocess.run(command, cwd=root, env=env, capture_output=True, text=True)
    (STATE / f'{variant}-native.stdout').write_text(result.stdout, encoding='utf-8')
    (STATE / f'{variant}-native.stderr').write_text(result.stderr, encoding='utf-8')
    print(result.stdout)
    print(f'Native exit: {result.returncode}')
    if result.returncode:
        print(result.stderr)
        raise SystemExit(result.returncode)


def profile(variant):
    pixels = images()[:8]
    inference = session(model_path(variant, 'image'), profile=True)
    inference.run(['embeddings'], {'pixel_values': pixels})
    inference.run(['embeddings'], {'pixel_values': pixels})
    path = Path(inference.end_profiling())
    events = json.loads(path.read_text(encoding='utf-8'))
    counts = Counter()
    for event in events:
        args = event.get('args', {})
        if args.get('provider'):
            counts[(args['provider'], args.get('op_name', 'unknown'))] += 1
    report = [{'provider': provider, 'operator': op, 'executions': count}
              for (provider, op), count in sorted(counts.items())]
    (STATE / f'{variant}-placement.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    path.rename(STATE / f'{variant}-profile.json')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['convert', 'evaluate', 'quality', 'native', 'profile'])
    parser.add_argument('variant', choices=['original', 'fp16', 'fp16-mixed', 'fp16-layernorm', 'int8-dynamic'])
    args = parser.parse_args()
    {'convert': convert, 'evaluate': evaluate, 'quality': quality,
     'native': native, 'profile': profile}[args.action](args.variant)
