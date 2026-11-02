// @flow
import {
  BYOK_PREVIEW_LOG_BUFFER_SIZE,
  createByokPreviewSession,
  makeByokPreviewLaunchOptions,
  reduceByokRuntimeDump,
  type ByokPreviewLauncher,
} from './ByokPreviewSession';

// A fake debugger server recording subscriptions — the lifecycle contract
// (start subscribes, stop unsubscribes, no dangling listeners). `sendMessage`
// records the targeted recipient and answers with `nextResponse` (echoing
// the messageId) through the registered callbacks.
const makeFakeDebuggerServer = () => {
  const registeredCallbacks: Array<any> = [];
  const sentMessages: Array<{| id: string, message: Object |}> = [];
  const fakeServer: any = {
    registeredCallbacks,
    sentMessages,
    nextResponse: { command: 'response', payload: {} },
    registerCallbacks: (callbacks: any) => {
      registeredCallbacks.push(callbacks);
      return () => {
        const index = registeredCallbacks.indexOf(callbacks);
        if (index !== -1) registeredCallbacks.splice(index, 1);
      };
    },
    sendMessageWithResponse: (jest.fn(): any),
    sendMessage: (jest.fn(): any).mockImplementation(
      (id: string, message: Object) => {
        sentMessages.push({ id, message });
        const response = {
          ...fakeServer.nextResponse,
          messageId: message.messageId,
        };
        for (const callbacks of registeredCallbacks) {
          callbacks.onHandleParsedMessage({
            id,
            parsedMessage: response,
          });
        }
      }
    ),
  };
  return fakeServer;
};

const makeFakeLauncher = (debuggerServer: any): ByokPreviewLauncher => ({
  launchPreview: (jest.fn(): any).mockResolvedValue(undefined),
  closePreview: jest.fn(),
  getPreviewDebuggerServer: () => debuggerServer,
});

const makeFakeLauncherWithCloseAll = (
  debuggerServer: any
): ByokPreviewLauncher => ({
  ...makeFakeLauncher(debuggerServer),
  closeAllPreviews: jest.fn(),
});

/** Simulate the preview connecting its debugger client. */
const emitConnectionOpened = (debuggerServer: any, id: string) => {
  for (const callbacks of debuggerServer.registeredCallbacks) {
    callbacks.onConnectionOpened({ id, debuggerIds: [id] });
  }
};

const emitConnectionClosed = (debuggerServer: any, id: string) => {
  for (const callbacks of debuggerServer.registeredCallbacks) {
    callbacks.onConnectionClosed({ id });
  }
};

/** Simulate the runtime pushing a message (no messageId). */
const emitPushedMessage = (
  debuggerServer: any,
  command: string,
  payload: Object
) => {
  for (const callbacks of debuggerServer.registeredCallbacks) {
    callbacks.onHandleParsedMessage({
      id: 'fake-preview',
      parsedMessage: { command, payload },
    });
  }
};

const emitLog = (debuggerServer: any, payload: Object) => {
  for (const callbacks of debuggerServer.registeredCallbacks) {
    callbacks.onHandleParsedMessage({
      id: 'fake-preview',
      parsedMessage: { command: 'console.log', payload },
    });
  }
};

const emitCrash = (debuggerServer: any, error: string) => {
  for (const callbacks of debuggerServer.registeredCallbacks) {
    callbacks.onHandleParsedMessage({
      id: 'fake-preview',
      parsedMessage: {
        command: 'game.crashed',
        payload: { error },
      },
    });
  }
};

