// @flow
import {
  APPROVED_CALL_IDS_CAPACITY,
  buildByokChatProps,
  byokCallRequiresApproval,
  createByokEditorFunctionCallExecutor,
  isByokAiRequestId,
  shouldUseByokForNewRequest,
} from './ByokSeam';
import { setByokCatalogFetchersForTests } from './ByokCatalogTools';
import { BYOK_TOOLS_VERSION, DEFAULT_BYOK_SETTINGS } from './ByokTypes';

describe('APPROVED_CALL_IDS_CAPACITY', () => {
  it('pins the blanket-approval memory cap', () => {
    // The cap is a memory bound, not a security rule: pinned so a change is
    // a deliberate decision, not an accident.
    expect(APPROVED_CALL_IDS_CAPACITY).toBe(500);
  });
});

describe('isByokAiRequestId', () => {
  it('recognizes ids prefixed by "byok-"', () => {
    expect(isByokAiRequestId('byok-abc123')).toBe(true);
    expect(isByokAiRequestId('regular-server-id')).toBe(false);
    expect(isByokAiRequestId('')).toBe(false);
    expect(isByokAiRequestId(null)).toBe(false);
    expect(isByokAiRequestId(undefined)).toBe(false);
  });
});

describe('shouldUseByokForNewRequest', () => {
  it('is false for the default (disabled) settings', () => {
    expect(
      shouldUseByokForNewRequest({
        byok: DEFAULT_BYOK_SETTINGS,
      })
    ).toBe(false);
  });

  it('is false when enabled but not fully configured', () => {
    expect(
      shouldUseByokForNewRequest({
        byok: {
          ...DEFAULT_BYOK_SETTINGS,
          enabled: true,
          endpointUrl: 'https://api.example.com/v1',
          // No model name.
        },
      })
    ).toBe(false);
  });

  it('is true when enabled and fully configured', () => {
    expect(
      shouldUseByokForNewRequest({
        byok: {
          ...DEFAULT_BYOK_SETTINGS,
          enabled: true,
          endpointUrl: 'https://api.example.com/v1',
          modelName: 'my-model',
        },
      })
    ).toBe(true);
  });

  it('is false for a missing or corrupt byok preference', () => {
    expect(shouldUseByokForNewRequest({ byok: null })).toBe(false);
    expect(shouldUseByokForNewRequest(({ byok: 'corrupt' }: any))).toBe(false);
  });
});

describe('buildByokChatProps', () => {
  it('returns the exact idle-credits prop bundle', () => {
    expect(buildByokChatProps()).toEqual({
      quota: null,
      price: null,
      availableCredits: 0,
      isRefreshingLimits: false,
      increaseQuotaOffering: 'none',
    });
  });
});

describe('byokCallRequiresApproval', () => {
  it('requires approval when the registry function is missing (safe default)', () => {
    expect(byokCallRequiresApproval(null, {})).toBe(true);
  });

  it('does not require approval for a non-modifying function', () => {
    expect(byokCallRequiresApproval({ modifiesProject: false }, {})).toBe(
      false
    );
  });

  it('requires approval for a modifying function', () => {
    expect(byokCallRequiresApproval({ modifiesProject: true }, {})).toBe(true);
  });

  it('respects a getModifiesProject override over modifiesProject', () => {
    const editorFunction = {
      modifiesProject: true,
      getModifiesProject: (args: any) => args.shouldModify === true,
    };

    expect(
      byokCallRequiresApproval(editorFunction, {
        shouldModify: true,
      })
    ).toBe(true);
    expect(
      byokCallRequiresApproval(editorFunction, {
        shouldModify: false,
      })
    ).toBe(false);
  });
});

