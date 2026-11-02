// @flow
import optionalRequire from '../../Utils/OptionalRequire';
import debounce from 'lodash/debounce';
import { splittedProjectFolderNames } from './LocalProjectWriter';

const path = optionalRequire('path');
const electron = optionalRequire('electron');
const ipcRenderer = electron ? electron.ipcRenderer : null;

/**
 * The kind of event the OS-level watcher saw for a file (the chokidar event
 * name, forwarded over IPC — Fork, Phase 17 [P17-kind-hint]). 'unlink' makes
 * deletions observable; 'add' vs 'change' tells a new file from an edit.
 */
export type ResourcesWatcherEventKind = 'add' | 'change' | 'unlink';

/**
 * What the resources watcher reports for one file: the file's path relative
 * to the project folder (forward slashes — the canonical resource-file
 * shape, hence the [P17-B3] field name) and what happened to it.
 */
export type ResourcesWatcherCallbackPayload = {|
  fileIdentifier: string,
  event: ResourcesWatcherEventKind,
|};

/** The chokidar kinds this renderer understands; anything else reads as a change. */
const isResourcesWatcherEventKind = (value: mixed): boolean =>
  value === 'add' || value === 'change' || value === 'unlink';

/**
 * Fork (Phase 17 [P17-B1]): the per-file debouncers used to live in a
 * `memoize` cache with no eviction, so every path ever watched kept a debounce
 * closure for the whole session. This bounded cache keeps the most recently
 * used ones only — an evicted path simply gets a fresh debouncer (a pending
 * debounced call on the evicted closure is lost, which is acceptable for a
 * path not seen in the last FORK_WATCHER_DEBOUNCER_LIMIT distinct files).
 */
const FORK_WATCHER_DEBOUNCER_LIMIT = 1000;

const debouncersByPath: Map<string, Function> = new Map();

export const getForkWatcherDebouncerCount = (): number => debouncersByPath.size;

const makeDebouncerPool = (
  fire: (filePath: string, eventKind: ResourcesWatcherEventKind) => void
): ((filePath: string, eventKind: ResourcesWatcherEventKind) => void) => {
  const debouncedCallback = (
    filePath: string,
    eventKind: ResourcesWatcherEventKind
  ) => {
    const existingDebouncer = debouncersByPath.get(filePath);
    if (existingDebouncer) {
      // Re-insert so the Map's insertion order keeps the LRU discipline.
      debouncersByPath.delete(filePath);
      debouncersByPath.set(filePath, existingDebouncer);
      existingDebouncer(eventKind);
      return;
    }
    // We can't just debounce the whole callback, it has to be done file-wise,
    // otherwise we would miss all the debounced calls but the last one.
    // See https://stackoverflow.com/questions/28787436/debounce-a-function-with-argument
    const debouncer = debounce(
      (kind: ResourcesWatcherEventKind) => {
        debouncersByPath.delete(filePath);
        fire(filePath, kind);
      },
      200,
      { leading: false, trailing: true }
    );
    debouncersByPath.set(filePath, debouncer);
    if (debouncersByPath.size > FORK_WATCHER_DEBOUNCER_LIMIT) {
      const oldestPath = debouncersByPath.keys().next().value;
      if (typeof oldestPath === 'string') {
        debouncersByPath.delete(oldestPath);
      }
    }
    debouncer(eventKind);
  };
  return debouncedCallback;
};

/**
 * The setup signature every consumer's watcher seam uses — Flow pins the
 * callback invariantly, so the one shared type keeps the seams call-compatible.
 */
export type SetupResourcesWatcher = ({|
  callback: ResourcesWatcherCallbackPayload => void,
  fileIdentifier: string,
  options?: {| isProjectSplitInMultipleFiles: boolean |},
|}) => () => void;

export const setupResourcesWatcher: SetupResourcesWatcher | void =
  ipcRenderer && path
    ? ({
        fileIdentifier,
        callback,
        options,
      }: {
        fileIdentifier: string,
        callback: ResourcesWatcherCallbackPayload => void,
        options?: {| isProjectSplitInMultipleFiles: boolean |},
      }) => {
        const folderPath = path.dirname(fileIdentifier);
        const gameFile = path.basename(fileIdentifier);
        const autosaveFile = gameFile + '.autosave';

        const debouncedCallback = makeDebouncerPool(
          (filePath: string, eventKind: ResourcesWatcherEventKind) => {
            const relativePath = path
              .relative(folderPath, filePath)
              .replace(/\\/g, '/');

            callback({ fileIdentifier: relativePath, event: eventKind });
          }
        );
        // Keep a reference to the handler so the unsubscribe can remove
        // exactly the listener WE registered: `removeAllListeners` would
        // also kill every other consumer's listener on the channel (for
        // example the game-code auto-reloader of the AI assistant).
        const onProjectFileChanged = (
          event: mixed,
          changedPath: string,
          changedEventKind?: mixed
        ) => {
          // TODO: Is it safe to let it like that since the OS could for some reason
          // do never-ending operations on the folder or its children, making the debounce
          // never ending.
          const eventKind: ResourcesWatcherEventKind = isResourcesWatcherEventKind(
            changedEventKind
          )
            ? ((changedEventKind: any): ResourcesWatcherEventKind)
            : 'change';
          debouncedCallback(changedPath, eventKind);
        };
        ipcRenderer.on('project-file-changed', onProjectFileChanged);

        // Note: this ignore list is not a list of glob. Any file that matches a string in this list will be ignored.
        // This could be improved to separate this in a list of paths, filenames, etc.
        const ignore = [
          path.sep + '.DS_Store', // macOS folder attributes file
          path.sep + '.git', // For projects using git as a versioning tool.
          path.sep + 'node_modules', // For projects using npm (node_modules has way too many files and would crash the watcher on macOS)
          path.join(folderPath, gameFile),
          path.join(folderPath, autosaveFile),
        ];
        if (options && options.isProjectSplitInMultipleFiles) {
          ignore.push(
            ...splittedProjectFolderNames.map(folderName =>
              path.join(folderPath, folderName)
            )
          );
        }
        const subscriptionIdPromise = ipcRenderer.invoke(
          'local-filesystem-watcher-setup',
          folderPath,
          JSON.stringify({
            ignore,
          })
        );

        return () => {
          ipcRenderer.removeListener(
            'project-file-changed',
            onProjectFileChanged
          );
          subscriptionIdPromise.then(subscriptionId => {
            ipcRenderer.invoke(
              'local-filesystem-watcher-disable',
              subscriptionId
            );
          });
        };
      }
    : undefined;
