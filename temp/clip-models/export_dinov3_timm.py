"""Export a separate DINOv3 Base candidate from pinned, public timm safetensors."""
import json
import hashlib
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import timm
import torch
from huggingface_hub import hf_hub_download
from PIL import Image, ImageOps
from safetensors.torch import load_file

ROOT = Path(__file__).resolve().parent
REPO = 'timm/vit_base_patch16_dinov3.lvd1689m'
REVISION = 'c6a5fb7d12bbd3cf3b0079253141c3332aaed7da'


def main():
    torch.set_num_threads(4)
    directory = ROOT / 'state' / 'dino-timm-export'
    directory.mkdir(parents=True, exist_ok=True)
    model = timm.create_model('vit_base_patch16_dinov3.lvd1689m', pretrained=False,
                              img_size=224, dynamic_img_size=False).eval()
    model.load_state_dict(load_file(hf_hub_download(REPO, 'model.safetensors', revision=REVISION, token=False)), strict=True)
    model.rope.periods = model.rope.periods.to(torch.bfloat16).to(torch.float32)
    model.rope.pos_embed_cached = model.rope._create_embed([14, 14], no_aug=True)
    model.rope.feat_shape = [14, 14]
    for block in model.blocks:
        block.attn.fused_attn = False

    class Encoder(torch.nn.Module):
        def __init__(self, backbone):
            super().__init__()
            self.backbone = backbone

        def forward(self, pixel_values):
            return self.backbone.forward_features(pixel_values)[:, 0]

    encoder = Encoder(model).eval()
    fixtures = json.loads((ROOT / 'state/dinov3-fixtures/image-tests.json').read_text())
    tensors = []
    for fixture in fixtures:
        with Image.open(fixture['path']) as source:
            image = ImageOps.exif_transpose(source).convert('RGB').resize((224, 224), Image.Resampling.BILINEAR)
            pixels = np.asarray(image, dtype=np.float32) / 255
            pixels = (pixels - np.array([.485, .456, .406], np.float32)) / np.array([.229, .224, .225], np.float32)
            tensors.append(pixels.transpose(2, 0, 1))
    batch = np.stack(tensors)
    with torch.inference_mode():
        reference = encoder(torch.from_numpy(batch)).numpy()
    normalized = reference / np.linalg.norm(reference, axis=1, keepdims=True)
    old = np.array([f['embedding'] for f in fixtures])
    cosine = np.sum(normalized * old, axis=1)
    print(json.dumps({'originalCosines': cosine.tolist()}), flush=True)
    assert cosine.min() > .9999, 'Candidate does not match existing DINO embeddings'
    path = directory / 'image.onnx'
    torch.onnx.export(encoder, (torch.from_numpy(batch[:1]),), str(path),
        input_names=['pixel_values'], output_names=['pooler_output'], opset_version=17,
        dynamo=False, dynamic_axes={'pixel_values': {0: 'batch'}, 'pooler_output': {0: 'batch'}})
    graph = onnx.load(path)
    onnx.checker.check_model(graph)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    session = ort.InferenceSession(str(path), sess_options=options, providers=['CPUExecutionProvider'])
    for size in range(1, 9):
        inputs = np.stack([tensors[i % len(tensors)] for i in range(size)])
        actual = session.run(['pooler_output'], {'pixel_values': inputs})[0]
        with torch.inference_mode():
            expected = encoder(torch.from_numpy(inputs)).numpy()
        np.testing.assert_allclose(actual, expected, atol=2e-4, rtol=2e-4)
    from collections import Counter
    report = dict(source=REPO, revision=REVISION, originalCosines=cosine.tolist(),
                  batchParity='1..8 passed', operators=dict(Counter(n.op_type for n in graph.graph.node)))
    (directory / 'validation.json').write_text(json.dumps(report, indent=2))
    for name in ('LICENSE.md', 'config.json'):
        (directory / name).write_bytes(Path(hf_hub_download(REPO, name, revision=REVISION, token=False)).read_bytes())
    model_id = 'facebook/dinov3-vitb16-pretrain-lvd1689m'
    from export_models import slug
    candidate = directory / 'exports' / slug(model_id)
    candidate.mkdir(parents=True, exist_ok=True)
    (candidate / 'manifest.json').unlink(missing_ok=True)
    (candidate / 'model.onnx_data').unlink(missing_ok=True)
    onnx.save_model(graph, str(candidate / 'image.onnx'), save_as_external_data=True,
                    all_tensors_to_one_file=True, location='model.onnx_data', size_threshold=1024)
    onnx.checker.check_model(str(candidate / 'image.onnx'))
    original = ROOT / 'exports' / slug(model_id)
    (candidate / 'preprocessor_config.json').write_bytes((original / 'preprocessor_config.json').read_bytes())
    (candidate / 'LICENSE.md').write_bytes((directory / 'LICENSE.md').read_bytes())
    (candidate / 'NOTICE.txt').write_text('DINOv3 weights by Meta, timm conversion by PyTorch Image Models.\n'
        'Nicegal evaluation export: fixed 224px, CLS output, original BF16-rounded RoPE periods, ONNX opset 17.\n')
    hashes = {}
    for name in ('image.onnx', 'model.onnx_data', 'preprocessor_config.json'):
        with (candidate / name).open('rb') as stream:
            hashes[name] = hashlib.file_digest(stream, 'sha256').hexdigest()
    assert all(a.i == 0 for n in graph.graph.node if n.op_type == 'Reshape'
               for a in n.attribute if a.name == 'allowzero')
    (candidate / 'manifest.json').write_text(json.dumps(dict(modelId=model_id, dimensions=768,
        contextLength=0, imageSize=224, compatibility='reshape-nonzero-v1', source=REPO,
        revision=REVISION, license='DINOv3 License', sha256=hashes), indent=2))
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
