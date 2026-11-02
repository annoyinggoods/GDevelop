/**
 * @jest-environment jsdom
 */
// @flow

// jsdom does not implement matchMedia, needed by some UI components at
// render time. Polyfill BEFORE the modules load (hence the requires).
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

const React = require('react');
// Flow types createElement as the React$CreateElement type rather than a
// callable: take it untyped for the mock factories.
const mockCreateElement: any = (React: any).createElement;
const { createRoot } = require('react-dom/client');
const { act } = require('react-dom/test-utils');
const { setupI18n } = require('@lingui/core');
const { I18nProvider } = require('@lingui/react');
const MuiThemeProvider = require('@material-ui/core/styles/MuiThemeProvider')
  .default;
const createMuiTheme = require('@material-ui/core/styles/createMuiTheme')
  .default;

// The tree and the editor are the pane's own components, already spec'd on
// their own: capture their props so the tests can drive the wiring.
let mockTreeProps: any = null;
jest.mock('./GameCodeTree', () => ({
  __esModule: true,
  default: (props: any) => {
    mockTreeProps = props;
    return mockCreateElement('div', {
      'data-testid': 'mock-game-code-tree',
    });
  },
}));
let mockEditorProps: any = null;
jest.mock('./GameCodeEditor', () => ({
  __esModule: true,
  default: (props: any) => {
    mockEditorProps = props;
    return mockCreateElement('div', {
      'data-testid': 'mock-game-code-editor',
    });
  },
}));
// AlertMessage reads two theme contexts absent under plain jsdom.
jest.mock('../../../UI/AlertMessage', () => ({
  __esModule: true,
  default: (props: any) =>
    mockCreateElement(
      'div',
      { 'data-testid': 'mock-alert-message' },
      props.children
    ),
}));

// The real EditorMosaic imports its stylesheet at module scope, which the
// Jest pipeline of this checkout cannot load from node_modules. The mosaic
// itself is upstream and exercised by every editor: the pane spec renders a
// stub that mounts every editor of the `editors` map, so the wiring stays
// under test.
let mockEditorMosaicProps: any = null;
jest.mock('../../../UI/EditorMosaic', () => ({
  __esModule: true,
  default: (props: any) => {
    mockEditorMosaicProps = props;

    return mockCreateElement(
      'div',
      { 'data-testid': 'mock-editor-mosaic' },
      Object.entries(props.editors).map(([name, editor]: [string, any]) =>
        mockCreateElement(
          'div',
          { key: name, 'data-testid': 'mock-mosaic-pane-' + name },
          mockCreateElement('div', null, editor.title ? editor.title.id : ''),
          editor.renderEditor()
        )
      )
    );
  },
}));

const GameCodePane = require('./GameCodePane').default;
const { renderGameCodeEditorContainer } = require('./GameCodePane');
const PreferencesContext = require('../../../MainFrame/Preferences/PreferencesContext')
  .default;

const i18n = setupI18n({ language: 'en', catalogs: {} });
const muiTheme = createMuiTheme();

const makeFakeStore = (
  initialFiles: { [relativePath: string]: string } = {}
) => {
  const contents: Map<string, string> = new Map(Object.entries(initialFiles));
  return {
    contents,
    listFiles: jest.fn(async () => ({
      ok: true,
      data: Array.from(contents.keys()).map(relativePath => ({
        relativePath,
        sizeBytes: 1,
      })),
    })),
    readFile: jest.fn(
      async (projectFile: string, folderName: string, relativePath: string) => {
        if (!contents.has(relativePath)) {
          return { ok: false, error: 'does not exist' };
        }
        return { ok: true, data: contents.get(relativePath) };
      }
    ),
    writeFile: jest.fn(
      async (
        projectFile: string,
        folderName: string,
        relativePath: string,
        content: string
      ) => {
        contents.set(relativePath, content);
        return { ok: true, data: { relativePath, created: true } };
      }
    ),
    deleteFile: jest.fn(
      async (projectFile: string, folderName: string, relativePath: string) => {
        contents.delete(relativePath);
        return { ok: true, data: { relativePath, deleted: true } };
      }
    ),
    renameFile: jest.fn(async () => ({ ok: true, data: {} })),
  };
};

