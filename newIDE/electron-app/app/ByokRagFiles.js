const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { writeByokFileAtomically } = require('./SharedCore').loadSharedModule(
  'AiGeneration/Byok/ByokAtomicWriteCore'
);
// The same pure-CJS core the Qdrant module uses for its snapshot URL, so the
// renderer-built bundle URLs are re-checked in THIS process before any
// request leaves it (audit100226 ELEC-22).
const {
  isAllowedByokRagBundleApiUrl,
  isAllowedByokRagBundleDownloadUrl,
} = require('./SharedCore').loadSharedModule(
  'AiGeneration/Byok/Rag/ByokQdrantSetupCore'
);

// BYOK RAG index files (Phase 13.7/13.8): the desktop side of the RAG
// storage. The in-process index lives as one JSON file (base64 vectors) in
// `<userData>/byok-rag/`. Same discipline as ByokChatFiles: this module
// only moves bytes, every handler answers with a value (never throws).
//
// Phase 14.4 (D14-3/D14-7(a)) adds the prebuilt-bundle channels: the
// release listing and the verified download. The bundle is the app's own
// index JSON plus a manifest; the sha256 is verified HERE (node crypto)
// before the renderer ever sees the payload — the renderer re-validates
// the envelope shape and the corpus compatibility in its own tested code
// (ByokRagBundle.js). URLs come from the renderer's tested constants; the
// downloads are opt-in (a consent dialog ran first).

const BYOK_RAG_FOLDER = 'byok-rag';

/** Download-bundle payloads are JSON indexes — cap them far above real. */
const BYOK_RAG_BUNDLE_MAX_BYTES = 200 * 1024 * 1024;

const getByokRagFolder = userDataPath =>
  path.join(userDataPath, BYOK_RAG_FOLDER);

const isSafeRagFileName = fileName => {
  const backslash = String.fromCharCode(92);
  if (typeof fileName !== 'string' || !fileName) return false;
  if (fileName.startsWith('.')) return false;
  if (fileName.includes('/') || fileName.includes(backslash)) return false;
  if (fileName.includes('..')) return false;
  if (fileName !== fileName.trim()) return false;
  // A colon would create a Windows Alternate Data Stream (audit011026
  // B-ELEC-12).
  if (fileName.includes(':')) return false;
  return true;
};

// Atomic writes (audit011026 B-RAG-11): an interrupted in-place write of
// the ~10-40 MB index left a truncated file the loader then treated as "no
// index built yet" — the previous working index was silently destroyed.
// temp + same-volume rename keeps the old file intact until the new one is
// fully on disk.
const writeByokRagFileAtomically = (folderPath, fileName, content) => {
  // The shared core owns the unique temp name (audit100226 ELEC-19: the old
  // fixed `<file>.tmp-<pid>` let two concurrent downloads to the fixed
  // bundle name publish each other's buffer).
  writeByokFileAtomically(fs, folderPath, fileName, content, () =>
    crypto.randomBytes(8).toString('hex')
  );
};

const writeByokRagFile = (userDataPath, fileName, content) => {
  try {
    if (!isSafeRagFileName(fileName)) {
      return { ok: false, error: 'Invalid RAG file name.' };
    }
    const ragFolder = getByokRagFolder(userDataPath);
    fs.mkdirSync(ragFolder, { recursive: true });
    writeByokRagFileAtomically(ragFolder, fileName, content);
    return { ok: true, data: null };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
};

const readByokRagFile = (userDataPath, fileName) => {
  try {
    if (!isSafeRagFileName(fileName)) {
      return { ok: false, error: 'Invalid RAG file name.' };
    }
    const filePath = path.join(getByokRagFolder(userDataPath), fileName);
    if (!fs.existsSync(filePath)) return { ok: true, data: null };
    return { ok: true, data: fs.readFileSync(filePath, 'utf8') };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
};

const deleteByokRagFile = (userDataPath, fileName) => {
  try {
    if (!isSafeRagFileName(fileName)) {
      return { ok: false, error: 'Invalid RAG file name.' };
    }
    const filePath = path.join(getByokRagFolder(userDataPath), fileName);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { ok: true, data: null };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
};

const BYOK_RAG_FETCH_TIMEOUT_MS = 30000;
const BYOK_RAG_MAX_REDIRECTS = 5;

const fetchTextWithRedirects = (url, maxBytes, userAgent, redirectsLeft) =>
  new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { 'User-Agent': userAgent } },
      response => {
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          // GitHub API and release-asset URLs redirect — bounded, so a loop
          // cannot recurse forever (audit011026 B-ELEC-6).
          response.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects.'));
            return;
          }
          fetchTextWithRedirects(
            new URL(response.headers.location, url).href,
            maxBytes,
            userAgent,
            redirectsLeft - 1
          ).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`HTTP ${response.statusCode} for ${url}`));
          return;
        }
        const chunks = [];
        let received = 0;
        response.on('data', chunk => {
          received += chunk.length;
          if (received > maxBytes) {
            response.destroy();
            reject(new Error('The download exceeded the size cap.'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          resolve(Buffer.concat(chunks).toString('utf8'))
        );
        response.on('error', reject);
      }
    );
    // A hung server must settle the IPC, not leave the consent dialog
    // pending forever (audit011026 B-ELEC-6).
    request.setTimeout(BYOK_RAG_FETCH_TIMEOUT_MS, () => {
      request.destroy();
      reject(new Error(`Timed out fetching ${url}`));
    });
    request.on('error', reject);
  });

