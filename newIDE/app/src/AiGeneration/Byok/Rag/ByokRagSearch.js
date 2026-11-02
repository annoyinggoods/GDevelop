// @flow
import { type ByokRagChunk, type ByokRagSettings } from './ByokRagTypes';
import { type ByokRagIndex, searchByokRagIndex } from './ByokRagIndex';
import { type ByokRagEmbedder } from './ByokRagEmbedder';

/**
 * The `search_knowledge` engine (Phase 13.7): hybrid retrieval over the
 * on-device corpus — tag/exact hits first, vector top-k second — and the
 * neighbor read (the model asks for the chunks around a hit by id). With
 * RAG off (or the embedder unavailable) it degrades to the tag/exact
 * search: grep-like, still fully on-device.
 */

export type ByokRagSearchHit = {|
  chunk: ByokRagChunk,
  score: number,
  /** Where the hit came from: an exact/tag match or the vector search. */
  match: 'exact' | 'vector',
|};

export type ByokRagSearchResult = {|
  success: boolean,
  message: string,
  hits: Array<ByokRagSearchHit>,
  mode: 'hybrid' | 'lexical',
|};

/**
 * The lexical half: AND-semantics over the query terms (every term must
 * hit somewhere), scored by WHERE each term hit — title (3) above tags (2)
 * above body text (1) — and multiplied by the source weight, so a curated
 * chunk whose TITLE names the query outranks a minified-wiki chunk that
 * merely contains all the words in prose. Pure.
 */
export const searchByokRagChunksLexically = (
  chunks: Array<ByokRagChunk>,
  query: string,
  resultLimit: number = 5
): Array<ByokRagSearchHit> => {
  const trimmedQuery = query.trim().toLowerCase();
  if (!trimmedQuery) return [];
  const terms = trimmedQuery.split(/\s+/).filter(Boolean);

  // The lowercased view of a corpus, computed once per array instance. The
  // lexical pass lowercased every chunk's title, text and tags on EVERY query
  // (~4k chunks, multi-MB with the wiki corpus, synchronously on the renderer
  // thread) — audit100226 CACHE-6. Keyed weakly so a rebuilt corpus (docs
  // folder changed) recomputes and the old view is collectable.
  type ByokRagLowercasedChunk = {|
    title: string,
    text: string,
    tags: string,
  |};
  const lowercaseViewCache: WeakMap<
    Array<ByokRagChunk>,
    Array<ByokRagLowercasedChunk>
  > = new WeakMap();

  const getLowercaseView = (
    chunks: Array<ByokRagChunk>
  ): Array<ByokRagLowercasedChunk> => {
    const cached = lowercaseViewCache.get(chunks);
    if (cached) return cached;
    const view = chunks.map(chunk => ({
      title: chunk.title.toLowerCase(),
      text: chunk.text.toLowerCase(),
      tags: chunk.tags.map(tag => tag.toLowerCase()).join(' '),
    }));
    lowercaseViewCache.set(chunks, view);
    return view;
  };

  const hits: Array<ByokRagSearchHit> = [];
  const partialHits: Array<ByokRagSearchHit> = [];
  const lowercaseView = getLowercaseView(chunks);
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    const lower = lowercaseView[chunkIndex];
    const title = lower.title;
    const text = lower.text;
    const tags = lower.tags;
    let score = 0;
    let matchedTermCount = 0;
    for (const term of terms) {
      let termScore = 0;
      if (title.includes(term)) termScore = 3;
      else if (tags.includes(term)) termScore = 2;
      else if (text.includes(term)) termScore = 1;
      // A prefix match rescues the plural / inflection / verb-form cases
      // ("animations" vs "animation", "spawned" vs "spawn").
      else if (term.length >= 4 && title.includes(term.slice(0, -1))) {
        termScore = 2;
      } else if (term.length >= 5 && text.includes(term.slice(0, -1))) {
        termScore = 1;
      }
      if (termScore === 0) continue;
      matchedTermCount++;
      score += termScore;
    }
    if (matchedTermCount === 0) continue;
    const weighted = score * getByokRagSourceWeight(chunk.source);
    if (matchedTermCount === terms.length) {
      hits.push({ chunk, score: weighted, match: 'exact' });
      continue;
    }
    // An AND-only pass returned NOTHING for queries whose wording differs
    // from the corpus by one word — and RAG is off by default, so that is
    // the mode most users are in: the tool answered `success:true` with
    // zero hits although the chunk was there (audit100226 RAG-5). Partial
    // matches are kept, ranked below every full match.
    partialHits.push({
      chunk,
      score: (weighted * matchedTermCount) / terms.length,
      match: 'exact',
    });
  }
  hits.sort((a, b) => b.score - a.score || (a.chunk.id < b.chunk.id ? -1 : 1));
  partialHits.sort(
    (a, b) => b.score - a.score || (a.chunk.id < b.chunk.id ? -1 : 1)
  );
  // Partial hits only fill the tail: a full match is always a better
  // answer, so a chunk matching every term outranks one matching most.
  return hits.concat(partialHits).slice(0, resultLimit);
};

