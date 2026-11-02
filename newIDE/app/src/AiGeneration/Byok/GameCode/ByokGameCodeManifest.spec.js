// @flow

/**
 * The Phase 15.1 manifest. It is a CACHE, never an authority, so these
 * specs are mostly about proving that a broken one degrades instead of
 * throwing — and that the content hash is the same one the hot reload
 * compares, which is the invariant that makes a "changed" file detectable.
 */

import {
  BYOK_GAME_CODE_MANIFEST_VERSION,
  findByokGameCodeManifestEntry,
  getByokGameCodeContentHash,
  getByokGameCodeManifestOrder,
  makeByokGameCodeManifest,
  parseByokGameCodeManifest,
  parseByokGameCodeManifestOrEmpty,
  removeByokGameCodeManifestEntry,
  serializeByokGameCodeManifest,
  upsertByokGameCodeManifestEntry,
} from './ByokGameCodeManifest';

const makeEntry = (relativePath: string, overrides?: Object = {}): Object => ({
  relativePath,
  resourceName: 'MyGameCode/' + relativePath,
  sizeBytes: 10,
  contentHash: 12345,
  exportedScriptName: relativePath.split('/').pop(),
  ...overrides,
});

describe('getByokGameCodeContentHash', () => {
  it('is deterministic and content-sensitive', () => {
    expect(getByokGameCodeContentHash('abc')).toBe(
      getByokGameCodeContentHash('abc')
    );
    expect(getByokGameCodeContentHash('abc')).not.toBe(
      getByokGameCodeContentHash('abd')
    );
  });

  it('distinguishes an empty file from a one-byte one', () => {
    expect(getByokGameCodeContentHash('')).not.toBe(
      getByokGameCodeContentHash(' ')
    );
  });

  it('is the same 32-bit hash the hot reload uses (xxhash, seed 0xabcd)', () => {
    // EventsFunctionsExtensionsProvider.js hashes include files the same
    // way; if these ever diverge, a "changed" file would stop reloading.
    const xxhashjs = require('xxhashjs');
    expect(getByokGameCodeContentHash('GameCode.a = 1;')).toBe(
      xxhashjs.h32('GameCode.a = 1;', 0xabcd).toNumber()
    );
  });
});

describe('upsertByokGameCodeManifestEntry', () => {
  it('keeps the entries in D15-3a load order', () => {
    let manifest = makeByokGameCodeManifest({ folderName: 'MyGameCode' });
    manifest = upsertByokGameCodeManifestEntry(
      manifest,
      makeEntry('enemy/spawn.js')
    );
    manifest = upsertByokGameCodeManifestEntry(manifest, makeEntry('main.js'));
    manifest = upsertByokGameCodeManifestEntry(
      manifest,
      makeEntry('core/boot.js')
    );
    expect(getByokGameCodeManifestOrder(manifest)).toEqual([
      'core/boot.js',
      'main.js',
      'enemy/spawn.js',
    ]);
  });

  it('replaces an entry in place instead of duplicating it', () => {
    let manifest = makeByokGameCodeManifest();
    manifest = upsertByokGameCodeManifestEntry(manifest, makeEntry('main.js'));
    manifest = upsertByokGameCodeManifestEntry(
      manifest,
      makeEntry('main.js', { contentHash: 999 })
    );
    expect(manifest.entries).toHaveLength(1);
    expect(findByokGameCodeManifestEntry(manifest, 'main.js')).toMatchObject({
      contentHash: 999,
    });
  });

  it('does not mutate the manifest it is given', () => {
    const manifest = makeByokGameCodeManifest();
    const entriesBefore = manifest.entries;
    upsertByokGameCodeManifestEntry(manifest, makeEntry('main.js'));
    expect(manifest.entries).toBe(entriesBefore);
    expect(manifest.entries).toHaveLength(0);
  });

  it('removes an entry without touching the others', () => {
    let manifest = makeByokGameCodeManifest();
    manifest = upsertByokGameCodeManifestEntry(manifest, makeEntry('main.js'));
    manifest = upsertByokGameCodeManifestEntry(
      manifest,
      makeEntry('enemy/spawn.js')
    );
    manifest = removeByokGameCodeManifestEntry(manifest, 'main.js');
    expect(manifest.entries).toHaveLength(1);
    expect(findByokGameCodeManifestEntry(manifest, 'main.js')).toBe(null);
    expect(findByokGameCodeManifestEntry(manifest, 'enemy/spawn.js')).not.toBe(
      null
    );
  });

  it('removing an absent entry changes nothing', () => {
    const manifest = makeByokGameCodeManifest();
    expect(removeByokGameCodeManifestEntry(manifest, 'ghost.js')).toEqual(
      manifest
    );
  });
});

