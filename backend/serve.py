import os
from pathlib import Path

import uvicorn


def main():
    config = Path(__file__).resolve().parents[1] / '.backend.env'
    if config.exists():
        for line in config.read_text(encoding='utf-8-sig').splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                os.environ.setdefault(key.strip(), value.strip())
    host = os.environ.get('LAYA_HOST', '127.0.0.1')
    if host not in ('127.0.0.1', '::1', 'localhost') and len(os.environ.get('LAYA_API_KEY', '')) < 32:
        raise SystemExit('Remote binding requires a LAYA_API_KEY of at least 32 characters in .backend.env.')
    uvicorn.run('backend.app:app', host=host, port=int(os.environ.get('LAYA_PORT', '5177')),
                workers=1, limit_concurrency=8, timeout_keep_alive=5, proxy_headers=False)


if __name__ == '__main__':
    main()
