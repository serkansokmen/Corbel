// Invariants of src/lib/server/retrieval.ts that the backend and the UI rely on.
// Needs Node 22.18+ (TypeScript type stripping). Run from the repository root:
//   node --test .claude/skills/corbel-contracts/scripts/retrieval.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../../..');
const { chunk, retrieve, CHUNK_MAX, CHUNK_TARGET } = await import(pathToFileURL(path.join(root, 'src/lib/server/retrieval.ts')).href);
const { samples } = await import(pathToFileURL(path.join(root, 'src/lib/samples.ts')).href);

const BACKEND_TEXT_MAX = 1000; // backend/app.py Passage.text max_length
const BACKEND_ID_MAX = 180; // backend/app.py Passage.id max_length

const longParagraph = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} describes part ${i % 7} of the rig.`).join(' ');
const noBreaks = 'x'.repeat(5000);
const docs = [
  ...samples,
  { id: 'long', title: 'Long.md', text: `# Heading\n\nShort line.\n\n${longParagraph}\n\nTail paragraph.` },
  { id: 'nobreaks', title: 'NoBreaks.md', text: noBreaks },
  { id: 'd'.repeat(120), title: 'Max id.md', text: `${'word '.repeat(9000)}\n\nlast` },
  { id: 'crlf', title: 'Crlf.md', text: 'First paragraph.\r\n\r\nSecond paragraph.\r\n  \r\nThird.' }
];

test('every chunk maps back to its source by offset', () => {
  for (const doc of docs) for (const c of chunk(doc)) assert.equal(doc.text.slice(c.offset, c.offset + c.text.length), c.text, `${doc.id} @${c.offset}`);
});

test('chunks respect CHUNK_MAX and the backend passage limits', () => {
  assert.ok(CHUNK_MAX <= BACKEND_TEXT_MAX, 'CHUNK_MAX must not exceed the backend passage limit');
  for (const doc of docs) for (const c of chunk(doc)) {
    assert.ok(c.text.length <= CHUNK_MAX, `${doc.id} chunk of ${c.text.length}`);
    assert.ok(c.id.length <= BACKEND_ID_MAX, `id ${c.id.length} chars`);
    assert.ok(c.text.trim() === c.text && c.text.length > 0);
  }
});

test('chunk ids are unique within a document', () => {
  for (const doc of docs) {
    const ids = chunk(doc).map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, doc.id);
  }
});

test('windows over a long paragraph cover it without gaps', () => {
  const doc = docs.find((d) => d.id === 'long');
  const start = doc.text.indexOf(longParagraph);
  const windows = chunk(doc).filter((c) => c.offset >= start && c.offset < start + longParagraph.length).sort((a, b) => a.offset - b.offset);
  assert.ok(windows.length > 1);
  let covered = start;
  for (const w of windows) {
    assert.ok(w.offset <= covered + 1, `gap before ${w.offset}`);
    assert.ok(w.text.length <= CHUNK_TARGET);
    covered = Math.max(covered, w.offset + w.text.length);
  }
  assert.ok(covered >= start + longParagraph.length - 1);
});

test('retrieve returns at most topK positive-score passages, best first', () => {
  for (const topK of [1, 2, 4, 8]) {
    const { passages, chunkCount } = retrieve(samples, 'What happens when the OSC connection is lost?', topK);
    assert.ok(passages.length <= topK && passages.length > 0 && chunkCount > 0);
    assert.ok(passages.every((p) => p.lexicalScore > 0));
    assert.deepEqual(passages.map((p) => p.lexicalScore), [...passages.map((p) => p.lexicalScore)].sort((a, b) => b - a));
  }
});

test('a stopword-only question retrieves nothing, so Laya is never called', () => {
  assert.equal(retrieve(samples, 'what is the', 8).passages.length, 0);
});

test('retrieve does not leak scores between calls', () => {
  const first = retrieve(samples, 'print queue jobs', 4).passages.map((p) => p.lexicalScore);
  const second = retrieve(samples, 'print queue jobs', 4).passages.map((p) => p.lexicalScore);
  assert.deepEqual(first, second);
});

test('sample questions retrieve their known passage first', () => {
  assert.match(retrieve(samples, 'How long are visitor captures stored?', 4).passages[0].text, /24 hours/);
  assert.match(retrieve(samples, 'What happens when the OSC connection is lost?', 4).passages[0].text, /idle sequence/);
});
