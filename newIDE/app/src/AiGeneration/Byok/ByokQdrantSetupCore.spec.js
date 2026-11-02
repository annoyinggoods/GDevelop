// @flow
/* eslint-disable no-restricted-globals */
const {
  BYOK_QDRANT_ENDPOINT_FILE_NAME,
  buildByokQdrantConfigYaml,
  getByokQdrantPlatform,
  getByokQdrantReleaseInfo,
  isAllowedByokQdrantSnapshotUrl,
  isAllowedByokRagBundleApiUrl,
  isAllowedByokRagBundleDownloadUrl,
  makeByokQdrantPaths,
  runByokQdrantSetup,
  runByokQdrantSnapshotRestore,
  waitForByokQdrantHealth,
} = require('./Rag/ByokQdrantSetupCore');

const makeDeps = (overrides: Object = {}) => ({
  isHealthy: async () => false,
  downloadArchive: jest.fn(async () => {}),
  extractArchive: jest.fn(async () => {}),
  binaryExists: jest.fn(() => false),
  writeTextFile: jest.fn(async () => {}),
  readTextFile: jest.fn(async () => null),
  spawnQdrant: jest.fn(async () => 4242),
  getAvailablePort: jest.fn(async () => 7333),
  deleteFile: jest.fn(async () => {}),
  ...overrides,
});

const makePaths = () =>
  makeByokQdrantPaths('C:/Users/Test/AppData/GDevelop 5/qdrant');

describe('getByokQdrantPlatform / getByokQdrantReleaseInfo', () => {
  it('maps the known platforms to their release artifacts', () => {
    expect(getByokQdrantPlatform('win32', 'x64')).toBe('windows-x64');
    expect(getByokQdrantPlatform('linux', 'x64')).toBe('linux-x64');
    expect(getByokQdrantPlatform('darwin', 'x64')).toBe('macos-x64');
    expect(getByokQdrantPlatform('win32', 'arm64')).toBe(null);

    expect(getByokQdrantReleaseInfo('windows-x64').artifactName).toBe(
      'qdrant-x86_64-pc-windows-msvc.zip'
    );
    expect(getByokQdrantReleaseInfo('linux-x64').archiveKind).toBe('tar.gz');
    expect(getByokQdrantReleaseInfo('unknown')).toBe(null);
  });
});

describe('buildByokQdrantConfigYaml', () => {
  it('binds Qdrant to loopback on the given port', () => {
    const config = buildByokQdrantConfigYaml(7333);
    expect(config).toContain('host: 127.0.0.1');
    expect(config).toContain('http_port: 7333');
    expect(config).not.toContain('0.0.0.0');
  });
});