/**
 * The neighbors of a chunk: the chunks with the same source document
 * (id prefix `source:documentIndex:`) within ±window positions — the
 * "read around this hit" path of the tool.
 */
export const getByokRagNeighborChunks = (
  chunks: Array<ByokRagChunk>,
  chunkId: string,
  window: number = 2
): Array<ByokRagChunk> => {
  const position = chunks.findIndex(chunk => chunk.id === chunkId);
  if (position === -1) return [];
  const documentPrefix = chunkId
    .split(':')
    .slice(0, 2)
    .join(':');
  const neighbors: Array<ByokRagChunk> = [];
  for (
    let index = Math.max(0, position - window);
    index <= Math.min(chunks.length - 1, position + window);
    index++
  ) {
    if (chunks[index].id.startsWith(documentPrefix)) {
      neighbors.push(chunks[index]);
    }
  }
  return neighbors;
};

/** Everything the search needs at call time. */
export type ByokRagSearchDeps = {|
  index: ?ByokRagIndex,
  embedder: ?ByokRagEmbedder,
  /** The bare corpus for the lexical (RAG-off) mode — no vectors needed. */
  lexicalChunks?: ?Array<ByokRagChunk>,
  /** The Qdrant vector search when the backend is Qdrant. */
  qdrantSearch?: ?(
    queryVector: Float32Array,
    limit: number
  ) => Promise<Array<ByokRagSearchHit>>,
|};

/**
 * The per-source ranking weights of the vector half (Phase 14.2): the
 * whole minified wiki joined the corpus (~1.5k prose chunks), and with the
 * hashing test embedder generic wiki prose started outscoring the exact
 * engine/example/skill chunks the queries were about (long chunks simply
 * overlap more terms). The weights keep every chunk reachable — a genuinely
 * better wiki match still wins — while the curated tiers stay on top for
 * near-equal similarity. The exact/lexical half is unaffected.
 */
export const BYOK_RAG_SOURCE_WEIGHTS: { [string]: number } = {
  'engine-reference': 1.25,
  example: 1.25,
  skill: 1.25,
  docs: 1.1,
  'docs-min': 0.8,
  'docs-min-map': 0.7,
  'user-docs': 1,
};

export const getByokRagSourceWeight = (source: string): number =>
  BYOK_RAG_SOURCE_WEIGHTS[source] || 1;

/**
 * The hybrid search: exact/tag hits first, then the vector top-k (merged,
 * duplicates removed, exact hits kept ahead). Falls back to lexical when
 * there is no embedder or no index (RAG off — the tool still answers).
 */
