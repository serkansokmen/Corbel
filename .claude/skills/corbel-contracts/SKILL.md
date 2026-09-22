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
| backend contract smoke | `/score` and `/health` shapes match `src/lib/types.ts`; 401/403/413/422/429/503 guards; truncation flag; the worst-case request SvelteKit can send (8 × `CHUNK_MAX` CJK chars) fits the 32 KB body limit | `scripts/contract_smoke.py` (fake Laya agent, drives the ASGI app directly; no httpx needed) |

Requirements: Node 22.18+ (the tests import `.ts` files via type stripping) and `.backend-venv` with fastapi. `--skip-typecheck` skips svelte-check for a faster loop.

The suite cannot see UI rendering, the export file, or anything that depends on real model probabilities. Say so when reporting; for model behaviour use `corbel-eval`.

`WARN` lines are drift that doesn't break anything yet (for example, a backend field that reaches the UI without being in the TypeScript type). Report them, but they don't fail the suite.

## Contract map

When you change a row, change every file in it, then run verify. Line numbers drift; search for the literal.

### Limits

| Contract | Value | Enforced in | Must agree with |
|---|---|---|---|
| Question length | 500 chars | `api/query/+server.ts` (`query.length > 500`), `backend/app.py` `ScoreRequest.query` | `+page.svelte` textarea `maxlength="500"`, README Limits |
| Candidates per query | 1–8 | `+server.ts` (`topK > 8`), `app.py` `passages max_length=8` | UI select `[2, 4, 6, 8]`, README |
| Threshold | 0.50–0.99 | `+server.ts` | UI slider `min="0.5" max="0.99"`, README, eval `metrics.mjs` grid |
| Documents | 30 docs, 50,000 chars each, 200,000 total | `+server.ts` | `+page.svelte` add/import guards and localStorage restore (`<= 30`), `maxlength="50000"`, README |
| SvelteKit body | 1 MB | `+server.ts` (content-length check + streaming reader, both 413) | adapter-node `BODY_SIZE_LIMIT` (default 512K; production must run with `BODY_SIZE_LIMIT=1M`, caught as 413 in `+server.ts`), README |
| Passage text | ≤ 1000 chars (backend), chunks ≤ `CHUNK_MAX` = 600 | `app.py` `Passage.text`, `retrieval.ts` | README Pipeline step 1, retrieval test |
| Passage id / documentId / title | 180 / 120 / 150 | `app.py` `Passage` | `+server.ts` document checks (id 120, title 150); chunk id = `${doc.id}:${offset}` must stay ≤ 180 |
| Backend body | 32 KB | `app.py` `authenticate` middleware | worst case from `CHUNK_MAX` × 8 (smoke test computes it) |
| Token budget | `max_len − head_max_len − 16` tokens | `app.py` `score_passages` (binary-search truncation) | `truncated` flag shown in UI and exported |
| Inference concurrency | 1 (else 429) | `app.py` `inference_lock` | `+server.ts` passes status through; eval `run_eval.mjs` retries 429 |
| Stored runs | 20 most recent | `+page.svelte` (`slice(0, 20)` twice) | README Limits |

### Shapes

| Contract | Producer | Consumers |
|---|---|---|
| `Passage` | `retrieval.ts` `chunk()` | `app.py` `Passage` model, `types.ts` |
| `Evidence` = Passage + `probability, decision, distribution, evaluatedText, truncated` | `app.py` `score_passages` | `types.ts`, `+page.svelte` (candidate list, inspector, `accepted`), export, eval `goldMatch` |
| `Run` | `+server.ts` (`base` + spread of the `/score` response + `latencyMs`) | `types.ts`, `+page.svelte`, localStorage `corbel-v1`, export `corbel-runs-v1` |
| `Health` | `app.py` `state` + `/api/health` adds `location` | `types.ts`, header badge |
| Label set `supported / partial / irrelevant` | `backend/batch.py` `SUPPORT_QUESTION.criteria` (order matters: logits `[:, :3]` are zipped with it) | `app.py` reads `distribution['supported']`, UI distribution bars, eval scripts |
| Error envelope | backend `{detail}` (string, but an array for FastAPI 422s and plain text for uvicorn's concurrency 503), SvelteKit `{error}` | `+server.ts` parses defensively, forwards `detail` only when it is a string, returns 502 for an unreadable success body; UI reads `result.error` |
| Env | `.backend.env` read by `backend/serve.py` (repo root only); `.env` read by SvelteKit | `corbel.ps1` creates `.env` if missing and copies `LAYA_API_KEY` and `LAYA_BACKEND_URL` into it (not with `-BackendOnly`); `.env.example`, `.backend.env.example`, `setup-backend.ps1`, README tables |

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
