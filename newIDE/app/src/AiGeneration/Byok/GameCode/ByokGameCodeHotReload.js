// @flow

/**
 * Phase 15.4 — push changed game-code files into a running preview.
 *
 * The engine's `HotReloader` diffs the `scriptFiles` it is handed on a
 * `hotReload` command against the snapshot taken when the game started, and
 * reloads a file that was ADDED (absent from the snapshot) or CHANGED (its
 * hash differs); a REMOVED one is only warned about, which is why a
 * deletion must be a hard reload (D15-13).
 *
 * The critical fact this module exists around: extension source files are
 * NOT in `scriptFiles`. `SerializeRuntimeGameOptions` (which builds
 * `scriptFiles`) runs BEFORE `ExportIndexFile` merges the used extensions'
 * source files (`GDJS/GDJS/IDE/ExporterHelper.cpp:313` vs `:335`), so the
 * game-code files would never be seen by the reloader on their own. This
 * module therefore appends its OWN `{path, hash}` entries — one per
 * game-code file — into the `runtimeGameOptions` it sends, using the
 * exported script name (the exporter copies resources FLAT) and the same
 * xxhash the exporter uses.
 *
 * Every external dependency is an optional parameter with a production
 * default, so the spec drives fakes and needs no WASM and no disk.
 */

import assignIn from 'lodash/assignIn';
import optionalRequire from '../../../Utils/OptionalRequire';
import LocalFileSystem from '../../../ExportAndShare/LocalExporters/LocalFileSystem';
import { findGDJS } from '../../../GameEngineFinder/LocalGDJSFinder';
import Window from '../../../Utils/Window';
import {
  ensureByokGameCodeCarrier,
  type ByokGameCodeCarrierResult,
} from './ByokGameCodeCarrier';
import { getByokGameCodeContentHash } from './ByokGameCodeManifest';
import {
  getByokGameCodeStore,
  getProjectGameCodeFolderName,
  type ByokGameCodeStore,
} from './ByokGameCodeStore';
import {
  getOrCreateByokPreviewSession,
  type ByokRuntimeToolDeps,
} from '../ByokRuntimeTools';
import type { ByokPreviewSession } from '../ByokPreviewSession';

export type ByokGameCodeScriptFile = {|
  /** The `<script src>` of the file in the exported game. */
  path: string,
  /** The xxhash32 (seed 0xabcd) of the file content. */
  hash: number,
|};

export type ByokGameCodeReloadReport = {|
  success: boolean,
  message: string,
  details?: Object,
|};

/**
 * How long to wait for the runtime's `hotReloader.logs` push. The export
 * itself can take seconds on a large project, and the reload is queued
 * behind whatever the game is doing.
 */
export const BYOK_GAME_CODE_HOT_RELOAD_LOGS_TIMEOUT_MS = 15000;

/**
 * The `{path, hash}` list for the game-code files, from their read
 * contents. Entries whose exported script name is unknowable are skipped
 * (the caller must have already fallen back to a hard reload for those —
 * see hasUnknowableExportedScriptName).
 */
export const buildByokGameCodeScriptFiles = (
  files: Array<{|
    relativePath: string,
    scriptName: string | null,
    content: string,
  |}>
): Array<ByokGameCodeScriptFile> => {
  const scriptFiles = [];
  for (const file of files) {
    if (!file.scriptName) continue;
    scriptFiles.push({
      path: file.scriptName,
      hash: getByokGameCodeContentHash(file.content),
    });
  }
  return scriptFiles;
};

/**
 * Merge the game-code entries into the serialized `runtimeGameOptions`.
 *
 * The game-code entries go LAST (after every engine file), and the guard
 * `initialRuntimeGameStatus.isInGameEdition` is forced to `false`: the
 * runtime silently drops the whole command when it does not match the
 * running game (`abstract-debugger-client.ts:313-317`), and a BYOK preview
 * is never an in-game-edition one.
 */
export const mergeByokGameCodeScriptFiles = (
  runtimeGameOptions: Object,
  gameCodeScriptFiles: Array<ByokGameCodeScriptFile>
): Object => {
  const existingScriptFiles = Array.isArray(runtimeGameOptions.scriptFiles)
    ? runtimeGameOptions.scriptFiles
    : [];
  const existingInitialStatus =
    runtimeGameOptions.initialRuntimeGameStatus &&
    typeof runtimeGameOptions.initialRuntimeGameStatus === 'object'
      ? runtimeGameOptions.initialRuntimeGameStatus
      : {};
  return {
    ...runtimeGameOptions,
    scriptFiles: existingScriptFiles.concat(gameCodeScriptFiles),
    initialRuntimeGameStatus: {
      ...existingInitialStatus,
      isInGameEdition: false,
    },
  };
};

