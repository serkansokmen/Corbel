---
name: corbel-contracts
description: "Contract map and offline verification for Corbel's layers: Svelte UI, /api/query and /api/health, retrieval.ts chunking/BM25, the FastAPI /score and /health endpoints, and Laya's token budget. Use before and after changing any request/response field, limit, chunk size, label set, error message or env variable in Corbel, and whenever asked to run Corbel's checks, tests or verify suite. Not for measuring answer quality on a question set; that is corbel-eval."
---

# Corbel contracts

Corbel has four layers that each enforce or consume the same limits and shapes. Each layer looks correct alone; bugs live where two of them meet. This skill lists every shared contract with the file that owns each side, and ships an offline suite that checks the ones a script can check.

## Run the checks

From the repository root, with no GPU, weights or running services:

```bash
node .claude/skills/corbel-contracts/scripts/verify.mjs
```

It runs three steps and prints a PASS/FAIL summary (exit 1 on any failure):

| Step | What it proves | Script |
|---|---|---|
| `npm run check` | Svelte and TypeScript type-check | package.json |
| retrieval invariants | Chunks map back to their source by offset, stay ≤ `CHUNK_MAX` and within backend limits, ids are unique, windows cover long paragraphs, `retrieve` returns ≤ topK positive scores in order, stopword-only queries never call Laya | `scripts/retrieval.test.mjs` |
| backend contract smoke | `/score` and `/health` shapes match `src/lib/types.ts`; 401/403/413/422/429/503 guards; truncation flag; the worst-case request SvelteKit can send (8 × `CHUNK_MAX` CJK chars) fits the 32 KB body limit; `serve.py` start-up key guard and `.backend.env.example` key | `scripts/contract_smoke.py` (fake Laya agent, drives the ASGI app directly; no httpx needed) |

Requirements: Node 22.18+ (the tests import `.ts` files via type stripping; the app itself needs Node 20.19+) and `.backend-venv` with fastapi. `--skip-typecheck` skips svelte-check for a faster loop.

The suite cannot see UI rendering, the export file, or anything that depends on real model probabilities. Say so when reporting; for model behaviour use `corbel-eval`.

`WARN` lines are drift that doesn't break anything yet (for example, a backend field that reaches the UI without being in the TypeScript type). Report them, but they don't fail the suite.

## Contract map

When you change a row, change every file in it, then run verify. Line numbers drift; search for the literal.

### Limits

| Contract | Value | Enforced in | Must agree with |
|---|---|---|---|
| Question length | 500 chars | `src/lib/limits.ts` `QUERY_MAX` / `checkQuery` (used by `api/query/+server.ts` and eval `validate_dataset.mjs`), `backend/app.py` `ScoreRequest.query` | `+page.svelte` (imports `limits.ts`): textarea `maxlength={QUERY_MAX}`, and `ask()` / Run query `disabled` call `checkQuery` (covers a long query `openRun` restores from a stored run), README Limits |
| Candidates per query | 1–8 | `limits.ts` `TOP_K_MAX` / `checkTopK` (used by `+server.ts` and `run_eval.mjs --topK`, checked before any inference), `app.py` `passages max_length=8` | UI select `[2, 4, 6, 8]`; README says "UI offers 2/4/6/8, API accepts 1–8" (Pipeline step 2 and Limits); smoke test reads `TOP_K_MAX` from `limits.ts` |
| Threshold | 0.50–0.99 | `limits.ts` `checkThreshold` (used by `+server.ts`) | UI slider `min="0.5" max="0.99"`, README, eval `metrics.mjs` grid |
| Documents | 30 docs, 50,000 chars each, 200,000 total, unique ids, non-empty text | `limits.ts` `checkDocuments` (used by `+server.ts`, `validate_dataset.mjs` as a corpus-level error, `run_eval.mjs` before the health check) | `+page.svelte` imports `limits.ts`: `addDocument` / `importFiles` check `DOCUMENT_CHARS_MAX` first (per-document message), then they and the `onMount` localStorage restore all call `checkDocuments` on the would-be library (restore also accepts an emptied `[]` library; a rejected one keeps the samples and sets `storageNotice`), import byte prefilter `DOCUMENT_CHARS_MAX * 4`, add/import reject C0 controls other than tab/LF/CR/BS/FF (`binaryControls`; each JSON-escapes to 6 bytes and could breach `BODY_MAX`), library toolbar text from `DOCUMENTS_MAX` / `CORPUS_CHARS_MAX`, text `maxlength={DOCUMENT_CHARS_MAX}`, title `maxlength={DOCUMENT_TITLE_MAX}` and import `slice(0, DOCUMENT_TITLE_MAX)` with a trailing unpaired high surrogate dropped (backend rejects invalid Unicode with 422); README |
| SvelteKit body | 1 MB | `limits.ts` `BODY_MAX`, applied in `+server.ts` (content-length check + streaming reader, both 413) | adapter-node `BODY_SIZE_LIMIT` (default 512K; production must run with `BODY_SIZE_LIMIT=1M`, caught as 413 in `+server.ts`), README |
| Production bind address | `127.0.0.1` | adapter-node `HOST` env (default `0.0.0.0`); nothing in code enforces it | README production command `$env:BODY_SIZE_LIMIT='1M'; $env:HOST='127.0.0.1'; node --env-file=.env build/index.js` and its explanation: `/api/*` has no auth and attaches the server-held `LAYA_API_KEY`, so any other bind exposes the GPU backend to whoever reaches the port |
| Passage text | ≤ 1000 chars (backend), chunks ≤ `CHUNK_MAX` = 600 | `app.py` `Passage.text`, `retrieval.ts` | README Pipeline step 1, retrieval test |
| Passage id / documentId / title | 180 / 120 / 150 | `app.py` `Passage` | `limits.ts` `DOCUMENT_ID_MAX` 120 / `DOCUMENT_TITLE_MAX` 150 via `checkDocuments` (UI title input and import title use the same constant); chunk id = `${doc.id}:${offset}` must stay ≤ 180 (smoke test builds its worst case from these constants) |
| Backend body | 32 KB | `app.py` `authenticate` middleware | worst case from `CHUNK_MAX` × 8 (smoke test computes it) |
| Token budget | `max_len − head_max_len − 16` tokens | `app.py` `score_passages` (binary-search truncation) | `truncated` flag shown in UI and exported |
| Inference concurrency | 1 (else 429) | `app.py` `inference_lock` | `+server.ts` passes status through; eval `run_eval.mjs` retries 429 |
| Stored runs | 20 most recent | `+page.svelte` (`slice(0, 20)` twice) | README Limits |

