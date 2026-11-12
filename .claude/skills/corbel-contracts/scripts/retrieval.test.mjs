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

// Headings without blank lines around them, an H1 title above a question heading, a heading
// run at EOF longer than CHUNK_MAX, and lines that look like headings but are not.
const tight = { id: 'tight', title: 'Tight.md', text: '## Who opens?\nThe manager.\n## Hours\nNine to five.' };
const titled = { id: 'titled', title: 'Titled.md', text: '# Title\n\n## Q?\n\nBody' };
const eofRun = { id: 'eofrun', title: 'EofRun.md', text: `Body first.\n\n## Zephyr ${'long heading words '.repeat(13)}\n## ${'more heading words '.repeat(13)}\n## ${'last heading words '.repeat(13)}` };
const fenced = {
  id: 'fenced', title: 'Fenced.md',
  text: '## Setup\n\n```bash\n# install deps\nnpm ci\n\n# build\nnpm run build\n```\n\n    # indented code, not a heading\n\n#\nBare heading body.\n\n~~~\n## not a heading either\n~~~\n'
};

const docs = [
  ...samples,
  { id: 'long', title: 'Long.md', text: `# Heading\n\nShort line.\n\n${longParagraph}\n\nTail paragraph.` },
  { id: 'nobreaks', title: 'NoBreaks.md', text: noBreaks },
  { id: 'd'.repeat(120), title: 'Max id.md', text: `${'word '.repeat(9000)}\n\nlast` },
  { id: 'crlf', title: 'Crlf.md', text: 'First paragraph.\r\n\r\nSecond paragraph.\r\n  \r\nThird.' },
  { id: 'leadspace', title: 'LeadSpace.md', text: `${' '.repeat(200)}ab ${'x'.repeat(700)}` }, // windows used to trim to the same offset
  faq, faqCrlf, tight, titled, eofRun, fenced
];

