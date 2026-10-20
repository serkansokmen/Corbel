---
name: corbel-harness
description: "Orchestrates work on Corbel (the Laya evidence workbench): cross-layer changes with contract QA, building and verifying labeled eval question sets, running evaluations, choosing thresholds, and comparing runs. Use for any Corbel feature, fix or refactor that touches more than one of UI / api routes / retrieval / backend; for 'build an eval set', 'run the eval', 'is the threshold right', 'did this change help', 'audit the contracts'; and for follow-ups: re-run, update, redo only the analysis, extend the dataset, improve on the last result, compare with the previous run. Simple questions about the code can be answered directly."
---

# Corbel harness

Routes Corbel work to one of four flows. Each flow names its execution mode. Intermediate files go in `_workspace/` (gitignored); durable outputs go in `eval/` or the source tree.

| Flow | Trigger | Mode | Agents (`subagent_type` / `agentType`) | Skills |
|---|---|---|---|---|
| **A. Change** | feature, fix or refactor across layers | Mixed: persistent implementer + one-shot QA | `corbel-implementer` (name `implementer`), `corbel-contract-qa` | `corbel-contracts` |
| **B. Dataset** | build or extend an eval question set | Workflow | `eval-question-author`, `eval-label-verifier` | `corbel-eval` |
| **C. Evaluate** | run an eval, pick a threshold, compare runs | Script, then one-shot subagent | `eval-analyst` | `corbel-eval` |
| **D. Audit** | "check the contracts", "is everything consistent" | One-shot subagent | `corbel-contract-qa` | `corbel-contracts` |

A change that touches one layer and is a few lines (a copy edit, a style fix) doesn't need flow A: make it directly, then run `node .claude/skills/corbel-contracts/scripts/verify.mjs`.

## Step 0: existing work (every flow)

1. Check `_workspace/change/` (flow A) or `_workspace/eval/` (flows B, C).
   - Absent: start fresh.
   - Present and the user asks to fix or redo part of it: re-run only that step. Pass the existing file paths to the agent so it builds on them.
   - Present and the user brings a new task: move it to `_workspace/<flow>_<YYYYMMDD-HHMM>/` first, then start fresh.
2. Flow B: if `_workspace/eval/dataset_run.json` holds a `runId` and only one category needs redoing, edit the script and resume with `resumeFromRunId`; unchanged `agent()` calls return cached results.

## Flow A: Change

1. **Scope** (main agent). List the layers the change touches and the contract-map rows from `corbel-contracts` that it changes. Write both to `_workspace/change/00_scope.md`. If no row changes and only one layer is involved, use the direct path above instead.
2. **Implement.** **Mode: persistent agent.** `Agent(name: "implementer", subagent_type: "corbel-implementer", prompt: <the request + scope file path + "write notes to _workspace/change/01_implementer_notes.md">)`. Its first message lists its tools; if Edit or Bash is missing, do the implementation yourself.
3. **QA.** **Mode: one-shot subagent.** `Agent(subagent_type: "corbel-contract-qa", prompt: <scope path + notes path + "review the working-tree diff">)`. Save its report to `_workspace/change/02_qa_findings.md`.
4. **Fix loop**, at most 2 rounds. If the report has blocker or major findings: `SendMessage({to: "implementer"}, "Apply the findings in _workspace/change/02_qa_findings.md, re-run verify, append Round N to your notes")`. The implementer keeps its context, so name findings by number. Then run QA again with "re-check previous findings" and overwrite the findings file. After 2 rounds, stop and report what is still open; more rounds rarely converge.
5. **Close** (main agent). Run verify yourself and read the summary; do not rely on the agents' copies. Report: files changed, contract rows changed, verify result, QA findings fixed and open, and the "Not verified" list (anything needing the live GPU backend or a browser). If the change affects retrieval, chunking, `SUPPORT_QUESTION` or the model, offer flow C to measure it.

## Flow B: Dataset

**Mode: workflow.** Invoking this skill is consent to run the workflow below. Default: 4 authors + 1 verifier per category (8 agents). When the user asks for a thorough or high-stakes set, use `verifiers: 3` (majority of 3 must confirm; 16 agents).

1. **Inputs** (main agent). Settle with the user or from the request: dataset name, corpus spec (default `samples`), questions per category (default 10; the seed set shows the format), and whether to extend an existing file. Collect existing queries to avoid duplicates. Run `print_chunks.mjs --corpus <spec>` once to confirm the corpus loads.
2. **Run the workflow** with `args = { corpus, categories: [{category, count}], existing: [queries], verifiers }`:

