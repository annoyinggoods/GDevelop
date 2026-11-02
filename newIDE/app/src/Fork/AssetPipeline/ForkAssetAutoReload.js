// @flow

/**
 * Phase 17.6 — the automatic half of the asset hot-reload (D17-7).
 *
 * Subscribes to the watcher's CHANGED files (the ResourcesWatcher file
 * events), gated by the `autoReload` setting (re-read on every event),
 * debounces the burst, and fires the existing external-change trigger for
 * each changed file that IS a project resource (matched by file, then by
 * name) — the URL cache bursts and the editors reload exactly as an
 * external edit already does. Non-resource files (a script, a config)
 * pass through untouched: bursting them would reload nothing.
 *
 * When a burst actually reloaded at least one resource, the preview reload
 * seam is notified too ([P17-preview-reload]) so the MainFrame can refresh
 * any launched (separate-window) preview — once per burst, never for an
 * unrelated file change.
 *
 * In the browser build there is no watcher, so this never fires.
 */

import {
  registerOnProjectFileEventCallback,
  unregisterOnProjectFileEventCallback,
  triggerOnResourceExternallyChanged,
} from '../../MainFrame/ResourcesWatcher';
import { notifyForkAssetPreviewsShouldReload } from './ForkAssetPreviewReload';
import { getForkAssetPipelineSettings } from './ForkAssetPipelineSettings';
import type { ForkAssetFileEvent } from './ForkAssetAutoRegister';

const DEFAULT_DEBOUNCE_DELAY_MS = 1000;

/** The default subscription: the ResourcesWatcher file-event registry. */
const defaultSubscribe = (
  callback: (event: ForkAssetFileEvent) => void
): (() => void) => {
  const id = registerOnProjectFileEventCallback(callback);
  return () => unregisterOnProjectFileEventCallback(id);
};

/** The identifiers a project resource can be seen under on disk. */
const collectProjectResourceIdentifiers = (project: any): Set<string> => {
  const identifiers: Set<string> = new Set<string>();
  if (!project || typeof project.getResourcesManager !== 'function') {
    return identifiers;
  }
  const resourcesManager = project.getResourcesManager();
  for (const name of resourcesManager.getAllResourceNames().toJSArray()) {
    const resource = resourcesManager.getResource(name);
    const file =
      typeof resource.getFile === 'function' ? resource.getFile() : '';
    if (file) identifiers.add(file.replace(/\\/g, '/'));
    identifiers.add(name);
  }
  return identifiers;
};

export type ForkAssetAutoReloadOptions = {|
  +project: any,
  /** The D17-7 setting — defaults to the settings store's `autoReload`. */
  +isEnabled?: () => boolean,
  /** The subscription seam (defaults to the watcher file-event registry). */
  +subscribe?: (callback: (event: ForkAssetFileEvent) => void) => () => void,
  /** The reload seam (defaults to the existing external-change trigger). */
  +onReloadIdentifier?: (identifier: string) => void,
  /**
   * The preview hop ([P17-preview-reload]) — defaults to the preview reload
   * seam. Called ONCE per burst, and only when at least one identifier was
   * actually reloaded.
   */
  +notifyPreviewReload?: () => void,
  +debounceDelayMs?: number,
|};

/**
 * Start the auto-reload. Returns the stop function (an in-flight debounce
 * is cancelled).
 */
export const startForkAssetAutoReload = (
  options: ForkAssetAutoReloadOptions
): (() => void) => {
  const { project } = options;
  if (!project || typeof project.getResourcesManager !== 'function') {
    return () => {};
  }

  const isEnabled =
    options.isEnabled || (() => getForkAssetPipelineSettings().autoReload);
  const subscribe = options.subscribe || defaultSubscribe;
  const onReloadIdentifier =
    options.onReloadIdentifier ||
    ((identifier: string) => {
      triggerOnResourceExternallyChanged({ fileIdentifier: identifier });
    });
  const notifyPreviewReload =
    options.notifyPreviewReload || notifyForkAssetPreviewsShouldReload;
  const debounceDelayMs =
    options.debounceDelayMs === undefined
      ? DEFAULT_DEBOUNCE_DELAY_MS
      : options.debounceDelayMs;

  const pendingIdentifiers: Set<string> = new Set<string>();
  let debounceTimer: ?TimeoutID = null;
  let isDisposed = false;

  const flushPendingBurst = () => {
    debounceTimer = null;
    if (isDisposed) return;
    const identifiers = Array.from(pendingIdentifiers);
    pendingIdentifiers.clear();
    // The identifiers a resource can be seen under are re-read at flush
    // time so a burst that registered a NEW resource reloads it too.
    const knownIdentifiers = collectProjectResourceIdentifiers(project);
    let reloadedCount = 0;
    for (const identifier of identifiers) {
      if (!knownIdentifiers.has(identifier)) continue;
      onReloadIdentifier(identifier);
      reloadedCount += 1;
    }
    // The preview hop fires once per burst, only when something actually
    // reloaded: an unrelated file change must not restart a running game.
    if (reloadedCount > 0) notifyPreviewReload();
  };

  const handleFileEvent = (event: ForkAssetFileEvent) => {
    if (isDisposed) return;
    // Re-read on every event: the setting can be flipped at any moment.
    if (!isEnabled()) return;
    const identifier = event.fileIdentifier;
    if (!identifier) return;
    pendingIdentifiers.add(identifier.replace(/\\/g, '/'));
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushPendingBurst, debounceDelayMs);
  };

  const unsubscribe = subscribe(handleFileEvent);

  return () => {
    isDisposed = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    pendingIdentifiers.clear();
    unsubscribe();
  };
};
