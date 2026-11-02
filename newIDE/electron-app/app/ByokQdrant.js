const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const net = require('net');
const childProcess = require('child_process');
const core = require('./SharedCore').loadSharedModule(
  'AiGeneration/Byok/Rag/ByokQdrantSetupCore'
);

// The managed Qdrant instance (Phase 13.8, D13-1): the "Set up permanent
// indexing with Qdrant" button installs the official binary under
// `<userData>/qdrant/` and this module starts it with every app launch
// (loopback only), health-checks it, and kills it on quit — the same
// lifecycle pattern as the MCP server. The pure setup state machine lives
// renderer-side (ByokQdrantSetupCore, Jest-tested); this wrapper only
// provides the real file/process/network operations. RAG never hard-depends
// on Qdrant: a failing setup falls back to the in-process index with the
// error message.

const BYOK_QDRANT_FOLDER = 'qdrant';
const DEFAULT_QDRANT_BASE_URL = 'http://127.0.0.1:6333';

let qdrantChildren = new Set();
let lastKnownBaseUrl = null;
let shuttingDown = false;
let setupInFlight = null;

const killByokQdrantChildren = () => {
  for (const child of qdrantChildren) {
    try {
      child.kill();
    } catch (error) {
      // Already gone.
    }
  }
  qdrantChildren = new Set();
};

const getQdrantFolder = userDataPath =>
  path.join(userDataPath, BYOK_QDRANT_FOLDER);

