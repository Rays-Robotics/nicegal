"""Inspect the three pinned DeepGHS SigLIP beta ONNX checkpoint pairs."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path

from huggingface_hub import hf_hub_download

ROOT = Path(__file__).resolve().parent
REPO = 'deepghs/siglip_beta'
REVISION = '03aa79c8a4a6c41e06ca87aa6e44fee563b2491d'
CHECKPOINTS = {
    'swinv2-frozen': ('siglip_swinv2_base_2025_02_22_18h56m54s', 448, 1024),
    'swinv2-unfrozen': ('siglip_swinv2_base_2025_05_02_22h02m36s', 448, 1024),
    'eva02': ('siglip_eva02_base_2025_05_02_21h53m54s', 420, 768),
}
FILES = ('image_encode.onnx', 'text_encode.onnx', 'meta.json', 'preprocessor.json', 'tokenizer.json')

def source_file(key, name):
    checkpoint = CHECKPOINTS[key][0]
    return hf_hub_download(REPO, f'smilingwolf/{checkpoint}/{name}', revision=REVISION)

def model_id(key):
    return f'{REPO}/smilingwolf/{CHECKPOINTS[key][0]}'

def describe(key):
    import onnx
    from tokenizers import Tokenizer
    size, dimensions = CHECKPOINTS[key][1:]
    metadata = json.loads(Path(source_file(key, 'meta.json')).read_text(encoding='utf-8'))
    stages = json.loads(Path(source_file(key, 'preprocessor.json')).read_text(encoding='utf-8'))['stages']
    tokenizer = Tokenizer.from_file(source_file(key, 'tokenizer.json'))
    if metadata['image_size'] != size or metadata['image_embedding_width'] != dimensions:
        raise ValueError(f'Unexpected metadata for {key}')
    report = {'modelId': model_id(key), 'revision': REVISION,
              'license': 'Apache-2.0', 'imageSize': size, 'dimensions': dimensions,
              'preprocessing': stages,
              'tokenizerMaxLength': tokenizer.truncation['max_length'],
              'tokenizerPadId': tokenizer.padding['pad_id'], 'graphs': {}}
    for kind in ('image', 'text'):
        filename = f'{kind}_encode.onnx'
        path = Path(source_file(key, filename))
        graph = onnx.load_model(str(path), load_external_data=False)
        onnx.checker.check_model(str(path))
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        report['graphs'][kind] = {'inputs': [
            {'name': x.name, 'shape': [d.dim_value if d.HasField('dim_value') else d.dim_param
                for d in x.type.tensor_type.shape.dim]} for x in graph.graph.input],
            'outputs': [{'name': x.name, 'shape': [d.dim_value if d.HasField('dim_value') else d.dim_param
                for d in x.type.tensor_type.shape.dim]} for x in graph.graph.output],
            'size': path.stat().st_size,
            'sha256': digest}
    return report

def validate(key):
    """Generate non-private native parity fixtures with the upstream ONNX graphs."""
    import numpy as np
    import onnxruntime as ort
    from PIL import Image
    from tokenizers import Tokenizer

    size = CHECKPOINTS[key][1]
    output = ROOT / 'state' / 'siglip-beta-fixtures' / key
    output.mkdir(parents=True, exist_ok=True)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    image_session = ort.InferenceSession(source_file(key, 'image_encode.onnx'),
                                         sess_options=options, providers=['CPUExecutionProvider'])
    corpus = ROOT.parent.parent / 'testdata' / 'catcopy'
    images = sorted(corpus.glob('*.jpg'))[:3]
    if len(images) != 3:
        raise ValueError('Expected three non-private catcopy images')
    image_cases = []
    for path in images:
        with Image.open(path) as original:
            rgb = original.convert('RGBA')
            white = Image.new('RGBA', rgb.size, 'white')
            white.alpha_composite(rgb)
            rgb = white.convert('RGB')
            width, height = rgb.size
            scale = size / min(width, height)
            width, height = int(width * scale), int(height * scale)
            if max(width, height) > size:
                scale = size / max(width, height)
                width, height = int(width * scale), int(height * scale)
            rgb = rgb.resize((width, height), Image.Resampling.BICUBIC)
            padded = Image.new('RGB', (size, size), (0, 0, 0))
            padded.paste(rgb, ((size - width) // 2, (size - height) // 2))
            pixels = np.asarray(padded, dtype=np.float32).transpose(2, 0, 1)
            pixels = (pixels / 255.0 - 0.5) / 0.5
        raw = image_session.run(['embeddings'], {'pixel_values': pixels[None, ...]})[0][0]
        vector = raw / np.linalg.norm(raw)
        if not np.isfinite(vector).all() or abs(np.linalg.norm(vector) - 1) > 1e-5:
            raise ValueError(f'Invalid image embedding for {key}')
        image_cases.append({'path': str(path.resolve()), 'embedding': vector.tolist()})
    (output / 'image-tests.json').write_text(json.dumps(image_cases), encoding='utf-8')
    del image_session

    tokenizer = Tokenizer.from_file(source_file(key, 'tokenizer.json'))
    prompts = ['a cat', 'a dog', 'cartoon cat with green eyes', '', 'orange fur and a white background']
    encoded = tokenizer.encode_batch(prompts)
    ids = np.asarray([item.ids for item in encoded], dtype=np.int64)
    if ids.shape != (len(prompts), 128):
        raise ValueError(f'Unexpected token shape: {ids.shape}')
    text_session = ort.InferenceSession(source_file(key, 'text_encode.onnx'),
                                        sess_options=options, providers=['CPUExecutionProvider'])
    raw = text_session.run(['embeddings'], {'input_ids': ids})[0]
    normalized = raw / np.linalg.norm(raw, axis=-1, keepdims=True)
    if not np.isfinite(normalized).all():
        raise ValueError(f'Invalid text embeddings for {key}')
    cases = [{'text': prompt, 'ids': token_ids.tolist(), 'embedding': embedding.tolist()}
             for prompt, token_ids, embedding in zip(prompts, ids, normalized)]
    (output / 'text-tests.json').write_text(json.dumps(cases), encoding='utf-8')
    print(f'{key}: {len(image_cases)} catcopy image and {len(cases)} text fixtures', flush=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download', action='store_true')
    parser.add_argument('--inspect', action='store_true')
    parser.add_argument('--validate', action='store_true')
    args = parser.parse_args()
    if args.download:
        jobs = [(key, name) for key in CHECKPOINTS for name in FILES]
        with ThreadPoolExecutor(max_workers=4) as pool:
            tasks = {pool.submit(source_file, key, name): (key, name) for key, name in jobs}
            for task in as_completed(tasks):
                key, name = tasks[task]
                path = Path(task.result())
                print(f'{key}/{name}: {path.stat().st_size} bytes cached', flush=True)
    if args.inspect:
        results = [describe(key) for key in CHECKPOINTS]
        path = ROOT / 'state' / 'siglip-beta-inspection.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(results, indent=2), encoding='utf-8')
        print(f'Graph metadata validated: {path}', flush=True)
    if args.validate:
        for key in CHECKPOINTS:
            validate(key)
