## Harness: Corbel

**Goal:** Keep Corbel's four layers (UI, api routes, retrieval, Laya backend) consistent on every change, and measure cite-or-abstain quality on labeled question sets.

**When to use:** For Corbel work that crosses layers, contract audits, building eval question sets, running evaluations, choosing thresholds or comparing runs, use the `corbel-harness` skill. Simple questions about the code can be answered directly. After any code change, run `node .claude/skills/corbel-contracts/scripts/verify.mjs`.

**Change log:**
| Date | Change | Scope | Reason |
| --- | --- | --- | --- |
| 2026-10-20 | Initial Harness v2 setup | All | - |
| 2026-10-20 | Contract map: body limit, error envelope and env rows | corbel-contracts | Match the fixes in 49fa6be |
| 2026-10-20 | Contract map: shared `src/lib/limits.ts`, production env/bind rows, Run export threshold rule | corbel-contracts, corbel-eval, corbel-harness | Audit fixes B1, M1-M4 and minors |
| 2026-10-20 | Contract map: UI side of Question length and Documents rows | corbel-contracts | UI guards and localStorage restore use limits.ts |
