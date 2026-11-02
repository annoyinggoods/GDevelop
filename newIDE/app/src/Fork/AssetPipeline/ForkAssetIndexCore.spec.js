// @flow
import optionalRequire from '../../Utils/OptionalRequire';

const path = (optionalRequire('path'): any);

const {
  FORK_ASSET_INDEX_FILE_NAME,
  isPathInsideFolder,
  resolveForkAssetIndexPath,
} = require('./ForkAssetIndexCore');

const PROJECT_FILE = path.resolve('/projects/game/game.json');

describe('resolveForkAssetIndexPath', () => {
  it('resolves to the fixed file name inside the project folder', () => {
    const resolved = resolveForkAssetIndexPath(PROJECT_FILE);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.indexPath).toBe(
        path.join(path.dirname(PROJECT_FILE), FORK_ASSET_INDEX_FILE_NAME)
      );
    }
  });

  it('refuses missing, relative, NUL-carrying inputs', () => {
    expect(resolveForkAssetIndexPath('').ok).toBe(false);
    expect(resolveForkAssetIndexPath(undefined).ok).toBe(false);
    expect(resolveForkAssetIndexPath('relative/game.json').ok).toBe(false);
    expect(
      resolveForkAssetIndexPath('C:/x/game.json' + String.fromCharCode(0)).ok
    ).toBe(false);
  });

  it('mirrors the renderer file name constant', () => {
    expect(FORK_ASSET_INDEX_FILE_NAME).toBe('assets-index.json');
  });
});

describe('isPathInsideFolder', () => {
  it('is segment-aware, like the game-code core it mirrors', () => {
    expect(isPathInsideFolder('/projects/game', '/projects/game')).toBe(true);
    expect(
      isPathInsideFolder('/projects/game', '/projects/game/assets-index.json')
    ).toBe(true);
    expect(isPathInsideFolder('/projects/game', '/projects/game2/x')).toBe(
      false
    );
    expect(isPathInsideFolder('/projects/game', '/projects/other')).toBe(false);
  });
});
