// @flow

/**
 * Step 15.5 — the command that opens the game-code tab, as a module
 * singleton.
 *
 * The home page button (D15-9) must open the tab, but the `openGameCode`
 * callback lives in MainFrame's state. Drilling it through
 * `EditorTabsPaneCommonProps` + the render-editor props would add the prop
 * to two shared upstream files (EditorTabsPane.js and BaseEditor.js) that
 * are outside the phase's approved touchpoints, for a single consumer. The
 * codebase already has this exact pattern for a one-way editor command:
 * `AskAiPrefill.js` (a pending value + one registered listener). MainFrame
 * registers the real opener when it mounts; the home page button calls
 * `openByokGameCode()`, which is a no-op when no MainFrame is mounted
 * (e.g. before a project window exists — and the home page is itself
 * inside MainFrame, so the listener is always there in practice).
 */

let opener: ?() => void = null;

/**
 * Register the function that opens the game-code tab. Returns the
 * un-register function.
 */
export const registerByokGameCodeOpener = (
  newOpener: () => void
): (() => void) => {
  opener = newOpener;
  return () => {
    if (opener === newOpener) opener = null;
  };
};

/** Open the game-code tab (no-op when MainFrame has not registered). */
export const openByokGameCode = (): void => {
  if (opener) opener();
};

/** Test seam: read the registered opener (or null). */
export const getByokGameCodeOpenerForTests = (): ?() => void => opener;

/** Test seam: forget the registered opener. */
export const resetByokGameCodeOpenerForTests = (): void => {
  opener = null;
};
