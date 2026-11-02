// @flow

/**
 * The preview lifecycle of the BYOK perception phase: one programmatic
 * preview the agent can start, read (console logs, crashes, live state) and
 * stop — built entirely on the existing machinery (the preview launcher
 * MainFrame registers for gameplay tests, and the debugger WebSocket
 * server it exposes). No engine or launcher change is involved.
 */

/** How many console entries are kept (the ring buffer size). */
export const BYOK_PREVIEW_LOG_BUFFER_SIZE = 200;

export type ByokPreviewLogEntry = {|
  level: string,
  text: string,
  tick: number,
|};

export type ByokPreviewCrash = {|
  text: string,
  tick: number,
|};

/** The subset of the preview launcher the session needs. */
export type ByokPreviewLauncher = {|
  launchPreview: (options: Object) => Promise<any>,
  closePreview?: (windowId?: number) => void,
  // Preferred by stop(): the Electron window id of a preview window never
  // reaches the renderer (the preview-open IPC returns nothing), so a
  // targeted close is impossible — closing all previews is the launcher's
  // own coarse counterpart, and the BYOK v1 rule is one preview at a time.
  closeAllPreviews?: () => void,
  getPreviewDebuggerServer: () => any,
|};

export type ByokPreviewSession = {|
  start: (options: {| sceneName?: string |}) => Promise<{|
    success: boolean,
    message: string,
  |}>,
  stop: () => {| success: boolean, message: string |},
  getLogs: (options: {|
    sinceIndex?: number,
    level?: string,
  |}) => Array<ByokPreviewLogEntry>,
  getLogStats: () => {| bufferedCount: number, droppedCount: number |},
  getNewErrors: () => Array<string>,
  inspectState: (options?: {|
    sceneName?: ?string,
    variablePaths?: ?Array<string>,
  |}) => Promise<{|
    success: boolean,
    message?: string,
    state?: Object,
  |}>,
  isRunning: () => boolean,
  // Whether the running game crashed (and the crash was not cleared by a
  // new start) — read by the completion gate's "no crashed previews
  // pending" check.
  hasCrashed: () => boolean,
  // ---- Debugger channel (Phase 12) ----
  // The live debugger state: which connection id the BYOK preview answers
  // on (captured from onConnectionOpened — never assumed to be the only
  // one: another preview may be connected to the same server).
  getDebuggerState: () => {| connected: boolean, debuggerId: string | null |},
  // Send ONE command to the BYOK preview's own connection and await its
  // response (targeted: `sendMessageWithResponse` would broadcast to every
  // connected preview). Rejects typed on timeout or lost connection.
  sendDebuggerCommand: (options: {|
    command: string,
    payload?: Object,
    timeoutMs?: number,
  |}) => Promise<Object>,
  // Resolve the next runtime-pushed message of this command (profiler
  // output, status…) from the buffer or a live subscription, bounded.
  waitForPushedDebuggerMessage: (options: {|
    command: string,
    timeoutMs: number,
  |}) => Promise<Object>,
|};

/**
 * True for the library warnings every preview emits (the IDE's own filter
 * — see isUnavoidableLibraryWarning in Debugger/index.js; inlined here so
 * this module does not import the whole Debugger UI).
 */
const isUnavoidableLibraryWarning = (log: {|
  group: string,
  message: string,
|}): boolean => {
  if (log.group !== 'JavaScript') return false;
  return (
    log.message.includes('Electron Security Warning') ||
    log.message.includes(
      'https://firebase.google.com/docs/storage/web/start'
    ) ||
    log.message.includes('A ping to firebase could not be made automatically')
  );
};

/**
 * Reduce the `dump` payload of a debugger `refresh` response (the
 * serialized live game) to a compact per-scene summary the model can read:
 * instance names with positions, and the scene variables. Everything is
 * read defensively — the payload is produced by the runtime's
 * circular-safe serializer, whose exact fields evolve with the engine.
 */
