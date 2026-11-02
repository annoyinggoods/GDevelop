// @flow
import {
  validateByokRagBundleEnvelope,
  checkByokRagBundleCompatibility,
  parseByokRagBundleReleaseInfo,
  makeByokRagBundleReleasesApiUrl,
} from './ByokRagBundle';
import { BYOK_RAG_BUNDLE_REPO } from './ByokRagTypes';

/**
 * The prebuilt-bundle validation (Phase 14.4, D14-3): every mismatch
 * dimension refuses the import — wrong kind, wrong format version, unknown
 * embedder, dimension disagreement, missing integrity hash, missing index,
 * a different chosen embedder, and a stale corpus — and the release
 * distiller picks the right assets off the GitHub API shape.
 */

const makeVectorBase64 = (): string => {
  const vector = new Float32Array(384);
  vector[0] = 1;
  const bytes = new Uint8Array(vector.buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index++) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
};

const makeBundleFixture = (overrides?: {|
  embedderId?: string,
  dimensions?: number,
  corpusHash?: string,
|}) => ({
  bundle: 'byok-rag-bundle',
  formatVersion: 1,
  created: '2026-09-27T00:00:00.000Z',
  embedder: {
    id:
      overrides && overrides.embedderId
        ? overrides.embedderId
        : 'Xenova/all-MiniLM-L6-v2',
    dimensions: overrides && overrides.dimensions ? overrides.dimensions : 384,
    approximateDownloadMegabytes: 25,
    dtype: 'q8',
  },
  index: {
    manifest: {
      schemaVersion: 1,
      embedderId:
        overrides && overrides.embedderId
          ? overrides.embedderId
          : 'Xenova/all-MiniLM-L6-v2',
      corpusHash:
        overrides && overrides.corpusHash ? overrides.corpusHash : '1a2b3c4d',
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
    vectorsBase64: [makeVectorBase64()],
  },
  integrity: {
    indexSha256: 'a'.repeat(64),
  },
});

describe('validateByokRagBundleEnvelope', () => {
  it('accepts a well-formed bundle of a catalog embedder', () => {
    const outcome = validateByokRagBundleEnvelope(makeBundleFixture());
    expect(outcome.ok).toBe(true);
  });

  it('refuses non-bundles and future format versions', () => {
    const notABundle = validateByokRagBundleEnvelope({ bundle: 'other' });
    expect(notABundle.ok).toBe(false);

    const future = makeBundleFixture();
    future.formatVersion = 99;
    const futureOutcome = validateByokRagBundleEnvelope(future);
    expect(futureOutcome.ok).toBe(false);
    if (!futureOutcome.ok) {
      expect(futureOutcome.error).toContain('format version');
    }
  });

  it('refuses unknown embedders and dimension disagreements', () => {
    const unknownEmbedder = validateByokRagBundleEnvelope(
      makeBundleFixture({ embedderId: 'someone/unknown-model' })
    );
    expect(unknownEmbedder.ok).toBe(false);
    if (!unknownEmbedder.ok) {
      expect(unknownEmbedder.error).toContain('unknown embedder');
    }

    const wrongDimensions = validateByokRagBundleEnvelope(
      makeBundleFixture({ dimensions: 999 })
    );
    expect(wrongDimensions.ok).toBe(false);
    if (!wrongDimensions.ok) {
      expect(wrongDimensions.error).toContain('dimensions');
    }
  });

  it('refuses missing integrity hashes and missing index payloads', () => {
    const noHash: any = makeBundleFixture();
    delete noHash.integrity;
    expect(validateByokRagBundleEnvelope(noHash).ok).toBe(false);

    const shortHash = makeBundleFixture();
    shortHash.integrity = { indexSha256: 'abc' };
    expect(validateByokRagBundleEnvelope(shortHash).ok).toBe(false);

    const noIndex: any = makeBundleFixture();
    delete noIndex.index;
    expect(validateByokRagBundleEnvelope(noIndex).ok).toBe(false);
  });
});

describe('checkByokRagBundleCompatibility', () => {
  it('accepts the matching embedder and corpus', () => {
    const validation = validateByokRagBundleEnvelope(makeBundleFixture());
    if (!validation.ok) throw new Error('fixture invalid');
    const outcome = checkByokRagBundleCompatibility(validation.bundle, {
      embedderId: 'Xenova/all-MiniLM-L6-v2',
      corpusHash: '1a2b3c4d',
    });
    expect(outcome.ok).toBe(true);
  });

  it('refuses a bundle built with a different embedder than the picker', () => {
    const validation = validateByokRagBundleEnvelope(makeBundleFixture());
    if (!validation.ok) throw new Error('fixture invalid');
    const outcome = checkByokRagBundleCompatibility(validation.bundle, {
      embedderId: 'Xenova/bge-small-en-v1.5',
      corpusHash: '1a2b3c4d',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('switch the embedder');
  });

  it('refuses a stale corpus (older than this app) — never silent', () => {
    const validation = validateByokRagBundleEnvelope(makeBundleFixture());
    if (!validation.ok) throw new Error('fixture invalid');
    const outcome = checkByokRagBundleCompatibility(validation.bundle, {
      embedderId: 'Xenova/all-MiniLM-L6-v2',
      corpusHash: '99999999',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok)
      expect(outcome.error).toContain('rebuild the index locally');
  });
});

describe('parseByokRagBundleReleaseInfo', () => {
  const makeRelease = (tag: string, assets: Array<string>) => ({
    tag_name: tag,
    draft: false,
    assets: assets.map(name => ({
      name,
      size: 5 * 1024 * 1024,
      browser_download_url: `https://example.com/${name}`,
    })),
  });

  it('picks the newest bundle release with its index and snapshot assets', () => {
    const info = parseByokRagBundleReleaseInfo([
      makeRelease('some-other-release', ['asset.zip']),
      makeRelease('byok-rag-bundle-v1', [
        'byok-rag-bundle-f1-Xenova-all-MiniLM-L6-v2-1a2b3c4d.json',
        'byok-rag-bundle-f1-Xenova-all-MiniLM-L6-v2-1a2b3c4d-qdrant-snapshot',
      ]),
      makeRelease('byok-rag-bundle-v2', [
        'byok-rag-bundle-f1-Xenova-all-MiniLM-L6-v2-99999999.json',
      ]),
    ]);
    if (!info) throw new Error('no release parsed');
    expect(info.tag).toBe('byok-rag-bundle-v2');
    expect(info.indexAsset && info.indexAsset.name).toContain('99999999.json');
    expect(info.snapshotAsset).toBe(null);
  });

  it('keeps the snapshot asset apart from the index asset', () => {
    const info = parseByokRagBundleReleaseInfo([
      makeRelease('byok-rag-bundle-v1', [
        'byok-rag-bundle-f1-Xenova-all-MiniLM-L6-v2-1a2b3c4d.json',
        'byok-rag-bundle-f1-Xenova-all-MiniLM-L6-v2-1a2b3c4d-qdrant-snapshot',
      ]),
    ]);
    if (!info || !info.indexAsset || !info.snapshotAsset) {
      throw new Error('assets not parsed');
    }
    const snapshot = info.snapshotAsset;
    const index = info.indexAsset;
    if (!snapshot || !index) throw new Error('assets not parsed');
    expect(snapshot.name).toContain('-qdrant-snapshot');
    expect(index.name.endsWith('.json')).toBe(true);
  });

  it('returns null without bundle releases and ignores drafts', () => {
    expect(parseByokRagBundleReleaseInfo(([]: any))).toBe(null);
    expect(parseByokRagBundleReleaseInfo(('junk': any))).toBe(null);
    const drafts = parseByokRagBundleReleaseInfo([
      { tag_name: 'byok-rag-bundle-v9', draft: true, assets: [] },
    ]);
    expect(drafts).toBe(null);
  });

  it('exposes the releases API URL of the fork', () => {
    expect(makeByokRagBundleReleasesApiUrl()).toContain(
      `repos/${BYOK_RAG_BUNDLE_REPO}/releases`
    );
  });
});

describe('parseByokRagBundleReleaseInfo: numeric tag ordering (audit011026 B-RAG-8)', () => {
  const makeReleaseWithIndexAsset = (tag: string) => ({
    tag_name: tag,
    draft: false,
    assets: [
      {
        name: `byok-rag-bundle-f1-x-${tag}.json`,
        browser_download_url: `https://example.com/${tag}.json`,
        size: 1000,
      },
    ],
  });

  it('picks v10 over v9 (lexicographic order would not)', () => {
    const info = parseByokRagBundleReleaseInfo([
      makeReleaseWithIndexAsset('byok-rag-bundle-v9'),
      makeReleaseWithIndexAsset('byok-rag-bundle-v10'),
    ]);
    expect(info && info.indexAsset && info.indexAsset.name).toContain('-v10');
  });
});