```javascript
export const meta = {
  name: 'corbel-eval-dataset',
  description: 'Write labeled Corbel eval questions per category, then adversarially verify each label',
  phases: [
    { title: 'Author', detail: 'one eval-question-author per category' },
    { title: 'Verify', detail: 'eval-label-verifier tries to break every label' },
  ],
}

const QUESTIONS = { type: 'object', required: ['category', 'questions', 'syntheticDocuments'], properties: {
  category: { type: 'string' },
  questions: { type: 'array', items: { type: 'object', required: ['query', 'gold', 'rationale'], properties: {
    query: { type: 'string' }, rationale: { type: 'string' },
    gold: { type: 'array', items: { type: 'object', required: ['documentId', 'quote'], properties: {
      documentId: { type: 'string' }, quote: { type: 'string' } } } } } } },
  syntheticDocuments: { type: 'array', items: { type: 'object', required: ['id', 'text'], properties: {
    id: { type: 'string' }, text: { type: 'string' } } } } } }
const VERDICTS = { type: 'object', required: ['verdicts'], properties: {
  verdicts: { type: 'array', items: { type: 'object', required: ['index', 'status', 'reason'], properties: {
    index: { type: 'integer' }, status: { type: 'string', enum: ['confirmed', 'refuted', 'uncertain'] },
    reason: { type: 'string' } } } } } }

const verifiers = args.verifiers ?? 1
const avoid = (args.existing ?? []).length ? `\nDo not duplicate these existing questions:\n${args.existing.join('\n')}` : ''

const batches = await pipeline(
  args.categories,
  c => agent(
    `Write ${c.count} "${c.category}" questions for the Corbel eval set over corpus spec "${args.corpus}". ` +
    `Follow the corbel-eval skill and references/dataset-format.md. Use print_chunks.mjs to read passages.${avoid}`,
    { agentType: 'eval-question-author', label: `author:${c.category}`, phase: 'Author', schema: QUESTIONS }),
  batch => {
    if (!batch || !batch.questions.length) return null
    const synthetic = batch.syntheticDocuments.length
      ? `\nThese synthetic documents will be added to the corpus; treat them as part of it:\n${JSON.stringify(batch.syntheticDocuments)}` : ''
    return parallel(Array.from({ length: verifiers }, (_, v) => () => agent(
      `Verify these proposed "${batch.category}" questions against corpus spec "${args.corpus}". ` +
      `Verifier ${v + 1} of ${verifiers}: work independently.${synthetic}\n` +
      batch.questions.map((q, i) => `[${i}] ${JSON.stringify(q)}`).join('\n'),
      { agentType: 'eval-label-verifier', label: `verify:${batch.category}:${v + 1}`, phase: 'Verify', schema: VERDICTS })))
      .then(votes => ({ ...batch, votes: votes.filter(Boolean) }))
  })

const done = batches.filter(Boolean)
const missing = args.categories.map(c => c.category).filter(c => !done.some(b => b.category === c))
if (missing.length) log(`No verified batch for: ${missing.join(', ')}`)
const accepted = [], rejected = []
for (const b of done) b.questions.forEach((q, i) => {
  const ballots = b.votes.map(v => v.verdicts.find(x => x.index === i)).filter(Boolean)
  const yes = ballots.filter(x => x.status === 'confirmed').length
  const row = { ...q, category: b.category, reasons: ballots.map(x => `${x.status}: ${x.reason}`) }
  if (yes * 2 > verifiers) accepted.push(row); else rejected.push(row)
})
log(`${accepted.length} accepted, ${rejected.length} rejected or uncertain`)
const synthetic = done.flatMap(b => b.syntheticDocuments)
return { accepted, rejected, synthetic, missing }
```

3. **Write the dataset** (main agent), deterministically:
   - Save the workflow's `runId` to `_workspace/eval/dataset_run.json` and the return value to `_workspace/eval/01_workflow_result.json`.
   - Write each synthetic document referenced by an accepted gold quote to `eval/corpora/<dataset>-conflicts/<id>.md`, and extend the corpus spec to `<spec>,eval/corpora/<dataset>-conflicts`.
   - Give accepted questions ids `<dataset>-<a|p|u|c><nn>` and alternate `split` calibration/test within each category. Write `eval/datasets/<dataset>.jsonl` (or the `-vN` file when extending a dataset that already produced results).
   - Run `validate_dataset.mjs` on it. Drop questions with errors and record them; don't hand-fix labels the verifier did not see.
4. **Report**: per-category accepted/rejected counts, the rejection reasons (they show where the corpus is ambiguous), validator warnings, and the exact command for flow C.

