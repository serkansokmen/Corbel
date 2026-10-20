export type Document = { id: string; title: string; text: string; sample?: boolean };
export type Passage = { id: string; documentId: string; title: string; text: string; offset: number; lexicalScore: number };
export type Evidence = Passage & {
  probability: number;
  decision: string;
  distribution: Record<string, number>;
  evaluatedText: string;
  truncated: boolean;
};
export type Run = {
  id: string;
  query: string;
  createdAt: string;
  threshold: number;
  topK: number;
  evidence: Evidence[];
  latencyMs: number;
  inferenceMs: number;
  model: string;
  revision: string;
  device: string;
  sdkVersion: string;
  gpu?: string | null;
  precision?: string;
  corpusSize: number;
  chunkCount: number;
  review?: 'correct' | 'incorrect';
};
// Export format corbel-runs-v1. `threshold` is always the stored Run threshold; a single-run export adds the slider
// value on screen (`viewedThreshold`) and the ids of the evidence accepted at it (`acceptedIds`).
export type ExportedRun = Run & { viewedThreshold?: number; acceptedIds?: string[] };
export type Health = { status: 'ready' | 'loading' | 'error' | 'offline'; model?: string; device?: string; message?: string; gpu?: string | null; location?: string; precision?: string };
