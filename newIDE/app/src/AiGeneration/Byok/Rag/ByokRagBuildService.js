// @flow
import { type ByokRagSettings } from './ByokRagTypes';
import {
  buildByokRagIndex,
  computeByokRagCorpusHash,
  deserializeByokRagIndex,
  isByokRagIndexUpToDate,
  serializeByokRagIndex,
  type ByokRagIndexProgress,
} from './ByokRagIndex';
import { loadByokRagEmbedder } from './ByokRagEmbedder';
import {
  createByokRagInProcessStore,
  createByokRagQdrantFetchTransport,
  createByokRagQdrantStore,
  importByokRagBundleIntoStore,
  type ByokRagStore,
} from './ByokRagStorage';
import {
  checkByokRagBundleCompatibility,
  validateByokRagBundleEnvelope,
} from './ByokRagBundle';
import { createByokRagFilesBackendForPlatform } from './ByokRagFileBackends';
import { setByokRagRuntime, setByokRagQdrantSearch } from './ByokRagSearch';

/**
 * The RAG build/enable service (Phase 13.7/13.8): what the RAG settings
 * tab and the app-start hook drive. Everything heavy (the embedder import,
 * the corpus build) happens HERE, on enable — the app startup and the
 * RAG-off path never import any of it (the lazy-load guarantee).
 */

export type ByokRagBuildProgress = {|
  stage: 'embedding' | 'uploading' | 'done',
  progress: number,
|};

export type ByokRagBuildOutcome =
  | {| ok: true, chunkCount: number |}
  | {| ok: false, error: string |};

/** The store of the settings: in-process files, or Qdrant over loopback. */
const makeStoreForSettings = (settings: ByokRagSettings): ?ByokRagStore => {
  if (settings.backend === 'qdrant') {
    const fetchImpl: any = typeof window !== 'undefined' ? window.fetch : null;
    if (!fetchImpl) return null;
    return createByokRagQdrantStore({
      transport: createByokRagQdrantFetchTransport(
        settings.qdrantBaseUrl,
        fetchImpl
      ),
    });
  }
  const backend = createByokRagFilesBackendForPlatform();
  if (!backend) return null;
  return createByokRagInProcessStore(backend);
};

/**
 * Build (or rebuild) the index of the current settings and install it as
 * the live search runtime. The embedder download happens here (the consent
 * UI ran before — D13-9). A failure is a clean outcome, never a throw: RAG
 * falls back to the lexical search.
 */
