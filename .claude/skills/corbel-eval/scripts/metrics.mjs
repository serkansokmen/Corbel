// Threshold sweep, calibration and failure attribution over a results.jsonl from run_eval.mjs.
//   node .claude/skills/corbel-eval/scripts/metrics.mjs --results _workspace/eval/<run>/results.jsonl [--target-precision 0.9]
// Writes metrics.json, failures.jsonl and summary.md next to the results file. No inference.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { args, loadJsonl, root } from './lib.mjs';

const opts = args();
if (!opts.results) { console.error('Usage: metrics.mjs --results <results.jsonl> [--target-precision 0.9]'); process.exit(2); }
const target = Number(opts['target-precision'] ?? 0.9);
const DEFAULT_T = 0.8; // the UI's default slider value
const grid = Array.from({ length: 50 }, (_, i) => Math.round((0.5 + i * 0.01) * 100) / 100);
const all = loadJsonl(opts.results);
const errored = all.filter((r) => r.error || !r.candidates);
const rows = all.filter((r) => !r.error && r.candidates);
const seeking = (r) => r.category === 'answerable' || r.category === 'paraphrased';

function wilson(k, n) {
  if (!n) return null;
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)].map((x) => Math.round(x * 1000) / 1000);
}
const rate = (k, n) => ({ k, n, value: n ? Math.round((k / n) * 1000) / 1000 : null, ci95: wilson(k, n) });

function conflictSurfaced(r, accepted) {
  const covered = new Set();
  for (const c of accepted) r.gold.forEach((g, i) => { if (c.documentId === g.documentId && c.gold === 'full' && c.evaluatedText.replace(/\s+/g, ' ').toLowerCase().includes(g.quote.replace(/\s+/g, ' ').toLowerCase())) covered.add(i); });
  return covered.size >= 2;
}

function at(set, t) {
  const A = set.filter(seeking), U = set.filter((r) => r.category === 'unanswerable'), C = set.filter((r) => r.category === 'contradictory');
  const acc = (r) => r.candidates.filter((c) => c.probability >= t);
  const answeredA = A.filter((r) => acc(r).length), correctA = answeredA.filter((r) => acc(r)[0].gold === 'full');
  const answeredU = U.filter((r) => acc(r).length);
  const accepted = set.flatMap(acc);
  return {
    threshold: t,
    coverage: rate(answeredA.length, A.length),
    selectivePrecision: rate(correctA.length, answeredA.length),
    falseAnswerRate: rate(answeredU.length, U.length),
    shownEvidencePrecision: rate(correctA.length, answeredA.length + answeredU.length),
    acceptedPassagePrecision: rate(accepted.filter((c) => c.gold === 'full').length, accepted.length),
    conflictSurfaced: rate(C.filter((r) => conflictSurfaced(r, acc(r))).length, C.length)
  };
}

function calibration(set) {
  const pairs = set.flatMap((r) => r.candidates.map((c) => [c.probability, c.gold === 'full' ? 1 : 0]));
  if (!pairs.length) return { n: 0 };
  const bins = Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, hi: (i + 1) / 10, n: 0, meanP: 0, observed: 0 }));
  for (const [p, y] of pairs) { const b = bins[Math.min(9, Math.floor(p * 10))]; b.n++; b.meanP += p; b.observed += y; }
  let ece = 0;
  for (const b of bins) if (b.n) { b.meanP /= b.n; b.observed /= b.n; ece += (b.n / pairs.length) * Math.abs(b.meanP - b.observed); }
  const brier = pairs.reduce((s, [p, y]) => s + (p - y) ** 2, 0) / pairs.length;
  const r3 = (x) => Math.round(x * 1000) / 1000;
  return { n: pairs.length, positives: pairs.filter(([, y]) => y).length, ece: r3(ece), brier: r3(brier), bins: bins.filter((b) => b.n).map((b) => ({ ...b, meanP: r3(b.meanP), observed: r3(b.observed) })) };
}

