# Dataset format and authoring rules

## Line format (JSONL, one question per line)

```json
{"id":"seed-a01","split":"calibration","category":"answerable","query":"What time does the installation open and close?","gold":[{"documentId":"sample-operations","quote":"The installation opens daily at 09:00 and closes at 19:00."}],"notes":"optional free text"}
```

| Field | Rule |
|---|---|
| `id` | Unique in the file. Prefix by dataset (`seed-`, `ops-`), then category letter and number |
| `split` | `calibration` or `test`. Alternate within each category so both splits have every category in similar numbers |
| `category` | `answerable`, `paraphrased`, `unanswerable`, `contradictory` |
| `query` | 1–500 characters, the same limit the API enforces |
| `gold` | Passages that answer the question. `[]` for unanswerable; at least two for contradictory |
| `gold[].documentId` | Document id in the corpus (`sample-operations`, or a file name without extension) |
| `gold[].quote` | Verbatim text from that document, inside a single passage as printed by `print_chunks.mjs` |
| `notes` | Optional; never read by the scripts |

A candidate passage counts as gold when its evaluated text contains the quote (whitespace and case normalised). Keep quotes short, one sentence where possible, so that any passage containing the fact matches. A quote that spans two passages can never match, and the validator warns about it.

## Categories

**answerable**: the corpus states the answer in one passage, and the question uses the corpus's own vocabulary. Measures the easy case: retrieval should find it, Laya should accept it.

**paraphrased**: same as answerable, but the question shares as few content words with the gold passage as possible ("media PC" for "playback computer", "electricity cut" for "power"). Measures robustness of BM25 and Laya to wording. Many will be retrieval misses; that is the finding, not a dataset bug. The validator warns when more than half the question's content words appear in the quote.

**unanswerable**: the corpus does not contain the answer. Write near misses that share vocabulary with the corpus ("Which port does the printer listen on?" when the corpus lists ports for other devices), so that BM25 retrieves candidates and Laya must reject them. Off-topic questions ("What is the capital of France?") mostly test the stopword list, so keep them to a small minority. Correct behaviour is to abstain.

**contradictory**: two sources state different values for the same fact under the same conditions. Correct behaviour is to surface both, so the reader sees the conflict. The sample corpus has no conflicts; add short synthetic documents under `eval/corpora/<name>/` (clearly fictional, one fact each) and use `--corpus samples,eval/corpora/<name>`. Two statements about different conditions (winter hours vs summer hours) are not a contradiction.

## Authoring rules

- Answers must come from the passage alone: no outside knowledge, no arithmetic across passages, no opinion.
- If two passages both answer an answerable question, list both as gold. Otherwise accepting the unlisted one counts as wrong evidence.
- Spread questions across documents and facts. Five questions about one sentence measure one sentence.
- Size: at least 30 per category per split before treating metrics as more than directional. The seed set (16) is for smoke-testing the pipeline.
- Once a dataset has produced a reported result, do not edit it in place. Write `<name>-v2.jsonl` and record why.
