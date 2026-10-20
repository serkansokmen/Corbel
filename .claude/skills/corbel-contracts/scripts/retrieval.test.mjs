// Invariants of src/lib/server/retrieval.ts that the backend and the UI rely on.
// Needs Node 22.18+ (TypeScript type stripping). Run from the repository root:
//   node --test .claude/skills/corbel-contracts/scripts/retrieval.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../../..');
const retrievalPath = path.join(root, 'src/lib/server/retrieval.ts');
const current = await import(pathToFileURL(retrievalPath).href);
const { chunk, retrieve, CHUNK_MAX, CHUNK_TARGET } = current;
const { samples } = await import(pathToFileURL(path.join(root, 'src/lib/samples.ts')).href);

// HEADING_IN_PASSAGE is a const, so the other mode is loaded from a temp copy with only that
// declaration rewritten. Every heading test runs against both modes, whichever one is shipped.
const declaration = /export const HEADING_IN_PASSAGE = '(never|question)'/;
const source = readFileSync(retrievalPath, 'utf8');
assert.match(source, declaration, 'HEADING_IN_PASSAGE declaration not found; update this test');
const otherMode = current.HEADING_IN_PASSAGE === 'never' ? 'question' : 'never';
const tmp = mkdtempSync(path.join(os.tmpdir(), 'corbel-retrieval-'));
writeFileSync(path.join(tmp, 'retrieval.ts'), source.replace(declaration, `export const HEADING_IN_PASSAGE = '${otherMode}'`));
const other = await import(pathToFileURL(path.join(tmp, 'retrieval.ts')).href);
rmSync(tmp, { recursive: true, force: true });
const variants = [current, other];
assert.deepEqual(variants.map((v) => v.HEADING_IN_PASSAGE).sort(), ['never', 'question']);

const BACKEND_TEXT_MAX = 1000; // backend/app.py Passage.text max_length
const BACKEND_ID_MAX = 180; // backend/app.py Passage.id max_length

const longParagraph = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} describes part ${i % 7} of the rig.`).join(' ');
const noBreaks = 'x'.repeat(5000);

// FAQ-style markdown: H1 title, label and question headings, consecutive headings, a heading
// with its body on the next line, a long answer, a nearly full answer and a heading at EOF.
const longAnswer = Array.from({ length: 30 }, (_, i) => `Step ${i} resets relay ${i % 5} on the rack.`).join(' ');
const nearlyFull = 'Fallback text. '.repeat(39).trim();
const faqText = [
  '# Gallery handbook', '', '## Overview', '', 'This handbook covers daily routines for the front desk team.', '',
  '## Who opens the gallery?', 'The duty manager unlocks the doors at nine and switches on the lobby lights.', '',
  '## Can visitors touch the wall?', '', 'No. Ask them to stay behind the floor line; the sensors react to movement, not contact.', '',
  'Point families at the printed guide by the entrance. Staff should repeat the floor line rule calmly, explain that the sensors read shapes from a distance, and call the duty manager if someone keeps reaching past the line after two reminders during busy afternoons or school visits.', '',
  '## Hours', '## Weekend hours', '', 'Saturday and Sunday opening runs from ten until six.', '',
  '## What happens when the relay rack fails?', '', longAnswer, '',
  '## Does a nearly full answer keep its heading?', '', nearlyFull, '',
  '## Contacts', ''
].join('\n');
const faq = { id: 'faq', title: 'Faq.md', text: faqText };
const faqCrlf = { id: 'faq-crlf', title: 'FaqCrlf.md', text: faqText.replace(/\n/g, '\r\n') };
// [heading line, does it start its first chunk in 'question' mode]
const faqHeadings = [
  ['# Gallery handbook', false], ['## Overview', false], ['## Who opens the gallery?', true], ['## Can visitors touch the wall?', true],
  ['## Hours', false], ['## Weekend hours', false], ['## What happens when the relay rack fails?', true],
  ['## Does a nearly full answer keep its heading?', false] // heading + body would exceed CHUNK_MAX, so body only
];

const docs = [
  ...samples,
  { id: 'long', title: 'Long.md', text: `# Heading\n\nShort line.\n\n${longParagraph}\n\nTail paragraph.` },
  { id: 'nobreaks', title: 'NoBreaks.md', text: noBreaks },
  { id: 'd'.repeat(120), title: 'Max id.md', text: `${'word '.repeat(9000)}\n\nlast` },
  { id: 'crlf', title: 'Crlf.md', text: 'First paragraph.\r\n\r\nSecond paragraph.\r\n  \r\nThird.' },
  faq,
  faqCrlf
];

const lines = (text) => text.split(/\r?\n/).filter((l) => l.trim());
const isHeading = (line) => /^#{1,6}[ \t]/.test(line.trim());
const atEof = (doc, c) => !doc.text.slice(c.offset + c.text.length).trim();

