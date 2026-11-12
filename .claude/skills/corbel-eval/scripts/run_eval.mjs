// Runs a labeled question set through the real Corbel pipeline and stores every scored candidate.
//   node .claude/skills/corbel-eval/scripts/run_eval.mjs --dataset eval/datasets/x.jsonl --out _workspace/eval/<run>
//        [--corpus samples|<dir>] [--topK 8] [--via backend|ui] [--url http://...] [--target-precision 0.9]
// --via backend (default): app retrieval code + POST /score on LAYA_BACKEND_URL from .env.
// --via ui: POST /api/query on the SvelteKit server (default http://127.0.0.1:5173), exercising +server.ts too.
// One inference per question; thresholds are swept afterwards by metrics.mjs from the stored probabilities.
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { args, loadCorpus, loadJsonl, goldMatch, importApp, readEnv, root } from './lib.mjs';

const opts = args();
if (!opts.dataset || !opts.out) { console.error('Usage: run_eval.mjs --dataset <file.jsonl> --out <dir> [--corpus samples|<dir>] [--topK 8] [--via backend|ui] [--url <base>]'); process.exit(2); }
const via = opts.via ?? 'backend';
const topK = opts.topK === true ? NaN : Number(opts.topK ?? 8);
const corpusSpec = opts.corpus ?? 'samples';
const env = { ...readEnv('.env'), ...process.env };
const base = (opts.url ?? (via === 'ui' ? 'http://127.0.0.1:5173' : env.LAYA_BACKEND_URL || 'http://127.0.0.1:5177')).replace(/\/$/, '');
const headers = { 'Content-Type': 'application/json', ...(via === 'backend' && env.LAYA_API_KEY ? { Authorization: `Bearer ${env.LAYA_API_KEY}` } : {}) };

// The /api/query limits apply to --via backend too, so both paths score the same kind of request.
const { checkDocuments, checkTopK } = await importApp('src/lib/limits.ts');
const topKError = checkTopK(topK);
if (topKError) { console.error(`--topK: ${topKError} (the /api/query limit).`); process.exit(2); }

const check = spawnSync(process.execPath, [path.join(import.meta.dirname, 'validate_dataset.mjs'), '--dataset', opts.dataset, '--corpus', corpusSpec], { cwd: root, encoding: 'utf8' });
if (check.status !== 0) { console.error(check.stdout + check.stderr); console.error('Dataset failed validation; fix it before spending inference.'); process.exit(1); }

const docs = await loadCorpus(corpusSpec);
const corpusError = checkDocuments(docs);
if (corpusError) { console.error(`Corpus "${corpusSpec}": ${corpusError} (the /api/query limit).`); process.exit(1); }
const { retrieve, HEADING_IN_PASSAGE, CHUNK_TARGET, CHUNK_MAX } = await importApp('src/lib/server/retrieval.ts');
// The chunker this run used. With --via ui the server runs its own copy of retrieval.ts; this records the checkout's.
const retrievalSha256 = createHash('sha256').update(readFileSync(path.join(root, 'src/lib/server/retrieval.ts'))).digest('hex').slice(0, 16);
const chunker = { headingInPassage: HEADING_IN_PASSAGE ?? null, chunkTarget: CHUNK_TARGET ?? null, chunkMax: CHUNK_MAX ?? null, retrievalSha256 };
const questions = loadJsonl(opts.dataset);

const health = await fetch(`${base}${via === 'ui' ? '/api/health' : '/health'}`, { headers, signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch((e) => ({ status: 'offline', message: e.message }));
if (health.status !== 'ready') { console.error(`Backend not ready at ${base}: ${health.status} ${health.message ?? ''}\nStart it with ./corbel.ps1 -BackendOnly (or ./corbel.ps1 for --via ui).`); process.exit(3); }

async function post(url, body) {
  for (let attempt = 0; ; attempt++) {
    const started = performance.now();
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
    const json = await response.json().catch(() => ({}));
    if (response.status === 429 && attempt < 6) { await new Promise((r) => setTimeout(r, 500 * (attempt + 1))); continue; }
    if (!response.ok) {
      // FastAPI sends a string detail for its own errors and an array of objects for 422 validation errors.
      const detail = json.detail ?? json.error ?? '';
      throw new Error(`${response.status} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    }
    return { ...json, wallMs: Math.round(performance.now() - started) };
  }
}

const outDir = path.resolve(root, opts.out);
mkdirSync(outDir, { recursive: true });
const resultsFile = path.join(outDir, 'results.jsonl');
writeFileSync(resultsFile, '');
writeFileSync(path.join(outDir, 'run.json'), JSON.stringify({ startedAt: new Date().toISOString(), dataset: opts.dataset, corpus: corpusSpec, documents: docs.length, topK, via, chunker, backend: base.replace(/\/\/[^/@]*@/, '//'), health }, null, 2));

let failed = 0;
for (const [i, q] of questions.entries()) {
  const record = { id: q.id, split: q.split, category: q.category, query: q.query, gold: q.gold };
  try {
    let result;
    if (via === 'ui') {
      result = await post(`${base}/api/query`, { query: q.query, documents: docs, threshold: 0.5, topK });
    } else {
      const { passages, chunkCount } = retrieve(docs, q.query.trim(), topK);
      result = passages.length ? { ...(await post(`${base}/score`, { query: q.query.trim(), passages })), chunkCount } : { evidence: [], chunkCount, inferenceMs: 0 };
    }
    record.candidates = result.evidence.map((e) => ({ ...e, gold: goldMatch(e, q.gold, docs) }));
    Object.assign(record, { chunkCount: result.chunkCount, inferenceMs: result.inferenceMs, wallMs: result.wallMs ?? 0, model: result.model, revision: result.revision, device: result.device, sdkVersion: result.sdkVersion, precision: result.precision });
  } catch (e) {
    record.error = e.message;
    failed++;
  }
  appendFileSync(resultsFile, JSON.stringify(record) + '\n');
  process.stdout.write(`\r${i + 1}/${questions.length} scored${failed ? `, ${failed} failed` : ''}   `);
}
console.log(`\nResults: ${path.relative(root, resultsFile)}`);

const metrics = spawnSync(process.execPath, [path.join(import.meta.dirname, 'metrics.mjs'), '--results', resultsFile, ...(opts['target-precision'] ? ['--target-precision', opts['target-precision']] : [])], { cwd: root, stdio: 'inherit' });
process.exit(failed || metrics.status ? 1 : 0);