describe('createByokEditorFunctionCallExecutor', () => {
  const makeExecutorDeps = (overrides: any = {}) => ({
    processEditorFunctionCalls: (jest.fn(): any),
    getProject: () => ({ name: 'fake-project' }),
    i18n: {},
    editorCallbacks: {},
    ensureExtensionInstalled: (jest.fn(): any),
    onSceneEventsModifiedOutsideEditor: (jest.fn(): any),
    onInstancesModifiedOutsideEditor: (jest.fn(): any),
    onObjectsModifiedOutsideEditor: (jest.fn(): any),
    onObjectGroupsModifiedOutsideEditor: (jest.fn(): any),
    onProjectItemRenamedOutsideEditor: (jest.fn(): any),
    onWillDeleteScene: (jest.fn(): any),
    onWillDeleteGameplayTest: (jest.fn(): any),
    onWillDeleteObject: (jest.fn(): any),
    onWillInstallExtension: (jest.fn(): any),
    onExtensionInstalled: (jest.fn(): any),
    ...overrides,
  });

  it('passes the calls to the injected runner with the byok context', async () => {
    const deps = makeExecutorDeps();
    deps.processEditorFunctionCalls.mockResolvedValue({
      results: [],
      createdSceneNames: ['NewScene'],
      createdProject: null,
    });
    const executor = createByokEditorFunctionCallExecutor(deps);
    const getRelatedAiRequestLastMessages = () => ({ lastUserMessage: null });

    const outcome = await executor(
      [{ name: 'create_scene', arguments: '{}', call_id: 'call-1' }],
      {
        aiRequestId: 'byok-chat-1',
        getRelatedAiRequestLastMessages,
      }
    );

    expect(deps.processEditorFunctionCalls).toHaveBeenCalledTimes(1);
    const runnerOptions = deps.processEditorFunctionCalls.mock.calls[0][0];
    // The project is resolved at call time through getProject.
    expect(runnerOptions.project).toEqual({ name: 'fake-project' });
    expect(runnerOptions.toolOptions).toBe(null);
    // The BYOK agent is script-based: it executes with v12+ semantics
    // (an idempotent no-op is a success), like the hosted v15 tools.
    expect(runnerOptions.toolsVersion).toBe(BYOK_TOOLS_VERSION);
    expect(runnerOptions.toolsVersion).toBe('v15');
    expect(runnerOptions.functionCalls).toEqual([
      { name: 'create_scene', arguments: '{}', call_id: 'call-1' },
    ]);
    expect(runnerOptions.relatedAiRequestId).toBe('byok-chat-1');
    expect(runnerOptions.getRelatedAiRequestLastMessages).toBe(
      getRelatedAiRequestLastMessages
    );
    expect(outcome.createdSceneNames).toEqual(['NewScene']);
  });

  it('coalesces the outside-editor notifications of a batch, flushing once', async () => {
    const deps = makeExecutorDeps();
    deps.processEditorFunctionCalls.mockImplementation(async (options: any) => {
      // Simulate two calls editing the same scene twice.
      options.onInstancesModifiedOutsideEditor({ scene: 'scene-1' });
      options.onInstancesModifiedOutsideEditor({ scene: 'scene-1' });
      options.onSceneEventsModifiedOutsideEditor({
        scene: 'scene-1',
        newOrChangedAiGeneratedEventIds: ['event-1'],
      });
      options.onSceneEventsModifiedOutsideEditor({
        scene: 'scene-1',
        newOrChangedAiGeneratedEventIds: ['event-2'],
      });
      return { results: [], createdSceneNames: [], createdProject: null };
    });
    const executor = createByokEditorFunctionCallExecutor(deps);

    await executor([], {
      aiRequestId: 'byok-chat-1',
      getRelatedAiRequestLastMessages: () => ({}),
    });

    expect(deps.onInstancesModifiedOutsideEditor).toHaveBeenCalledTimes(1);
    expect(deps.onSceneEventsModifiedOutsideEditor).toHaveBeenCalledTimes(1);
    expect(deps.onSceneEventsModifiedOutsideEditor).toHaveBeenCalledWith({
      scene: 'scene-1',
      newOrChangedAiGeneratedEventIds: new Set(['event-1', 'event-2']),
    });
  });

  it('OR-accumulates isNewObjectTypeUsed like the server-backed flow', async () => {
    const deps = makeExecutorDeps();
    deps.processEditorFunctionCalls.mockImplementation(async (options: any) => {
      // An early call introduces a new object type, a later one in the same
      // scene reports false: the flush must still say true.
      options.onObjectsModifiedOutsideEditor({
        scene: 'scene-1',
        isNewObjectTypeUsed: true,
      });
      options.onObjectsModifiedOutsideEditor({
        scene: 'scene-1',
        isNewObjectTypeUsed: false,
      });
      return { results: [], createdSceneNames: [], createdProject: null };
    });
    const executor = createByokEditorFunctionCallExecutor(deps);

    await executor([], {
      aiRequestId: 'byok-chat-1',
      getRelatedAiRequestLastMessages: () => ({}),
    });

    expect(deps.onObjectsModifiedOutsideEditor).toHaveBeenCalledTimes(1);
    expect(deps.onObjectsModifiedOutsideEditor).toHaveBeenCalledWith({
      scene: 'scene-1',
      isNewObjectTypeUsed: true,
    });
  });

  it('flushes the accumulated notifications even when the runner throws', async () => {
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const deps = makeExecutorDeps();
    deps.processEditorFunctionCalls.mockImplementation(async (options: any) => {
      options.onInstancesModifiedOutsideEditor({ scene: 'scene-1' });
      throw new Error('runner exploded');
    });
    const executor = createByokEditorFunctionCallExecutor(deps);

    await expect(
      executor([], {
        aiRequestId: 'byok-chat-1',
        getRelatedAiRequestLastMessages: () => ({}),
      })
    ).rejects.toThrow('runner exploded');
    expect(deps.onInstancesModifiedOutsideEditor).toHaveBeenCalledTimes(1);

    consoleErrorSpy.mockRestore();
  });

  it('wires the store search dependencies to the local catalog implementation', async () => {
    // The Phase 12 flip: searchAndInstallAsset/searchAndInstallResources
    // used to be `makeUnavailableDependency` stubs — they now run the
    // public-catalog implementation (Phase 12, D12-3). The catalogs are
    // faked so the test never touches the network.
    setByokCatalogFetchersForTests({
      listAllExamples: async () => [],
      getExample: async () => ({}),
      listAllPublicAssets: async () => [],
      getPublicAsset: async () => ({}),
      listAllResources: async () => [],
    });
    try {
      const deps = makeExecutorDeps();
      deps.processEditorFunctionCalls.mockImplementation(
        async (options: any) => {
          await expect(options.generateEvents({})).rejects.toThrow(
            'not available in BYOK'
          );
          const assetResult = await options.searchAndInstallAsset({
            objectsContainer: null,
            objectName: 'Coin',
            objectType: null,
            searchTerms: 'coin',
            description: '',
          });
          expect(assetResult.status).toBe('nothing-found');
          expect(options.getAssetStoreTagForNewObject('Sprite::Object')).toBe(
            null
          );
          return { results: [], createdSceneNames: [], createdProject: null };
        }
      );
      const executor = createByokEditorFunctionCallExecutor(deps);

      await executor([], {
        aiRequestId: 'byok-chat-1',
        getRelatedAiRequestLastMessages: () => ({}),
      });

      expect(deps.processEditorFunctionCalls).toHaveBeenCalledTimes(1);
    } finally {
      setByokCatalogFetchersForTests(null);
    }
  });

  it('passes the real ensureExtensionInstalled through', async () => {
    const deps = makeExecutorDeps();
    deps.processEditorFunctionCalls.mockResolvedValue({
      results: [],
      createdSceneNames: [],
      createdProject: null,
    });
    const executor = createByokEditorFunctionCallExecutor(deps);

    await executor([], {
      aiRequestId: 'byok-chat-1',
      getRelatedAiRequestLastMessages: () => ({}),
    });

    expect(
      deps.processEditorFunctionCalls.mock.calls[0][0].ensureExtensionInstalled
    ).toBe(deps.ensureExtensionInstalled);
  });
});
