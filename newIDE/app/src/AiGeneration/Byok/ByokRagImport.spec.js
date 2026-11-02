// @flow
/**
 * The prebuilt-index import service (Phase 14.4, D14-3): a verified bundle
 * lands in the store and the live runtime; every mismatch (embedder,
 * corpus) refuses with the rebuild offer; an embedder-load failure degrades
 * honestly (lexical) instead of failing the import.
 */
import { importPrebuiltByokRagIndex } from './Rag/ByokRagBuildService';
import { getByokRagSearchDeps, setByokRagRuntime } from './Rag/ByokRagSearch';
import { DEFAULT_BYOK_RAG_SETTINGS } from './Rag/ByokRagTypes';

jest.mock('./Rag/ByokRagEmbedder', () => ({
  loadByokRagEmbedder: jest.fn(),
}));

jest.mock('./Rag/ByokRagFileBackends', () => ({
  createByokRagFilesBackendForPlatform: jest.fn(),
}));

const embedderModule: any = require('./Rag/ByokRagEmbedder');
const backendsModule: any = require('./Rag/ByokRagFileBackends');

const makeTestVectorBase64 = (): string => {
  const bytes = new Uint8Array(new Float32Array(384).buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index++) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
};

const makeMemoryBackend = () => {
  const files: Map<string, string> = new Map();
  return {
    files,
    writeFile: async (fileName: string, content: string) => {
      files.set(fileName, content);
    },
    readFile: async (fileName: string) => files.get(fileName) || null,
    deleteFile: async (fileName: string) => {
      files.delete(fileName);
    },
  };
};

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

describe('importPrebuiltByokRagIndex', () => {
  beforeEach(() => {
    setByokRagRuntime(null);
    backendsModule.createByokRagFilesBackendForPlatform.mockImplementation(() =>
      makeMemoryBackend()
    );
    embedderModule.loadByokRagEmbedder.mockImplementation(async () => ({
      ok: true,
      embedder: { id: 'Xenova/all-MiniLM-L6-v2', embed: async () => [] },
    }));
  });

  afterEach(() => {
    setByokRagRuntime(null);
  });

  it('imports a compatible bundle: store + live runtime + embedder', async () => {
    const outcome = await importPrebuiltByokRagIndex({
      settings: { ...DEFAULT_BYOK_RAG_SETTINGS },
      rawBundle: makeBundleFixture(),
      corpusHash: '1a2b3c4d',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('refused');
    expect(outcome.chunkCount).toBe(1);
    expect(outcome.embedderReady).toBe(true);
    // The live runtime carries the imported index and the embedder.
    const deps = getByokRagSearchDeps();
    expect(deps.index && deps.index.chunks).toHaveLength(1);
    expect(deps.embedder).not.toBe(null);
  });

  it('still imports (lexical-honest) when the embedder model fails to load', async () => {
    embedderModule.loadByokRagEmbedder.mockImplementation(async () => ({
      ok: false,
      error: 'download blocked',
    }));
    const outcome = await importPrebuiltByokRagIndex({
      settings: { ...DEFAULT_BYOK_RAG_SETTINGS },
      rawBundle: makeBundleFixture(),
      corpusHash: '1a2b3c4d',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('refused');
    expect(outcome.embedderReady).toBe(false);
    expect(getByokRagSearchDeps().embedder).toBe(null);
  });

  it('refuses a stale corpus with the rebuild offer and installs nothing', async () => {
    const backend = makeMemoryBackend();
    backendsModule.createByokRagFilesBackendForPlatform.mockImplementation(
      () => backend
    );
    const outcome = await importPrebuiltByokRagIndex({
      settings: { ...DEFAULT_BYOK_RAG_SETTINGS },
      rawBundle: makeBundleFixture(),
      corpusHash: 'fadedfade',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('imported');
    expect(outcome.error).toContain('rebuild the index locally');
    expect(backend.files.size).toBe(0);
    expect(getByokRagSearchDeps().index).toBe(null);
  });

  it('refuses a bundle of a different embedder than the picker selection', async () => {
    const outcome = await importPrebuiltByokRagIndex({
      settings: {
        ...DEFAULT_BYOK_RAG_SETTINGS,
        embedderId: 'Xenova/bge-small-en-v1.5',
      },
      rawBundle: makeBundleFixture(),
      corpusHash: '1a2b3c4d',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('imported');
    expect(outcome.error).toContain('switch the embedder');
  });
});