describe('createByokPreviewSession', () => {
  it('starts a preview, subscribes before launching, and stops cleanly', async () => {
    const debuggerServer = makeFakeDebuggerServer();
    const launcher = makeFakeLauncher(debuggerServer);
    const session = createByokPreviewSession({
      getPreviewLauncher: () => launcher,
      getProject: () => ({ getFirstLayout: () => 'Scene 1' }),
    });

    const startResult = await session.start({});
    expect(startResult.success).toBe(true);
    expect(debuggerServer.registeredCallbacks.length).toBe(1);
    expect(launcher.launchPreview).toHaveBeenCalledTimes(1);
    expect(session.isRunning()).toBe(true);

    const stopResult = session.stop();
    expect(stopResult.success).toBe(true);
    expect(debuggerServer.registeredCallbacks.length).toBe(0);
    expect(launcher.closePreview).toHaveBeenCalledTimes(1);
    expect(session.isRunning()).toBe(false);
  });

  it('registers every callback the debugger server fan-out invokes (QA 2026-09-24 regression)', async () => {
    const debuggerServer = makeFakeDebuggerServer();
    const launcher = makeFakeLauncher(debuggerServer);
    const session = createByokPreviewSession({
      getPreviewLauncher: () => launcher,
      getProject: () => ({ getFirstLayout: () => 'Scene 1' }),
    });

    await session.start({});

    // LocalPreviewDebuggerServer calls each of these on every registered
    // subscriber — a missing callback throws "not a function" and, being
    // uncaught, blanks the whole editor.
    const callbacks = debuggerServer.registeredCallbacks[0];
    expect(typeof callbacks.onServerStateChanged).toBe('function');
    expect(typeof callbacks.onErrorReceived).toBe('function');
    expect(typeof callbacks.onConnectionErrored).toBe('function');
    expect(() => callbacks.onServerStateChanged()).not.toThrow();
    expect(() =>
      callbacks.onErrorReceived(new Error('server error'))
    ).not.toThrow();
    expect(() =>
      callbacks.onConnectionErrored({ id: 'x', errorMessage: 'boom' })
    ).not.toThrow();

    session.stop();
  });

  it('launches with the full PreviewOptions the launcher expects (QA 2026-09-24 regression)', async () => {
    const debuggerServer = makeFakeDebuggerServer();
    const launcher = makeFakeLauncher(debuggerServer);
    const project = { getFirstLayout: () => 'Scene 1' };
    const session = createByokPreviewSession({
      getPreviewLauncher: () => launcher,
      getProject: () => project,
    });

    await session.start({ sceneName: 'Forest' });

    expect(launcher.launchPreview).toHaveBeenCalledTimes(1);
    const options = (launcher.launchPreview: any).mock.calls[0][0];
    // LocalPreviewLauncher CALLS these two — with the pre-QA hand-rolled
    // options they were missing, and every start_preview failed with
    // "options.getIsMenuBarHiddenInPreview is not a function".
    expect(typeof options.getIsMenuBarHiddenInPreview).toBe('function');
    expect(typeof options.getIsAlwaysOnTopInPreview).toBe('function');
    expect(options.getIsMenuBarHiddenInPreview()).toBe(true);
    expect(options.getIsAlwaysOnTopInPreview()).toBe(false);
    expect(options.project).toBe(project);
    expect(options.sceneName).toBe('Forest');
    expect(options.numberOfWindows).toBe(1);
    expect(options.isForInGameEdition).toBe(false);
    expect(options.isForGameplayTest).toBe(false);
    expect(options.shouldGenerateScenesEventsCode).toBe(true);
    expect(options.captureOptions).toBe(null);
  });

  it('falls back to the first scene when no scene name is given', async () => {
    const debuggerServer = makeFakeDebuggerServer();
    const launcher = makeFakeLauncher(debuggerServer);
    const session = createByokPreviewSession({
      getPreviewLauncher: () => launcher,
      getProject: () => ({ getFirstLayout: () => 'Scene 1' }),
    });

    await session.start({});
    const options = (launcher.launchPreview: any).mock.calls[0][0];
    expect(options.sceneName).toBe('Scene 1');
  });

  it('builds launch options directly, honoring the preference overrides', () => {
    const options = makeByokPreviewLaunchOptions({
      project: { getFirstLayout: () => 'Scene 1' },
      sceneName: 'Forest',
      isMenuBarHiddenInPreview: false,
      isAlwaysOnTopInPreview: true,
    });
    expect(options.getIsMenuBarHiddenInPreview()).toBe(false);
    expect(options.getIsAlwaysOnTopInPreview()).toBe(true);
    expect(options.networkPreview).toBe(false);
    expect(options.hotReload).toBe(false);
    expect(options.fullLoadingScreen).toBe(false);
    expect(options.previewWindows).toBe(null);
  });

  it('refuses a second preview while one runs, and stopping twice fails', async () => {
    const debuggerServer = makeFakeDebuggerServer();
    const session = createByokPreviewSession({
      getPreviewLauncher: () => makeFakeLauncher(debuggerServer),
      getProject: () => ({ getFirstLayout: () => 'Scene 1' }),
    });

    await session.start({});
    const secondStart = await session.start({});
    expect(secondStart.success).toBe(false);
    expect(secondStart.message).toContain('already running');

    session.stop();
    const secondStop = session.stop();
    expect(secondStop.success).toBe(false);
  });

  it('fails actionably without a launcher or debugger server', async () => {
    const noLauncher = createByokPreviewSession({
      getPreviewLauncher: () => null,
      getProject: () => null,
    });
    const noLauncherResult = await noLauncher.start({});
    expect(noLauncherResult.success).toBe(false);
    expect(noLauncherResult.message).toContain('No preview launcher');

    const noDebugger = createByokPreviewSession({
      getPreviewLauncher: () => ({
        launchPreview: async () => {},
        getPreviewDebuggerServer: () => null,
      }),
      getProject: () => null,
    });
    const noDebuggerResult = await noDebugger.start({});
    expect(noDebuggerResult.success).toBe(false);
    expect(noDebuggerResult.message).toContain('debugger server');
  });

  it('buffers console logs, skips library warnings, and slices by index/level', async () => {
    const debuggerServer = makeFakeDebuggerServer();
    const session = createByokPreviewSession({
      getPreviewLauncher: () => makeFakeLauncher(debuggerServer),
      getProject: () => ({ getFirstLayout: () => 'Scene 1' }),
    });
    await session.start({});

    emitLog(debuggerServer, { message: 'hello', type: 'log', timestamp: 1 });
    emitLog(debuggerServer, {
      message: 'Electron Security Warning (bad)',
      type: 'warning',
      group: 'JavaScript',
      timestamp: 2,
    });
    emitLog(debuggerServer, { message: 'boom', type: 'error', timestamp: 3 });

    expect(session.getLogs({})).toHaveLength(2);
    expect(session.getLogs({ sinceIndex: 1 })).toHaveLength(1);
    expect(
      session.getLogs({ level: 'error' }).map(entry => entry.text)
    ).toEqual(['boom']);
  });

  it('caps the log ring buffer', async () => {
    const debuggerServer = makeFakeDebuggerServer();
    const session = createByokPreviewSession({
      getPreviewLauncher: () => makeFakeLauncher(debuggerServer),
      getProject: () => ({ getFirstLayout: () => 'Scene 1' }),
    });
    await session.start({});

    for (let index = 0; index < BYOK_PREVIEW_LOG_BUFFER_SIZE + 50; index++) {
      emitLog(debuggerServer, { message: `log ${index}`, type: 'log' });
    }
    expect(session.getLogs({}).length).toBe(BYOK_PREVIEW_LOG_BUFFER_SIZE);
  });

  it('captures crashes and error-level logs as new errors, consumed once', async () => {
    const debuggerServer = makeFakeDebuggerServer();
    const session = createByokPreviewSession({
      getPreviewLauncher: () => makeFakeLauncher(debuggerServer),
      getProject: () => ({ getFirstLayout: () => 'Scene 1' }),
    });
    await session.start({});

    emitLog(debuggerServer, { message: 'soft failure', type: 'error' });
    emitCrash(debuggerServer, 'TypeError: x is not a function');

    const errors = session.getNewErrors();
    expect(errors).toHaveLength(2);
    expect(errors[1]).toContain('TypeError');
    // Consumed on read.
    expect(session.getNewErrors()).toHaveLength(0);
  });

  it('reads the runtime state through a targeted refresh round-trip', async () => {
    const debuggerServer = makeFakeDebuggerServer();
    debuggerServer.nextResponse = {
      command: 'response',
      payload: {
        _variables: { Score: 10 },
        _sceneStack: {
          _stack: [
            {
              _name: 'Level 1',
              _instances: {
                items: {
                  Player: [{ name: 'Player', x: 123, y: 45, zOrder: 0 }],
                },
              },
              _variables: { Health: 5 },
            },
          ],
        },
      },
    };
    const session = createByokPreviewSession({
      getPreviewLauncher: () => makeFakeLauncher(debuggerServer),
      getProject: () => ({ getFirstLayout: () => 'Scene 1' }),
    });
    await session.start({});
    emitConnectionOpened(debuggerServer, 'preview-ws-1');

    const result = await session.inspectState();
    expect(result.success).toBe(true);
    const state = result.state;
    if (!state) throw new Error('expected a state');
    expect(state.scenes[0].name).toBe('Level 1');
    expect(state.scenes[0].instances.Player[0].x).toBe(123);
    expect(state.scenes[0].variables).toEqual({ Health: 5 });
    expect(state.globalVariables).toEqual({ Score: 10 });
    // Targeted: the refresh went to the session's own connection only.
    expect(debuggerServer.sentMessages).toHaveLength(1);
    expect(debuggerServer.sentMessages[0].id).toBe('preview-ws-1');
    expect(debuggerServer.sentMessages[0].message.command).toBe('refresh');
    expect(debuggerServer.sentMessages[0].message.messageId).toBeDefined();
  });

  it('refuses state reads without a running preview, and reports crashes', async () => {
    const debuggerServer = makeFakeDebuggerServer();
    const session = createByokPreviewSession({
      getPreviewLauncher: () => makeFakeLauncher(debuggerServer),
      getProject: () => ({ getFirstLayout: () => 'Scene 1' }),
    });

    const idle = await session.inspectState();
    expect(idle.success).toBe(false);

    await session.start({});
    emitCrash(debuggerServer, 'TypeError: crashed');
    const crashed = await session.inspectState();
    expect(crashed.success).toBe(false);
    expect(crashed.message).toContain('crashed');
  });
});

