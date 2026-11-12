// Mechanical checks on a labeled question set before any inference is spent on it.
//   node .claude/skills/corbel-eval/scripts/validate_dataset.mjs --dataset eval/datasets/samples-seed.jsonl [--corpus samples] [--json]
// Errors (exit 1) make results meaningless. Warnings flag questions that measure something other than intended.
import { args, loadCorpus, loadJsonl, goldSpan, importApp, CATEGORIES, SPLITS } from './lib.mjs';

const opts = args();
if (!opts.dataset) { console.error('Usage: validate_dataset.mjs --dataset <file.jsonl> [--corpus samples|<dir>] [--json]'); process.exit(2); }
const docs = await loadCorpus(opts.corpus ?? 'samples');
const { chunk } = await importApp('src/lib/server/retrieval.ts');
const { checkDocuments, checkQuery } = await importApp('src/lib/limits.ts'); // the same limits /api/query enforces
const stop = new Set('a an the is are was were be been being to of and or in on at for by with it its as from this that what when how does do can we i you'.split(' '));
const words = (t) => new Set((t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !stop.has(w)));

const rows = loadJsonl(opts.dataset);
const errors = [];
const warnings = [];
const err = (r, m) => errors.push(`line ${r._line}${r.id ? ` (${r.id})` : ''}: ${m}`);
const warn = (r, m) => warnings.push(`line ${r._line}${r.id ? ` (${r.id})` : ''}: ${m}`);
const seen = new Set();
const counts = {};
const corpusError = checkDocuments(docs);
if (corpusError) errors.push(`corpus "${opts.corpus ?? 'samples'}": ${corpusError} (the /api/query limit)`);

for (const r of rows) {
  if (r._parseError) { err(r, `invalid JSON: ${r._parseError}`); continue; }
  if (typeof r.id !== 'string' || !r.id) err(r, 'id must be a non-empty string');
  else if (seen.has(r.id)) err(r, 'duplicate id'); else seen.add(r.id);
  if (!SPLITS.includes(r.split)) err(r, `split must be one of ${SPLITS.join(', ')}`);
  if (!CATEGORIES.includes(r.category)) err(r, `category must be one of ${CATEGORIES.join(', ')}`);
  const queryError = checkQuery(r.query);
  if (queryError) err(r, `${queryError} (the API limit)`);
  if (!Array.isArray(r.gold)) { err(r, 'gold must be an array'); continue; }
  const key = `${r.category}/${r.split}`;
  counts[key] = (counts[key] ?? 0) + 1;

  if (r.category === 'unanswerable' && r.gold.length) err(r, 'unanswerable questions must have gold: []');
  if (r.category !== 'unanswerable' && !r.gold.length) err(r, `${r.category} questions need at least one gold quote`);
  if (r.category === 'contradictory' && r.gold.length < 2) err(r, 'contradictory questions need at least two conflicting gold quotes');

  for (const g of r.gold) {
    const doc = docs.find((d) => d.id === g?.documentId);
    if (!doc) { err(r, `gold documentId "${g?.documentId}" is not in the corpus`); continue; }
    if (typeof g.quote !== 'string' || !g.quote.trim()) { err(r, 'gold quote must be a non-empty string'); continue; }
    const span = goldSpan(doc, g.quote);
    if (!span) { err(r, `gold quote not found in ${doc.id}: "${g.quote.slice(0, 60)}"`); continue; }
    if (span.normalizedOnly) warn(r, `gold quote matches ${doc.id} only after whitespace/case normalisation`);
    else if (!chunk(doc).some((c) => c.offset <= span.start && c.offset + c.text.length >= span.end))
      warn(r, `gold quote spans a chunk boundary in ${doc.id}; no single passage can contain it, so this question tests chunking`);
  }
  if (r.category === 'paraphrased' && r.gold.length) {
    const q = words(r.query);
    const g = words(r.gold.map((x) => x.quote).join(' '));
    const shared = [...q].filter((w) => g.has(w));
    if (q.size && shared.length / q.size > 0.5) warn(r, `paraphrase shares ${shared.length}/${q.size} content words with its gold quote (${shared.join(', ')})`);
  }
  if (r.category === 'contradictory' && new Set(r.gold.map((g) => `${g.documentId}`)).size < 2)
    warn(r, 'conflicting quotes come from one document; usually they should come from different sources');
}

for (const c of CATEGORIES) for (const s of SPLITS) {
  const any = CATEGORIES.some((x) => counts[`${x}/${s}`]);
  if (any && !counts[`${c}/${s}`] && Object.keys(counts).some((k) => k.startsWith(`${c}/`))) warnings.push(`category ${c} has no ${s} questions`);
}
const n = Object.values(counts).reduce((a, b) => a + b, 0);
if (n && n < 60) warnings.push(`${n} questions: interval estimates will be wide; treat metrics as directional`);

if (opts.json) console.log(JSON.stringify({ ok: !errors.length, questions: n, counts, errors, warnings }, null, 2));
else {
  console.log(`${n} questions in ${opts.dataset} against corpus "${opts.corpus ?? 'samples'}" (${docs.length} documents)`);
  for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k.padEnd(28)} ${v}`);
  for (const e of errors) console.log(`ERROR ${e}`);
  for (const w of warnings) console.log(`WARN  ${w}`);
  console.log(errors.length ? `\n${errors.length} error(s), ${warnings.length} warning(s)` : `\nValid (${warnings.length} warning(s))`);
}
process.exit(errors.length ? 1 : 0);
