/**
 * The confined BYOK resource-download core (audit011026 B-ELEC-14):
 * `import_project_resources` downloads model-chosen URLs, so the download
 * rides its OWN IPC instead of the upstream `local-file-download` (which
 * attaches the GDevelop cloud session cookie to ANY host and writes to any
 * path without validation). Rules enforced here: http(s) only, the cloud
 * cookie only for gdevelop.io hosts, a byte cap, a timeout, a redirect
 * cap, and the target path must stay inside the project folder.
 * Plain-CJS on purpose (the ByokQdrantSetupCore pattern): required by the
 * Electron main (electron-app/app/ByokResourceDownload.js) and by the Jest
 * suite — never by the Flow-checked renderer app.
 */

const BYOK_RESOURCE_DOWNLOAD_MAX_BYTES = 200 * 1000 * 1000;
const BYOK_RESOURCE_DOWNLOAD_TIMEOUT_MS = 60 * 1000;
const BYOK_RESOURCE_DOWNLOAD_MAX_REDIRECTS = 5;

/** Only gdevelop.io itself and its subdomains ever see the cloud cookie. */
const isByokGDevelopHost = hostname =>
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
 * (renderer-relayed, ultimately model-chosen).
 */
const validateByokResourceDownloadRequest = ({
  url,
  outputPath,
  projectFile,
  pathLib,
}) => {
  if (
    typeof url !== 'string' ||
    typeof outputPath !== 'string' ||
    typeof projectFile !== 'string' ||
    !url ||
    !outputPath ||
    !projectFile
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
  const projectFolder = pathLib.dirname(pathLib.resolve(projectFile));
  const resolvedOutput = pathLib.resolve(outputPath);
  if (!isPathInsideFolder(pathLib, projectFolder, resolvedOutput)) {
    return {
      ok: false,
      error: 'Refused: the download target is outside the project folder.',
    };
  }
  return { ok: true };
};

/**
 * One request/response round (no redirect following). Resolves with
 * `{ ok: true }`, `{ ok: false, error }` or `{ redirectLocation }` for the
 * caller to follow (bounded there).
 */
const downloadByokResourceOnce = ({
  transport,
  parsedUrl,
  headers,
  outputPath,
  fs,
  timeoutMs,
  maxBytes,
}) =>
  new Promise(resolve => {
    const request = transport.get(parsedUrl.href, { headers }, response => {
      const redirectStatuses = [301, 302, 303, 307, 308];
      if (redirectStatuses.indexOf(response.statusCode) !== -1) {
        response.resume();
        resolve({ redirectLocation: response.headers.location || null });
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        resolve({
          ok: false,
          error: `The download failed: HTTP ${response.statusCode}.`,
        });
        return;
      }
      const writer = fs.createWriteStream(outputPath);
      let receivedBytes = 0;
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        if (!result.ok) {
          try {
            writer.destroy();
          } catch (error) {
            // A destroyed writer is the best-effort cleanup already.
          }
          try {
            fs.unlinkSync(outputPath);
          } catch (error) {
            // The partial file may already be gone.
          }
        }
        resolve(result);
      };
      response.on('data', chunk => {
        receivedBytes += chunk.length;
        if (receivedBytes > maxBytes) {
          request.destroy();
          finish({
            ok: false,
            error: `The file exceeds the ${maxBytes} byte download cap.`,
          });
        }
      });
      writer.on('error', error => {
        finish({
          ok: false,
          error: `Writing the file failed: ${error.message}`,
        });
      });
      writer.on('finish', () => finish({ ok: true }));
      response.on('error', error => {
        finish({ ok: false, error: `The download failed: ${error.message}` });
      });
      response.pipe(writer);
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      resolve({
        ok: false,
        error: `The download timed out after ${timeoutMs} ms.`,
      });
    });
    request.on('error', error => {
      resolve({ ok: false, error: `The download failed: ${error.message}` });
    });
  });

/**
 * The download handler factory: the Electron main registers the returned
 * function on the `byok-download-resource` channel with the real node
 * modules; the tests inject fakes.
 */
const createByokResourceDownloader = ({
  https,
  http,
  fs,
  pathLib,
  getCloudCookieValue,
}) => async ({ url, outputPath, projectFile }) => {
  const validation = validateByokResourceDownloadRequest({
    url,
    outputPath,
    projectFile,
    pathLib,
  });
  if (!validation.ok) return validation;

  let currentUrl = url;
  for (let hop = 0; hop <= BYOK_RESOURCE_DOWNLOAD_MAX_REDIRECTS; hop++) {
    const parsedUrl = new URL(currentUrl);
    const transport = parsedUrl.protocol === 'https:' ? https : http;
    const headers = {};
    if (isByokGDevelopHost(parsedUrl.hostname)) {
      const cookieValue = await getCloudCookieValue();
      if (cookieValue) headers.Cookie = `gd_resource=${cookieValue}`;
    }
    const result = await downloadByokResourceOnce({
      transport,
      parsedUrl,
      headers,
      outputPath,
      fs,
      timeoutMs: BYOK_RESOURCE_DOWNLOAD_TIMEOUT_MS,
      maxBytes: BYOK_RESOURCE_DOWNLOAD_MAX_BYTES,
    });
    if (result.redirectLocation) {
      if (hop === BYOK_RESOURCE_DOWNLOAD_MAX_REDIRECTS) {
        return { ok: false, error: 'Too many redirects.' };
      }
      currentUrl = new URL(result.redirectLocation, currentUrl).href;
      continue;
    }
    return result;
  }
  return { ok: false, error: 'Too many redirects.' };
};

module.exports = {
  BYOK_RESOURCE_DOWNLOAD_MAX_BYTES,
  BYOK_RESOURCE_DOWNLOAD_TIMEOUT_MS,
  BYOK_RESOURCE_DOWNLOAD_MAX_REDIRECTS,
  isByokGDevelopHost,
  validateByokResourceDownloadRequest,
  createByokResourceDownloader,
};