const makeProject = () => ({
  getName: () => 'MyGame',
  getProjectFile: () => 'C:/projects/mygame.json',
});

const makeRenderProps = (project: any) => ({
  project,
  paneIdentifier: 'center',
  isActive: true,
  setToolbar: jest.fn(() => {}),
  fileMetadata: null,
  storageProvider: { internalName: 'LocalFile' },
  resourceManagementProps: {},
});

const makePreferencesValue = () =>
  ({
    getDefaultEditorMosaicNode: jest.fn(() => null),
    setDefaultEditorMosaicNode: jest.fn(() => {}),
  }: any);

const renderPane = (props: any) => {
  const container = document.createElement('div');
  if (!document.body) throw new Error('missing document body');
  document.body.appendChild(container);
  let root: any = null;
  act(() => {
    root = createRoot(container);
    root.render(
      <I18nProvider i18n={i18n} language="en">
        <MuiThemeProvider theme={muiTheme}>
          <PreferencesContext.Provider value={makePreferencesValue()}>
            <GameCodePane {...props} />
          </PreferencesContext.Provider>
        </MuiThemeProvider>
      </I18nProvider>
    );
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
};

describe('GameCodePane', () => {
  beforeEach(() => {
    mockTreeProps = null;
    mockEditorProps = null;
    mockEditorMosaicProps = null;
    (window: any).confirm = jest.fn(() => true);
  });

  it('exposes the renderer MainFrame wires for the game-code tab', () => {
    // The real render props are built by EditorTabsPane; the partial fake is
    // enough for the pane, hence the cast.
    const renderEditorContainerProps = (makeRenderProps(null): any);
    const rendered = renderGameCodeEditorContainer(renderEditorContainerProps);
    // The renderer maps the tab render props into the pane.
    expect(rendered).not.toBe(null);
    expect(mockEditorMosaicProps).toBe(null);
  });

  it('asks to open a project when there is none', () => {
    const renderChatEditor = jest.fn(() => null);
    const { container, unmount } = renderPane({
      renderEditorContainerProps: makeRenderProps(null),
      store: makeFakeStore(),
      renderChatEditor,
    });
    try {
      expect(container.textContent).toContain('Open a project');
      expect(
        container.querySelector('[data-testid="mock-editor-mosaic"]')
      ).toBe(null);
      expect(
        container.querySelector('[data-testid="mock-game-code-tree"]')
      ).toBe(null);
      expect(renderChatEditor).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });

  it('renders the tree pane and the chat pane sharing the tab render props', async () => {
    const renderChatEditor = jest.fn((renderProps: any) =>
      mockCreateElement('div', {
        'data-testid': 'mock-chat',
        'data-pane': renderProps.paneIdentifier,
      })
    );
    const renderEditorContainerProps = makeRenderProps(makeProject());
    const { container, unmount } = renderPane({
      renderEditorContainerProps,
      store: makeFakeStore({ 'main.js': 'const main = 1;' }),
      renderChatEditor,
    });
    try {
      await act(async () => {});
      // The tree is there, with the store listing.
      expect(
        container.querySelector('[data-testid="mock-game-code-tree"]')
      ).not.toBe(null);
      expect(mockTreeProps.files.map(file => file.relativePath)).toEqual([
        'main.js',
      ]);
      expect(mockTreeProps.gameCodeFolderName).toBe('MyGameCode');
      // No file is open: the editor placeholder is shown instead.
      expect(mockEditorProps).toBe(null);
      expect(container.textContent).toContain('Select a JavaScript file');
      // The chat pane got EXACTLY the tab's render props (same chat as the
      // standalone Ask AI tab: same render function, same props).
      expect(container.querySelector('[data-testid="mock-chat"]')).not.toBe(
        null
      );
      expect(renderChatEditor).toHaveBeenCalledWith(renderEditorContainerProps);
    } finally {
      unmount();
    }
  });

  it('opens a file from the tree into the editor (keyed by path)', async () => {
    const { contents } = makeFakeStore({
      'character/spawn.js': 'const spawn = 1;',
    });
    const { unmount } = renderPane({
      renderEditorContainerProps: makeRenderProps(makeProject()),
      store: {
        listFiles: jest.fn(async () => ({
          ok: true,
          data: Array.from(contents.keys()).map(relativePath => ({
            relativePath,
            sizeBytes: 1,
          })),
        })),
        readFile: jest.fn(
          async (
            projectFile: string,
            folderName: string,
            relativePath: string
          ) =>
            contents.has(relativePath)
              ? { ok: true, data: contents.get(relativePath) }
              : { ok: false, error: 'does not exist' }
        ),
        writeFile: jest.fn(async () => ({ ok: true, data: {} })),
        deleteFile: jest.fn(async () => ({ ok: true, data: {} })),
        renameFile: jest.fn(async () => ({ ok: true, data: {} })),
      },
      renderChatEditor: jest.fn(() => null),
    });
    try {
      await act(async () => {});
      await act(async () => {
        mockTreeProps.onOpenFile('character/spawn.js');
      });
      await act(async () => {});
      expect(mockEditorProps).not.toBe(null);
      expect(mockEditorProps.relativePath).toBe('character/spawn.js');
      expect(mockEditorProps.contentOnDisk).toBe('const spawn = 1;');
    } finally {
      unmount();
    }
  });

  it('deletes through the confirmation into the store and the carrier', async () => {
    const ensureCarrier = jest.fn(() => {});
    const store = makeFakeStore({ 'main.js': 'const main = 1;' });
    const { unmount } = renderPane({
      renderEditorContainerProps: makeRenderProps(makeProject()),
      store,
      ensureCarrier,
      renderChatEditor: jest.fn(() => null),
    });
    try {
      await act(async () => {});
      await act(async () => {
        mockTreeProps.onDeleteFile('main.js');
      });
      expect((window: any).confirm).toHaveBeenCalled();
      expect(store.deleteFile).toHaveBeenCalledWith(
        'C:/projects/mygame.json',
        'MyGameCode',
        'main.js'
      );
      expect(ensureCarrier).toHaveBeenCalled();
    } finally {
      unmount();
    }
  });

  it('keeps the file when the deletion is refused', async () => {
    (window: any).confirm = jest.fn(() => false);
    const store = makeFakeStore({ 'main.js': 'const main = 1;' });
    const { unmount } = renderPane({
      renderEditorContainerProps: makeRenderProps(makeProject()),
      store,
      ensureCarrier: jest.fn(() => {}),
      renderChatEditor: jest.fn(() => null),
    });
    try {
      await act(async () => {});
      await act(async () => {
        mockTreeProps.onDeleteFile('main.js');
      });
      expect(store.deleteFile).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });

  it('surfaces a refusal from the tree (A15-3/A15-4 visible)', async () => {
    const { container, unmount } = renderPane({
      renderEditorContainerProps: makeRenderProps(makeProject()),
      store: makeFakeStore({}),
      renderChatEditor: jest.fn(() => null),
    });
    try {
      await act(async () => {});
      await act(async () => {
        mockTreeProps.onRefusal('Refused: the path escapes the folder.');
      });
      const alerts = container.querySelectorAll(
        '[data-testid="mock-alert-message"]'
      );
      expect(alerts.length).toBe(1);
      expect(alerts[0].textContent).toContain('escapes');
    } finally {
      unmount();
    }
  });
});
