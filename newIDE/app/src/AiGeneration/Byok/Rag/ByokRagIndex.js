// @flow
import {
  BYOK_RAG_CHUNK_TARGET_TOKENS,
  buildByokRagCorpus,
} from './ByokRagCorpus';
import { type ByokRagChunk, type ByokRagManifest } from './ByokRagTypes';

/**
 * The in-process vector index (Phase 13.7, D13-1): the chunk list plus one
 * Float32 vector per chunk, searched with brute-force cosine — the corpus
 * is thousands of chunks, not millions. Pure and deterministic: the same
 * corpus + embedder always builds the same manifest hash.
 */

export type ByokRagIndex = {|
  manifest: ByokRagManifest,
  chunks: Array<ByokRagChunk>,
  vectors: Array<Float32Array>,
|};

/**
 * The corpus hash: stable over the chunk ids, sources, titles, texts AND
 * tags (not the timestamps) — the determinism contract of the index build.
 * A delimiter between the parts prevents boundary collisions
 * (`"ab"+"c" === "a"+"bc"`), and folding the tags in means a tag-only
 * change cannot sail through a still-matching hash (audit011026 B-RAG-10).
 */
export const computeByokRagCorpusHash = (
  chunks: Array<ByokRagChunk>
): string => {
  let hash = 0x811c9dc5;
  const feed = (part: string) => {
    for (let index = 0; index < part.length; index++) {
      hash ^= part.charCodeAt(index);
      hash = (hash * 0x01000193) | 0;
    }
  };
  for (const chunk of chunks) {
    feed(chunk.id);
    feed('\u0000');
    feed(chunk.source);
    feed('\u0000');
    feed(chunk.title);
    feed('\u0000');
    feed(chunk.text);
    feed('\u0000');
    feed(chunk.tags.join('\u0001'));
    feed('\u0000');
  }
  return (hash >>> 0).toString(16);
};

/** The cosine similarity of two unit vectors (a plain dot product). */
export const byokRagCosineSimilarity = (
  a: Float32Array,
  b: Float32Array
): number => {
  // A length mismatch is corruption, not a truncation opportunity: quietly
  // dropping dimensions would fabricate plausible-looking scores.
  if (a.length !== b.length) return -1;
  let dot = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index];
  }
  return dot;
};

export type ByokRagIndexProgress = {|
  /** 0..1 — the share of chunks already embedded. */
  progress: number,
  /** What is happening, for the progress UI. */
  stage: 'corpus' | 'embedding' | 'done',
|};

/** The injected embedding function (the loaded embedder). */
export type ByokRagEmbedFunction = (
  texts: Array<string>
) => Promise<Array<Float32Array>>;

/**
 * Build (or rebuild) the index: build the corpus, embed every chunk, hash
 * the corpus into the manifest. `onProgress` drives the first-build UI.
 */
export const buildByokRagIndex = async (options: {|
  embedderId: string,
  embed: ByokRagEmbedFunction,
  docsFolderPath?: string,
  docsFolderReader?: any,
  backend?: 'in-process' | 'qdrant',
  onProgress?: (progress: ByokRagIndexProgress) => void,
|}): Promise<ByokRagIndex> => {
  const report =
    options.onProgress || ((_progress: ByokRagIndexProgress) => {});
  report({ progress: 0, stage: 'corpus' });
  const chunks = await buildByokRagCorpus({
    docsFolderPath: options.docsFolderPath,
    docsFolderReader: options.docsFolderReader,
  });

  // Batch the embedding: the corpus is thousands of chunks, one call per
  // batch keeps the (WASM) queue bounded.
  const BATCH_SIZE = 32;
  const vectors: Array<Float32Array> = [];
  for (let start = 0; start < chunks.length; start += BATCH_SIZE) {
    // eslint-disable-next-line no-await-in-loop
    const batch = chunks
      .slice(start, start + BATCH_SIZE)
      .map(chunk => `${chunk.title}\n${chunk.text}`);
    // eslint-disable-next-line no-await-in-loop
    const embedded = await options.embed(batch);
    vectors.push(...embedded);
    report({
      progress: Math.min(1, (start + BATCH_SIZE) / chunks.length),
      stage: 'embedding',
    });
  }
  report({ progress: 1, stage: 'done' });

  return {
    manifest: {
      schemaVersion: 1,
      embedderId: options.embedderId,
      corpusHash: computeByokRagCorpusHash(chunks),
      chunkCount: chunks.length,
      backend: options.backend || 'in-process',
      builtAt: new Date().toISOString(),
    },
    chunks,
    vectors,
  };
};

/**
 * True when the stored manifest matches the current corpus + embedder. The
 * current corpus hash is compared when given: an app update that changed
 * the bundled docs must not silently serve stale vectors (audit011026
 * B-RAG-10).
 */
export const isByokRagIndexUpToDate = (
  index: ByokRagIndex,
  embedderId: string,
  currentCorpusHash?: string
): boolean =>
  index.manifest.embedderId === embedderId &&
  (currentCorpusHash === undefined ||
    index.manifest.corpusHash === currentCorpusHash);

