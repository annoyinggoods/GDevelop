// @flow
import {
  ensureByokRagLexicalCorpus,
  getByokRagSearchDepsAsync,
  resetByokRagLexicalCorpusForTests,
  resetByokRagPersistedLoadForTests,
  searchByokRagKnowledge,
  seedByokRagLexicalCorpus,
  setByokRagRuntime,
  setByokRagSettingsProvider,
} from './ByokRagSearch';
import * as ragCorpusModule from './ByokRagCorpus';
import * as ragEmbedderModule from './ByokRagEmbedder';

// The lazy persisted-index recovery requires the build service: mocked so
// the test observes the call without touching storages.
jest.mock('./ByokRagBuildService', () => ({
  loadPersistedByokRagIndex: jest.fn(),
}));

describe('ByokRagSearch: audit011026 fixes', () => {
  afterEach(() => {
    setByokRagRuntime(null);
    setByokRagSettingsProvider(null);
    resetByokRagPersistedLoadForTests();
    resetByokRagLexicalCorpusForTests();
    jest.restoreAllMocks();
  });

  it('B-RAG-1: lazily loads the persisted index when RAG is enabled', async () => {
    const { loadPersistedByokRagIndex } = jest.requireMock(
      './ByokRagBuildService'
    );
    loadPersistedByokRagIndex.mockResolvedValue({ chunkCount: 42 });
    setByokRagSettingsProvider(
      () =>
        ({
          enabled: true,
          backend: 'in-process',
          embedderId: 'x',
          docsFolderPath: '',
          qdrantBaseUrl: '',
        }: any)
    );
    await getByokRagSearchDepsAsync();
    expect(loadPersistedByokRagIndex).toHaveBeenCalled();
  });

  it('B-RAG-1: does not attempt the load when RAG is disabled', async () => {
    const { loadPersistedByokRagIndex } = jest.requireMock(
      './ByokRagBuildService'
    );
    setByokRagSettingsProvider(
      () =>
        ({
          enabled: false,
          backend: 'in-process',
          embedderId: 'x',
          docsFolderPath: '',
          qdrantBaseUrl: '',
        }: any)
    );
    await getByokRagSearchDepsAsync();
    expect(loadPersistedByokRagIndex).not.toHaveBeenCalled();
  });

  it('B-RAG-18: a bare chunk_id neighbor read works without an index (lexical corpus)', async () => {
    const chunks = [
      { id: 'docs:0:0', source: 'docs', title: 'A', text: 'first', tags: [] },
      { id: 'docs:0:1', source: 'docs', title: 'B', text: 'second', tags: [] },
      { id: 'docs:0:2', source: 'docs', title: 'C', text: 'third', tags: [] },
    ];
    const result = await searchByokRagKnowledge({
      query: '',
      nearChunkId: 'docs:0:1',
      deps: { index: null, embedder: null, lexicalChunks: (chunks: any) },
    });
    expect(result.success).toBe(true);
    expect(result.mode).toBe('lexical');
    expect(result.hits.map(hit => hit.chunk.id)).toEqual([
      'docs:0:0',
      'docs:0:1',
      'docs:0:2',
    ]);
  });
  it('A1002-RAG-1: answers semantically with NO local index (the Qdrant backend)', async () => {
    // The Qdrant backend keeps no local index, so `index: null` is the
    // production shape after a restart. Before the fix the semantic path
    // required a local index and every Qdrant query silently degraded to
    // lexical while the settings card reported a healthy index.
    const remoteHit = {
      chunk: {
        id: 'docs:3:1',
        source: 'docs',
        title: 'Collision masks',
        text: 'A sprite collision mask.',
        tags: ['docs'],
      },
      score: 0.9,
      match: 'vector',
    };
    const qdrantSearch = jest.fn(async () => [remoteHit]);
    const embedder: any = {
      embed: async () => [new Float32Array([0.1, 0.2, 0.3])],
    };
    const result = await searchByokRagKnowledge({
      query: 'collision masks',
      deps: {
        index: null,
        embedder,
        lexicalChunks: ([
          {
            id: 'docs:0:0',
            source: 'docs',
            title: 'Unrelated',
            text: 'nothing here',
            tags: [],
          },
        ]: any),
        qdrantSearch: (qdrantSearch: any),
      },
    });
    expect(result.success).toBe(true);
    expect(result.mode).not.toBe('lexical');
    expect(qdrantSearch).toHaveBeenCalled();
    expect(result.hits.map(hit => hit.chunk.id)).toContain('docs:3:1');
  });

  it('A1002-RAG-5: a query whose wording differs by one word still returns hits', async () => {
    // RAG is off by default, so lexical is the mode most users are in. An
    // AND-only match returned NOTHING for a paraphrase although the chunk
    // was right there (the tool answered success with zero hits).
    const chunks = [
      {
        id: 'docs:0:0',
        source: 'docs',
        title: 'Sprite animation',
        text: 'Set the animation speed of the sprite.',
        tags: [],
      },
      {
        id: 'docs:0:1',
        source: 'docs',
        title: 'Unrelated',
        text: 'Scenes contain objects.',
        tags: [],
      },
    ];
    const result = await searchByokRagKnowledge({
      // "animations" does not appear; "animation" does.
      query: 'change animations speed',
      deps: { index: null, embedder: null, lexicalChunks: (chunks: any) },
    });
    expect(result.success).toBe(true);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0].chunk.id).toBe('docs:0:0');
  });

  it('A1002-RAG-5: a full match still outranks a partial one', async () => {
    const chunks = [
      {
        id: 'docs:0:0',
        source: 'docs',
        title: 'Scenes',
        text: 'A scene holds objects and events.',
        tags: [],
      },
      {
        id: 'docs:0:1',
        source: 'docs',
        title: 'Sprite animation',
        text: 'Animation is unrelated to scenes.',
        tags: [],
      },
    ];
    const result = await searchByokRagKnowledge({
      query: 'scene objects',
      deps: { index: null, embedder: null, lexicalChunks: (chunks: any) },
    });
    expect(result.hits[0].chunk.id).toBe('docs:0:0');
  });
});

