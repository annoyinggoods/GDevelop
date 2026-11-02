// @flow
import {
  loadByokRagEmbedder,
  makeByokHashingEmbedderForTests,
  releaseByokRagEmbeddersExcept,
  resetByokRagEmbedderCache,
  setByokTransformersLoaderForTests,
  type ByokTransformersModule,
} from './Rag/ByokRagEmbedder';

describe('loadByokRagEmbedder (the lazy Transformers.js loader)', () => {
  beforeEach(() => {
    resetByokRagEmbedderCache();
  });
  afterEach(() => {
    setByokTransformersLoaderForTests(
      // Restore the real lazy loader (never called in these tests).
      null
    );
  });

  const makeFakeTransformers = (): {|
    module: ByokTransformersModule,
    pipelineCalls: Array<string>,
  |} => {
    const pipelineCalls: Array<string> = [];
    const module: any = {
      pipeline: async (task: string, modelId: string) => {
        pipelineCalls.push(`${task}:${modelId}`);
        return async (text: string, options: any) => {
          // A deterministic pseudo-embedding: the char codes of the text.
          const vector = new Float32Array(8);
          for (let index = 0; index < text.length; index++) {
            vector[index % 8] += text.charCodeAt(index);
          }
          return { data: vector };
        };
      },
    };
    return { module: (module: any), pipelineCalls };
  };

  it('loads the embedder through the lazy loader and normalizes vectors', async () => {
    const { module, pipelineCalls } = makeFakeTransformers();
    setByokTransformersLoaderForTests(async () => module);

    const result = await loadByokRagEmbedder('Xenova/all-MiniLM-L6-v2');
    if (!result.ok) throw new Error('expected ok');
    expect(pipelineCalls).toEqual([
      'feature-extraction:Xenova/all-MiniLM-L6-v2',
    ]);
    expect(result.embedder.id).toBe('Xenova/all-MiniLM-L6-v2');
    expect(result.embedder.dimensions).toBe(384);

    const [vector] = await result.embedder.embed(['hello']);
    const magnitude = Math.sqrt(
      vector.reduce((sum, value) => sum + value * value, 0)
    );
    expect(magnitude).toBeCloseTo(1, 5);
  });

  it('caches a loaded model: the pipeline is created once', async () => {
    const { module, pipelineCalls } = makeFakeTransformers();
    setByokTransformersLoaderForTests(async () => module);
    await loadByokRagEmbedder('Xenova/all-MiniLM-L6-v2');
    await loadByokRagEmbedder('Xenova/all-MiniLM-L6-v2');
    expect(pipelineCalls).toHaveLength(1);
  });

  it('refuses an unknown embedder id', async () => {
    const result = await loadByokRagEmbedder('not-a-real-model');
    expect(result.ok).toBe(false);
  });

  it('reports a failing loader as a clean error (RAG never hard-crashes)', async () => {
    setByokTransformersLoaderForTests(async () => {
      throw new Error('no network');
    });
    const result = await loadByokRagEmbedder('Xenova/all-MiniLM-L6-v2');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('could not be loaded');
  });

  it('RAG-9: releases every embedder but the one still in use', async () => {
    const { module, pipelineCalls } = makeFakeTransformers();
    setByokTransformersLoaderForTests(async () => module);

    await loadByokRagEmbedder('Xenova/all-MiniLM-L6-v2');
    await loadByokRagEmbedder('Xenova/bge-small-en-v1.5');
    // Each entry pins a Transformers.js pipeline (tens of MB of WASM):
    // switching embedders used to keep both models resident forever.
    expect(pipelineCalls).toHaveLength(2);

    releaseByokRagEmbeddersExcept('Xenova/bge-small-en-v1.5');

    // The kept one is still cached (no new pipeline), the dropped one is
    // loaded again from scratch.
    await loadByokRagEmbedder('Xenova/bge-small-en-v1.5');
    expect(pipelineCalls).toHaveLength(2);
    await loadByokRagEmbedder('Xenova/all-MiniLM-L6-v2');
    expect(pipelineCalls).toHaveLength(3);
  });
});

describe('makeByokHashingEmbedderForTests', () => {
  it('embeds deterministically, with unit vectors', async () => {
    const embedder = makeByokHashingEmbedderForTests(32);
    const [a, b] = await embedder.embed(['collision timer', 'collision']);
    expect(a).toEqual((await embedder.embed(['collision timer']))[0]);
    const magnitude = Math.sqrt(
      Array.from(b).reduce((sum, value) => sum + value * value, 0)
    );
    expect(magnitude).toBeCloseTo(1, 5);
    expect(embedder.dimensions).toBe(32);
  });
});
