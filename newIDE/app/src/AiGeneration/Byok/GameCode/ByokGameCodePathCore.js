/* eslint-disable no-undef */

/**
 * The game-code path confinement of the ELECTRON MAIN process
 * (Phase 15.1).
 *
 * Plain CJS on purpose, for the reason ByokAtomicWriteCore.js and
 * ByokMcpStdioAdapterCore.js are plain CJS: the Electron main process
 * requires it directly (that package has no test runner) and the Jest suite
 * specs it from the renderer. The renderer has its own tested gate
 * (`resolveByokGameCodeAbsolutePath` in ByokGameCodeStore.js, built on
 * ByokGameCodeCore.js) — the rule is deliberately applied TWICE, in the
 * process that decides and in the process that writes to disk, because the
 * untrusted input crosses the IPC boundary in between.
 *
 * The rule: this process never trusts a folder path. It derives the project
 * folder from the project file, treats the game-code folder NAME as one
 * untrusted segment, and refuses any relative path that does not stay
 * inside.
 */

const path = require('path');

/** Mirrors BYOK_GAME_CODE_RESERVED_DEVICE_NAMES in ByokGameCodeCore.js. */
const RESERVED_DEVICE_NAMES = [
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
];

const NUL = String.fromCharCode(0);

/** Segment-aware containment: "/games/game2" is NOT inside "/games/game". */
const isPathInsideFolder = (folder, candidate) => {
  const relative = path.relative(folder, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
};

/**
 * The game-code folder for a project file. The folder NAME comes from the
 * renderer but is treated as ONE untrusted segment: anything carrying a
 * separator, a drive prefix, a NUL or a dot-segment is refused outright
 * rather than sanitized, so this process never invents a path the renderer
 * did not ask for.
 */
const resolveGameCodeFolder = (projectFile, gameCodeFolderName) => {
  if (typeof projectFile !== 'string' || !projectFile) {
    return { ok: false, error: 'No project file was given.' };
  }
  if (
    typeof gameCodeFolderName !== 'string' ||
    !gameCodeFolderName ||
    gameCodeFolderName.indexOf(NUL) !== -1
  ) {
    return { ok: false, error: 'Invalid game code folder name.' };
  }
  if (
    gameCodeFolderName.includes('/') ||
    gameCodeFolderName.includes('\\') ||
    gameCodeFolderName === '.' ||
    gameCodeFolderName === '..'
  ) {
    return { ok: false, error: 'Invalid game code folder name.' };
  }
  const projectFolder = path.dirname(path.resolve(projectFile));
  const folderPath = path.join(projectFolder, gameCodeFolderName);
  if (!isPathInsideFolder(projectFolder, folderPath)) {
    return { ok: false, error: 'Invalid game code folder name.' };
  }
  return { ok: true, folderPath };
};

/** Re-check a renderer-supplied relative path against the game-code folder. */
const resolveGameCodeFile = (folderPath, relativePath) => {
  if (typeof relativePath !== 'string' || !relativePath) {
    return { ok: false, error: 'No game code path was given.' };
  }
  if (relativePath.indexOf(NUL) !== -1) {
    return { ok: false, error: 'Invalid game code path.' };
  }
  const withForwardSlashes = relativePath.replace(/\\/g, '/');
  if (
    withForwardSlashes.startsWith('/') ||
    /^[a-zA-Z]:/.test(withForwardSlashes)
  ) {
    return { ok: false, error: 'Invalid game code path.' };
  }
  const segments = withForwardSlashes.split('/').filter(Boolean);
  if (segments.length === 0) {
    return { ok: false, error: 'No game code path was given.' };
  }
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      return { ok: false, error: 'Invalid game code path.' };
    }
    if (segment !== segment.trim() || segment.endsWith('.')) {
      return { ok: false, error: 'Invalid game code path.' };
    }
    if (/[<>:"|?*]/.test(segment)) {
      return { ok: false, error: 'Invalid game code path.' };
    }
    if (RESERVED_DEVICE_NAMES.includes(segment.split('.')[0].toLowerCase())) {
      return { ok: false, error: 'Invalid game code path.' };
    }
  }
  const absolutePath = path.resolve(folderPath, ...segments);
  if (!isPathInsideFolder(folderPath, absolutePath)) {
    return {
      ok: false,
      error: 'Refused: the path is outside the game code folder.',
    };
  }
  return { ok: true, absolutePath };
};

module.exports = {
  RESERVED_DEVICE_NAMES,
  isPathInsideFolder,
  resolveGameCodeFolder,
  resolveGameCodeFile,
};
