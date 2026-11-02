// @flow

/**
 * The Electron-main confinement of the game-code folder, spec'd from here
 * because that package has no test runner (the plain-CJS core pattern of
 * ByokAtomicWriteCore.js).
 *
 * This is the gate that matters for A15-3 in the process that actually
 * writes to disk: the renderer re-checks every path, but the IPC boundary
 * is exactly where a compromised or buggy renderer would try to widen it.
 */

// $FlowFixMe[cannot-resolve-module] - a Node builtin, used by this spec only.
const nodePath = require('path');

const {
  isPathInsideFolder,
  resolveGameCodeFolder,
  resolveGameCodeFile,
} = require('./ByokGameCodePathCore');

// Built from nodePath so the specs describe the same absolute paths the
// core produces on the machine that runs them (on Windows `/games` resolves
// against the current drive, so a hard-coded POSIX path would not compare).
const PROJECT_FOLDER = nodePath.resolve('/games');
const PROJECT_FILE = nodePath.join(PROJECT_FOLDER, 'MyGame.json');
const FOLDER = nodePath.join(PROJECT_FOLDER, 'MyGameCode');

describe('isPathInsideFolder', () => {
  it('accepts the folder itself and its descendants', () => {
    expect(isPathInsideFolder(PROJECT_FOLDER, PROJECT_FOLDER)).toBe(true);
    expect(
      isPathInsideFolder(
        PROJECT_FOLDER,
        nodePath.join(PROJECT_FOLDER, 'a', 'b.js')
      )
    ).toBe(true);
  });

  it('is segment-aware, so a longer sibling name is outside', () => {
    expect(
      isPathInsideFolder(
        nodePath.join(PROJECT_FOLDER, 'game'),
        nodePath.join(PROJECT_FOLDER, 'game2', 'x.js')
      )
    ).toBe(false);
    expect(
      isPathInsideFolder(
        PROJECT_FOLDER,
        nodePath.join(PROJECT_FOLDER, '..', 'secrets.js')
      )
    ).toBe(false);
  });
});

describe('resolveGameCodeFolder', () => {
  it('places the folder next to the project file', () => {
    const result = resolveGameCodeFolder(PROJECT_FILE, 'MyGameCode');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.folderPath).toBe(FOLDER);
  });

  it('refuses a folder NAME carrying a separator', () => {
    for (const name of [
      'Code/../../etc',
      '..\\..\\etc',
      'a/b',
      '/absolute',
      'C:/Windows',
    ]) {
      expect([name, resolveGameCodeFolder(PROJECT_FILE, name).ok]).toEqual([
        name,
        false,
      ]);
    }
  });

  it('refuses the dot segments and a NUL byte', () => {
    expect(resolveGameCodeFolder(PROJECT_FILE, '.').ok).toBe(false);
    expect(resolveGameCodeFolder(PROJECT_FILE, '..').ok).toBe(false);
    expect(
      resolveGameCodeFolder(PROJECT_FILE, 'Code' + String.fromCharCode(0)).ok
    ).toBe(false);
  });

  it('refuses a missing or non-string project file or folder', () => {
    expect(resolveGameCodeFolder('', 'Code').ok).toBe(false);
    expect(resolveGameCodeFolder(null, 'Code').ok).toBe(false);
    expect(resolveGameCodeFolder(PROJECT_FILE, '').ok).toBe(false);
    expect(resolveGameCodeFolder(PROJECT_FILE, null).ok).toBe(false);
    expect(resolveGameCodeFolder(PROJECT_FILE, 42).ok).toBe(false);
  });
});

describe('resolveGameCodeFile', () => {
  it('resolves a nested path inside the folder', () => {
    const result = resolveGameCodeFile(FOLDER, 'character/spawn.js');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.absolutePath).toContain('character');
      expect(result.absolutePath.endsWith('spawn.js')).toBe(true);
    }
  });

  it('refuses every traversal, in both separator spellings', () => {
    for (const candidate of [
      '../secrets.js',
      '../../secrets.js',
      'character/../../secrets.js',
      '..\\secrets.js',
      'character\\..\\..\\secrets.js',
    ]) {
      expect([candidate, resolveGameCodeFile(FOLDER, candidate).ok]).toEqual([
        candidate,
        false,
      ]);
    }
  });

  it('refuses an absolute path or a drive prefix', () => {
    expect(resolveGameCodeFile(FOLDER, '/etc/passwd.js').ok).toBe(false);
    expect(resolveGameCodeFile(FOLDER, 'C:/Windows/x.js').ok).toBe(false);
  });

  it('refuses a NUL byte', () => {
    expect(
      resolveGameCodeFile(FOLDER, 'spawn.js' + String.fromCharCode(0)).ok
    ).toBe(false);
  });

  it('refuses a reserved device name in any segment', () => {
    expect(resolveGameCodeFile(FOLDER, 'NUL.js').ok).toBe(false);
    expect(resolveGameCodeFile(FOLDER, 'character/CON.js').ok).toBe(false);
    expect(resolveGameCodeFile(FOLDER, 'lpt9.js').ok).toBe(false);
  });

  it('refuses names Windows cannot store', () => {
    expect(resolveGameCodeFile(FOLDER, 'trailing./spawn.js').ok).toBe(false);
    expect(resolveGameCodeFile(FOLDER, ' leading.js').ok).toBe(false);
    expect(resolveGameCodeFile(FOLDER, 'a|b.js').ok).toBe(false);
    expect(resolveGameCodeFile(FOLDER, 'a<b.js').ok).toBe(false);
  });

  it('refuses an empty path', () => {
    expect(resolveGameCodeFile(FOLDER, '').ok).toBe(false);
    expect(resolveGameCodeFile(FOLDER, '///').ok).toBe(false);
    expect(resolveGameCodeFile(FOLDER, null).ok).toBe(false);
  });

  it('answers with a reason, never throws', () => {
    const result = resolveGameCodeFile(FOLDER, '../x.js');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(typeof result.error).toBe('string');
  });
});