// Independent, fence-aware scan of a document's heading lines as source ranges.
function headingSpans(text) {
  const spans = [];
  let fence = '';
  let at = 0;
  for (const raw of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) fence = fence ? '' : marker;
    else if (!fence && /^ {0,3}#{1,6}(?:[ \t\r]|$)/.test(raw)) spans.push({ start: at, end: at + raw.length, text: raw.trim() });
    at += raw.length + 1;
  }
  return spans;
}
// For each non-blank line of a chunk: the heading span its first character sits in, or null for body.
function lineKinds(c, spans) {
  const kinds = [];
  let at = c.offset;
  for (const raw of c.text.split('\n')) {
    const lead = raw.search(/\S/);
    if (lead >= 0) kinds.push(spans.find((h) => h.start <= at + lead && at + lead < h.end) ?? null);
    at += raw.length + 1;
  }
  return kinds;
}
// Start of the run of heading lines at EOF, where heading-only chunks are allowed.
function tailStart(text, spans) {
  let tail = text.length;
  for (const h of [...spans].reverse()) {
    if (text.slice(h.end, tail).trim()) break;
    tail = h.start;
  }
  return tail;
}
const eachChunk = (v, fn) => {
  for (const doc of docs) {
    const spans = headingSpans(doc.text);
    const tail = tailStart(doc.text, spans);
    for (const c of v.chunk(doc)) fn(doc, c, lineKinds(c, spans), tail);
  }
};

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

  test(`[${mode}] no chunk ends with a heading line, except heading-only chunks at EOF`, () => {
    eachChunk(v, (doc, c, kinds, tail) => {
      if (kinds.at(-1)) assert.ok(kinds.every(Boolean) && c.offset >= tail, `${doc.id} @${c.offset} ends with "${kinds.at(-1).text}"`);
    });
  });

  test(`[${mode}] no chunk spans two sections; a body chunk shows at most its own heading`, () => {
    eachChunk(v, (doc, c, kinds) => {
      const body = kinds.indexOf(null);
      if (body < 0) return;
      assert.ok(kinds.slice(body).every((k) => !k), `${doc.id} @${c.offset} has a heading after body text`);
      assert.ok(body <= (mode === 'question' ? 1 : 0), `${doc.id} @${c.offset} starts with ${body} heading line(s)`);
    });
  });

  test(`[${mode}] a chunk starts with a heading only for a question heading in 'question' mode, or at EOF`, () => {
    eachChunk(v, (doc, c, kinds, tail) => {
      if (kinds[0]) assert.ok(c.offset >= tail || (mode === 'question' && /\?[ \t#]*$/.test(kinds[0].text)), `${doc.id} @${c.offset} starts with "${kinds[0].text}"`);
    });
  });

  test(`[${mode}] headings need no blank lines; only the last of consecutive headings is shown`, () => {
    assert.deepEqual(v.chunk(tight).map((c) => c.text), mode === 'question' ? ['## Who opens?\nThe manager.', 'Nine to five.'] : ['The manager.', 'Nine to five.']);
    assert.deepEqual(v.chunk(titled).map((c) => c.text), mode === 'question' ? ['## Q?\n\nBody'] : ['Body']);
    // Bodies of exactly CHUNK_MAX right under / right above a heading line: the newline is not counted.
    const full = `${'abcd '.repeat(CHUNK_MAX / 5 - 1)}abcde`;
    assert.equal(full.length, CHUNK_MAX);
    assert.deepEqual(v.chunk({ id: 'edge', title: 'Edge.md', text: `## A\n${full}\n## B\n${full}` }).map((c) => c.text), [full, full]);
  });

  test(`[${mode}] paragraphs inside a section never share a chunk; text before any heading still merges`, () => {
    const fade = 'The ambient sequence now starts with a slow fade.';
    const sensors = 'Sensor tracking was retuned to ignore bags on the floor.';
    const why = 'Because the cut felt like a crash to visitors.';
    const also = 'Feedback came from the March visitor survey.';
    const log = { id: 'log', title: 'Log.md', text: `Intro one.\n\nIntro two.\n\n## Version 1.1\n\n${fade}\n\n${sensors}\n\n## Why?\n\n${why}\n\n${also}` };
    assert.deepEqual(v.chunk(log).map((c) => c.text), ['Intro one.\n\nIntro two.', fade, sensors, mode === 'question' ? `## Why?\n\n${why}` : why, also]);
    // Two paragraphs with content (three or more words, not a "Label:" line) never share a chunk inside a section.
    const content = (p) => !/:[*_ \t\r]*$/.test(p.trim()) && (p.replace(/<!--[\s\S]*?-->/g, '').match(/[\p{L}\p{N}]+/gu) ?? []).length >= 3;
    eachChunk(v, (doc, c, kinds, tail) => {
      const first = headingSpans(doc.text)[0];
      if (!first || c.offset < first.start || c.offset >= tail) return;
      const body = kinds[0] ? c.text.slice(kinds[0].end - c.offset) : c.text;
      assert.ok(body.trim().split(/\n[ \t\r]*\n/).filter(content).length <= 1, `${doc.id} @${c.offset} merges paragraphs inside a section`);
    });
  });

  test(`[${mode}] scraps in a section join a neighbour within CHUNK_MAX, so they never outrank the answer`, () => {
    const revert = 'Revert the release tag and redeploy the previous build from the archive.';
    const keep = 'Keep the old artifacts for at least a week after every release.';
    const texts = (text) => v.chunk({ id: 'rb', title: 'Rb.md', text }).map((c) => c.text);
    // Trailing scraps join the paragraph before them; with none yet, they join the one after.
    assert.deepEqual(texts(`## Rollback plan\n\n${revert}\n\n---\n\n<!-- todo -->\n\n**Note:**\n\n${keep}`), [`${revert}\n\n---\n\n<!-- todo -->\n\n**Note:**`, keep]);
    assert.deepEqual(texts(`## Rollback plan\n\n<!-- todo: fill this in -->\n\n**Warning (read first):**\n\n${revert}`), [`<!-- todo: fill this in -->\n\n**Warning (read first):**\n\n${revert}`]);
    assert.deepEqual(texts(`## Rollback plan\n\n${revert}\n\n---`), [`${revert}\n\n---`]);
    // Past CHUNK_TARGET (LF or CRLF), and after a windowed paragraph: the scrap still joins.
    const long = 'Revert the tag, redeploy the build and confirm the health checks. '.repeat(5).trim();
    assert.ok(long.length > CHUNK_TARGET && long.length < CHUNK_MAX - 10);
    assert.deepEqual(texts(`## Rollback plan\n\n${long}\n\n---\n\n## Deploy plan\n\n${keep}`), [`${long}\n\n---`, keep]);
    assert.deepEqual(texts(`## Rollback plan\r\n\r\n${long}\r\n\r\n---`), [`${long}\r\n\r\n---`]);
    const windowed = texts(`## Relay rack\n\n**Note:**\n\n${longParagraph}\n\n---\n\n## Next\n\n${keep}`);
    assert.ok(windowed.length > 2 && windowed[0].startsWith('**Note:**\n\nSentence') && windowed.at(-2).endsWith('rig.\n\n---') && windowed.at(-1) === keep, windowed.join(' | '));
    // A question heading with a scrap under it still shows the answer.
    assert.deepEqual(texts(`## How do we roll back the release safely?\n\n---\n\n${revert}`), [mode === 'question' ? `## How do we roll back the release safely?\n\n---\n\n${revert}` : `---\n\n${revert}`]);
    for (const query of ['rollback plan', 'What is the rollback plan?']) {
      const { passages } = v.retrieve([{ id: 'rb', title: 'Rb.md', text: `## Rollback plan\n\n${long}\n\n---\n\n**Note:**\n\n## Deploy plan\n\n${keep}` }], query, 8);
      assert.ok(passages[0].text.startsWith('Revert'), query);
    }
  });

  test(`[${mode}] short paragraphs and list items with content stay separate inside a section`, () => {
    const items = ['- Fixed crash on boot.', '- Kiosk timeout is now 90 s.', '- New logo on the idle screen.', 'Alice owns the API.'];
    const list = { id: 'list', title: 'List.md', text: `## Version 1.2\n\n${items.join('\n\n')}` };
    assert.deepEqual(v.chunk(list).map((c) => c.text), items);
    assert.deepEqual(v.retrieve([list], 'kiosk timeout', 8).passages.map((p) => p.text), [items[1]]);
  });

  test(`[${mode}] fenced and indented "#" lines are body text; a bare "#" is a heading`, () => {
    const chunks = v.chunk(fenced);
    const texts = chunks.map((c) => c.text).join('\n\n');
    for (const line of ['# install deps', '# build', '# indented code, not a heading', '## not a heading either', 'Bare heading body.']) assert.ok(texts.includes(line), line);
    // Neither heading is shown (not questions, not at EOF); "Bare heading body." starts its own section.
    assert.ok(!chunks.some((c) => c.text.includes('## Setup') || /^#\s*\n/.test(c.text)));
    assert.ok(chunks.some((c) => c.text.startsWith('Bare heading body.')));
    // A blank line splits a fence too (README); halves with content stay apart like paragraphs.
    assert.deepEqual(chunks.map((c) => c.text), [
      '```bash\n# install deps\nnpm ci', '# build\nnpm run build\n```', '# indented code, not a heading',
      'Bare heading body.', '~~~\n## not a heading either\n~~~'
    ]);
  });

  test(`[${mode}] a heading run at EOF over CHUNK_MAX is windowed, and never counted twice`, () => {
    const start = eofRun.text.indexOf('## Zephyr');
    const tail = v.chunk(eofRun).filter((c) => c.offset >= start);
    assert.ok(tail.length > 1 && tail.every((c) => c.text.length <= CHUNK_MAX));
    // Windows overlap the heading lines they cut, so they get no extra heading tokens.
    const { passages } = v.retrieve([eofRun], 'zephyr', 8);
    assert.ok(passages.length > 0 && passages.every((p) => /zephyr/i.test(p.text)), passages.map((p) => p.offset).join());
  });

  test(`[${mode}] a heading counts once, whether it is in the passage text or only in BM25`, () => {
    const withHeading = { id: 'h', title: 'H.md', text: '## Can pets enter?\n\nOnly guide dogs.' };
    const plain = { id: 'p', title: 'P.md', text: 'Can pets enter?\nOnly guide dogs.' };
    const { passages } = v.retrieve([withHeading, plain], 'pets guide', 8);
    assert.equal(passages.length, 2);
    assert.equal(passages[0].lexicalScore, passages[1].lexicalScore);
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

test('heading-less documents score exactly as before heading-aware chunking (43cdd6c)', () => {
  const pinned = {
    'What happens when the OSC connection is lost?': [['sample-operations:216', 4.368961], ['sample-capture:206', 1.467087], ['sample-hardware:220', 1.389026]],
    'How long are visitor captures stored?': [['sample-capture:391', 5.455932], ['sample-capture:0', 2.72964]],
    'Does the installation support facial recognition?': [['sample-operations:0', 1.428058], ['sample-hardware:393', 1.090576], ['sample-operations:216', 0.982209]],
    'print queue jobs': [['sample-capture:0', 4.615396], ['sample-capture:206', 4.40126]]
  };
  for (const v of variants) for (const [query, expected] of Object.entries(pinned)) {
    assert.deepEqual(v.retrieve(samples, query, 8).passages.map((p) => [p.id, +p.lexicalScore.toFixed(6)]), expected, `[${v.HEADING_IN_PASSAGE}] ${query}`);
  }
});