export const searchByokRagKnowledge = async (options: {|
  query: string,
  tags?: ?Array<string>,
  kind?: ?string,
  nearChunkId?: ?string,
  limit?: number,
  deps: ByokRagSearchDeps,
|}): Promise<ByokRagSearchResult> => {
  const limit = options.limit || 5;
  const index = options.deps.index;

  // The neighbor read needs no query at all — and no vectors: with RAG off
  // (or before the persisted index recovered) the lexical corpus carries
  // the same chunks, so a chunk_id alone still works (audit011026 B-RAG-18).
  const nearChunkId = options.nearChunkId || null;
  if (nearChunkId) {
    const neighborPool = index
      ? index.chunks
      : options.deps.lexicalChunks
      ? options.deps.lexicalChunks
      : null;
    if (neighborPool) {
      const neighbors = getByokRagNeighborChunks(neighborPool, nearChunkId);
      return {
        success: true,
        message:
          neighbors.length > 0
            ? `The chunks around "${nearChunkId}".`
            : `No chunk "${nearChunkId}" in the index — search first, then read around a hit.`,
        hits: neighbors.map(chunk => ({ chunk, score: 1, match: 'exact' })),
        mode: index ? 'hybrid' : 'lexical',
      };
    }
  }

  const query = (options.query || '').trim();
  if (!query) {
    return {
      success: false,
      message: 'The "query" is required (or a chunk_id to read around).',
      hits: [],
      mode: index ? 'hybrid' : 'lexical',
    };
  }

  const pool = index
    ? index.chunks
    : options.deps.lexicalChunks
    ? options.deps.lexicalChunks
    : [];
  const matchesTagFilter = (chunk: ByokRagChunk): boolean => {
    if (options.kind && chunk.source !== options.kind) return false;
    if (options.tags && options.tags.length > 0) {
      const wanted = options.tags.map(tag => tag.toLowerCase());
      return chunk.tags.some(tag => wanted.includes(tag.toLowerCase()));
    }
    return true;
  };
  const filteredPool = pool.filter(matchesTagFilter);

  const exactHits = searchByokRagChunksLexically(filteredPool, query, limit);

  // RAG off (no embedder, and neither a local index nor a remote one):
  // the lexical mode. A Qdrant backend has no local index by design — the
  // vectors live on the server — so `qdrantSearch` alone is enough to
  // answer semantically (audit100226 RAG-1: the backend was upload-only,
  // so every restart degraded Qdrant users to lexical).
  const hasRemoteSearch = !!options.deps.qdrantSearch;
  if (!options.deps.embedder || (!index && !hasRemoteSearch)) {
    return {
      success: true,
      message:
        'Semantic search is off — this is an exact-text search over the corpus. Enable and build the index in Preferences > RAG for semantic ranking.',
      hits: exactHits,
      mode: 'lexical',
    };
  }

  const queryVector = (await options.deps.embedder.embed([query]))[0];

  // A wider candidate pool than the result limit: the source weights below
  // re-rank it, so the pre-weight top-k must not already be all one source.
  const candidateLimit = Math.max(limit * 4, 24);
  let vectorCandidates: Array<ByokRagSearchHit> = [];
  if (options.deps.qdrantSearch) {
    const remoteHits = await options.deps.qdrantSearch(
      queryVector,
      candidateLimit
    );
    vectorCandidates = remoteHits.filter(hit => matchesTagFilter(hit.chunk));
  } else if (index) {
    // No remote search means the local index is the vector half. The gate
    // above already allows the remote case with a null index, so this
    // narrowing is the local-index guarantee.
    vectorCandidates = searchByokRagIndex(index, queryVector, candidateLimit)
      .filter(hit => matchesTagFilter(hit.chunk))
      .map(hit => ({ chunk: hit.chunk, score: hit.score, match: 'vector' }));
  }
  const vectorHits = vectorCandidates
    .map(hit => ({
      ...hit,
      score: hit.score * getByokRagSourceWeight(hit.chunk.source),
    }))
    .sort((a, b) => b.score - a.score || (a.chunk.id < b.chunk.id ? -1 : 1))
    .slice(0, limit);

  // Merge on the shared scale (both halves are source-weighted now): a
  // title-matching exact hit scores ~3+ per term, a strong vector match
  // ≤ ~1.25, so exact evidence leads without starving the vector half the
  // way the pre-14.2 fixed "exact block first" order did once the whole
  // wiki joined the corpus.
  const merged = [...exactHits, ...vectorHits]
    .filter(
      (hit, position, all) =>
        all.findIndex(other => other.chunk.id === hit.chunk.id) === position
    )
    .sort((a, b) => b.score - a.score || (a.chunk.id < b.chunk.id ? -1 : 1))
    .slice(0, limit);
  return {
    success: true,
    message: `${
      merged.length
    } chunk(s) for "${query}" (exact + semantic). Read around a hit with chunk_id.`,
    hits: merged,
    mode: 'hybrid',
  };
};

// --- The runtime holder ------------------------------------------------------
// The loaded index + embedder of this session: built by the RAG settings
// tab, read by the search_knowledge tool. Nothing here is imported at app
// startup — the embedder module is only imported when RAG is enabled.

type ByokRagRuntime = {|
  settings: ByokRagSettings,
  index: ?ByokRagIndex,
  embedder: ?ByokRagEmbedder,
|};

let runtime: ?ByokRagRuntime = null;

// The live RAG settings provider (registered by the chat seam, which holds
// the preferences values): the lazy persisted-index load of
// getByokRagSearchDepsAsync needs to know whether RAG is enabled and with
// which embedder (audit011026 B-RAG-1).
let ragSettingsProvider: ?() => ?ByokRagSettings = null;

