// @flow
import * as React from 'react';

import {
  getByokGameCodeStore,
  getProjectGameCodeFolderName,
  type ByokGameCodeFileInfo,
  type ByokGameCodeStore,
} from './ByokGameCodeStore';
import { type SetupResourcesWatcher } from '../../../ProjectsStorage/LocalFileStorageProvider/LocalFileResourcesWatcher';
import { ensureByokGameCodeCarrier } from './ByokGameCodeCarrier';
import {
  getByokGameCodeNamespaceExpression,
  getByokGameCodeNamespacePrologue,
  normalizeByokGameCodeRelativePath,
} from './ByokGameCodeCore';
import { startByokGameCodeAutoReload } from './ByokGameCodeAutoReload';
import { makeNewGameCodeFileName } from './GameCodeTree';
import {
  useStableUpToDateCallback,
  useStableUpToDateRef,
} from '../../../Utils/UseStableUpToDateCallback';

/**
 * Step 15.5 — the orchestration of the game-code pane, as a hook.
 *
 * The pane is a SECOND writer of the game-code folder (next to the AI
 * tools), so every mutation of the pane follows the same rule as the tools:
 * store operation, then `ensureByokGameCodeCarrier` with the FRESH store
 * listing (a rename or a delete that skipped the carrier would leave the
 * exporter shipping the old path), then the reload — a hard one for a
 * deletion or a rename, because a removed script cannot be unloaded from a
 * running page (D15-13).
 *
 * Every dependency has a production default and can be injected, so the
 * specs drive fakes (the ByokGameCodeHotReload pattern).
 */

export type ByokGameCodePaneReloadFunction = (options: {|
  project: any,
  hardReload?: boolean,
|}) => Promise<{| success: boolean, message: string, details?: Object |}>;

export type ByokGameCodePaneSaveResult =
  | {| ok: true |}
  | {| ok: false, error: string |};

const describeError = (error: mixed): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Resolve the real Phase 15.4 reload at CALL time (the deferred-require
 * pattern of ByokGameCodeTools.js): the module drags the local exporter
 * (LocalFileSystem reads `path` at module scope), which the specs that stub
 * the filesystem away must not load.
 */
const loadDefaultReloadGameCode = (): ?ByokGameCodePaneReloadFunction => {
  const hotReloadModule = require('./ByokGameCodeHotReload');
  const reload: any = hotReloadModule.reloadByokGameCode;
  return typeof reload === 'function'
    ? (reload: ByokGameCodePaneReloadFunction)
    : null;
};

/** The last segment of a namespace expression: `GameCode.character.spawn`. */
const getNamespaceLeafName = (namespaceExpression: string): string => {
  const segments = namespaceExpression.split('.');
  return segments[segments.length - 1] || 'game';
};

/**
 * The content of a file created from the tree: the namespace prologue the
 * D15-12 convention asks every file to start with, plus a working example.
 */
export const makeStarterGameCodeContent = (relativePath: string): string => {
  const leafName = getNamespaceLeafName(
    getByokGameCodeNamespaceExpression(relativePath)
  );
  return [
    '// New game code file.',
    `// Publishes into the namespace: ${getByokGameCodeNamespaceExpression(
      relativePath
    )}`,
    '',
    getByokGameCodeNamespacePrologue(relativePath),
    '',
    `${leafName} = {`,
    '  hello() {',
    '    console.log("Hello from game code!");',
    '  },',
    '};',
    '',
  ].join('\n');
};

type PaneStateDeps = {|
  /** The open project, or null (the pane then shows a "no project" note). */
  project: any,
  store?: ByokGameCodeStore,
  ensureCarrier?: typeof ensureByokGameCodeCarrier,
  reloadGameCode?: ?ByokGameCodePaneReloadFunction,
  /** The watcher seam of startByokGameCodeAutoReload. */
  setupWatcher?: SetupResourcesWatcher,
  /** The watcher debounce; the auto-reload default is 500 ms. */
  debounceDelayMs?: number,
|};

