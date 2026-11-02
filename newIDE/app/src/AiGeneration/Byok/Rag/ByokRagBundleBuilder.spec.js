/**
 * The prebuilt bundle builder self-check (Phase 14.4): the envelope must
 * pin the embedder identity + dtype, the integrity hash must survive the
 * exact JSON round-trip the importer will do (parse → re-stringify), the
 * file name must be versioned and sanitized, and the spot-check query
 * list must stay usable. The heavy build itself is a maintainer CLI run
 * (`scripts/byok-embedder/build-byok-rag-bundle.js`) — the spec only
 * covers the pure helpers, dev-only by the eval-harness rule (no shipped
 * module imports the script).
 */
const {
  BUNDLE_FORMAT_VERSION,
  BUNDLE_KIND,
  SPOT_CHECK_QUERIES,
  computeIndexSha256,
  buildBundleEnvelope,
  makeBundleFileName,
} = require('../../../../scripts/byok-embedder/build-byok-rag-bundle.js');

const makeSerializedIndex = () => ({
  manifest: {
    schemaVersion: 1,
    embedderId: 'Xenova/all-MiniLM-L6-v2',
    corpusHash: '1a2b3c4d',
    chunkCount: 2,
    backend: 'in-process',
    builtAt: '2026-09-27T00:00:00.000Z',
  },
  chunks: [
    {
      id: 'docs:0:0',
      source: 'docs',
      title: 'Events',
      tags: ['docs', 'events/index.md'],
      text: 'Events are the logic of a game.',
    },
    {
      id: 'engine-reference:0:0',
      source: 'engine-reference',
      title: 'Timer',
      tags: ['expression', 'Test'],
      text: 'expression Timer (Test)',
    },
  ],
  vectorsBase64: ['AAAAAAAAAAA=', 'AAAAAAAAAAE='],
});

describe('ByokRagBundleBuilder: pure helpers', () => {
  it('builds an envelope with the kind, version, embedder identity and pinned dtype', () => {
    const index = makeSerializedIndex();
    const bundle = buildBundleEnvelope({
      index,
      embedder: {
        id: 'Xenova/all-MiniLM-L6-v2',
        dimensions: 384,
        approximateDownloadMegabytes: 25,
      },
      createdIso: '2026-09-27T00:00:00.000Z',
    });
    expect(bundle.bundle).toBe(BUNDLE_KIND);
    expect(bundle.formatVersion).toBe(BUNDLE_FORMAT_VERSION);
    expect(bundle.created).toBe('2026-09-27T00:00:00.000Z');
    expect(bundle.embedder).toEqual({
      id: 'Xenova/all-MiniLM-L6-v2',
      dimensions: 384,
      approximateDownloadMegabytes: 25,
      dtype: 'q8',
    });
    expect(bundle.index).toBe(index);
    expect(bundle.integrity.indexSha256).toBeTruthy();
  });

  it('hashes the index payload so it survives the importer round-trip', () => {
    const index = makeSerializedIndex();
    const bundle = buildBundleEnvelope({
      index,
      embedder: {
        id: 'Xenova/all-MiniLM-L6-v2',
        dimensions: 384,
        approximateDownloadMegabytes: 25,
      },
      createdIso: '2026-09-27T00:00:00.000Z',
    });
    // The importer reads the downloaded file and recomputes the hash over
    // JSON.stringify(bundle.index) — the parse/re-stringify cycle must be
    // canonical (JSON.parse preserves key order).
    const roundTrip = JSON.parse(JSON.stringify(bundle));
    expect(roundTrip).toEqual(bundle);
    expect(computeIndexSha256(JSON.stringify(roundTrip.index))).toBe(
      bundle.integrity.indexSha256
    );
  });

  it('changes the hash when the index payload changes', () => {
    const index = makeSerializedIndex();
    const bundle = buildBundleEnvelope({
      index,
      embedder: {
        id: 'Xenova/all-MiniLM-L6-v2',
        dimensions: 384,
        approximateDownloadMegabytes: 25,
      },
      createdIso: '2026-09-27T00:00:00.000Z',
    });
    const tampered = JSON.parse(JSON.stringify(bundle));
    tampered.index.chunks[0].text = 'Tampered.';
    expect(computeIndexSha256(JSON.stringify(tampered.index))).not.toBe(
      bundle.integrity.indexSha256
    );
  });

  it('builds a versioned, sanitized file name', () => {
    expect(makeBundleFileName('1a2b3c4d', 'Xenova/all-MiniLM-L6-v2')).toBe(
      'byok-rag-bundle-f1-Xenova-all-MiniLM-L6-v2-1a2b3c4d.json'
    );
    expect(makeBundleFileName('deadbeef', 'weird/id with spaces')).toBe(
      'byok-rag-bundle-f1-weird-id-with-spaces-deadbeef.json'
    );
  });

  it('keeps the spot-check queries non-empty and unique', () => {
    expect(SPOT_CHECK_QUERIES.length).toBeGreaterThanOrEqual(5);
    expect(new Set(SPOT_CHECK_QUERIES).size).toBe(SPOT_CHECK_QUERIES.length);
    for (const query of SPOT_CHECK_QUERIES) {
      expect(query.trim()).toBe(query);
      expect(query.length).toBeGreaterThan(0);
    }
  });
});
