// @flow
import { Trans } from '@lingui/macro';

import * as React from 'react';
import LocalFileSystem from '../LocalFileSystem';
import optionalRequire from '../../../Utils/OptionalRequire';
import { findGDJS } from '../../../GameEngineFinder/LocalGDJSFinder';
import LocalNetworkPreviewDialog from './LocalNetworkPreviewDialog';
import assignIn from 'lodash/assignIn';
import {
  type PreviewOptions,
  type PreviewLauncherProps,
  type CaptureOptions,
} from '../../PreviewLauncher.flow';
import SubscriptionChecker, {
  type SubscriptionCheckerInterface,
} from '../../../Profile/Subscription/SubscriptionChecker';
import {
  getDebuggerServerAddress,
  localPreviewDebuggerServer,
} from './LocalPreviewDebuggerServer';
import {
  createPreviewClosedTracker,
  type PreviewClosedTracker,
} from './PreviewClosedTracker';
import Window from '../../../Utils/Window';
import { getIDEVersionWithHash } from '../../../Version';
import { setEmbeddedGameFramePreviewLocation } from '../../../EmbeddedGame/EmbeddedGameFrame';
import { setGameplayTestFramePreviewLocation } from '../../../GameplayTests/GameplayTestFrame';
const electron = optionalRequire('electron');
const path = optionalRequire('path');
const ipcRenderer = electron ? electron.ipcRenderer : null;
const gd: libGDevelop = global.gd;

let nextPreviewId = 1;

type State = {|
  networkPreviewDialogOpen: boolean,
  networkPreviewHost: ?string,
  networkPreviewPort: ?number,
  networkPreviewError: ?any,
  hotReloadsCount: number,
  previewGamePath: ?string,
  previewBrowserWindowOptions: ?{
    width: number,
    height: number,
    useContentSize: boolean,
    title: string,
    backgroundColor: string,
  },
  hideMenuBar: boolean,
  alwaysOnTop: boolean,
  numberOfWindows: number,
  captureOptions: ?CaptureOptions,
|};

const prepareExporter = async ({
  isForInGameEdition,
  isForGameplayTest,
}: {
  isForInGameEdition: boolean,
  isForGameplayTest: boolean,
}): Promise<{|
  outputDir: string,
  exporter: gdjsExporter,
  gdjsRoot: string,
|}> => {
  const { gdjsRoot } = await findGDJS();
  console.info('GDJS found in ', gdjsRoot);

  const localFileSystem = new LocalFileSystem({
    downloadUrlsToLocalFiles: false,
  });
  const fileSystem = assignIn(new gd.AbstractFileSystemJS(), localFileSystem);
  const outputDir = path.join(
    fileSystem.getTempDir(),
    isForGameplayTest
      ? 'gameplay-test-preview'
      : isForInGameEdition
      ? 'in-game-editor-preview'
      : 'preview'
  );
  const exporter = new gd.Exporter(fileSystem, gdjsRoot);

  return {
    outputDir,
    exporter,
    gdjsRoot,
  };
};

export default class LocalPreviewLauncher extends React.Component<
  PreviewLauncherProps,
  State