export type ByokGameCodePaneState = {|
  gameCodeFolderName: ?string,
  files: Array<ByokGameCodeFileInfo>,
  isLoading: boolean,
  statusMessage: ?string,
  selectedRelativePath: ?string,
  /** The content of the selected file, as it last was on disk. */
  contentOnDisk: string,
  isAutoReloadEnabled: boolean,
  setIsAutoReloadEnabled: boolean => void,
  dirtyRelativePaths: Array<string>,
  openFile: (relativePath: string) => void,
  createFileInFolder: (folderPath: string) => Promise<void>,
  renameFile: (
    fromRelativePath: string,
    toRelativePath: string
  ) => Promise<void>,
  deleteFile: (relativePath: string) => Promise<void>,
  saveFile: (
    relativePath: string,
    content: string
  ) => Promise<ByokGameCodePaneSaveResult>,
  setFileDirtyState: (relativePath: string, isDirty: boolean) => void,
  /** Surface a refusal or an error in the pane (A15-3 refusals...). */
  showStatusMessage: (message: string) => void,
  clearStatusMessage: () => void,
|};

/**
 * State and actions of the game-code pane. The component glue lives in
 * GameCodePane.js; this hook owns every store/project-model interaction.
 */
export const useByokGameCodePaneState = (
  deps: PaneStateDeps
): ByokGameCodePaneState => {
  const { project } = deps;
  const store = deps.store || getByokGameCodeStore();
  const ensureCarrier = deps.ensureCarrier || ensureByokGameCodeCarrier;

  const [files, setFiles] = React.useState<Array<ByokGameCodeFileInfo>>([]);
  const [isLoading, setIsLoading] = React.useState<boolean>(false);
  const [statusMessage, setStatusMessage] = React.useState<?string>(null);
  const [
    selectedRelativePath,
    setSelectedRelativePath,
  ] = React.useState<?string>(null);
  const [contentOnDisk, setContentOnDisk] = React.useState<string>('');
  const [isAutoReloadEnabled, setIsAutoReloadEnabled] = React.useState<boolean>(
    true
  );
  const [dirtyRelativePaths, setDirtyRelativePaths] = React.useState<
    Array<string>
  >([]);

  const projectRef = useStableUpToDateRef<any>(project);
  // Read at event time by the auto-reload (the D15-6 setting is never
  // captured once).
  const isEnabledRef = React.useRef<boolean>(true);
  isEnabledRef.current = isAutoReloadEnabled;

  const gameCodeFolderName: ?string = project
    ? getProjectGameCodeFolderName(project)
    : null;

  const describeReloadOutcome = (report: {|
    success: boolean,
    message: string,
    details?: Object,
  |}): void => {
    // No preview running is the normal desktop case — not an error to show.
    if (report.success || report.message.includes('No preview is running')) {
      return;
    }
    setStatusMessage(report.message);
  };

  /**
   * Re-read the selected file after the folder changed, and hand the fresh
   * disk state to the open editor (which shows the incoming-content banner
   * if the user was typing — D15-7). A selected file that no longer reads
   * (deleted elsewhere) is closed.
   */
  const refreshSelectedFile = async (): Promise<void> => {
    const currentProject = projectRef.current;
    if (!currentProject || !selectedRelativePath) return;
    const folderName = getProjectGameCodeFolderName(currentProject);
    const read = await store.readFile(
      currentProject.getProjectFile(),
      folderName,
      selectedRelativePath
    );
    if (read.ok) {
      setContentOnDisk(read.data);
    } else {
      setSelectedRelativePath(null);
      setContentOnDisk('');
    }
  };

  /** List the folder, update the pane and sync the carrier (the mandate). */
  const refreshListing = async (): Promise<void> => {
    const currentProject = projectRef.current;
    if (!currentProject) return;
    const folderName = getProjectGameCodeFolderName(currentProject);
    setIsLoading(true);
    try {
      const listed = await store.listFiles(
        currentProject.getProjectFile(),
        folderName
      );
      if (!listed.ok) {
        setStatusMessage(listed.error);
        return;
      }
      setFiles(listed.data);
      await refreshSelectedFile();
    } finally {
      setIsLoading(false);
    }
  };

  /** Fire the reload (D15-13: hard for a deletion or a rename). */
  const runReload = async (hardReload: boolean): Promise<void> => {
    const currentProject = projectRef.current;
    if (!currentProject) return;
    let reloadGameCode: ?ByokGameCodePaneReloadFunction =
      deps.reloadGameCode !== undefined ? deps.reloadGameCode : null;
    if (!reloadGameCode) {
      try {
        reloadGameCode = loadDefaultReloadGameCode();
      } catch (error) {
        reloadGameCode = null;
      }
    }
    if (!reloadGameCode) return;
    try {
      const report = await reloadGameCode({
        project: currentProject,
        hardReload,
      });
      describeReloadOutcome(report);
    } catch (error) {
      setStatusMessage(describeError(error));
    }
  };

  /**
   * The sequence every pane mutation ends with: a fresh listing, the carrier
   * synced with exactly that listing, the pane state updated, the open file
   * re-read, then the reload when the mutation removed a script.
   */
  const runAfterMutation = async (options: {|
    hardReload: boolean,
  |}): Promise<void> => {
    const currentProject = projectRef.current;
    if (!currentProject) return;
    const folderName = getProjectGameCodeFolderName(currentProject);
    const listed = await store.listFiles(
      currentProject.getProjectFile(),
      folderName
    );
    if (!listed.ok) {
      setStatusMessage(listed.error);
      return;
    }
    try {
      ensureCarrier({
        project: currentProject,
        gameCodeFolderName: folderName,
        relativePaths: listed.data.map(file => file.relativePath),
      });
    } catch (error) {
      setStatusMessage(describeError(error));
      return;
    }
    setFiles(listed.data);
    await refreshSelectedFile();
    if (options.hardReload) await runReload(true);
  };

  // Stable wrappers: user actions and the auto-reload always call the latest
  // closures, even after awaits.
  const stableRefreshListing = useStableUpToDateCallback<Promise<void>, void>(
    refreshListing
  );
  const stableRunReload = useStableUpToDateCallback<Promise<void>, boolean>(
    runReload
  );
  const stableRunAfterMutation = useStableUpToDateCallback<
    Promise<void>,
    {| hardReload: boolean |}
  >(runAfterMutation);

  // One auto-reload subscription while a project is open (D15-6).
  const hasProject: boolean = !!project;
  React.useEffect(
    () => {
      if (!hasProject) return undefined;
      return startByokGameCodeAutoReload({
        getProject: () => projectRef.current,
        isEnabled: () => isEnabledRef.current,
        onReload: async trigger => {
          await stableRefreshListing();
          await stableRunReload(trigger.wasDeleted);
        },
        setupWatcher: deps.setupWatcher,
        debounceDelayMs: deps.debounceDelayMs,
      });
    },
    [
      hasProject,
      deps.setupWatcher,
      deps.debounceDelayMs,
      projectRef,
      stableRefreshListing,
      stableRunReload,
    ]
  );

  // Initial listing when the project appears.
  React.useEffect(
    () => {
      if (hasProject) stableRefreshListing();
    },
    [hasProject, stableRefreshListing]
  );

  // Load the content of the selected file (and drop it if it disappeared).
  React.useEffect(
    () => {
      if (!selectedRelativePath) {
        setContentOnDisk('');
        return undefined;
      }
      let isCancelled = false;
      const readSelectedFile = async (): Promise<void> => {
        const currentProject = projectRef.current;
        if (!currentProject) return;
        const folderName = getProjectGameCodeFolderName(currentProject);
        const read = await store.readFile(
          currentProject.getProjectFile(),
          folderName,
          selectedRelativePath
        );
        if (isCancelled) return;
        if (read.ok) {
          setContentOnDisk(read.data);
        } else {
          setSelectedRelativePath(null);
          setContentOnDisk('');
        }
      };
      readSelectedFile();
      return () => {
        isCancelled = true;
      };
    },
    [selectedRelativePath, store, projectRef]
  );

  const openFile = React.useCallback((relativePath: string) => {
    const check = normalizeByokGameCodeRelativePath(relativePath);
    if (!check.ok) {
      setStatusMessage(check.error);
      return;
    }
    setSelectedRelativePath(check.relativePath);
  }, []);

  const createFileInFolder = async (folderPath: string): Promise<void> => {
    const currentProject = projectRef.current;
    if (!currentProject) return;
    const folderName = getProjectGameCodeFolderName(currentProject);
    const newFileName = makeNewGameCodeFileName(
      files.map(file => file.relativePath),
      folderPath
    );
    const newRelativePath = folderPath
      ? folderPath + '/' + newFileName
      : newFileName;
    const check = normalizeByokGameCodeRelativePath(newRelativePath);
    if (!check.ok) {
      setStatusMessage(check.error);
      return;
    }
    const written = await store.writeFile(
      currentProject.getProjectFile(),
      folderName,
      check.relativePath,
      makeStarterGameCodeContent(check.relativePath)
    );
    if (!written.ok) {
      setStatusMessage(written.error);
      return;
    }
    await stableRunAfterMutation({ hardReload: false });
    setSelectedRelativePath(check.relativePath);
  };

  const renameFile = async (
    fromRelativePath: string,
    toRelativePath: string
  ): Promise<void> => {
    const currentProject = projectRef.current;
    if (!currentProject) return;
    const folderName = getProjectGameCodeFolderName(currentProject);
    // Defense in depth: the tree already normalized the candidate and the
    // store re-checks it, but the gate runs here too (A15-3).
    const check = normalizeByokGameCodeRelativePath(toRelativePath);
    if (!check.ok) {
      setStatusMessage(check.error);
      return;
    }
    const renamed = await store.renameFile(
      currentProject.getProjectFile(),
      folderName,
      fromRelativePath,
      check.relativePath
    );
    if (!renamed.ok) {
      setStatusMessage(renamed.error);
      return;
    }
    await stableRunAfterMutation({ hardReload: true });
    if (selectedRelativePath === fromRelativePath) {
      setSelectedRelativePath(check.relativePath);
    }
  };

  const deleteFile = async (relativePath: string): Promise<void> => {
    const currentProject = projectRef.current;
    if (!currentProject) return;
    const folderName = getProjectGameCodeFolderName(currentProject);
    const check = normalizeByokGameCodeRelativePath(relativePath);
    if (!check.ok) {
      setStatusMessage(check.error);
      return;
    }
    const deleted = await store.deleteFile(
      currentProject.getProjectFile(),
      folderName,
      check.relativePath
    );
    if (!deleted.ok) {
      setStatusMessage(deleted.error);
      return;
    }
    await stableRunAfterMutation({ hardReload: true });
  };

  const saveFile = async (
    relativePath: string,
    content: string
  ): Promise<ByokGameCodePaneSaveResult> => {
    const currentProject = projectRef.current;
    if (!currentProject) {
      return { ok: false, error: 'No project is open.' };
    }
    const folderName = getProjectGameCodeFolderName(currentProject);
    const check = normalizeByokGameCodeRelativePath(relativePath);
    if (!check.ok) return { ok: false, error: check.error };
    const written = await store.writeFile(
      currentProject.getProjectFile(),
      folderName,
      check.relativePath,
      content
    );
    if (!written.ok) return { ok: false, error: written.error };
    // The carrier MUST run after every pane write, with the fresh listing.
    await stableRunAfterMutation({ hardReload: false });
    await stableRunReload(false);
    return { ok: true };
  };

  const setFileDirtyState = React.useCallback(
    (relativePath: string, isDirty: boolean): void => {
      setDirtyRelativePaths(currentPaths => {
        const hasPath = currentPaths.includes(relativePath);
        if (isDirty && !hasPath) return currentPaths.concat(relativePath);
        if (!isDirty && hasPath) {
          return currentPaths.filter(path => path !== relativePath);
        }
        return currentPaths;
      });
    },
    []
  );

  const clearStatusMessage = React.useCallback((): void => {
    setStatusMessage(null);
  }, []);

  const showStatusMessage = React.useCallback((message: string): void => {
    setStatusMessage(message);
  }, []);

  // The actions that read the state they mutate go through stable wrappers,
  // so a call always runs the latest closure even after awaits.
  const stableCreateFileInFolder = useStableUpToDateCallback<
    Promise<void>,
    string
  >(createFileInFolder);
  const stableRenameFile = useStableUpToDateCallback<Promise<void>, string>(
    renameFile
  );
  const stableDeleteFile = useStableUpToDateCallback<Promise<void>, string>(
    deleteFile
  );
  const stableSaveFile = useStableUpToDateCallback<
    Promise<ByokGameCodePaneSaveResult>,
    string
  >(saveFile);

  return {
    gameCodeFolderName,
    files,
    isLoading,
    statusMessage,
    selectedRelativePath,
    contentOnDisk,
    isAutoReloadEnabled,
    setIsAutoReloadEnabled,
    dirtyRelativePaths,
    openFile,
    createFileInFolder: stableCreateFileInFolder,
    renameFile: stableRenameFile,
    deleteFile: stableDeleteFile,
    saveFile: stableSaveFile,
    setFileDirtyState,
    showStatusMessage,
    clearStatusMessage,
  };
};
