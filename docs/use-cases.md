# Corbel use-case scenarios

Corbel quotes verbatim passages that Laya judges `supported`, or abstains. That makes it useful wherever a wrong-but-fluent answer costs more than "I don't know", and where the reader needs to see the source to act. The scenarios below are the ones that fit, ordered by how directly the current app serves them.

Each scenario names who asks, what they ask, what a good answer looks like, what Corbel does today, and the gap. The evaluation corpus `eval/corpora/handover/` is a fictional handover pack for an installation called Tidewater (runbook, fault guide, venue technical sheet, privacy notice, support contract, change log, staff FAQ), built so that scenarios 1–4 can be measured with `eval/datasets/handover-v1.jsonl` and `handover-v1-conflicts.jsonl`.

## 1. On-site fault lookup

**Who:** the technician or venue staff member standing in front of a dark LED wall.
**Asks:** "The wall is black, what do I check?", "Which amplifier do I power-cycle?", "Can I open the wall to reseat a cable?"
**Good answer:** the exact step from the fault guide, with the document and position, in under a second. When the guide doesn't cover the fault, an abstention that says so, so they call support instead of improvising.
**Today:** the core case. Answerable questions in the corpus's own vocabulary mostly work.
**Gap:** staff don't use the runbook's vocabulary ("the big screen", "the handheld controller", "unlit strip"). BM25 is lexical, so paraphrased questions are the main loss (see Findings).

## 2. Front-of-house visitor questions

**Who:** gallery staff answering visitors.
**Asks:** "Am I being filmed?", "Is it safe for children?", "How long do you keep my data?"
**Good answer:** the privacy notice or FAQ sentence, quoted, so staff repeat the approved wording rather than paraphrasing a policy.
**Today:** works when the question matches the FAQ body.
**Gap:** FAQ documents put the question in a Markdown heading. The original chunker glued each heading onto the previous section's chunk, so the question words pointed at the wrong answer. Section-aware chunking fixed the retrieval side (see Findings); the retrieved answers still often score just under the threshold.

## 3. Handover and compliance cross-check

**Who:** a producer or project manager closing out an installation; a venue's compliance officer.
**Asks:** "What is the maximum wall brightness during public hours?", "How fast does the integrator respond to a fault?", "How long are diagnostic clips kept?"
**Good answer:** every source that states the value, side by side, so a conflict is visible. The handover pack has three planted, realistic ones: the runbook's Gallery preset allows 1200 nits while venue policy caps displays at 1000 nits; the contract promises a 4-hour response while the staff FAQ says one business day; the privacy notice deletes clips after 24 hours while the contract annex allows 72.
**Today:** acceptance is per passage against one threshold. Nothing in the UI tells the reader that two accepted passages disagree, and a conflict is surfaced only if both sides clear the threshold.
**Gap:** a conflict view: when accepted (or near-threshold) passages come from different documents and contain different numbers or times for the same question, show them together and flag it. Measured by the `contradictory` category.

## 4. Contract and SLA lookup

**Who:** account managers, producers.
**Asks:** "Is visitor damage covered?", "How much notice ends the agreement?", "What's in the spare parts kit?"
**Good answer:** the clause, verbatim. A paraphrase of a contract clause is worse than useless in a dispute.
**Today:** works for clauses written in the asker's vocabulary.
**Gap:** the same paraphrase gap as scenario 1, and unanswerable near misses ("How much does the support contract cost per year?") have to abstain even though BM25 retrieves contract passages.

## 5. Handover completeness check

**Who:** the studio, before handing an installation to a venue.
**Asks:** a fixed checklist of 30–50 questions every handover pack must answer (shutdown procedure, emergency behaviour, support contact, data retention, spare parts, warranty).
**Good answer:** a table: one row per question, the supporting quote or "not covered". Abstentions are the deliverable here: they are the documentation gaps to fill before handover.
**Today:** the eval scripts already do this in batch (`run_eval.mjs`), but the UI asks one question at a time.
**Gap:** a batch mode in the UI: paste or import a question list, run it, export a CSV/Markdown coverage report. Reuses `/api/query` unchanged.

## 6. Tender and RFP compliance matrix

**Who:** bid managers answering a client's requirements list from the studio's own proposal and spec documents.
**Asks:** "Requirement 4.2: content must be updateable remotely. Where does our proposal say so?"
**Good answer:** per requirement, the quoted evidence or a flagged gap.
**Today / gap:** same batch mode as scenario 5; plus higher corpus limits (proposals are long; the 200,000-character library limit and 50,000 per document will bind).

## 7. Multilingual crews

