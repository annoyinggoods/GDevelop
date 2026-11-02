// @flow
import { getByokRagEmbedderInfo } from './ByokRagTypes';

/**
 * The on-device embedder (Phase 13.7, D13-1/D13-8): a Transformers.js ONNX
 * model (`@huggingface/transformers`), **lazy-loaded** — the package is
 * only imported when RAG is first enabled, so startup and the RAG-off path
 * never pay for it. The model weights download once (≈25 MB for the
 * bundled default), with the size and consent surfaced by the settings UI
 * before this module is ever asked to load. Everything runs CPU/WASM,
 * on-device (D13-9).
 */

/** A loaded embedder: embeds texts into unit-length Float32 vectors. */
export type ByokRagEmbedder = {|
  id: string,
  dimensions: number,
  embed: (texts: Array<string>) => Promise<Array<Float32Array>>,
|};

export type ByokRagEmbedderLoadResult =
  | {| ok: true, embedder: ByokRagEmbedder |}
  | {| ok: false, error: string |};

/**
 * The Transformers.js module shape this loader uses (declared here so the
 * lazy import stays typed and the tests can inject a factory).
 */
export type ByokTransformersModule = {|
  pipeline: (
    task: string,
    modelId: string,
    options?: { quantized?: boolean, ... }
  ) => Promise<any>,
|};

/** The lazy import — overridable in the tests (null disables loading). */
let transformersLoader: ?() => Promise<ByokTransformersModule> = () =>
  import(// $FlowFixMe[unsupported-syntax] — dynamic import, never at module load.
  '@huggingface/transformers');

/** Replace the lazy loader (tests inject a deterministic fake). */
export const setByokTransformersLoaderForTests = (
  loader: (() => Promise<ByokTransformersModule>) | null
): void => {
  transformersLoader = loader;
};

const normalizeVector = (vector: Float32Array): Float32Array => {
  let sumOfSquares = 0;
  for (const value of vector) sumOfSquares += value * value;
  const norm = Math.sqrt(sumOfSquares);
  if (norm === 0) return vector;
  for (let index = 0; index < vector.length; index++) {
    vector[index] /= norm;
  }
  return vector;
};

const cacheByEmbedderId: Map<string, Promise<ByokRagEmbedder>> = new Map();

/**
 * Load an embedder by id (the curated catalog of ByokRagTypes). The
 * returned vectors are unit-length, so cosine similarity is a plain dot
 * product. Model artifacts load from the Transformers.js cache after the
 * first (consented) download.
 */
export const loadByokRagEmbedder = async (
  embedderId: string
): Promise<ByokRagEmbedderLoadResult> => {
  const info = getByokRagEmbedderInfo(embedderId);
  if (!info) {
    return { ok: false, error: `Unknown embedder "${embedderId}".` };
  }
  const cached = cacheByEmbedderId.get(embedderId);
  if (cached) {
    try {
      return { ok: true, embedder: await cached };
    } catch (error) {
      cacheByEmbedderId.delete(embedderId);
    }
  }
  const loadPromise = (async (): Promise<ByokRagEmbedder> => {
    const loader = transformersLoader;
    if (!loader) {
      throw new Error('The embedder loader is not available.');
    }
    const transformers = await loader();
    // dtype pinned explicitly (audit011026 B-RAG-15): `quantized` is the
    // removed v2 option — v4 loads q8 only via the wasm device default, so
    // any default change would silently diverge the query-side vectors
    // from the pinned-q8 prebuilt bundles.
    const extractor = await transformers.pipeline(
      'feature-extraction',
      embedderId,
      { dtype: 'q8' }
    );
    return {
      id: embedderId,
      dimensions: info.dimensions,
      embed: async (texts: Array<string>) => {
        const outputs: Array<Float32Array> = [];
        for (const text of texts) {
          const output = await extractor(text, {
            pooling: 'mean',
            normalize: true,
          });
          const data = output.data;
          if (!(data instanceof Float32Array)) {
            throw new Error('The embedder returned an unexpected output.');
          }
          outputs.push(normalizeVector(data.slice()));
        }
        return outputs;
      },
    };
  })();
  cacheByEmbedderId.set(embedderId, loadPromise);
  try {
    return { ok: true, embedder: await loadPromise };
  } catch (error) {
    cacheByEmbedderId.delete(embedderId);
    return {
      ok: false,
      error: `The embedder could not be loaded: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
};

/** Forget the cached embedders (tests). */
export const resetByokRagEmbedderCache = (): void => {
  cacheByEmbedderId.clear();
};

/**
 * Drop every cached embedder but the one still in use. Each entry pins a
 * Transformers.js pipeline — tens of megabytes of WASM — so switching
 * embedders in the settings used to keep two models resident for the rest of
 * the session (audit100226 RAG-9). A search already holding the old embedder
 * keeps its own reference, so this is safe to call right after a rebuild.
 */
export const releaseByokRagEmbeddersExcept = (keptEmbedderId: string): void => {
  for (const embedderId of Array.from(cacheByEmbedderId.keys())) {
    if (embedderId !== keptEmbedderId) cacheByEmbedderId.delete(embedderId);
  }
};

/**
 * The deterministic hashing embedder used by the test suite: maps each word
 * to a bucket of a fixed-dimension vector (the bag-of-words hashing trick)
 * and normalizes — cosine similarity then approximates term overlap. It
 * gives the eval set a meaningful ranking signal without any network or
 * model download, and doubles as the offline fallback of the RAG-off
 * lexical search (kept exported for the specs).
 */
export const makeByokHashingEmbedderForTests = (
  dimensions: number = 64
): ByokRagEmbedder => ({
  id: 'hashing-test-embedder',
  dimensions,
  embed: async (texts: Array<string>) =>
    texts.map(text => {
      const vector = new Float32Array(dimensions);
      const words = text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
      for (const word of words) {
        let hash = 0;
        for (let index = 0; index < word.length; index++) {
          hash = (hash * 31 + word.charCodeAt(index)) | 0;
        }
        vector[Math.abs(hash) % dimensions] += 1;
      }
      return normalizeVector(vector);
    }),
});
