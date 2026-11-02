// @flow
import {
  FORK_ASSET_MAX_TAG_LENGTH,
  FORK_ASSET_TAGS_METADATA_KEY,
  collectForkAssetTagVocabulary,
  normalizeForkAssetTag,
  parseForkAssetTags,
  serializeForkAssetTags,
} from './ForkAssetTags';

const makeMetadata = (tags: Array<string>, otherKeys?: Object = {}) =>
  JSON.stringify({ ...otherKeys, [FORK_ASSET_TAGS_METADATA_KEY]: tags });

describe('normalizeForkAssetTag', () => {
  it('lowercases and trims a valid tag', () => {
    expect(normalizeForkAssetTag('  Enemy  ')).toEqual({
      ok: true,
      tag: 'enemy',
    });
  });

  it('refuses an empty or whitespace-only tag with a reason', () => {
    expect(normalizeForkAssetTag('')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeForkAssetTag('   ')).toEqual({
      ok: false,
      reason: 'empty',
    });
  });

  it('refuses a control-character tag with a reason', () => {
    expect(normalizeForkAssetTag('bad\u0007tag')).toEqual({
      ok: false,
      reason: 'control-characters',
    });
    expect(normalizeForkAssetTag('bad\u007ftag')).toEqual({
      ok: false,
      reason: 'control-characters',
    });
  });

  it('refuses path separators and overlong tags', () => {
    expect(normalizeForkAssetTag('art/enemy')).toEqual({
      ok: false,
      reason: 'path-separator',
    });
    expect(normalizeForkAssetTag('art\\enemy')).toEqual({
      ok: false,
      reason: 'path-separator',
    });
    expect(
      normalizeForkAssetTag('a'.repeat(FORK_ASSET_MAX_TAG_LENGTH + 1))
    ).toEqual({ ok: false, reason: 'too-long' });
  });

  it('refuses a non-string with a reason', () => {
    expect(normalizeForkAssetTag(42)).toEqual({
      ok: false,
      reason: 'not-a-string',
    });
  });
});

describe('parseForkAssetTags', () => {
  it('reads the tags inside the metadata JSON', () => {
    expect(parseForkAssetTags(makeMetadata(['enemy', 'red']))).toEqual([
      'enemy',
      'red',
    ]);
  });

  it('returns no tags for empty, non-JSON or non-object metadata', () => {
    expect(parseForkAssetTags('')).toEqual([]);
    expect(parseForkAssetTags('not json at all')).toEqual([]);
    expect(parseForkAssetTags('"just a string"')).toEqual([]);
  });

  it('returns no tags when the tags key is not an array', () => {
    expect(parseForkAssetTags(JSON.stringify({ tags: 'enemy' }))).toEqual([]);
    expect(parseForkAssetTags(JSON.stringify({ tags: null }))).toEqual([]);
  });

  it('normalizes stored tags and skips invalid ones instead of crashing', () => {
    expect(
      parseForkAssetTags(makeMetadata(['  Enemy ', 'bad\u0001tag', 'enemy']))
    ).toEqual(['enemy']);
  });
});

describe('serializeForkAssetTags', () => {
  it('round-trips tags without disturbing the other metadata keys', () => {
    const metadata = JSON.stringify({
      localFilePath: 'C:/somewhere/hero.png',
      extension: 'png',
      resourceCustomProperties: { smooth: true },
    });
    const written = serializeForkAssetTags(metadata, ['enemy', 'red']);

    expect(JSON.parse(written)).toEqual({
      localFilePath: 'C:/somewhere/hero.png',
      extension: 'png',
      resourceCustomProperties: { smooth: true },
      tags: ['enemy', 'red'],
    });
    expect(parseForkAssetTags(written)).toEqual(['enemy', 'red']);
  });

  it('overwrites the previous tags on a second write, still preserving the rest', () => {
    const first = serializeForkAssetTags(
      makeMetadata(['old'], { localFilePath: 'x.png' }),
      ['new']
    );
    const second = serializeForkAssetTags(first, []);
    expect(JSON.parse(second).localFilePath).toBe('x.png');
    expect(parseForkAssetTags(second)).toEqual([]);
  });

  it('round-trips non-JSON metadata untouched on a no-op write', () => {
    expect(serializeForkAssetTags('not json at all', [])).toBe(
      'not json at all'
    );
  });

  it('replaces non-JSON metadata with fresh JSON when tags are written', () => {
    const written = serializeForkAssetTags('not json at all', ['enemy']);
    expect(JSON.parse(written)).toEqual({ tags: ['enemy'] });
  });
});

describe('collectForkAssetTagVocabulary', () => {
  it('collects the sorted set of canonical tags across entries', () => {
    expect(
      collectForkAssetTagVocabulary([
        { tags: ['red', 'enemy'] },
        { tags: ['Enemy', 'boss'] },
        { tags: [] },
      ])
    ).toEqual(['boss', 'enemy', 'red']);
  });

  it('is empty for no entries or invalid tags only', () => {
    expect(collectForkAssetTagVocabulary([])).toEqual([]);
    expect(collectForkAssetTagVocabulary([{ tags: ['\u0000'] }])).toEqual([]);
  });
});