export const rebuildByokRagIndex = async (options: {|
  settings: ByokRagSettings,
  onProgress?: (progress: ByokRagBuildProgress) => void,
|}): Promise<ByokRagBuildOutcome> => {
  const { settings } = options;
  const embedderResult = await loadByokRagEmbedder(settings.embedderId);
  if (!embedderResult.ok) {
    return { ok: false, error: embedderResult.error };
  }
  const embedder = embedderResult.embedder;

  const store = makeStoreForSettings(settings);
  if (!store) {
    return {
      ok: false,
      error:
        'The index could not be stored on this platform (no file backend).',
    };
  }

  let index = null;
  try {
    index = await buildByokRagIndex({
      embedderId: settings.embedderId,
      embed: embedder.embed,
      docsFolderPath: settings.docsFolderPath || undefined,
      docsFolderReader: settings.docsFolderPath
        ? await makeDocsFolderReader()
        : undefined,
      backend: settings.backend,
      onProgress: (progress: ByokRagIndexProgress) => {
        if (options.onProgress) {
          options.onProgress({
            stage: 'embedding',
            progress: progress.progress,
          });
        }
      },
    });
  } catch (error) {
    // "A failure is a clean outcome, never a throw" is this function's
    // contract — a mid-corpus embedder abort (WASM OOM at batch N) must not
    // propagate and leave the settings tab stuck on "Building…"
    // (audit011026 B-RAG-6).
    return {
      ok: false,
      error: `Building the index failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (options.onProgress) {
    options.onProgress({ stage: 'uploading', progress: 1 });
  }
  try {
    await store.saveIndex(serializeByokRagIndex(index));
  } catch (error) {
    return {
      ok: false,
      error: `The index could not be saved: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  setByokRagRuntime({
    settings,
    index,
    embedder,
  });
  // After a Qdrant rebuild the vectors live on the server, so the live
  // search must go through it rather than the in-memory index
  // (audit100226 RAG-1).
  setByokRagQdrantSearch(store.search || null);
  // The freshly built corpus IS the lexical one: hand it over rather than
  // letting the next search build it a second time (audit100226 CACHE-8).
  seedLexicalCorpus(index.chunks, settings);
  // The previous embedder is now dead weight: a rebuild with another
  // embedder would otherwise keep both models resident (audit100226 RAG-9).
  releaseOtherEmbedders(settings.embedderId);
  if (options.onProgress) {
    options.onProgress({ stage: 'done', progress: 1 });
  }
  return { ok: true, chunkCount: index.chunks.length };
};

/**
 * Load a persisted in-process index (if any, and up to date) into the live
 * runtime — the recovery path when the app restarted and the in-memory
 * runtime is gone (audit011026 B-RAG-1: the built index sits on disk in
 * `<userData>/byok-rag/index.json`; without this call every restart
 * silently degraded `search_knowledge` to lexical mode). Returns null when
 * there is nothing to load (the tab offers a build).
 */
export const loadPersistedByokRagIndex = async (
  settings: ByokRagSettings
): Promise<?{| chunkCount: number |}> => {
  // The Qdrant backend keeps no local index to load: what must survive a
  // restart is the REMOTE search, so recovery verifies the collection
  // really holds points and installs the search closure + embedder. Without
  // this the backend was upload-only and every restart degraded Qdrant
  // users to lexical while the status card reported healthy (audit100226
  // RAG-1).
  if (settings.backend === 'qdrant') {
    const qdrantStore = makeStoreForSettings(settings);
    if (!qdrantStore || !qdrantStore.search || !qdrantStore.inspect) {
      return null;
    }
    let remoteState;
    try {
      remoteState = await qdrantStore.inspect();
    } catch (error) {
      // Qdrant is not running (or refused): no runtime, lexical degrade.
      return null;
    }
    if (!remoteState.ready) return null;
    const embedderResult = await loadByokRagEmbedder(settings.embedderId);
    if (!embedderResult.ok) return null;
    setByokRagRuntime({
      settings,
      index: null,
      embedder: embedderResult.embedder,
    });
    setByokRagQdrantSearch(qdrantStore.search);
    releaseOtherEmbedders(settings.embedderId);
    return { chunkCount: remoteState.pointCount };
  }
  if (settings.backend !== 'in-process') return null;
  const store = makeStoreForSettings(settings);
  if (!store) return null;
  const stored = await store.loadIndex();
  if (!stored) return null;
  // The freshness check compares against the CURRENT corpus (an app update
  // that changed the bundled docs must not serve stale vectors — the same
  // rule the prebuilt-bundle import enforces).
  const { buildByokRagCorpus } = require('./ByokRagCorpus');
  const currentChunks = await buildByokRagCorpus({
    docsFolderPath: settings.docsFolderPath || undefined,
    docsFolderReader: settings.docsFolderPath
      ? await makeDocsFolderReader()
      : undefined,
  });
  if (
    !isByokRagIndexUpToDate(
      stored,
      settings.embedderId,
      computeByokRagCorpusHash(currentChunks)
    )
  ) {
    // A different embedder or a different corpus: the vectors are
    // meaningless — rebuild. The corpus we just built IS the lexical one, so
    // hand it over instead of letting the tool build it again right after
    // (audit100226 CACHE-8).
    seedLexicalCorpus(currentChunks, settings);
    return null;
  }
  const embedderResult = await loadByokRagEmbedder(settings.embedderId);
  if (!embedderResult.ok) {
    // Same story: the index is unusable without its embedder, and the tool
    // will answer from the lexical corpus — the one already built.
    seedLexicalCorpus(currentChunks, settings);
    return null;
  }
  setByokRagRuntime({
    settings,
    index: stored,
    embedder: embedderResult.embedder,
  });
  releaseOtherEmbedders(settings.embedderId);
  return { chunkCount: stored.chunks.length };
};

/** Hand an already-built corpus to the lexical cache of the search module. */
const seedLexicalCorpus = (
  chunks: Array<any>,
  settings: ByokRagSettings
): void => {
  const { seedByokRagLexicalCorpus } = require('./ByokRagSearch');
  seedByokRagLexicalCorpus(chunks, settings.docsFolderPath || '');
};

/**
 * Keep at most ONE embedder model resident. The cache holds every embedder it
 * ever loaded, so switching embedders in the settings left two models (each
 * tens of megabytes of WASM) alive for the rest of the session
 * (audit100226 RAG-9).
 */
const releaseOtherEmbedders = (keptEmbedderId: string): void => {
  const { releaseByokRagEmbeddersExcept } = require('./ByokRagEmbedder');
  releaseByokRagEmbeddersExcept(keptEmbedderId);
};

/** The docs-folder reader of the desktop build (injected in the tests). */
const makeDocsFolderReader = async (): Promise<any> => {
  const { makeByokRagDocsFolderReader } = require('./ByokRagCorpus');
  return makeByokRagDocsFolderReader();
};

/** Read the persisted index metadata for the status card (no loading). */
export const readByokRagIndexStatus = async (
  settings: ByokRagSettings
): Promise<?{|
  chunkCount: number,
  corpusHash: string,
  builtAt: string,
  embedderId: string,
|}> => {
  // The Qdrant backend has no local manifest; report what the server
  // actually holds so the card tells the truth instead of showing "no index
  // built" while semantic search is live (audit100226 RAG-1). A dead server
  // reports nothing rather than a fabricated healthy state.
  if (settings.backend === 'qdrant') {
    const store = makeStoreForSettings(settings);
    if (!store || !store.inspect) return null;
    try {
      const remoteState = await store.inspect();
      if (!remoteState.ready) return null;
      return {
        chunkCount: remoteState.pointCount,
        corpusHash: '',
        builtAt: '',
        embedderId: settings.embedderId,
      };
    } catch (error) {
      return null;
    }
  }
  if (settings.backend !== 'in-process') return null;
  const store = makeStoreForSettings(settings);
  if (!store) return null;
  // Read the manifest sidecar, not the index: deserializing a multi-MB index
  // (base64-decoding and checking every vector) to show four numbers made
  // every settings-tab refresh read the whole file over IPC
  // (audit100226 CACHE-7). The full read stays as the fallback for an index
  // written before the sidecar existed.
  let manifest = store.readManifest ? await store.readManifest() : null;
  if (!manifest) {
    const stored = await store.loadIndex();
    if (!stored) return null;
    manifest = stored.manifest;
  }
  return {
    chunkCount: manifest.chunkCount,
    corpusHash: manifest.corpusHash,
    builtAt: manifest.builtAt,
    embedderId: manifest.embedderId,
  };
};

/**
 * The corpus hash of THIS app installation's bundled corpus (the freshness
 * check of the prebuilt bundle, D14-3). Injected in the tests; the default
 * builds the real corpus (a couple of seconds, pure).
 */
export const getCurrentByokRagCorpusHash = async (
  injectedCorpusHash?: ?string
): Promise<string> => {
  if (injectedCorpusHash) return injectedCorpusHash;
  const { buildByokRagCorpus } = require('./ByokRagCorpus');
  const chunks = await buildByokRagCorpus({});
  return computeByokRagCorpusHash(chunks);
};

export type ByokRagImportOutcome =
  | {| ok: true, chunkCount: number, embedderReady: boolean |}
  | {| ok: false, error: string |};

/**
 * Import a downloaded prebuilt bundle (Phase 14.4, D14-3): validate the
 * envelope, refuse any embedder/corpus mismatch (offer a local rebuild
 * instead — never serve stale vectors), persist the index through the
 * store exactly like a local build, and install the live runtime. The
 * query-side embedder download (~25 MB, D13-9 consent) is part of the
 * deal: it loads here, and a failure degrades to lexical search with an
 * honest note rather than failing the import.
 */
export const importPrebuiltByokRagIndex = async (options: {|
  settings: ByokRagSettings,
  rawBundle: any,
  corpusHash?: ?string,
|}): Promise<ByokRagImportOutcome> => {
  const { settings } = options;
  const validation = validateByokRagBundleEnvelope(options.rawBundle);
  if (!validation.ok) return { ok: false, error: validation.error };
  const bundle = validation.bundle;

  const corpusHash = await getCurrentByokRagCorpusHash(options.corpusHash);
  const compatibility = checkByokRagBundleCompatibility(bundle, {
    embedderId: settings.embedderId,
    corpusHash,
  });
  if (!compatibility.ok) return { ok: false, error: compatibility.error };

  const store = makeStoreForSettings(settings);
  if (!store) {
    return {
      ok: false,
      error: 'The index could not be stored on this platform.',
    };
  }
  const importOutcome = await importByokRagBundleIntoStore(store, bundle);
  if (!importOutcome.ok) return importOutcome;

  const stored = deserializeByokRagIndex(bundle.index);
  if (!stored) {
    return { ok: false, error: 'The bundled index payload is malformed.' };
  }
  const embedderResult = await loadByokRagEmbedder(settings.embedderId);
  const embedder = embedderResult.ok ? embedderResult.embedder : null;
  setByokRagRuntime({ settings, index: stored, embedder });
  return {
    ok: true,
    chunkCount: importOutcome.chunkCount,
    embedderReady: !!embedder,
  };
};