describe('reduceByokRuntimeDump', () => {
  it('reduces a defensive empty object to an empty state', () => {
    expect(reduceByokRuntimeDump(null)).toEqual({ scenes: [] });
    expect(reduceByokRuntimeDump({})).toEqual({
      scenes: [],
      globalVariables: {},
    });
  });
});

describe('createByokPreviewSession: the debugger channel (Phase 12)', () => {
  const makeStartedSession = async () => {
    const debuggerServer = makeFakeDebuggerServer();
    const session = createByokPreviewSession({
      getPreviewLauncher: () => makeFakeLauncher(debuggerServer),
      getProject: () => ({ getFirstLayout: () => 'Scene 1' }),
    });
    await session.start({});
    return { debuggerServer, session };
  };

  it('captures the debugger id of its own connection', async () => {
    const { debuggerServer, session } = await makeStartedSession();
    expect(session.getDebuggerState()).toEqual({
      connected: false,
      debuggerId: null,
    });

    emitConnectionOpened(debuggerServer, 'preview-ws-7');
    expect(session.getDebuggerState()).toEqual({
      connected: true,
      debuggerId: 'preview-ws-7',
    });

    emitConnectionClosed(debuggerServer, 'preview-ws-7');
    expect(session.getDebuggerState().connected).toBe(false);
  });

  it('sends targeted commands with a response correlation id', async () => {
    const { debuggerServer, session } = await makeStartedSession();
    emitConnectionOpened(debuggerServer, 'preview-ws-1');

    const response = await session.sendDebuggerCommand({
      command: 'pause',
    });
    expect(response.messageId).toBeDefined();
    expect(debuggerServer.sentMessages).toHaveLength(1);
    expect(debuggerServer.sentMessages[0].id).toBe('preview-ws-1');
    expect(debuggerServer.sentMessages[0].message.command).toBe('pause');
  });

  it('refuses commands before a connection is captured', async () => {
    const { session } = await makeStartedSession();
    await expect(
      session.sendDebuggerCommand({ command: 'pause' })
    ).rejects.toThrow('not connected');
  });

  it('fails pending work typed when the connection closes', async () => {
    const { debuggerServer, session } = await makeStartedSession();
    emitConnectionOpened(debuggerServer, 'preview-ws-1');
    // Make sendMessage silent so the request stays pending.
    (debuggerServer.sendMessage: any).mockImplementation(() => {});
    const pending = session.sendDebuggerCommand({ command: 'refresh' });
    emitConnectionClosed(debuggerServer, 'preview-ws-1');
    await expect(pending).rejects.toThrow('connection was closed');
  });

  it('resolves pushed messages from the buffer and from live pushes', async () => {
    const { debuggerServer, session } = await makeStartedSession();
    emitPushedMessage(debuggerServer, 'profiler.output', {
      framesAverageMeasures: [{ timeSpent: 12 }],
    });

    const buffered = await session.waitForPushedDebuggerMessage({
      command: 'profiler.output',
      timeoutMs: 100,
    });
    expect(buffered.framesAverageMeasures).toHaveLength(1);

    const livePromise = session.waitForPushedDebuggerMessage({
      command: 'profiler.output',
      timeoutMs: 1000,
    });
    emitPushedMessage(debuggerServer, 'profiler.output', {
      framesAverageMeasures: [{ timeSpent: 34 }],
    });
    const live = await livePromise;
    expect(live.framesAverageMeasures[0].timeSpent).toBe(34);

    await expect(
      session.waitForPushedDebuggerMessage({
        command: 'profiler.output',
        timeoutMs: 50,
      })
    ).rejects.toThrow('arrived within');
  });

  it('stop() prefers closeAllPreviews (the no-window-id quirk fix)', async () => {
    const debuggerServer = makeFakeDebuggerServer();
    const launcher = makeFakeLauncherWithCloseAll(debuggerServer);
    const session = createByokPreviewSession({
      getPreviewLauncher: () => launcher,
      getProject: () => ({ getFirstLayout: () => 'Scene 1' }),
    });
    await session.start({});
    emitConnectionOpened(debuggerServer, 'preview-ws-1');

    const stopResult = session.stop();
    expect(stopResult.success).toBe(true);
    expect(launcher.closeAllPreviews).toHaveBeenCalledTimes(1);
    // The legacy closePreview(windowId) path is NOT used when the working
    // one exists — it would close nothing.
    expect(launcher.closePreview).toHaveBeenCalledTimes(0);
    expect(session.getDebuggerState().connected).toBe(false);
  });
});

