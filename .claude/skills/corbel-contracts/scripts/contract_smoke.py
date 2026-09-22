"""Backend contract smoke test for Corbel.

Runs without a GPU, model weights or httpx: it swaps in a fake Laya agent and a fake
backend.batch module, then drives the FastAPI app directly over ASGI. It checks the
response shape against src/lib/types.ts and every guard the README promises
(401/403/413/422/429/503, truncation).

Run from the repository root:
    .backend-venv/Scripts/python.exe .claude/skills/corbel-contracts/scripts/contract_smoke.py
"""
import asyncio
import json
import os
import re
import sys
import threading
import types
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))
os.environ['LAYA_API_KEY'] = ''  # start in loopback mode; the auth case patches the module variable

failures = []
warnings = []


def check(name, condition, detail=''):
    print(('PASS ' if condition else 'FAIL ') + name + ('' if condition else f'  -> {detail}'))
    if not condition:
        failures.append(name)


def warn(name, detail):
    print(f'WARN {name}  -> {detail}')
    warnings.append(name)


def ts_fields(source, type_name):
    match = re.search(r'export type ' + type_name + r' = (?:\w+ & )?\{(.*?)\};', source, re.S)
    if not match:
        raise SystemExit(f'Could not find type {type_name} in src/lib/types.ts')
    return {re.split(r'\??:', part.strip())[0] for part in match.group(1).split(';') if ':' in part}


def fake_predict_batch(agent, states):
    out = []
    for state in states:
        p = 0.9 if 'answer' in state['passage'] else 0.1
        out.append({'supported': p, 'partial': (1 - p) / 2, 'irrelevant': (1 - p) / 2})
    return out


fake_batch = types.ModuleType('backend.batch')
fake_batch.predict_batch = fake_predict_batch
sys.modules['backend.batch'] = fake_batch

import backend.app as backend_app  # noqa: E402  (must follow the fake module)

backend_app.agent = SimpleNamespace(cfg={'max_len': 512, 'head_max_len': 192},
                                    tok=SimpleNamespace(encode=lambda s: s.split()),
                                    device=SimpleNamespace(type='cpu'))