export const reduceByokRuntimeDump = (
  dump: any,
  options?: {|
    /** Keep only this scene (the model's `scene_name` filter). */
    sceneName?: ?string,
    /** Keep only these variable paths (the model's `variable_paths`). */
    variablePaths?: ?Array<string>,
  |}
): Object => {
  const scenes: Array<Object> = [];
  if (!dump || typeof dump !== 'object') return { scenes };

  const sceneFilter = options && options.sceneName ? options.sceneName : null;
  const variablePaths =
    options && options.variablePaths && options.variablePaths.length > 0
      ? options.variablePaths
      : null;
  const sceneStack =
    dump._sceneStack && Array.isArray(dump._sceneStack._stack)
      ? dump._sceneStack._stack
      : [];
  for (const scene of sceneStack) {
    if (!scene || typeof scene !== 'object') continue;
    const sceneName =
      typeof scene._name === 'string' ? scene._name : '(unnamed scene)';
    if (sceneFilter && sceneName !== sceneFilter) continue;
    const instances: { [objectName: string]: Array<Object> } = {};
    // Per-scene list of the object groups that were cut, with their real
    // totals. Kept OUT of `instances` so a caller iterating that map always
    // gets arrays (audit100226 TOOL-9).
    const truncatedInstanceGroups: Array<Object> = [];
    const items: any =
      scene._instances &&
      scene._instances.items &&
      typeof scene._instances.items === 'object'
        ? scene._instances.items
        : {};
    for (const objectName of Object.keys(items)) {
      const objectInstances = Array.isArray(items[objectName])
        ? items[objectName]
        : [];
      // Instance-heavy scenes serialized to ~120k chars, which the 20k tool
      // cap then cut MID-JSON — possibly without the scene the model asked
      // for, and with no tool-level truncated flag (audit100226 TOOL-9).
      const keptInstances = objectInstances
        .slice(0, BYOK_RUNTIME_INSTANCES_KEPT)
        .map(instance => ({
          name: typeof instance.name === 'string' ? instance.name : objectName,
          x: typeof instance.x === 'number' ? instance.x : null,
          y: typeof instance.y === 'number' ? instance.y : null,
          zOrder: typeof instance.zOrder === 'number' ? instance.zOrder : null,
        }));
      instances[objectName] = keptInstances;
      if (objectInstances.length > keptInstances.length) {
        // Honest about what was left out rather than a silent cut.
        truncatedInstanceGroups.push({
          objectName,
          shown: keptInstances.length,
          total: objectInstances.length,
        });
      }
    }
    scenes.push({
      name: sceneName,
      instances,
      truncatedInstanceGroups,
      variables: pickByokRuntimeVariables(
        scene._variables || {},
        variablePaths
      ),
    });
  }

  return {
    scenes,
    globalVariables: pickByokRuntimeVariables(
      dump._variables || {},
      variablePaths
    ),
  };
};

/**
 * How many instances of one object a runtime dump lists per scene.
 * Instance-heavy scenes serialized to ~120k characters, which the 20k tool
 * cap then cut MID-JSON — possibly without the scene the model asked for,
 * and with no tool-level truncated flag (audit100226 TOOL-9). Each cut group
 * is reported in the scene's `truncatedInstanceGroups`.
 */
export const BYOK_RUNTIME_INSTANCES_KEPT = 50;

/**
 * The scene/global variables the model asked for, or all of them when it
 * named none. `variable_paths` was advertised in the schema but the handler
 * ignored it, so a narrow query answered with the full multi-scene dump
 * (audit100226 TOOL-3).
 */
const pickByokRuntimeVariables = (
  variables: any,
  variablePaths: ?Array<string>
): Object => {
  if (!variablePaths) return variables;
  if (!variables || typeof variables !== 'object') return {};
  const picked: Object = {};
  for (const path of variablePaths) {
    const segments = path.split('.');
    if (segments.length === 0) continue;
    let source: any = variables;
    for (const segment of segments) {
      if (!source || typeof source !== 'object') {
        source = null;
        break;
      }
      source = source[segment];
    }
    picked[path] = source === undefined ? null : source;
  }
  return picked;
};