describe('createByokPreviewSession: the launch-window debugger binding (audit B-TOOL-11)', () => {
  // A launcher whose launchPreview resolves only when the test calls
  // resolveLaunch — that pending span IS the export window, during which
  // another preview's debugger client may connect.
  const makeControlledLauncher = (
    debuggerServer: any
  ): {| launcher: ByokPreviewLauncher, resolveLaunch: () => void |} => {
    let resolveLaunch: () => void = () => {};
    const launcher: ByokPreviewLauncher = {
      launchPreview: (jest.fn(): any).mockImplementation(
        () =>
          new Promise<void>(resolve => {
            resolveLaunch = resolve;
          })
      ),
      closePreview: jest.fn(),
      getPreviewDebuggerServer: () => debuggerServer,
    };
    return { launcher, resolveLaunch: () => resolveLaunch() };
  };

  const makeSession = (launcher: ByokPreviewLauncher) =>
    createByokPreviewSession({
      getPreviewLauncher: () => launcher,
      getProject: () => ({ getFirstLayout: () => 'Scene 1' }),
    });

  it('does not bind a connection opened before the launch resolves', async () => {
    const debuggerServer = makeFakeDebuggerServer();
    const { launcher, resolveLaunch } = makeControlledLauncher(debuggerServer);
    const session = makeSession(launcher);

    const startPromise = session.start({});
    // Another preview (the user's) connects while the export is running.
    emitConnectionOpened(debuggerServer, 'user-preview-ws');
    resolveLaunch();
    await startPromise;

    // The early connection was never bound: no debugger id, and a
    // debugger command has no connection to round-trip to.
    expect(session.getDebuggerState()).toEqual({
      connected: false,
      debuggerId: null,
    });
    await expect(
      session.sendDebuggerCommand({ command: 'pause', timeoutMs: 50 })
    ).rejects.toThrow('not connected');
  });

  it('binds the first connection opened after the launch resolves', async () => {
    const debuggerServer = makeFakeDebuggerServer();
    const { launcher, resolveLaunch } = makeControlledLauncher(debuggerServer);
    const session = makeSession(launcher);

    const startPromise = session.start({});
    resolveLaunch();
    await startPromise;
    emitConnectionOpened(debuggerServer, 'own-preview-ws');

    const response = await session.sendDebuggerCommand({ command: 'pause' });
    expect(response.messageId).toBeDefined();
    expect(debuggerServer.sentMessages).toHaveLength(1);
    expect(debuggerServer.sentMessages[0].id).toBe('own-preview-ws');
  });

  it('is not stolen by a user preview connecting during the launch window', async () => {
    const debuggerServer = makeFakeDebuggerServer();
    const { launcher, resolveLaunch } = makeControlledLauncher(debuggerServer);
    const session = makeSession(launcher);

    const startPromise = session.start({});
    // The user's preview connects first (during the export window), then
    // the session's own preview connects after the launch resolved.
    emitConnectionOpened(debuggerServer, 'user-preview-ws');
    resolveLaunch();
    await startPromise;
    emitConnectionOpened(debuggerServer, 'own-preview-ws');

    const response = await session.sendDebuggerCommand({ command: 'pause' });
    expect(response.messageId).toBeDefined();
    expect(debuggerServer.sentMessages).toHaveLength(1);
    // The command reaches the session's own connection, never the user's.
    expect(debuggerServer.sentMessages[0].id).toBe('own-preview-ws');
    expect(
      debuggerServer.sentMessages.filter(sent => sent.id === 'user-preview-ws')
    ).toHaveLength(0);
  });

  it('does not rebind on a late connection after stop() (launch gate reset)', async () => {
    const debuggerServer = makeFakeDebuggerServer();
    const { launcher, resolveLaunch } = makeControlledLauncher(debuggerServer);
    const session = makeSession(launcher);

    const startPromise = session.start({});
    resolveLaunch();
    await startPromise;
    emitConnectionOpened(debuggerServer, 'own-preview-ws');
    expect(session.getDebuggerState().connected).toBe(true);

    // Grab the callbacks before stop() unregisters them, so the late
    // connection reaches the session the way a server keeping a stale
    // reference would (after stop() the server itself has none left).
    const callbacks = debuggerServer.registeredCallbacks[0];
    session.stop();
    callbacks.onConnectionOpened({ id: 'late-preview-ws' });
    expect(session.getDebuggerState()).toEqual({
      connected: false,
      debuggerId: null,
    });
  });
});
