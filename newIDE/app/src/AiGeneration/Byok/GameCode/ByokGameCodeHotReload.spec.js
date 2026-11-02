// @flow

/**
 * The game-code hot reload, driven entirely through injected fakes: no WASM
 * export and no disk. The seam under test is the real `reloadByokGameCode`
 * flow — listing → carrier reconciliation → preview guard → hard-reload
 * fallbacks → read → export → merge → send → pushed logs.
 */

import {
  buildByokGameCodeScriptFiles,
  mergeByokGameCodeScriptFiles,
  reloadByokGameCode,
  BYOK_GAME_CODE_HOT_RELOAD_LOGS_TIMEOUT_MS,
} from './ByokGameCodeHotReload';
import { getByokGameCodeContentHash } from './ByokGameCodeManifest';
import {
  getByokGameCodeFolderName,
  orderByokGameCodeRelativePaths,
} from './ByokGameCodeCore';

// $FlowFixMe[cannot-resolve-module] - a Node builtin, used by this spec only.
const nodePath = require('path');

const makeFakeProject = () => ({
  getName: () => 'My Game',
  getProjectFile: () => nodePath.join('projects', 'my-game.json'),
  getFirstLayout: () => 'Scene1',
});

const fileNameOf = (relativePath: string): string =>
  relativePath.slice(relativePath.lastIndexOf('/') + 1);

const makeFakeStore = (
  initialFiles: { [relativePath: string]: string },
  listFilesError?: string
) => {
  const files: Map<string, string> = new Map(
    Object.keys(initialFiles).map(relativePath => [
      relativePath,
      initialFiles[relativePath],
    ])
  );
  const store = {
    listFiles: async () => {
      if (listFilesError) return { ok: false, error: listFilesError };
      return {
        ok: true,
        data: orderByokGameCodeRelativePaths(Array.from(files.keys())).map(
          relativePath => ({ relativePath, sizeBytes: 10 })
        ),
      };
    },
    readFile: async (
      projectFile: string,
      folderName: string,
      relativePath: string
    ) => {
      if (!files.has(relativePath)) {
        return { ok: false, error: `"${relativePath}" does not exist.` };
      }
      return { ok: true, data: files.get(relativePath) };
    },
    writeFile: async (
      projectFile: string,
      folderName: string,
      relativePath: string,
      content: string
    ) => {
      const created = !files.has(relativePath);
      files.set(relativePath, content);
      return { ok: true, data: { relativePath, created } };
    },
    deleteFile: async (
      projectFile: string,
      folderName: string,
      relativePath: string
    ) => {
      files.delete(relativePath);
      return { ok: true, data: { relativePath, deleted: true } };
    },
    renameFile: async () => ({ ok: false, error: 'Not needed by this fake.' }),
  };
  return { store, files };
};

/**
 * A carrier fake that reconciles like the real one does on the paths that
 * matter here: the load order, the exported script names (flat, with
 * overrides) and the resources dropped for files that disappeared.
 */
const makeFakeEnsureCarrier = (
  previousResourcePaths: Array<string>,
  scriptNameOverrides?: { [relativePath: string]: string | null }
) => {
  const ensureCarrier = jest.fn(
    (reconcileOptions: {
      project: any,
      gameCodeFolderName: string,
      relativePaths: Array<string>,
    }) => {
      const { relativePaths } = reconcileOptions;
      const orderedRelativePaths = orderByokGameCodeRelativePaths(
        relativePaths
      );
      const removedResourceNames = previousResourcePaths
        .filter(path => !orderedRelativePaths.includes(path))
        .map(path => `My GameCode/${path}`);
      const exportedScriptNames: {
        [relativePath: string]: string | null,
      } = {};
      for (const relativePath of orderedRelativePaths) {
        exportedScriptNames[relativePath] =
          scriptNameOverrides && relativePath in scriptNameOverrides
            ? scriptNameOverrides[relativePath]
            : fileNameOf(relativePath);
      }
      return {
        didModifyProject: removedResourceNames.length > 0,
        createdExtension: false,
        addedResourceNames: ([]: Array<string>),
        removedResourceNames,
        orderedRelativePaths,
        exportedScriptNames,
        errors: ([]: Array<string>),
      };
    }
  );
  return ensureCarrier;
};