export type ByokRagIndexHit = {|
  chunk: ByokRagChunk,
  score: number,
|};

/**
 * Search the in-process index: brute-force cosine over every vector, top-k
 * results, deterministic tie-break on the chunk id.
 */
export const searchByokRagIndex = (
  index: ByokRagIndex,
  queryVector: Float32Array,
  resultLimit: number = 5
): Array<ByokRagIndexHit> => {
  const hits: Array<ByokRagIndexHit> = [];
  for (let position = 0; position < index.chunks.length; position++) {
    const score = byokRagCosineSimilarity(queryVector, index.vectors[position]);
    hits.push({ chunk: index.chunks[position], score });
  }
  hits.sort((a, b) => b.score - a.score || (a.chunk.id < b.chunk.id ? -1 : 1));
  return hits.slice(0, resultLimit);
};

// --- The serialized shape (vectors as base64 of the Float32 buffer) -----

export type ByokRagSerializedIndex = {|
  manifest: ByokRagManifest,
  chunks: Array<ByokRagChunk>,
  /** base64 of each vector's Float32Array buffer. */
  vectorsBase64: Array<string>,
|};

const encodeBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      // $FlowFixMe[cannot-spread-indexer]
      Array.from(bytes.subarray(index, index + CHUNK))
    );
  }
  return btoa(binary);
};

const decodeBase64 = (text: string): Float32Array => {
  const binary = atob(text);
  // A byte count that is not a multiple of 4 would silently drop the
  // trailing floats of the vector (audit011026 B-RAG-9).
  if (binary.length % 4 !== 0) {
    throw new Error('Truncated vector payload.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Float32Array(bytes.buffer);
};

/** True when every component is finite (NaN/Infinity poison cosine). */
const isFiniteByokRagVector = (vector: Float32Array): boolean => {
  for (let index = 0; index < vector.length; index++) {
    if (!Number.isFinite(vector[index])) return false;
  }
  return true;
};

/** Serialize an index for storage (base64 vectors: half the JSON size). */
export const serializeByokRagIndex = (
  index: ByokRagIndex
): ByokRagSerializedIndex => ({
  manifest: index.manifest,
  chunks: index.chunks,
  vectorsBase64: index.vectors.map(vector =>
    encodeBase64(vector.buffer.slice(0))
  ),
});

/** Deserialize a stored index (untrusted data: every field is checked). */
export const deserializeByokRagIndex = (raw: any): ?ByokRagIndex => {
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.manifest || typeof raw.manifest !== 'object') return null;
  if (!Array.isArray(raw.chunks) || !Array.isArray(raw.vectorsBase64)) {
    return null;
  }
  if (raw.chunks.length !== raw.vectorsBase64.length) return null;

  const chunks: Array<ByokRagChunk> = [];
  for (const entry of raw.chunks) {
    if (
      !entry ||
      typeof entry.id !== 'string' ||
      typeof entry.source !== 'string' ||
      typeof entry.title !== 'string' ||
      typeof entry.text !== 'string' ||
      !Array.isArray(entry.tags)
    ) {
      return null;
    }
    chunks.push({
      id: entry.id,
      source: entry.source,
      title: entry.title,
      text: entry.text,
      tags: entry.tags.filter((tag: any) => typeof tag === 'string'),
    });
  }

  let vectors: Array<Float32Array>;
  try {
    vectors = raw.vectorsBase64.map((text: any) =>
      typeof text === 'string' ? decodeBase64(text) : null
    );
  } catch (error) {
    return null;
  }
  if (vectors.some((vector: ?Float32Array) => !vector)) return null;

  // Uniform dimensions and finite components: a corrupt-but-sha-consistent
  // payload must be refused, not silently scored (audit011026 B-RAG-9).
  if (vectors.length === 0) return null;
  const dimensions = vectors[0].length;
  const hasUniformFiniteVectors = vectors.every(
    (vector: ?Float32Array) =>
      !!vector && vector.length === dimensions && isFiniteByokRagVector(vector)
  );
  if (dimensions === 0 || !hasUniformFiniteVectors) return null;
  // The manifest's count is what the status card reports — the actual array
  // is what search uses; they must agree.
  if (raw.manifest.chunkCount !== chunks.length) return null;

  return {
    manifest: {
      schemaVersion: raw.manifest.schemaVersion,
      embedderId: String(raw.manifest.embedderId || ''),
      corpusHash: String(raw.manifest.corpusHash || ''),
      chunkCount: raw.manifest.chunkCount,
      backend: raw.manifest.backend === 'qdrant' ? 'qdrant' : 'in-process',
      builtAt: String(raw.manifest.builtAt || ''),
    },
    chunks,
    // $FlowFixMe[incompatible-call] — the null check is done above.
    vectors,
  };
};

/** The estimated tokens of the corpus (the settings status card shows it). */
export const estimateByokRagCorpusTokens = (
  chunks: Array<ByokRagChunk>
): number =>
  chunks.reduce(
    (sum, chunk) => sum + Math.ceil(chunk.text.length / 4),
    BYOK_RAG_CHUNK_TARGET_TOKENS * 0
  );
