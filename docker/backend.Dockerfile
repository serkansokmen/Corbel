# Laya scoring backend, CPU build. Build from the repository root:
#   docker build -f docker/backend.Dockerfile -t corbel-backend .
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# CPU wheels only: the CUDA build is several GB larger and a container without a GPU cannot use it.
RUN pip install "torch==2.10.0" --index-url https://download.pytorch.org/whl/cpu
COPY backend/requirements.txt backend/requirements.txt
RUN pip install -r backend/requirements.txt

COPY backend backend

# Model weights (about 800 MB) are downloaded on first start into /data, which should be a volume.
RUN useradd --create-home --uid 10001 corbel && mkdir -p /data && chown corbel:corbel /data
USER corbel

ENV LAYA_DEVICE=cpu \
    LAYA_PRECISION=fp32 \
    LAYA_MODEL=english \
    LAYA_HOST=0.0.0.0 \
    LAYA_PORT=5177 \
    HF_HOME=/data/huggingface

EXPOSE 5177
VOLUME /data

# 200 while loading as well as when ready; the UI shows the model status itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import os,urllib.request as u; u.urlopen(u.Request('http://127.0.0.1:5177/health', headers={'Authorization': 'Bearer ' + os.environ.get('LAYA_API_KEY', '')}), timeout=4)"

CMD ["python", "-m", "backend.serve"]
