import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { retrieve } from '$lib/server/retrieval';
import type { Document } from '$lib/types';

export async function POST({ request, fetch }) {
  const started = performance.now();
  const tooLarge = () => json({ error: 'The document library exceeds the 1 MB request limit.' }, { status: 413 });
  try {
    if (Number(request.headers.get('content-length')) > 1_000_000) return tooLarge();
    const reader = request.body?.getReader();
    if (!reader) return json({ error: 'A request body is required.' }, { status: 400 });
    let bytes = 0;
    let body = '';
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_000_000) return tooLarge(); // no reader.cancel(): it destroys the socket before the 413 is written
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    const input = JSON.parse(body);
    const { query, documents, threshold, topK } = input;
    if (typeof query !== 'string' || !query.trim() || query.length > 500 || !Array.isArray(documents) || documents.length < 1 || documents.length > 30 ||
        typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0.5 || threshold > 0.99 || !Number.isInteger(topK) || topK < 1 || topK > 8 ||
        documents.some((d: Document) => !d || typeof d.id !== 'string' || d.id.length > 120 || typeof d.title !== 'string' || d.title.length > 150 || typeof d.text !== 'string' || !d.text.trim() || d.text.length > 50_000) ||
        new Set(documents.map((d: Document) => d.id)).size !== documents.length || documents.reduce((n: number, d: Document) => n + d.text.length, 0) > 200_000) {
      return json({ error: 'Check the question and document limits: 500 characters, 30 documents, 50,000 characters per document, 200,000 total.' }, { status: 400 });
    }
    const { passages, chunkCount } = retrieve(documents, query.trim(), topK);
    const base = { id: crypto.randomUUID(), query: query.trim(), createdAt: new Date().toISOString(), threshold, topK, corpusSize: documents.length, chunkCount };
    if (!passages.length) return json({ ...base, evidence: [], latencyMs: Math.round(performance.now() - started), inferenceMs: 0, model: 'not run', revision: '', device: '', sdkVersion: '' });
    let response;
    try {
      response = await fetch(`${env.LAYA_BACKEND_URL || 'http://127.0.0.1:5177'}/score`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(env.LAYA_API_KEY ? { Authorization: `Bearer ${env.LAYA_API_KEY}` } : {}) },
        body: JSON.stringify({ query: query.trim(), passages }), signal: AbortSignal.timeout(120_000)
      });
    } catch {
      return json({ error: 'The Laya service is unavailable or timed out. Check the model status and retry.' }, { status: 503 });
    }
    let result;
    try { result = await response.json(); } catch { result = null; }
    if (!response.ok) return json({ error: typeof result?.detail === 'string' ? result.detail : 'Laya could not score these passages.' }, { status: response.status });
    if (!result || typeof result !== 'object' || !Array.isArray(result.evidence)) return json({ error: 'The Laya service returned an unreadable response. Check the backend log and retry.' }, { status: 502 });
    return json({ ...base, ...result, latencyMs: Math.round(performance.now() - started) });
  } catch (error) {
    if ((error as { status?: number } | null)?.status === 413) return json({ error: "The document library exceeds the server's request size limit (1 MB). If it is under 1 MB, start the production server with BODY_SIZE_LIMIT=1M." }, { status: 413 });
    return json({ error: 'The request could not be processed. Check the input and retry.' }, { status: 400 });
  }
}
