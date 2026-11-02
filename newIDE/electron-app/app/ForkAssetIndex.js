const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeByokFileAtomically } = require('./SharedCore').loadSharedModule(
  'AiGeneration/Byok/ByokAtomicWriteCore'
);
const { resolveForkAssetIndexPath } = require('./SharedCore').loadSharedModule(
  'Fork/AssetPipeline/ForkAssetIndexCore'
);

// The fork asset-index sidecar (Phase 17.2): the optional
// <project>/assets-index.json. The RENDERER owns the format, the version
// and the "metadata is the authority" discipline (Fork/AssetPipeline/
// ForkAssetIndex.js) — this module only moves bytes, confined to the one
// fixed file name inside the project folder it derives from the project
// file.
//
// Same discipline as ByokGameCode.js: every handler answers with a value
// and never throws, because an exception inside an ipcMain.handle rejects
// the renderer's invoke and turns an ordinary refusal into a crash.

const describeError = error =>
  error && error.message ? error.message : String(error);

/** Whether the sidecar exists (and how big it is), without reading it. */
const statForkAssetIndex = projectFile => {
  try {
    const resolved = resolveForkAssetIndexPath(projectFile);
    if (!resolved.ok) return resolved;
    if (!fs.existsSync(resolved.indexPath)) {
      return { ok: true, data: { exists: false, sizeBytes: 0 } };
    }
    const stat = fs.statSync(resolved.indexPath);
    return { ok: true, data: { exists: true, sizeBytes: stat.size } };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
};

const readForkAssetIndex = projectFile => {
  try {
    const resolved = resolveForkAssetIndexPath(projectFile);
    if (!resolved.ok) return resolved;
    if (!fs.existsSync(resolved.indexPath)) {
      // "No index yet" is a normal state, not an error: the renderer then
      // reads the tags straight from the resource metadata.
      return { ok: true, data: null };
    }
    return { ok: true, data: fs.readFileSync(resolved.indexPath, 'utf8') };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
};

const writeForkAssetIndex = (projectFile, content) => {
  try {
    if (typeof content !== 'string') {
      return { ok: false, error: 'The asset index content must be a string.' };
    }
    const resolved = resolveForkAssetIndexPath(projectFile);
    if (!resolved.ok) return resolved;
    // The write is atomic and in place, in the project folder (which always
    // exists — the project file lives in it).
    writeByokFileAtomically(
      fs,
      path.dirname(resolved.indexPath),
      path.basename(resolved.indexPath),
      content,
      () => crypto.randomBytes(8).toString('hex')
    );
    return { ok: true, data: null };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
};

const registerForkAssetIndexFiles = ipcMain => {
  ipcMain.handle('fork-asset-index-list', (event, projectFile) =>
    statForkAssetIndex(projectFile)
  );
  ipcMain.handle('fork-asset-index-read', (event, projectFile) =>
    readForkAssetIndex(projectFile)
  );
  ipcMain.handle('fork-asset-index-write', (event, projectFile, content) =>
    writeForkAssetIndex(projectFile, content)
  );
};

module.exports = {
  registerForkAssetIndexFiles,
  statForkAssetIndex,
  readForkAssetIndex,
  writeForkAssetIndex,
};
