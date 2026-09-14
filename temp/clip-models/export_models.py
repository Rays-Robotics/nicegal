"""Local FP32 ONNX exports, with native-framework parity checks on non-private images."""
import argparse
import gc
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path

os.environ.setdefault('HF_HUB_DISABLE_PROGRESS_BARS', '1')
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
ROOT = Path(__file__).resolve().parent
MODELS = {
    'metaclip-b32': ('facebook/metaclip-2-worldwide-b32', 224, 77, 512, 'cc-by-nc-4.0'),
    'metaclip-b16': ('facebook/metaclip-2-worldwide-b16', 224, 77, 512, 'cc-by-nc-4.0'),
    'siglip2': ('google/siglip2-base-patch16-256', 256, 64, 768, 'apache-2.0'),
    'laion': ('laion/CLIP-ViT-B-32-laion2B-s34B-b79K', 224, 77, 512, 'mit'),
}

def slug(model):
    import re
    return re.sub('[^a-z0-9]+', '-', model.lower()).strip('-')

def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding='utf-8')

def export(key, corpus):
    import numpy as np
    import torch
    import onnx
    import onnxruntime as ort
    from PIL import Image, ImageOps
    from transformers import AutoModel, AutoTokenizer, AutoImageProcessor
    from huggingface_hub import model_info, hf_hub_download

    model_id, size, context, dimensions, license_id = MODELS[key]
    out = ROOT / 'exports' / slug(model_id)
    out.mkdir(parents=True, exist_ok=True)
    if (out / 'manifest.json').exists():
        print(f'{key}: already validated; skipping', flush=True)
        return
    revision = model_info(model_id).sha
    print(f'{key}: loading {model_id}@{revision}', flush=True)
    torch.set_num_threads(4)
    # The fused CPU MHA kernel has no legacy ONNX symbolic; use equivalent standard ops.
    torch.backends.mha.set_fastpath_enabled(False)
    torch.manual_seed(0)
    paths = sorted(p for p in corpus.iterdir() if p.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp'))[:7]
    if len(paths) < 2:
        raise ValueError('Need at least two non-private corpus images')
    images = []
    for path in paths:
        with Image.open(path) as source:
            images.append(ImageOps.exif_transpose(source).convert('RGB'))
    prompts = ['a photo of a cat', 'a photo of a dog', 'a car on a road', '', '猫 and café', 'a person ' * 100, 'two sleeping cats']

    if key == 'laion':
        import open_clip
        checkpoint = hf_hub_download(model_id, 'open_clip_model.safetensors', revision=revision)
        model, _, preprocess = open_clip.create_model_and_transforms(
            'ViT-B-32', pretrained=checkpoint, device='cpu', precision='fp32')
        model.eval()
        native_tokenizer = open_clip.get_tokenizer('ViT-B-32')
        tokenizer = AutoTokenizer.from_pretrained('openai/clip-vit-base-patch32')
        pixels = torch.stack([preprocess(im) for im in images])
        tokens = native_tokenizer(prompts)
        # OpenCLIP pads with zero, while the standard HF CLIP tokenizer pads with EOS.
        tokenizer.pad_token = '!'
        tokenizer.pad_token_id = 0
        hf_tokens = tokenizer(prompts, padding='max_length', truncation=True, max_length=context, return_tensors='pt')['input_ids']
        np.testing.assert_array_equal(tokens.numpy(), hf_tokens.numpy())
        mask = torch.ones_like(tokens)
        config = {'do_resize': True, 'size': {'shortest_edge': size}, 'do_center_crop': True,
                  'crop_size': {'height': size, 'width': size}, 'do_rescale': True,
                  'rescale_factor': 1/255, 'do_normalize': True, 'resample': 3,
                  'image_mean': list(open_clip.constants.OPENAI_DATASET_MEAN),
                  'image_std': list(open_clip.constants.OPENAI_DATASET_STD)}
    else:
        model = AutoModel.from_pretrained(model_id, revision=revision, attn_implementation='eager', torch_dtype=torch.float32).eval()
        tokenizer = AutoTokenizer.from_pretrained(model_id, revision=revision)
        processor = AutoImageProcessor.from_pretrained(model_id, revision=revision, use_fast=False)
        pixels = processor(images=images, return_tensors='pt')['pixel_values']
        encoded = tokenizer(prompts, padding='max_length', truncation=True, max_length=context, return_tensors='pt')
        tokens, mask = encoded['input_ids'], encoded.get('attention_mask', torch.ones_like(encoded['input_ids']))
        config = processor.to_dict()
    config['nicegal_preserve_aspect_ratio'] = key != 'siglip2'
    write_json(out / 'preprocessor_config.json', config)
    tokenizer.save_pretrained(out)
    tokenizer_config = json.loads((out / 'tokenizer_config.json').read_text(encoding='utf-8'))
    tokenizer_config.update(model_max_length=context, pad_token=tokenizer.pad_token)
    write_json(out / 'tokenizer_config.json', tokenizer_config)
    write_json(out / 'config.json', {'pad_token_id': tokenizer.pad_token_id})
    if not (out / 'special_tokens_map.json').exists():
        write_json(out / 'special_tokens_map.json', {})

    class ImageTower(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.base = model
        def forward(self, pixel_values):
            features = self.base.encode_image(pixel_values) if key == 'laion' else self.base.get_image_features(pixel_values=pixel_values)
            return torch.nn.functional.normalize(features, dim=-1)

    class TextTower(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.base = model
        def forward(self, input_ids, attention_mask):
            if key == 'laion':
                features = self.base.encode_text(input_ids)
            elif key == 'siglip2':
                features = self.base.get_text_features(input_ids=input_ids)
            else:
                features = self.base.get_text_features(input_ids=input_ids, attention_mask=attention_mask)
            return torch.nn.functional.normalize(features, dim=-1)

    report = {}
    references = {}
    for kind, wrapper, data, names in [
        ('image', ImageTower().eval(), (pixels,), ['pixel_values']),
        ('text', TextTower().eval(), (tokens, mask), ['input_ids', 'attention_mask']),
    ]:
        path = out / f'{kind}.onnx'
        output_name = f'{kind}_embeds'
        print(f'{key}: exporting {kind} tower', flush=True)
        with torch.no_grad():
            torch.onnx.export(wrapper, tuple(x[:2] for x in data), str(path), dynamo=False,
                opset_version=17, input_names=names, output_names=[output_name],
                dynamic_axes={name: {0: 'batch'} for name in names + [output_name]},
                external_data=True)
            references[f'{kind}_embeddings'] = wrapper(*data).numpy()
        onnx.checker.check_model(str(path))
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        session = ort.InferenceSession(str(path), sess_options=options, providers=['CPUExecutionProvider'])
        accepted = {item.name for item in session.get_inputs()}
        checks = []
        for batch in (1, 2, 7):
            sample = tuple(x[:batch] for x in data)
            with torch.no_grad():
                expected = wrapper(*sample).numpy()
            actual = session.run(None, {name: x.numpy() for name, x in zip(names, sample) if name in accepted})[0]
            assert actual.shape == (batch, dimensions) and np.isfinite(actual).all()
            np.testing.assert_allclose(actual, expected, atol=3e-4, rtol=3e-4)
            np.testing.assert_allclose(np.linalg.norm(actual, axis=1), 1, atol=3e-4)
            checks.append({'batch': batch, 'maxAbsoluteError': float(np.max(np.abs(actual-expected)))})
        report[kind] = checks
        del session
        gc.collect()
    np.savez(out / 'reference.npz', pixel_values=pixels.numpy(), input_ids=tokens.numpy(), attention_mask=mask.numpy(), **references)
    write_json(out / 'tokenizer-tests.json', [{'text': text, 'ids': ids, 'embedding': emb} for text, ids, emb in zip(prompts, tokens.tolist(), references['text_embeddings'].tolist())])
    write_json(out / 'image-tests.json', [{'path': str(path.resolve()), 'embedding': emb} for path, emb in zip(paths, references['image_embeddings'].tolist())])
    checksums = {}
    for path in sorted(out.iterdir()):
        if path.is_file() and path.suffix not in ('.npz',):
            with path.open('rb') as stream:
                checksums[path.name] = hashlib.file_digest(stream, 'sha256').hexdigest()
    write_json(out / 'manifest.json', {'modelId': model_id, 'revision': revision, 'dimensions': dimensions,
        'contextLength': context, 'imageSize': size, 'license': license_id, 'source': f'https://huggingface.co/{model_id}',
        'normalized': True, 'validation': report, 'filesSha256': checksums,
        'versions': {name: importlib.metadata.version(name) for name in ['torch', 'transformers', 'onnx', 'onnxruntime', 'open_clip_torch']}})
    print(f'{key}: export and numerical validation passed', flush=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', choices=MODELS, required=True)
    parser.add_argument('--corpus', type=Path, default=ROOT.parent.parent / 'testdata' / 'catcopy')
    args = parser.parse_args()
    export(args.model, args.corpus)