const isHealthy = baseUrl =>
  new Promise(resolve => {
    const request = http.get(`${baseUrl}/healthz`, response => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
    request.setTimeout(3000, () => {
      request.destroy();
      resolve(false);
    });
  });

const BYOK_QDRANT_DOWNLOAD_MAX_BYTES = 300 * 1000 * 1000;
const BYOK_QDRANT_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const BYOK_QDRANT_MAX_REDIRECTS = 5;

const removeFileBestEffort = destinationPath => {
  fs.unlink(destinationPath, () => {
    // Best-effort cleanup of the partial archive.
  });
};

// The final (2xx) hop only: the destination stream is opened here, never
// on a redirect (the old shape leaked one open handle per hop and never
// destroyed the 3xx responses — audit011026 B-RAG-19), with a byte cap and
// a timeout (ELEC-5).
const downloadArchiveToStream = (url, destinationPath, redirectsLeft) =>
  new Promise((resolve, reject) => {
    const transport = url.startsWith('http://') ? http : https;
    const request = transport.get(url, response => {
      if (
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error('Download failed: too many redirects.'));
          return;
        }
        const nextUrl = new URL(response.headers.location, url).href;
        downloadArchiveToStream(
          nextUrl,
          destinationPath,
          redirectsLeft - 1
        ).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed: HTTP ${response.statusCode}`));
        return;
      }
      const file = fs.createWriteStream(destinationPath);
      let receivedBytes = 0;
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        try {
          file.destroy();
        } catch (closeError) {
          // The destroy itself is best-effort.
        }
        removeFileBestEffort(destinationPath);
        reject(error);
      };
      response.on('data', chunk => {
        receivedBytes += chunk.length;
        if (receivedBytes > BYOK_QDRANT_DOWNLOAD_MAX_BYTES) {
          request.destroy();
          fail(
            new Error(
              `Download failed: exceeds ${BYOK_QDRANT_DOWNLOAD_MAX_BYTES} bytes.`
            )
          );
        }
      });
      file.on('error', fail);
      response.on('error', fail);
      file.on('finish', () => {
        if (settled) return;
        settled = true;
        file.close(() => resolve());
      });
      response.pipe(file);
    });
    request.setTimeout(BYOK_QDRANT_DOWNLOAD_TIMEOUT_MS, () => {
      request.destroy();
      reject(new Error('Download failed: timed out.'));
    });
    request.on('error', error => {
      removeFileBestEffort(destinationPath);
      reject(error);
    });
  });

const downloadArchive = (url, destinationPath) =>
  downloadArchiveToStream(url, destinationPath, BYOK_QDRANT_MAX_REDIRECTS);

// Windows 10+ ships bsdtar (handles zip); macOS bsdtar handles zip too;
// Linux GNU tar handles the .tar.gz release directly. execFile with array
// args — no shell interpolation of the paths (audit011026 B-ELEC-13).
const extractArchive = (archivePath, destinationFolder, kind) =>
  new Promise((resolve, reject) => {
    const args =
      kind === 'zip'
        ? ['-xf', archivePath, '-C', destinationFolder]
        : ['-xzf', archivePath, '-C', destinationFolder];
    childProcess.execFile(
      'tar',
      args,
      { cwd: destinationFolder, timeout: 120000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`tar ${args.join(' ')} failed: ${stderr || error}`));
        } else {
          resolve();
        }
      }
    );
  });

const getAvailablePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });

const makeSetupDeps = () => ({
  isHealthy,
  downloadArchive,
  extractArchive,
  binaryExists: binaryPath => {
    try {
      return fs.existsSync(binaryPath);
    } catch (error) {
      return false;
    }
  },
  writeTextFile: async (filePath, content) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  },
  readTextFile: async filePath => {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      return null;
    }
  },
  spawnQdrant: async (binaryPath, configPath) => {
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    const child = childProcess.spawn(
      binaryPath,
      [`--config-path`, configPath],
      {
        cwd: path.dirname(configPath),
        stdio: 'ignore',
        windowsHide: true,
      }
    );
    child.on('error', () => {});
    // Every child is tracked and killed on quit: overwriting a single
    // reference orphaned earlier spawns (audit011026 B-RAG-5).
    qdrantChildren.add(child);
    child.on('exit', () => {
      qdrantChildren.delete(child);
    });
    if (shuttingDown) {
      // A setup racing the quit path must not leave a child behind.
      try {
        child.kill();
      } catch (error) {
        // Already gone.
      }
    }
    return child.pid;
  },
  getAvailablePort,
  isPortAvailable: port =>
    new Promise(resolve => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => {
        probe.close(() => resolve(true));
      });
    }),
  killProcessByPid: pid =>
    new Promise(resolve => {
      try {
        process.kill(pid);
        resolve();
      } catch (error) {
        resolve();
      }
    }),
  deleteFile: async filePath => {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      // Best-effort cleanup.
    }
  },
});

const runSetup = async app => {
  // Serialized (audit011026 B-ELEC-9): two concurrent setup invokes raced
  // two downloads onto the same archive path and orphaned the first child.
  if (setupInFlight) return setupInFlight;
  setupInFlight = (async () => {
    try {
      const userDataPath = app.getPath('userData');
      const platform = core.getByokQdrantPlatform(
        process.platform,
        process.arch
      );
      if (!platform) {
        return {
          ok: false,
          stage: 'downloading',
          error: `Qdrant is not available for this platform (${
            process.platform
          }/${process.arch}).`,
        };
      }
      const paths = core.makeByokQdrantPaths(
        getQdrantFolder(userDataPath),
        core.getByokQdrantPlatform(process.platform, process.arch)
      );
      try {
        fs.mkdirSync(paths.installFolder, { recursive: true });
      } catch (error) {
        return {
          ok: false,
          stage: 'downloading',
          error: `The install folder could not be created: ${error.message}`,
        };
      }
      return await core.runByokQdrantSetup({
        platform,
        paths,
        deps: makeSetupDeps(),
        defaultBaseUrl: DEFAULT_QDRANT_BASE_URL,
      });
    } finally {
      setupInFlight = null;
    }
  })();
  return setupInFlight;
};

/**
 * Start the managed Qdrant with the app when it is already installed (the
 * permanent-indexing lifecycle): spawn + health-check only — never a
 * download, never an error into the app when absent (RAG quietly falls
 * back to the in-process index).
 */
const ensureStarted = async app => {
  try {
    const userDataPath = app.getPath('userData');
    const platform = core.getByokQdrantPlatform(process.platform, process.arch);
    if (!platform) return;
    const paths = core.makeByokQdrantPaths(
      getQdrantFolder(userDataPath),
      platform
    );
    if (!require('fs').existsSync(paths.binaryPath)) return;
    // Already healthy (e.g. a previous instance or a manual install)?
    const outcome = await core.runByokQdrantSetup({
      platform,
      paths,
      deps: makeSetupDeps(),
      defaultBaseUrl: DEFAULT_QDRANT_BASE_URL,
    });
    if (outcome.ok) lastKnownBaseUrl = outcome.baseUrl;
  } catch (error) {
    // Autostart is best-effort: the RAG tab's setup button reports errors.
  }
};

/** One JSON request over the loopback Qdrant REST API (the restore deps). */
const BYOK_QDRANT_REQUEST_TIMEOUT_MS = 30000;

// `timeoutMs` defaults to the health-check budget; the snapshot upload
// passes a much longer one (a tens-of-MB asset, and `?wait=true` blocks
// until Qdrant has downloaded AND recovered it — audit100226 RAG-3).
const requestJson = (
  baseUrl,
  method,
  requestPath,
  body,
  timeoutMs = BYOK_QDRANT_REQUEST_TIMEOUT_MS
) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request(
      `${baseUrl}${requestPath}`,
      {
        method,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            }
          : {},
      },
      response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (response.statusCode >= 400) {
            reject(
              new Error(
                `Qdrant ${method} ${requestPath}: ${
                  response.statusCode
                } ${text}`
              )
            );
            return;
          }
          try {
            resolve(text ? JSON.parse(text) : null);
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    // A wedged Qdrant must settle the IPC, not hang it forever
    // (audit011026 B-RAG-16).
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      // Marked so the restore can tell "we gave up waiting" from "Qdrant
      // refused": the first must NOT drop the collection, because the
      // server may still be importing into it (audit100226 RAG-3).
      const timeoutError = new Error(
        `Qdrant ${method} ${requestPath}: timed out after ${timeoutMs} ms.`
      );
      timeoutError.clientTimedOut = true;
      reject(timeoutError);
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });

const registerByokQdrant = (ipcMain, app) => {
  ipcMain.handle('byok-qdrant-setup', async () => {
    const outcome = await runSetup(app);
    if (outcome.ok) lastKnownBaseUrl = outcome.baseUrl;
    return outcome;
  });
  // Phase 14.4 (D14-3): the Qdrant branch of the prebuilt bundle — restore
  // the official collection snapshot from its release URL. The consent
  // (snapshot download + Qdrant binary when missing) ran in the UI first.
  ipcMain.handle('byok-qdrant-restore-snapshot', async (event, options) => {
    // Validated BEFORE anything is downloaded, dropped or fetched: the URL
    // comes from the renderer and Qdrant fetches it server-side, so an
    // unvalidated value let a caller make the local process request any URL
    // (audit100226 ELEC-17).
    if (!core.isAllowedByokQdrantSnapshotUrl(options && options.snapshotUrl)) {
      return {
        ok: false,
        stage: 'validating',
        error:
          'Refused: the snapshot URL is not the official GDevelop RAG release URL.',
      };
    }
    const setupOutcome = await runSetup(app);
    if (!setupOutcome.ok) return setupOutcome;
    lastKnownBaseUrl = setupOutcome.baseUrl;
    return core.runByokQdrantSnapshotRestore({
      baseUrl: setupOutcome.baseUrl,
      snapshotUrl: options.snapshotUrl,
      expectedDimensions: options.expectedDimensions,
      deps: {
        isHealthy,
        requestJson: (method, requestPath, body, requestTimeoutMs) =>
          requestJson(
            setupOutcome.baseUrl,
            method,
            requestPath,
            body,
            requestTimeoutMs
          ),
      },
    });
  });
  ipcMain.handle('byok-qdrant-status', async () => {
    if (lastKnownBaseUrl) {
      return {
        installed: true,
        healthy: await isHealthy(lastKnownBaseUrl),
        baseUrl: lastKnownBaseUrl,
      };
    }
    const userDataPath = app.getPath('userData');
    const paths = core.makeByokQdrantPaths(
      getQdrantFolder(userDataPath),
      core.getByokQdrantPlatform(process.platform, process.arch)
    );
    const installed = await Promise.resolve(
      require('fs').existsSync(paths.binaryPath)
    );
    return {
      installed,
      healthy: false,
      baseUrl: null,
    };
  });
  // Stop every managed child on quit (the app-start autostart is a status
  // check + spawn by this same module when the RAG tab enables it).
  app.on('before-quit', () => {
    shuttingDown = true;
    killByokQdrantChildren();
  });
};

module.exports = {
  BYOK_QDRANT_FOLDER,
  DEFAULT_QDRANT_BASE_URL,
  ensureStarted,
  registerByokQdrant,
  // The app-exit path skips 'before-quit' (app.exit terminates
  // immediately) — the CLI --run-command runner uses it, so the BYOK
  // children need an explicit stop there too (audit011026 B-ELEC-8).
  stopByokQdrantForExit: killByokQdrantChildren,
};
