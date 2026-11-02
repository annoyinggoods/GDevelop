/* eslint-disable no-undef */

/**
 * The asset-index path confinement of the ELECTRON MAIN process
 * (Phase 17.2).
 *
 * Plain CJS for the same reason ByokGameCodePathCore.js and
 * ByokAtomicWriteCore.js are: the Electron main requires it directly (that
 * package has no test runner) and the Jest renderer suite specs it here.
 * The renderer has its own copy of the file NAME (FORK_ASSET_INDEX_FILE_NAME
 * in ForkAssetIndex.js); the rule is applied TWICE — in the process that
 * decides and in the process that writes — because the input crosses the
 * IPC boundary in between.
 *
 * The rule: this process never trusts a project file path it is handed. It
 * resolves the folder, joins the ONE fixed index file name, and re-checks
 * containment, so no renderer argument can steer a read or a write
 * anywhere but `<project folder>/assets-index.json`.
 */

const path = require('path');

/** Mirrors FORK_ASSET_INDEX_FILE_NAME in ForkAssetIndex.js. */
const FORK_ASSET_INDEX_FILE_NAME = 'assets-index.json';

/** Segment-aware containment (same rule as ByokGameCodePathCore). */
const isPathInsideFolder = (folder, candidate) => {
  const relative = path.relative(folder, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
};

/**
 * The one writable/readable index path of a project. `projectFile` must be
 * an absolute path to the project file; anything else is refused.
 */
const resolveForkAssetIndexPath = projectFile => {
  if (typeof projectFile !== 'string' || !projectFile) {
    return { ok: false, error: 'No project file was given.' };
  }
  if (projectFile.indexOf(String.fromCharCode(0)) !== -1) {
    return { ok: false, error: 'Invalid project file path.' };
  }
  if (!path.isAbsolute(projectFile)) {
    return { ok: false, error: 'The project file path must be absolute.' };
  }
  const projectFolder = path.dirname(path.resolve(projectFile));
  const indexPath = path.join(projectFolder, FORK_ASSET_INDEX_FILE_NAME);
  if (!isPathInsideFolder(projectFolder, indexPath)) {
    // Unreachable with a fixed file name — kept as a belt-and-braces guard.
    return { ok: false, error: 'Invalid asset index path.' };
  }
  return { ok: true, indexPath };
};

module.exports = {
  FORK_ASSET_INDEX_FILE_NAME,
  isPathInsideFolder,
  resolveForkAssetIndexPath,
};
