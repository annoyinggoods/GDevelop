// @flow
import type {
  CaptureOptions,
  PreviewLauncherProps,
  PreviewOptions,
} from '../../PreviewLauncher.flow';

const mockIpcRendererListeners: Map<string, Array<Function>> = new Map();
const mockIpcRenderer = {
  on: jest.fn<[string, Function], void>(),
  removeAllListeners: jest.fn<[string], void>(),
  removeListener: jest.fn<[string, Function], void>(),
  send: jest.fn<Array<any>, void>(),
  invoke: jest.fn<[string, any], any>(),
};

jest.mock('../../../Utils/OptionalRequire', () =>
  jest.fn((moduleName: string) => {
    if (moduleName === 'electron') return { ipcRenderer: mockIpcRenderer };
    // $FlowFixMe[cannot-resolve-module] - the Node.js modules are required.
    if (moduleName === 'path') return require('path');
    // $FlowFixMe[cannot-resolve-module] - the Node.js modules are required.
    if (moduleName === 'os') return require('os');
    return null;
  })
);

jest.mock('../../../GameEngineFinder/LocalGDJSFinder', () => ({
  findGDJS: () => Promise.resolve({ gdjsRoot: 'gdjs-root' }),
}));

jest.mock('./LocalPreviewDebuggerServer', () => ({
  getDebuggerServerAddress: () => null,
  localPreviewDebuggerServer: {
    startServer: () => Promise.resolve(),
    getExistingPreviewDebuggerIds: () => [],
    getExistingEmbeddedGameFrameDebuggerIds: () => [],
    sendMessage: () => {},
    closeAllConnections: () => {},
  },
}));

jest.mock('../../../EmbeddedGame/EmbeddedGameFrame', () => ({
  setEmbeddedGameFramePreviewLocation: () => {},
}));

jest.mock('../../../GameplayTests/GameplayTestFrame', () => ({
  setGameplayTestFramePreviewLocation: () => {},
}));

jest.mock('../../../Profile/Subscription/SubscriptionChecker', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('./LocalNetworkPreviewDialog', () => ({
  __esModule: true,
  default: () => null,
}));

type FakeExporter = {|
  exportProjectForPixiPreview: any,
  serializeProjectData: any,
  serializeRuntimeGameOptions: any,
  delete: any,
|};

const makeFakeExporter = (): FakeExporter => ({
  exportProjectForPixiPreview: jest.fn(),
  serializeProjectData: jest.fn(),
  serializeRuntimeGameOptions: jest.fn(),
  delete: jest.fn(),
});

const createdPreviewExportOptions: Array<any> = [];

const previewExportOptionsSetterNames = [
  'setIsDevelopmentEnvironment',
  'setLayoutName',
  'setIsInGameEdition',
  'setEditorId',
  'setExternalLayoutName',
  'setEventsBasedObjectType',
  'setEventsBasedObjectVariantName',
  'useWindowMessageDebuggerClient',
  'useWebsocketDebuggerClientWithServerAddress',
  'setIncludeFileHash',
  'setElectronRemoteRequirePath',
  'setShouldClearExportFolder',
  'setShouldReloadProjectData',
  'setShouldReloadLibraries',
  'setShouldGenerateScenesEventsCode',
  'setFullLoadingScreen',
  'setGDevelopVersionWithHash',
  'setCrashReportUploadLevel',
  'setPreviewContext',
  'setProjectTemplateSlug',
  'setSourceGameId',
  'setInAppTutorialMessageInPreview',
  'setFallbackAuthor',
  'setAuthenticatedPlayer',
  'addScreenshotCapture',
  'setEditorCameraState3D',
  'setInGameEditorSettingsJson',
];

class FakePreviewExportOptions {
  delete: any = jest.fn();
  constructor(project: any, outputDir: string) {
    previewExportOptionsSetterNames.forEach(setterName => {
      // $FlowFixMe[cannot-write] - all the setters are stubbed for the test.
      (this: any)[setterName] = jest.fn();
    });
    createdPreviewExportOptions.push(this);
  }
}

class FakeAbstractFileSystemJS {
  getTempDir: () => string = () => 'temp-dir';
}

class FakeSerializerElement {
  delete: any = jest.fn();
}

const makeFakeGd = (exporter: FakeExporter): any => ({
  AbstractFileSystemJS: FakeAbstractFileSystemJS,
  // A plain function (not an arrow) so that it can be called with `new`,
  // returning the fake exporter instance like the real constructor would.
  Exporter: function FakeExporterConstructor(
    fileSystem: any,
    gdjsRoot: string
  ) {
    return exporter;
  },
  PreviewExportOptions: FakePreviewExportOptions,
  SerializerElement: FakeSerializerElement,
  Serializer: { toJSON: () => '{}' },
});

const makeFakeProject = (): any => ({
  getName: () => 'Fake game',
  getTemplateSlug: () => '',
  getGameResolutionWidth: () => 800,
  getGameResolutionHeight: () => 600,
});

const makeCaptureOptions = (signedUrl: string): CaptureOptions => ({
  screenshots: [
    {
      signedUrl,
      delayTimeInSeconds: 2,
      publicUrl: `${signedUrl}/public`,
    },
  ],
});

const makeLauncherProps = (onCaptureFinished: any): PreviewLauncherProps => ({
  crashReportUploadLevel: 'crash',
  getIncludeFileHashs: () => ({}),
  onExport: () => {},
  onCaptureFinished,
});

const makePreviewOptions = (): PreviewOptions => ({
  project: makeFakeProject(),
  sceneName: 'My scene',
  externalLayoutName: null,
  eventsBasedObjectType: null,
  eventsBasedObjectVariantName: null,
  networkPreview: false,
  hotReload: false,
  shouldReloadProjectData: false,
  shouldReloadLibraries: false,
  shouldGenerateScenesEventsCode: false,
  shouldReloadResources: false,
  shouldHardReload: false,
  fullLoadingScreen: false,
  fallbackAuthor: null,
  authenticatedPlayer: null,
  isForInGameEdition: false,
  isForGameplayTest: false,
  editorId: '',
  getIsMenuBarHiddenInPreview: () => true,
  getIsAlwaysOnTopInPreview: () => true,
  captureOptions: null,
  onCaptureFinished: () => Promise.resolve(),
  inAppTutorialMessageInPreview: '',
  inAppTutorialMessagePositionInPreview: '',
  editorCameraState3D: null,
  inGameEditorSettings: null,
  numberOfWindows: 0,
  previewWindows: null,
});

/**
 * The launcher (and some of its dependencies) reads `global.gd` when loaded,
 * so it must be freshly loaded after the fake `gd` is installed.
 */
const loadLocalPreviewLauncher = (fakeGd: any) => {
  // $FlowFixMe[cannot-write] - install the fake gd for the test.
  global.gd = fakeGd;
  jest.resetModules();
  // $FlowFixMe[unsupported-syntax] - required to get a fresh module state.
  return require('./index').default;
};

/** Simulate a message sent by the Electron main process. */
const emitFromMainProcess = (channel: string, payload: any) =>
  (mockIpcRendererListeners.get(channel) || []).forEach(listener =>
    listener({}, payload)
  );

const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0));

