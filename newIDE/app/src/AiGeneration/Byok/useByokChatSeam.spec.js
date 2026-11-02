// @flow
import * as React from 'react';
import { act } from 'react-dom/test-utils';
import reactTestRenderer from 'react-test-renderer';
import { useByokChatSeam } from './useByokChatSeam';
import { sendByokChatCompletionWithRetries } from './ByokClient';
import { saveByokKey } from './ByokKeyStorage';
import {
  getByokChat,
  listByokChats,
  setByokChatPersistence,
} from './ByokChatStore';
import { createByokChatFileStore } from './ByokChatPersistence';
import { isByokAiRequestId } from './ByokSeam';
import { getByokMcpToolHost, setByokMcpToolHost } from './Mcp/ByokMcpToolHost';

jest.mock('./ByokClient', () => ({
  sendByokChatCompletionWithRetries: (jest.fn(): any),
  createByokCancellation: jest.fn(() => ({
    token: { __fakeCancelToken: true },
    cancel: (jest.fn(): any),
  })),
}));

// The real hook consumes the extension-store context through
// useEnsureExtensionInstalled — not under test here (it has its own spec);
// replace it with a stub. The stub is a **plain function**, not a jest.fn():
// the repo's jest config sets `resetMocks: true`, which strips the
// implementation off a jest.fn() before every test, and a late render of a
// tree this suite left mounted (see renderSeam's unmount tracking below) would
// then get `undefined` back from the hook.
jest.mock('../UseEnsureExtensionInstalled', () => ({
  useEnsureExtensionInstalled: () => ({
    ensureExtensionInstalled: (jest.fn(async () => {}): any),
  }),
}));

const mockSendByokChatCompletion: any = sendByokChatCompletionWithRetries;

// The suite runs in the node environment (like ByokOrchestrator.spec.js —
// the import chain reaches modules that need no DOM), which has no
// localStorage: shim the tiny surface ByokKeyStorage uses. Installed in the
// module body: none of the imported modules touch localStorage at load.
const localStorageShim = (() => {
  const store: Map<string, string> = new Map();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key) : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
})();
(global: any).localStorage = localStorageShim;

