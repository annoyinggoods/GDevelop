// @flow
import {
  DEFAULT_FORK_ASSET_BUILD_SETTINGS,
  type ForkAssetBuildSettings,
} from './ForkAssetBuildSettings';
import {
  FORK_ASSET_OPTIMIZE_APPLY_CHANNEL,
  FORK_ASSET_OPTIMIZE_CAPABILITIES_CHANNEL,
  createDefaultForkAssetOptimizerDeps,
  formatForkAssetBytes,
  formatForkAssetOptimizationReport,
  listForkAssetFiles,
  probeForkAssetEncoderCapabilities,
  runForkAssetOptimization,
  type ForkAssetOptimizerDeps,
} from './ForkAssetOptimizerPort';

const ROOT = 'out';

/** A flat-path fake of the export folder (relative path -> size in bytes). */
const makeFakeFs = (filesByRelativePath: { [string]: number }) => ({
  readdirSync: (directory: string) => {
    const prefix =
      directory === ROOT ? '' : directory.slice(ROOT.length + 1) + '/';
    const names: Set<string> = new Set();
    for (const relativePath of Object.keys(filesByRelativePath)) {
      if (prefix && !relativePath.startsWith(prefix)) continue;
      const rest = relativePath.slice(prefix.length);
      const firstSegment = rest.split('/')[0];
      if (firstSegment) names.add(firstSegment);
    }
    return [...names];
  },
  statSync: (absolutePath: string) => {
    const relative =
      absolutePath === ROOT ? '' : absolutePath.slice(ROOT.length + 1);
    if (relative in filesByRelativePath) {
      return {
        size: filesByRelativePath[relative],
        isDirectory: () => false,
        isFile: () => true,
      };
    }
    return { size: 0, isDirectory: () => true, isFile: () => false };
  },
});

const fakePath = {
  join: (first: string, second: string) =>
    `${first.replace(/\/+$/, '')}/${second}`,
};

const makeDeps = (
  filesByRelativePath: { [string]: number },
  invoke: (channel: string, payload: any) => Promise<any>
): ForkAssetOptimizerDeps => ({
  fs: makeFakeFs(filesByRelativePath),
  path: fakePath,
  invoke,
});

const okCapabilities = async () => ({ images: true, audio: true });

const enabledSettings = (
  partial?: Partial<ForkAssetBuildSettings>
): ForkAssetBuildSettings => ({
  ...DEFAULT_FORK_ASSET_BUILD_SETTINGS,
  enabled: true,
  ...(partial || {}),
});

describe('listForkAssetFiles', () => {
  it('lists files flat and recurses into folders with a relative path', () => {
    const files = listForkAssetFiles({
      folderPath: ROOT,
      fs: makeFakeFs({
        'hero.png': 100,
        'notes.txt': 5,
        'sub/icon.png': 200,
        'sub/deep/x.jpg': 300,
      }),
      path: fakePath,
    });
    const paths = files.map(file => file.relativePath).sort();
    expect(paths).toEqual([
      'hero.png',
      'notes.txt',
      'sub/deep/x.jpg',
      'sub/icon.png',
    ]);
    const hero = files.find(file => file.relativePath === 'hero.png');
    expect(hero).toEqual({
      relativePath: 'hero.png',
      extension: '.png',
      sizeBytes: 100,
    });
  });

  it('returns an empty listing when the folder cannot be read', () => {
    const files = listForkAssetFiles({
      folderPath: ROOT,
      fs: {
        readdirSync: () => {
          throw new Error('EACCES');
        },
      },
      path: fakePath,
    });
    expect(files).toEqual([]);
  });
});