/** How many pushed runtime messages are kept for late subscribers. */
export const BYOK_PUSHED_MESSAGES_BUFFER_SIZE = 50;

/** Default timeout of one targeted debugger command. */
export const BYOK_DEBUGGER_COMMAND_TIMEOUT_MS = 5000;

type PendingResponse = {|
  resolve: (message: Object) => void,
  reject: (error: Error) => void,
  timer: any,
|};

type PushedWaiter = {|
  command: string,
  resolve: (payload: Object) => void,
  reject: (error: Error) => void,
  timer: any,
|};

/**
 * The launch options the preview launcher reads (`PreviewOptions` in
 * ExportAndShare/PreviewLauncher.flow.js — an exact object whose preference
 * fields are GETTERS, which is why a hand-rolled `{ sceneName, ... }` fails
 * with "options.getIsMenuBarHiddenInPreview is not a function"). The BYOK
 * preview is a plain one-window gameplay preview: every in-game-edition,
 * capture and tutorial field is off, and the two preference getters use the
 * same values the gameplay-test runner launches with (GameplayTestRunner.js).
 */
export const makeByokPreviewLaunchOptions = ({
  project,
  sceneName,
  isMenuBarHiddenInPreview = true,
  isAlwaysOnTopInPreview = false,
}: {|
  project: any,
  sceneName: string,
  isMenuBarHiddenInPreview?: boolean,
  isAlwaysOnTopInPreview?: boolean,
|}): Object => ({
  project,
  sceneName,
  externalLayoutName: null,
  eventsBasedObjectType: null,
  eventsBasedObjectVariantName: null,
  networkPreview: false,
  hotReload: false,
  shouldReloadProjectData: true,
  shouldReloadLibraries: true,
  shouldGenerateScenesEventsCode: true,
  shouldReloadResources: false,
  shouldHardReload: false,
  fullLoadingScreen: false,
  fallbackAuthor: null,
  authenticatedPlayer: null,
  isForInGameEdition: false,
  isForGameplayTest: false,
  editorId: '',
  getIsMenuBarHiddenInPreview: () => isMenuBarHiddenInPreview,
  getIsAlwaysOnTopInPreview: () => isAlwaysOnTopInPreview,
  captureOptions: null,
  onCaptureFinished: async () => {},
  inAppTutorialMessageInPreview: '',
  inAppTutorialMessagePositionInPreview: '',
  editorCameraState3D: null,
  inGameEditorSettings: null,
  numberOfWindows: 1,
  previewWindows: null,
});

/**
 * Create the BYOK preview session. `getPreviewLauncher` and `getProject`
 * are injected (in the app they resolve the launcher MainFrame registered
 * for gameplay tests, and the live project); tests inject fakes.
 */
