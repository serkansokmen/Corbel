import type { Document, Passage } from '$lib/types';

const stopwords = new Set('a an the is are was were be been being to of and or in on at for by with it its as from this that what when how does do can we i you'.split(' '));
const tokens = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !stopwords.has(t));

// Laya scores short, focused passages far better than long ones: a single distractor
// paragraph in the same chunk can halve P(supported). Chunk on paragraph boundaries,
// merging short paragraphs (headings, one-liners) up to TARGET and windowing anything over MAX.
export const CHUNK_TARGET = 320;
export const CHUNK_MAX = 600;
const WINDOW_OVERLAP = 80;

function paragraphs(text: string) {
  const spans: { start: number; end: number }[] = [];
  const separator = /\n[ \t]*\n/g;
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

export function chunk(doc: Document) {
  const chunks: Passage[] = [];
  const push = (start: number, end: number) => {
    const raw = doc.text.slice(start, end);
    const leading = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text) chunks.push({ id: `${doc.id}:${start + leading}`, documentId: doc.id, title: doc.title, text, offset: start + leading, lexicalScore: 0 });
  };
  let pending: { start: number; end: number } | null = null;
  for (const span of paragraphs(doc.text)) {
    if (!doc.text.slice(span.start, span.end).trim()) continue;
    const length = span.end - span.start;
    if (length > CHUNK_MAX) {
      if (pending) push(pending.start, pending.end);
      pending = null;
      for (const window of windows(doc.text, span.start, span.end)) push(window.start, window.end);
      continue;
    }
    if (pending && span.end - pending.start <= CHUNK_TARGET) pending.end = span.end;
    else {
      if (pending) push(pending.start, pending.end);
      pending = { ...span };
    }
  }
  if (pending) push(pending.start, pending.end);
  return chunks;
}

export function retrieve(documents: Document[], query: string, topK: number) {
  const chunks = documents.flatMap(chunk);
  const terms = [...new Set(tokens(query))];
  const bags = chunks.map((item) => {
    const words = tokens(item.text);
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
