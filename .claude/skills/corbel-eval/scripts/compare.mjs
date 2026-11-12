// Compares two evaluation runs (metrics.json + results.jsonl) question by question.
//   node .claude/skills/corbel-eval/scripts/compare.mjs --a _workspace/eval/<before> --b _workspace/eval/<after> [--threshold 0.8]
// Only meaningful when both runs used the same dataset; the script refuses otherwise. It warns when the runs'
// chunker config (run.json `chunker`) differs or was not recorded, since that changes what Laya sees.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { args, goldCovered, loadJsonl, root } from './lib.mjs';

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
console.log(`B: ${opts.b}  (${B.run.corpus}, topK ${B.run.topK}, ${B.metrics.model.join(', ')})`);
const unrecorded = [['A', A], ['B', B]].filter(([, x]) => !x.run.chunker).map(([n]) => n);
if (unrecorded.length) console.log(`WARNING: ${unrecorded.length > 1 ? 'neither run recorded its' : `run ${unrecorded[0]} did not record its`} chunker config (run.json from before it had one); check the chunker by hand.`);
else {
  const keys = [...new Set([...Object.keys(A.run.chunker), ...Object.keys(B.run.chunker)])];
  const diff = keys.filter((k) => A.run.chunker[k] !== B.run.chunker[k]).map((k) => `${k} ${A.run.chunker[k]} -> ${B.run.chunker[k]}`);
  if (diff.length) console.log(`WARNING: the runs used different chunker configs: ${diff.join(', ')}`);
}
console.log('');
// Contradictory questions whose candidates (before thresholding) contain at least two gold quotes.
// Computed from results.jsonl so it also works for runs whose metrics.json predates the metric.
const conflictRecall = (results, split) => {
  const C = results.filter((r) => r.split === split && r.category === 'contradictory' && !r.error && r.candidates);
  return { value: C.length ? C.filter((r) => goldCovered(r, r.candidates).size >= 2).length / C.length : null };
};
for (const split of ['calibration', 'test']) {
  const a = sweepAt(A.metrics, split), b = sweepAt(B.metrics, split);
  console.log(`${split} @ ${t.toFixed(2)}`);
  for (const key of ['coverage', 'selectivePrecision', 'falseAnswerRate', 'shownEvidencePrecision', 'conflictSurfaced'])
    console.log(`  ${key.padEnd(24)} ${fmt(a[key]).padStart(7)} -> ${fmt(b[key]).padStart(7)}`);
  console.log(`  ${'recallAtK'.padEnd(24)} ${fmt(A.metrics.retrieval[split].recallAtK).padStart(7)} -> ${fmt(B.metrics.retrieval[split].recallAtK).padStart(7)}`);
  console.log(`  ${'conflictRecallAtK'.padEnd(24)} ${fmt(conflictRecall(A.results, split)).padStart(7)} -> ${fmt(conflictRecall(B.results, split)).padStart(7)}`);
  console.log(`  ${'ECE'.padEnd(24)} ${String(A.metrics.calibration[split].ece ?? 'n/a').padStart(7)} -> ${String(B.metrics.calibration[split].ece ?? 'n/a').padStart(7)}\n`);
}

const outcome = (r) => {
  const accepted = (r.candidates ?? []).filter((c) => c.probability >= t);
  if (r.error) return 'error';
  if (r.category === 'unanswerable') return accepted.length ? 'answered (wrong)' : 'abstained (right)';
  if (r.category === 'contradictory') {
    const sides = goldCovered(r, accepted).size;
    return `conflict ${sides >= 2 ? 'surfaced' : 'missed'} (${sides}/${r.gold.length} sides accepted)`;
  }
  if (!accepted.length) return 'abstained';
  return accepted[0].gold === 'full' ? 'answered (right)' : 'answered (wrong evidence)';
};
const byId = new Map(B.results.map((r) => [r.id, r]));
const changed = A.results.map((r) => ({ id: r.id, query: r.query, a: outcome(r), b: outcome(byId.get(r.id)) })).filter((x) => x.a !== x.b);
console.log(changed.length ? `${changed.length} question(s) changed outcome @ ${t.toFixed(2)}:` : `No question changed outcome @ ${t.toFixed(2)}.`);
for (const c of changed) console.log(`  ${c.id}: ${c.a} -> ${c.b}   "${c.query}"`);