describe('LocalPreviewLauncher', () => {
  beforeEach(() => {
    mockIpcRendererListeners.clear();
    // `resetMocks` is enabled, so the implementations are set for each test.
    mockIpcRenderer.on.mockImplementation((channel, listener) => {
      mockIpcRendererListeners.set(channel, [
        ...(mockIpcRendererListeners.get(channel) || []),
        listener,
      ]);
    });
    mockIpcRenderer.removeListener.mockImplementation((channel, listener) => {
      mockIpcRendererListeners.set(
        channel,
        (mockIpcRendererListeners.get(channel) || []).filter(
          registeredListener => registeredListener !== listener
        )
      );
    });
    mockIpcRenderer.invoke.mockImplementation(() => Promise.resolve([]));
    createdPreviewExportOptions.length = 0;
  });

  afterEach(() => {
    // $FlowFixMe[cannot-delete] - uninstall the fake gd after the test.
    delete global.gd;
  });

  describe('preview window closing', () => {
    const makeBrowserWindowOptions = () => ({
      width: 100,
      height: 100,
      useContentSize: true,
      title: 'Preview of Fake game',
      backgroundColor: '#000000',
    });

    const setLauncherState = (launcher: any, overrides: Object) => {
      // $FlowFixMe[cannot-write] - directly set the state for the test.
      launcher.state = { ...launcher.state, ...overrides };
    };

    it('routes a preview window closing to the launch that owns it', async () => {
      const onCaptureFinished = jest.fn(() => Promise.resolve());
      const LocalPreviewLauncher = loadLocalPreviewLauncher(
        makeFakeGd(makeFakeExporter())
      );
      const launcher = new LocalPreviewLauncher(
        makeLauncherProps(onCaptureFinished)
      );
      const firstLaunchCaptureOptions = makeCaptureOptions('first-launch');
      const secondLaunchCaptureOptions = makeCaptureOptions('second-launch');

      mockIpcRenderer.invoke.mockImplementation(channel =>
        Promise.resolve(channel === 'preview-open' ? [1] : [])
      );
      setLauncherState(launcher, {
        previewGamePath: 'preview-folder',
        previewBrowserWindowOptions: makeBrowserWindowOptions(),
        captureOptions: firstLaunchCaptureOptions,
      });
      await launcher._openPreviewBrowserWindow();

      // A second launch, opening another window with its own capture options.
      mockIpcRenderer.invoke.mockImplementation(() => Promise.resolve([2]));
      setLauncherState(launcher, {
        captureOptions: secondLaunchCaptureOptions,
      });
      await launcher._openPreviewBrowserWindow();

      // A single, stable listener handles all the launches.
      expect(mockIpcRenderer.on).toHaveBeenCalledTimes(1);
      expect(mockIpcRenderer.on).toHaveBeenCalledWith(
        'preview-window-closed',
        expect.any(Function)
      );
      expect(mockIpcRenderer.removeAllListeners).not.toHaveBeenCalledWith(
        'preview-window-closed'
      );

      emitFromMainProcess('preview-window-closed', 1);
      await flushPromises();

      expect(onCaptureFinished).toHaveBeenCalledTimes(1);
      expect(onCaptureFinished).toHaveBeenCalledWith(firstLaunchCaptureOptions);

      emitFromMainProcess('preview-window-closed', 2);
      await flushPromises();

      expect(onCaptureFinished).toHaveBeenCalledTimes(2);
      expect(onCaptureFinished).toHaveBeenLastCalledWith(
        secondLaunchCaptureOptions
      );
    });

    it('ignores the closing of a preview window that no launch owns', async () => {
      const onCaptureFinished = jest.fn(() => Promise.resolve());
      const LocalPreviewLauncher = loadLocalPreviewLauncher(
        makeFakeGd(makeFakeExporter())
      );
      const launcher = new LocalPreviewLauncher(
        makeLauncherProps(onCaptureFinished)
      );

      mockIpcRenderer.invoke.mockImplementation(() => Promise.resolve([1]));
      setLauncherState(launcher, {
        previewGamePath: 'preview-folder',
        previewBrowserWindowOptions: makeBrowserWindowOptions(),
        captureOptions: makeCaptureOptions('launch'),
      });
      await launcher._openPreviewBrowserWindow();

      emitFromMainProcess('preview-window-closed', 42);
      await flushPromises();

      expect(onCaptureFinished).not.toHaveBeenCalled();
    });

    it('stops listening and forgets the ownership when unmounted', async () => {
      const onCaptureFinished = jest.fn(() => Promise.resolve());
      const LocalPreviewLauncher = loadLocalPreviewLauncher(
        makeFakeGd(makeFakeExporter())
      );
      const launcher = new LocalPreviewLauncher(
        makeLauncherProps(onCaptureFinished)
      );

      mockIpcRenderer.invoke.mockImplementation(() => Promise.resolve([1]));
      setLauncherState(launcher, {
        previewGamePath: 'preview-folder',
        previewBrowserWindowOptions: makeBrowserWindowOptions(),
        captureOptions: makeCaptureOptions('launch'),
      });
      await launcher._openPreviewBrowserWindow();

      launcher.componentWillUnmount();

      expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
        'preview-window-closed',
        expect.any(Function)
      );

      emitFromMainProcess('preview-window-closed', 1);
      await flushPromises();

      expect(onCaptureFinished).not.toHaveBeenCalled();
    });
  });

  describe('launchPreview', () => {
    it('deletes the exporter and the preview export options when the export throws', async () => {
      const exporter = makeFakeExporter();
      exporter.exportProjectForPixiPreview.mockImplementation(() => {
        throw new Error('Export failure');
      });
      const LocalPreviewLauncher = loadLocalPreviewLauncher(
        makeFakeGd(exporter)
      );
      const launcher = new LocalPreviewLauncher(makeLauncherProps(jest.fn()));

      const error = await launcher
        .launchPreview(makePreviewOptions())
        .then(() => null, caughtError => caughtError);

      expect(error).toBeInstanceOf(Error);
      expect(error && error.message).toBe('Export failure');
      expect(exporter.exportProjectForPixiPreview).toHaveBeenCalledTimes(1);
      expect(exporter.delete).toHaveBeenCalledTimes(1);
      expect(createdPreviewExportOptions).toHaveLength(1);
      expect(createdPreviewExportOptions[0].delete).toHaveBeenCalledTimes(1);
    });

    it('deletes the exporter and the preview export options exactly once when the export succeeds', async () => {
      const exporter = makeFakeExporter();
      const LocalPreviewLauncher = loadLocalPreviewLauncher(
        makeFakeGd(exporter)
      );
      const launcher = new LocalPreviewLauncher(makeLauncherProps(jest.fn()));

      await launcher.launchPreview(makePreviewOptions());

      expect(exporter.exportProjectForPixiPreview).toHaveBeenCalledTimes(1);
      expect(exporter.delete).toHaveBeenCalledTimes(1);
      expect(createdPreviewExportOptions).toHaveLength(1);
      expect(createdPreviewExportOptions[0].delete).toHaveBeenCalledTimes(1);
    });
  });
});