async def call(method, path, body=None, headers=None, client=('127.0.0.1', 50000)):
    raw = body if isinstance(body, bytes) else (json.dumps(body).encode() if body is not None else b'')
    scope = {'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1', 'method': method, 'scheme': 'http',
             'path': path, 'raw_path': path.encode(), 'query_string': b'', 'root_path': '',
             'headers': [(b'content-type', b'application/json'), (b'content-length', str(len(raw)).encode())] +
                        [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
             'client': client, 'server': ('127.0.0.1', 5177)}
    pending = [raw]
    sent = []

    async def receive():
        if pending:
            return {'type': 'http.request', 'body': pending.pop(), 'more_body': False}
        await asyncio.sleep(3600)

    async def send(message):
        sent.append(message)

    await asyncio.wait_for(backend_app.app(scope, receive, send), timeout=30)
    status = next(m['status'] for m in sent if m['type'] == 'http.response.start')
    payload = b''.join(m.get('body', b'') for m in sent if m['type'] == 'http.response.body')
    return status, (json.loads(payload) if payload else None)


def passage(i, text='This passage holds the answer.'):
    return {'id': f'doc:{i}', 'documentId': 'doc', 'title': 'Doc.md', 'text': text, 'offset': i * 10, 'lexicalScore': 1.5}


async def main():
    types_ts = (ROOT / 'src/lib/types.ts').read_text(encoding='utf-8')
    passage_fields = ts_fields(types_ts, 'Passage')
    evidence_fields = passage_fields | ts_fields(types_ts, 'Evidence')
    run_fields = ts_fields(types_ts, 'Run')
    health_fields = ts_fields(types_ts, 'Health')
    retrieval_ts = (ROOT / 'src/lib/server/retrieval.ts').read_text(encoding='utf-8')
    query_ts = (ROOT / 'src/routes/api/query/+server.ts').read_text(encoding='utf-8')
    app_py = (ROOT / 'backend/app.py').read_text(encoding='utf-8')
    chunk_max = int(re.search(r'CHUNK_MAX = (\d+)', retrieval_ts).group(1))
    top_k_max = int(re.search(r'topK > (\d+)', query_ts).group(1))
    backend_max = int(re.search(r'passages: list\[Passage\] = Field\([^)]*max_length=(\d+)', app_py).group(1))

    status, body = await call('GET', '/health')
    check('health returns 200', status == 200, status)
    check('health keys are a subset of the Health type', set(body) <= health_fields, set(body) - health_fields)

    backend_app.state['status'] = 'loading'
    status, _ = await call('POST', '/score', {'query': 'q', 'passages': [passage(0)]})
    check('score while loading returns 503', status == 503, status)

    backend_app.state.update(status='ready', precision='fp32', gpu=None, message='ok')
    status, _ = await call('GET', '/health')
    ready_keys = set(backend_app.state)
    check('ready health keys are a subset of the Health type', ready_keys <= health_fields, ready_keys - health_fields)

    status, body = await call('POST', '/score', {'query': 'What is it?', 'passages': [passage(0, 'Unrelated text.'), passage(1)]})
    check('valid score returns 200', status == 200, (status, body))
    if status == 200:
        evidence = body['evidence']
        check('evidence keys match the Evidence type exactly', all(set(e) == evidence_fields for e in evidence),
              [set(e) ^ evidence_fields for e in evidence])
        backend_run_keys = set(body) - {'evidence'}
        required = {'inferenceMs', 'model', 'revision', 'device', 'sdkVersion'}
        check('score response provides the Run fields SvelteKit forwards', required <= backend_run_keys, required - backend_run_keys)
        # +server.ts spreads the whole response into the Run, so extras reach the UI and exports untyped.
        if backend_run_keys - run_fields:
            warn('score response keys missing from the Run type', sorted(backend_run_keys - run_fields))
        check('evidence is sorted by probability, descending', [e['probability'] for e in evidence] == sorted((e['probability'] for e in evidence), reverse=True))
        check('distribution has exactly supported/partial/irrelevant', all(set(e['distribution']) == {'supported', 'partial', 'irrelevant'} for e in evidence))
        check('decision is the argmax label', all(e['decision'] == max(e['distribution'], key=e['distribution'].get) for e in evidence))
        check('untruncated passages are flagged truncated=false', all(e['truncated'] is False and e['evaluatedText'] == e['text'] for e in evidence))

    long_text = ('ab ' * 333)[:1000]
    status, body = await call('POST', '/score', {'query': 'What is it?', 'passages': [passage(0, long_text)]})
    if status == 200:
        e = body['evidence'][0]
        check('over-budget passage is truncated and flagged', e['truncated'] is True and long_text.startswith(e['evaluatedText']) and len(e['evaluatedText']) < len(long_text))
    else:
        check('over-budget passage is truncated and flagged', False, (status, body))

    status, _ = await call('POST', '/score', {'query': 'q', 'passages': [passage(i) for i in range(backend_max + 1)]})
    check(f'{backend_max + 1} passages returns 422', status == 422, status)
    status, _ = await call('POST', '/score', {'query': 'q', 'passages': [passage(0, 'x' * 1001)]})
    check('1001-character passage returns 422', status == 422, status)
    status, _ = await call('POST', '/score', {'query': 'q' * 501, 'passages': [passage(0)]})
    check('501-character query returns 422', status == 422, status)
    status, _ = await call('POST', '/score', b'{"pad":"' + b'x' * 33_000 + b'"}')
    check('body over 32 KB returns 413', status == 413, status)

    # The largest request SvelteKit can legally send must pass every backend limit.
    check(f'SvelteKit topK max ({top_k_max}) <= backend passage max ({backend_max})', top_k_max <= backend_max)
    cjk = '文'
    worst = {'query': cjk * 500, 'passages': [{'id': cjk * 120 + ':49999', 'documentId': cjk * 120, 'title': cjk * 150,
                                               'text': cjk * chunk_max, 'offset': 49_999, 'lexicalScore': 123.456789012345}
                                              for _ in range(top_k_max)]}
    worst_bytes = len(json.dumps(worst, ensure_ascii=False).encode('utf-8'))
    check(f'worst-case SvelteKit request ({top_k_max} x CHUNK_MAX={chunk_max} CJK chars, {worst_bytes} bytes) fits the 32 KB backend limit', worst_bytes <= 32_768, worst_bytes)

    backend_app.inference_lock.acquire()
    try:
        status, _ = await call('POST', '/score', {'query': 'q', 'passages': [passage(0)]})
        check('concurrent request returns 429', status == 429, status)
    finally:
        backend_app.inference_lock.release()

    status, _ = await call('GET', '/health', client=('192.168.1.20', 50000))
    check('remote client without a configured key returns 403', status == 403, status)

    backend_app.api_key = 'k' * 32
    try:
        status, _ = await call('GET', '/health')
        check('missing bearer token returns 401', status == 401, status)
        status, _ = await call('GET', '/health', headers={'Authorization': 'Bearer ' + 'k' * 32}, client=('192.168.1.20', 50000))
        check('correct bearer token from a remote client returns 200', status == 200, status)
    finally:
        backend_app.api_key = ''

    print(f'\n{len(failures)} failure(s), {len(warnings)} warning(s)' if failures else f'\nAll backend contract checks passed ({len(warnings)} warning(s)).')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