describe('runByokQdrantSetup', () => {
  it('uses a healthy existing instance instead of installing', async () => {
    const deps = makeDeps({ isHealthy: async () => true });
    const outcome = await runByokQdrantSetup({
      platform: 'windows-x64',
      paths: makePaths(),
      deps,
      defaultBaseUrl: 'http://127.0.0.1:6333',
    });
    expect(outcome).toEqual({
      ok: true,
      mode: 'used-existing',
      baseUrl: 'http://127.0.0.1:6333',
    });
    expect(deps.downloadArchive).not.toHaveBeenCalled();
  });

  it('honors the discovery file port before the default URL', async () => {
    const deps = makeDeps({
      readTextFile: async () =>
        JSON.stringify({ port: 7100, pid: 1, startedAt: 'x' }),
      isHealthy: async baseUrl => baseUrl === 'http://127.0.0.1:7100',
    });
    const outcome = await runByokQdrantSetup({
      platform: 'windows-x64',
      paths: makePaths(),
      deps,
      defaultBaseUrl: 'http://127.0.0.1:6333',
    });
    expect(outcome.mode).toBe('used-existing');
    expect(outcome.baseUrl).toBe('http://127.0.0.1:7100');
  });

  it('downloads, extracts, configures, spawns and health-checks a fresh install', async () => {
    const stages: Array<string> = [];
    let healthyAfterStart = false;
    let binaryPresent = false;
    const deps = makeDeps({
      isHealthy: async () => healthyAfterStart,
      binaryExists: () => binaryPresent,
      extractArchive: jest.fn(async () => {
        binaryPresent = true;
      }),
      spawnQdrant: jest.fn(async () => {
        healthyAfterStart = true;
        return 99;
      }),
    });
    const paths = makePaths();
    const outcome = await runByokQdrantSetup({
      platform: 'windows-x64',
      paths,
      deps,
      defaultBaseUrl: 'http://127.0.0.1:6333',
      onStage: stage => stages.push(stage),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.mode).toBe('installed');
      expect(outcome.port).toBe(7333);
      expect(outcome.baseUrl).toBe('http://127.0.0.1:7333');
    }
    expect(deps.downloadArchive).toHaveBeenCalledWith(
      expect.stringContaining('qdrant-x86_64-pc-windows-msvc.zip'),
      paths.archivePath
    );
    expect(deps.extractArchive).toHaveBeenCalledWith(
      paths.archivePath,
      paths.installFolder,
      'zip'
    );
    expect(deps.deleteFile).toHaveBeenCalledWith(paths.archivePath);
    expect(deps.spawnQdrant).toHaveBeenCalledWith(
      paths.binaryPath,
      paths.configPath
    );
    expect(deps.writeTextFile).toHaveBeenCalledWith(
      paths.endpointFilePath,
      expect.stringContaining('"port":7333')
    );
    expect(stages[0]).toBe('checking-existing');
    expect(stages[stages.length - 1]).toBe('ready');
  });

  it('skips the download when the binary is already installed (idempotency)', async () => {
    let healthyAfterStart = false;
    const deps = makeDeps({
      binaryExists: () => true,
      isHealthy: async () => healthyAfterStart,
      spawnQdrant: jest.fn(async () => {
        healthyAfterStart = true;
        return 7;
      }),
    });
    const outcome = await runByokQdrantSetup({
      platform: 'windows-x64',
      paths: makePaths(),
      deps,
      defaultBaseUrl: 'http://127.0.0.1:6333',
    });
    expect(outcome.ok).toBe(true);
    expect(deps.downloadArchive).not.toHaveBeenCalled();
    expect(deps.extractArchive).not.toHaveBeenCalled();
  });

  it('fails cleanly on a download error (the fallback path)', async () => {
    const deps = makeDeps({
      downloadArchive: jest.fn(async () => {
        throw new Error('offline');
      }),
    });
    const outcome = await runByokQdrantSetup({
      platform: 'windows-x64',
      paths: makePaths(),
      deps,
      defaultBaseUrl: 'http://127.0.0.1:6333',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.stage).toBe('downloading');
      expect(outcome.error).toContain('offline');
    }
  });

  it('fails cleanly when the health check never passes', async () => {
    const deps = makeDeps({
      isHealthy: async () => false,
      binaryExists: () => true,
    });
    const outcome = await runByokQdrantSetup({
      platform: 'windows-x64',
      paths: makePaths(),
      deps,
      defaultBaseUrl: 'http://127.0.0.1:6333',
      healthCheckTimeoutMs: 50,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.stage).toBe('health-check');
  });
});

describe('waitForByokQdrantHealth', () => {
  it('stops polling once healthy and respects the timeout', async () => {
    const deps = makeDeps();
    expect(await waitForByokQdrantHealth(deps, 'http://x', 10, 1)).toBe(false);
    let calls = 0;
    const turningHealthy = makeDeps({
      isHealthy: async () => {
        calls += 1;
        return calls >= 2;
      },
    });
    expect(
      await waitForByokQdrantHealth(turningHealthy, 'http://x', 1000, 1)
    ).toBe(true);
    expect(calls).toBe(2);
  });
});

describe('makeByokQdrantPaths', () => {
  it('builds the standard install paths', () => {
    const paths = makeByokQdrantPaths('C:/root/qdrant', 'windows-x64');
    expect(paths.binaryPath).toContain('qdrant.exe');
    expect(paths.configPath).toContain('gdevelop-qdrant.yaml');
    expect(paths.endpointFilePath).toContain(BYOK_QDRANT_ENDPOINT_FILE_NAME);
  });
});

describe('runByokQdrantSnapshotRestore (Phase 14.4, D14-3)', () => {
  const makeRestoreDeps = (requests: Array<any>, responses: Object) => ({
    isHealthy: async () => true,
    requestJson: jest.fn(async (method: string, path: string, body?: any) => {
      requests.push({ method, path, body });
      if (responses[path]) return responses[path];
      return { result: true };
    }),
  });

  it('drops, uploads from the URL, verifies the points, and succeeds', async () => {
    const requests: Array<any> = [];
    const deps = makeRestoreDeps(requests, {
      '/collections/gdevelop-byok': {
        result: {
          points_count: 2052,
          config: { params: { vectors: { size: 384 } } },
        },
      },
    });
    const stages = [];
    const outcome = await runByokQdrantSnapshotRestore({
      baseUrl: 'http://127.0.0.1:6333',
      snapshotUrl:
        'https://github.com/mrmflis-hub/GDevelop/releases/download/v3/snapshot.snap',
      expectedDimensions: 384,
      deps,
      onStage: stage => stages.push(stage),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.pointsCount).toBe(2052);
    expect(stages).toEqual([
      'health-check',
      'dropping-collection',
      'uploading',
      'verifying',
      'ready',
    ]);
    // The collection is dropped first, then Qdrant pulls the snapshot URL.
    const deleteIndex = requests.findIndex(
      request => request.method === 'DELETE'
    );
    const uploadIndex = requests.findIndex(
      request => request.method === 'POST' && request.path.includes('upload')
    );
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(uploadIndex).toBeGreaterThan(deleteIndex);
    const upload = requests[uploadIndex];
    expect(upload.body).toEqual({
      url:
        'https://github.com/mrmflis-hub/GDevelop/releases/download/v3/snapshot.snap',
    });
  });

  it('refuses to run against an unhealthy Qdrant', async () => {
    const requests: Array<any> = [];
    const outcome = await runByokQdrantSnapshotRestore({
      baseUrl: 'http://127.0.0.1:6333',
      snapshotUrl:
        'https://github.com/mrmflis-hub/GDevelop/releases/download/v3/snapshot.snap',
      expectedDimensions: 384,
      deps: {
        isHealthy: async () => false,
        requestJson: jest.fn(async () => {
          throw new Error('should not be called');
        }),
      },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.stage).toBe('health-check');
      expect(outcome.error).toContain('not running');
    }
    expect(requests).toHaveLength(0);
  });

  it('fails cleanly when the upload itself errors', async () => {
    const outcome = await runByokQdrantSnapshotRestore({
      baseUrl: 'http://127.0.0.1:6333',
      snapshotUrl:
        'https://github.com/mrmflis-hub/GDevelop/releases/download/v3/snapshot.snap',
      expectedDimensions: 384,
      deps: {
        isHealthy: async () => true,
        requestJson: jest.fn(async (method, path) => {
          if (method === 'POST') throw new Error('HTTP 500 boom');
          return { result: true };
        }),
      },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.stage).toBe('uploading');
      expect(outcome.error).toContain('boom');
    }
  });

  it('fails when the restored collection stays empty (verifying)', async () => {
    const outcome = await runByokQdrantSnapshotRestore({
      baseUrl: 'http://127.0.0.1:6333',
      snapshotUrl:
        'https://github.com/mrmflis-hub/GDevelop/releases/download/v3/snapshot.snap',
      expectedDimensions: 384,
      verifyTimeoutMs: 5,
      pollIntervalMs: 1,
      deps: makeRestoreDeps([], {
        '/collections/gdevelop-byok': { result: { points_count: 0 } },
      }),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.stage).toBe('verifying');
      expect(outcome.error).toContain('empty');
    }
  });

  it('fails when the vector dimensions do not match the embedder', async () => {
    const outcome = await runByokQdrantSnapshotRestore({
      baseUrl: 'http://127.0.0.1:6333',
      snapshotUrl:
        'https://github.com/mrmflis-hub/GDevelop/releases/download/v3/snapshot.snap',
      expectedDimensions: 384,
      deps: makeRestoreDeps([], {
        '/collections/gdevelop-byok': {
          result: {
            points_count: 10,
            config: { params: { vectors: { size: 768 } } },
          },
        },
      }),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.stage).toBe('verifying');
      expect(outcome.error).toContain('768');
    }
  });
});

describe('isAllowedByokQdrantSnapshotUrl (ELEC-17)', () => {
  const allowed =
    'https://github.com/mrmflis-hub/GDevelop/releases/download/v3/byok-rag.json';

  it('accepts the official GDevelop release asset', () => {
    expect(isAllowedByokQdrantSnapshotUrl(allowed)).toBe(true);
  });

  it('refuses http, foreign hosts, cloud metadata and non-string values', () => {
    expect(
      isAllowedByokQdrantSnapshotUrl(allowed.replace('https:', 'http:'))
    ).toBe(false);
    expect(
      isAllowedByokQdrantSnapshotUrl(
        'https://evil.example.com/mrmflis-hub/GDevelop/releases/download/x.json'
      )
    ).toBe(false);
    expect(
      isAllowedByokQdrantSnapshotUrl('http://169.254.169.254/latest/meta-data')
    ).toBe(false);
    expect(
      isAllowedByokQdrantSnapshotUrl(
        'https://github.com/other/repo/releases/download/x.json'
      )
    ).toBe(false);
    expect(isAllowedByokQdrantSnapshotUrl('not a url')).toBe(false);
    expect(isAllowedByokQdrantSnapshotUrl(null)).toBe(false);
    expect(isAllowedByokQdrantSnapshotUrl(undefined)).toBe(false);
  });
});

describe('runByokQdrantSnapshotRestore: refuses a hostile URL (ELEC-17)', () => {
  it('refuses before any drop or fetch happens', async () => {
    const calls: Array<Object> = [];
    const result = await runByokQdrantSnapshotRestore({
      baseUrl: 'http://127.0.0.1:6333',
      snapshotUrl: 'http://169.254.169.254/latest/meta-data',
      deps: {
        isHealthy: async () => {
          calls.push({ method: 'isHealthy' });
          return true;
        },
        requestJson: async (method: string, requestPath: string) => {
          calls.push({ method, requestPath });
          return {};
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('validating');
    // Nothing was dropped and nothing was fetched.
    expect(calls).toEqual([]);
  });
});

describe('runByokQdrantSnapshotRestore: a client timeout keeps the collection (RAG-3)', () => {
  it('does not drop the collection when the client gave up first', async () => {
    const calls: Array<Object> = [];
    const timedOutError: any = new Error(
      'The request timed out after 300000 ms'
    );
    timedOutError.clientTimedOut = true;
    const result = await runByokQdrantSnapshotRestore({
      baseUrl: 'http://127.0.0.1:6333',
      snapshotUrl:
        'https://github.com/mrmflis-hub/GDevelop/releases/download/v3/x.json',
      deps: {
        isHealthy: async () => true,
        requestJson: async (method: string, requestPath: string) => {
          calls.push({ method, requestPath });
          if (requestPath.includes('snapshots/upload')) throw timedOutError;
          return { result: { points_count: 0 } };
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.clientTimedOut).toBe(true);
    // Exactly ONE delete: the pre-upload one the restore always does. The
    // failure path used to run a SECOND drop, deleting data out from under
    // a server-side import still in progress (audit100226 RAG-3).
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
  });
});

describe('the prebuilt-bundle URL allowlist (audit100226 ELEC-22)', () => {
  const allowedApiUrl =
    'https://api.github.com/repos/mrmflis-hub/GDevelop/releases';
  const allowedDownloadUrl =
    'https://github.com/mrmflis-hub/GDevelop/releases/download/v3/byok-rag-bundle.json';

  it('accepts the two official GitHub URLs the renderer builds', () => {
    // The renderer builds these two from its own tested constants
    // (makeByokRagBundleReleasesApiUrl, and the release asset URL); the
    // main process re-checks them before dereferencing.
    expect(isAllowedByokRagBundleApiUrl(allowedApiUrl)).toBe(true);
    expect(isAllowedByokRagBundleDownloadUrl(allowedDownloadUrl)).toBe(true);
  });

  it('refuses http, foreign hosts, cloud metadata and non-string values', () => {
    for (const isAllowed of [
      isAllowedByokRagBundleApiUrl,
      isAllowedByokRagBundleDownloadUrl,
    ]) {
      expect(isAllowed(allowedApiUrl.replace('https:', 'http:'))).toBe(false);
      expect(isAllowed('https://evil.example.com/whatever.json')).toBe(false);
      expect(isAllowed('http://169.254.169.254/latest/meta-data')).toBe(false);
      expect(isAllowed('https://github.com/other/repo/releases/x')).toBe(false);
      expect(isAllowed('not a url')).toBe(false);
      expect(isAllowed(null)).toBe(false);
      expect(isAllowed(undefined)).toBe(false);
      expect(isAllowed(42)).toBe(false);
    }
  });

  it('does not let an API URL pass as a download URL (or the reverse)', () => {
    // The two channels fetch different things; mixing them would let the
    // releases API answer a download request (and vice versa).
    expect(isAllowedByokRagBundleApiUrl(allowedDownloadUrl)).toBe(false);
    expect(isAllowedByokRagBundleDownloadUrl(allowedApiUrl)).toBe(false);
  });
});