/** Register the live RAG settings provider (the chat seam, once). */
export const setByokRagSettingsProvider = (
  provider: ?() => ?ByokRagSettings
): void => {
  ragSettingsProvider = provider;
};

/** What the build service installs as the live search runtime. */
export type ByokRagRuntimeInput = {|
  settings?: ByokRagSettings,
  index?: ?ByokRagIndex,
  embedder?: ?ByokRagEmbedder,
|};

/** Install the live search runtime (the build service; the tests). */
export const setByokRagRuntime = (next: ?ByokRagRuntimeInput): void => {
  runtime = next
    ? {
        settings: next.settings || (({}: any): ByokRagSettings),
        index: next.index || null,
        embedder: next.embedder || null,
      }
    : null;
  // A runtime carrying a usable embedder needs no repair pass anymore.
  if (runtime && runtime.embedder) embedderRepairAttempted = false;
};

// A runtime can hold a perfectly good index with a FAILED embedder (the
// prebuilt-bundle import installs exactly that when the query-side model
// cannot load). Semantic search then stayed off for the whole session: the
// embedder cache evicts failed loads, so the next attempt really can succeed,
// but nothing ever made one (audit100226 RAG-6). One repair attempt per
// session is enough to recover a transient failure without hammering a
// genuinely broken model on every search.
let embedderRepairAttempted = false;

/**
 * Try once to load the embedder of the live runtime's settings, and install
 * it when it succeeds. Returns the embedder, or null when there is nothing
 * to repair or the load failed again.
 */
const repairRuntimeEmbedder = async (): Promise<?ByokRagEmbedder> => {
  const currentRuntime = runtime;
  if (embedderRepairAttempted || !currentRuntime) return null;
  const embedderId = currentRuntime.settings
    ? currentRuntime.settings.embedderId
    : '';
  if (!embedderId) return null;
  embedderRepairAttempted = true;
  const { loadByokRagEmbedder } = require('./ByokRagEmbedder');
  const embedderResult = await loadByokRagEmbedder(embedderId);
  if (!embedderResult.ok) return null;
  setByokRagRuntime({
    settings: currentRuntime.settings,
    index: currentRuntime.index,
    embedder: embedderResult.embedder,
  });
  return embedderResult.embedder;
};

/** The deps the search_knowledge tool passes (null runtime → lexical). */
export const getByokRagSearchDeps = (): ByokRagSearchDeps => ({
  index: runtime ? runtime.index : null,
  embedder: runtime ? runtime.embedder : null,
});

let lexicalCorpusCache: ?Array<ByokRagChunk> = null;
// The docs folder the cached corpus was built from: changing that folder (or
// opting in and out of it) must invalidate the cache, or the user's own files
// would stay invisible until the next restart.
let lexicalCorpusCacheKey: string | null = null;
// The in-flight build, so two concurrent first searches share ONE corpus build
// instead of each paying for it (audit100226 RAG-10).
let lexicalCorpusBuild: ?Promise<Array<ByokRagChunk>> = null;

/** The docs folder the corpus cache is currently keyed on. */
const makeLexicalCorpusKey = (): string => {
  const settings = ragSettingsProvider ? ragSettingsProvider() : null;
  return settings && settings.docsFolderPath ? settings.docsFolderPath : '';
};

const buildLexicalCorpusForKey = async (
  docsFolderPath: string
): Promise<Array<ByokRagChunk>> => {
  const {
    buildByokRagCorpus,
    makeByokRagDocsFolderReader,
  } = require('./ByokRagCorpus');
  return buildByokRagCorpus({
    docsFolderPath: docsFolderPath || undefined,
    // The user's opt-in folder is part of the corpus, so the lexical (RAG-off)
    // mode can answer from their own documentation too — before, only a full
    // build ever indexed them (audit100226 RAG-7).
    docsFolderReader: docsFolderPath
      ? await makeByokRagDocsFolderReader()
      : undefined,
  });
};

/**
 * The corpus without vectors, cached: the lexical (RAG-off) mode of the
 * search_knowledge tool greps this — built once per session, on the first
 * tool call, so the app startup and the RAG-off path never pay for it.
 */
export const ensureByokRagLexicalCorpus = async (): Promise<
  Array<ByokRagChunk>
