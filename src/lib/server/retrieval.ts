import type { Document, Passage } from '$lib/types';

const stopwords = new Set('a an the is are was were be been being to of and or in on at for by with it its as from this that what when how does do can we i you'.split(' '));
const tokens = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !stopwords.has(t));

// Laya scores short, focused passages far better than long ones: a single distractor
// paragraph in the same chunk can halve P(supported). Chunk on paragraph boundaries,
// merging short paragraphs (one-liners) up to TARGET and windowing anything over MAX.
export const CHUNK_TARGET = 320;
export const CHUNK_MAX = 600;
const WINDOW_OVERLAP = 80;

// Markdown headings start a section: sections never share a chunk, and BM25 counts the
// section's heading for every chunk in it. Whether Laya also sees the heading is separate:
// label headings ("## Term") lowered P(supported) on the handover eval, question headings
// raised it. 'never' keeps Passage.text body-only; 'question' starts a section's first chunk
// at its heading when the heading ends in "?" and the slice still fits CHUNK_MAX.
export const HEADING_IN_PASSAGE = 'never' as 'never' | 'question';
const HEADING = /^#{1,6}[ \t]/;
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
  let cursor = start;
  while (cursor < end) {
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

// Paragraphs, with heading lines at the start of a paragraph split off as their own blocks
// (a heading followed directly by its body, with no blank line, still becomes two blocks).
function blocks(text: string) {
  const out: { start: number; end: number; heading: boolean }[] = [];
  for (let { start, end } of paragraphs(text)) {
    for (;;) {
      const lead = text.slice(start, end).search(/\S/);
      if (lead < 0) break;
      const newline = text.indexOf('\n', start + lead);
      const lineEnd = newline < 0 || newline > end ? end : newline;
      if (!HEADING.test(text.slice(start + lead, lineEnd))) { out.push({ start, end, heading: false }); break; }
      out.push({ start: start + lead, end: lineEnd, heading: true });
      start = lineEnd;
    }
  }
  return out;
}

// Chunks plus the heading lines of their section, which only retrieve() needs.
function sections(doc: Document) {
  const chunks: { passage: Passage; headings: string[] }[] = [];
  let headings: string[] = [];
  const push = (start: number, end: number) => {
    const raw = doc.text.slice(start, end);
    const leading = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text) chunks.push({ passage: { id: `${doc.id}:${start + leading}`, documentId: doc.id, title: doc.title, text, offset: start + leading, lexicalScore: 0 }, headings });
  };
  let pending: { start: number; end: number } | null = null;
  const flush = () => { if (pending) push(pending.start, pending.end); pending = null; };
  // Consecutive headings with no body yet (e.g. "# Title" then "## Section") accumulate.
  let open: { start: number; last: number; end: number } | null = null;
  for (const block of blocks(doc.text)) {
    if (block.heading) {
      flush();
      const line = doc.text.slice(block.start, block.end).trim();
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
    if (open && HEADING_IN_PASSAGE === 'question' && QUESTION.test(headings[headings.length - 1]) && (block.end - block.start > CHUNK_MAX || block.end - open.last <= CHUNK_MAX)) start = open.last;
    open = null;
    if (block.end - start > CHUNK_MAX) {
      flush();
      for (const window of windows(doc.text, start, block.end)) push(window.start, window.end);
      continue;
    }
    if (pending && block.end - pending.start <= CHUNK_TARGET) pending.end = block.end;
    else {
      flush();
      pending = { start, end: block.end };
    }
  }
  flush();
  // Headings with no body before EOF become their own chunk, so no text disappears.
  if (open) for (const window of open.end - open.start > CHUNK_MAX ? windows(doc.text, open.start, open.end) : [open]) push(window.start, window.end);
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
    // Every chunk of a section counts its heading, unless the chunk text already shows it.
    const words = [passage.text, ...headings.filter((h) => !passage.text.includes(h))].flatMap(tokens);
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
