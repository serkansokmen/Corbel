# Corbel: notes for coding agents

Corbel is a local document Q&A workbench: a SvelteKit UI and API routes, BM25 retrieval, and a FastAPI backend that scores passages with the Laya decision model. It quotes verbatim passages Laya judges `supported`, or abstains. See [README.md](README.md) for the architecture and [CONTRIBUTING.md](CONTRIBUTING.md) for setup.

## Layers

| Layer | Files |
|---|---|
| UI | `src/routes/+page.svelte` |
| API routes | `src/routes/api/query/+server.ts`, `src/routes/api/health/+server.ts` |
| Retrieval | `src/lib/server/retrieval.ts`, `src/lib/limits.ts` |
| Backend | `backend/app.py`, `backend/batch.py`, `backend/serve.py` |

A limit, field, label or env variable that crosses layers must change in every layer and in the README in the same change. The contract map in `.claude/skills/corbel-contracts/SKILL.md` lists them.

## Checks

After any code change, run:

```bash
npm run verify
```

It runs the type check, the retrieval invariants and a backend contract smoke test against a fake model. No GPU, weights or running services are needed.

## Changes that affect answers

Chunking, BM25, the question Laya is asked, the model and its precision all change what Corbel cites. Measure them before and after on the labeled sets in `eval/datasets/`, with the scripts in `.claude/skills/corbel-eval/scripts/` (`validate_dataset.mjs`, `run_eval.mjs`, `compare.mjs`). `.claude/skills/corbel-eval/SKILL.md` explains the workflow and the rules. `run_eval.mjs` needs the backend running; report numbers with their n.

## Tooling

The skills and agent definitions under `.claude/` were written for Claude Code, but the scripts inside them are plain Node and Python, and the `SKILL.md` files are ordinary Markdown. Read and run them from where they are; do not copy them elsewhere.

## Rules

- Never commit or print `.env`, `.backend.env`, logs or `LAYA_API_KEY`.
- Do not edit a dataset in `eval/datasets/` that has produced a reported result; add a new versioned file.
- Corpus documents must be fictional.
- Intermediate files go in `_workspace/` (gitignored).
