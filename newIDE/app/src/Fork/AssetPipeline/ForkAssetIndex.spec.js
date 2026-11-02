// @flow
import {
  FORK_ASSET_INDEX_FILE_NAME,
  FORK_ASSET_INDEX_VERSION,
  findForkAssetIndexEntry,
  makeForkAssetIndex,
  mergeForkAssetIndexWithMetadata,
  parseForkAssetIndex,
  parseForkAssetIndexOrEmpty,
  removeForkAssetIndexEntry,
  serializeForkAssetIndex,
  upsertForkAssetIndexEntry,
  type ForkAssetIndex,
} from './ForkAssetIndex';

const makeEntry = (
  name: string,
  tags: Array<string>,
  kind: string = 'image',
  file: string = name
) => ({ name, kind, file, tags });

describe('the fork asset index entries', () => {
  it('upserts keyed by name, keeps the list name-sorted, removes and finds', () => {
    let index = makeForkAssetIndex();
    index = upsertForkAssetIndexEntry(index, makeEntry('z.png', ['zed']));
    index = upsertForkAssetIndexEntry(index, makeEntry('a.png', ['abc']));
    expect(index.entries.map(entry => entry.name)).toEqual(['a.png', 'z.png']);

    index = upsertForkAssetIndexEntry(index, makeEntry('a.png', ['updated']));
    expect(index.entries).toHaveLength(2);
    expect(findForkAssetIndexEntry(index, 'a.png')).toEqual(
      makeEntry('a.png', ['updated'])
    );
    expect(findForkAssetIndexEntry(index, 'nope.png')).toBeNull();

    index = removeForkAssetIndexEntry(index, 'a.png');
    expect(index.entries.map(entry => entry.name)).toEqual(['z.png']);
  });
});

describe('parseForkAssetIndex', () => {
  it('round-trips through serialize/parse', () => {
    const index = upsertForkAssetIndexEntry(
      makeForkAssetIndex(),
      makeEntry('hero.png', ['enemy', 'red'])
    );
    const parsed = parseForkAssetIndex(serializeForkAssetIndex(index));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.index).toEqual(index);
  });

  it('refuses corrupt JSON, wrong versions and bad shapes with an error', () => {
    expect(parseForkAssetIndex('{not json').ok).toBe(false);
    expect(parseForkAssetIndex('"a string"').ok).toBe(false);
    expect(parseForkAssetIndex('[]').ok).toBe(false);

    const futureVersion = JSON.stringify({ version: 999, entries: [] });
    const parsedFuture = parseForkAssetIndex(futureVersion);
    expect(parsedFuture.ok).toBe(false);
    if (!parsedFuture.ok) expect(parsedFuture.error).toContain('999');

    expect(
      parseForkAssetIndex(
        JSON.stringify({ version: FORK_ASSET_INDEX_VERSION, entries: 'no' })
      ).ok
    ).toBe(false);
    expect(
      parseForkAssetIndex(
        JSON.stringify({
          version: FORK_ASSET_INDEX_VERSION,
          entries: [{ kind: 'image' }],
        })
      ).ok
    ).toBe(false);
    expect(
      parseForkAssetIndex(
        JSON.stringify({
          version: FORK_ASSET_INDEX_VERSION,
          entries: [{ name: 'a.png', kind: 'image', file: 'a.png', tags: 3 }],
        })
      ).ok
    ).toBe(false);
  });

  it('degrades a corrupt or future index to a fresh empty index', () => {
    expect(parseForkAssetIndexOrEmpty('{not json')).toEqual(
      makeForkAssetIndex()
    );
    expect(parseForkAssetIndexOrEmpty('')).toEqual(makeForkAssetIndex());
    expect(parseForkAssetIndexOrEmpty(JSON.stringify({ version: 42 }))).toEqual(
      makeForkAssetIndex()
    );
  });

  it('keeps the LAST entry for a duplicated name', () => {
    const text = JSON.stringify({
      version: FORK_ASSET_INDEX_VERSION,
      entries: [makeEntry('a.png', ['first']), makeEntry('a.png', ['second'])],
    });
    const parsed = parseForkAssetIndex(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.index.entries).toEqual([makeEntry('a.png', ['second'])]);
    }
  });
});

describe('mergeForkAssetIndexWithMetadata', () => {
  it('lets METADATA win when the index is newer (claims tags metadata lacks)', () => {
    const index = upsertForkAssetIndexEntry(
      makeForkAssetIndex(),
      makeEntry('hero.png', ['ghost-tag'])
    );
    const merged = mergeForkAssetIndexWithMetadata(index, [
      { name: 'hero.png', kind: 'image', file: 'hero.png', tags: [] },
    ]);
    expect(merged.entries).toEqual([
      { name: 'hero.png', kind: 'image', file: 'hero.png', tags: [] },
    ]);
  });

  it('lets METADATA win when metadata is newer (index is stale)', () => {
    const index = upsertForkAssetIndexEntry(
      makeForkAssetIndex(),
      makeEntry('hero.png', ['old'])
    );
    const merged = mergeForkAssetIndexWithMetadata(index, [
      { name: 'hero.png', kind: 'image', file: 'hero.png', tags: ['new'] },
    ]);
    expect(findForkAssetIndexEntry(merged, 'hero.png')).toEqual(
      makeEntry('hero.png', ['new'])
    );
  });

  it('drops entries for resources that no longer exist', () => {
    const index: ForkAssetIndex = [
      makeEntry('a.png', ['x']),
      makeEntry('gone.png', ['x']),
    ].reduce(
      (current, entry) => upsertForkAssetIndexEntry(current, entry),
      makeForkAssetIndex()
    );
    const merged = mergeForkAssetIndexWithMetadata(index, [
      { name: 'a.png', kind: 'image', file: 'a.png', tags: ['x'] },
    ]);
    expect(merged.entries.map(entry => entry.name)).toEqual(['a.png']);
  });

  it('never consults the index: identical snapshots merge identically whatever the index holds', () => {
    const snapshots = [
      { name: 'a.png', kind: 'image', file: 'a.png', tags: ['x'] },
    ];
    const fromEmpty = mergeForkAssetIndexWithMetadata(
      makeForkAssetIndex(),
      snapshots
    );
    const fromFull = mergeForkAssetIndexWithMetadata(
      upsertForkAssetIndexEntry(
        makeForkAssetIndex(),
        makeEntry('a.png', ['whatever'], 'audio', 'other-file')
      ),
      snapshots
    );
    expect(fromFull).toEqual(fromEmpty);
  });
});

describe('the index sidecar contract', () => {
  it('uses the documented version and file name', () => {
    expect(FORK_ASSET_INDEX_VERSION).toBe(1);
    expect(FORK_ASSET_INDEX_FILE_NAME).toBe('assets-index.json');
  });
});
