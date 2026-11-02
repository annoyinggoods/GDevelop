// @flow

/**
 * Phase 17.3 — the automatic half of the registration (D17-5).
 *
 * Subscribes to the project-folder file events (the ResourcesWatcher
 * registry MainFrame's watcher feeds — the same single-subscription
 * discipline the game-code auto-reloader uses), classifies each file by
 * the watcher's EVENT KIND ('add' | 'change' | 'unlink' — forwarded since
 * [P17-kind-hint], which is what makes a deletion observable), debounces
 * the burst, and hands it to the reconcile of ForkAssetRegistration.js.
 * When a source cannot tell the kind (a custom subscribe seam, an older
 * watcher), the file is STATTED as the fallback — the original
 * classification. Gated by the `autoRegister` setting (re-read on every
 * event, never captured once).
 *
 * In the browser build there is no watcher, so the subscription simply
 * never fires — the feature degrades silently, by design.
 *
 * Flagging the project modified is the caller's injected
 * `onProjectModified` (the Assets view wires it to
 * `UnsavedChangesContext.triggerUnsavedChanges`).
 */

import optionalRequire from '../../Utils/OptionalRequire';
import {
  registerOnProjectFileEventCallback,
  unregisterOnProjectFileEventCallback,
} from '../../MainFrame/ResourcesWatcher';
import { reconcileForkAssetResources } from './ForkAssetRegistration';
import { FORK_ASSET_INDEX_FILE_NAME } from './ForkAssetIndex';
import { getForkAssetPipelineSettings } from './ForkAssetPipelineSettings';

const fs = optionalRequire('fs');
const path = optionalRequire('path');

export type ForkAssetFileEvent = {|
  +fileIdentifier: string,
  /** The watcher's event kind; null when the source could not tell. */
  +event: ?string,
|};

const DEFAULT_DEBOUNCE_DELAY_MS = 1000;

/** Suffixes of files a download or an editor leaves half-written. */
const PARTIAL_FILE_SUFFIXES = ['.tmp', '.part', '.crdownload', '.swp', '~'];

/**
 * The default ignore list: the project file and its autosave, the index
 * sidecar (writing it must not register it as a resource!), version-control
 * and package-manager folders, hidden files, and partial downloads. Pure
 * string logic over the forward-slash, project-relative identifier.
 */
export const makeForkAssetIgnoreMatcher = (
  projectFile: string
): ((relativePath: string) => boolean) => {
  const normalizedProjectFile = projectFile.replace(/\\/g, '/');
  const gameFile = normalizedProjectFile.slice(
    normalizedProjectFile.lastIndexOf('/') + 1
  );
  return (relativePath: string) => {
    const segments = relativePath.split('/').filter(Boolean);
    if (segments.length === 0) return true;
    const fileName = segments[segments.length - 1];
    if (fileName === gameFile || fileName === gameFile + '.autosave') {
      return true;
    }
    if (fileName === FORK_ASSET_INDEX_FILE_NAME) return true;
    if (fileName.startsWith('.')) return true;
    if (PARTIAL_FILE_SUFFIXES.some(suffix => fileName.endsWith(suffix))) {
      return true;
    }
    return segments.some(segment => segment === 'node_modules');
  };
};

/** The default existence check: stat the file inside the project folder. */
const makeDefaultFileExists = (
  project: any
): ((relativePath: string) => boolean) => {
  const projectFile =
    typeof project.getProjectFile === 'function'
      ? project.getProjectFile()
      : '';
  return (relativePath: string) => {
    if (!fs || !path || !projectFile) return false;
    try {
      return fs.existsSync(path.join(path.dirname(projectFile), relativePath));
    } catch (error) {
      return false;
    }
  };
};

/** The default subscription: the ResourcesWatcher file-event registry. */
const defaultSubscribe = (
  callback: (event: ForkAssetFileEvent) => void
): (() => void) => {
  const id = registerOnProjectFileEventCallback(callback);
  return () => unregisterOnProjectFileEventCallback(id);
};

