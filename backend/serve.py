import os
from pathlib import Path

import uvicorn


PLACEHOLDER_KEY = 'replace-with-a-random-shared-key'  # shipped in older copies of .backend.env.example
LOOPBACK = ('127.0.0.1', '::1', 'localhost')


def bind_error(host, key):
    """Why the backend must not start with this host and key, or None when it may."""
    if key.strip() == PLACEHOLDER_KEY:
        return ('LAYA_API_KEY in .backend.env is still the example placeholder. Delete .backend.env and rerun '
                './scripts/setup-backend.ps1, or set LAYA_API_KEY to a random key of at least 32 characters '
                '(empty is fine for a loopback bind).')
    if host not in LOOPBACK and len(key) < 32:
        return ('Remote binding requires a LAYA_API_KEY of at least 32 characters in .backend.env. Delete .backend.env '
                'and rerun ./scripts/setup-backend.ps1, or set LAYA_API_KEY to a random key of at least 32 characters.')
    return None


def main():
    config = Path(__file__).resolve().parents[1] / '.backend.env'
    if config.exists():
        for line in config.read_text(encoding='utf-8-sig').splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                os.environ.setdefault(key.strip(), value.strip())
    host = os.environ.get('LAYA_HOST', '127.0.0.1')
    error = bind_error(host, os.environ.get('LAYA_API_KEY', ''))
    if error:
        raise SystemExit(error)
    uvicorn.run('backend.app:app', host=host, port=int(os.environ.get('LAYA_PORT', '5177')),
                workers=1, limit_concurrency=8, timeout_keep_alive=5, proxy_headers=False)


if __name__ == '__main__':
    main()
