# Corbel

Corbel is a local document Q&A workbench built around [Laya](https://huggingface.co/convaiinnovations/laya), a decision model that scores a fixed answer space instead of generating text. You load plain-text or Markdown documents, ask a question, and the app returns verbatim source passages that Laya judges as supporting the answer. If nothing clears the acceptance threshold, it abstains. No language model writes the displayed answer.

The point of the project is to inspect the decision, not to hide it: every candidate passage, its BM25 score, the full supported / partial / irrelevant distribution, the exact text the model evaluated, and the timing are visible and exportable.

## Architecture

```
Browser (SvelteKit UI, documents in localStorage)
   |  POST /api/query  { query, documents, threshold, topK }
   v
SvelteKit server (adapter-node)
   |  chunk documents -> BM25 -> top-K passages
   |  POST /score  (Bearer LAYA_API_KEY)
   v
FastAPI backend (backend/app.py)
   |  one batched forward pass over all passages
   v
Laya 0.3.5 (English checkpoint, ModernBERT encoder + decision head), CUDA
```

Pipeline steps:

1. **Chunk.** Documents are split on paragraph boundaries. Short paragraphs (headings, one-liners) are merged up to about 320 characters. Paragraphs over 600 characters are windowed at sentence boundaries with an 80-character overlap. Every chunk keeps its character offset into the source document. See `src/lib/server/retrieval.ts`.
2. **Retrieve.** BM25 over the chunks with a small English stopword list. Top-K candidates go to the backend: the UI offers 2, 4, 6 or 8, and `/api/query` accepts any integer from 1 to 8. This is a lexical baseline; paraphrases can be missed.
3. **Score.** The backend asks Laya one typed choice question per passage: does the passage explicitly contain enough information to answer the query? Options are `supported`, `partial`, `irrelevant`. All passages are batched into one forward pass.
4. **Decide.** The UI accepts passages whose P(supported) meets the threshold slider (0.50 to 0.99). Threshold changes re-evaluate the current run instantly without another inference call.

Chunk size matters. On the sample corpus, the same fact scored 0.90 as a standalone paragraph and 0.14 when the whole 700-character document was one passage. Keep passages short and focused.

## Two-machine layout

The GPU backend is intended to run on a workstation with an RTX 5090. The SvelteKit app can run on the same machine or on a laptop that reaches the workstation over the LAN. Everything stays on your network; documents are sent only to the backend you configure.

### Workstation (GPU backend)

Requirements: Windows, Python 3.12 (`uv` or `py` launcher), a current NVIDIA driver supporting CUDA 12.8. Blackwell cards need the CUDA 12.8 PyTorch build, which the setup script pins (`torch==2.10.0+cu128`).

```powershell
./scripts/setup-backend.ps1 -Device cuda -Model english
```

The script creates `.backend-venv`, installs PyTorch and `backend/requirements.txt`, runs a CUDA smoke test that prints the GPU name and compute capability, and writes `.backend.env` with a random 32-byte shared key. When the UI runs on the same machine, `./corbel.ps1` copies that key into `.env` for you. Copy `LAYA_API_KEY` by hand only when SvelteKit runs on a different machine.

Setup runs once. After that, `./corbel.ps1` is the only command you need: it starts the backend, waits for the model to report ready, then runs the UI in the foreground. Ctrl+C stops both. Before starting the UI it creates `.env` from `.env.example` if it is missing and writes `LAYA_BACKEND_URL=http://127.0.0.1:<LAYA_PORT>` and the `LAYA_API_KEY` from `.backend.env` into it, so a one-machine setup needs no manual `.env` editing. The key is never printed. `-BackendOnly` and `-Stop` do not write `LAYA_BACKEND_URL` or `LAYA_API_KEY`.

```powershell
./corbel.ps1
```

Useful flags: `-Model multilingual` switches the checkpoint and records it in both env files, `-BackendOnly` leaves the backend running without the UI, `-Stop` kills whatever is on either port, and `-NoBrowser` skips opening a tab. `corbel.bat` wraps the same script for double-clicking.

On first start it downloads about 800 MB of weights into the Hugging Face cache, warms up with one inference, and reports `ready` on `GET /health`. The backend refuses to bind to a non-loopback address without a key of at least 32 characters, refuses the placeholder key that older copies of `.backend.env.example` shipped (on any address), and it refuses to fall back to CPU silently when `LAYA_DEVICE=cuda`.

The backend listens on TCP port 5177 by default. Allow that port through the Windows firewall for the private network profile only.

### SvelteKit app

Requirements: Node 20.19+ (Vite 7). The evaluation and contract scripts under `.claude/skills/` need Node 22.18+, because they import the app's `.ts` files with Node's type stripping.

```powershell
npm install
copy .env.example .env
```

Skip the copy on a one-machine setup: `./corbel.ps1` creates `.env` and fills in `LAYA_BACKEND_URL` and `LAYA_API_KEY`. For a UI on a separate machine, edit `.env`:

| Variable | Meaning |
|---|---|
| `LAYA_BACKEND_URL` | `http://WORKSTATION_IP:5177`, or `http://127.0.0.1:5177` when both run on one machine |
| `LAYA_API_KEY` | Must match `LAYA_API_KEY` in the workstation's `.backend.env`. Never leaves the server side. |
| `LAYA_MODEL` | Informational label shown in the UI |

`./corbel.ps1` starts this for you. To run the UI on its own against a backend that is already up:

```powershell
npm run dev
```

Production build and run:

```powershell
npm run build
```

```powershell
$env:BODY_SIZE_LIMIT='1M'; $env:HOST='127.0.0.1'; node --env-file=.env build/index.js
```

The app is then at `http://127.0.0.1:3000`; set `PORT` to change the port. Each part of the command matters:

- `--env-file=.env`: the built server does not read `.env` by itself (only `npm run dev` does). Without it, `LAYA_API_KEY` and `LAYA_BACKEND_URL` are unset: a backend with a key answers `401`, and a UI on a separate machine calls `http://127.0.0.1:5177` instead of the workstation. Node stops with an error if `.env` is missing.
- `HOST=127.0.0.1`: the Node adapter binds `0.0.0.0` (every network interface) by default. `/api/*` has no login of its own and attaches the server-held `LAYA_API_KEY` to every backend call, so binding to any other address lets anyone who can reach the port run queries on your GPU backend. Change it only behind your own authentication.
- `BODY_SIZE_LIMIT=1M`: the Node adapter defaults to 512 KB, so without it a document library between 512 KB and 1 MB is rejected with `413` even though it is within the app's 1 MB limit.

The header badge polls `/api/health` and shows `connected`, `loading`, `error`, or `offline`. The Run query button is disabled until the backend reports ready.

## Backend configuration

`.backend.env` is read by `backend/serve.py` at startup, from the repository root. `setup-backend.ps1` writes it for you; `.backend.env.example` lists every variable. No other location is read, so a copy placed in `backend/` is ignored silently. Variables already set in the process environment take precedence.

| Variable | Default | Notes |
|---|---|---|
| `LAYA_DEVICE` | `cuda` | `cuda` or `cpu`. With `cuda`, loading fails loudly if CUDA is unavailable. |
| `LAYA_MODEL` | `english` | `english`, `multilingual`, or `typed-decisions` |
| `LAYA_PRECISION` | `bf16` | `bf16`, `fp16`, or `fp32`. Only applied on CUDA via autocast. |
| `LAYA_HOST` | `127.0.0.1` | Use `0.0.0.0` on the workstation to accept LAN clients |
| `LAYA_PORT` | `5177` | |
| `LAYA_API_KEY` | empty | Required for any non-loopback bind: a random key of at least 32 characters. `setup-backend.ps1` writes one only when `.backend.env` does not exist yet: to get a new one, delete `.backend.env` and rerun it, or set the key by hand. The old example placeholder `replace-with-a-random-shared-key` is refused. Compared in constant time. |
| `LAYA_REVISION` | empty | Optional Hugging Face commit hash to pin the checkpoint |

Endpoints:

- `GET /health` returns `{ status, model, device, precision, gpu, message }`.
- `POST /score` takes `{ query, passages[] }` with at most 8 passages of 1000 characters. Passages that exceed the model token budget are trimmed and flagged `truncated`. A second concurrent request gets `429` because inference is serialised on one GPU. Request bodies over 32 KB get `413`.

## Local CPU testing

You can run the whole stack on a laptop without a GPU to check the pipeline. Latency is 2 to 7 seconds per query on CPU and is not representative.

```powershell
./scripts/setup-backend.ps1 -Device cpu
```

Or, with an existing virtual environment that has `laya`, `fastapi`, and `uvicorn` installed, start the backend directly:

```powershell
$env:LAYA_DEVICE='cpu'; $env:LAYA_PRECISION='fp32'; $env:LAYA_HOST='127.0.0.1'; .venv/Scripts/python.exe -m backend.serve
```

With `LAYA_HOST=127.0.0.1` no API key is needed.

## Limits

- 30 documents, 50,000 characters each, 200,000 characters total, 1 MB request body. The production server (`node --env-file=.env build/index.js`) needs `BODY_SIZE_LIMIT=1M` for this; its default is 512 KB. These limits, and the question, Top-K and threshold limits below, live in `src/lib/limits.ts`, which `/api/query` and the evaluation scripts share.
- Up to 8 candidate passages per question (the UI offers 2, 4, 6 or 8; the API accepts 1 to 8). Acceptance threshold 0.50 to 0.99.
- Questions up to 500 characters.
- Runs are kept in browser storage, 20 most recent. Use Export runs for a JSON file that includes evaluated passages, scores, model revision, settings, and timings. Each run's `threshold` is the one stored with it (the threshold it was run at, or last reviewed at). Exporting a single run from the workbench also records the slider value on screen (`viewedThreshold`) and the ids of the passages accepted at it (`acceptedIds`).
- The sample corpus describes a fictional exhibition installation. Sample documents are flagged in the library and can be removed.

## What this does not do

Constrained output rules out invented prose. It does not rule out the wrong label, irrelevant evidence, or confident mistakes. The probabilities are not calibrated on your corpus; the SDK also clamps one of the checkpoint's shipped temperatures and warns about it at load time. Treat the threshold as a coverage control, not a correctness guarantee. A proper evaluation needs a fixed labeled question set with answerable, unanswerable, contradictory, and paraphrased questions, and separate calibration and test splits.

## Project layout

```
backend/app.py            FastAPI app, model loading, /health and /score
backend/batch.py          Batched per-passage scoring using Laya internals
backend/serve.py          Reads .backend.env and starts uvicorn
scripts/setup-backend.ps1 Creates .backend-venv, installs torch + deps, writes .backend.env
corbel.ps1                Starts backend + UI, waits for ready, stops both on Ctrl+C
src/lib/server/retrieval.ts  Chunking and BM25
src/routes/api/query/+server.ts  Validation, retrieval, proxy to /score
src/routes/api/health/+server.ts Health proxy
src/routes/+page.svelte   The whole UI: workbench, library, experiment log, architecture
src/lib/limits.ts         Request limits shared by /api/query and the eval scripts
src/lib/samples.ts        Sample corpus and example questions
```

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Vite dev server on 127.0.0.1 |
| `npm run build` | Production build to `build/` |
| `npm run check` | `svelte-check` type check |
| `npm start` | Runs `corbel.ps1`: backend, readiness wait, then the UI |
| `npm run backend` | Runs `corbel.ps1 -BackendOnly` |