export type ForkAssetAutoRegisterOptions = {|
  +project: any,
  /** Called whenever the reconcile changed the project model. */
  +onProjectModified: () => void,
  /** The D17-5 setting — defaults to the settings store's `autoRegister`. */
  +isEnabled?: () => boolean,
  /** The subscription seam (defaults to the watcher file-event registry). */
  +subscribe?: (callback: (event: ForkAssetFileEvent) => void) => () => void,
  /** The existence check seam (defaults to an fs stat in the project folder). */
  +fileExists?: (relativePath: string) => boolean,
  /** The ignore seam (defaults to `makeForkAssetIgnoreMatcher`). */
  +ignoreMatcher?: (relativePath: string) => boolean,
  +resourceKindForExtension?: (extension: string) => string | null,
  +resourceFactory?: (kind: string) => any,
  +debounceDelayMs?: number,
|};

/**
 * Start the auto-registration. Returns the stop function: after it, no
 * further reconcile can be triggered by this subscription (an in-flight
 * debounce is cancelled).
 */
export const startForkAssetAutoRegister = (
  options: ForkAssetAutoRegisterOptions
): (() => void) => {
  const { project } = options;
  if (!project || typeof project.getProjectFile !== 'function') {
    return () => {};
  }

  const isEnabled =
    options.isEnabled || (() => getForkAssetPipelineSettings().autoRegister);
  const subscribe = options.subscribe || defaultSubscribe;
  const fileExists = options.fileExists || makeDefaultFileExists(project);
  const ignoreMatcher =
    options.ignoreMatcher ||
    makeForkAssetIgnoreMatcher(project.getProjectFile());
  const debounceDelayMs =
    options.debounceDelayMs === undefined
      ? DEFAULT_DEBOUNCE_DELAY_MS
      : options.debounceDelayMs;

  const pendingExisting: Set<string> = new Set<string>();
  const pendingGone: Set<string> = new Set<string>();
  let debounceTimer: ?TimeoutID = null;
  let isDisposed = false;

  const flushPendingBurst = () => {
    debounceTimer = null;
    if (isDisposed) return;
    const onDiskFiles = Array.from(pendingExisting);
    const deletedFiles = Array.from(pendingGone);
    pendingExisting.clear();
    pendingGone.clear();
    if (onDiskFiles.length === 0 && deletedFiles.length === 0) return;

    try {
      const result = reconcileForkAssetResources({
        project,
        onDiskFiles,
        deletedFiles,
        ignoreMatcher,
        resourceKindForExtension: options.resourceKindForExtension,
        resourceFactory: options.resourceFactory,
      });
      if (result.didModifyProject) options.onProjectModified();
    } catch (error) {
      // A failed reconcile must never take the editor down; the next burst
      // retries.
      console.error('The fork asset auto-registration failed:', error);
    }
  };

  /**
   * Whether the file exists, decided by the watcher's event kind when it
   * knows ([P17-kind-hint]) and by an existence stat otherwise (the
   * original classification, kept as the fallback).
   */
  const resolveExistsOnDisk = (
    event: ForkAssetFileEvent,
    relativePath: string
  ): boolean => {
    if (event.event === 'unlink') return false;
    if (event.event === 'add' || event.event === 'change') return true;
    return fileExists(relativePath);
  };

  const handleFileEvent = (event: ForkAssetFileEvent) => {
    if (isDisposed) return;
    // Re-read on every event: the setting can be flipped at any moment.
    if (!isEnabled()) return;
    const relativePath = event.fileIdentifier;
    if (!relativePath) return;
    if (ignoreMatcher(relativePath)) return;

    // Last event wins: a file deleted then re-created inside one burst
    // counts as existing, and the other way around.
    if (resolveExistsOnDisk(event, relativePath)) {
      pendingGone.delete(relativePath);
      pendingExisting.add(relativePath);
    } else {
      pendingExisting.delete(relativePath);
      pendingGone.add(relativePath);
    }

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushPendingBurst, debounceDelayMs);
  };

  const unsubscribe = subscribe(handleFileEvent);

  return () => {
    isDisposed = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    pendingExisting.clear();
    pendingGone.clear();
    unsubscribe();
  };
};