describe('probeForkAssetEncoderCapabilities', () => {
  it('reads the capabilities off the probe channel', async () => {
    const deps = makeDeps({}, async channel => {
      expect(channel).toBe(FORK_ASSET_OPTIMIZE_CAPABILITIES_CHANNEL);
      return { images: true, audio: false };
    });
    expect(await probeForkAssetEncoderCapabilities(deps)).toEqual({
      images: true,
      audio: false,
    });
  });

  it('answers "no encoders" when the probe fails or is malformed', async () => {
    const rejected = makeDeps({}, async () => {
      throw new Error('the main process is gone');
    });
    expect(await probeForkAssetEncoderCapabilities(rejected)).toEqual({
      images: false,
      audio: false,
    });
    const malformed = makeDeps({}, async () => 'nonsense');
    expect(await probeForkAssetEncoderCapabilities(malformed)).toEqual({
      images: false,
      audio: false,
    });
  });
});

describe('runForkAssetOptimization', () => {
  it('lists, plans, invokes the applier and reports the byte deltas', async () => {
    const invoked: Array<Object> = [];
    const deps = makeDeps(
      { 'hero.png': 200000, 'notes.txt': 500 },
      async (channel, payload) => {
        expect(channel).toBe(FORK_ASSET_OPTIMIZE_APPLY_CHANNEL);
        invoked.push(payload);
        return [
          {
            relativePath: 'hero.png',
            bytesBefore: 200000,
            bytesAfter: 120000,
            error: null,
          },
        ];
      }
    );
    deps.capabilities = await okCapabilities();

    const report = await runForkAssetOptimization({
      folderPath: ROOT,
      settings: enabledSettings(),
      deps,
    });

    expect(invoked).toHaveLength(1);
    expect(invoked[0].folderPath).toBe(ROOT);
    // Only the planned (non-skipped) files reach the applier — and the plan
    // entry carries the transform the pure policy chose, not an absolute path.
    expect(invoked[0].entries).toEqual([
      {
        relativePath: 'hero.png',
        kind: 'image',
        transform: 'png',
        options: { compressionLevel: 9, effort: 10, palette: false },
      },
    ]);
    expect(report.ranOptimization).toBe(true);
    expect(report.error).toBeNull();
    expect(report.summary.optimizedCount).toBe(1);
    expect(report.summary.savedBytes).toBe(80000);
    expect(report.summary.totalBytesBefore).toBe(200000);
    expect(report.summary.totalBytesAfter).toBe(120000);
    expect(report.skipped).toEqual([
      {
        relativePath: 'notes.txt',
        reason: expect.stringContaining('Unsupported extension'),
        reasonCode: 'unsupported-extension',
      },
    ]);
  });

  it('degrades every planned file to unchanged when the applier IPC fails', async () => {
    const deps = makeDeps({ 'hero.png': 200000 }, async () => {
      throw new Error('no handler registered');
    });
    deps.capabilities = await okCapabilities();

    const report = await runForkAssetOptimization({
      folderPath: ROOT,
      settings: enabledSettings(),
      deps,
    });

    // The run still completes and reports honestly (D16-7).
    expect(report.ranOptimization).toBe(true);
    expect(report.files).toHaveLength(1);
    expect(report.files[0].bytesBefore).toBe(200000);
    expect(report.files[0].bytesAfter).toBe(200000);
    expect(report.files[0].error).toContain('could not run');
    expect(report.summary.failedCount).toBe(1);
    expect(report.summary.savedBytes).toBe(0);
  });

  it('degrades one file, not the run, when the applier reports a per-file error', async () => {
    const deps = makeDeps({ 'a.png': 10000, 'b.png': 10000 }, async () => [
      {
        relativePath: 'a.png',
        bytesBefore: 10000,
        bytesAfter: 6000,
        error: null,
      },
      {
        relativePath: 'b.png',
        bytesBefore: 10000,
        bytesAfter: 10000,
        error: 'locked file',
      },
    ]);
    deps.capabilities = await okCapabilities();

    const report = await runForkAssetOptimization({
      folderPath: ROOT,
      settings: enabledSettings(),
      deps,
    });
    expect(report.summary.optimizedCount).toBe(1);
    expect(report.summary.failedCount).toBe(1);
    expect(report.summary.savedBytes).toBe(4000);
    const failed: any = report.files.find(
      file => file.relativePath === 'b.png'
    );
    expect(failed.error).toBe('locked file');
    expect(failed.bytesAfter).toBe(10000);
  });

  it('treats a missing applier answer for a planned file as unchanged', async () => {
    const deps = makeDeps({ 'a.png': 10000 }, async () => []);
    deps.capabilities = await okCapabilities();
    const report = await runForkAssetOptimization({
      folderPath: ROOT,
      settings: enabledSettings(),
      deps,
    });
    expect(report.files).toHaveLength(1);
    expect(report.files[0].error).toContain('no result');
    expect(report.files[0].bytesAfter).toBe(10000);
  });

  it('never invokes the applier when nothing is planned', async () => {
    let invoked = 0;
    const deps = makeDeps({ 'notes.txt': 10 }, async () => {
      invoked += 1;
      return [];
    });
    deps.capabilities = await okCapabilities();
    const report = await runForkAssetOptimization({
      folderPath: ROOT,
      settings: enabledSettings(),
      deps,
    });
    expect(invoked).toBe(0);
    expect(report.ranOptimization).toBe(true);
    expect(report.files).toEqual([]);
    expect(report.skipped).toHaveLength(1);
  });

  it('reports a whole-run failure without throwing', async () => {
    const deps: ForkAssetOptimizerDeps = {
      fs: makeFakeFs({ 'hero.png': 10000 }),
      path: {
        join: () => {
          throw new Error('the path module refused');
        },
      },
      invoke: okCapabilities,
      capabilities: { images: true, audio: true },
    };
    const report = await runForkAssetOptimization({
      folderPath: ROOT,
      settings: enabledSettings(),
      deps,
    });
    expect(report.ranOptimization).toBe(false);
    expect(report.error).toContain('refused');
    expect(report.summary.savedBytes).toBe(0);
  });
});

