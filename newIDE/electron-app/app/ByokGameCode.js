const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeByokFileAtomically } = require('./SharedCore').loadSharedModule(
  'AiGeneration/Byok/ByokAtomicWriteCore'
);
const {
  isPathInsideFolder,
  resolveGameCodeFolder,
  resolveGameCodeFile,
} = require('./SharedCore').loadSharedModule(
  'AiGeneration/Byok/GameCode/ByokGameCodePathCore'
);

// The BYOK game-code files (Phase 15.1): the desktop side of
// `<project>/<GameName>Code/`. The RENDERER owns the folder name, the load
// order, the manifest and every user-visible rule — this module only moves
// bytes.
//
// Same discipline as ByokRagFiles.js: every handler answers with a value and
// never throws, because an exception inside an ipcMain.handle rejects the
// renderer's invoke and turns an ordinary refusal into a crash.
//
// Every path rule lives in ByokGameCodePathCore.js (plain CJS, spec'd from
// the renderer suite): this process derives the project folder from the
// project file it is given and refuses any path that does not stay inside
// the game-code folder inside it. The renderer applies the same rule in its
// own tested code; the check is repeated here because THIS is the process
// that writes to disk.

/** Mirrors BYOK_GAME_CODE_MAX_FILE_BYTES in ByokGameCodeCore.js. */
const BYOK_GAME_CODE_MAX_FILE_BYTES = 256 * 1024;

const describeError = error =>
  error && error.message ? error.message : String(error);

const listGameCodeFiles = (projectFile, gameCodeFolderName) => {
  try {
    const folder = resolveGameCodeFolder(projectFile, gameCodeFolderName);
    if (!folder.ok) return folder;
    if (!fs.existsSync(folder.folderPath)) return { ok: true, data: [] };

    const found = [];
    const walk = (directory, prefix) => {
      for (const entry of fs.readdirSync(directory)) {
        const absoluteEntry = path.join(directory, entry);
        const relativeEntry = prefix ? prefix + '/' + entry : entry;
        const stat = fs.statSync(absoluteEntry);
        if (stat.isDirectory()) {
          walk(absoluteEntry, relativeEntry);
          continue;
        }
        if (!/\.js$/i.test(entry)) continue;
        found.push({ relativePath: relativeEntry, sizeBytes: stat.size });
      }
    };
    walk(folder.folderPath, '');
    return { ok: true, data: found };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
};

const readGameCodeFile = (projectFile, gameCodeFolderName, relativePath) => {
  try {
    const folder = resolveGameCodeFolder(projectFile, gameCodeFolderName);
    if (!folder.ok) return folder;
    const file = resolveGameCodeFile(folder.folderPath, relativePath);
    if (!file.ok) return file;
    if (!fs.existsSync(file.absolutePath)) {
      return { ok: false, error: 'That game code file does not exist.' };
    }
    return { ok: true, data: fs.readFileSync(file.absolutePath, 'utf8') };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
};

const writeGameCodeFile = (
  projectFile,
  gameCodeFolderName,
  relativePath,
  content
) => {
  try {
    if (typeof content !== 'string') {
      return { ok: false, error: 'The file content must be a string.' };
    }
    const sizeBytes = Buffer.byteLength(content, 'utf8');
    if (sizeBytes > BYOK_GAME_CODE_MAX_FILE_BYTES) {
      return {
        ok: false,
        error: `The file is ${sizeBytes} bytes; a game code file is capped at ${BYOK_GAME_CODE_MAX_FILE_BYTES} bytes.`,
      };
    }
    const folder = resolveGameCodeFolder(projectFile, gameCodeFolderName);
    if (!folder.ok) return folder;
    const file = resolveGameCodeFile(folder.folderPath, relativePath);
    if (!file.ok) return file;

    const created = !fs.existsSync(file.absolutePath);
    fs.mkdirSync(path.dirname(file.absolutePath), { recursive: true });
    writeByokFileAtomically(
      fs,
      folder.folderPath,
      path.relative(folder.folderPath, file.absolutePath),
      content,
      () => crypto.randomBytes(8).toString('hex')
    );
    return { ok: true, data: { created } };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
};

const deleteGameCodeFile = (projectFile, gameCodeFolderName, relativePath) => {
  try {
    const folder = resolveGameCodeFolder(projectFile, gameCodeFolderName);
    if (!folder.ok) return folder;
    const file = resolveGameCodeFile(folder.folderPath, relativePath);
    if (!file.ok) return file;
    if (!fs.existsSync(file.absolutePath)) {
      return { ok: false, error: 'That game code file does not exist.' };
    }
    fs.unlinkSync(file.absolutePath);
    return { ok: true, data: { deleted: true } };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
};

const renameGameCodeFile = (
  projectFile,
  gameCodeFolderName,
  fromRelativePath,
  toRelativePath
) => {
  try {
    const folder = resolveGameCodeFolder(projectFile, gameCodeFolderName);
    if (!folder.ok) return folder;
    const from = resolveGameCodeFile(folder.folderPath, fromRelativePath);
    if (!from.ok) return from;
    const to = resolveGameCodeFile(folder.folderPath, toRelativePath);
    if (!to.ok) return to;
    if (!fs.existsSync(from.absolutePath)) {
      return { ok: false, error: 'That game code file does not exist.' };
    }
    fs.mkdirSync(path.dirname(to.absolutePath), { recursive: true });
    fs.renameSync(from.absolutePath, to.absolutePath);
    return { ok: true, data: null };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
};

const registerByokGameCodeFiles = ipcMain => {
  ipcMain.handle('byok-game-code-list', (event, projectFile, folderName) =>
    listGameCodeFiles(projectFile, folderName)
  );
  ipcMain.handle(
    'byok-game-code-read',
    (event, projectFile, folderName, relativePath) =>
      readGameCodeFile(projectFile, folderName, relativePath)
  );
  ipcMain.handle(
    'byok-game-code-write',
    (event, projectFile, folderName, relativePath, content) =>
      writeGameCodeFile(projectFile, folderName, relativePath, content)
  );
  ipcMain.handle(
    'byok-game-code-delete',
    (event, projectFile, folderName, relativePath) =>
      deleteGameCodeFile(projectFile, folderName, relativePath)
  );
  ipcMain.handle(
    'byok-game-code-rename',
    (event, projectFile, folderName, fromRelativePath, toRelativePath) =>
      renameGameCodeFile(
        projectFile,
        folderName,
        fromRelativePath,
        toRelativePath
      )
  );
};

module.exports = {
  BYOK_GAME_CODE_MAX_FILE_BYTES,
  registerByokGameCodeFiles,
  isPathInsideFolder,
  resolveGameCodeFolder,
  resolveGameCodeFile,
  listGameCodeFiles,
  readGameCodeFile,
  writeGameCodeFile,
  deleteGameCodeFile,
  renameGameCodeFile,
};
