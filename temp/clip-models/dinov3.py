"""Validate the pinned DINOv3 B/16 ONNX export on the public catcopy corpus."""
import json
import shutil
import tempfile
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MODEL_ID = 'facebook/dinov3-vitb16-pretrain-lvd1689m'
REPO = 'onnx-community/dinov3-vitb16-pretrain-lvd1689m-ONNX'
REVISION = 'd704d636f7b114347fd2a9d6fecac5e1ef464db3'


def main():
    import numpy as np
    import onnx
    import onnxruntime as ort
    from huggingface_hub import hf_hub_download
    from PIL import Image, ImageOps
    files = {name: hf_hub_download(REPO, name, revision=REVISION) for name in
             ('onnx/model.onnx', 'onnx/model.onnx_data', 'preprocessor_config.json')}
    # HF snapshots use symlinks, which the checker's path-security policy rejects.
    # Check ordinary copies in the project's ignored scratch directory.
    (ROOT / 'state').mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=ROOT / 'state') as directory:
        for name in ('onnx/model.onnx', 'onnx/model.onnx_data'):
            shutil.copyfile(files[name], Path(directory) / Path(name).name)
        onnx.checker.check_model(str(Path(directory) / 'model.onnx'))
    config = json.loads(Path(files['preprocessor_config.json']).read_text())
    assert config['size'] == {'height': 224, 'width': 224}
    assert config['resample'] == 2 and not config['do_center_crop']
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    session = ort.InferenceSession(files['onnx/model.onnx'], sess_options=options,
                                   providers=['CPUExecutionProvider'])
    corpus = ROOT.parent.parent / 'testdata' / 'catcopy'
    paths = sorted(corpus.glob('*.jpg'))[:3]
    assert len(paths) == 3
    tensors = []
    for path in paths:
        with Image.open(path) as image:
            image = ImageOps.exif_transpose(image).convert('RGB')
            image = image.resize((224, 224), Image.Resampling.BILINEAR)
            pixels = np.asarray(image, dtype=np.float32) / 255
            pixels = (pixels - np.array(config['image_mean'], np.float32)) / np.array(config['image_std'], np.float32)
            tensors.append(pixels.transpose(2, 0, 1))
    def embed(batch):
        vectors = session.run(['pooler_output'], {'pixel_values': np.stack(batch)})[0]
        assert np.isfinite(vectors).all()
        assert vectors.shape == (len(batch), 768)
        return vectors / np.linalg.norm(vectors, axis=1, keepdims=True)
    vectors = embed(tensors)
    for i, tensor in enumerate(tensors):
        np.testing.assert_allclose(vectors[i], embed([tensor])[0], atol=2e-5, rtol=2e-4)
    # Specialize spatial dimensions only. For supported positive batches, reshape targets
    # contain no zero dimensions: allowzero=0 is equivalent and works around DirectML's
    # failure with the upstream export's allowzero=1 reshapes. Keep batch size dynamic.
    from export_models import slug
    export = ROOT / 'exports' / slug(MODEL_ID)
    export.mkdir(parents=True, exist_ok=True)
    manifest = export / 'manifest.json'
    manifest.unlink(missing_ok=True)
    shutil.copyfile(files['onnx/model.onnx_data'], export / 'model.onnx_data')
    graph = onnx.load(files['onnx/model.onnx'], load_external_data=False)
    # Observe every reshape target in the original graph, across the supported batch range.
    # This directly checks the condition that makes changing allowzero semantics equivalent.
    shape_names = sorted({node.input[1] for node in graph.graph.node if node.op_type == 'Reshape'})
    probe = onnx.ModelProto()
    probe.CopyFrom(graph)
    for name in shape_names:
        probe.graph.output.append(onnx.helper.make_tensor_value_info(name, onnx.TensorProto.INT64, [None]))
    probe_path = export / 'shape-probe.onnx'
    onnx.save(probe, probe_path)
    probe_session = ort.InferenceSession(str(probe_path), sess_options=options, providers=['CPUExecutionProvider'])
    for count in range(1, 9):
        batch = np.stack([tensors[i % len(tensors)] for i in range(count)])
        for shape in probe_session.run(shape_names, {'pixel_values': batch}):
            assert np.all(shape != 0), f'Zero reshape dimension in batch {count}'
    del probe_session
    probe_path.unlink()
    for axis in (2, 3):
        graph.graph.input[0].type.tensor_type.shape.dim[axis].dim_value = 224
    for node in graph.graph.node:
        if node.op_type == 'Reshape':
            for attribute in node.attribute:
                if attribute.name == 'allowzero':
                    attribute.i = 0
    onnx.save(graph, export / 'image.onnx')
    shutil.copyfile(files['preprocessor_config.json'], export / 'preprocessor_config.json')
    onnx.checker.check_model(str(export / 'image.onnx'))
    compatible = ort.InferenceSession(str(export / 'image.onnx'), sess_options=options,
                                      providers=['CPUExecutionProvider'])
    for count in range(1, 9):
        batch = np.stack([tensors[i % len(tensors)] for i in range(count)])
        original = session.run(['pooler_output'], {'pixel_values': batch})[0]
        actual = compatible.run(['pooler_output'], {'pixel_values': batch})[0]
        np.testing.assert_allclose(actual, original, atol=2e-4, rtol=2e-4)
    import urllib.request
    with urllib.request.urlopen('https://raw.githubusercontent.com/facebookresearch/dinov3/main/LICENSE.md', timeout=30) as response:
        (export / 'LICENSE.md').write_bytes(response.read())
    (export / 'NOTICE.txt').write_text('DINOv3 weights by Meta, ONNX export by onnx-community.\n'
        'Modified for Nicegal evaluation: fixed 224px spatial dimensions and equivalent nonzero reshape semantics.\n')
    hashes = {}
    for name in ('image.onnx', 'model.onnx_data', 'preprocessor_config.json'):
        with (export / name).open('rb') as stream:
            hashes[name] = hashlib.file_digest(stream, 'sha256').hexdigest()
    manifest.write_text(json.dumps({'modelId': MODEL_ID, 'dimensions': 768, 'contextLength': 0,
        'source': REPO, 'revision': REVISION, 'license': 'DINOv3 License',
        'imageSize': 224, 'compatibility': 'reshape-nonzero-v1', 'sha256': hashes}, indent=2))
    output = ROOT / 'state' / 'dinov3-fixtures'
    output.mkdir(parents=True, exist_ok=True)
    (output / 'image-tests.json').write_text(json.dumps([
        {'path': str(path.resolve()), 'embedding': vector.tolist()}
        for path, vector in zip(paths, vectors)], indent=2))
    print(json.dumps({'model': MODEL_ID, 'revision': REVISION, 'images': len(paths),
                      'dimensions': 768, 'batchParity': 'passed', 'fixtures': str(output)}))


if __name__ == '__main__':
    main()