type HarnessOptions = {|
  files?: { [relativePath: string]: string },
  previousResourcePaths?: Array<string>,
  scriptNameOverrides?: { [relativePath: string]: string | null },
  isRunning?: boolean,
  connected?: boolean,
  runtimeGameOptions?: Object,
  pushedLogs?: Array<Object>,
  sendError?: Error,
  waitError?: Error,
  listFilesError?: string,
|};

const makeFakeSession = (sessionOptions?: HarnessOptions) => {
  const sent = [];
  const waits = [];
  const isRunning = !sessionOptions || sessionOptions.isRunning !== false;
  const connected = !sessionOptions || sessionOptions.connected !== false;
  const session = {
    isRunning: () => isRunning,
    getDebuggerState: () => ({
      connected,
      debuggerId: connected ? 'debugger-1' : null,
    }),
    sendDebuggerCommand: async (request: Object) => {
      sent.push(request);
      if (sessionOptions && sessionOptions.sendError) {
        throw sessionOptions.sendError;
      }
      return {};
    },
    waitForPushedDebuggerMessage: async (waitOptions: Object) => {
      waits.push(waitOptions);
      if (sessionOptions && sessionOptions.waitError) {
        throw sessionOptions.waitError;
      }
      return { logs: (sessionOptions && sessionOptions.pushedLogs) || [] };
    },
  };
  return { session: (session: any), sent, waits };
};

const makeFakeRunExport = (runtimeGameOptions: Object) => {
  const calls = [];
  const runExport = async (exportRequest: Object) => {
    calls.push(exportRequest);
    return {
      projectData: { firstLayout: 'Scene1', layouts: [] },
      runtimeGameOptions,
    };
  };
  return { runExport, calls };
};

const makeDefaultRuntimeGameOptions = () => ({
  shouldReloadLibraries: true,
  shouldGenerateScenesEventsCode: true,
  scriptFiles: [{ path: 'libs.js', hash: 100 }],
  initialRuntimeGameStatus: { isInGameEdition: false },
});

const makeHarness = (harnessOptions?: HarnessOptions) => {
  const filesByPath = (harnessOptions && harnessOptions.files) || {
    'main.js': 'GameCode.main = 1;',
    'character/spawn.js': 'GameCode.character.spawn = 2;',
  };
  const fakeStore = makeFakeStore(
    filesByPath,
    harnessOptions && harnessOptions.listFilesError
  );
  const ensureCarrier = makeFakeEnsureCarrier(
    (harnessOptions && harnessOptions.previousResourcePaths) ||
      Object.keys(filesByPath),
    harnessOptions && harnessOptions.scriptNameOverrides
  );
  const fakeSession = makeFakeSession(harnessOptions);
  const fakeRunExport = makeFakeRunExport(
    (harnessOptions && harnessOptions.runtimeGameOptions) ||
      makeDefaultRuntimeGameOptions()
  );

  const reload = (extraOptions?: Object) =>
    reloadByokGameCode({
      project: makeFakeProject(),
      store: (fakeStore.store: any),
      ensureCarrier: (ensureCarrier: any),
      getSession: () => fakeSession.session,
      runExport: fakeRunExport.runExport,
      resolveGdjsRoot: async () => 'fake/gdjs',
      now: () => 1000,
      ...extraOptions,
    });

  return {
    reload,
    files: fakeStore.files,
    ensureCarrier,
    sent: fakeSession.sent,
    waits: fakeSession.waits,
    exportCalls: fakeRunExport.calls,
  };
};

describe('buildByokGameCodeScriptFiles', () => {
  it('maps each file to its exported name and the exporter hash', () => {
    const content = 'GameCode.main = 1;';
    const scriptFiles = buildByokGameCodeScriptFiles([
      { relativePath: 'main.js', scriptName: 'main.js', content },
    ]);
    expect(scriptFiles).toEqual([
      { path: 'main.js', hash: getByokGameCodeContentHash(content) },
    ]);
  });

  it('hashes contents differently, so an edit changes exactly its entry', () => {
    const [before] = buildByokGameCodeScriptFiles([
      { relativePath: 'main.js', scriptName: 'main.js', content: 'a = 1;' },
    ]);
    const [after] = buildByokGameCodeScriptFiles([
      { relativePath: 'main.js', scriptName: 'main.js', content: 'a = 2;' },
    ]);
    expect(before.hash).not.toBe(after.hash);
    expect(before.path).toBe(after.path);
  });

  it('skips files whose exported name is unknowable', () => {
    const scriptFiles = buildByokGameCodeScriptFiles([
      { relativePath: 'main.js', scriptName: null, content: 'a = 1;' },
      { relativePath: 'other.js', scriptName: 'other.js', content: 'b = 2;' },
    ]);
    expect(scriptFiles).toEqual([
      { path: 'other.js', hash: getByokGameCodeContentHash('b = 2;') },
    ]);
  });
});

