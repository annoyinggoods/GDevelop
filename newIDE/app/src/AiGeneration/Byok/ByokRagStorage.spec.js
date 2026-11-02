// @flow
import {
  BYOK_RAG_QDRANT_COLLECTION,
  createByokRagInProcessStore,
  createByokRagQdrantFetchTransport,
  createByokRagQdrantStore,
  type ByokRagFilesBackend,
  type ByokRagQdrantTransport,
} from './Rag/ByokRagStorage';
import { serializeByokRagIndex } from './Rag/ByokRagIndex';
import { makeByokHashingEmbedderForTests } from './Rag/ByokRagEmbedder';

const makeMemoryBackend = (): ByokRagFilesBackend & {
  files: Map<string, string>,
} => {
  const files: Map<string, string> = new Map();
  return ({
    files,
    writeFile: async (fileName: string, content: string) => {
      files.set(fileName, content);
    },
    readFile: async (fileName: string) => files.get(fileName) || null,
    deleteFile: async (fileName: string) => {
      files.delete(fileName);
    },
  }: any);
};

const makeTestIndex = async () => {
  const embedder = makeByokHashingEmbedderForTests(16);
  const chunks = [
    {
      id: 'docs:0:0',
      source: 'docs',
      title: 'Timer events',
      tags: ['docs'],
      text: 'Timers count time in seconds.',
    },
    {
      id: 'example:0:0',
      source: 'example',
      title: 'Timer spawn',
      tags: ['example'],
      text: 'if Timer(2, "SpawnTimer"):',
    },
  ];
  const vectors = await embedder.embed(chunks.map(chunk => chunk.text));
  return serializeByokRagIndex({
    manifest: {
      schemaVersion: 1,
      embedderId: 'hashing-test-embedder',
      corpusHash: 'abc123',
      chunkCount: chunks.length,
      backend: 'in-process',
      builtAt: '2026-09-25T00:00:00.000Z',
    },
    chunks,
    vectors,
  });
};

const makeTestVectorBase64 = (): string => {
  const bytes = new Uint8Array(new Float32Array(384).buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index++) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
};

describe('createByokRagInProcessStore (the storage contract: in-process)', () => {
  it('saves, loads and clears an index', async () => {
    const backend = makeMemoryBackend();
    const store = createByokRagInProcessStore(backend);
    expect(store.kind).toBe('in-process');
    expect(await store.loadIndex()).toBe(null);

    const serialized = await makeTestIndex();
    await store.saveIndex(serialized);
    const loaded = await store.loadIndex();
    if (!loaded) throw new Error('expected a loaded index');
    expect(loaded.manifest.corpusHash).toBe('abc123');
    expect(loaded.chunks.length).toBe(2);

    await store.clear();
    expect(await store.loadIndex()).toBe(null);
  });

  it('survives corrupted stored data (loads null, never throws)', async () => {
    const backend = makeMemoryBackend();
    backend.files.set('index.json', '{not json');
    const store = createByokRagInProcessStore(backend);
    await expect(store.loadIndex()).resolves.toBe(null);
  });

  it('CACHE-7: reads the manifest sidecar without loading the index', async () => {
    const backend = makeMemoryBackend();
    const store = createByokRagInProcessStore(backend);
    const serialized = await makeTestIndex();
    await store.saveIndex(serialized);

    const manifest = await (store.readManifest: any)();
    expect(manifest).not.toBe(null);
    expect(manifest.chunkCount).toBe(2);
    expect(manifest.corpusHash).toBe('abc123');
    expect(manifest.embedderId).toBe('hashing-test-embedder');

    // The whole point: reading the manifest must not deserialize the index.
    // The status card used to base64-decode every vector of a multi-MB file
    // over IPC just to show four numbers.
    backend.files.set('index.json', 'THIS IS NOT AN INDEX');
    expect(await (store.readManifest: any)()).not.toBe(null);
  });

  it('CACHE-7: reports no manifest before anything is stored, and clears it', async () => {
    const backend = makeMemoryBackend();
    const store = createByokRagInProcessStore(backend);
    expect(await (store.readManifest: any)()).toBe(null);

    await store.saveIndex(await makeTestIndex());
    await store.clear();
    // A sidecar left behind would report a built index that no longer exists.
    expect(await (store.readManifest: any)()).toBe(null);
  });

  it('CACHE-7: ignores a corrupted sidecar instead of throwing', async () => {
    const backend = makeMemoryBackend();
    backend.files.set('index.manifest.json', '{not json');
    const store = createByokRagInProcessStore(backend);
    await expect((store.readManifest: any)()).resolves.toBe(null);

    backend.files.set('index.manifest.json', JSON.stringify({ nope: true }));
    await expect((store.readManifest: any)()).resolves.toBe(null);
  });
});

