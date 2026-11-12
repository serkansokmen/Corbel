---
name: corbel-eval
description: "Measures how well Corbel cites or abstains on a labeled question set: dataset format and category rules, validation, running questions through the real retrieval + Laya pipeline, threshold sweep, calibration (ECE/Brier), recall@K, failure attribution, and before/after comparison. Use when building or checking an eval set, running an eval, choosing an acceptance threshold, checking calibration, or measuring whether a retrieval/chunking/model change helped. Not for type or contract checks; that is corbel-contracts."
---

# Corbel evaluation

Corbel's README says the threshold is a coverage control, not a correctness guarantee, and that a real evaluation needs a fixed labeled question set with answerable, unanswerable, contradictory and paraphrased questions, split into calibration and test. This skill is that evaluation.

Everything runs from the repository root. Scripts need Node 22.18+ because they import the app's own `retrieval.ts`, `samples.ts` and `limits.ts`, so the eval always chunks and ranks exactly like the app and rejects what `/api/query` would reject.

## Files

| Path | What lives there |
|---|---|
| `eval/datasets/<name>.jsonl` | Labeled question sets (committed). `samples-seed.jsonl` is a 16-question hand-labeled set over the sample corpus |
| `eval/corpora/<name>/` | Extra corpus documents as `.md`/`.txt`, e.g. synthetic conflict documents (committed) |
| `_workspace/eval/<run>/` | One run: `run.json`, `results.jsonl`, `metrics.json`, `failures.jsonl`, `summary.md` (not committed) |
| `eval/reports/<date>-<name>.md` | Analyst reports worth keeping (committed) |

A corpus spec is a comma-separated list: `samples` (the app's sample corpus) and/or directories. Example: `--corpus samples,eval/corpora/conflicts`. A document's id is its file name without extension.

## Workflow

1. **Write or extend a dataset.** Rules for each category and the line format are in `references/dataset-format.md`; read it before writing questions. To see the exact passages the app will build:
   ```bash
   node .claude/skills/corbel-eval/scripts/print_chunks.mjs --corpus samples
   ```
   Add `--query "..."` to see what BM25 retrieves for one question.

2. **Validate** before spending inference. Errors make metrics meaningless (they include a corpus or query that `/api/query` would reject: the checks come from the app's `src/lib/limits.ts`, so 30 documents, 50,000 characters each, 200,000 total, unique ids up to 120 characters, titles up to 150, queries 1 to 500 characters); warnings mean a question measures something else than intended (a gold quote split across chunks, a "paraphrase" that copies the source):
   ```bash
   node .claude/skills/corbel-eval/scripts/validate_dataset.mjs --dataset eval/datasets/samples-seed.jsonl --corpus samples
   ```

3. **Run.** Needs the backend at `LAYA_BACKEND_URL` from `.env` to report `ready` (`./corbel.ps1 -BackendOnly` starts it). One inference per question; the run is sequential because the backend serves one request at a time.
   ```bash
   node .claude/skills/corbel-eval/scripts/run_eval.mjs --dataset eval/datasets/samples-seed.jsonl --corpus samples --out _workspace/eval/seed-baseline
   ```
   Options: `--topK 1..8` (the API limit, checked before any inference; the UI offers 2/4/6/8; default 8, so the threshold sweep sees the most candidates), `--via ui` to go through `/api/query` on the SvelteKit server and exercise `+server.ts` too, `--target-precision 0.9`.

4. **Read the summary** (`summary.md`, also printed). Metric definitions and how to read them are in `references/metrics.md`. Recompute without inference after editing the scripts or the target:
   ```bash
   node .claude/skills/corbel-eval/scripts/metrics.mjs --results _workspace/eval/seed-baseline/results.jsonl --target-precision 0.95
   ```

5. **Compare** after a change (retrieval, chunk sizes, `SUPPORT_QUESTION` wording, model, precision, topK). Same dataset and corpus on both sides:
   ```bash
   node .claude/skills/corbel-eval/scripts/compare.mjs --a _workspace/eval/seed-baseline --b _workspace/eval/seed-after --threshold 0.8
   ```
   `run.json` records the chunker (`HEADING_IN_PASSAGE`, `CHUNK_TARGET`, `CHUNK_MAX`, a hash of `retrieval.ts`) and `startedAt`; compare warns when the two runs differ there or did not record it. Contradictory questions are listed when the number of accepted sides changes, not only the top passage.

## Rules that keep the numbers honest

- **Choose the threshold on calibration, report on test.** `metrics.mjs` does this: it picks the smallest threshold whose shown-evidence precision on the calibration split reaches the target, then reports the test split at that threshold. Looking at test numbers to pick a threshold makes the test split worthless.
- **Freeze a dataset once it has been used for a reported result.** Fix label errors by adding a new versioned file (`<name>-v2.jsonl`) and say so; silently editing labels changes past results.
- **Retrieval failures are not model failures.** If the gold passage never reached Laya (`retrieval-miss`, `chunk-split`, no candidates), the run says nothing about the model for that question. Report recall@K next to every decision metric.
- **Small sets are directional.** Every rate is printed with n and a 95% Wilson interval. Under roughly 30 questions per category, don't state a threshold to two decimals.
- **Probabilities are per passage.** Calibration is measured over every scored candidate (did P(supported) match how often the passage contains a gold quote), not over questions.
- **Don't print secrets.** `run_eval.mjs` reads `LAYA_API_KEY` from `.env` and never writes it out; keep it that way.
