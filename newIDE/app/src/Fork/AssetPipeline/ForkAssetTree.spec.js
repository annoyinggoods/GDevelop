// @flow
import {
  FORK_ASSET_UNTAGGED_BUCKET_NAME,
  buildForkAssetTree,
  type ForkAssetTreeEntry,
  type ForkAssetTreeTagItem,
} from './ForkAssetTree';

const makeEntry = (name: string, tags: Array<string>): ForkAssetTreeEntry => ({
  name,
  tags,
});

const tagNamesOf = (tree: Array<ForkAssetTreeTagItem>): Array<string> =>
  tree.map(item => (item.kind === 'tag' ? item.tagName : '?'));

const assetNamesUnder = (
  tree: Array<ForkAssetTreeTagItem>,
  tagName: string
): Array<string> | null => {
  const folder = tree.find(
    item => item.kind === 'tag' && item.tagName === tagName
  );
  if (!folder || folder.kind !== 'tag') return null;
  return folder.children.map(child => child.name);
};

describe('buildForkAssetTree', () => {
  it('groups assets under their tags, many-to-many', () => {
    const tree = buildForkAssetTree({
      resources: [
        makeEntry('hero.png', ['player', 'red']),
        makeEntry('enemy.png', ['enemy']),
      ],
    });

    expect(tagNamesOf(tree)).toEqual(['enemy', 'player', 'red']);
    expect(assetNamesUnder(tree, 'player')).toEqual(['hero.png']);
    expect(assetNamesUnder(tree, 'red')).toEqual(['hero.png']);
    expect(assetNamesUnder(tree, 'enemy')).toEqual(['enemy.png']);
  });

  it('puts an asset with two tags in BOTH branches', () => {
    const tree = buildForkAssetTree({
      resources: [makeEntry('hero.png', ['player', 'red'])],
    });
    expect(assetNamesUnder(tree, 'player')).toEqual(['hero.png']);
    expect(assetNamesUnder(tree, 'red')).toEqual(['hero.png']);
  });

  it('lands untagged assets in the Untagged bucket, kept last', () => {
    const tree = buildForkAssetTree({
      resources: [
        makeEntry('zeta.png', []),
        makeEntry('alpha.png', []),
        makeEntry('hero.png', ['player']),
      ],
    });

    const lastFolder = tree[tree.length - 1];
    expect(lastFolder.name).toBe(FORK_ASSET_UNTAGGED_BUCKET_NAME);
    expect(assetNamesUnder(tree, '')).toEqual(['alpha.png', 'zeta.png']);
    expect(tagNamesOf(tree)).toEqual(['player', '']);
  });

  it('sorts folders alphabetically and assets alphabetically within', () => {
    const tree = buildForkAssetTree({
      resources: [
        makeEntry('z.png', ['zed']),
        makeEntry('a.png', ['abc', 'zed']),
        makeEntry('m.png', ['mid']),
      ],
    });

    expect(tagNamesOf(tree)).toEqual(['abc', 'mid', 'zed']);
    expect(assetNamesUnder(tree, 'zed')).toEqual(['a.png', 'z.png']);
  });

  it('returns an empty tree for zero resources (no empty Untagged bucket)', () => {
    expect(buildForkAssetTree({ resources: [] })).toEqual([]);
  });

  it('skips a stored tag that fails normalization instead of crashing', () => {
    const tree = buildForkAssetTree({
      resources: [makeEntry('hero.png', ['ok', 'bad\u0002tag'])],
    });
    expect(tagNamesOf(tree)).toEqual(['ok']);
    expect(assetNamesUnder(tree, 'ok')).toEqual(['hero.png']);
  });

  it('keeps case-distinct resource names as distinct assets', () => {
    const tree = buildForkAssetTree({
      resources: [
        makeEntry('Hero.png', ['player']),
        makeEntry('hero.png', ['player']),
      ],
    });
    expect(assetNamesUnder(tree, 'player')).toEqual(['Hero.png', 'hero.png']);
  });

  it('supports the tagOf override and ignores duplicate input entries', () => {
    const tree = buildForkAssetTree({
      resources: [
        makeEntry('a.png', ['ignored']),
        makeEntry('a.png', ['other']),
      ],
      tagOf: entry => (entry.name === 'a.png' ? ['custom'] : entry.tags),
    });
    expect(tagNamesOf(tree)).toEqual(['custom']);
    expect(assetNamesUnder(tree, 'custom')).toEqual(['a.png']);
  });

  it('is pure: the input entries are never mutated', () => {
    const entry = makeEntry('hero.png', ['Player']);
    buildForkAssetTree({ resources: [entry] });
    expect(entry).toEqual({ name: 'hero.png', tags: ['Player'] });
  });
});