function retrieval(set) {
  const S = set.filter((r) => r.category !== 'unanswerable');
  return {
    recallAtK: rate(S.filter((r) => r.candidates.some((c) => c.gold === 'full')).length, S.length),
    partialOnly: S.filter((r) => !r.candidates.some((c) => c.gold === 'full') && r.candidates.some((c) => c.gold === 'partial')).map((r) => r.id),
    noCandidates: set.filter((r) => !r.candidates.length).map((r) => r.id),
    truncatedGold: set.filter((r) => r.candidates.some((c) => c.truncated && c.gold !== 'none')).map((r) => r.id)
  };
}

function failures(set, t) {
  const out = [];
  for (const r of set) {
    const accepted = r.candidates.filter((c) => c.probability >= t);
    const goldRank = r.candidates.findIndex((c) => c.gold === 'full');
    const gold = goldRank >= 0 ? r.candidates[goldRank] : null;
    const base = { id: r.id, split: r.split, category: r.category, query: r.query, threshold: t };
    const top = accepted[0] && { title: accepted[0].title, probability: accepted[0].probability, text: accepted[0].evaluatedText };
    if (r.category === 'unanswerable') { if (accepted.length) out.push({ ...base, kind: 'false-answer', top }); continue; }
    if (r.category === 'contradictory') { if (!conflictSurfaced(r, accepted)) out.push({ ...base, kind: 'conflict-missed', acceptedGold: accepted.filter((c) => c.gold === 'full').length }); continue; }
    if (!accepted.length) {
      if (!gold) out.push({ ...base, kind: r.candidates.some((c) => c.gold === 'partial') ? 'chunk-split' : 'retrieval-miss', candidates: r.candidates.length });
      else out.push({ ...base, kind: 'below-threshold', goldProbability: gold.probability, goldRank: goldRank + 1, goldDistribution: gold.distribution });
    } else if (accepted[0].gold !== 'full') out.push({ ...base, kind: 'wrong-evidence', top, goldRank: goldRank >= 0 ? goldRank + 1 : null, goldProbability: gold?.probability ?? null });
  }
  return out;
}

const splits = { calibration: rows.filter((r) => r.split === 'calibration'), test: rows.filter((r) => r.split === 'test'), all: rows };
const calSweep = grid.map((t) => at(splits.calibration, t));
const chosen = calSweep.find((m) => m.coverage.k > 0 && m.shownEvidencePrecision.value !== null && m.shownEvidencePrecision.value >= target)?.threshold ?? null;
const reportT = chosen ?? DEFAULT_T;
const failureRows = failures(splits.test.length ? splits.test : rows, reportT);

const metrics = {
  questions: all.length, errored: errored.map((r) => ({ id: r.id, error: r.error })),
  counts: Object.fromEntries(['answerable', 'paraphrased', 'unanswerable', 'contradictory'].map((c) => [c, { calibration: splits.calibration.filter((r) => r.category === c).length, test: splits.test.filter((r) => r.category === c).length }])),
  model: [...new Set(rows.filter((r) => r.model).map((r) => `${r.model}@${r.revision} ${r.device} ${r.precision ?? ''}`.trim()))],
  targetPrecision: target,
  chosenThreshold: chosen,
  chosenThresholdNote: chosen === null ? `No threshold reached ${target} shown-evidence precision on the calibration split; failures are reported at the UI default ${DEFAULT_T}.` : `Smallest threshold reaching ${target} shown-evidence precision on the calibration split.`,
  atChosenOnTest: at(splits.test, reportT),
  atDefault: { calibration: at(splits.calibration, DEFAULT_T), test: at(splits.test, DEFAULT_T) },
  retrieval: { calibration: retrieval(splits.calibration), test: retrieval(splits.test) },
  calibration: { calibration: calibration(splits.calibration), test: calibration(splits.test) },
  sweep: { calibration: calSweep, test: grid.map((t) => at(splits.test, t)) },
  failureCounts: failureRows.reduce((m, f) => ({ ...m, [f.kind]: (m[f.kind] ?? 0) + 1 }), {})
};

