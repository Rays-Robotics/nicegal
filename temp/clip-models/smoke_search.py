"""Search only the non-private catcopy corpus with each DeepGHS checkpoint."""
from types import SimpleNamespace
from urllib.parse import urlencode

from index_models import Server
from siglip_beta import CHECKPOINTS, ROOT, model_id

state = ROOT / 'state' / 'catcopy'
args = SimpleNamespace(
    server=ROOT.parent.parent / 'nicegal-server' / 'target' / 'release' / 'nicegal-server.exe',
    state=state,
    runtime_config=state / 'runtime.json',
    provider='cpu',
)
corpus = (ROOT.parent.parent / 'testdata' / 'catcopy').resolve()
for key in CHECKPOINTS:
    with (state / 'search-smoke.log').open('a', encoding='utf-8') as log:
        server = Server(args, model_id(key), log)
        try:
            query = urlencode({'q': 'a cat', 'type': 'image', 'root': str(corpus), 'limit': 10})
            result = server.request(f'/v1/search?{query}')
            hits = result['results']
            if not hits or any('assetId' not in hit for hit in hits):
                raise RuntimeError(f'{key}: no valid image-search results')
            print(f'{key}: {result["total"]} matching images; first five asset IDs '
                  f'{[hit["assetId"] for hit in hits[:5]]}', flush=True)
        finally:
            server.close()
