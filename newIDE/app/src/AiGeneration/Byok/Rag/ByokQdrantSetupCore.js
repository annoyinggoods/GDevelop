/**
 * The Qdrant permanent-indexing setup core (Phase 13.8, D13-1): the pure
 * state machine behind the "Set up permanent indexing with Qdrant" button.
 * Plain-CJS on purpose (the ByokMcpStdioAdapterCore pattern): required by
 * the Electron main (electron-app/app/ByokQdrant.js) and by the Jest
 * suite — never by the Flow-checked renderer app. The lifecycle mirrors
 * the MCP server: spawn -> health check -> ready; the child is killed on
 * quit; loopback only (D13-9).
 */

const getByokQdrantPlatform = (processPlatform, processArch) => {
  if (processPlatform === 'win32' && processArch === 'x64') {
    return 'windows-x64';
  }
  if (processPlatform === 'linux' && processArch === 'x64') {
    return 'linux-x64';
  }
  if (processPlatform === 'darwin' && processArch === 'x64') {
    return 'macos-x64';
  }
  return null;
};

/**
 * The official Qdrant release artifact of a platform (GitHub releases; the
 * QA machine already runs qdrant-x86_64-pc-windows-msvc, so the artifact
 * shape is known).
 */
const getByokQdrantReleaseInfo = platform => {
  switch (platform) {
    case 'windows-x64':
      return {
        artifactName: 'qdrant-x86_64-pc-windows-msvc.zip',
        archiveKind: 'zip',
      };
    case 'linux-x64':
      return {
        artifactName: 'qdrant-x86_64-unknown-linux-gnu.tar.gz',
        archiveKind: 'tar.gz',
      };
    case 'macos-x64':
      return {
        artifactName: 'qdrant-x86_64-apple-darwin.tar.gz',
        archiveKind: 'tar.gz',
      };
    default:
      return null;
  }
};

const BYOK_QDRANT_DOWNLOAD_URL_BASE =
  'https://github.com/qdrant/qdrant/releases/latest/download';

/** The loopback-only config file content of the managed instance. */
const buildByokQdrantConfigYaml = port =>
  [
    '# Managed by GDevelop (BYOK RAG) - loopback only, no external interface.',
    'service:',
    '  host: 127.0.0.1',
    `  http_port: ${port}`,
    'storage:',
    '  storage_path: qdrant-storage',
  ].join('\n');

const BYOK_QDRANT_ENDPOINT_FILE_NAME = 'gdevelop-qdrant-endpoint.json';

/** The standard paths of a managed install under a root folder. */
const makeByokQdrantPaths = (rootFolder, platform) => ({
  installFolder: rootFolder,
  binaryPath: `${rootFolder}/${
    platform === 'windows-x64' ? 'qdrant.exe' : 'qdrant'
  }`,
  configPath: `${rootFolder}/gdevelop-qdrant.yaml`,
  archivePath: `${rootFolder}/qdrant-release-archive`,
  endpointFilePath: `${rootFolder}/${BYOK_QDRANT_ENDPOINT_FILE_NAME}`,
});

const readByokQdrantEndpoint = async (deps, endpointFilePath) => {
  try {
    const content = await deps.readTextFile(endpointFilePath);
    if (!content) return null;
    const parsed = JSON.parse(content);
    if (typeof parsed.port !== 'number') return null;
    return {
      port: parsed.port,
      pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
      startedAt: String(parsed.startedAt || ''),
    };
  } catch (error) {
    return null;
  }
};

/** Poll the health endpoint for up to ~15 s (the binary boots fast). */
const waitForByokQdrantHealth = async (
  deps,
  baseUrl,
  timeoutMs = 15000,
  pollIntervalMs = 500
) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    if (await deps.isHealthy(baseUrl)) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  return false;
};

/**
 * Run the whole setup, idempotently:
 * 1. a healthy existing instance (any port we know of, or the default) is
 *    used as-is ("use existing instance" - no download at all);
 * 2. an already-installed binary is only (re)configured and started;
 * 3. otherwise the release is downloaded (the consent UI ran before this)
 *    and extracted, then configured and started.
 * Every step can fail cleanly: the outcome names the stage, the caller
 * falls back to the in-process index with the error message.
 */