const dir = path.dirname(path.resolve(root, opts.results));
writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify(metrics, null, 2));
writeFileSync(path.join(dir, 'failures.jsonl'), failureRows.map((f) => JSON.stringify(f)).join('\n') + (failureRows.length ? '\n' : ''));

const pct = (r) => (r.value === null ? 'n/a' : `${(r.value * 100).toFixed(1)}% (${r.k}/${r.n}, 95% CI ${r.ci95.map((x) => (x * 100).toFixed(0)).join('–')}%)`);
const row = (label, m) => `| ${label} | ${m.threshold.toFixed(2)} | ${pct(m.coverage)} | ${pct(m.selectivePrecision)} | ${pct(m.falseAnswerRate)} | ${pct(m.shownEvidencePrecision)} | ${pct(m.conflictSurfaced)} |`;
const md = [
  `# Corbel evaluation summary`, '',
  `Results: \`${path.relative(root, path.resolve(root, opts.results))}\`  `,
  `Model: ${metrics.model.join(', ') || 'n/a'}  `,
  `Questions: ${all.length} (${errored.length} errored and excluded)`, '',
  '| Category | Calibration | Test |', '|---|---|---|',
  ...Object.entries(metrics.counts).map(([c, v]) => `| ${c} | ${v.calibration} | ${v.test} |`), '',
  `## Decision quality`, '', metrics.chosenThresholdNote, '',
  '| Split | Threshold | Coverage (answerable+paraphrased) | Precision when answered | False answers (unanswerable) | Shown-evidence precision | Conflicts surfaced |', '|---|---|---|---|---|---|---|',
  ...(chosen !== null ? [row('test @ chosen', metrics.atChosenOnTest)] : []),
  row('calibration @ default', metrics.atDefault.calibration), row('test @ default', metrics.atDefault.test), '',
  `## Retrieval (threshold-free)`, '',
  `- Recall@K, calibration: ${pct(metrics.retrieval.calibration.recallAtK)}`,
  `- Recall@K, test: ${pct(metrics.retrieval.test.recallAtK)}`,
  `- No candidates at all (Laya not called): ${[...metrics.retrieval.calibration.noCandidates, ...metrics.retrieval.test.noCandidates].join(', ') || 'none'}`,
  `- Gold only partially inside a chunk: ${[...metrics.retrieval.calibration.partialOnly, ...metrics.retrieval.test.partialOnly].join(', ') || 'none'}`,
  `- Gold candidate truncated by the token budget: ${[...metrics.retrieval.calibration.truncatedGold, ...metrics.retrieval.test.truncatedGold].join(', ') || 'none'}`, '',
  `## Calibration of P(supported), passage level`, '',
  `- Calibration split: ECE ${metrics.calibration.calibration.ece ?? 'n/a'}, Brier ${metrics.calibration.calibration.brier ?? 'n/a'}, ${metrics.calibration.calibration.n} passages`,
  `- Test split: ECE ${metrics.calibration.test.ece ?? 'n/a'}, Brier ${metrics.calibration.test.brier ?? 'n/a'}, ${metrics.calibration.test.n} passages`, '',
  `## Failures on ${splits.test.length ? 'test' : 'all'} @ ${reportT.toFixed(2)}`, '',
  ...(Object.keys(metrics.failureCounts).length ? Object.entries(metrics.failureCounts).map(([k, v]) => `- ${k}: ${v}`) : ['- none']),
  '', 'Per-question detail: `failures.jsonl`. Full sweep: `metrics.json`.', ''
].join('\n');
writeFileSync(path.join(dir, 'summary.md'), md);
console.log(md);
