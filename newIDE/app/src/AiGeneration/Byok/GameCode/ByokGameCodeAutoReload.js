// @flow

/**
 * Phase 15.4 — the automatic half of the game-code hot reload (D15-6):
 * watch the project folder and reload the game code when a file of the
 * game-code folder changes, behind a setting the pane owns.
 *
 * The watcher is the project-wide `setupResourcesWatcher` (the same one the
 * resources use since the single-consumer fix), filtered here to the paths
 * that can matter: `<GameName>Code/*.js`. Everything else — the manifest,
 * unrelated project files, other folders — is ignored before the debounce
 * even arms.
 */

import {
  setupResourcesWatcher,
  type ResourcesWatcherCallbackPayload,
  type SetupResourcesWatcher,
} from '../../../ProjectsStorage/LocalFileStorageProvider/LocalFileResourcesWatcher';
import {
  getByokGameCodeStore,
  getProjectGameCodeFolderName,
  type ByokGameCodeStore,
} from './ByokGameCodeStore';

export type ByokGameCodeReloadTrigger = {|
  /** The changed path, project-relative with forward slashes. */
  changedRelativePath: string,
  /**
   * True when the file no longer reads (deleted, or unreadable): the caller
   * must then hard-reload (D15-13), because a deleted script cannot be
   * unloaded from the running game.
   */
  wasDeleted: boolean,
|};

export type ByokGameCodeAutoReloadOptions = {|
  getProject: () => any,
  /** Performs the reload (the pane wires this to reloadByokGameCode). */
  onReload: (trigger: ByokGameCodeReloadTrigger) => Promise<mixed>,
  /** The D15-6 setting — re-read on every event, never captured once. */
  isEnabled: () => boolean,
  /**
   * The subscription seam; defaults to the project-folder resources
   * watcher. The callback receives `{fileIdentifier, event}` — a
   * project-relative path with forward slashes, and the watcher's event
   * kind ('add' | 'change' | 'unlink').
   */
  setupWatcher?: SetupResourcesWatcher,
  store?: ByokGameCodeStore,
  debounceDelayMs?: number,
|};

const DEFAULT_DEBOUNCE_DELAY_MS = 500;

const defaultSetupWatcher: SetupResourcesWatcher = watcherOptions => {
  if (!setupResourcesWatcher) return () => {};
  return setupResourcesWatcher(watcherOptions);
};

const isJavaScriptPath = (identifier: string): boolean =>
  /\.js$/i.test(identifier);

/**
 * Whether a watched path is a game-code file of the CURRENT project. The
 * trailing slash in the prefix check is what keeps `MyGameCode2/x.js` out
 * of `MyGameCode/`.
 */
const isGameCodePath = (project: any, identifier: string): boolean => {
  const folderName = getProjectGameCodeFolderName(project);
  return (
    identifier.startsWith(folderName + '/') &&
    identifier.length > folderName.length + 1 &&
    isJavaScriptPath(identifier)
  );
};

/**
 * Start watching the project folder for game-code changes. Returns the
 * unsubscribe: after it, no further reload can be triggered by this
 * subscription (an in-flight reload still finishes on its own).
 */
export const startByokGameCodeAutoReload = (
  options: ByokGameCodeAutoReloadOptions
): (() => void) => {
  const initialProject = options.getProject();
  if (!initialProject || typeof initialProject.getProjectFile !== 'function') {
    return () => {};
  }

  const store = options.store || getByokGameCodeStore();
  const setupWatcher = options.setupWatcher || defaultSetupWatcher;
  const debounceDelayMs =
    options.debounceDelayMs === undefined
      ? DEFAULT_DEBOUNCE_DELAY_MS
      : options.debounceDelayMs;
  /** The disk events of the CURRENT burst, latest per path. */
  const burstEventKinds: Map<string, string> = new Map();

  let isDisposed = false;
  let debounceTimer: ?TimeoutID = null;
  let pendingChangedPath: string | null = null;
  let isReloadInFlight = false;
  let isTriggerQueued = false;
  let queuedChangedPath: string | null = null;

  const detectDeletedFile = async (
    project: any,
    changedRelativePath: string
  ): Promise<boolean> => {
    const folderName = getProjectGameCodeFolderName(project);
    const relativeWithinFolder = changedRelativePath.slice(
      folderName.length + 1
    );
    const read = await store.readFile(
      project.getProjectFile(),
      folderName,
      relativeWithinFolder
    );
    return !read.ok;
  };

  const triggerReload = async (
    project: any,
    changedRelativePath: string,
    burstEventKind: ?string
  ): Promise<void> => {
    if (isReloadInFlight) {
      // Re-entry is refused — but ONE trailing trigger is remembered,
      // otherwise the last edit of a burst during a slow reload would be
      // lost and the preview would stay silently stale.
      isTriggerQueued = true;
      queuedChangedPath = changedRelativePath;
      return;
    }
    isReloadInFlight = true;
    try {
      // The D15-6 setting is honoured at CALL time: a burst armed before
      // the setting was turned off must not fire.
      if (options.isEnabled()) {
        // The watcher's kind is authoritative for a deletion when it is
        // known ([P17-kind-hint]); the store read stays the fallback (and
        // also covers "unreadable", which no event kind expresses).
        const wasDeleted =
          burstEventKind === 'unlink' ||
          (await detectDeletedFile(project, changedRelativePath));
        await options.onReload({ changedRelativePath, wasDeleted });
      }
    } catch (error) {
      console.error('The game code auto-reload failed:', error);
    } finally {
      isReloadInFlight = false;
      if (isTriggerQueued && !isDisposed) {
        const nextChangedPath = queuedChangedPath;
        isTriggerQueued = false;
        queuedChangedPath = null;
        if (nextChangedPath) {
          triggerReload(
            project,
            nextChangedPath,
            burstEventKinds.get(nextChangedPath) || null
          );
        }
      }
    }
  };

  const flushPendingReload = () => {
    debounceTimer = null;
    if (isDisposed) return;
    const changedRelativePath = pendingChangedPath;
    pendingChangedPath = null;
    if (!changedRelativePath) return;
    const project = options.getProject();
    if (!project) return;
    triggerReload(
      project,
      changedRelativePath,
      burstEventKinds.get(changedRelativePath) || null
    );
  };

  const handleWatchedFile = (event: ResourcesWatcherCallbackPayload) => {
    if (isDisposed) return;
    // Re-read on every event: the setting can be flipped at any moment.
    if (!options.isEnabled()) return;
    if (!isGameCodePath(options.getProject(), event.fileIdentifier)) return;
    pendingChangedPath = event.fileIdentifier;
    burstEventKinds.set(event.fileIdentifier, event.event);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushPendingReload, debounceDelayMs);
  };

  const unsubscribeWatcher = setupWatcher({
    callback: handleWatchedFile,
    fileIdentifier: initialProject.getProjectFile(),
  });

  return () => {
    isDisposed = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    burstEventKinds.clear();
    unsubscribeWatcher();
  };
};