describe('serialization round trip', () => {
  it('preserves every field', () => {
    const manifest = upsertByokGameCodeManifestEntry(
      makeByokGameCodeManifest({ folderName: 'MyGameCode' }),
      makeEntry('character/hero.js', { exportedScriptName: 'hero.js' })
    );
    const parsed = parseByokGameCodeManifest(
      serializeByokGameCodeManifest(manifest)
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.manifest).toEqual(manifest);
  });

  it('is stable: re-serializing a parsed manifest changes nothing', () => {
    const manifest = upsertByokGameCodeManifestEntry(
      makeByokGameCodeManifest({ folderName: 'MyGameCode' }),
      makeEntry('main.js')
    );
    const text = serializeByokGameCodeManifest(manifest);
    const parsed = parseByokGameCodeManifest(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(serializeByokGameCodeManifest(parsed.manifest)).toBe(text);
    }
  });

  it('preserves an unknown exported script name as null', () => {
    const manifest = upsertByokGameCodeManifestEntry(
      makeByokGameCodeManifest(),
      makeEntry('spawn.js', { exportedScriptName: null })
    );
    const parsed = parseByokGameCodeManifest(
      serializeByokGameCodeManifest(manifest)
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const entry = findByokGameCodeManifestEntry(parsed.manifest, 'spawn.js');
      expect(entry ? entry.exportedScriptName : undefined).toBe(null);
    }
  });
});

describe('parseByokGameCodeManifest is defensive', () => {
  it('rejects invalid JSON with a readable reason', () => {
    const parsed = parseByokGameCodeManifest('{ not json');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/not valid JSON/);
  });

  it('rejects a non-object', () => {
    expect(parseByokGameCodeManifest('42').ok).toBe(false);
    expect(parseByokGameCodeManifest('null').ok).toBe(false);
    expect(parseByokGameCodeManifest('').ok).toBe(false);
  });

  it('rejects another version rather than misreading it', () => {
    const parsed = parseByokGameCodeManifest(
      JSON.stringify({ version: 99, entries: [] })
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/version 99/);
  });

  it('names a missing version instead of saying "undefined"', () => {
    const parsed = parseByokGameCodeManifest(JSON.stringify({ entries: [] }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/version none/);
  });

  it('rejects a manifest with no entries list', () => {
    const parsed = parseByokGameCodeManifest(
      JSON.stringify({ version: BYOK_GAME_CODE_MANIFEST_VERSION })
    );
    expect(parsed.ok).toBe(false);
  });

  it('rejects a malformed entry instead of importing it', () => {
    const parsed = parseByokGameCodeManifest(
      JSON.stringify({
        version: BYOK_GAME_CODE_MANIFEST_VERSION,
        entries: [{ sizeBytes: 1 }],
      })
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/no relative path/);
  });

  it('rejects a non-object entry', () => {
    const parsed = parseByokGameCodeManifest(
      JSON.stringify({
        version: BYOK_GAME_CODE_MANIFEST_VERSION,
        entries: ['main.js'],
      })
    );
    expect(parsed.ok).toBe(false);
  });

  it('fills in defaults for the optional fields of a hand-edited entry', () => {
    const parsed = parseByokGameCodeManifest(
      JSON.stringify({
        version: BYOK_GAME_CODE_MANIFEST_VERSION,
        entries: [{ relativePath: 'main.js' }],
      })
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.manifest.entries[0]).toEqual({
        relativePath: 'main.js',
        resourceName: '',
        sizeBytes: 0,
        contentHash: 0,
        exportedScriptName: null,
      });
    }
  });
});

describe('parseByokGameCodeManifestOrEmpty', () => {
  it('degrades a broken manifest to a fresh one instead of throwing', () => {
    // The read path must keep working: the next write rebuilds the file.
    const manifest = parseByokGameCodeManifestOrEmpty('{ broken', 'MyGameCode');
    expect(manifest.entries).toEqual([]);
    expect(manifest.folderName).toBe('MyGameCode');
    expect(manifest.version).toBe(BYOK_GAME_CODE_MANIFEST_VERSION);
  });

  it('degrades an empty string too', () => {
    expect(parseByokGameCodeManifestOrEmpty('', 'X').entries).toEqual([]);
  });

  it('returns the parsed manifest when it is valid', () => {
    const manifest = upsertByokGameCodeManifestEntry(
      makeByokGameCodeManifest({ folderName: 'MyGameCode' }),
      makeEntry('main.js')
    );
    expect(
      parseByokGameCodeManifestOrEmpty(
        serializeByokGameCodeManifest(manifest),
        'ignored'
      )
    ).toEqual(manifest);
  });
});

describe('findByokGameCodeManifestEntry', () => {
  it('answers null for a path it does not know', () => {
    expect(
      findByokGameCodeManifestEntry(makeByokGameCodeManifest(), 'ghost.js')
    ).toBe(null);
  });
});
