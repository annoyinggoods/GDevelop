// @flow

/**
 * The on-device RAG types and settings (Phase 13.7/13.8): the corpus
 * chunks, the index manifest, the embedder catalog and the preferences
 * blob (`byokRag` — kept out of the `byok` settings so the BYOK blob stays
 * stable). Privacy invariant D13-9: embeddings, corpus and vectors stay on
 * the machine; the only network calls are the one-time embedder download
 * (consented) and the optional Qdrant binary download.
 */

/** One retrievable chunk of the corpus. */
export type ByokRagChunk = {|
  /** Stable id: `<source>:<n>` — the model uses it to read neighbors. */
  id: string,
  /** Corpus origin: engine-reference | docs | skill | example | user-docs. */
  source: string,
  /** Human title (the entry name, the page title, the skill name…). */
  title: string,
  /** Kind/tag filter facets (e.g. action, condition, timer, spawn). */
  tags: Array<string>,
  /** The retrievable text. */
  text: string,
|};

/** The manifest of a built index (determinism: same corpus → same hash). */
export type ByokRagManifest = {|
  schemaVersion: number,
  embedderId: string,
  /** A stable hash of the corpus chunks (ids + texts). */
  corpusHash: string,
  chunkCount: number,
  backend: 'in-process' | 'qdrant',
  builtAt: string,
|};

/**
 * A curated embedder of the picker (D13-1): the bundled default is a
 * MiniLM-class ONNX model (≈25 MB, CPU/WASM); the alternatives trade a
 * bigger download for better recall.
 */
export type ByokRagEmbedderInfo = {|
  id: string,
  label: string,
  /** The approximate download size, shown with explicit consent (D13-9). */
  approximateDownloadMegabytes: number,
  dimensions: number,
  languageNote: string,
|};

export const BYOK_RAG_EMBEDDERS: Array<ByokRagEmbedderInfo> = [
  {
    id: 'Xenova/all-MiniLM-L6-v2',
    label: 'MiniLM L6 v2 (bundled default — small and fast)',
    approximateDownloadMegabytes: 25,
    dimensions: 384,
    languageNote: 'English-centric',
  },
  {
    id: 'Xenova/bge-small-en-v1.5',
    label: 'BGE small en v1.5 (better recall, bigger download)',
    approximateDownloadMegabytes: 90,
    dimensions: 384,
    languageNote: 'English',
  },
];

export const BYOK_RAG_DEFAULT_EMBEDDER_ID = 'Xenova/all-MiniLM-L6-v2';

export const getByokRagEmbedderInfo = (id: string): ?ByokRagEmbedderInfo =>
  BYOK_RAG_EMBEDDERS.find(embedder => embedder.id === id) || null;

// --- The prebuilt index bundle (Phase 14.4, D14-3 / D14-7 (a)) --------------

/**
 * The envelope of a prebuilt RAG index bundle, exactly as
 * `scripts/byok-embedder/build-byok-rag-bundle.js` writes it: the app's own
 * serialized index plus embedder identity + a sha256 integrity hash. The
 * artifact lives on the fork's GitHub Releases; importing is opt-in only.
 */
export type ByokRagBundleManifest = {|
  bundle: 'byok-rag-bundle',
  formatVersion: number,
  created: string,
  embedder: {|
    id: string,
    dimensions: number,
    approximateDownloadMegabytes: number,
    dtype: string,
  |},
  integrity: {| indexSha256: string |},
  index: any, // ByokRagSerializedIndex — validated by deserializeByokRagIndex
|};

/** The bundle format this app understands (bump = incompatible). */
export const BYOK_RAG_BUNDLE_FORMAT_VERSION = 1;

/** The `bundle` discriminator of the envelope. */
export const BYOK_RAG_BUNDLE_KIND = 'byok-rag-bundle';

/** The fork repository hosting the bundle releases (owner Task 17.2). */
export const BYOK_RAG_BUNDLE_REPO = 'mrmflis-hub/GDevelop';

/** The release tag prefix of bundle generations (`byok-rag-bundle-v1`…). */
export const BYOK_RAG_BUNDLE_TAG_PREFIX = 'byok-rag-bundle-v';

/** The Qdrant collection snapshot asset name suffix of a release. */
export const BYOK_RAG_BUNDLE_SNAPSHOT_SUFFIX = '-qdrant-snapshot';

/** The RAG preferences blob (a top-level `byokRag` preferences key). */
export type ByokRagSettings = {|
  enabled: boolean,
  embedderId: string,
  backend: 'in-process' | 'qdrant',
  /** Opt-in extra corpus: a local documentation folder (desktop). */
  docsFolderPath: string,
  /** The Qdrant loopback origin when the backend is Qdrant. */
  qdrantBaseUrl: string,
|};

export const DEFAULT_BYOK_RAG_SETTINGS: ByokRagSettings = {
  enabled: false,
  embedderId: BYOK_RAG_DEFAULT_EMBEDDER_ID,
  backend: 'in-process',
  docsFolderPath: '',
  qdrantBaseUrl: 'http://127.0.0.1:6333',
};

/**
 * Read the RAG settings defensively (they come back from localStorage as
 * untrusted data): every field is merged over the defaults.
 */
export const getByokRagSettings = (values: {
  +byokRag?: ?ByokRagSettings,
  ...
}): ByokRagSettings => {
  const rag = values.byokRag;
  if (!rag || typeof rag !== 'object') {
    return { ...DEFAULT_BYOK_RAG_SETTINGS };
  }
  return {
    enabled: rag.enabled === true,
    embedderId:
      typeof rag.embedderId === 'string' && rag.embedderId
        ? rag.embedderId
        : DEFAULT_BYOK_RAG_SETTINGS.embedderId,
    backend: rag.backend === 'qdrant' ? 'qdrant' : 'in-process',
    docsFolderPath:
      typeof rag.docsFolderPath === 'string' ? rag.docsFolderPath : '',
    qdrantBaseUrl:
      typeof rag.qdrantBaseUrl === 'string' && rag.qdrantBaseUrl
        ? rag.qdrantBaseUrl
        : DEFAULT_BYOK_RAG_SETTINGS.qdrantBaseUrl,
  };
};
