import type { Document, Passage } from '$lib/types';

const stopwords = new Set('a an the is are was were be been being to of and or in on at for by with it its as from this that what when how does do can we i you'.split(' '));
const tokens = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !stopwords.has(t));

// Laya scores short, focused passages far better than long ones: a single distractor
// paragraph in the same chunk can halve P(supported). Chunk on paragraph boundaries,
// merging short paragraphs (one-liners) up to TARGET outside Markdown sections, only
// content-free scraps inside them, and windowing anything over MAX.
export const CHUNK_TARGET = 320;
export const CHUNK_MAX = 600;
const WINDOW_OVERLAP = 80;

// Markdown headings start a section: sections never share a chunk, and BM25 counts the
// section's heading for every chunk in it. Whether Laya also sees the heading is separate:
// label headings ("## Term") lowered P(supported) on the handover eval, question headings
// raised it. 'never' keeps Passage.text body-only; 'question' starts a section's first chunk
// at its heading when the heading ends in "?" and the slice still fits CHUNK_MAX.
export const HEADING_IN_PASSAGE = 'never' as 'never' | 'question';
const HEADING = /^ {0,3}#{1,6}(?:[ \t\r]|$)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const QUESTION = /\?[ \t#]*$/;

function paragraphs(text: string) {
  const spans: { start: number; end: number }[] = [];
  const separator = /\n(?:[ \t\r]*\n)+/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = separator.exec(text))) {
    spans.push({ start, end: match.index });
    start = match.index + match[0].length;
  }
  spans.push({ start, end: text.length });
  return spans;
}

function* windows(text: string, start: number, end: number) {
  const blank = /\s*/y;
  let cursor = start;
  while (cursor < end) {
    // Start each window on text, so two windows can never trim to the same offset (and id).
    blank.lastIndex = cursor;
    blank.exec(text);
    cursor = Math.min(blank.lastIndex, end);
    if (cursor >= end) break;
    let stop = Math.min(cursor + CHUNK_TARGET, end);
    if (stop < end) {
      const slice = text.slice(cursor, stop);
      const sentence = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('? '), slice.lastIndexOf('! '));
      const space = slice.lastIndexOf(' ');
      const cut = sentence > CHUNK_TARGET / 2 ? sentence + 1 : space > CHUNK_TARGET / 2 ? space : -1;
      if (cut > 0) stop = cursor + cut;
    }
    yield { start: cursor, end: stop };
    if (stop >= end) break;
    cursor = Math.max(stop - WINDOW_OVERLAP, cursor + 1);
  }
}

// Paragraphs, with every heading line split off as its own block, so a heading needs no
// blank line around it. Lines inside ``` or ~~~ fences are never headings (shell comments).
// `fenced` is whether a fence is still open where the block ends.
function blocks(text: string) {
  const out: { start: number; end: number; heading: boolean; fenced: boolean }[] = [];
  const body = (start: number, end: number) => { if (text.slice(start, end).trim()) out.push({ start, end, heading: false, fenced: !!fence }); };
  let fence = '';
  for (const { start, end } of paragraphs(text)) {
    let from = start;
    for (let line = start; line < end; ) {
      const newline = text.indexOf('\n', line);
      const lineEnd = newline < 0 || newline > end ? end : newline;
      const raw = text.slice(line, lineEnd);
      const marker = FENCE.exec(raw)?.[1];
      if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) fence = fence ? '' : marker;
      else if (!fence && HEADING.test(raw)) {
        if (line > from) body(from, line - 1);
        out.push({ start: line, end: lineEnd, heading: true, fenced: false });
        from = lineEnd + 1;
      }
      line = lineEnd + 1;
    }
    body(from, end);
  }
  return out;
}

// A paragraph with no content of its own: markup with no letters or digits once HTML comments
// and tags are removed ("---", "<!-- todo -->", "</details>", a bare fence), a lone "[...]"
// marker ("[TOC]", "[1]"), a lone fence line such as "```bash", or a one-line label that only
// introduces what follows: up to three non-stopword words, and at most 20 characters when it
// has no spaces (CJK), such as "See also:" or "注意：", or emphasised as a whole
// ("**Warning (read first):**"). A sentence ending in ":" is content.
const MARKUP = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/g;
const MARKER = /^\[[^\]\n]*\]$/;
const FENCE_LINE = /^(?:`{3,}[^`\n]*|~{3,}[^\n]*)$/;
const LABEL = /^[^\n]*[:：][*_ \t\r]*$/;
const EMPHASISED = /^(\*\*?|__?)[^\n]*[:：][ \t]*\1$/;
const rest = (text: string) => text.replace(MARKUP, '').trim();
const label = (r: string) => LABEL.test(r) && (EMPHASISED.test(r) || (tokens(r).length <= 3 && (/\s/.test(r) || r.length <= 20)));
function scrap(text: string) {
  const r = rest(text);
  return !/[\p{L}\p{N}]/u.test(r) || MARKER.test(r) || FENCE_LINE.test(r) || label(r);
}
// A scrap that leads into the next paragraph: a label, or a fence line that opens a fence.
const intro = (text: string, fenced: boolean) => {
  const r = rest(text);
  return label(r) || (fenced && FENCE_LINE.test(r));
};

type Heading = { start: number; end: number; text: string };