const runByokQdrantSetup = async options => {
  const paths = options.paths;
  const deps = options.deps;
  const report = options.onStage || (() => {});
  const healthCheckTimeoutMs = options.healthCheckTimeoutMs || 15000;

  // 1. An already-healthy instance wins: never install over one.
  report('checking-existing');
  const endpoint = await readByokQdrantEndpoint(deps, paths.endpointFilePath);
  const existingUrls = [
    endpoint ? `http://127.0.0.1:${endpoint.port}` : null,
    options.defaultBaseUrl,
  ].filter(Boolean);
  for (const baseUrl of existingUrls) {
    // eslint-disable-next-line no-await-in-loop
    if (await deps.isHealthy(baseUrl)) {
      return { ok: true, mode: 'used-existing', baseUrl };
    }
  }

  // 2. Download + extract when the binary is missing (consent ran first).
  if (!deps.binaryExists(paths.binaryPath)) {
    const release = getByokQdrantReleaseInfo(options.platform);
    if (!release) {
      return {
        ok: false,
        stage: 'downloading',
        error: `No Qdrant release is known for platform "${options.platform}".`,
      };
    }
    try {
      report('downloading');
      await deps.downloadArchive(
        `${BYOK_QDRANT_DOWNLOAD_URL_BASE}/${release.artifactName}`,
        paths.archivePath
      );
      report('extracting');
      await deps.extractArchive(
        paths.archivePath,
        paths.installFolder,
        release.archiveKind
      );
      await deps.deleteFile(paths.archivePath);
    } catch (error) {
      return {
        ok: false,
        stage: 'downloading',
        error: `The Qdrant download or extraction failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (!deps.binaryExists(paths.binaryPath)) {
      return {
        ok: false,
        stage: 'extracting',
        error:
          'The downloaded archive did not contain the expected Qdrant binary.',
      };
    }
  }

  // 3. Configure, start, health-check.
  try {
    report('configuring');
    // Prefer the PREVIOUS endpoint's port when it is free (audit011026
    // B-RAG-4): the renderer persists qdrantBaseUrl only on explicit setup
    // or restore clicks, so drawing a fresh random port on every launch
    // left the preferences pointing at a dead port after each restart.
    let port = null;
    if (
      endpoint &&
      typeof endpoint.port === 'number' &&
      deps.isPortAvailable &&
      (await deps.isPortAvailable(endpoint.port))
    ) {
      port = endpoint.port;
    } else {
      port = await deps.getAvailablePort();
    }
    await deps.writeTextFile(paths.configPath, buildByokQdrantConfigYaml(port));
    report('starting');
    const pid = await deps.spawnQdrant(paths.binaryPath, paths.configPath);
    await deps.writeTextFile(
      paths.endpointFilePath,
      JSON.stringify({
        port,
        pid,
        startedAt: new Date().toISOString(),
      })
    );
    report('health-check');
    const baseUrl = `http://127.0.0.1:${port}`;
    const isUp = await waitForByokQdrantHealth(
      deps,
      baseUrl,
      healthCheckTimeoutMs
    );
    if (!isUp) {
      // A failed health check must not leak the just-spawned child holding
      // the port and the storage dir (audit011026 B-RAG-5) — kill it and
      // remove the stale endpoint file.
      if (deps.killProcessByPid) {
        try {
          await deps.killProcessByPid(pid);
        } catch (error) {
          // Best-effort: an already-dead child is fine.
        }
      }
      await deps.deleteFile(paths.endpointFilePath);
      return {
        ok: false,
        stage: 'health-check',
        error: 'Qdrant started but did not answer its health check in time.',
      };
    }
    report('ready');
    return { ok: true, mode: 'installed', baseUrl, port };
  } catch (error) {
    return {
      ok: false,
      stage: 'starting',
      error: `Qdrant could not be started: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
};

/**
 * Restore a prebuilt collection snapshot into a healthy Qdrant (Phase
 * 14.4, D14-3): the Qdrant branch of the prebuilt bundle. Qdrant pulls the
 * official snapshot itself from the release URL (its native
 * snapshots/upload API accepts a `url` body — no multipart, the
 * megabytes never pass through the app), the existing collection is
 * replaced, and the point count + vector dimensions are verified before
 * the caller flips the backend. Pure state machine over injected deps
 * (fake HTTP in the tests, loopback http in the Electron main).
 */
const runByokQdrantSnapshotRestore = async options => {
  const report = options.onStage || (() => {});
  const collection = options.collection || 'gdevelop-byok';
  const verifyTimeoutMs = options.verifyTimeoutMs || 120000;
  const pollIntervalMs = options.pollIntervalMs || 1000;

  // FIRST, before anything is dropped or fetched: the URL comes from the
  // renderer and Qdrant fetches it itself (audit100226 ELEC-17).
  if (!isAllowedByokQdrantSnapshotUrl(options.snapshotUrl)) {
    return {
      ok: false,
      stage: 'validating',
      error:
        'Refused: the snapshot URL is not the official GDevelop RAG release URL.',
    };
  }

  report('health-check');
  if (!(await options.deps.isHealthy(options.baseUrl))) {
    return {
      ok: false,
      stage: 'health-check',
      error: 'Qdrant is not running — set it up first, then restore.',
    };
  }

  // A leftover half-restored collection poisons later rebuilds (upserts
  // fail against its config) — every failure path below drops it
  // (audit011026 B-RAG-17).
  const dropCollectionBestEffort = async () => {
    try {
      await options.deps.requestJson('DELETE', `/collections/${collection}`);
    } catch (error) {
      // Nothing to drop, or Qdrant is unreachable — the next restore/setup
      // recreates a clean collection either way.
    }
  };

  // A snapshot restore must land on a clean slate: an existing collection
  // with a different config makes the upload fail halfway.
  report('dropping-collection');
  try {
    await options.deps.requestJson('DELETE', `/collections/${collection}`);
  } catch (error) {
    // A missing collection is the expected "nothing to drop".
  }

  report('uploading');
  try {
    await options.deps.requestJson(
      'POST',
      `/collections/${collection}/snapshots/upload?wait=true`,
      { url: options.snapshotUrl },
      // A snapshot asset is tens of MB and `?wait=true` blocks until
      // Qdrant has downloaded AND recovered it — the 30 s health-check
      // timeout is far too short for it (audit100226 RAG-3).
      options.uploadTimeoutMs || 300000
    );
  } catch (error) {
    // A CLIENT-side timeout means Qdrant may still be importing: dropping
    // the collection then deletes data out from under a server-side
    // restore in progress, and a later retry re-creates it anyway
    // (audit100226 RAG-3).
    if (error && error.clientTimedOut) {
      return {
        ok: false,
        stage: 'uploading',
        clientTimedOut: true,
        error:
          'The snapshot restore did not finish before the local timeout — Qdrant may still be importing it in the background. Check the collection before retrying.',
      };
    }
    await dropCollectionBestEffort();
    return {
      ok: false,
      stage: 'uploading',
      error: `The snapshot restore failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  report('verifying');
  const startedAt = Date.now();
  let pointsCount = 0;
  let vectorSize = 0;
  while (Date.now() - startedAt < verifyTimeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const info = await options.deps
      .requestJson('GET', `/collections/${collection}`)
      .catch(() => null);
    const result = info && info.result ? info.result : null;
    pointsCount =
      result && result.points_count ? Number(result.points_count) : 0;
    const vectors =
      result && result.config && result.config.params
        ? result.config.params.vectors
        : null;
    vectorSize = vectors && vectors.size ? Number(vectors.size) : 0;
    if (pointsCount > 0) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  if (pointsCount === 0) {
    await dropCollectionBestEffort();
    return {
      ok: false,
      stage: 'verifying',
      error: 'The restored collection is empty — the snapshot did not land.',
    };
  }
  if (options.expectedDimensions && vectorSize !== options.expectedDimensions) {
    await dropCollectionBestEffort();
    return {
      ok: false,
      stage: 'verifying',
      error: `The restored collection has ${vectorSize}-dim vectors, expected ${
        options.expectedDimensions
      } — pick the bundle of your embedder.`,
    };
  }

  report('ready');
  return { ok: true, baseUrl: options.baseUrl, collection, pointsCount };
};

/**
 * Where the RAG snapshot assets live. The app only ever fetches them from
 * the GDevelop release it ships (BYOK_RAG_BUNDLE_REPO in
 * Rag/ByokRagTypes.js), over https from github.com — the same host the
 * Qdrant binary is pinned to above.
 */
const BYOK_QDRANT_SNAPSHOT_URL_PREFIX =
  '/mrmflis-hub/GDevelop/releases/download/';

/**
 * Only the official GDevelop release snapshot URL may be handed to Qdrant.
 *
 * The snapshot URL arrives from the RENDERER and Qdrant fetches it itself,
 * so an unvalidated value made the local process issue a request to any
 * URL a caller chose (including cloud metadata endpoints) — and the
 * restore drops the existing collection BEFORE the upload, so a junk URL
 * destroyed the current index too (audit100226 ELEC-17).
 */
const isAllowedByokQdrantSnapshotUrl = url => {
  if (typeof url !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    return false;
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.hostname === 'github.com' &&
    parsed.pathname.startsWith(BYOK_QDRANT_SNAPSHOT_URL_PREFIX)
  );
};

/**
 * Where the prebuilt RAG bundle lives, and the only host the app ever asks
 * GitHub's API about. Kept here (a plain-CJS core the Electron main process
 * requires directly) so the SAME rule is enforced on both sides of the IPC
 * boundary: the renderer builds the URLs, and the main process is the one
 * that actually performs the request.
 */
const BYOK_RAG_BUNDLE_API_HOST = 'api.github.com';
const BYOK_RAG_BUNDLE_DOWNLOAD_HOST = 'github.com';
const BYOK_RAG_BUNDLE_REPO_PATH_PREFIX = '/repos/mrmflis-hub/GDevelop';

/**
 * Only the two official GitHub URLs of the GDevelop release repository may
 * be fetched for a RAG bundle: the releases API (bundle info) and a release
 * asset (bundle download).
 *
 * Both URLs arrive from the RENDERER and the main process dereferences them,
 * so an unvalidated value turned the bundle-info/download channels into a
 * fetch-on-demand for any https URL a caller chose (audit100226 ELEC-22).
 * The download is sha256-verified and capped, so nothing was written
 * unverified — but the app would still issue the request, with the user's
 * network position, to a host it never intended to reach.
 *
 * Redirect targets need no allow-listing: the fetch follows them from an
 * already-validated origin (release assets redirect to
 * objects.githubusercontent.com), and the fetch is what follows them.
 */
const isAllowedByokRagBundleApiUrl = url => {
  if (typeof url !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    return false;
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.hostname === BYOK_RAG_BUNDLE_API_HOST &&
    parsed.pathname.startsWith(BYOK_RAG_BUNDLE_REPO_PATH_PREFIX)
  );
};

const isAllowedByokRagBundleDownloadUrl = url => {
  if (typeof url !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    return false;
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.hostname === BYOK_RAG_BUNDLE_DOWNLOAD_HOST &&
    parsed.pathname.startsWith('/mrmflis-hub/GDevelop/releases/download/')
  );
};

module.exports = {
  BYOK_QDRANT_DOWNLOAD_URL_BASE,
  isAllowedByokQdrantSnapshotUrl,
  isAllowedByokRagBundleApiUrl,
  isAllowedByokRagBundleDownloadUrl,
  BYOK_QDRANT_ENDPOINT_FILE_NAME,
  buildByokQdrantConfigYaml,
  getByokQdrantPlatform,
  getByokQdrantReleaseInfo,
  makeByokQdrantPaths,
  runByokQdrantSetup,
  runByokQdrantSnapshotRestore,
  waitForByokQdrantHealth,
};
