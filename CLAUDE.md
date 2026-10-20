## Harness: Corbel

**Goal:** Keep Corbel's four layers (UI, api routes, retrieval, Laya backend) consistent on every change, and measure cite-or-abstain quality on labeled question sets.

**When to use:** For Corbel work that crosses layers, contract audits, building eval question sets, running evaluations, choosing thresholds or comparing runs, use the `corbel-harness` skill. Simple questions about the code can be answered directly. After any code change, run `node .claude/skills/corbel-contracts/scripts/verify.mjs`.

**Change log:**
| Date | Change | Scope | Reason |
| --- | --- | --- | --- |
| 2026-10-20 | Initial Harness v2 setup | All | - |
| 2026-10-20 | Contract map: body limit, error envelope and env rows | corbel-contracts | Match the fixes in 49fa6be |
| 2026-10-20 | Chunker config in run.json, conflict flips in compare, heading-quote warnings, both-sides recall@K | corbel-eval | Gaps found measuring heading-aware chunking (QA F6, F11) |
