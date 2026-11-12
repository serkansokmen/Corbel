# Changelog

Notable changes to Corbel. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Corbel has no tagged release yet.

## Unreleased

### Added
- Apache-2.0 license, contributing guide, security policy, issue and pull request templates, and CI.
- Handover-pack evaluation corpus with two labeled question sets (`eval/corpora/handover`, `eval/datasets/handover-v1*.jsonl`) and use-case scenarios (`docs/use-cases.md`).
- Shared request limits in `src/lib/limits.ts`, used by `/api/query`, the UI and the eval scripts.
- Eval runs record the chunker configuration; `compare.mjs` reports contradictory questions whose outcome flips.

### Changed
- Chunking follows Markdown sections: a heading starts a new section, each paragraph inside a section is its own chunk, and headings are indexed for BM25 but not sent to Laya.
- The production command reads `.env` and binds to `127.0.0.1`.
- A single-run export keeps the stored threshold and adds the viewed threshold and the accepted passage ids.

### Fixed
- The dev server's first page load took about 40 s because Vite watched the Python virtual environment.
- The backend accepted the example placeholder key for a LAN bind.

### Known issues
- A one-line paragraph ending in a colon is treated as a label and merges into the previous paragraph.

## 0.1.0

- Initial version: SvelteKit workbench, BM25 retrieval, FastAPI backend scoring passages with Laya 0.3.5.