describe('ByokRagSearch: audit100226 retrieval fixes', () => {
  const makeSettings = (overrides?: Object): any => ({
    enabled: true,
    backend: 'in-process',
    embedderId: 'Xenova/all-MiniLM-L6-v2',
    docsFolderPath: '',
    qdrantBaseUrl: '',
    ...(overrides || {}),
  });

  const makeFakeChunk = (id: string): any => ({
    id,
    source: 'docs',
    title: id,
    text: 'Some documentation text.',
    tags: [],
  });

  afterEach(() => {
    setByokRagRuntime(null);
    setByokRagSettingsProvider(null);
    resetByokRagPersistedLoadForTests();
    resetByokRagLexicalCorpusForTests();
    jest.restoreAllMocks();
  });

  it('A1002-RAG-7: builds the lexical corpus WITH the opt-in docs folder', async () => {
    const buildSpy = jest
      .spyOn(ragCorpusModule, 'buildByokRagCorpus')
      .mockResolvedValue([makeFakeChunk('user-docs:notes.md:0')]);
    jest
      .spyOn(ragCorpusModule, 'makeByokRagDocsFolderReader')
      .mockResolvedValue(
        ({
          listMarkdownFiles: async () => [],
          readFile: async () => '',
        }: any)
      );
    setByokRagSettingsProvider(() =>
      makeSettings({ docsFolderPath: 'C:/docs' })
    );

    const chunks = await ensureByokRagLexicalCorpus();

    expect(chunks).toHaveLength(1);
    // RAG is OFF by default, so this is the corpus almost every user searches.
    // Without the folder, the user's own documentation was invisible until
    // they built an index.
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(buildSpy.mock.calls[0][0]).toEqual({
      docsFolderPath: 'C:/docs',
      docsFolderReader: expect.anything(),
    });
  });

  it('A1002-RAG-7: rebuilds when the opt-in folder is cleared', async () => {
    const buildSpy = jest
      .spyOn(ragCorpusModule, 'buildByokRagCorpus')
      .mockResolvedValue([]);
    jest
      .spyOn(ragCorpusModule, 'makeByokRagDocsFolderReader')
      .mockResolvedValue(
        ({
          listMarkdownFiles: async () => [],
          readFile: async () => '',
        }: any)
      );
    setByokRagSettingsProvider(() =>
      makeSettings({ docsFolderPath: 'C:/docs' })
    );
    await ensureByokRagLexicalCorpus();
    expect(buildSpy).toHaveBeenCalledTimes(1);

    setByokRagSettingsProvider(() => makeSettings({ docsFolderPath: '' }));
    await ensureByokRagLexicalCorpus();
    expect(buildSpy).toHaveBeenCalledTimes(2);
    expect(buildSpy.mock.calls[1][0].docsFolderPath).toBeUndefined();
  });

  it('A1002-RAG-10: two concurrent first searches build the corpus ONCE', async () => {
    let releaseBuild: () => void = () => {};
    const buildGate = new Promise(resolve => {
      releaseBuild = resolve;
    });
    const buildSpy = jest
      .spyOn(ragCorpusModule, 'buildByokRagCorpus')
      .mockImplementation(async () => {
        await buildGate;
        return [makeFakeChunk('docs:0:0')];
      });
    setByokRagSettingsProvider(() => makeSettings());

    const firstSearch = getByokRagSearchDepsAsync();
    const secondSearch = getByokRagSearchDepsAsync();
    releaseBuild();
    const [firstDeps, secondDeps] = await Promise.all([
      firstSearch,
      secondSearch,
    ]);

    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(firstDeps.lexicalChunks).toBe(secondDeps.lexicalChunks);
  });

  it('A1002-CACHE-8: a seeded corpus is reused instead of rebuilt', async () => {
    const buildSpy = jest
      .spyOn(ragCorpusModule, 'buildByokRagCorpus')
      .mockResolvedValue([]);
    setByokRagSettingsProvider(() => makeSettings());

    // What loadPersistedByokRagIndex does on its stale-index path: it built
    // the corpus to hash it, then handed it over instead of letting the tool
    // build the identical corpus again right after.
    const seeded = [makeFakeChunk('docs:0:0')];
    seedByokRagLexicalCorpus(seeded, '');

    const deps = await getByokRagSearchDepsAsync();
    expect(buildSpy).not.toHaveBeenCalled();
    expect(deps.lexicalChunks).toBe(seeded);
  });

  it('A1002-RAG-6: retries a failed embedder load on a runtime that has an index', async () => {
    const repairedEmbedder = ({ id: 'repaired', dimensions: 4 }: any);
    const loadSpy = jest
      .spyOn(ragEmbedderModule, 'loadByokRagEmbedder')
      .mockResolvedValue({ ok: true, embedder: repairedEmbedder });
    setByokRagSettingsProvider(() => makeSettings());
    // The prebuilt-bundle import installs exactly this: a good index whose
    // query-side model failed to load.
    setByokRagRuntime({
      settings: makeSettings(),
      index: ({ chunks: [], vectors: [] }: any),
      embedder: null,
    });

    const deps = await getByokRagSearchDepsAsync();

    expect(loadSpy).toHaveBeenCalledWith('Xenova/all-MiniLM-L6-v2');
    expect(deps.embedder).toBe(repairedEmbedder);
    // The runtime is repaired too, so the NEXT search does not reload it.
    const secondDeps = await getByokRagSearchDepsAsync();
    expect(secondDeps.embedder).toBe(repairedEmbedder);
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  it('A1002-RAG-6: a still-failing embedder is not retried on every search', async () => {
    const loadSpy = jest
      .spyOn(ragEmbedderModule, 'loadByokRagEmbedder')
      .mockResolvedValue({ ok: false, error: 'model file missing' });
    setByokRagSettingsProvider(() => makeSettings());
    setByokRagRuntime({
      settings: makeSettings(),
      index: ({ chunks: [], vectors: [] }: any),
      embedder: null,
    });

    const firstDeps = await getByokRagSearchDepsAsync();
    await getByokRagSearchDepsAsync();

    expect(firstDeps.embedder).toBe(null);
    // One attempt per session: a genuinely broken model must not be
    // re-downloaded on every single search.
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });
});
