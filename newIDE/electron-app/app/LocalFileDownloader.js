const fs = require('fs');
const path = require('path');
const axios = require('axios');
const log = require('electron-log');
const { session } = require('electron');
const {
  LOCAL_FILE_DOWNLOAD_MAX_BYTES,
  LOCAL_FILE_DOWNLOAD_TIMEOUT_MS,
  LOCAL_FILE_DOWNLOAD_MAX_REDIRECTS,
  shouldAttachGDevelopCloudCookie,
  validateLocalFileDownloadRequest,
  validateLocalFileSavePath,
  makeByteCapGuard,
} = require('./SharedCore').loadSharedModule('Utils/LocalFileDownloadCore');

const findGDevelopCloudCookieValue = async () => {
  /** @type {import("electron").Cookie[]} */
  let cookies = [];
  try {
    cookies = await session.defaultSession.cookies.get({
      domain: 'gdevelop.io',
      name: 'gd_resource',
    });
  } catch (error) {
    log.error('Error while reading cookies:', error);
  }

  const gdevelopCloudCookieValue = cookies[0] ? cookies[0].value : null;
  return gdevelopCloudCookieValue;
};

/**
 * Resolve the URL through its redirect chain, re-validating every hop and
 * re-deciding the cookie per host: the bundled axios (0.19.x) forwards
 * headers across cross-host redirects, so a gdevelop.io URL redirecting
 * elsewhere would otherwise carry the cloud cookie on that hop.
 */
const requestThroughRedirects = async url => {
  let currentUrl = url;
  for (let hop = 0; hop <= LOCAL_FILE_DOWNLOAD_MAX_REDIRECTS; hop++) {
    const hostname = new URL(currentUrl).hostname;
    const gdevelopCloudCookieValue = shouldAttachGDevelopCloudCookie(hostname)
      ? await findGDevelopCloudCookieValue()
      : null;

    const response = await axios.get(currentUrl, {
      responseType: 'stream',
      timeout: LOCAL_FILE_DOWNLOAD_TIMEOUT_MS,
      maxRedirects: 0,
      // 3xx must resolve (not reject) so the walk can inspect them.
      validateStatus: status => status >= 200 && status < 400,
      headers: gdevelopCloudCookieValue
        ? {
            Cookie: `gd_resource=${gdevelopCloudCookieValue}`,
          }
        : {},
    });

    if (response.status >= 200 && response.status < 300) {
      return response;
    }

    const location = response.headers ? response.headers.location : null;
    response.data.destroy();
    if (!location) {
      throw new Error(
        `The server answered ${response.status} without a redirect location.`
      );
    }
    const nextUrl = new URL(location, currentUrl).href;
    const nextHopValidation = validateLocalFileDownloadRequest({
      url: nextUrl,
      // The path rules are unchanged by redirects; only the URL is re-checked.
      outputPath: '.',
      basePath: '.',
      pathLib: path,
    });
    if (!nextHopValidation.ok) {
      throw new Error(nextHopValidation.error);
    }
    currentUrl = nextUrl;
  }
  throw new Error(
    `The download exceeded ${LOCAL_FILE_DOWNLOAD_MAX_REDIRECTS} redirects.`
  );
};

module.exports = {
  /**
   * @param {string} url
   * @param {string} outputPath
   * @param {string} basePath The folder the outputPath must stay inside
   * (security fix UP-1 — see LocalFileDownloadCore for the rules).
   */
  downloadLocalFile: async (url, outputPath, basePath) => {
    const validation = validateLocalFileDownloadRequest({
      url,
      outputPath,
      basePath,
      pathLib: path,
    });
    if (!validation.ok) {
      throw new Error(validation.error);
    }

    // Only gdevelop.io itself and its subdomains ever see the cloud cookie,
    // on the initial request and on every redirect hop alike.
    log.verbose(`Downloading ${url} to ${outputPath}...`);
    const response = await requestThroughRedirects(url);

    // Create the writer only after the request is successful.
    const writer = fs.createWriteStream(outputPath);
    const byteCapGuard = makeByteCapGuard(LOCAL_FILE_DOWNLOAD_MAX_BYTES);

    return new Promise((resolve, reject) => {
      let isRejectedOrResolvedAlready = false;
      let transferWatchdogTimer = null;

      const cleanUpAndReject = err => {
        if (isRejectedOrResolvedAlready) return;
        isRejectedOrResolvedAlready = true;

        if (transferWatchdogTimer) clearTimeout(transferWatchdogTimer);
        try {
          writer.destroy();
        } catch (e) {}
        try {
          response.data.destroy();
        } catch (e) {}
        // Best effort to remove the incomplete file
        try {
          fs.unlinkSync(outputPath);
        } catch (e) {}
        reject(err);
      };

      // Overall transfer watchdog: destroys the stream and rejects if the
      // download does not finish in time (the axios "timeout" only guards
      // the request setup and socket inactivity).
      transferWatchdogTimer = setTimeout(() => {
        cleanUpAndReject(
          new Error(
            `The download timed out after ${LOCAL_FILE_DOWNLOAD_TIMEOUT_MS} ms.`
          )
        );
      }, LOCAL_FILE_DOWNLOAD_TIMEOUT_MS);

      response.data.on('data', chunk => {
        if (!byteCapGuard.accept(chunk)) {
          cleanUpAndReject(
            new Error(
              `The file exceeds the ${LOCAL_FILE_DOWNLOAD_MAX_BYTES} byte download cap.`
            )
          );
        }
      });
      response.data.on('error', cleanUpAndReject);
      writer.on('error', cleanUpAndReject);
      writer.on('finish', () => {
        if (isRejectedOrResolvedAlready) return;
        isRejectedOrResolvedAlready = true;
        clearTimeout(transferWatchdogTimer);
        resolve(true);
      });

      response.data.pipe(writer);
    });
  },
  /**
   * @param {ArrayBuffer} arrayBuffer
   * @param {string} outputPath
   * @param {string} basePath The folder the outputPath must stay inside
   * (security fix UP-1 — same confinement rule as the download).
   */
  saveLocalFileFromArrayBuffer: async (arrayBuffer, outputPath, basePath) => {
    const validation = validateLocalFileSavePath({
      outputPath,
      basePath,
      pathLib: path,
    });
    if (!validation.ok) {
      throw new Error(validation.error);
    }
    if (
      !arrayBuffer ||
      !arrayBuffer.byteLength ||
      arrayBuffer.byteLength > LOCAL_FILE_DOWNLOAD_MAX_BYTES
    ) {
      throw new Error(
        `The payload is empty or exceeds the ${LOCAL_FILE_DOWNLOAD_MAX_BYTES} byte cap.`
      );
    }
    await fs.promises.writeFile(outputPath, Buffer.from(arrayBuffer));
  },
};