describe('mergeByokGameCodeScriptFiles', () => {
  it('appends the game-code entries after the engine ones', () => {
    const merged = mergeByokGameCodeScriptFiles(
      { scriptFiles: [{ path: 'libs.js', hash: 100 }] },
      [{ path: 'main.js', hash: 7 }]
    );
    expect(merged.scriptFiles).toEqual([
      { path: 'libs.js', hash: 100 },
      { path: 'main.js', hash: 7 },
    ]);
  });

  it('creates the scriptFiles list when the export had none', () => {
    const merged = mergeByokGameCodeScriptFiles(
      { shouldReloadLibraries: true },
      [{ path: 'main.js', hash: 7 }]
    );
    expect(merged.scriptFiles).toEqual([{ path: 'main.js', hash: 7 }]);
  });

  it('forces initialRuntimeGameStatus.isInGameEdition to false', () => {
    const forced = mergeByokGameCodeScriptFiles(
      { initialRuntimeGameStatus: { isInGameEdition: true, sceneName: 'S' } },
      []
    );
    expect(forced.initialRuntimeGameStatus).toEqual({
      isInGameEdition: false,
      sceneName: 'S',
    });
    const created = mergeByokGameCodeScriptFiles({}, []);
    expect(created.initialRuntimeGameStatus).toEqual({
      isInGameEdition: false,
    });
  });
});