const makeAssistantTextResponse = (text: string) => ({
  choices: [{ message: { role: 'assistant', content: text } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const makeOptions = (overrides: Object = {}) => ({
  preferencesValues: {},
  project: null,
  fileMetadata: null,
  i18n: {
    _: (descriptor: any) =>
      typeof descriptor === 'string' ? descriptor : 'translated',
  },
  editorCallbacks: {},
  processEditorFunctionCalls: (jest.fn(): any),
  editorFunctions: {},
  editorFunctionsWithoutProject: {},
  onSceneEventsModifiedOutsideEditor: (jest.fn(): any),
  onInstancesModifiedOutsideEditor: (jest.fn(): any),
  onObjectsModifiedOutsideEditor: (jest.fn(): any),
  onObjectGroupsModifiedOutsideEditor: (jest.fn(): any),
  onProjectItemRenamedOutsideEditor: (jest.fn(): any),
  onWillDeleteScene: (jest.fn(async () => {}): any),
  onWillDeleteGameplayTest: (jest.fn(async () => {}): any),
  onWillDeleteObject: (jest.fn(): any),
  onWillInstallExtension: (jest.fn(): any),
  onExtensionInstalled: (jest.fn(): any),
  getIsAutoEditEnabled: () => true,
  requestEditApproval: jest.fn(async () => true),
  triggerUnsavedChanges: (jest.fn(): any),
  onOpenLayout: (jest.fn(): any),
  setSelectedAiRequestId: (jest.fn(): any),
  resetChatUserInputs: (jest.fn(): any),
  getProjectPreviewLauncher: () => null,
  ...overrides,
});

// The seam object is re-created at every render: tests read it through the
// capture (never through a variable captured before an update).
type SeamCapture = { current: Object | null };

const Probe = ({
  options,
  capture,
}: {|
  options: Object,
  capture: SeamCapture,
|}) => {
  capture.current = useByokChatSeam(options);
  return null;
};

const renderSeam = (
  options: Object
): {| renderer: any, getSeam: () => Object |} => {
  const capture: SeamCapture = { current: null };
  const renderer = reactTestRenderer.create(
    <Probe options={options} capture={capture} />
  );
  mountedRenderers.push(renderer);
  return { renderer, getSeam: () => capture.current };
};

// Every renderer this suite creates, so the afterEach below can unmount them.
// A tree left mounted keeps its async effects (history loading, model choice
// loading) alive past the test that made it: their state setters then fire
// during a later test file — where this file's mocks no longer exist — and
// crash or fail an unrelated suite. This is the one thing that made full runs
// fail a different, arbitrary suite each time.
const mountedRenderers: Array<any> = [];

const unmountEverySeam = () => {
  const renderers = mountedRenderers.splice(0, mountedRenderers.length);
  renderers.forEach(renderer => {
    act(() => {
      renderer.unmount();
    });
  });
};

describe('useByokChatSeam', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendByokChatCompletion.mockReset();
    localStorageShim.clear();
    listByokChats().forEach(chat => {
      const record = getByokChat(chat.id);
      if (record) record.archivedAt = new Date().toISOString();
    });
  });

  afterEach(() => {
    unmountEverySeam();
  });

  // Regression test for the "one random suite fails per full run" family
  // (outofscoped O4). This suite mounts trees that kick off async effects
  // (chat history, model choices); a tree left mounted keeps them alive past
  // the test that made it, and their state setters then fire while a LATER
  // test file is running — against that file's mocks. Reproduce the original
  // failure with:
  //   npm test -- --watchAll=false --maxWorkers=1 --runTestsByPath \
  //     src/AiGeneration/Byok/useByokChatSeam.spec.js \
  //     src/UI/HelpIcon/HelpIcon.spec.js
  // which crashed the worker process outright.
  it('tracks every tree it mounts so the afterEach can unmount it', async () => {
    const { getSeam } = renderSeam(makeOptions());
    await act(async () => {});
    expect(mountedRenderers.length).toBe(1);

    const consoleErrors: Array<string> = [];
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation((...args) => {
        consoleErrors.push(String(args[0]));
      });
    try {
      unmountEverySeam();
      // The seam object still answers after its tree is gone: a late call
      // like the ones the unmounted effects make must update nothing, and
      // must not warn about an update it could not flush.
      await act(async () => {
        await getSeam().refreshByokHistoryChats();
      });
    } finally {
      consoleErrorSpy.mockRestore();
    }

    expect(mountedRenderers.length).toBe(0);
    expect(consoleErrors.join('\n')).not.toContain('not wrapped in act');
  });

  it('exposes the BYOK chat selection and store summaries', () => {
    const { getSeam } = renderSeam(makeOptions());
    expect(getSeam().selectedByokChatId).toBe(null);
    expect(getSeam().selectedByokChat).toBe(null);
    expect(Array.isArray(getSeam().byokChatSummaries)).toBe(true);
  });

  it('marks a new chat with the missing-key error when no key is stored', async () => {
    const { getSeam } = renderSeam(makeOptions());
    await act(async () => {
      await getSeam().startByokChat('Make me a game');
    });

    const selectedByokChatId = getSeam().selectedByokChatId;
    expect(selectedByokChatId).not.toBe(null);
    expect(isByokAiRequestId(selectedByokChatId)).toBe(true);
    const chat = getSeam().selectedByokChat;
    expect(chat).not.toBe(null);
    expect(chat.status).toBe('error');
    expect(chat.error && chat.error.code).toBe('byok-missing-key');
    // No orchestrator was ever created: the endpoint was never called.
    expect(mockSendByokChatCompletion).not.toHaveBeenCalled();
  });

  it('resets the chat inputs and the server selection when a chat starts', async () => {
    const resetChatUserInputs = (jest.fn(): any);
    const setSelectedAiRequestId = (jest.fn(): any);
    const { getSeam } = renderSeam(
      makeOptions({ resetChatUserInputs, setSelectedAiRequestId })
    );
    await act(async () => {
      await getSeam().startByokChat('Make me a game');
    });

    expect(setSelectedAiRequestId).toHaveBeenCalledWith(null);
    expect(resetChatUserInputs).toHaveBeenCalledTimes(1);
    expect(resetChatUserInputs.mock.calls[0][0]).toBe(
      getSeam().selectedByokChatId
    );
  });

  it('runs the chat through the orchestrator when a key is stored', async () => {
    await saveByokKey('test-key');
    mockSendByokChatCompletion.mockResolvedValue(
      makeAssistantTextResponse('Hello from BYOK.')
    );
    const { getSeam } = renderSeam(makeOptions());
    await act(async () => {
      await getSeam().startByokChat('Make me a game');
    });

    expect(mockSendByokChatCompletion).toHaveBeenCalledTimes(1);
    const chat = getSeam().selectedByokChat;
    expect(chat.status).toBe('ready');
    const roles = (chat.output || []).map((message: Object) => message.role);
    expect(roles).toEqual(['user', 'assistant']);
    // The chat is listed in the history summaries.
    expect(
      getSeam().byokChatSummaries.some(
        (summary: Object) => summary.id === getSeam().selectedByokChatId
      )
    ).toBe(true);
  });

  it('ignores empty user messages', async () => {
    await saveByokKey('test-key');
    mockSendByokChatCompletion.mockResolvedValue(
      makeAssistantTextResponse('Answer.')
    );
    const { getSeam } = renderSeam(makeOptions());
    await act(async () => {
      await getSeam().startByokChat('Make me a game');
    });
    mockSendByokChatCompletion.mockClear();

    await act(async () => {
      await getSeam().sendByokUserMessage(getSeam().selectedByokChatId, '');
    });
    expect(mockSendByokChatCompletion).not.toHaveBeenCalled();
  });

  it('continues a chat with a user message through the orchestrator', async () => {
    await saveByokKey('test-key');
    mockSendByokChatCompletion.mockResolvedValue(
      makeAssistantTextResponse('Answer.')
    );
    const { getSeam } = renderSeam(makeOptions());
    await act(async () => {
      await getSeam().startByokChat('Make me a game');
    });
    mockSendByokChatCompletion.mockClear();

    await act(async () => {
      await getSeam().sendByokUserMessage(
        getSeam().selectedByokChatId,
        'Now add a coin'
      );
    });
    expect(mockSendByokChatCompletion).toHaveBeenCalledTimes(1);
    const chat = getSeam().selectedByokChat;
    const userMessages = (chat.output || []).filter(
      (message: Object) => message.role === 'user'
    );
    expect(userMessages.length).toBe(2);
  });

  it('suspends BYOK chats locally and leaves other ids alone', async () => {
    await saveByokKey('test-key');
    mockSendByokChatCompletion.mockResolvedValue(
      makeAssistantTextResponse('Answer.')
    );
    const { getSeam } = renderSeam(makeOptions());
    await act(async () => {
      await getSeam().startByokChat('Make me a game');
    });

    await act(async () => {
      await getSeam().suspendAiRequestWithByokSupport('not-a-byok-id');
    });
    expect(getSeam().selectedByokChat.status).toBe('ready');

    act(() => {
      getSeam().suspendByokChat(getSeam().selectedByokChatId);
    });
    expect(getSeam().selectedByokChat.status).toBe('suspended');
  });

  it('reads the live project through the project prop', async () => {
    const fakeProject = { name: 'Opened project' };
    const capture: SeamCapture = { current: null };
    const options = makeOptions();
    const renderer = reactTestRenderer.create(
      <Probe options={options} capture={capture} />
    );
    expect((capture.current: any).getByokLiveProject()).toBe(null);

    await act(async () => {
      renderer.update(
        <Probe
          options={makeOptions({ project: fakeProject })}
          capture={capture}
        />
      );
    });
    expect((capture.current: any).getByokLiveProject()).toBe(fakeProject);
    renderer.unmount();
  });
});

describe('useByokChatSeam — the MCP tool host (Phase 10)', () => {
  const makeFinishedResult = (callId: string) => ({
    status: 'finished',
    call_id: callId,
    success: true,
    output: { message: 'ok' },
  });

  // The useEnsureExtensionInstalled stub is installed by the module factory
  // above, so this describe needs no extra per-test setup.
  afterEach(() => {
    setByokMcpToolHost(null);
    unmountEverySeam();
  });

  it('registers the tool host on mount and unregisters it on unmount', async () => {
    const { renderer } = renderSeam(makeOptions());
    await act(async () => {});
    expect(getByokMcpToolHost()).not.toBe(null);

    await act(async () => {
      renderer.unmount();
    });
    expect(getByokMcpToolHost()).toBe(null);
  });

  it('an older mount cleanup does not unregister a newer host', async () => {
    const first = renderSeam(makeOptions());
    await act(async () => {});
    const firstHost = getByokMcpToolHost();

    const second = renderSeam(makeOptions());
    await act(async () => {});
    expect(getByokMcpToolHost()).not.toBe(firstHost);

    await act(async () => {
      first.renderer.unmount();
    });
    expect(getByokMcpToolHost()).not.toBe(null);

    await act(async () => {
      second.renderer.unmount();
    });
    expect(getByokMcpToolHost()).toBe(null);
  });

  it('executes a registry tool through the seam executor', async () => {
    const processEditorFunctionCalls = (jest.fn(): any).mockResolvedValue({
      results: [makeFinishedResult('mcp-1')],
      createdSceneNames: [],
      createdProject: null,
    });
    renderSeam(makeOptions({ processEditorFunctionCalls }));
    await act(async () => {});
    const host = (getByokMcpToolHost(): any);

    const result = await host.executeRegistryTool(
      'read_scene_events',
      '{"sceneName":"Menu"}',
      'mcp-1'
    );
    expect(processEditorFunctionCalls).toHaveBeenCalledWith(
      expect.objectContaining({
        functionCalls: [
          {
            name: 'read_scene_events',
            arguments: '{"sceneName":"Menu"}',
            call_id: 'mcp-1',
          },
        ],
        relatedAiRequestId: 'byok-mcp',
      })
    );
    expect(result.output.message).toBe('ok');
  });

  it('refuses sub-agent extra tools (no runner is provided over MCP)', async () => {
    renderSeam(makeOptions());
    await act(async () => {});
    const host = (getByokMcpToolHost(): any);

    const extraResult = await host.executeExtraTool('run_explorer_agent', {
      instructions: 'Explore everything.',
    });
    expect(extraResult.output.success).toBe(false);
    expect(extraResult.output.message).toContain('nested');
  });
});

describe('useByokChatSeam: Phase 13 (toggle, bottom bar, history rail)', () => {
  const makeMemoryBackend = () => {
    const files: Map<string, string> = new Map();
    return {
      listFiles: async () =>
        Array.from(files.entries()).map(([fileName, content]) => ({
          fileName,
          sizeBytes: content.length,
        })),
      readFile: async (fileName: string) => files.get(fileName) || null,
      writeFile: async (fileName: string, content: string) => {
        files.set(fileName, content);
      },
      deleteFile: async (fileName: string) => {
        files.delete(fileName);
      },
      moveFile: async (from: string, to: string) => {
        if (!files.has(from)) return;
        files.set(to, String(files.get(from)));
        files.delete(from);
      },
      getTotalBytes: async () =>
        Array.from(files.values()).reduce(
          (sum, content) => sum + content.length,
          0
        ),
    };
  };

  beforeEach(() => {
    setByokChatPersistence(null);
  });

  afterEach(() => {
    unmountEverySeam();
  });

  it('exposes the toggle synced with the preferences setting, both ways', () => {
    const updateByokPreferences = (jest.fn(): any);
    // Off by default (not enabled / not configured).
    const off = renderSeam(makeOptions({ updateByokPreferences }));
    expect(off.getSeam().byokToggleState.isEnabled).toBe(false);

    // Flipping it writes the same `enabled` field the Preferences checkbox
    // drives — the rest of the settings is preserved.
    off.getSeam().byokToggleState.onToggle(true);
    expect(updateByokPreferences).toHaveBeenCalledTimes(1);
    const writtenSettings = updateByokPreferences.mock.calls[0][0];
    expect(writtenSettings.enabled).toBe(true);

    // Configured + enabled reads as on.
    const on = renderSeam(
      makeOptions({
        updateByokPreferences,
        preferencesValues: {
          byok: {
            enabled: true,
            endpointUrl: 'https://api.example.com/v1',
            modelName: 'm1',
          },
        },
      })
    );
    expect(on.getSeam().byokToggleState.isEnabled).toBe(true);
  });

  it('exposes the chat controls (bottom bar) only on a selected BYOK chat', async () => {
    const { getSeam } = renderSeam(makeOptions());
    await act(async () => {});
    expect(getSeam().byokChatControls).toBe(null);

    // A hosted chat id never produces controls either: the controls gate on
    // isByokAiRequestId.
    const seam = getSeam();
    await act(async () => {
      seam.setSelectedByokChatId('byok-not-a-real-chat');
    });
    expect(getSeam().byokChatControls).toBe(null);
  });

  it('merges the persisted chats into the history and routes the rail actions', async () => {
    const backend = makeMemoryBackend();
    const store = createByokChatFileStore((backend: any), () => null);
    setByokChatPersistence(store);

    // One persisted-only chat on disk, one in-session chat.
    const persistedChat = createByokAiRequestShellForTest('byok-persisted-1');
    persistedChat.output.push({
      type: 'message',
      status: 'completed',
      role: 'user',
      content: [
        { type: 'user_request', status: 'completed', text: 'Saved earlier' },
      ],
    });
    await store.saveChat(persistedChat);

    const { getSeam } = renderSeam(makeOptions());
    await act(async () => {});
    await act(async () => {
      await getSeam().refreshByokHistoryChats();
    });

    let history = getSeam().byokHistoryChats;
    expect(history.map((entry: any) => entry.id)).toContain('byok-persisted-1');

    // Archive the persisted-only chat: the file marker moves.
    await act(async () => {
      await getSeam().setByokHistoryChatArchived('byok-persisted-1', true);
    });
    await act(async () => {
      await getSeam().refreshByokHistoryChats();
    });
    history = getSeam().byokHistoryChats;
    const archivedEntry = history.find(
      (entry: any) => entry.id === 'byok-persisted-1'
    );
    expect(archivedEntry.archivedAt).toBeTruthy();

    // Restore, then delete: the entry disappears.
    await act(async () => {
      await getSeam().setByokHistoryChatArchived('byok-persisted-1', false);
      await getSeam().deleteByokHistoryChat('byok-persisted-1');
    });
    await act(async () => {
      await getSeam().refreshByokHistoryChats();
    });
    expect(
      getSeam().byokHistoryChats.some(
        (entry: any) => entry.id === 'byok-persisted-1'
      )
    ).toBe(false);
  });
});

// A minimal shell builder for persistence tests (the spec file's node
// environment has no access to the transcript factory's defaults).
function createByokAiRequestShellForTest(id: string): any {
  return {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userId: '',
    status: 'ready',
    mode: 'orchestrator',
    error: null,
    output: [],
    contextStats: null,
  };
}
