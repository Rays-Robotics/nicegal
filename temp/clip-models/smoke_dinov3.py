"""Exercise image-only search against the isolated public catcopy index."""
import base64
import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.parse import urlencode

from dinov3 import MODEL_ID, ROOT
from export_models import slug
from index_models import Server


def main():
    state = ROOT / 'state' / 'catcopy'
    corpus = (ROOT.parent.parent / 'testdata' / 'catcopy').resolve()
    args = SimpleNamespace(server=ROOT.parent.parent / 'nicegal-server' / 'target' / 'release' / 'nicegal-server.exe',
                           state=state, runtime_config=state / 'runtime.json', provider='directml')
    with sqlite3.connect(f'{(state / (slug(MODEL_ID) + ".db")).as_uri()}?mode=ro', uri=True) as db:
        examples = db.execute('SELECT asset_id, source_path FROM image_embedding_state ORDER BY asset_id LIMIT 2').fetchall()
    assert len(examples) == 2
    image_path = Path(examples[0][1]).resolve()
    assert image_path.is_relative_to(corpus), 'Only public catcopy files may be opened'
    expected = None
    for attempt in range(2):
        with (state / 'dino-search-smoke.log').open('a', encoding='utf-8') as log:
            server = Server(args, MODEL_ID, log)
            try:
                runtime = server.request('/v1/runtime')['imageModel']
                assert runtime['supportsTextQueries'] is False
                assert server.request('/v1/models')['clipText']['state'] == 'unsupported'
                def search(components):
                    return server.request('/v1/search', {'root': str(corpus), 'limit': 106,
                        'queries': [{'key': 'similar', 'type': 'image', 'imageQuery': {'components': components}}]})['queries'][0]
                result = search([{'assetId': examples[0][0]}])
                assert result['total'] == 106
                assert result['results'][0]['assetId'] == examples[0][0]
                assert server.request('/v1/models')['clipImage']['state'] == 'notLoaded'
                ranking = [hit['assetId'] for hit in result['results']]
                if expected is not None:
                    assert ranking == expected, 'Ranking changed across restart'
                expected = ranking
                if attempt == 0:
                    external = search([{'externalImage': {'bytesBase64': base64.b64encode(image_path.read_bytes()).decode()}}])
                    assert external['results'][0]['assetId'] == examples[0][0]
                    assert external['results'][0]['distance'] < 0.0001
                    signed = search([{'assetId': examples[0][0], 'weight': 1}, {'assetId': examples[1][0], 'weight': -0.2}])
                    assert signed['total'] == 106
                    for components in ([{'text': 'a cat'}], [{'assetId': examples[0][0]}, {'text': 'a cat'}]):
                        try:
                            search(components)
                            raise AssertionError('Text term was accepted')
                        except HTTPError as error:
                            assert error.code == 400
                            body = json.loads(error.read())
                            assert 'image examples only' in body['error']['message']
                    literal = server.request('/v1/search?' + urlencode({'root': str(corpus), 'type': 'simple', 'q': 'cat'}))
                    assert 'results' in literal
                assert server.request('/v1/models')['clipText']['state'] == 'unsupported'
            finally:
                server.close()
    print('DINOv3: 106 results; asset/external self-match, signed examples, text rejection, OCR search and restart stability passed.')


if __name__ == '__main__':
    main()