describe('formatForkAssetBytes / formatForkAssetOptimizationReport', () => {
  it('formats bytes at a human scale', () => {
    expect(formatForkAssetBytes(0)).toBe('0 B');
    expect(formatForkAssetBytes(512)).toBe('512 B');
    expect(formatForkAssetBytes(2048)).toBe('2.0 KB');
    expect(formatForkAssetBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });

  it('summarizes a clean run, naming the failures and the skips', async () => {
    const deps = makeDeps(
      { 'a.png': 10000, 'b.png': 10000, 'notes.txt': 1 },
      async () => [
        {
          relativePath: 'a.png',
          bytesBefore: 10000,
          bytesAfter: 4000,
          error: null,
        },
        {
          relativePath: 'b.png',
          bytesBefore: 10000,
          bytesAfter: 10000,
          error: 'boom',
        },
      ]
    );
    deps.capabilities = await okCapabilities();
    const report = await runForkAssetOptimization({
      folderPath: ROOT,
      settings: enabledSettings(),
      deps,
    });
    const text = formatForkAssetOptimizationReport(report);
    expect(text).toContain('1 file(s) re-encoded');
    expect(text).toContain('could not be optimized');
    expect(text).toContain('1 file(s) skipped');
  });

  it('states the reason of a skipped run', () => {
    const text = formatForkAssetOptimizationReport({
      folderPath: ROOT,
      ranOptimization: false,
      error: 'boom',
      summary: {
        totalBytesBefore: 0,
        totalBytesAfter: 0,
        savedBytes: 0,
        optimizedCount: 0,
        failedCount: 0,
        largestSavings: [],
      },
      files: [],
      skipped: [],
    });
    expect(text).toContain('skipped: boom');
  });
});

describe('createDefaultForkAssetOptimizerDeps', () => {
  it('never throws outside the desktop app (it returns null or the deps)', () => {
    const deps = createDefaultForkAssetOptimizerDeps();
    if (deps) {
      expect(typeof deps.invoke).toBe('function');
      expect(deps.fs).toBeTruthy();
      expect(deps.path).toBeTruthy();
    } else {
      expect(deps).toBeNull();
    }
  });
});