> => {
  const docsFolderPath = makeLexicalCorpusKey();
  const cached = lexicalCorpusCache;
  if (cached && lexicalCorpusCacheKey === docsFolderPath) return cached;
  const inFlight = lexicalCorpusBuild;
  if (inFlight && lexicalCorpusCacheKey === docsFolderPath) return inFlight;

  lexicalCorpusCacheKey = docsFolderPath;
  const build = buildLexicalCorpusForKey(docsFolderPath);
  lexicalCorpusBuild = build;
  try {
    const chunks = await build;
    lexicalCorpusCache = chunks;
    return chunks;
  } finally {
    // A failed build must not be remembered: the next call retries.
    if (lexicalCorpusBuild === build) lexicalCorpusBuild = null;
  }
};

/**
 * Seed the lexical corpus cache with a corpus somebody else already built.
 * The persisted-index recovery builds the whole corpus to hash it against the
 * index; when that recovery does not install a runtime, the tool then built
 * the IDENTICAL corpus again a moment later for the lexical cache — two full
 * builds on the first search after every restart (audit100226 CACHE-8).
 */
export const seedByokRagLexicalCorpus = (
  chunks: Array<ByokRagChunk>,
  docsFolderPath: string
): void => {
  lexicalCorpusCache = chunks;
  lexicalCorpusCacheKey = docsFolderPath;
};

/** Forget the cached lexical corpus (tests). */
export const resetByokRagLexicalCorpusForTests = (): void => {
  lexicalCorpusCache = null;
  lexicalCorpusCacheKey = null;
  lexicalCorpusBuild = null;
};

/**
 * The deps of the search_knowledge tool: the built index when RAG is on,
 * the bare corpus otherwise (the tool always answers, on-device).
 */
let persistedLoadAttempted = false;

/** The remote (Qdrant) search closure of the live runtime, when set. */
let qdrantSearchFn: ?(
  queryVector: Float32Array,
  limit: number
) => Promise<Array<ByokRagSearchHit>> = null;

export const setByokRagQdrantSearch = (
  search: ?(
    queryVector: Float32Array,
    limit: number
  ) => Promise<Array<ByokRagSearchHit>>
): void => {
  qdrantSearchFn = search;
};

/** Forget the lazy-load state (tests). */
export const resetByokRagPersistedLoadForTests = (): void => {
  persistedLoadAttempted = false;
  embedderRepairAttempted = false;
};

export const getByokRagSearchDepsAsync = async (): Promise<ByokRagSearchDeps> => {
  // A restart wiped the in-memory runtime: when RAG is enabled, the
  // persisted index on disk is loaded lazily HERE (once per session) so
  // semantic search survives app restarts instead of silently degrading
  // to lexical mode while the status card claims a built index
  // (audit011026 B-RAG-1). The heavy modules load only on this path.
  if (!persistedLoadAttempted && (!runtime || !runtime.index)) {
    const settings = ragSettingsProvider ? ragSettingsProvider() : null;
    // Only latch after an ACTUAL attempt: latching on a skipped attempt
    // (RAG disabled, or no provider registered yet) meant enabling RAG
    // later in the same session never loaded the on-disk index until a
    // restart (audit100226 RAG-9).
    if (settings && settings.enabled) {
      persistedLoadAttempted = true;
      const { loadPersistedByokRagIndex } = require('./ByokRagBuildService');
      try {
        await loadPersistedByokRagIndex(settings);
      } catch (error) {
        // A failed recovery degrades to lexical search — never to a crash.
      }
    }
  }
  if (runtime && runtime.index) {
    const liveRuntime = runtime;
    // A good index with no embedder: one repair attempt before answering, so
    // a transient model-load failure does not cost the whole session its
    // semantic search (audit100226 RAG-6).
    if (!liveRuntime.embedder) {
      const repairedEmbedder = await repairRuntimeEmbedder();
      return {
        index: liveRuntime.index,
        embedder: repairedEmbedder || liveRuntime.embedder,
        qdrantSearch: qdrantSearchFn,
      };
    }
    return {
      index: liveRuntime.index,
      embedder: liveRuntime.embedder,
      qdrantSearch: qdrantSearchFn,
    };
  }
  // The Qdrant backend keeps no local index: after a restart the runtime
  // holds only the embedder and the remote-search closure, which is enough
  // to answer semantically (audit100226 RAG-1 — the backend used to be
  // upload-only, so every restart silently degraded to lexical).
  if (runtime && runtime.embedder && qdrantSearchFn) {
    return {
      index: null,
      embedder: runtime.embedder,
      lexicalChunks: await ensureByokRagLexicalCorpus(),
      qdrantSearch: qdrantSearchFn,
    };
  }
  return {
    index: null,
    embedder: null,
    lexicalChunks: await ensureByokRagLexicalCorpus(),
  };
};
