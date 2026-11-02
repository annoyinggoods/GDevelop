/**
 * @jest-environment jsdom
 */
// @flow

// Type-only import: erased at compile time, loads nothing.
import type { EditorOpeningOptions } from '../../../MainFrame/EditorTabs/EditorTabsHandler';

// jsdom does not implement matchMedia, which transitive imports call at
// module load. Polyfill BEFORE anything is loaded — hence the `require`s
// instead of imports.
if (!(window: any).matchMedia) {
  (window: any).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  });
}

// EditorTabsHandler statically imports every editor container (for its
// EditorRef type union), which drags the whole editor graph — including
// PIXI, which touches a canvas at import time — into this spec. The
// containers are used ONLY in type positions there, so stubbing them keeps
// the tab registry's runtime under test.
jest.mock(
  '../../../MainFrame/EditorContainers/DebuggerEditorContainer',
  () => ({
    DebuggerEditorContainer: (props: any) => null,
  })
);
jest.mock('../../../MainFrame/EditorContainers/EventsEditorContainer', () => ({
  EventsEditorContainer: (props: any) => null,
}));
jest.mock(
  '../../../MainFrame/EditorContainers/EventsFunctionsExtensionEditorContainer',
  () => ({ EventsFunctionsExtensionEditorContainer: (props: any) => null })
);
jest.mock(
  '../../../MainFrame/EditorContainers/ExternalEventsEditorContainer',
  () => ({ ExternalEventsEditorContainer: (props: any) => null })
);
jest.mock(
  '../../../MainFrame/EditorContainers/ExternalLayoutEditorContainer',
  () => ({ ExternalLayoutEditorContainer: (props: any) => null })
);
jest.mock(
  '../../../MainFrame/EditorContainers/ResourcesEditorContainer',
  () => ({
    ResourcesEditorContainer: (props: any) => null,
  })
);
jest.mock('../../../MainFrame/EditorContainers/SceneEditorContainer', () => ({
  SceneEditorContainer: (props: any) => null,
}));
jest.mock(
  '../../../MainFrame/EditorContainers/CustomObjectEditorContainer',
  () => ({ CustomObjectEditorContainer: (props: any) => null })
);
jest.mock(
  '../../../MainFrame/EditorContainers/GameplayTestEditorContainer',
  () => ({ GameplayTestEditorContainer: (props: any) => null })
);
jest.mock('../../../MainFrame/EditorContainers/HomePage', () => ({
  renderHomePageContainer: (props: any) => null,
}));

const { editorKindToLabel } = require('../../../MainFrame/TabsTitlebarTooltip');
const {
  closeEditorTab,
  getOpenedAskAiEditor,
  getOpenedGameCodeTab,
  getEditorTabsInitialState,
  openEditorTab,
} = require('../../../MainFrame/EditorTabs/EditorTabsHandler');

/**
 * Step 15.5 — the 'game-code' tab kind registration.
 *
 * MainFrame's renderer map (`editorKindToRenderer`) is keyed by EditorKind,
 * so Flow enforces at compile time that it has a 'game-code' entry (it is
 * wired to renderGameCodeEditorContainer) — importing MainFrame here would
 * drag the whole editor graph into the spec, so the runtime assertions pin
 * the other two keyed surfaces: the titlebar label map and the tab
 * registry itself.
 */

const makeGameCodeOpeningOptions = (): EditorOpeningOptions => ({
  kind: 'game-code',
  paneIdentifier: 'center',
  label: 'Game code',
  projectItemName: null,
  renderEditorContainer: () => null,
  key: 'game-code',
});

const makeAskAiOpeningOptions = (): EditorOpeningOptions => ({
  kind: 'ask-ai',
  paneIdentifier: 'right',
  label: 'Ask AI',
  projectItemName: null,
  renderEditorContainer: () => null,
  key: 'ask-ai',
});

describe('game-code tab registration', () => {
  it('has a Game code label in the titlebar label map', () => {
    const label = editorKindToLabel['game-code'];
    expect(label).not.toBe(undefined);
    // The Lingui macro stores the source message as the Trans id.
    if (label && typeof label === 'object') {
      expect((label: any).props.id).toBe('Game code');
    }
  });

  it("uses the plain 'game-code' key (singleton, like 'ask-ai')", () => {
    // Opening the same key twice keeps exactly one tab.
    let state = getEditorTabsInitialState();
    state = openEditorTab(state, makeGameCodeOpeningOptions());
    state = openEditorTab(state, makeGameCodeOpeningOptions());
    expect(state.panes.center.editors).toHaveLength(1);
    expect(state.panes.center.editors[0].key).toBe('game-code');
  });

  it('is found by getOpenedGameCodeTab and not by getOpenedAskAiEditor', () => {
    let state = getEditorTabsInitialState();
    state = openEditorTab(state, makeGameCodeOpeningOptions());

    const openedGameCodeTab = getOpenedGameCodeTab(state);
    expect(openedGameCodeTab).not.toBe(null);
    if (openedGameCodeTab) {
      expect(openedGameCodeTab.paneIdentifier).toBe('center');
      expect(openedGameCodeTab.editorTab.kind).toBe('game-code');
      expect(openedGameCodeTab.editorTab.label).toBe('Game code');
    }
    expect(getOpenedAskAiEditor(state)).toBe(null);
  });

  it('closes cleanly and is no longer found (D15-11 close-then-reopen shape)', () => {
    let state = getEditorTabsInitialState();
    state = openEditorTab(state, makeGameCodeOpeningOptions());
    state = openEditorTab(state, makeAskAiOpeningOptions());
    const openedGameCodeTab = getOpenedGameCodeTab(state);
    if (!openedGameCodeTab) throw new Error('game-code tab not found');
    state = closeEditorTab(state, openedGameCodeTab.editorTab);

    expect(getOpenedGameCodeTab(state)).toBe(null);
    // The standalone Ask AI tab is untouched by the close.
    expect(getOpenedAskAiEditor(state)).not.toBe(null);
  });
});