**Who:** venue staff who read the English runbook but ask in Turkish (or the reverse).
**Today:** `-Model multilingual` switches the Laya checkpoint, but retrieval is BM25 over surface words, so a Turkish question against an English document retrieves nothing and Laya is never called.
**Gap:** cross-lingual retrieval (a small multilingual embedding retriever next to BM25), and a CJK/Turkish truncation check against the token budget. Measure with a translated copy of `handover-v1.jsonl`.

## 8. Version-aware questions

**Who:** anyone asking about an installation that has changed since opening.
**Asks:** "When was the Restart Sensors button added?", "Is the backup fibre link installed?"
**Gap:** documents carry no date or version metadata, so "the amendment says 60 days" and "the contract says 90 days" look like a conflict when one supersedes the other. The dataset verifier rejected exactly this case. A document date or version field, shown next to each quote and used to rank superseding sources, would separate conflicts from revisions.

## Findings from the handover evaluation

Two runs, both with Laya `english` on an RTX 5090 in bf16, topK 8, test split at the default 0.80 threshold. Every cell holds 1–11 questions, so all rates are directional.

- **Baseline (2026-10-20):** the original chunker, which merged short paragraphs and glued each Markdown heading onto the previous section.
- **Current (2026-11-12):** section-aware chunking. A heading starts a new section, each paragraph in a section is its own chunk, and headings are indexed for BM25 but not sent to Laya. The Hugging Face revision moved from `7b928d8` to `85cc74d` between the runs; passage scores on unchanged text are bit-identical, so the differences below come from chunking.

| Handover pack (31 q), test split | Baseline | Current |
|---|---|---|
| Coverage (answerable + paraphrased) | 4/10 | 4/10 |
| False answers (unanswerable) | 1/4 | 1/4 |
| Shown-evidence precision | 3/5 | 4/5 |
| Recall@K | 8/11 | 10/11 |
| Conflicts surfaced (natural, in this set) | 0/1 | 0/1 |
| Conflicts surfaced (synthetic conflicts set, 6 q) | 1/3 | 2/3 |
| Threshold chosen on calibration | 0.79 | 0.83 |

The three-document sample set is unchanged by the chunker (its documents have no headings): coverage 2/5, false answers 0/3, shown-evidence precision 2/2, recall@K 4/5, threshold chosen on calibration 0.50.

A realistic corpus, with many near-miss passages, is much harder than the sample. The chosen threshold differs by corpus (0.50 against 0.79–0.83) and each value is set by a single calibration passage. Choose it per corpus on calibration, don't carry the number across, and keep the 0.80 default until each cell has about 30 questions.

- **Heading chunking (scenarios 1, 2): fixed, with a retrieval gain only.** In the baseline, 31 of the 37 `##` headings ended the previous section's chunk and all 7 FAQ questions were detached from their answers, which explained 2 of the 3 test retrieval misses. Section-aware chunks recover both. Coverage did not move, because the recovered passages score just under the threshold. Showing Laya the heading is not neutral: question headings raise P(supported), label headings ("## Term") lower it on identical text, so headings are used for retrieval only.
- **Near-miss false answer (scenario 4): open.** "What phone number should staff dial?" accepts "sent to the support line … or by phone" at 0.865. The passage mentions phoning but gives no number. This is a Laya decision miss that no usable threshold fixes. Rewording the question Laya is asked does not fix it either: three stricter wordings (requiring "the specific fact, value or name" in the instructions, the option descriptions, or both) left this passage at 0.84–0.86, while raising scores slightly on 70–80% of all passages and making calibration error a little worse. The wording was left unchanged. The remaining options are a second check on accepted passages or fine-tuning.
- **Conflicts (scenario 3): open.** Neither natural conflict in the pack is surfaced. The FAQ's "one business day" scores 0.524 against the contract's 0.817, and the venue's 1000-nit cap is not among the 8 retrieved passages. A per-passage threshold can't surface conflicts. Scenario 3 needs its own decision rule and UI.
- **Below-threshold answers (scenarios 1, 2, 4): open.** Five of the six remaining answerable and paraphrased test failures are correct passages that were retrieved but scored below 0.80. The sixth is a paraphrased question that shares no words with its answer, so BM25 never retrieves it.
- **Synthetic-document artifact.** The same sentence scores 0.82 alone, 0.52 under a "# Title (fictional)" heading, and 0.24 with "This document is fictional." added. Synthetic conflict documents need neutral titles, or the contradictory category is measuring the title rather than the conflict.
- **Noise floor.** The same passage text varies by about ±0.01 when it is scored in a different batch in bf16, so thresholds and probabilities quoted to two decimals are below the noise.
