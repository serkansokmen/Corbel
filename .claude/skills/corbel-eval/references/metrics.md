# Metric definitions

These match `scripts/metrics.mjs` exactly. "Accepted" means P(supported) ≥ threshold t. Candidates are sorted by probability, so the top accepted passage is the one with the highest P(supported).

## Per threshold (swept 0.50–0.99 in steps of 0.01)

| Metric | Over | Definition | Corbel behaviour it measures |
|---|---|---|---|
| Coverage | answerable + paraphrased | share with at least one accepted passage | How often it answers when it could |
| Precision when answered | answerable + paraphrased that were answered | share whose top accepted passage contains a gold quote | Whether the first quote shown is right |
| False answers | unanswerable | share with any accepted passage | How often it shows evidence when it should abstain |
| Shown-evidence precision | everything answered (answerable + paraphrased + unanswerable) | correct answers ÷ all answers | What a user sees: when Corbel shows a quote, how often it is right. This is the target for threshold choice |
| Accepted-passage precision | every accepted passage | share containing a gold quote | Noise in the accepted list beyond the top one |
| Conflicts surfaced | contradictory | share where accepted passages cover at least two gold quotes | Whether the reader gets to see the disagreement |

Every rate is reported as value, k/n and a 95% Wilson interval.

## Threshold-free

- **Recall@K**: share of non-unanswerable questions where any candidate (before thresholding) contains a gold quote. The ceiling for coverage: no threshold can accept a passage BM25 never retrieved.
- **Both sides retrieved** (`conflictRecallAtK`): share of contradictory questions whose candidates contain at least two gold quotes. The ceiling for conflicts surfaced. `compare.mjs` computes it from `results.jsonl`, so it also works for older runs.
- **No candidates**: questions where BM25 found no term overlap, so Laya was not called.
- **Partial only**: a candidate overlaps the gold quote's span but does not contain it, a chunking problem.
- **Heading only**: the gold quote lies in a Markdown heading line and no passage shows it (`HEADING_IN_PASSAGE`); a candidate from that heading's section was retrieved. A dataset problem; see `dataset-format.md`.
- **Truncated gold**: a gold-bearing candidate was cut to fit the token budget.

## Calibration (passage level)

Pairs (P(supported), contains-gold) over every scored candidate in a split. ECE uses 10 equal-width bins weighted by count; Brier is the mean squared error. The reliability bins in `metrics.json` show where the model is over- or under-confident. Laya is not calibrated on your corpus (README), so expect ECE well above 0.05; the useful question is whether it improves after a change.

## Threshold choice

On the calibration split, the smallest t whose shown-evidence precision ≥ target (default 0.9) with at least one answered question. The test split is reported at that t. If no t reaches the target, failures are reported at the UI default 0.80 and the summary says so.

## Failure kinds (`failures.jsonl`, test split at the chosen or default threshold)

| Kind | Meaning | Stage |
|---|---|---|
| `retrieval-miss` | Answerable, abstained, no candidate contains the gold | Retrieval |
| `chunk-split` | As above, but a candidate overlaps the gold span | Chunking |
| `heading-quote` | As above, but the gold quote is heading text the passages do not show, and a candidate from that section was retrieved | Dataset (quote the body instead) |
| `below-threshold` | Gold candidate was scored but under t; record has its probability, rank and distribution | Decision (or chunking if `partial` dominates) |
| `wrong-evidence` | Answered, but the top accepted passage is not gold | Decision |
| `false-answer` | Unanswerable, but something was accepted | Decision |
| `conflict-missed` | Contradictory, fewer than two gold quotes accepted | Retrieval or decision; check candidates |