> {
  canDoNetworkPreview = (): any => true;

  // $FlowFixMe[missing-local-annot]
  state = {
    networkPreviewDialogOpen: false,
    networkPreviewHost: null,
    networkPreviewPort: null,
    networkPreviewError: null,
    previewGamePath: null,
    previewBrowserWindowOptions: null,
    hotReloadsCount: 0,
    hideMenuBar: true,
    alwaysOnTop: true,
    numberOfWindows: 1,
    captureOptions: null,
  };
  _networkPreviewSubscriptionChecker: ?SubscriptionCheckerInterface = null;
  _hotReloadSubscriptionChecker: ?SubscriptionCheckerInterface = null;
  _previewClosedTracker: PreviewClosedTracker = createPreviewClosedTracker(
    (captureOptions: CaptureOptions) =>
      this.props.onCaptureFinished(captureOptions)
  );
  _previewClosedListenerRegistered = false;

  _onPreviewWindowClosed = (event: any, windowId: number) => {
    // The tracker already contains its own failures; this catch is the
    // belt-and-braces for anything else, so a preview that closes while the
    // IDE is shutting down can never produce an unhandled rejection
    // (audit100226 ELEC-21).
    this._previewClosedTracker
      .handleClosed(windowId)
      .catch(error =>
        console.error('A preview window close could not be handled.', error)
      );
  };

  _ensurePreviewClosedListenerRegistered = () => {
    if (!ipcRenderer) return;
    if (this._previewClosedListenerRegistered) return;

    this._previewClosedListenerRegistered = true;
    ipcRenderer.on('preview-window-closed', this._onPreviewWindowClosed);
  };

  componentWillUnmount() {
    if (!ipcRenderer) return;

    if (this._previewClosedListenerRegistered) {
      ipcRenderer.removeListener(
        'preview-window-closed',
        this._onPreviewWindowClosed
      );
      this._previewClosedListenerRegistered = false;
    }
    this._previewClosedTracker.releaseAll();
  }

  _openPreviewBrowserWindow = () => {
    const {
      previewGamePath,
      previewBrowserWindowOptions,
      captureOptions,
      alwaysOnTop,
      hideMenuBar,
      numberOfWindows,
    } = this.state;
    if (!previewBrowserWindowOptions || !previewGamePath) return;

    if (!ipcRenderer) return;

    ipcRenderer
      .invoke('preview-open', {
        previewBrowserWindowOptions,
        previewGameIndexHtmlPath: `file://${previewGamePath}/index.html`,
        alwaysOnTop,
        hideMenuBar,
        numberOfWindows,
        captureOptions,
      })
      .then(windowIds => {
        if (!Array.isArray(windowIds)) return;

        if (captureOptions) {
          this._previewClosedTracker.own(windowIds, captureOptions);
        }
        this._ensurePreviewClosedListenerRegistered();
      })
      // The main process refused (the preview could not be written, the
      // window could not be opened). Nothing else reports this: without the
      // catch it is an unhandled rejection.
      .catch(error =>
        console.error('Unable to open the preview window - ignoring.', error)
      );
  };

  closePreview = (windowId: number) => {
    if (!ipcRenderer) return;
    // The main process closes a window that may already be gone (a close
    // race, or a crashed renderer). Mirrors closeAllPreviews: the failure is
    // reported and ignored rather than becoming an unhandled rejection
    // (audit100226 ELEC-21).
    ipcRenderer
      .invoke('preview-close', { windowId })
      .catch(error =>
        console.info('Unable to close the preview window - ignoring.', error)
      );
  };

  closeAllPreviews = () => {
    if (ipcRenderer) {
      ipcRenderer.invoke('preview-close-all').catch(error => {
        console.info('Unable to close all preview windows - ignoring.', error);
      });
    }

    // This should be unnecessary since the preview windows are closed above.
    const previewDebuggerServer = this.getPreviewDebuggerServer();
    if (previewDebuggerServer) {
      previewDebuggerServer.closeAllConnections();
    }
  };

  _openPreviewWindow = (
    project: gdProject,
    gamePath: string,
    options: PreviewOptions
  ): void => {
    this.setState(
      // $FlowFixMe[incompatible-type]
      {
        previewBrowserWindowOptions: {
          width: project.getGameResolutionWidth(),
          height: project.getGameResolutionHeight(),
          useContentSize: true,
          title: `Preview of ${project.getName()}`,
          backgroundColor: '#000000',
          webPreferences: {
            webSecurity: false, // Allow to access to local files,
            // Allow Node.js API access in renderer process, as long
            // as we've not removed dependency on it and on "@electron/remote".
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false,
          },
        },
        previewGamePath: gamePath,
        hideMenuBar: !options.getIsMenuBarHiddenInPreview(),
        alwaysOnTop: options.getIsAlwaysOnTopInPreview(),
        numberOfWindows: options.numberOfWindows,
        captureOptions: options.captureOptions,
      },
      () => {
        if (!options.networkPreview) {
          this._openPreviewBrowserWindow();
        } else {
          if (!ipcRenderer) return;

          ipcRenderer.removeAllListeners('serve-folder-done');
          ipcRenderer.removeAllListeners('local-network-ips');
          ipcRenderer.on('serve-folder-done', (event, err, serverParams) => {
            if (err) {
              this.setState({
                networkPreviewDialogOpen: true,
                networkPreviewPort: null,
                networkPreviewHost: null,
                networkPreviewError: err,
              });
            } else {
              this.setState({
                networkPreviewDialogOpen: true,
                networkPreviewPort: serverParams.port,
              });
            }

            setTimeout(() => this._checkSubscriptionForNetworkPreview());
          });
          ipcRenderer.on('local-network-ip', (event, ipAddress) => {
            this.setState({
              networkPreviewHost: ipAddress,
            });
          });
          ipcRenderer.send('serve-folder', {
            root: gamePath,
          });
          ipcRenderer.send('get-local-network-ip');
        }
      }
    );
  };

  launchPreview = async (previewOptions: PreviewOptions): Promise<any> => {
    const {
      project,
      sceneName,
      externalLayoutName,
      eventsBasedObjectType,
      eventsBasedObjectVariantName,
    } = previewOptions;

    const previewId = nextPreviewId++;
    console.log(
      `[LocalPreviewLauncher] Launching preview #${previewId} with options:`,
      previewOptions
    );

    // Start the debugger server for previews. Even if not used,
    // useful if the user opens the Debugger editor later, or want to
    // hot reload.
    try {
      await this.getPreviewDebuggerServer().startServer({});
    } catch (err) {
      console.error(
        'Unable to start the Debugger Server for the preview:',
        err
      );
    }

    const { outputDir, exporter, gdjsRoot } = await prepareExporter({
      isForInGameEdition: previewOptions.isForInGameEdition,
      isForGameplayTest: !!previewOptions.isForGameplayTest,
    });

    var previewStartTime = performance.now();

    const previewExportOptions = new gd.PreviewExportOptions(
      project,
      outputDir
    );
    // Everything from now on may throw (export, serialization, preview
    // opening): the WASM wrappers (`exporter`, `previewExportOptions`) must
    // still be deleted, so wrap the work in a try/finally.
    try {
      previewExportOptions.setIsDevelopmentEnvironment(Window.isDev());
      previewExportOptions.setLayoutName(sceneName);
      previewExportOptions.setIsInGameEdition(
        previewOptions.isForInGameEdition
      );
      previewExportOptions.setEditorId(previewOptions.editorId || '');
      if (externalLayoutName) {
        previewExportOptions.setExternalLayoutName(externalLayoutName);
      }
      if (eventsBasedObjectType) {
        previewExportOptions.setEventsBasedObjectType(eventsBasedObjectType);
        previewExportOptions.setEventsBasedObjectVariantName(
          eventsBasedObjectVariantName || ''
        );
      }

      if (
        previewOptions.isForInGameEdition ||
        previewOptions.isForGameplayTest
      ) {
        previewExportOptions.useWindowMessageDebuggerClient();
      } else {
        const previewDebuggerServerAddress = getDebuggerServerAddress();
        if (previewDebuggerServerAddress) {
          previewExportOptions.useWebsocketDebuggerClientWithServerAddress(
            previewDebuggerServerAddress.address,
            '' + previewDebuggerServerAddress.port
          );
        }
      }

      const includeFileHashs = this.props.getIncludeFileHashs();
      for (const includeFile in includeFileHashs) {
        const hash = includeFileHashs[includeFile];
        previewExportOptions.setIncludeFileHash(includeFile, hash);
      }

      // Give the preview the path to the "@electron/remote" module of the editor,
      // as this is required by some features and we've not removed dependency
      // on "@electron/remote" yet.
      previewExportOptions.setElectronRemoteRequirePath(
        path.join(
          gdjsRoot,
          '../preview_node_modules',
          '@electron/remote',
          'renderer/index.js'
        )
      );

      // TODO Filter according to isForInGameEdition because the first game preview
      // won't necessarily be the first debugger.
      // It doesn't have any side effect because when it wont actually do an hot-reload
      // since the game preview doesn't exist yet.
      const debuggerIds = previewOptions.isForInGameEdition
        ? this.getPreviewDebuggerServer().getExistingEmbeddedGameFrameDebuggerIds()
        : this.getPreviewDebuggerServer().getExistingPreviewDebuggerIds();
      const shouldHotReload =
        previewOptions.hotReload &&
        !previewOptions.isForGameplayTest &&
        !!debuggerIds.length;
      if (shouldHotReload) {
        previewExportOptions.setShouldClearExportFolder(
          previewOptions.shouldHardReload
        );
        // At hot-reload, the ProjectData are passed into the message.
        // It means that we don't need to write them in a file.
        previewExportOptions.setShouldReloadProjectData(false);
        previewExportOptions.setShouldReloadLibraries(
          previewOptions.shouldReloadLibraries ||
            previewOptions.shouldGenerateScenesEventsCode
        );
        previewExportOptions.setShouldGenerateScenesEventsCode(
          previewOptions.shouldGenerateScenesEventsCode
        );
      }

      previewExportOptions.setFullLoadingScreen(
        previewOptions.fullLoadingScreen
      );
      previewExportOptions.setGDevelopVersionWithHash(getIDEVersionWithHash());
      previewExportOptions.setCrashReportUploadLevel(
        this.props.crashReportUploadLevel
      );
      previewExportOptions.setPreviewContext('preview');
      previewExportOptions.setProjectTemplateSlug(project.getTemplateSlug());

      if (previewOptions.inAppTutorialMessageInPreview) {
        previewExportOptions.setInAppTutorialMessageInPreview(
          previewOptions.inAppTutorialMessageInPreview,
          previewOptions.inAppTutorialMessagePositionInPreview
        );
      }

      if (previewOptions.fallbackAuthor) {
        previewExportOptions.setFallbackAuthor(
          previewOptions.fallbackAuthor.id,
          previewOptions.fallbackAuthor.username
        );
      }
      if (previewOptions.authenticatedPlayer) {
        previewExportOptions.setAuthenticatedPlayer(
          previewOptions.authenticatedPlayer.playerId,
          previewOptions.authenticatedPlayer.playerUsername,
          previewOptions.authenticatedPlayer.playerToken
        );
      }
      if (previewOptions.captureOptions) {
        if (previewOptions.captureOptions.screenshots) {
          previewOptions.captureOptions.screenshots.forEach(screenshot => {
            previewExportOptions.addScreenshotCapture(
              screenshot.delayTimeInSeconds,
              screenshot.signedUrl,
              screenshot.publicUrl
            );
          });
        }
      }
      if (previewOptions.editorCameraState3D) {
        previewExportOptions.setEditorCameraState3D(
          previewOptions.editorCameraState3D.cameraMode,
          previewOptions.editorCameraState3D.positionX,
          previewOptions.editorCameraState3D.positionY,
          previewOptions.editorCameraState3D.positionZ,
          previewOptions.editorCameraState3D.rotationAngle,
          previewOptions.editorCameraState3D.elevationAngle,
          previewOptions.editorCameraState3D.distance
        );
      }
      if (previewOptions.inGameEditorSettings) {
        previewExportOptions.setInGameEditorSettingsJson(
          JSON.stringify(previewOptions.inGameEditorSettings)
        );
      }

      exporter.exportProjectForPixiPreview(previewExportOptions);

      if (shouldHotReload) {
        const projectDataElement = new gd.SerializerElement();
        let projectData = null;
        try {
          exporter.serializeProjectData(
            project,
            previewExportOptions,
            projectDataElement
          );
          projectData = JSON.parse(gd.Serializer.toJSON(projectDataElement));
        } finally {
          projectDataElement.delete();
        }

        const runtimeGameOptionsElement = new gd.SerializerElement();
        let runtimeGameOptions = null;
        try {
          exporter.serializeRuntimeGameOptions(
            previewExportOptions,
            runtimeGameOptionsElement
          );
          runtimeGameOptions = JSON.parse(
            gd.Serializer.toJSON(runtimeGameOptionsElement)
          );
        } finally {
          runtimeGameOptionsElement.delete();
        }

        if (previewOptions.shouldHardReload) {
          console.log(
            `[LocalPreviewLauncher] Triggering hard reload for preview #${previewId}...`
          );
          debuggerIds.forEach(debuggerId => {
            this.getPreviewDebuggerServer().sendMessage(debuggerId, {
              command: 'hardReload',
            });
          });
        } else {
          debuggerIds.forEach(debuggerId => {
            console.log(
              `[LocalPreviewLauncher] Triggering hot reload for preview #${previewId}...`
            );
            this.getPreviewDebuggerServer().sendMessage(debuggerId, {
              command: 'hotReload',
              payload: {
                shouldReloadResources: previewOptions.shouldReloadResources,
                projectData,
                runtimeGameOptions,
              },
            });
          });
        }
        if (!previewOptions.isForInGameEdition) {
          if (
            this.state.hotReloadsCount % 16 === 0 &&
            this._hotReloadSubscriptionChecker
          ) {
            this._hotReloadSubscriptionChecker.checkUserHasSubscription();
          }
          this.setState(state => ({
            hotReloadsCount: state.hotReloadsCount + 1,
          }));
        }
      } else {
        if (previewOptions.isForInGameEdition) {
          setEmbeddedGameFramePreviewLocation({
            previewIndexHtmlLocation: `file://${outputDir}/index.html`,
          });
        }

        if (previewOptions.isForGameplayTest) {
          // The preview is shown in (and run by) the gameplay test frame:
          // no window to open. The previewId in the URL forces the frame to
          // reload the game when the same preview is re-exported.
          setGameplayTestFramePreviewLocation({
            previewIndexHtmlLocation: `file://${outputDir}/index.html?previewId=${previewId}`,
            // The game window of the frame is fixed at the project
            // resolution: the frame only zooms its display.
            gameResolution: {
              width: project.getGameResolutionWidth(),
              height: project.getGameResolutionHeight(),
            },
          });
        } else if (previewOptions.numberOfWindows >= 1) {
          this._openPreviewWindow(project, outputDir, previewOptions);
        }
      }
    } finally {
      exporter.delete();
      previewExportOptions.delete();
    }

    const previewStopTime = performance.now();
    console.info(
      `[LocalPreviewLauncher] Preview #${previewId} took ${previewStopTime -
        previewStartTime}ms`
    );
  };

  getPreviewDebuggerServer(): any {
    return localPreviewDebuggerServer;
  }

  _checkSubscriptionForNetworkPreview = (): any => {
    if (!this._networkPreviewSubscriptionChecker) return true;

    return this._networkPreviewSubscriptionChecker.checkUserHasSubscription();
  };

  render(): any {
    const {
      networkPreviewDialogOpen,
      networkPreviewHost,
      networkPreviewPort,
      networkPreviewError,
    } = this.state;

    return (
      <React.Fragment>
        <SubscriptionChecker
          ref={subscriptionChecker =>
            (this._networkPreviewSubscriptionChecker = subscriptionChecker)
          }
          onChangeSubscription={() =>
            this.setState({ networkPreviewDialogOpen: false })
          }
          id="Preview over wifi"
          title={<Trans>Preview over wifi</Trans>}
          placementId="preview-wifi"
          mode="try"
          isNotShownDuringInAppTutorial
        />
        <SubscriptionChecker
          ref={subscriptionChecker =>
            (this._hotReloadSubscriptionChecker = subscriptionChecker)
          }
          id="Hot reloading"
          title={
            <Trans>Live preview (apply changes to the running preview)</Trans>
          }
          placementId="hot-reloading"
          mode="try"
          isNotShownDuringInAppTutorial
        />
        <LocalNetworkPreviewDialog
          open={networkPreviewDialogOpen}
          url={
            networkPreviewHost && networkPreviewPort
              ? `${networkPreviewHost}:${networkPreviewPort}`
              : null
          }
          error={networkPreviewError}
          onClose={() => this.setState({ networkPreviewDialogOpen: false })}
          onExport={this.props.onExport}
          onRunPreviewLocally={this._openPreviewBrowserWindow}
        />
      </React.Fragment>
    );
  }
}