### Shapes

| Contract | Producer | Consumers |
|---|---|---|
| `Passage` | `retrieval.ts` `chunk()` | `app.py` `Passage` model, `types.ts` |
| `Evidence` = Passage + `probability, decision, distribution, evaluatedText, truncated` | `app.py` `score_passages` | `types.ts`, `+page.svelte` (candidate list, inspector, `accepted`), export, eval `goldMatch` |
| `Run` | `+server.ts` (spread of the `/score` response, then `base`, then `latencyMs`: app-owned `id, query, createdAt, threshold, topK, corpusSize, chunkCount` win over backend fields) | `types.ts`, `+page.svelte`, localStorage `corbel-v1`, export `corbel-runs-v1`. `threshold` is the stored threshold: set at query time, overwritten with the slider by `review()` (a review records the threshold the judgement was made at). Run log tag and bulk export use it. Single-run export (`ExportedRun` in `types.ts`) writes the stored run unchanged plus `viewedThreshold` (live slider) and `acceptedIds` (evidence ids with `probability >= viewedThreshold`), which match the workbench `accepted` list |
| `Health` | `app.py` `state` + `/api/health` adds `location` | `types.ts`, header badge |
| Label set `supported / partial / irrelevant` | `backend/batch.py` `SUPPORT_QUESTION.criteria` (order matters: logits `[:, :3]` are zipped with it) | `app.py` reads `distribution['supported']`, UI distribution bars, eval scripts |
| Error envelope | backend `{detail}` (string, but an array for FastAPI 422s and plain text for uvicorn's concurrency 503), SvelteKit `{error}` | `+server.ts` parses defensively, forwards `detail` only when it is a string, returns 502 for an unreadable success body; its catch-all returns 413 for an adapter-node body-limit error, 400 only for malformed JSON (`SyntaxError`) and for a client disconnect (`request.signal.aborted` or `ECONNRESET`, not logged), 500 (logged, generic message) for anything else; limit violations return 400 with `LIMITS_MESSAGE`. UI reads `result.error` and tolerates a non-JSON body (a reverse proxy's plain-text or HTML error page, e.g. a proxy 413 or 502): it shows a status-based message instead of a parse error |
| Env | In Docker, `docker/.env` feeds both containers through `docker/compose.yml` (`LAYA_API_KEY` to both, `LAYA_BACKEND_URL=http://backend:5177` fixed for the UI); neither container reads the files below. Outside Docker: `.backend.env` read by `backend/serve.py` (repo root only); `.env` read by SvelteKit in dev only, the production build reads it only through `node --env-file=.env build/index.js` | `corbel.ps1` creates `.env` if missing and copies `LAYA_API_KEY` and `LAYA_BACKEND_URL` into it (not with `-BackendOnly`); `.env.example`, `.backend.env.example` (empty `LAYA_API_KEY`), `setup-backend.ps1` (writes a random key), README tables. `serve.py` `bind_error` refuses the old placeholder `replace-with-a-random-shared-key` on any host and a key under 32 chars on a non-loopback host (smoke-tested) |

Persisted data has no migration path. Renaming a `Run` or `Evidence` field breaks runs already in users' localStorage and in exported JSON. Either keep the old name readable or bump `corbel-v1` / `corbel-runs-v1` and handle the old shape on load.

## Boundary checklist

For every boundary a change touches, open both sides and compare:

1. **UI → /api/query**: the request body built in `+page.svelte` matches what `+server.ts` validates, and UI-side guards allow nothing the server rejects (or the user gets a generic 400).
2. **/api/query → retrieval**: `retrieve(documents, query.trim(), topK)` gets what it expects; zero passages short-circuits without calling the backend.
3. **retrieval → /score**: every field `chunk()` emits fits the `Passage` model limits for any document `+server.ts` accepts, not just typical ones.
4. **/score → Laya**: the serialised state `{query, passage}` stays within the token budget; truncation keeps a literal prefix and sets `truncated`.
5. **/score response → Run → UI/export**: every field the UI reads exists in the response; every response field the UI or export relies on is in `types.ts`. `fetch().json()` is untyped, so svelte-check does not catch this.
6. **Errors**: each new failure path has a status code and a message the UI can show; the UI never shows "answer" content on an error.
7. **Docs**: README tables (Limits, Backend configuration, Endpoints, Scripts) still match.

## Updating this skill

If the code and this map disagree, the code is the truth. Fix the map in the same change, and add a check to `contract_smoke.py` or `retrieval.test.mjs` when the contract can be checked without the model.
