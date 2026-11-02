// @flow
import { buildByokRagIndex } from './Rag/ByokRagIndex';
import { makeByokHashingEmbedderForTests } from './Rag/ByokRagEmbedder';
import {
  getByokRagNeighborChunks,
  searchByokRagChunksLexically,
  searchByokRagKnowledge,
  type ByokRagSearchDeps,
} from './Rag/ByokRagSearch';
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
    id: 'docs:0:1',
    source: 'docs',
    title: 'Timer events',
    tags: ['docs', 'timer'],
    text: 'Reset a timer to start it over with ResetTimer.',
  },
  {
    id: 'docs:0:2',
    source: 'docs',
    title: 'Timer events',
    tags: ['docs', 'timer'],
    text: 'The end of the timer page.',
  },
  {
    id: 'example:0:0',
    source: 'example',
    title: 'Spawning on a timer',
    tags: ['example', 'timer', 'spawn'],
    text: 'if Timer(2, "SpawnTimer") and once: Create(Rock, ...)',
  },
  {
    id: 'engine-reference:0:0',
    source: 'engine-reference',
    title: 'PlaySound',
    tags: ['action', 'BuiltinAudio'],
    text: 'action PlaySound (BuiltinAudio) — Play a sound.',
  },
];

describe('searchByokRagChunksLexically (the RAG-off fallback)', () => {
  it('scores title hits above body hits and caps the results', () => {
    const hits = searchByokRagChunksLexically(makeChunks(), 'timer', 3);
    expect(hits.length).toBe(3);
    expect(hits.every(hit => hit.match === 'exact')).toBe(true);
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score);

    expect(searchByokRagChunksLexically(makeChunks(), 'zzz')).toEqual([]);
    expect(searchByokRagChunksLexically(makeChunks(), '  ')).toEqual([]);
  });

  it('ranks a full multi-word match above a partial one', () => {
    const hits = searchByokRagChunksLexically(makeChunks(), 'play sound', 5);
    expect(hits.map(hit => hit.chunk.title)).toContain('PlaySound');
    expect(hits[0].chunk.title).toBe('PlaySound');
    // A query where only one term occurs still answers (partial matches are
    // ranked below every full match) rather than returning nothing: RAG is
    // off by default, so lexical is the mode most users are in, and an
    // AND-only pass answered `success: true` with zero hits for any
    // paraphrase or inflection (audit100226 RAG-5).
    const partial = searchByokRagChunksLexically(
      makeChunks(),
      'play zzzword',
      5
    );
    expect(partial.length).toBeGreaterThan(0);
    // A term matching nothing anywhere still yields nothing.
    expect(
      searchByokRagChunksLexically(makeChunks(), 'zzzword qqqword', 5)
    ).toEqual([]);
  });
});

describe('getByokRagNeighborChunks (the read-around-a-hit path)', () => {
  it('returns the surrounding chunks of the same document', () => {
    const neighbors = getByokRagNeighborChunks(makeChunks(), 'docs:0:1', 1);
    expect(neighbors.map(chunk => chunk.id)).toEqual([
      'docs:0:0',
      'docs:0:1',
      'docs:0:2',
    ]);
    // The window never crosses into another document (the anchor itself
    // stays in the result — reading around includes where you are).
    expect(
      getByokRagNeighborChunks(makeChunks(), 'docs:0:0', 2).map(c => c.id)
    ).toEqual(['docs:0:0', 'docs:0:1', 'docs:0:2']);
    expect(
      getByokRagNeighborChunks(makeChunks(), 'example:0:0', 5).map(c => c.id)
    ).toEqual(['example:0:0']);
    expect(getByokRagNeighborChunks(makeChunks(), 'unknown:1:1')).toEqual([]);
  });
});

describe('searchByokRagKnowledge', () => {
  it('answers lexically (RAG off: corpus only, no embedder) with an explicit mode', async () => {
    const result = await searchByokRagKnowledge({
      query: 'timer',
      deps: { index: null, embedder: null, lexicalChunks: makeChunks() },
    });
    expect(result.mode).toBe('lexical');
    expect(result.success).toBe(true);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.message).toContain('exact-text search');
  });

  it('merges exact and vector hits without duplicates (hybrid mode)', async () => {
    const embedder = makeByokHashingEmbedderForTests(64);
    const chunks = makeChunks();
    const vectors = await embedder.embed(
      chunks.map(chunk => `${chunk.title}\n${chunk.text}`)
    );
    const deps: ByokRagSearchDeps = {
      index: {
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
      },
      embedder,
    };
    const result = await searchByokRagKnowledge({ query: 'timer spawn', deps });
    expect(result.mode).toBe('hybrid');
    const ids = result.hits.map(hit => hit.chunk.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.hits.some(hit => hit.match === 'exact')).toBe(true);
  });

  it('filters by kind and tags, and reads around a chunk by id', async () => {
    const embedder = makeByokHashingEmbedderForTests(64);
    const chunks = makeChunks();
    const vectors = await embedder.embed(
      chunks.map(chunk => `${chunk.title}\n${chunk.text}`)
    );
    const deps: ByokRagSearchDeps = {
      index: {
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
      },
      embedder,
    };
    const onlyDocs = await searchByokRagKnowledge({
      query: 'timer',
      kind: 'docs',
      deps,
    });
    expect(onlyDocs.hits.every(hit => hit.chunk.source === 'docs')).toBe(true);

    const neighbors = await searchByokRagKnowledge({
      query: '',
      nearChunkId: 'docs:0:1',
      deps,
    });
    expect(neighbors.success).toBe(true);
    expect(neighbors.hits.map(hit => hit.chunk.id)).toContain('docs:0:0');

    const empty = await searchByokRagKnowledge({ query: '', deps });
    expect(empty.success).toBe(false);
  });
});