const describeError = (error: mixed): string =>
  error instanceof Error ? error.message : String(error);

/** Any unknowable exported name makes the whole set unreliable (see ByokGameCodeCore). */
const hasUnknowableExportedScriptName = (
  carrier: ByokGameCodeCarrierResult
): boolean =>
  carrier.orderedRelativePaths.some(
    relativePath =>
      typeof carrier.exportedScriptNames[relativePath] !== 'string'
  );

const defaultResolveGdjsRoot = async (): Promise<string> => {
  const { gdjsRoot } = await findGDJS();
  return gdjsRoot;
};

const resolveDefaultSession = (
  runtimeDeps: ?ByokRuntimeToolDeps
): ?ByokPreviewSession => {
  if (!runtimeDeps) return null;
  return getOrCreateByokPreviewSession(runtimeDeps);
};

/**
 * Read every game-code file, pairing each with the exported script name the
 * carrier computed. One unreadable file fails the whole reload: sending a
 * partial list would half-update the running game.
 */
const readGameCodeFiles = async (
  store: ByokGameCodeStore,
  projectFile: string,
  folderName: string,
  carrier: ByokGameCodeCarrierResult
): Promise<
  | {|
      ok: true,
      files: Array<{|
        relativePath: string,
        scriptName: string | null,
        content: string,
      |}>,
    |}
  | {| ok: false, relativePath: string, error: string |}
> => {
  const files = [];
  for (const relativePath of carrier.orderedRelativePaths) {
    const read = await store.readFile(projectFile, folderName, relativePath);
    if (!read.ok) {
      return { ok: false, relativePath, error: read.error };
    }
    files.push({
      relativePath,
      scriptName: carrier.exportedScriptNames[relativePath] || null,
      content: read.data,
    });
  }
  return { ok: true, files };
};

/** Parse one WASM-serialized element to a plain object, freeing the element. */
const serializeExporterElement = (fill: (element: any) => void): Object => {
  const gd: libGDevelop = global.gd;
  const element = new gd.SerializerElement();
  try {
    fill(element);
    return JSON.parse(gd.Serializer.toJSON(element));
  } finally {
    element.delete();
  }
};

/**
 * The production export: the same plumbing as
 * LocalPreviewLauncher's `prepareExporter` + launch block, pointed at the
 * folder the running preview was launched from (the runtime fetches the
 * script paths relative to its own index.html, so a fresh export anywhere
 * else would reload STALE files).
 */
const makeDefaultRunExport = (options: {|
  getIncludeFileHashs?: () => { [string]: number },
|}) => async (exportRequest: {|
  project: any,
  sceneName: string,
  gdjsRoot: string,
|}): Promise<{| projectData: Object, runtimeGameOptions: Object |}> => {
  const pathLib = optionalRequire('path');
  if (!pathLib) {
    throw new Error('The local filesystem is not available.');
  }
  const gd: libGDevelop = global.gd;
  const localFileSystem = new LocalFileSystem({
    downloadUrlsToLocalFiles: false,
  });
  const fileSystem = assignIn(new gd.AbstractFileSystemJS(), localFileSystem);
  // BYOK previews are plain one-window gameplay previews, so the launcher
  // wrote them to `<tempDir>/preview` (LocalPreviewLauncher.prepareExporter).
  const outputDir = pathLib.join(fileSystem.getTempDir(), 'preview');
  const exporter = new gd.Exporter(fileSystem, exportRequest.gdjsRoot);
  const previewExportOptions = new gd.PreviewExportOptions(
    exportRequest.project,
    outputDir
  );
  try {
    // The running game reads this very folder: clearing it would delete the
    // files under the running preview (the default is true — the launcher
    // only turns it off in its hot-reload branch, too).
    previewExportOptions.setShouldClearExportFolder(false);
    previewExportOptions.setIsDevelopmentEnvironment(Window.isDev());
    previewExportOptions.setLayoutName(exportRequest.sceneName);
    previewExportOptions.setShouldReloadProjectData(true);
    previewExportOptions.setShouldReloadLibraries(true);
    previewExportOptions.setShouldGenerateScenesEventsCode(true);
    const includeFileHashs: { [string]: number } = options.getIncludeFileHashs
      ? options.getIncludeFileHashs()
      : {};
    for (const includeFile of Object.keys(includeFileHashs)) {
      previewExportOptions.setIncludeFileHash(
        includeFile,
        includeFileHashs[includeFile]
      );
    }

    exporter.exportProjectForPixiPreview(previewExportOptions);

    const projectData = serializeExporterElement(element =>
      exporter.serializeProjectData(
        exportRequest.project,
        previewExportOptions,
        element
      )
    );
    const runtimeGameOptions = serializeExporterElement(element =>
      exporter.serializeRuntimeGameOptions(previewExportOptions, element)
    );
    return { projectData, runtimeGameOptions };
  } finally {
    previewExportOptions.delete();
    exporter.delete();
  }
};