## Flow C: Evaluate

1. **Backend check** (main agent). `curl -s http://127.0.0.1:5177/health` (or `LAYA_BACKEND_URL` from `.env`). If not `ready`, ask the user to start it with `./corbel.ps1 -BackendOnly`, or start it in the background yourself if they agree; the first start downloads about 800 MB of weights. Never run inference on CPU silently: if `/health` says `device: cpu`, say so in the report.
2. **Run** (script). `node .claude/skills/corbel-eval/scripts/run_eval.mjs --dataset <file> --corpus <spec> --out _workspace/eval/<run-name>`. Run it in the background when the set has more than about 50 questions. Use a descriptive run name (`seed-baseline`, `seed-chunk240`).
3. **Analyse.** **Mode: one-shot subagent.** `Agent(subagent_type: "eval-analyst", prompt: <run dir + "write the report to _workspace/eval/<run-name>/04_analyst_report.md"; for a comparison also the baseline dir and "run compare.mjs first">)`.
4. **Close** (main agent). Read the report and `summary.md` yourself. Give the user the headline numbers with n, the threshold recommendation and whether the set is large enough to trust it, the top failure causes, and the next experiment. Copy the report to `eval/reports/<YYYY-MM-DD>-<run-name>.md` if the user wants to keep it.

Re-running only the analysis: skip steps 1–2. Re-computing metrics with another target: `metrics.mjs --results ... --target-precision X`, no inference.

## Flow D: Audit

`Agent(subagent_type: "corbel-contract-qa", prompt: "Audit every boundary in the corbel-contracts checklist on the current tree, not just a diff.")`. Report its findings as-is. Offer flow A for any blocker or major finding; don't fix them inside the audit.

## Errors

| Situation | Action |
|---|---|
| Agent fails once | Retry once with the same inputs. If it fails again, continue without it and name the gap in the report. |
| Usage limit, auth expiry, permission denied | Don't retry; retries burn the remaining quota. Open the partial outputs, record what is missing in `_workspace/<flow>/MISSING.md`, report to the user with the reset time if known. Fill gaps only with facts you checked yourself, never with an agent's judgement you didn't see. |
| Workflow `agent()` returns null | Already filtered; `missing` lists categories with no batch. Re-run those categories alone, or report them. |
| Implementer stops responding | `SendMessage` once to ask for status. Then start `corbel-implementer` under the name `implementer-2` with the notes file path. |
| verify fails before any change | Record the baseline failure; judge the change by whether it adds failures. |
| Backend returns 503/500 during an eval | `run_eval.mjs` records the error per question and metrics excludes it. More than 10% errored: stop, check `backend.log`, re-run. |
| Validator errors after the workflow | Drop those questions and list them; never edit gold quotes by hand to make them pass. |
| Conflicting results (QA vs implementer, two verifiers) | Keep both with their sources; the majority rule decides labels, the main agent decides QA disputes by reading the code. |

## Test scenarios

**Normal, flow A.** Request: "Let users pick up to 12 candidates." Scope lists the `Candidates per query` row (UI select, `src/lib/limits.ts` `TOP_K_MAX`, `app.py max_length`, README) and the 32 KB body row. Implementer changes all of them and runs verify; the smoke test's worst-case check (topK max read from `src/lib/limits.ts`) now computes 12 × 600 CJK chars ≈ 38.5 KB and fails. QA reports it as a blocker with both file:line refs; round 1 raises the backend body limit or lowers `CHUNK_MAX`; verify passes; the report lists "probabilities for passages 9–10 not checked against the live model" under Not verified.

**Normal, flow B → C.** "Build a 10-per-category eval set over the samples and run it." Workflow returns 34 accepted, 6 rejected (two "unanswerable" questions were answered by the capture document). The main agent writes `eval/datasets/samples-v1.jsonl` and `eval/corpora/samples-v1-conflicts/`, and validation passes with paraphrase warnings. Backend is ready; `run_eval.mjs` writes `_workspace/eval/samples-v1-baseline/`; the analyst attributes most paraphrase failures to retrieval (no candidates) and recommends a threshold with its interval.

**Error, flow B.** The contradictory author returns null twice. `missing: ['contradictory']` is logged; the dataset is written from the other three categories; the report says the contradictory category is absent and why, and `metrics.mjs` shows "Conflicts surfaced: n/a".

**Error, flow C.** `/health` reports `offline`. The main agent doesn't run the eval; it asks the user to start `./corbel.ps1 -BackendOnly` and gives the exact `run_eval.mjs` command to run once it is ready.
