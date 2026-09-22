// Prints the passages the app would build from a corpus, exactly as retrieval.ts chunks them.
// Question authors use it to pick gold quotes that sit inside one passage.
//   node .claude/skills/corbel-eval/scripts/print_chunks.mjs [--corpus samples] [--query "..."] [--topK 8]
import { args, loadCorpus, importApp } from './lib.mjs';

const opts = args();
const docs = await loadCorpus(opts.corpus ?? 'samples');
const { chunk, retrieve } = await importApp('src/lib/server/retrieval.ts');
if (opts.query) {
  const { passages, chunkCount } = retrieve(docs, String(opts.query), Number(opts.topK ?? 8));
  console.log(`${passages.length} of ${chunkCount} passages match "${opts.query}" lexically${passages.length ? '' : ' (Laya would not be called)'}`);
  for (const p of passages) console.log(`\n[${p.id}] BM25 ${p.lexicalScore.toFixed(2)}\n${p.text}`);
} else {
  for (const doc of docs) {
    console.log(`\n## ${doc.id} (${doc.title}, ${doc.text.length} chars)`);
    for (const c of chunk(doc)) console.log(`\n[${c.id}] ${c.text.length} chars\n${c.text}`);
  }
}