/**
 * Turn the runtime's pushed `hotReloader.logs` into the report. A fatal or
 * error log means the reload did not fully apply; warnings (a removed
 * script, an unknown behavior…) do not.
 */
const reportHotReloaderLogs = (
  pushedMessage: Object,
  durationMs: number
): ByokGameCodeReloadReport => {
  const logs = Array.isArray(pushedMessage && pushedMessage.logs)
    ? pushedMessage.logs
    : [];
  const errorLogs = logs.filter(
    log => log.kind === 'fatal' || log.kind === 'error'
  );
  const warningLogs = logs.filter(log => log.kind === 'warning');
  const firstMessages = logs
    .slice(0, 3)
    .map(log => (typeof log.message === 'string' ? log.message : ''))
    .filter(Boolean);

  return {
    success: errorLogs.length === 0,
    message:
      `Game code hot-reloaded in ${durationMs} ms: ` +
      `${logs.length - errorLogs.length - warningLogs.length} info, ` +
      `${warningLogs.length} warning(s), ${errorLogs.length} error(s)` +
      (firstMessages.length ? ` — ${firstMessages.join(' | ')}` : '') +
      '.',
    details: { durationMs, logs, hardReload: false },
  };
};

/**
 * Fire one debugger command without awaiting a response: the runtime never
 * answers `hotReload`/`hardReload` with a response message (the completion
 * signal is the pushed `hotReloader.logs`, or the page navigating away for
 * a hard reload), so `sendDebuggerCommand`'s own timeout rejection is
 * expected and must be contained. The send error is captured so the caller
 * can surface it if the completion signal never arrives either.
 */
const sendCommandWithoutAwaitingResponse = (
  session: ByokPreviewSession,
  command: string,
  payload?: Object
): {| getSendError: () => ?Error |} => {
  let sendError: ?Error = null;
  session.sendDebuggerCommand({ command, payload }).catch((error: Error) => {
    sendError = error;
  });
  return { getSendError: () => sendError };
};

const sendHardReload = (
  session: ByokPreviewSession,
  durationMs: number,
  reason: string
): ByokGameCodeReloadReport => {
  sendCommandWithoutAwaitingResponse(session, 'hardReload');
  return {
    success: true,
    message:
      `A hard reload of the preview was requested (${reason}): ` +
      'a deleted script cannot be unloaded from the running game, so the whole page reloads.',
    details: { durationMs, hardReload: true },
  };
};

/**
 * Reload the game-code files into the running BYOK preview.
 *
 * In order: reconcile the carrier (so the resources and the source-file
 * declarations match the folder), fail with an actionable message when no
 * preview is running, fall back to a hard reload for a deletion or an
 * unknowable exported name, then re-export, merge the game-code
 * `{path, hash}` entries into `runtimeGameOptions.scriptFiles` and push the
 * `hotReload` command over BYOK's own debugger client.
 */