describe('the search_knowledge eval set (top-3 hit rate, on-device)', () => {
  // The shared eval set (14.5): the same queries the Node-side
  // eval-embedder.js runner scores an embedder with — one source of truth.
  const EXPECTED_QUERIES: Array<{|
    query: string,
    expectedSource: string,
    expectedHint?: string,
  |}> = require('./evals/byok-rag-eval-queries.json');

  it('returns the expected source in the top 3 for at least 70% of the eval queries', async () => {
    const embedder = makeByokHashingEmbedderForTests(128);
    const index = await buildByokRagIndex({
      embedderId: embedder.id,
      embed: embedder.embed,
    });
    const deps: ByokRagSearchDeps = { index, embedder };

    const misses: Array<string> = [];
    for (const expected of EXPECTED_QUERIES) {
      // eslint-disable-next-line no-await-in-loop
      const result = await searchByokRagKnowledge({
        query: expected.query,
        deps,
        limit: 3,
      });
      const isHit = result.hits.some(hit => {
        const sourceMatches = hit.chunk.source === expected.expectedSource;
        const hintMatches =
          !expected.expectedHint ||
          hit.chunk.text.includes(expected.expectedHint) ||
          hit.chunk.title.includes((expected.expectedHint: any));
        return sourceMatches && hintMatches;
      });
      if (!isHit) misses.push(expected.query);
    }
    const hitRate = 1 - misses.length / EXPECTED_QUERIES.length;
    // The hit-rate threshold of the phase: meaningful retrieval quality
    // even with the deterministic test embedder (the real MiniLM does
    // better); a regression below it fails loudly.
    if (hitRate < 0.7) {
      throw new Error(
        `search_knowledge eval hit rate ${(hitRate * 100).toFixed(
          0
        )}% — misses: ${misses.join(' | ')}`
      );
    }
  }, 240000);
});

describe('search_knowledge over the minified wiki (Phase 14.2, D14-2)', () => {
  // The whole wiki is bundled minified: with RAG OFF (no index, no
  // embedder — lexical only) and fully offline, a chat can discover the
  // right page through its category map and read the minified body.
  it('discovers a page via its category map and its minified chunks, lexically', async () => {
    const {
      buildByokRagMinifiedDocsMapChunks,
      buildByokRagMinifiedDocsPageChunks,
    } = require('./Rag/ByokRagCorpus');
    const chunks = [
      ...buildByokRagMinifiedDocsMapChunks(),
      ...buildByokRagMinifiedDocsPageChunks(),
    ];
    expect(chunks.length).toBeGreaterThan(500);

    // Pick a real page from a real map line (path — title — summary); the
    // header line of a map chunk also contains an em dash, so match the
    // listing shape exactly.
    const mapChunks = chunks.filter(chunk => chunk.source === 'docs-min-map');
    const firstLine = mapChunks[0].text
      .split('\n')
      .find(line => /^\S+\.md — .+ — /.test(line));
    if (!firstLine) throw new Error('The map chunk lists no pages');
    const pagePath = firstLine.slice(0, firstLine.indexOf(' — '));
    const pageTitle = firstLine.split(' — ')[1];
    const term = pageTitle
      .split(/\s+/)
      .filter(word => word.length > 3)
      .map(word => word.toLowerCase().replace(/[^a-z0-9]/g, ''))
      .find(Boolean);
    if (!term) throw new Error('No usable search term in the page title');

    // The drill-down the prompt's hint line teaches: browse by map first
    // (tags: ["map"]), then pull the page's minified chunks.
    const deps: ByokRagSearchDeps = {
      index: null,
      embedder: null,
      lexicalChunks: chunks,
    };
    const mapResult = await searchByokRagKnowledge({
      query: term,
      tags: ['map'],
      deps,
    });
    expect(mapResult.mode).toBe('lexical');
    expect(mapResult.success).toBe(true);
    expect(mapResult.hits.length).toBeGreaterThan(0);
    expect(
      mapResult.hits.every(hit => hit.chunk.source === 'docs-min-map')
    ).toBe(true);

    const pageResult = await searchByokRagKnowledge({ query: term, deps });
    expect(pageResult.mode).toBe('lexical');
    const pageHit = pageResult.hits.find(
      hit =>
        hit.chunk.source === 'docs-min' &&
        hit.chunk.id.startsWith(`docs-min:${pagePath}:`)
    );
    if (!pageHit) throw new Error(`No minified chunk hit for ${pagePath}`);
    // The hit itself carries the full-depth pointer.
    expect(pageHit.chunk.text).toContain(
      `Full page: read_doc_page('${pagePath}').`
    );
  });
});

describe('getByokRagSourceWeight (the Phase 14.2 vector re-ranking)', () => {
  it('weights the curated tiers above the minified-wiki prose, 1 for unknowns', () => {
    const { getByokRagSourceWeight } = require('./Rag/ByokRagSearch');
    expect(getByokRagSourceWeight('engine-reference')).toBeGreaterThan(
      getByokRagSourceWeight('docs-min')
    );
    expect(getByokRagSourceWeight('skill')).toBeGreaterThan(
      getByokRagSourceWeight('docs-min-map')
    );
    expect(getByokRagSourceWeight('docs')).toBeGreaterThan(
      getByokRagSourceWeight('docs-min')
    );
    expect(getByokRagSourceWeight('user-docs')).toBe(1);
    expect(getByokRagSourceWeight('anything-else')).toBe(1);
  });
});
