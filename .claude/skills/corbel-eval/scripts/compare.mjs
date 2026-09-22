// Compares two evaluation runs (metrics.json + results.jsonl) question by question.
//   node .claude/skills/corbel-eval/scripts/compare.mjs --a _workspace/eval/<before> --b _workspace/eval/<after> [--threshold 0.8]
// Only meaningful when both runs used the same dataset; the script refuses otherwise.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { args, loadJsonl, root } from './lib.mjs';

const opts = args();
if (!opts.a || !opts.b) { console.error('Usage: compare.mjs --a <run dir> --b <run dir> [--threshold 0.8]'); process.exit(2); }
const t = Number(opts.threshold ?? 0.8);
const load = (dir) => ({
  run: JSON.parse(readFileSync(path.resolve(root, dir, 'run.json'), 'utf8')),
  metrics: JSON.parse(readFileSync(path.resolve(root, dir, 'metrics.json'), 'utf8')),
  results: loadJsonl(path.resolve(root, dir, 'results.jsonl'))
});
const A = load(opts.a), B = load(opts.b);
const idsA = A.results.map((r) => r.id).sort().join(), idsB = B.results.map((r) => r.id).sort().join();
if (idsA !== idsB) { console.error('The runs used different question sets; compare metrics by hand instead.'); process.exit(1); }

const sweepAt = (m, split) => m.sweep[split].find((x) => Math.abs(x.threshold - t) < 1e-9);
const fmt = (r) => (r.value === null ? 'n/a' : `${(r.value * 100).toFixed(1)}%`);
console.log(`A: ${opts.a}  (${A.run.corpus}, topK ${A.run.topK}, ${A.metrics.model.join(', ')})`);
console.log(`B: ${opts.b}  (${B.run.corpus}, topK ${B.run.topK}, ${B.metrics.model.join(', ')})\n`);
for (const split of ['calibration', 'test']) {
  const a = sweepAt(A.metrics, split), b = sweepAt(B.metrics, split);
  console.log(`${split} @ ${t.toFixed(2)}`);
  for (const key of ['coverage', 'selectivePrecision', 'falseAnswerRate', 'shownEvidencePrecision', 'conflictSurfaced'])
    console.log(`  ${key.padEnd(24)} ${fmt(a[key]).padStart(7)} -> ${fmt(b[key]).padStart(7)}`);
  console.log(`  ${'recallAtK'.padEnd(24)} ${fmt(A.metrics.retrieval[split].recallAtK).padStart(7)} -> ${fmt(B.metrics.retrieval[split].recallAtK).padStart(7)}`);
  console.log(`  ${'ECE'.padEnd(24)} ${String(A.metrics.calibration[split].ece ?? 'n/a').padStart(7)} -> ${String(B.metrics.calibration[split].ece ?? 'n/a').padStart(7)}\n`);
}

const outcome = (r) => {
  const accepted = (r.candidates ?? []).filter((c) => c.probability >= t);
  if (r.error) return 'error';
  if (r.category === 'unanswerable') return accepted.length ? 'answered (wrong)' : 'abstained (right)';
  if (!accepted.length) return 'abstained';
  return accepted[0].gold === 'full' ? 'answered (right)' : 'answered (wrong evidence)';
};
const byId = new Map(B.results.map((r) => [r.id, r]));
const changed = A.results.map((r) => ({ id: r.id, query: r.query, a: outcome(r), b: outcome(byId.get(r.id)) })).filter((x) => x.a !== x.b);
console.log(changed.length ? `${changed.length} question(s) changed outcome @ ${t.toFixed(2)}:` : `No question changed outcome @ ${t.toFixed(2)}.`);
for (const c of changed) console.log(`  ${c.id}: ${c.a} -> ${c.b}   "${c.query}"`);