export const createByokPreviewSession = (options: {|
  getPreviewLauncher: () => ?ByokPreviewLauncher,
  getProject: () => any,
|}): ByokPreviewSession => {
  let isRunning = false;
  let unregisterCallbacks: ?() => void = null;
  let previewLauncherAtStart: ?ByokPreviewLauncher = null;
  let logBuffer: Array<ByokPreviewLogEntry> = [];
  let newErrors: Array<string> = [];
  let crash: ?ByokPreviewCrash = null;
  // How many entries the ring buffer dropped at its head: the model's
  // `since_index` is positional, so a wrap silently shifts it — the stats
  // let the reader resync (audit011026 B-TOOL-10).
  let droppedLogCount: number = 0;
  // ---- The debugger channel state (Phase 12) ----
  let debuggerId: string | null = null;
  // The earliest time at which an incoming connection may be bound as this
  // session's debugger: Infinity until the launch resolves — connections
  // opened in that window belong to other previews (typically the user
  // launching one while the export runs) — then the moment the launch
  // resolved. stop() puts it back to Infinity so even a stale callback
  // firing cannot rebind (audit011026 B-TOOL-11: the binding is
  // first-connection-after-launch, not first-connection-overall).
  let launchBoundAtMs: number = Number.POSITIVE_INFINITY;
  let nextMessageId = 1;
  const pendingResponses: Map<number, PendingResponse> = new Map();
  const pushedMessagesBuffer: Array<{|
    command: string,
    payload: Object,
  |}> = [];
  const pushedWaiters: Array<PushedWaiter> = [];

  const failPendingDebuggerWork = (reason: string) => {
    pendingResponses.forEach(pending => {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    });
    pendingResponses.clear();
    pushedWaiters.forEach(waiter => {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    });
    pushedWaiters.length = 0;
  };

  const handlePushedMessage = (command: string, payload: Object) => {
    const waiterIndex = pushedWaiters.findIndex(
      waiter => waiter.command === command
    );
    if (waiterIndex !== -1) {
      const waiter = pushedWaiters[waiterIndex];
      pushedWaiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(payload);
      return;
    }
    pushedMessagesBuffer.push({ command, payload });
    if (pushedMessagesBuffer.length > BYOK_PUSHED_MESSAGES_BUFFER_SIZE) {
      pushedMessagesBuffer.shift();
    }
  };

  // A late push (arriving after its wait timed out or after stop) must not
  // survive into the NEXT session — the buffer-first wait used to serve the
  // previous run's profiler output as if it were current
  // (audit011026 B-TOOL-7).
  const clearPushedMessagesBuffer = (): void => {
    pushedMessagesBuffer.length = 0;
  };

  const handleParsedMessage = (parsedMessage: any): void => {
    if (!parsedMessage || typeof parsedMessage !== 'object') return;
    const command = parsedMessage.command;
    const payload = parsedMessage.payload;

    // A response to one of our targeted requests (the runtime echoes the
    // messageId we sent).
    if (typeof parsedMessage.messageId === 'number') {
      const pending = pendingResponses.get(parsedMessage.messageId);
      if (pending) {
        pendingResponses.delete(parsedMessage.messageId);
        clearTimeout(pending.timer);
        pending.resolve(parsedMessage);
        return;
      }
    }

    if (command === 'console.log' && payload && typeof payload === 'object') {
      const log = {
        group: typeof payload.group === 'string' ? payload.group : '',
        message: typeof payload.message === 'string' ? payload.message : '',
      };
      if (isUnavoidableLibraryWarning(log)) return;
      const entry: ByokPreviewLogEntry = {
        level:
          typeof payload.type === 'string' && payload.type
            ? payload.type
            : 'log',
        text: log.message,
        tick: typeof payload.timestamp === 'number' ? payload.timestamp : 0,
      };
      logBuffer.push(entry);
      if (entry.level === 'error') newErrors.push(entry.text);
      if (logBuffer.length > BYOK_PREVIEW_LOG_BUFFER_SIZE) {
        droppedLogCount += logBuffer.length - BYOK_PREVIEW_LOG_BUFFER_SIZE;
        logBuffer = logBuffer.slice(-BYOK_PREVIEW_LOG_BUFFER_SIZE);
      }
      return;
    }

    if (command === 'game.crashed') {
      crash = {
        text:
          payload && typeof payload.error === 'string'
            ? payload.error
            : JSON.stringify(payload || {}),
        tick: Date.now(),
      };
      newErrors.push(crash.text);
      handlePushedMessage('game.crashed', payload || {});
      return;
    }

    // Every other pushed runtime message (profiler.output, status…) is
    // buffered for the debugger tools' bounded waits.
    if (typeof command === 'string' && command) {
      handlePushedMessage(command, payload || {});
    }
  };

  return {
    start: async ({ sceneName }) => {
      if (isRunning) {
        return {
          success: false,
          message:
            'A preview started by this chat is already running — stop_preview it first.',
        };
      }
      const previewLauncher = options.getPreviewLauncher();
      if (!previewLauncher) {
        return {
          success: false,
          message:
            'No preview launcher is available (the editor did not register one).',
        };
      }
      const debuggerServer = previewLauncher.getPreviewDebuggerServer();
      if (
        !debuggerServer ||
        typeof debuggerServer.registerCallbacks !== 'function'
      ) {
        return {
          success: false,
          message: 'The preview debugger server is not available.',
        };
      }

      const project = options.getProject();
      logBuffer = [];
      newErrors = [];
      crash = null;
      debuggerId = null;
      launchBoundAtMs = Number.POSITIVE_INFINITY;
      droppedLogCount = 0;
      clearPushedMessagesBuffer();
      // Subscribe before launching, so no early log, crash or pushed
      // message is missed. The debugger BINDING is stricter than the
      // subscription: connections opened while the launch is still in
      // flight belong to other previews (typically the user launching one
      // during the export window) and are ignored — the first connection
      // opened after the launch resolves is this session's preview.
      unregisterCallbacks = debuggerServer.registerCallbacks({
        // The debugger server fan-out invokes every registered callback
        // (server state changes, server errors, connection errors), so each
        // one must be present — a missing callback crashes the whole app.
        onServerStateChanged: () => {},
        onErrorReceived: () => {},
        onConnectionErrored: () => {},
        onConnectionOpened: ({ id }: {| id: string |}) => {
          // Early connections (arriving before the launch resolved) are
          // other previews' — see launchBoundAtMs above.
          if (Date.now() < launchBoundAtMs) return;
          if (debuggerId === null) debuggerId = id;
        },
        onConnectionClosed: ({ id }: {| id: string |}) => {
          if (id === debuggerId) {
            debuggerId = null;
            failPendingDebuggerWork(
              'The preview debugger connection was closed.'
            );
          }
        },
        onHandleParsedMessage: ({ parsedMessage }) =>
          handleParsedMessage(parsedMessage),
      });
      try {
        await previewLauncher.launchPreview(
          makeByokPreviewLaunchOptions({
            project,
            sceneName: sceneName || project.getFirstLayout(),
          })
        );
      } catch (error) {
        if (unregisterCallbacks) unregisterCallbacks();
        unregisterCallbacks = null;
        return {
          success: false,
          message: `The preview could not be started: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      previewLauncherAtStart = previewLauncher;
      // The launch resolved: from this moment on, the first connection to
      // arrive is this session's preview (see launchBoundAtMs).
      launchBoundAtMs = Date.now();
      isRunning = true;
      return {
        success: true,
        message: sceneName
          ? `Preview started on scene "${sceneName}".`
          : 'Preview started on the first scene.',
      };
    },

    stop: () => {
      if (!isRunning) {
        return { success: false, message: 'No preview is running.' };
      }
      // The Electron window id of the preview never reaches the renderer,
      // so closePreview(windowId) cannot be targeted (the pre-Phase-12 code
      // called it with NO id — a silent no-op). closeAllPreviews is the
      // launcher's working counterpart, and the BYOK v1 rule is one
      // preview at a time.
      const launcher = previewLauncherAtStart;
      if (launcher && typeof launcher.closeAllPreviews === 'function') {
        try {
          launcher.closeAllPreviews();
        } catch (error) {
          // Closing is best-effort: the window may already be gone.
        }
      } else if (launcher && launcher.closePreview) {
        try {
          launcher.closePreview();
        } catch (error) {
          // Closing is best-effort: the window may already be gone.
        }
      }
      if (unregisterCallbacks) unregisterCallbacks();
      unregisterCallbacks = null;
      failPendingDebuggerWork('The preview was stopped.');
      isRunning = false;
      debuggerId = null;
      launchBoundAtMs = Number.POSITIVE_INFINITY;
      clearPushedMessagesBuffer();
      return { success: true, message: 'Preview stopped.' };
    },

    getLogs: ({ sinceIndex, level }) => {
      const fromIndex =
        typeof sinceIndex === 'number' && sinceIndex >= 0 ? sinceIndex : 0;
      return logBuffer
        .slice(fromIndex)
        .filter(entry => !level || entry.level === level);
    },

    getLogStats: () => ({
      bufferedCount: logBuffer.length,
      droppedCount: droppedLogCount,
    }),

    getNewErrors: () => {
      const errors = newErrors.slice();
      newErrors = [];
      return errors;
    },

    inspectState: async inspectOptions => {
      if (!isRunning) {
        return {
          success: false,
          message: 'No preview is running — start_preview first.',
        };
      }
      if (crash) {
        return {
          success: false,
          message: `The game crashed: ${crash.text}`,
        };
      }
      try {
        const response = await sendDebuggerCommandTo(
          options,
          () => debuggerId,
          pendingResponses,
          () => nextMessageId++,
          { command: 'refresh' }
        );
        return {
          success: true,
          state: reduceByokRuntimeDump(
            response && response.payload ? response.payload : null,
            inspectOptions
          ),
        };
      } catch (error) {
        return {
          success: false,
          message: `The runtime state could not be read: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },

    isRunning: () => isRunning,
    hasCrashed: () => !!crash,

    getDebuggerState: () => ({
      connected: isRunning && !!debuggerId,
      debuggerId,
    }),

    sendDebuggerCommand: async ({ command, payload, timeoutMs }) => {
      if (!isRunning) {
        throw new Error('No preview is running — start_preview first.');
      }
      if (!debuggerId) {
        throw new Error(
          'The preview is not connected to the debugger yet — retry in a moment.'
        );
      }
      return sendDebuggerCommandTo(
        options,
        () => debuggerId,
        pendingResponses,
        () => nextMessageId++,
        { command, payload, timeoutMs }
      );
    },

    waitForPushedDebuggerMessage: ({ command, timeoutMs }) =>
      new Promise<Object>((resolve, reject) => {
        const bufferedIndex = pushedMessagesBuffer.findIndex(
          buffered => buffered.command === command
        );
        if (bufferedIndex !== -1) {
          const buffered = pushedMessagesBuffer[bufferedIndex];
          pushedMessagesBuffer.splice(bufferedIndex, 1);
          resolve(buffered.payload);
          return;
        }
        const timer = setTimeout(() => {
          const waiterIndex = pushedWaiters.findIndex(
            waiter => waiter.resolve === resolve
          );
          if (waiterIndex !== -1) pushedWaiters.splice(waiterIndex, 1);
          reject(
            new Error(`No "${command}" message arrived within ${timeoutMs} ms.`)
          );
        }, timeoutMs);
        pushedWaiters.push({ command, resolve, reject, timer });
      }),
  };
};

/**
 * One targeted request/response round against the session's own debugger
 * connection — the piece `sendMessageWithResponse` cannot do (it
 * broadcasts to every connected preview).
 */
const sendDebuggerCommandTo = (
  options: {|
    getPreviewLauncher: () => ?ByokPreviewLauncher,
    getProject: () => any,
  |},
  getDebuggerId: () => string | null,
  pendingResponses: Map<number, PendingResponse>,
  allocateMessageId: () => number,
  request: {|
    command: string,
    payload?: Object,
    timeoutMs?: number,
  |}
): Promise<Object> => {
  const previewLauncher = options.getPreviewLauncher();
  const debuggerServer = previewLauncher
    ? previewLauncher.getPreviewDebuggerServer()
    : null;
  const debuggerId = getDebuggerId();
  if (!debuggerServer || !debuggerId) {
    return Promise.reject(
      new Error('The preview is not connected to the debugger.')
    );
  }
  const messageId = allocateMessageId();
  const timeoutMs =
    request.timeoutMs === undefined
      ? BYOK_DEBUGGER_COMMAND_TIMEOUT_MS
      : request.timeoutMs;
  return new Promise<Object>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingResponses.delete(messageId);
      reject(
        new Error(
          `The preview debugger did not answer "${
            request.command
          }" within ${timeoutMs} ms.`
        )
      );
    }, timeoutMs);
    pendingResponses.set(messageId, { resolve, reject, timer });
    debuggerServer.sendMessage(debuggerId, {
      command: request.command,
      payload: request.payload,
      messageId,
    });
  });
};