export const reloadByokGameCode = async (options: {|
  project: any,
  sceneName?: string,
  /** The deletion path (D15-13): always a hard reload. */
  hardReload?: boolean,
  store?: ByokGameCodeStore,
  ensureCarrier?: typeof ensureByokGameCodeCarrier,
  getSession?: () => ?ByokPreviewSession,
  /** The runtime tools deps, used to resolve the shared preview session by default. */
  runtimeDeps?: ByokRuntimeToolDeps,
  runExport?: (exportRequest: {|
    project: any,
    sceneName: string,
    gdjsRoot: string,
  |}) => Promise<{| projectData: Object, runtimeGameOptions: Object |}>,
  resolveGdjsRoot?: () => Promise<string>,
  /**
   * The xxhash per include file, as `eventsFunctionsExtensionsContext.getIncludeFileHashs()`
   * provides them (MainFrame passes the same to the preview launcher).
   * Without them the engine files serialize with hash 0 and every engine
   * script reloads — degraded, but working.
   */
  getIncludeFileHashs?: () => { [string]: number },
  now?: () => number,
|}): Promise<ByokGameCodeReloadReport> => {
  const project = options.project;
  const now = options.now || Date.now;
  const startedAtMs = now();
  const store = options.store || getByokGameCodeStore();
  const ensureCarrier = options.ensureCarrier || ensureByokGameCodeCarrier;
  const folderName = getProjectGameCodeFolderName(project);
  const projectFile = project.getProjectFile();

  const listing = await store.listFiles(projectFile, folderName);
  if (!listing.ok) {
    return {
      success: false,
      message: `The game code folder could not be read: ${listing.error}`,
    };
  }

  const carrier = ensureCarrier({
    project,
    gameCodeFolderName: folderName,
    relativePaths: listing.data.map(file => file.relativePath),
  });

  const session = options.getSession
    ? options.getSession()
    : resolveDefaultSession(options.runtimeDeps);
  if (!session || !session.isRunning()) {
    return {
      success: false,
      message:
        'No preview is running — launch one first (start_preview), then reload the game code.',
    };
  }
  if (!session.getDebuggerState().connected) {
    return {
      success: false,
      message:
        'The preview is not connected to the debugger yet — retry in a moment.',
    };
  }

  if (carrier.removedResourceNames.length > 0) {
    return sendHardReload(
      session,
      now() - startedAtMs,
      'a game code file was deleted'
    );
  }
  if (options.hardReload) {
    return sendHardReload(
      session,
      now() - startedAtMs,
      'as requested by the caller'
    );
  }
  if (hasUnknowableExportedScriptName(carrier)) {
    return sendHardReload(
      session,
      now() - startedAtMs,
      'the exported name of a game code file could not be known'
    );
  }

  const filesRead = await readGameCodeFiles(
    store,
    projectFile,
    folderName,
    carrier
  );
  if (!filesRead.ok) {
    return {
      success: false,
      message: `The game code file "${
        filesRead.relativePath
      }" could not be read: ${filesRead.error}`,
    };
  }

  const runExport =
    options.runExport ||
    makeDefaultRunExport({
      getIncludeFileHashs: options.getIncludeFileHashs,
    });
  const resolveGdjsRoot = options.resolveGdjsRoot || defaultResolveGdjsRoot;

  let gdjsRoot;
  try {
    gdjsRoot = await resolveGdjsRoot();
  } catch (error) {
    return {
      success: false,
      message: `The game engine (GDJS) could not be found: ${describeError(
        error
      )}`,
    };
  }

  let exportResult;
  try {
    exportResult = await runExport({
      project,
      sceneName: options.sceneName || project.getFirstLayout(),
      gdjsRoot,
    });
  } catch (error) {
    return {
      success: false,
      message: `The game could not be re-exported for the hot reload: ${describeError(
        error
      )}`,
    };
  }

  const runtimeGameOptions = mergeByokGameCodeScriptFiles(
    exportResult.runtimeGameOptions,
    buildByokGameCodeScriptFiles(filesRead.files)
  );

  const send = sendCommandWithoutAwaitingResponse(session, 'hotReload', {
    shouldReloadResources: false,
    projectData: exportResult.projectData,
    runtimeGameOptions,
  });

  try {
    const pushedMessage = await session.waitForPushedDebuggerMessage({
      command: 'hotReloader.logs',
      timeoutMs: BYOK_GAME_CODE_HOT_RELOAD_LOGS_TIMEOUT_MS,
    });
    return reportHotReloaderLogs(pushedMessage, now() - startedAtMs);
  } catch (error) {
    const sendError = send.getSendError();
    return {
      success: false,
      message:
        `The hot reload was sent but the preview never reported back: ${describeError(
          error
        )}` +
        (sendError
          ? ` The command itself failed: ${describeError(sendError)}`
          : ''),
      details: { durationMs: now() - startedAtMs, hardReload: false },
    };
  }
};
