// Shared helpers for the Corbel evaluation scripts. Needs Node 22.18+ (imports the app's .ts files directly).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const root = path.resolve(import.meta.dirname, '../../../..');
export const CATEGORIES = ['answerable', 'paraphrased', 'unanswerable', 'contradictory'];
export const SPLITS = ['calibration', 'test'];

export const importApp = (relative) => import(pathToFileURL(path.join(root, relative)).href);

export function args(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

// A corpus spec is a comma-separated list of sources. "samples" loads src/lib/samples.ts; anything else
// is a directory of .md/.txt files whose document id is the file name without its extension.
// Example: "samples,eval/corpora/conflicts" adds synthetic conflict documents to the sample corpus.
export async function loadCorpus(spec = 'samples') {
  const docs = [];
  for (const source of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (source === 'samples') {
      docs.push(...(await importApp('src/lib/samples.ts')).samples.map(({ id, title, text }) => ({ id, title, text })));
      continue;
    }
    const dir = path.resolve(root, source);
    if (!statSync(dir).isDirectory()) throw new Error(`Corpus source ${source} is not a directory`);
    docs.push(...readdirSync(dir).filter((f) => /\.(md|txt)$/i.test(f)).sort().map((f) => ({
      id: f.replace(/\.(md|txt)$/i, ''), title: f, text: readFileSync(path.join(dir, f), 'utf8').replace(/^﻿/, '')
    })));
  }
  const ids = docs.map((d) => d.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`Corpus "${spec}" has two documents with id "${dup}"`);
  return docs;
}

export function loadJsonl(file) {
  const rows = [];
  readFileSync(path.resolve(root, file), 'utf8').split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try { rows.push({ ...JSON.parse(line), _line: i + 1 }); } catch (e) { rows.push({ _line: i + 1, _parseError: e.message }); }
  });
  return rows;
}

export const normalize = (text) => text.replace(/\s+/g, ' ').trim().toLowerCase();

// Character span of a gold quote inside its document, or null when the quote is not verbatim.
export function goldSpan(doc, quote) {
  const start = doc.text.indexOf(quote);
  if (start >= 0) return { start, end: start + quote.length };
  const n = normalize(doc.text).indexOf(normalize(quote));
  return n >= 0 ? { start: -1, end: -1, normalizedOnly: true } : null;
}

// Markdown heading lines of a document, as character ranges (same pattern as retrieval.ts).
export function headingLines(text) {
  return [...text.matchAll(/^[ \t]*#{1,6}[ \t][^\r\n]*/gm)].map((m) => ({ start: m.index, end: m.index + m[0].length, text: m[0].trim() }));
}

// The heading line a gold span overlaps, or null. Whether a passage shows heading text depends on
// HEADING_IN_PASSAGE, so a quote that relies on it measures the chunker setting, not the answer.
export function headingAt(doc, span) {
  if (!span || span.start < 0) return null;
  return headingLines(doc.text).find((h) => h.start < span.end && h.end > span.start) ?? null;
}

// How a scored passage relates to the gold quotes: 'full' contains one, 'partial' overlaps one,
// 'heading' sits in the section of a heading line that holds the quote (but does not show it), 'none'.
export function goldMatch(candidate, gold, docs) {
  let best = 'none';
  for (const g of gold) {
    if (g.documentId !== candidate.documentId) continue;
    if (normalize(candidate.evaluatedText ?? candidate.text).includes(normalize(g.quote))) return 'full';
    const doc = docs.find((d) => d.id === g.documentId);
    const span = doc && goldSpan(doc, g.quote);
    const end = candidate.offset + (candidate.evaluatedText ?? candidate.text).length;
    if (span && span.start >= 0 && candidate.offset < span.end && end > span.start) best = 'partial';
    const heading = best === 'none' && doc && headingAt(doc, span);
    if (heading && candidate.offset >= heading.end && !headingLines(doc.text).some((h) => h.start >= heading.end && h.start < candidate.offset)) best = 'heading';
  }
  return best;
}

// Indices of gold quotes that some 'full' candidate contains. A conflict counts when two or more are covered.
export function goldCovered(record, candidates) {
  const covered = new Set();
  for (const c of candidates) record.gold.forEach((g, i) => {
    if (c.documentId === g.documentId && c.gold === 'full' && normalize(c.evaluatedText ?? c.text).includes(normalize(g.quote))) covered.add(i);
  });
  return covered;
}

export function readEnv(file) {
  try {
    return Object.fromEntries(readFileSync(path.join(root, file), 'utf8').replace(/^﻿/, '').split(/\r?\n/)
      .map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
  } catch { return {}; }
}
