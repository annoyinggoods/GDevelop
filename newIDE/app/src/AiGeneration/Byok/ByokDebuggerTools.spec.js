// @flow
import { getByokDebuggerTools } from './ByokDebuggerTools';
import {
  getOrCreateByokPreviewSession,
  resetByokPreviewSessionForTests,
  getByokPreviewHasCrashed,
} from './ByokRuntimeTools';
import type { ByokExtraTool } from './ByokExtraTools';

/**
 * The debugger/profiler tools drive the preview session's TARGETED debugger
 * channel. The fixtures reuse the fake debugger-server pattern of
 * ByokPreviewSession.spec.js: sendMessage answers through the registered
 * callbacks (echoing the messageId), pushes are emitted by hand.
 */

const makeFakeDebuggerServer = () => {
  const registeredCallbacks: Array<any> = [];
  const sentMessages: Array<{| id: string, message: Object |}> = [];
  const fakeServer: any = {
    registeredCallbacks,
    sentMessages,
    responsesByCommand: { getStatus: { paused: false }, refresh: {} },
    registerCallbacks: (callbacks: any) => {
      registeredCallbacks.push(callbacks);
      return () => {
        const index = registeredCallbacks.indexOf(callbacks);
        if (index !== -1) registeredCallbacks.splice(index, 1);
      };
    },
    sendMessage: ((jest.fn(): any): any).mockImplementation(
      (id: string, message: Object) => {
        sentMessages.push({ id, message });
        const payload =
          fakeServer.responsesByCommand[message.command] === undefined
            ? {}
            : fakeServer.responsesByCommand[message.command];
        for (const callbacks of registeredCallbacks) {
          callbacks.onHandleParsedMessage({
            id,
            parsedMessage: {
              command: 'response',
              payload,
              messageId: message.messageId,
            },
          });
        }
      }
    ),
  };
  return fakeServer;
};

const makeRuntimeDeps = (debuggerServer: any): any => ({
  getProject: () => ({ getFirstLayout: () => 'Scene 1' }),
  captureSceneCanvas: () => null,
  invokePreviewCapture: async () => ({ ok: false, error: 'no electron' }),
  getPreviewLauncher: () => ({
    launchPreview: ((jest.fn(): any): any).mockResolvedValue(undefined),
    closePreview: (jest.fn(): any),
    getPreviewDebuggerServer: () => debuggerServer,
  }),
  storeImage: async () => {
    throw new Error('not expected here');
  },
  executeSingleToolCall: async () => {
    throw new Error('not expected here');
  },
});

// Start the session through the SAME holder the tools use.
const startSession = async (debuggerServer: any) => {
  const session = getOrCreateByokPreviewSession(
    makeRuntimeDeps(debuggerServer)
  );
  await session.start({});
  for (const callbacks of debuggerServer.registeredCallbacks) {
    callbacks.onConnectionOpened({
      id: 'preview-ws-1',
      debuggerIds: ['preview-ws-1'],
    });
  }
  return session;
};