const makeRecordingTransport = (): {|
  transport: ByokRagQdrantTransport,
  requests: Array<{| method: string, path: string, body?: any |}>,
  respondWith: (handler: (request: any) => any) => void,
|} => {
  const requests: Array<{| method: string, path: string, body?: any |}> = [];
  let handler = (request: any) => ({ result: {} });
  return {
    requests,
    respondWith: nextHandler => {
      handler = nextHandler;
    },
    transport: {
      request: async (method, path, body) => {
        requests.push({ method, path, body });
        return handler({ method, path, body });
      },
    },
  };
};

describe('createByokRagQdrantStore (the storage contract: Qdrant)', () => {
  it('creates the collection then upserts the points with their payloads', async () => {
    const { transport, requests } = makeRecordingTransport();
    const store = createByokRagQdrantStore({ transport });
    expect(store.kind).toBe('qdrant');

    const serialized = await makeTestIndex();
    await store.saveIndex(serialized);

    const putCollection: any = requests.find(
      request =>
        request.method === 'PUT' &&
        request.path === `/collections/${BYOK_RAG_QDRANT_COLLECTION}`
    );
    expect(putCollection).toBeTruthy();
    expect(putCollection.body.vectors.distance).toBe('Cosine');

    const upsert: any = requests.find(
      request =>
        request.method === 'PUT' &&
        request.path.startsWith(
          `/collections/${BYOK_RAG_QDRANT_COLLECTION}/points`
        )
    );
    expect(upsert).toBeTruthy();
    expect(upsert.body.points.length).toBe(2);
    expect(upsert.body.points[0].payload.id).toBe('docs:0:0');
    expect(upsert.body.points[0].vector.length).toBeGreaterThan(0);
    // Qdrant point ids are unsigned integers (the chunk id is in the payload).
    expect(Number.isInteger(upsert.body.points[0].id)).toBe(true);
  });

  it('skips the collection creation when it already exists', async () => {
    const { transport, requests, respondWith } = makeRecordingTransport();
    respondWith(() => ({
      result: {
        config: { params: { vectors: { size: 16, distance: 'Cosine' } } },
      },
    }));
    const store = createByokRagQdrantStore({ transport });
    await store.saveIndex(await makeTestIndex());
    expect(
      requests.some(
        request =>
          request.method === 'PUT' &&
          request.path === `/collections/${BYOK_RAG_QDRANT_COLLECTION}` &&
          request.body !== undefined
      )
    ).toBe(false);
  });

  it('clears by deleting the collection', async () => {
    const { transport, requests } = makeRecordingTransport();
    const store = createByokRagQdrantStore({ transport });
    await store.clear();
    expect(
      requests.some(
        request =>
          request.method === 'DELETE' &&
          request.path === `/collections/${BYOK_RAG_QDRANT_COLLECTION}`
      )
    ).toBe(true);
  });
});

describe('createByokRagQdrantFetchTransport', () => {
  it('speaks REST over the loopback origin and throws on HTTP errors', async () => {
    const calls: Array<any> = [];
    const fetchImpl = jest.fn(async (url: string, options: any) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ result: true }) };
    });
    const transport = createByokRagQdrantFetchTransport(
      'http://127.0.0.1:6333/',
      (fetchImpl: any)
    );
    const response = await transport.request('GET', '/collections', undefined);
    expect(response).toEqual({ result: true });
    expect(calls[0].url).toBe('http://127.0.0.1:6333/collections');
    expect(calls[0].options.body).toBe(undefined);
    expect(calls[0].options.method).toBe('GET');

    const failing = jest.fn(async () => ({
      ok: false,
      status: 500,
      statusText: 'boom',
    }));
    const failingTransport = createByokRagQdrantFetchTransport(
      'http://127.0.0.1:6333',
      (failing: any)
    );
    await expect(
      failingTransport.request('PUT', '/collections/x', { a: 1 })
    ).rejects.toThrow('500');
  });
});

