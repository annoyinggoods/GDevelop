/**
 * The confined `local-file-download` core (security fix UP-1): the upstream
 * IPC used to download ANY url to ANY path, attaching the GDevelop cloud
 * session cookie to every host. Rules enforced here: http(s) only, the
 * cloud cookie only for gdevelop.io hosts (see
 * shouldAttachGDevelopCloudCookie), a byte cap, an overall timeout and a
 * redirect cap (enforced by the Electron wrapper through makeByteCapGuard,
 * LOCAL_FILE_DOWNLOAD_TIMEOUT_MS and its per-hop validated redirect walk),
 * and the target path must stay inside the caller-declared base folder.
 * Plain-CJS on purpose (the ByokResourceDownloader pattern): required by
 * the Electron main (electron-app/app/LocalFileDownloader.js) and by the
 * Jest suite — never by the Flow-checked renderer app.
 */

const LOCAL_FILE_DOWNLOAD_MAX_BYTES = 200 * 1000 * 1000;
const LOCAL_FILE_DOWNLOAD_TIMEOUT_MS = 60 * 1000;
const LOCAL_FILE_DOWNLOAD_MAX_REDIRECTS = 5;

/** Only gdevelop.io itself and its subdomains ever see the cloud cookie. */
const shouldAttachGDevelopCloudCookie = hostname =>
  hostname === 'gdevelop.io' || hostname.endsWith('.gdevelop.io');

/** Segment-aware containment: "/projects/game2" is NOT inside "/projects/game". */
const isPathInsideFolder = (pathLib, folder, candidate) => {
  const relative = pathLib.relative(folder, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !pathLib.isAbsolute(relative))
  );
};

/**
 * Validate one download request. Pure; every argument is untrusted
 * (renderer-relayed).
 */
const validateLocalFileDownloadRequest = ({
  url,
  outputPath,
  basePath,
  pathLib,
}) => {
  if (
    typeof url !== 'string' ||
    typeof outputPath !== 'string' ||
    typeof basePath !== 'string' ||
    !url ||
    !outputPath ||
    !basePath
  ) {
    return { ok: false, error: 'Invalid download request.' };
  }
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch (error) {
    return { ok: false, error: `Not a valid URL: ${url}` };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      ok: false,
      error: `Only http(s) URLs can be downloaded (got "${parsed.protocol}").`,
    };
  }
  const resolvedBase = pathLib.resolve(basePath);
  const resolvedOutput = pathLib.resolve(outputPath);
  if (!isPathInsideFolder(pathLib, resolvedBase, resolvedOutput)) {
    return {
      ok: false,
      error: 'Refused: the download target is outside the base folder.',
    };
  }
  return { ok: true };
};

/**
 * Validate one save-from-arraybuffer request (the sibling IPC of the
 * download, same confinement rule — only the path applies, no URL).
 */
const validateLocalFileSavePath = ({ outputPath, basePath, pathLib }) => {
  if (
    typeof outputPath !== 'string' ||
    typeof basePath !== 'string' ||
    !outputPath ||
    !basePath
  ) {
    return { ok: false, error: 'Invalid save request.' };
  }
  if (
    !isPathInsideFolder(
      pathLib,
      pathLib.resolve(basePath),
      pathLib.resolve(outputPath)
    )
  ) {
    return {
      ok: false,
      error: 'Refused: the save target is outside the base folder.',
    };
  }
  return { ok: true };
};

/**
 * A byte-cap counter for streamed downloads: feed every chunk to accept;
 * once the cap is exceeded accept returns false (and keeps doing so) so
 * the Electron wrapper can destroy the stream.
 */
const makeByteCapGuard = maxBytes => {
  let receivedBytes = 0;
  let exceeded = false;
  return {
    accept: chunk => {
      if (exceeded) return false;
      receivedBytes += chunk.length;
      if (receivedBytes > maxBytes) {
        exceeded = true;
        return false;
      }
      return true;
    },
    bytesRead: () => receivedBytes,
  };
};

module.exports = {
  LOCAL_FILE_DOWNLOAD_MAX_BYTES,
  LOCAL_FILE_DOWNLOAD_TIMEOUT_MS,
  LOCAL_FILE_DOWNLOAD_MAX_REDIRECTS,
  shouldAttachGDevelopCloudCookie,
  isPathInsideFolder,
  validateLocalFileDownloadRequest,
  validateLocalFileSavePath,
  makeByteCapGuard,
};
