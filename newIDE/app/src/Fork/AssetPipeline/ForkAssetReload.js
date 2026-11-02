// @flow

import { notifyForkAssetPreviewsShouldReload } from './ForkAssetPreviewReload';

/**
 * Phase 17.6 — the manual "Reload from disk" (D17-7).
 *
 * It reuses the EXISTING external-change path: `triggerOnResourceExternallyChanged`
 * (MainFrame/ResourcesWatcher.js) bursts the resource URL cache and fans
 * out to the registered editors — MainFrame's callback then notifies the
 * in-game editor with `shouldReloadResources: true` — so a manual reload
 * behaves exactly like an external edit, through the same code the watcher
 * already drives. A successful reload also notifies the preview reload seam
 * ([P17-preview-reload]) so any launched preview picks up the new file.
 */

export type ForkAssetReloadResult =
  | {| ok: true, reloadedIdentifier: string |}
  | {| ok: false, error: string |};

export type ForkAssetReloadTrigger = (resourceInfo: {|
  fileIdentifier: string,
|}) => void;

/**
 * Reload one resource from disk. The identifier sent through the trigger
 * is the resource's FILE (the same project-relative file identifier the
 * watcher events carry — [P17-B3]), falling back to the resource name when
 * the file is empty (a resource not tied to a local file has nothing to
 * reload, but the burst is still honest about what was asked).
 */
export const reloadForkResourceFromDisk = (options: {|
  resource: any,
  triggerOnResourceExternallyChanged: ForkAssetReloadTrigger,
  /** The preview hop — injectable for tests ([P17-preview-reload]). */
  notifyPreviewReload?: () => void,
|}): ForkAssetReloadResult => {
  const {
    resource,
    triggerOnResourceExternallyChanged,
    notifyPreviewReload = notifyForkAssetPreviewsShouldReload,
  } = options;
  if (!resource || typeof resource.getFile !== 'function') {
    return { ok: false, error: 'No resource was given to reload.' };
  }
  const file = typeof resource.getFile === 'function' ? resource.getFile() : '';
  const name = typeof resource.getName === 'function' ? resource.getName() : '';
  const identifier = file || name;
  if (!identifier) {
    return { ok: false, error: 'The resource has no file to reload.' };
  }
  // Nothing else happens here by design: the burst + the editor fan-out
  // ARE the reload — and the preview hop follows it.
  triggerOnResourceExternallyChanged({ fileIdentifier: identifier });
  notifyPreviewReload();
  return { ok: true, reloadedIdentifier: identifier };
};
