// @flow

/**
 * Phase 17 ([P17-preview-reload]) — the preview hop of the asset hot-reload.
 *
 * A launched (separate-window) preview serves COPIES of the project's
 * resources from its export folder, and the runtime cannot re-fetch a
 * changed file in place: the resource caches are keyed by URL and only the
 * in-game edition gets cache-busting URLs (see GDJS
 * `ResourceLoader.getFullUrl` and `pixi-image-manager._loadTexture`, which
 * returns early for a cached texture). The one reliable refresh is a
 * re-export of the preview followed by a hard reload of the preview windows
 * — exactly the sequence of upstream's `relaunchAndHardReloadAllPreviews`.
 *
 * This module is the seam between the fork's asset-reload paths (the
 * debounced auto-reload of `ForkAssetAutoReload` and the manual "Reload
 * from disk" of `ForkAssetReload`) and the MainFrame, which owns the
 * preview launcher: a reload path calls `notifyForkAssetPreviewsShouldReload`
 * once a changed asset was actually reloaded on the editor side, and the
 * MainFrame registers what that means for previews (nothing when no preview
 * is running). Keeping it a registry (like the ResourcesWatcher external
 * change callbacks) keeps the fork files React-free and independently
 * testable.
 */

export type ForkAssetPreviewReloader = () => void;

const reloaders: Set<ForkAssetPreviewReloader> = new Set();

/**
 * Register what a preview refresh means in the host (the MainFrame). Returns
 * the unregister function — an effect's cleanup can return it directly.
 */
export const registerForkAssetPreviewReloader = (
  reloader: ForkAssetPreviewReloader
): (() => void) => {
  reloaders.add(reloader);
  return () => {
    reloaders.delete(reloader);
  };
};

/**
 * Tell the host that a changed asset was reloaded and running previews
 * should be refreshed. Never throws: a failing reloader is contained so the
 * reload path that fired the notification still completes.
 */
export const notifyForkAssetPreviewsShouldReload = (): void => {
  for (const reloader of Array.from(reloaders)) {
    try {
      reloader();
    } catch (error) {
      console.error('A fork asset preview reloader threw (ignored):', error);
    }
  }
};