// Chunks plus the heading lines of their section, which only retrieve() needs.
function sections(doc: Document) {
  const chunks: { passage: Passage; headings: Heading[] }[] = [];
  let headings: Heading[] = [];
  // A scrap-only chunk gets no heading tokens, so it never wins a heading-only query.
  const push = (start: number, end: number, body = true) => {
    const raw = doc.text.slice(start, end);
    const leading = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text) chunks.push({ passage: { id: `${doc.id}:${start + leading}`, documentId: doc.id, title: doc.title, text, offset: start + leading, lexicalScore: 0 }, headings: body ? headings : [] });
  };
  let pending: { start: number; end: number; body: boolean } | null = null;
  const flush = () => { if (pending) push(pending.start, pending.end, pending.body); pending = null; };
  // Consecutive headings with no body yet (e.g. "# Title" then "## Section") accumulate.
  let open: { start: number; last: number; end: number } | null = null;
  const all = blocks(doc.text);
  const isScrap = all.map((b) => !b.heading && scrap(doc.text.slice(b.start, b.end)));
  for (const [i, block] of all.entries()) {
    if (block.heading) {
      flush();
      const line = { start: block.start, end: block.end, text: doc.text.slice(block.start, block.end).trim() };
      if (open) {
        headings.push(line);
        open.last = block.start;
        open.end = block.end;
      } else {
        headings = [line];
        open = { start: block.start, last: block.start, end: block.end };
      }
      continue;
    }
    let start = block.start;
    if (open && HEADING_IN_PASSAGE === 'question' && QUESTION.test(headings[headings.length - 1].text) && (block.end - block.start > CHUNK_MAX || block.end - open.last <= CHUNK_MAX)) start = open.last;
    open = null;
    // Text before any heading merges short paragraphs up to CHUNK_TARGET, as it always has.
    if (!headings.length) {
      if (block.end - start > CHUNK_MAX) {
        flush();
        for (const window of windows(doc.text, start, block.end)) push(window.start, window.end);
      } else if (pending && block.end - pending.start <= CHUNK_TARGET) pending.end = block.end;
      else {
        flush();
        pending = { start, end: block.end, body: true };
      }
      continue;
    }
    // Inside a Markdown section every paragraph is its own chunk: merged change-log entries
    // dragged each other's P(supported) down. Scraps are the exception, since alone they would
    // win BM25 for heading-only queries on length normalisation: a scrap joins the paragraph
    // before it (or, with none yet, the one after it) within CHUNK_MAX. A scrap that leads
    // into what follows (a label, an opening fence) joins the next paragraph instead when one
    // follows in the same section and they fit, or that paragraph is windowed anyway. Two
    // paragraphs with content never share a chunk.
    const body = !isScrap[i];
    // Leading scraps start the first window; the last window stays open for trailing ones.
    const from = pending && !pending.body ? pending.start : start;
    let forward = false;
    if (!body && pending?.body && intro(doc.text.slice(block.start, block.end), block.fenced)) {
      let next = i + 1;
      while (next < all.length && isScrap[next]) next++;
      const target = all[next];
      forward = !!target && !target.heading && (target.end - start <= CHUNK_MAX || target.end - target.start > CHUNK_MAX);
    }
    if (block.end - start > CHUNK_MAX) {
      if (from === start) flush();
      const spans = [...windows(doc.text, from, block.end)];
      for (const window of spans.slice(0, -1)) push(window.start, window.end);
      pending = { ...spans[spans.length - 1], body: true };
    } else if (pending && !forward && block.end - pending.start <= CHUNK_MAX && !(body && pending.body)) {
      pending.end = block.end;
      pending.body ||= body;
    } else {
      flush();
      pending = { start, end: block.end, body };
    }
  }
  flush();
  // Headings with no body before EOF become their own chunk(s), so no text disappears; their
  // text is the passage, so BM25 adds nothing on top.
  if (open) {
    headings = [];
    for (const window of open.end - open.start > CHUNK_MAX ? windows(doc.text, open.start, open.end) : [open]) push(window.start, window.end);
  }
  return chunks;
}

export function chunk(doc: Document) {
  return sections(doc).map((c) => c.passage);
}

export function retrieve(documents: Document[], query: string, topK: number) {
  const sectioned = documents.flatMap((doc) => sections(doc));
  const chunks = sectioned.map((c) => c.passage);
  const terms = [...new Set(tokens(query))];
  const bags = sectioned.map(({ passage, headings }) => {
    // Every chunk of a section counts its heading, unless the chunk shows (part of) it already
    // or has fewer than two words of its own (a "Done." would win heading-only queries).
    const shown = (h: Heading) => h.end > passage.offset && h.start < passage.offset + passage.text.length;
    const own = tokens(passage.text);
    const words = own.length < 2 ? own : [...own, ...headings.filter((h) => !shown(h)).flatMap((h) => tokens(h.text))];
    const counts = new Map<string, number>();
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    return { counts, length: words.length };
  });
  const average = bags.reduce((n, bag) => n + bag.length, 0) / (bags.length || 1) || 1;
  for (const term of terms) {
    const frequency = bags.filter((bag) => bag.counts.has(term)).length;
    const idf = Math.log(1 + (chunks.length - frequency + 0.5) / (frequency + 0.5));
    bags.forEach((bag, i) => {
      const tf = bag.counts.get(term) ?? 0;
      chunks[i].lexicalScore += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * bag.length / average));
    });
  }
  return { passages: chunks.filter((c) => c.lexicalScore > 0).sort((a, b) => b.lexicalScore - a.lexicalScore).slice(0, topK), chunkCount: chunks.length };
}