describe('reloadByokGameCode', () => {
  it('reconciles the carrier with the store listing, in load order', async () => {
    const harness = makeHarness();
    await harness.reload();

    expect(harness.ensureCarrier).toHaveBeenCalledTimes(1);
    expect(harness.ensureCarrier.mock.calls[0][0].relativePaths).toEqual([
      'main.js',
      'character/spawn.js',
    ]);
    expect(harness.ensureCarrier.mock.calls[0][0].gameCodeFolderName).toBe(
      getByokGameCodeFolderName('My Game')
    );
  });

  it('reloads with a hotReload whose list differs in exactly the edited entry', async () => {
    const harness = makeHarness();
    const firstReport = await harness.reload();
    expect(firstReport.success).toBe(true);

    const firstScriptFiles =
      harness.sent[0].payload.runtimeGameOptions.scriptFiles;

    harness.files.set('main.js', 'GameCode.main = 11;');
    const secondReport = await harness.reload();
    expect(secondReport.success).toBe(true);

    const secondScriptFiles =
      harness.sent[1].payload.runtimeGameOptions.scriptFiles;

    // Exactly one entry differs, and it is the edited file with the new
    // content hash — the engine will reload it as "changed".
    const differingEntries = secondScriptFiles.filter(
      (entry, index) =>
        JSON.stringify(entry) !== JSON.stringify(firstScriptFiles[index])
    );
    expect(differingEntries).toEqual([
      {
        path: 'main.js',
        hash: getByokGameCodeContentHash('GameCode.main = 11;'),
      },
    ]);
    // The engine files pass through untouched (same hashes as exported).
    expect(secondScriptFiles[0]).toEqual({ path: 'libs.js', hash: 100 });
  });

  it('adds a NEW file to the list, so the engine takes its "added" branch', async () => {
    const harness = makeHarness();
    await harness.reload();
    const firstScriptFiles =
      harness.sent[0].payload.runtimeGameOptions.scriptFiles;

    harness.files.set('enemy/grunt.js', 'GameCode.enemy.grunt = 3;');
    await harness.reload();
    const secondScriptFiles =
      harness.sent[1].payload.runtimeGameOptions.scriptFiles;

    const addedEntries = secondScriptFiles.filter(
      entry =>
        !firstScriptFiles.some(firstEntry => firstEntry.path === entry.path)
    );
    expect(addedEntries).toEqual([
      {
        path: 'grunt.js',
        hash: getByokGameCodeContentHash('GameCode.enemy.grunt = 3;'),
      },
    ]);
  });

  it('sends a hardReload when the caller asks for the deletion path', async () => {
    const harness = makeHarness();
    const report = await harness.reload({ hardReload: true });

    expect(report.success).toBe(true);
    expect(report.message).toContain('hard reload');
    expect(harness.sent).toEqual([
      { command: 'hardReload', payload: undefined },
    ]);
    expect(harness.exportCalls).toEqual([]);
    expect(harness.waits).toEqual([]);
  });

  it('sends a hardReload when a file was deleted (D15-13)', async () => {
    const harness = makeHarness();
    await harness.reload();

    harness.files.delete('character/spawn.js');
    const report = await harness.reload();

    expect(report.success).toBe(true);
    expect(harness.sent[1]).toEqual({
      command: 'hardReload',
      payload: undefined,
    });
    // Only the first reload re-exported; the deletion path stopped before
    // any export.
    expect(harness.exportCalls).toHaveLength(1);
  });

  it('falls back to a hardReload when an exported name is unknowable', async () => {
    const harness = makeHarness({
      scriptNameOverrides: { 'character/spawn.js': null },
    });
    const report = await harness.reload();

    expect(report.success).toBe(true);
    expect(harness.sent).toEqual([
      { command: 'hardReload', payload: undefined },
    ]);
    expect(harness.exportCalls).toEqual([]);
  });

  it('answers an actionable failure when no preview is running', async () => {
    const harness = makeHarness({ isRunning: false });
    const report = await harness.reload();

    expect(report.success).toBe(false);
    expect(report.message).toContain('No preview is running');
    expect(report.message).toContain('start_preview');
    expect(harness.sent).toEqual([]);
    expect(harness.exportCalls).toEqual([]);
  });

  it('refuses to send while the debugger is not connected', async () => {
    const harness = makeHarness({ connected: false });
    const report = await harness.reload();

    expect(report.success).toBe(false);
    expect(report.message).toContain('not connected');
    expect(harness.sent).toEqual([]);
  });

  it('reports a failing export instead of throwing', async () => {
    const harness = makeHarness();
    const failingRunExport = async () => {
      throw new Error('boom');
    };
    const report = await harness.reload({
      runExport: (failingRunExport: any),
    });

    expect(report.success).toBe(false);
    expect(report.message).toContain('boom');
    expect(harness.sent).toEqual([]);
  });

  it('reports an unreadable game code folder instead of throwing', async () => {
    const harness = makeHarness({ listFilesError: 'the folder is gone' });
    const report = await harness.reload();

    expect(report.success).toBe(false);
    expect(report.message).toContain('the folder is gone');
    expect(harness.ensureCarrier).not.toHaveBeenCalled();
    expect(harness.sent).toEqual([]);
  });

  it('sends the hotReload payload and awaits the pushed hotReloader.logs', async () => {
    const harness = makeHarness({
      pushedLogs: [
        { kind: 'info', message: 'Reloading main.js because it was changed.' },
      ],
    });
    const report = await harness.reload();

    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0].command).toBe('hotReload');
    expect(harness.sent[0].payload.shouldReloadResources).toBe(false);
    expect(harness.sent[0].payload.projectData).toEqual({
      firstLayout: 'Scene1',
      layouts: [],
    });
    expect(
      harness.sent[0].payload.runtimeGameOptions.initialRuntimeGameStatus
    ).toEqual({ isInGameEdition: false });
    expect(harness.exportCalls[0].sceneName).toBe('Scene1');
    expect(harness.waits).toEqual([
      {
        command: 'hotReloader.logs',
        timeoutMs: BYOK_GAME_CODE_HOT_RELOAD_LOGS_TIMEOUT_MS,
      },
    ]);
    expect(report.success).toBe(true);
    expect(report.message).toContain('Reloading main.js');
  });

  it('reports the hotReloader logs as unsuccessful when one is an error', async () => {
    const harness = makeHarness({
      pushedLogs: [{ kind: 'error', message: 'SyntaxError: main.js exploded' }],
    });
    const report = await harness.reload();

    expect(report.success).toBe(false);
    expect(report.message).toContain('main.js exploded');
  });

  it('mentions the send failure when the reload is never acknowledged', async () => {
    const harness = makeHarness({
      sendError: new Error('the debugger hung up'),
      waitError: new Error('No "hotReloader.logs" message arrived'),
    });
    const report = await harness.reload();

    expect(report.success).toBe(false);
    expect(report.message).toContain('never reported back');
    expect(report.message).toContain('the debugger hung up');
  });
});
