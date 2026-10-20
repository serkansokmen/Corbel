// Request limits for /api/query, shared with the eval scripts (.claude/skills/corbel-eval/scripts) so a question set
// or corpus that the app would reject is rejected before any inference. The eval scripts load this file with plain
// Node type stripping: keep it free of imports, enums, namespaces and parameter properties.
// Each check returns a reason string, or null when the value is within limits.
export const BODY_MAX = 1_000_000; // bytes of JSON accepted by /api/query (production also needs BODY_SIZE_LIMIT=1M)
export const QUERY_MAX = 500;
export const DOCUMENTS_MAX = 30;
export const DOCUMENT_CHARS_MAX = 50_000;
export const CORPUS_CHARS_MAX = 200_000;
export const DOCUMENT_ID_MAX = 120; // chunk ids are `${id}:${offset}` and must stay within the backend's 180
export const DOCUMENT_TITLE_MAX = 150;
export const THRESHOLD_MIN = 0.5;
export const THRESHOLD_MAX = 0.99;
export const TOP_K_MIN = 1;
export const TOP_K_MAX = 8;
const n = (value: number) => value.toLocaleString('en-US');
export const LIMITS_MESSAGE = `Check the question and document limits: ${QUERY_MAX} characters, ${DOCUMENTS_MAX} documents, ${n(DOCUMENT_CHARS_MAX)} characters per document, ${n(CORPUS_CHARS_MAX)} total.`;

export function checkQuery(query: unknown): string | null {
  return typeof query !== 'string' || !query.trim() || query.length > QUERY_MAX ? `query must be 1 to ${QUERY_MAX} characters` : null;
}

export function checkThreshold(threshold: unknown): string | null {
  return typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < THRESHOLD_MIN || threshold > THRESHOLD_MAX ? `threshold must be a number from ${THRESHOLD_MIN} to ${THRESHOLD_MAX}` : null;
}

export function checkTopK(topK: unknown): string | null {
  return !Number.isInteger(topK) || (topK as number) < TOP_K_MIN || (topK as number) > TOP_K_MAX ? `topK must be an integer from ${TOP_K_MIN} to ${TOP_K_MAX}` : null;
}

export function checkDocuments(documents: unknown): string | null {
  if (!Array.isArray(documents) || documents.length < 1 || documents.length > DOCUMENTS_MAX) return `documents must be an array of 1 to ${DOCUMENTS_MAX} documents`;
  let total = 0;
  const ids = new Set<string>();
  for (const [i, d] of documents.entries()) {
    const label = `document ${i + 1}${d && typeof d.id === 'string' ? ` ("${d.id.slice(0, 40)}")` : ''}`;
    if (!d || typeof d !== 'object') return `${label} must be an object`;
    if (typeof d.id !== 'string' || d.id.length > DOCUMENT_ID_MAX) return `${label}: id must be a string of at most ${DOCUMENT_ID_MAX} characters`;
    if (ids.has(d.id)) return `${label}: duplicate id`;
    ids.add(d.id);
    if (typeof d.title !== 'string' || d.title.length > DOCUMENT_TITLE_MAX) return `${label}: title must be a string of at most ${DOCUMENT_TITLE_MAX} characters`;
    if (typeof d.text !== 'string' || !d.text.trim() || d.text.length > DOCUMENT_CHARS_MAX) return `${label}: text must be 1 to ${n(DOCUMENT_CHARS_MAX)} characters`;
    total += d.text.length;
  }
  return total > CORPUS_CHARS_MAX ? `documents total ${n(total)} characters; the limit is ${n(CORPUS_CHARS_MAX)}` : null;
}

// The whole /api/query body: { query, documents, threshold, topK }.
export function checkQueryRequest(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'the request body must be a JSON object';
  const { query, documents, threshold, topK } = input as Record<string, unknown>;
  return checkQuery(query) ?? checkDocuments(documents) ?? checkThreshold(threshold) ?? checkTopK(topK);
}
