// @flow
import {
  FORK_ASSET_ALIAS_DOC,
  resolveForkAssetReference,
  suggestForkAssetNames,
} from './ForkAssetAliasHelper';

const makeEntry = (
  name: string,
  kind: string = 'image',
  tags: Array<string> = []
) => ({ name, kind, file: name, tags });

const catalog = [
  makeEntry('hero.png'),
  makeEntry('hero-hurt.png'),
  makeEntry('player/jump', 'audio'),
  makeEntry('enemy.png', 'image', ['boss']),
];

describe('resolveForkAssetReference', () => {
  it('resolves an exact name, including a slash that IS the name', () => {
    const resolved = resolveForkAssetReference({
      catalog,
      writtenName: 'player/jump',
    });
    expect(resolved).toEqual({
      ok: true,
      name: 'player/jump',
      entry: makeEntry('player/jump', 'audio'),
    });
  });

  it('trims surrounding whitespace before matching', () => {
    const resolved = resolveForkAssetReference({
      catalog,
      writtenName: '  hero.png  ',
    });
    expect(resolved.ok).toBe(true);
  });

  it('refuses a non-existent name with a clear message and suggestions', () => {
    const refused = resolveForkAssetReference({
      catalog,
      writtenName: 'hero',
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toContain('No asset named "hero"');
      expect(refused.reason).toContain('RESOURCE NAME');
      expect(refused.suggestions).toEqual(['hero.png', 'hero-hurt.png']);
    }
  });

  it('refuses an unrelated name without inventing suggestions', () => {
    const refused = resolveForkAssetReference({
      catalog,
      writtenName: 'her.png',
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.suggestions).toEqual([]);
  });

  it('refuses a file path even when the file exists as a suffix of names', () => {
    const refused = resolveForkAssetReference({
      catalog,
      writtenName: 'art/player/jump.wav',
    });
    expect(refused.ok).toBe(false);
  });

  it('refuses empty or non-string input without suggestions', () => {
    expect(resolveForkAssetReference({ catalog, writtenName: '' }).ok).toBe(
      false
    );
    expect(resolveForkAssetReference({ catalog, writtenName: '   ' }).ok).toBe(
      false
    );
    expect(resolveForkAssetReference({ catalog, writtenName: 42 }).ok).toBe(
      false
    );
  });

  it('refuses everything against an empty catalog', () => {
    const refused = resolveForkAssetReference({
      catalog: [],
      writtenName: 'hero.png',
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.suggestions).toEqual([]);
  });
});

describe('suggestForkAssetNames', () => {
  it('caps the suggestions at 5, prefix matches first', () => {
    const many = ['hero', 'hero-1', 'hero-2', 'hero-3', 'hero-4', 'hero-5']
      .map(name => makeEntry(name))
      .concat([makeEntry('other')]);
    expect(suggestForkAssetNames(many, 'hero')).toEqual([
      'hero',
      'hero-1',
      'hero-2',
      'hero-3',
      'hero-4',
    ]);
  });

  it('falls back to substring matches when nothing starts with the input', () => {
    const many = [makeEntry('xhero'), makeEntry('the-hero'), makeEntry('zzz')];
    expect(suggestForkAssetNames(many, 'hero')).toEqual(['xhero', 'the-hero']);
  });

  it('is case-insensitive', () => {
    expect(suggestForkAssetNames([makeEntry('Hero.png')], 'hero')).toEqual([
      'Hero.png',
    ]);
  });
});

describe('FORK_ASSET_ALIAS_DOC', () => {
  it('documents the name-based convention and forbids imports', () => {
    expect(FORK_ASSET_ALIAS_DOC).toContain('RESOURCE NAME');
    expect(FORK_ASSET_ALIAS_DOC).toContain('import');
    expect(FORK_ASSET_ALIAS_DOC).toContain('@assets/');
    // The doc EXPLAINS the prohibition; it must not TEACH the syntax as a
    // working form (no code sample using it).
    expect(FORK_ASSET_ALIAS_DOC).not.toContain("import '");
  });
});
