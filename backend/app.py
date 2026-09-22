import os
from pathlib import Path

os.environ.setdefault('USE_TF', '0')
os.environ.setdefault('HF_HOME', str(Path(__file__).resolve().parents[1] / '.cache' / 'huggingface'))
os.environ.setdefault('HF_HUB_DISABLE_SYMLINKS_WARNING', '1')

import asyncio
import json
import logging
import math
import secrets
import threading
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

log = logging.getLogger('corbel')
agent = None
state = {'status': 'loading', 'model': os.environ.get('LAYA_MODEL', 'english'), 'device': os.environ.get('LAYA_DEVICE', 'cuda')}
api_key = os.environ.get('LAYA_API_KEY', '')
inference_lock = threading.Lock()
revision = ''
sdk_version = ''


def load_model():
    global agent, revision, sdk_version
    try:
        import laya
        import torch
        from huggingface_hub import snapshot_download
        from backend.batch import predict_batch

        torch.set_num_threads(min(8, os.cpu_count() or 4))
        requested_device = state['device']
        if requested_device.startswith('cuda') and not torch.cuda.is_available():
            raise RuntimeError('CUDA requested but unavailable. Install backend dependencies with setup-backend.ps1, or explicitly set LAYA_DEVICE=cpu.')
        if requested_device.startswith('cuda'):
            torch.set_float32_matmul_precision('high')
            torch.backends.cuda.matmul.allow_tf32 = True
        model = state['model']
        if model not in ('english', 'multilingual', 'typed-decisions'):
            raise ValueError('LAYA_MODEL must be english, multilingual, or typed-decisions')
        prefix = '' if model == 'english' else model + '/'
        snapshot = snapshot_download('convaiinnovations/laya', revision=os.environ.get('LAYA_REVISION') or None, allow_patterns=[prefix + item for item in ('rl_agent_config.json', 'model.safetensors', 'tokenizer/*', 'encoder/*')])
        revision = Path(snapshot).name
        agent = laya.load(str(Path(snapshot) / prefix), device=state['device'])
        if requested_device.startswith('cuda') and agent.device.type != 'cuda':
            raise RuntimeError('Laya fell back to CPU while loading; the GPU service will not silently run on CPU.')
        precision = os.environ.get('LAYA_PRECISION', 'bf16')
        if precision not in ('bf16', 'fp16', 'fp32'):
            raise ValueError('LAYA_PRECISION must be bf16, fp16, or fp32')
        if agent.device.type == 'cuda':
            agent.dtype = {'bf16': torch.bfloat16, 'fp16': torch.float16, 'fp32': torch.float32}[precision]
            if precision == 'bf16' and not torch.cuda.is_bf16_supported():
                raise RuntimeError('BF16 is unavailable on this GPU; set LAYA_PRECISION=fp16.')
        predict_batch(agent, [{'query': 'What is the display refresh rate?', 'passage': 'The display refresh rate is 60 Hz.'}])
        sdk_version = laya.__version__
        state.update(status='ready', device=str(agent.device), precision=str(agent.dtype).replace('torch.', ''), gpu=torch.cuda.get_device_name(agent.device) if agent.device.type == 'cuda' else None,
                     message='Model loaded and warmed up. Probabilities have not been calibrated on your corpus.')
    except Exception:
        log.exception('Laya model initialization failed')
        state.update(status='error', message='Model loading failed. Check the backend log and restart the service to retry.')


@asynccontextmanager
async def lifespan(app):
    loader = threading.Thread(target=load_model, daemon=True)
    loader.start()
    yield


app = FastAPI(title='Corbel', lifespan=lifespan)


@app.middleware('http')
async def authenticate(request: Request, call_next):
    if api_key:
        supplied = request.headers.get('authorization', '')
        if not secrets.compare_digest(supplied, 'Bearer ' + api_key):
            return JSONResponse({'detail': 'Backend API key is missing or incorrect.'}, status_code=401)
    elif not request.client or request.client.host not in ('127.0.0.1', '::1', 'localhost', 'testclient'):
        return JSONResponse({'detail': 'Configure LAYA_API_KEY before accepting remote connections.'}, status_code=403)
    # All request schemas are small. Limit raw bodies before JSON parsing.
    if request.method == 'POST':
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 32_768:
                return JSONResponse({'detail': 'Request body exceeds 32 KB.'}, status_code=413)
        request._body = bytes(body)
    return await call_next(request)


class Passage(BaseModel):
    id: str = Field(max_length=180)
    documentId: str = Field(max_length=120)
    title: str = Field(max_length=150)
    text: str = Field(min_length=1, max_length=1000)
    offset: int = Field(ge=0)
    lexicalScore: float = Field(ge=0, allow_inf_nan=False)


class ScoreRequest(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    passages: list[Passage] = Field(min_length=1, max_length=8)


@app.get('/health')
def health():
    return state


def score_passages(request):
    if not inference_lock.acquire(blocking=False):
        raise HTTPException(429, 'Laya is processing another query. Retry shortly.')
    try:
        started = time.perf_counter()
        evidence = []
        from backend.batch import predict_batch

        states = []
        evaluated = []
        budget = int(agent.cfg.get('max_len', 512)) - int(agent.cfg.get('head_max_len', 192)) - 16
        for passage in request.passages:
            text = passage.text
            # Count the serialized state exactly, preserving the question and a literal source prefix.
            def token_count(candidate):
                return len(agent.tok.encode(json.dumps({'query': request.query, 'passage': candidate}, ensure_ascii=False)))

            if token_count('') > budget:
                raise HTTPException(422, 'This question exceeds the model token budget. Shorten it and retry.')
            if token_count(text) > budget:
                low, high = 0, len(text)
                while low < high:
                    mid = (low + high + 1) // 2
                    if token_count(text[:mid]) <= budget:
                        low = mid
                    else:
                        high = mid - 1
                text = text[:low].rstrip()
            if not text:
                raise HTTPException(422, 'No passage context fits beside this question. Shorten the question.')
            states.append({'query': request.query, 'passage': text})
            evaluated.append(text)
        distributions = predict_batch(agent, states)
        for passage, text, distribution in zip(request.passages, evaluated, distributions):
            probability = float(distribution['supported'])
            if not math.isfinite(probability) or not 0 <= probability <= 1:
                raise ValueError('Invalid model probability')
            evidence.append({**passage.model_dump(), 'probability': probability, 'decision': max(distribution, key=distribution.get),
                             'distribution': distribution, 'evaluatedText': text, 'truncated': text != passage.text})
        evidence.sort(key=lambda item: item['probability'], reverse=True)
        return {'evidence': evidence, 'inferenceMs': round((time.perf_counter() - started) * 1000),
                'model': state['model'], 'revision': revision, 'device': state['device'], 'sdkVersion': sdk_version,
                'precision': state.get('precision'), 'gpu': state.get('gpu')}
    except HTTPException:
        raise
    except Exception:
        log.exception('Passage scoring failed')
        import torch
        if agent.device.type == 'cuda':
            torch.cuda.empty_cache()
        raise HTTPException(500, 'Model inference failed. Check the backend log; no answer was produced.')
    finally:
        inference_lock.release()


@app.post('/score')
async def score(request: ScoreRequest):
    if state['status'] != 'ready':
        raise HTTPException(503, state.get('message', 'Laya is downloading or loading its model. Retry when ready.'))
    return await asyncio.to_thread(score_passages, request)