const getTool = (name: string): ByokExtraTool => {
  const tool = getByokDebuggerTools().find(entry => entry.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
};

describe('ByokDebuggerTools', () => {
  beforeEach(() => {
    resetByokPreviewSessionForTests();
  });

  it('registers the three read-only tools', () => {
    const tools = getByokDebuggerTools();
    expect(tools.map(tool => tool.name)).toEqual([
      'read_runtime_details',
      'control_runtime',
      'profile_runtime',
    ]);
    for (const tool of tools) {
      expect(tool.modifiesProject).toBe(false);
    }
  });

  it('keeps the completion-gate holder working (no regression)', () => {
    expect(getByokPreviewHasCrashed()).toBe(false);
  });

  describe('read_runtime_details', () => {
    it('returns the status and the reduced dump of the chat preview', async () => {
      const debuggerServer = makeFakeDebuggerServer();
      debuggerServer.responsesByCommand.getStatus = { paused: true };
      debuggerServer.responsesByCommand.refresh = {
        _variables: { Score: 3 },
        _sceneStack: {
          _stack: [
            {
              _name: 'Level 1',
              _instances: { items: { Player: [{ name: 'Player', x: 9 }] } },
              _variables: {},
            },
          ],
        },
      };
      const session = await startSession(debuggerServer);
      const deps = makeRuntimeDeps(debuggerServer);
      void session;

      const result = await getTool('read_runtime_details').run(
        {},
        ({ getProject: () => null, runtimeDeps: deps }: any)
      );

      expect(result.output.success).toBe(true);
      expect(result.output.status.paused).toBe(true);
      expect(result.output.state.scenes[0].instances.Player[0].x).toBe(9);
      expect(result.didModifyProject).toBe(false);
    });

    it('fails typed without a running preview', async () => {
      const debuggerServer = makeFakeDebuggerServer();
      const deps = makeRuntimeDeps(debuggerServer);

      const result = await getTool('read_runtime_details').run(
        {},
        ({ getProject: () => null, runtimeDeps: deps }: any)
      );

      expect(result.output.success).toBe(false);
      expect(result.output.message).toContain('No BYOK preview is running');
    });
  });

  describe('control_runtime', () => {
    it('pauses and resumes through targeted commands', async () => {
      const debuggerServer = makeFakeDebuggerServer();
      await startSession(debuggerServer);
      const deps = makeRuntimeDeps(debuggerServer);
      const collaborators = ({
        getProject: () => null,
        runtimeDeps: deps,
      }: any);

      const paused = await getTool('control_runtime').run(
        { action: 'pause' },
        collaborators
      );
      expect(paused.output.success).toBe(true);
      expect(paused.output.action).toBe('pause');

      const resumed = await getTool('control_runtime').run(
        { action: 'resume' },
        collaborators
      );
      expect(resumed.output.success).toBe(true);
      expect(resumed.output.action).toBe('play');

      const commands = debuggerServer.sentMessages.map(
        sent => sent.message.command
      );
      expect(commands).toEqual(['pause', 'play']);
    });

    it('surfaces an ignored command as a typed failure (the gameplay guard)', async () => {
      const debuggerServer = makeFakeDebuggerServer();
      debuggerServer.responsesByCommand.pause = {
        commandIgnored: true,
        reason: 'A gameplay test is running.',
      };
      await startSession(debuggerServer);
      const deps = makeRuntimeDeps(debuggerServer);

      const result = await getTool('control_runtime').run(
        { action: 'pause' },
        ({ getProject: () => null, runtimeDeps: deps }: any)
      );

      expect(result.output.success).toBe(false);
      expect(result.output.message).toContain('ignored');
      expect(result.output.message).toContain('gameplay test');
    });

    it('refuses an unknown action', async () => {
      const result = await getTool('control_runtime').run(
        { action: 'teleport' },
        ({
          getProject: () => null,
          runtimeDeps: makeRuntimeDeps(makeFakeDebuggerServer()),
        }: any)
      );

      expect(result.output.success).toBe(false);
      expect(result.output.message).toContain('pause, play');
    });
  });

  describe('profile_runtime', () => {
    it('profiles start → duration → stop → pushed output', async () => {
      const debuggerServer = makeFakeDebuggerServer();
      await startSession(debuggerServer);
      const deps = makeRuntimeDeps(debuggerServer);

      // Answer every command, and push the profiler output when the stop
      // command arrives (stats are pushed, never a response payload).
      (debuggerServer.sendMessage: any).mockImplementation(
        (id: string, message: Object) => {
          debuggerServer.sentMessages.push({ id, message });
          for (const callbacks of debuggerServer.registeredCallbacks) {
            callbacks.onHandleParsedMessage({
              id,
              parsedMessage: {
                command: 'response',
                payload: {},
                messageId: message.messageId,
              },
            });
            if (message.command === 'profiler.stop') {
              callbacks.onHandleParsedMessage({
                id,
                parsedMessage: {
                  command: 'profiler.output',
                  payload: {
                    framesAverageMeasures: [{ timeSpent: 4.2 }],
                    stats: { framesCount: 120 },
                  },
                },
              });
            }
          }
        }
      );

      const result = await getTool('profile_runtime').run(
        { duration_ms: 10 },
        ({ getProject: () => null, runtimeDeps: deps }: any)
      );

      expect(result.output.success).toBe(true);
      expect(result.output.durationMs).toBe(10);
      expect(result.output.framesAverageMeasures[0].timeSpent).toBe(4.2);
      expect(result.output.stats.framesCount).toBe(120);
      expect(result.didModifyProject).toBe(false);
      const commands = debuggerServer.sentMessages.map(
        sent => sent.message.command
      );
      expect(commands).toEqual(['profiler.start', 'profiler.stop']);
    });

    it('fails typed when no profiler output arrives (bounded wait)', async () => {
      const debuggerServer = makeFakeDebuggerServer();
      await startSession(debuggerServer);
      const deps = makeRuntimeDeps(debuggerServer);

      const result = await getTool('profile_runtime').run(
        { duration_ms: 5 },
        ({ getProject: () => null, runtimeDeps: deps }: any)
      );

      expect(result.output.success).toBe(false);
      expect(result.output.message).toContain('profiling run failed');
    }, 20000);

    it('fails typed when the connection closed mid-profile', async () => {
      const debuggerServer = makeFakeDebuggerServer();
      await startSession(debuggerServer);
      const deps = makeRuntimeDeps(debuggerServer);
      // Make start hang forever, then kill the connection.
      (debuggerServer.sendMessage: any).mockImplementation(() => {});
      const pending = getTool('profile_runtime').run(
        { duration_ms: 5 },
        ({ getProject: () => null, runtimeDeps: deps }: any)
      );
      for (const callbacks of debuggerServer.registeredCallbacks) {
        callbacks.onConnectionClosed({ id: 'preview-ws-1' });
      }
      const result = await pending;

      expect(result.output.success).toBe(false);
      expect(result.output.message).toContain('connection was closed');
    });
  });
});
