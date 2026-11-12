# Contributing to Corbel

Bug reports, eval questions, documentation fixes and code changes are all welcome. By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE).

## Setup

You need Node 22.18 or later and Python 3.12. No GPU is needed for the checks.

```bash
npm install
```

```bash
pip install "fastapi>=0.115,<1" "uvicorn>=0.34,<1"
```

```bash
npm run verify
```

`npm run verify` runs the type check, the retrieval invariants and a backend contract smoke test against a fake model. It needs no model weights and no running services. CI runs the same command on every pull request.

To run the whole app with the real model, follow the README. The launcher and setup scripts (`corbel.ps1`, `scripts/setup-backend.ps1`) are PowerShell and tested on Windows only. On Linux or macOS, start the backend with `python -m backend.serve` and the UI with `npm run dev`. Reports and fixes for other platforms are welcome.

## How the project is laid out

Corbel has four layers, and most bugs come from two of them disagreeing:

| Layer | Files |
|---|---|
| UI | `src/routes/+page.svelte` |
| API routes | `src/routes/api/query/+server.ts`, `src/routes/api/health/+server.ts` |
| Retrieval | `src/lib/server/retrieval.ts`, `src/lib/limits.ts` |
| Backend | `backend/app.py`, `backend/batch.py`, `backend/serve.py` |

The contract map in `.claude/skills/corbel-contracts/SKILL.md` lists every limit, field and env variable that more than one layer depends on. If you change one, change every row's files in the same pull request, and the README with them.

## Changes that affect answers

A change to chunking, BM25, the question Laya is asked, the model or its precision changes what Corbel cites. Measure it before and after on the labeled question sets:

```bash
node .claude/skills/corbel-eval/scripts/run_eval.mjs --dataset eval/datasets/handover-v1.jsonl --corpus eval/corpora/handover --out _workspace/eval/my-change
```

```bash
node .claude/skills/corbel-eval/scripts/compare.mjs --a _workspace/eval/baseline --b _workspace/eval/my-change --threshold 0.8
```

This needs the backend running. Put the numbers in the pull request with their n; the sets are small, so say "directional" when a cell has under 30 questions. `.claude/skills/corbel-eval/SKILL.md` explains the metrics and the rules (choose thresholds on the calibration split, never edit a dataset that has produced a reported result).

If you have no GPU, say so in the pull request and a maintainer will run the eval.

## Eval questions and corpora

New questions and corpora are a good first contribution. The format and the category rules are in `.claude/skills/corbel-eval/references/dataset-format.md`. Corpus documents must be fictional or your own to license; do not submit client documents, real names or real network details. Validate before opening a pull request:

```bash
node .claude/skills/corbel-eval/scripts/validate_dataset.mjs --dataset eval/datasets/<name>.jsonl --corpus <spec>
```

## Pull requests

- Keep one concern per pull request.
- Match the surrounding code: its naming, comment density and formatting.
- Fill in the "Not verified" section of the template honestly. A change that could not be tested against the real model or in a browser is fine to submit when it says so.
- Never commit `.env`, `.backend.env`, logs or anything containing `LAYA_API_KEY`.

## AI coding agents

The `.claude/` directory holds agent definitions and skills used to develop Corbel with Claude Code. They are optional. The scripts inside them are plain Node and Python and run without any agent.
