const fs = require('fs');
const path = require('path');
const { writeByokFileAtomically } = require('./SharedCore').loadSharedModule(
  'AiGeneration/Byok/ByokAtomicWriteCore'
);
const makeUniqueTempToken = () =>
  require('crypto')
    .randomBytes(8)
    .toString('hex');

// BYOK durable chat history (Phase 9.3): the desktop side of the chat file
// store. The chats live as Markdown files (plus `.images.json` image
// sidecars) in `<userData>/byok-chats/`. This module only moves bytes —
// the format, the validation and the quarantine policy live renderer-side
// (ByokChatPersistence.js), and every handler answers with a value (never
// an exception), so a broken file system state cannot take the main
// process down (the ByokUserSkills pattern).

const BYOK_CHATS_FOLDER = 'byok-chats';

/**
 * The chat folder of the given user-data folder (not created by this call).
 */
const getByokChatsFolder = userDataPath =>
  path.join(userDataPath, BYOK_CHATS_FOLDER);

/**
 * A chat file name is a single safe path segment: anything carrying a
 * separator, a traversal or a hidden-file dot prefix is rejected.
 */
const isSafeChatFileName = fileName => {
  if (typeof fileName !== 'string' || !fileName) return false;
  if (fileName.startsWith('.')) return false;
  if (fileName.includes('/') || fileName.includes('\\')) return false;
  if (fileName.includes('..')) return false;
  if (fileName !== fileName.trim()) return false;
  // A colon would create a Windows Alternate Data Stream instead of the
  // intended file (audit011026 B-ELEC-12).
  if (fileName.includes(':')) return false;
  return true;
};

/**
 * List the chat files of the folder: names and sizes only — the contents
 * are read lazily per chat (the history list must stay cheap).
 */
const listByokChatFiles = userDataPath => {
  try {
    const chatsFolder = getByokChatsFolder(userDataPath);
    if (!fs.existsSync(chatsFolder)) return { ok: true, data: [] };
    const entries = fs.readdirSync(chatsFolder, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        const stats = fs.statSync(path.join(chatsFolder, entry.name));
        files.push({ fileName: entry.name, sizeBytes: stats.size });
      } catch (error) {
        // One unreadable entry must not hide the others.
      }
    }
    return { ok: true, data: files };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
};

const readByokChatFile = (userDataPath, fileName) => {
  try {
    if (!isSafeChatFileName(fileName)) {
      return { ok: false, error: 'Invalid chat file name.' };
    }
    const filePath = path.join(getByokChatsFolder(userDataPath), fileName);
    return { ok: true, data: fs.readFileSync(filePath, 'utf8') };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
};

const writeByokChatFile = (userDataPath, fileName, content) => {
  try {
    if (!isSafeChatFileName(fileName)) {
      return { ok: false, error: 'Invalid chat file name.' };
    }
    const chatsFolder = getByokChatsFolder(userDataPath);
    fs.mkdirSync(chatsFolder, { recursive: true });
    // Atomic write (audit011026 B-ELEC-10): a crash mid-write of the final
    // path left a truncated chat that the renderer's quarantine then hid —
    // temp + same-volume rename keeps the previous file intact until the
    // new one is fully on disk. The temp name is unique per call: it used
    // to be fixed per file+pid, so two windows saving the same chat
    // published each other's buffer (audit100226 ELEC-19).
    writeByokFileAtomically(
      fs,
      chatsFolder,
      fileName,
      content,
      makeUniqueTempToken
    );
    return { ok: true, data: null };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
};

const deleteByokChatFile = (userDataPath, fileName) => {
  try {
    if (!isSafeChatFileName(fileName)) {
      return { ok: false, error: 'Invalid chat file name.' };
    }
    const filePath = path.join(getByokChatsFolder(userDataPath), fileName);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { ok: true, data: null };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
};

const moveByokChatFile = (userDataPath, fromFileName, toFileName) => {
  try {
    if (!isSafeChatFileName(fromFileName) || !isSafeChatFileName(toFileName)) {
      return { ok: false, error: 'Invalid chat file name.' };
    }
    const chatsFolder = getByokChatsFolder(userDataPath);
    fs.mkdirSync(chatsFolder, { recursive: true });
    fs.renameSync(
      path.join(chatsFolder, fromFileName),
      path.join(chatsFolder, toFileName)
    );
    return { ok: true, data: null };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
};

const getByokChatsTotalBytes = userDataPath => {
  try {
    const chatsFolder = getByokChatsFolder(userDataPath);
    if (!fs.existsSync(chatsFolder)) return { ok: true, data: 0 };
    const entries = fs.readdirSync(chatsFolder, { withFileTypes: true });
    let totalBytes = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        totalBytes += fs.statSync(path.join(chatsFolder, entry.name)).size;
      } catch (error) {
        // Skip the unreadable entry.
      }
    }
    return { ok: true, data: totalBytes };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
};

const registerByokChatFileHandlers = (ipcMain, app) => {
  ipcMain.handle('byok-chats-list', () =>
    listByokChatFiles(app.getPath('userData'))
  );
  ipcMain.handle('byok-chats-read', (event, fileName) =>
    readByokChatFile(app.getPath('userData'), fileName)
  );
  ipcMain.handle('byok-chats-write', (event, fileName, content) =>
    writeByokChatFile(app.getPath('userData'), fileName, content)
  );
  ipcMain.handle('byok-chats-delete', (event, fileName) =>
    deleteByokChatFile(app.getPath('userData'), fileName)
  );
  ipcMain.handle('byok-chats-move', (event, fromFileName, toFileName) =>
    moveByokChatFile(app.getPath('userData'), fromFileName, toFileName)
  );
  ipcMain.handle('byok-chats-total-bytes', () =>
    getByokChatsTotalBytes(app.getPath('userData'))
  );
};

module.exports = {
  BYOK_CHATS_FOLDER,
  registerByokChatFileHandlers,
  isSafeChatFileName,
};