describe('importByokRagBundleIntoStore (Phase 14.4)', () => {
  const makeBundleFixture = () => ({
    bundle: 'byok-rag-bundle',
    formatVersion: 1,
    created: '2026-09-27T00:00:00.000Z',
    embedder: {
      id: 'Xenova/all-MiniLM-L6-v2',
      dimensions: 384,
      approximateDownloadMegabytes: 25,
      dtype: 'q8',
    },
    index: {
      manifest: {
        schemaVersion: 1,
        embedderId: 'Xenova/all-MiniLM-L6-v2',
        corpusHash: '1a2b3c4d',
        chunkCount: 1,
        backend: 'in-process',
        builtAt: '2026-09-27T00:00:00.000Z',
      },
      chunks: [
        {
          id: 'docs:0:0',
          source: 'docs',
          title: 'Timers',
          tags: ['docs'],
          text: 'Timers count time.',
        },
      ],
      vectorsBase64: [makeTestVectorBase64()],
    },
    integrity: { indexSha256: 'a'.repeat(64) },
  });

  it('round-trips a valid bundle through the in-process store', async () => {
    const { importByokRagBundleIntoStore } = require('./Rag/ByokRagStorage');
    const backend = makeMemoryBackend();
    const store = createByokRagInProcessStore(backend);
    const outcome = await importByokRagBundleIntoStore(
      store,
      makeBundleFixture()
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('refused');
    expect(outcome.chunkCount).toBe(1);
    // The persisted file is exactly what a local build would have saved,
    // and it loads back through the store.
    expect(backend.files.has('index.json')).toBe(true);
    const loaded = await store.loadIndex();
    expect(loaded && loaded.chunks[0].title).toBe('Timers');
    expect(loaded && loaded.vectors).toHaveLength(1);
  });

  it('uploads a valid bundle into the Qdrant store as points', async () => {
    const { importByokRagBundleIntoStore } = require('./Rag/ByokRagStorage');
    const requests: Array<any> = [];
    const transport = {
      request: jest.fn(async (method: string, path: string, body?: any) => {
        requests.push({ method, path, body });
        if (method === 'GET' && path.startsWith('/collections/gdevelop-byok')) {
          return {
            result: { config: { params: { vectors: { size: 384 } } } },
          };
        }
        return { result: true };
      }),
    };
    const store = createByokRagQdrantStore({ transport: (transport: any) });
    const outcome = await importByokRagBundleIntoStore(
      store,
      makeBundleFixture()
    );
    expect(outcome.ok).toBe(true);
    expect(
      requests.some(
        request =>
          request.method === 'PUT' &&
          request.path.startsWith('/collections/gdevelop-byok/points')
      )
    ).toBe(true);
  });

  it('refuses invalid or malformed bundles WITHOUT writing anything', async () => {
    const { importByokRagBundleIntoStore } = require('./Rag/ByokRagStorage');
    const backend = makeMemoryBackend();
    const store = createByokRagInProcessStore(backend);

    const notABundle = await importByokRagBundleIntoStore(store, {
      hello: 'world',
    });
    expect(notABundle.ok).toBe(false);

    const malformedIndex = makeBundleFixture();
    malformedIndex.index.vectorsBase64 = [];
    const malformed = await importByokRagBundleIntoStore(store, malformedIndex);
    expect(malformed.ok).toBe(false);

    const emptyIndex = makeBundleFixture();
    emptyIndex.index.chunks = [];
    emptyIndex.index.vectorsBase64 = [];
    const empty = await importByokRagBundleIntoStore(store, emptyIndex);
    expect(empty.ok).toBe(false);

    expect(backend.files.size).toBe(0);
  });
});

describe('createByokRagQdrantStore: audit011026 fixes', () => {
  it('B-RAG-2: computes the true float32 dimensions (no double base64 conversion)', async () => {
    const { transport, requests } = makeRecordingTransport();
    const store = createByokRagQdrantStore({ transport });
    // 2 chunks of 16 dims: 64 bytes each decoded → 16 floats.
    await store.saveIndex(await makeTestIndex());
    const putCollection: any = requests.find(
      request =>
        request.method === 'PUT' &&
        request.path === `/collections/${BYOK_RAG_QDRANT_COLLECTION}`
    );
    expect(putCollection.body.vectors.size).toBe(16);
  });

  it('B-RAG-2: drops and recreates an existing collection of the wrong size', async () => {
    const { transport, requests, respondWith } = makeRecordingTransport();
    respondWith(() => ({
      result: {
        config: { params: { vectors: { size: 288, distance: 'Cosine' } } },
      },
    }));
    const store = createByokRagQdrantStore({ transport });
    await store.saveIndex(await makeTestIndex());
    expect(
      requests.some(
        request =>
          request.method === 'DELETE' &&
          request.path === `/collections/${BYOK_RAG_QDRANT_COLLECTION}`
      )
    ).toBe(true);
    const putCollection: any = requests.find(
      request =>
        request.method === 'PUT' &&
        request.path === `/collections/${BYOK_RAG_QDRANT_COLLECTION}`
    );
    expect(putCollection.body.vectors.size).toBe(16);
  });

  it('B-RAG-13: point ids are the deterministic chunk positions (collision-free)', async () => {
    const { transport, requests } = makeRecordingTransport();
    const store = createByokRagQdrantStore({ transport });
    await store.saveIndex(await makeTestIndex());
    const upsert: any = requests.find(
      request =>
        request.method === 'PUT' &&
        request.path.startsWith(
          `/collections/${BYOK_RAG_QDRANT_COLLECTION}/points`
        )
    );
    expect(upsert.body.points.map((point: any) => point.id)).toEqual([1, 2]);
  });
});

describe('createByokRagQdrantStore: the server-side search (audit100226 RAG-1)', () => {
  // The backend was upload-only: `qdrantSearch` was declared and consumed
  // by the search engine but never provided, so after a restart Qdrant
  // users silently degraded to lexical while the card reported healthy.
  it('queries the collection and rebuilds hits from the payloads', async () => {
    const { transport, requests, respondWith } = makeRecordingTransport();
    respondWith(request => {
      if (request.path.endsWith('/points/search')) {
        return {
          result: [
            {
              score: 0.87,
              payload: {
                id: 'docs:0:0',
                source: 'docs',
                title: 'Scenes',
                tags: ['docs'],
                text: 'A scene holds objects.',
              },
            },
            // A malformed point must be dropped, not crash the search.
            { score: 0.5, payload: null },
          ],
        };
      }
      return { result: {} };
    });
    const store = createByokRagQdrantStore({ transport });
    expect(store.search).toBeDefined();

    if (!store.search) throw new Error('the Qdrant store has no search');
    const hits = await store.search(new Float32Array([0.1, 0.2, 0.3]), 5);

    const searchRequest: any = requests.find(request =>
      request.path.endsWith('/points/search')
    );
    expect(searchRequest.method).toBe('POST');
    expect(searchRequest.body.limit).toBe(5);
    expect(searchRequest.body.with_payload).toBe(true);
    expect(searchRequest.body.vector.length).toBe(3);
    expect(hits.length).toBe(1);
    expect(hits[0].chunk.id).toBe('docs:0:0');
    expect(hits[0].score).toBe(0.87);
    expect(hits[0].match).toBe('vector');
  });

  it('reports ready only when the collection actually holds points', async () => {
    const { transport, respondWith } = makeRecordingTransport();
    respondWith(request => {
      if (request.path === `/collections/${BYOK_RAG_QDRANT_COLLECTION}`) {
        return { result: { status: 'green' } };
      }
      if (request.path.endsWith('/points/count')) {
        return { result: { count: 4026 } };
      }
      return { result: {} };
    });
    const store = createByokRagQdrantStore({ transport });
    if (!store.inspect) throw new Error('the Qdrant store has no inspect');
    expect(await store.inspect()).toEqual({ ready: true, pointCount: 4026 });
  });

  it('reports not-ready for an empty or non-green collection', async () => {
    const { transport, respondWith } = makeRecordingTransport();
    respondWith(request => {
      if (request.path === `/collections/${BYOK_RAG_QDRANT_COLLECTION}`) {
        return { result: { status: 'green' } };
      }
      if (request.path.endsWith('/points/count'))
        return { result: { count: 0 } };
      return { result: {} };
    });
    const store = createByokRagQdrantStore({ transport });
    if (!store.inspect) throw new Error('the Qdrant store has no inspect');
    expect(await store.inspect()).toEqual({ ready: false, pointCount: 0 });
  });

  it('RAG-2: deletes the points a SHRINKING corpus no longer has', async () => {
    const { transport, requests, respondWith } = makeRecordingTransport();
    respondWith(request => {
      // The collection already holds 10 points; the new corpus has 2.
      if (request.path.endsWith('/points/count'))
        return { result: { count: 10 } };
      return { result: {} };
    });
    const store = createByokRagQdrantStore({ transport });
    await store.saveIndex(await makeTestIndex());

    const deleteRequest: any = requests.find(request =>
      request.path.endsWith('/points/delete')
    );
    expect(deleteRequest).toBeTruthy();
    // Point ids are chunk positions + 1, so ids 3..10 are the stale tail.
    expect(deleteRequest.body.points).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('issues no delete when the corpus grew (nothing is stale)', async () => {
    const { transport, requests, respondWith } = makeRecordingTransport();
    respondWith(request => {
      if (request.path.endsWith('/points/count'))
        return { result: { count: 1 } };
      return { result: {} };
    });
    const store = createByokRagQdrantStore({ transport });
    await store.saveIndex(await makeTestIndex());
    expect(
      requests.find(request => request.path.endsWith('/points/delete'))
    ).toBeFalsy();
  });
});
