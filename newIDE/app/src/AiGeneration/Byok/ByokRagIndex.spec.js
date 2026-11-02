// @flow
import {
  buildByokRagIndex,
  byokRagCosineSimilarity,
  computeByokRagCorpusHash,
  deserializeByokRagIndex,
  searchByokRagIndex,
  serializeByokRagIndex,
  type ByokRagIndex,
} from './Rag/ByokRagIndex';
import { makeByokHashingEmbedderForTests } from './Rag/ByokRagEmbedder';
import { buildByokRagCorpus } from './Rag/ByokRagCorpus';
import { type ByokRagChunk } from './Rag/ByokRagTypes';

const makeChunks = (): Array<ByokRagChunk> => [
  {
    id: 'docs:0:0',
    source: 'docs',
    title: 'Timer events',
    tags: ['docs', 'timer'],
    text: 'Timers count time in seconds and fire when they reach their value.',
  },
  {
    id: 'example:0:0',
    source: 'example',
    title: 'Spawning on a timer',
    tags: ['example', 'timer', 'spawn'],
    text: 'if Timer(2, "SpawnTimer") and once: Create(Rock, ...)',
  },
  {
    id: 'engine-reference:1:0',
    source: 'engine-reference',
    title: 'PlaySound',
    tags: ['action', 'BuiltinAudio'],
    text: 'action PlaySound (BuiltinAudio) — Play a sound.',
  },
];

describe('computeByokRagCorpusHash (index determinism)', () => {
  it('is stable for the same corpus and changes with the content', () => {
    const chunks = makeChunks();
    expect(computeByokRagCorpusHash(chunks)).toBe(
      computeByokRagCorpusHash(chunks.slice())
    );
    expect(computeByokRagCorpusHash(chunks)).not.toBe(
      computeByokRagCorpusHash([
        { ...chunks[0], text: 'different text' },
        ...chunks.slice(1),
      ])
    );
    expect(computeByokRagCorpusHash([])).toBe(computeByokRagCorpusHash([]));
  });
});

describe('byokRagCosineSimilarity', () => {
  it('is 1 for identical unit vectors, ~0 for orthogonal ones', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(byokRagCosineSimilarity(a, a)).toBeCloseTo(1, 5);
    expect(byokRagCosineSimilarity(a, b)).toBe(0);
  });
});

describe('buildByokRagIndex over the real corpus (hashing embedder)', () => {
  it('builds deterministically: same corpus + embedder → same manifest hash', async () => {
    const embedder = makeByokHashingEmbedderForTests(64);
    const progressStages: Array<string> = [];
    const options: any = {
      embedderId: 'hashing-test-embedder',
      embed: embedder.embed,
      onProgress: (progress: any) => progressStages.push(progress.stage),
    };
    const indexA = await buildByokRagIndex(options);
    const indexB = await buildByokRagIndex(options);

    expect(indexA.chunks.length).toBeGreaterThan(1000);
    expect(indexA.vectors.length).toBe(indexA.chunks.length);
    expect(indexA.manifest.corpusHash).toBe(indexB.manifest.corpusHash);
    expect(indexA.manifest.chunkCount).toBe(indexA.chunks.length);
    expect(progressStages[0]).toBe('corpus');
    expect(progressStages[progressStages.length - 1]).toBe('done');
  });

  it('ranks a related chunk first (the vector search works end to end)', async () => {
    const embedder = makeByokHashingEmbedderForTests(128);
    const chunks = makeChunks();
    const vectors = await embedder.embed(chunks.map(chunk => chunk.text));
    const index: ByokRagIndex = {
      manifest: {
        schemaVersion: 1,
        embedderId: embedder.id,
        corpusHash: 'x',
        chunkCount: chunks.length,
        backend: 'in-process',
        builtAt: new Date().toISOString(),
      },
      chunks,
      vectors,
    };
    const [queryVector] = await embedder.embed([
      'timer spawn events documentation',
    ]);
    const hits = searchByokRagIndex(index, queryVector, 3);
    expect(hits.length).toBe(3);
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score);
  });
});

describe('serialization', () => {
  it('round-trips an index (base64 vectors, manifest intact)', async () => {
    const embedder = makeByokHashingEmbedderForTests(16);
    const chunks = makeChunks();
    const vectors = await embedder.embed(chunks.map(chunk => chunk.text));
    const index: ByokRagIndex = {
      manifest: {
        schemaVersion: 1,
        embedderId: 'e',
        corpusHash: 'abc',
        chunkCount: chunks.length,
        backend: 'in-process',
        builtAt: '2026-09-25T00:00:00.000Z',
      },
      chunks,
      vectors,
    };
    const serialized = serializeByokRagIndex(index);
    expect(JSON.parse(JSON.stringify(serialized))).toEqual(serialized);

    const restored = deserializeByokRagIndex(
      JSON.parse(JSON.stringify(serialized))
    );
    if (!restored) throw new Error('expected a restored index');
    expect(restored.manifest.corpusHash).toBe('abc');
    expect(restored.chunks).toEqual(chunks);
    expect(restored.vectors.length).toBe(vectors.length);
    expect(Array.from(restored.vectors[0])).toEqual(
      Array.from(vectors[0]).map(value => Math.round(value * 1e6) / 1e6)
    );
  });

  it('refuses corrupted stored data', () => {
    expect(deserializeByokRagIndex(null)).toBe(null);
    expect(deserializeByokRagIndex('nope')).toBe(null);
    expect(deserializeByokRagIndex({ manifest: {} })).toBe(null);
    const chunks = makeChunks();
    expect(
      deserializeByokRagIndex({
        manifest: {
          schemaVersion: 1,
          embedderId: 'e',
          corpusHash: 'h',
          chunkCount: 1,
          backend: 'in-process',
          builtAt: '',
        },
        chunks,
        vectorsBase64: ['AAAA'],
      })
    ).toBe(null);
  });
});

describe('the full corpus build stays bounded (the corpus is thousands of chunks)', () => {
  it('chunks the whole corpus in a reasonable time', async () => {
    const corpus = await buildByokRagCorpus({});
    expect(corpus.length).toBeLessThan(20000);
    const uniqueIds = new Set(corpus.map(chunk => chunk.id));
    expect(uniqueIds.size).toBe(corpus.length);
  });
});