/** The newest GitHub releases (the renderer distills the bundle one). */
const fetchByokRagBundleReleases = async apiUrl => {
  const text = await fetchTextWithRedirects(
    apiUrl,
    5 * 1024 * 1024,
    'GDevelop-BYOK-RAG',
    BYOK_RAG_MAX_REDIRECTS
  );
  return JSON.parse(text);
};

/** Where the verified bundle lands for the renderer to read back. */
const BYOK_RAG_BUNDLE_DOWNLOAD_FILE = 'bundle-download.json';

/**
 * Download a bundle asset and verify its integrity hash: the sha256 of
 * the canonical JSON of `bundle.index` (the exact re-stringification the
 * builder hashed — JSON.parse preserves key order). The verified JSON is
 * kept under a fixed safe name which the renderer reads through the
 * regular byok-rag-read channel (audit011026 B-ELEC-7: returning the
 * parsed object over IPC structured-cloned the whole payload on top of
 * the parse — the peak is now the parse only, and the clone is gone).
 */
const downloadVerifiedByokRagBundle = async (userDataPath, downloadUrl) => {
  const text = await fetchTextWithRedirects(
    downloadUrl,
    BYOK_RAG_BUNDLE_MAX_BYTES,
    'GDevelop-BYOK-RAG',
    BYOK_RAG_MAX_REDIRECTS
  );
  const parsed = JSON.parse(text);
  if (
    !parsed ||
    !parsed.integrity ||
    typeof parsed.integrity.indexSha256 !== 'string' ||
    !parsed.index
  ) {
    throw new Error('The downloaded file is not a RAG bundle.');
  }
  const actualHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(parsed.index), 'utf8')
    .digest('hex');
  if (actualHash !== parsed.integrity.indexSha256) {
    throw new Error(
      'The bundle integrity check failed (sha256 mismatch) — the download was corrupted or tampered with.'
    );
  }
  const ragFolder = getByokRagFolder(userDataPath);
  fs.mkdirSync(ragFolder, { recursive: true });
  writeByokRagFileAtomically(
    ragFolder,
    BYOK_RAG_BUNDLE_DOWNLOAD_FILE,
    JSON.stringify(parsed)
  );
  return {
    fileName: BYOK_RAG_BUNDLE_DOWNLOAD_FILE,
    sizeBytes: Buffer.byteLength(text, 'utf8'),
  };
};

const registerByokRagFileHandlers = (ipcMain, app) => {
  ipcMain.handle('byok-rag-write', (event, fileName, content) =>
    writeByokRagFile(app.getPath('userData'), fileName, content)
  );
  ipcMain.handle('byok-rag-read', (event, fileName) =>
    readByokRagFile(app.getPath('userData'), fileName)
  );
  ipcMain.handle('byok-rag-delete', (event, fileName) =>
    deleteByokRagFile(app.getPath('userData'), fileName)
  );
  ipcMain.handle('byok-rag-bundle-info', async (event, apiUrl) => {
    // The URL comes from the renderer and is dereferenced by this process:
    // only the official GDevelop releases API may be asked (audit100226
    // ELEC-22). Checked here, before any request.
    if (!isAllowedByokRagBundleApiUrl(apiUrl)) {
      return {
        ok: false,
        error: 'Refused: unexpected prebuilt-index API URL.',
      };
    }
    try {
      return { ok: true, releases: await fetchByokRagBundleReleases(apiUrl) };
    } catch (error) {
      return {
        ok: false,
        error: `The prebuilt-index release listing is unreachable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  });
  ipcMain.handle('byok-rag-bundle-download', async (event, downloadUrl) => {
    if (!isAllowedByokRagBundleDownloadUrl(downloadUrl)) {
      return {
        ok: false,
        error: 'Refused: unexpected prebuilt-index download URL.',
      };
    }
    try {
      const downloaded = await downloadVerifiedByokRagBundle(
        app.getPath('userData'),
        downloadUrl
      );
      return { ok: true, ...downloaded };
    } catch (error) {
      return {
        ok: false,
        error: `The prebuilt index download failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  });
};

module.exports = {
  BYOK_RAG_FOLDER,
  registerByokRagFileHandlers,
  isSafeRagFileName,
};