for (const v of variants) {
  const mode = v.HEADING_IN_PASSAGE;

  test(`[${mode}] every chunk maps back to its source by offset`, () => {
    for (const doc of docs) for (const c of v.chunk(doc)) assert.equal(doc.text.slice(c.offset, c.offset + c.text.length), c.text, `${doc.id} @${c.offset}`);
  });

  test(`[${mode}] chunks respect CHUNK_MAX and the backend passage limits`, () => {
    assert.ok(CHUNK_MAX <= BACKEND_TEXT_MAX, 'CHUNK_MAX must not exceed the backend passage limit');
    for (const doc of docs) for (const c of v.chunk(doc)) {
      assert.ok(c.text.length <= CHUNK_MAX, `${doc.id} chunk of ${c.text.length}`);
      assert.ok(c.id.length <= BACKEND_ID_MAX, `id ${c.id.length} chars`);
      assert.ok(c.text.trim() === c.text && c.text.length > 0);
    }
  });

  test(`[${mode}] chunk ids are unique within a document`, () => {
    for (const doc of docs) {
      const ids = v.chunk(doc).map((c) => c.id);
      assert.equal(new Set(ids).size, ids.length, doc.id);
    }
  });

  test(`[${mode}] no chunk ends with a heading line, except a heading-only chunk at EOF`, () => {
    for (const doc of docs) for (const c of v.chunk(doc)) {
      const ls = lines(c.text);
      if (isHeading(ls.at(-1))) assert.ok(ls.every(isHeading) && atEof(doc, c), `${doc.id} @${c.offset} ends with "${ls.at(-1)}"`);
    }
  });

  test(`[${mode}] no chunk spans two sections; a body chunk shows at most its own heading`, () => {
    for (const doc of docs) for (const c of v.chunk(doc)) {
      const ls = lines(c.text);
      const body = ls.findIndex((l) => !isHeading(l));
      if (body < 0) continue;
      assert.ok(ls.slice(body).every((l) => !isHeading(l)), `${doc.id} @${c.offset} has a heading after body text`);
      assert.ok(body <= (mode === 'question' ? 1 : 0), `${doc.id} @${c.offset} starts with ${body} heading line(s)`);
    }
  });

  test(`[${mode}] chunk text starts with a heading only for a question heading in 'question' mode, or at EOF`, () => {
    for (const doc of docs) for (const c of v.chunk(doc)) {
      if (!c.text.startsWith('#')) continue;
      const first = lines(c.text)[0];
      assert.ok(atEof(doc, c) || (mode === 'question' && /\?[ \t#]*$/.test(first)), `${doc.id} @${c.offset} starts with "${first}"`);
    }
  });

  test(`[${mode}] question headings start their first chunk only in 'question' mode, when it fits`, () => {
    for (const doc of [faq, faqCrlf]) {
      const chunks = v.chunk(doc);
      for (const [line, question] of faqHeadings) {
        const at = doc.text.indexOf(line);
        assert.ok(at >= 0, line);
        assert.equal(chunks.some((c) => c.offset === at), mode === 'question' && question, `${doc.id}: ${line}`);
      }
      assert.equal(chunks.at(-1).text, '## Contacts', `${doc.id}: trailing heading is kept as its own chunk`);
    }
  });

  test(`[${mode}] CRLF text chunks exactly like LF text`, () => {
    assert.deepEqual(v.chunk(faqCrlf).map((c) => c.text.replace(/\r\n/g, '\n')), v.chunk(faq).map((c) => c.text));
  });

  test(`[${mode}] a query using only a heading's words retrieves every chunk of that section`, () => {
    for (const doc of [faq, faqCrlf]) {
      const section = (line) => {
        const start = doc.text.indexOf(line);
        const next = doc.text.indexOf('\n#', start + line.length);
        return v.chunk(doc).filter((c) => c.offset + c.text.length > start && c.offset < next);
      };
      // "visitors", "touch" and "wall" appear only in the heading, and the section has two chunks.
      const touch = section('## Can visitors touch the wall?');
      assert.equal(touch.length, 2);
      const { passages } = v.retrieve([doc], 'Can visitors touch the wall?', 8);
      assert.deepEqual(passages.map((p) => p.offset).sort((a, b) => a - b), touch.map((c) => c.offset));
      // "fails" appears only in the heading of the windowed section.
      const relay = section('## What happens when the relay rack fails?');
      assert.ok(relay.length > 2);
      assert.deepEqual(v.retrieve([doc], 'fails', 8).passages.map((p) => p.offset).sort((a, b) => a - b), relay.map((c) => c.offset));
      // The heading also wins against the sample corpus.
      assert.ok(touch.some((c) => c.offset === v.retrieve([...samples, doc], 'Can visitors touch the wall?', 4).passages[0].offset));
    }
  });
}

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
