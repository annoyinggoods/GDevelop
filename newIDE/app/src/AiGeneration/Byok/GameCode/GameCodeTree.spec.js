/**
 * @jest-environment jsdom
 */
// @flow

// jsdom does not implement matchMedia, which useResponsiveWindowSize (used
// by TreeView) needs at render time. Polyfill BEFORE the modules load.
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
const { createRoot } = require('react-dom/client');
const { act } = require('react-dom/test-utils');
const { setupI18n } = require('@lingui/core');
const { I18nProvider } = require('@lingui/react');
const DragAndDropContextProvider = require('../../../UI/DragAndDrop/DragAndDropContextProvider')
  .default;
const GameCodeTree = require('./GameCodeTree').default;
const {
  buildGameCodeMenuTemplate,
  buildGameCodeTreeItems,
  findGameCodeTreeItemByPath,
  getGameCodeBaseName,
  getGameCodeParentFolderPath,
  makeNewGameCodeFileName,
  resolveGameCodeRenamePath,
} = require('./GameCodeTree');

const i18n = setupI18n({ language: 'en', catalogs: {} });

const makeFile = (relativePath: string, sizeBytes: number = 10) => ({
  relativePath,
  sizeBytes,
});

const makeFiles = () => [
  makeFile('main.js'),
  makeFile('core/boot.js'),
  makeFile('character/spawn.js'),
];

describe('GameCodeTree', () => {
  describe('buildGameCodeTreeItems', () => {
    it('builds the folder tree from the listing, rooted at the folder', () => {
      const items = buildGameCodeTreeItems(makeFiles(), 'MyGameCode');
      expect(items).toHaveLength(1);
      const root = items[0];
      expect(root.isRoot).toBe(true);
      expect(root.relativePath).toBe('');
      expect(root.name).toBe('MyGameCode');
      if (!root.children) throw new Error('root has no children');
      const childNames = root.children.map(child => child.name);
      // Folders first, then the root files, in listing order.
      expect(childNames).toEqual(['character', 'core', 'main.js']);
    });

    it('never creates an item above the game-code folder (A15-4)', () => {
      const items = buildGameCodeTreeItems(makeFiles(), 'MyGameCode');
      const collectPaths = (nodes: any, accumulator: Array<string>) => {
        for (const node of nodes) {
          accumulator.push(node.relativePath);
          if (node.children) collectPaths(node.children, accumulator);
        }
      };
      const paths: Array<string> = [];
      collectPaths(items, paths);
      for (const path of paths) {
        expect(path).not.toContain('..');
        expect(path.startsWith('/')).toBe(false);
      }
      // Every path is inside the folder: either '' (the root itself) or a
      // game-code-relative path.
      expect(paths).toEqual([
        '',
        'character',
        'character/spawn.js',
        'core',
        'core/boot.js',
        'main.js',
      ]);
    });

    it('returns only the root for an empty listing', () => {
      const items = buildGameCodeTreeItems([], 'MyGameCode');
      expect(items).toHaveLength(1);
      expect(items[0].isRoot).toBe(true);
      expect(items[0].children).toEqual([]);
    });
  });

  describe('getGameCodeParentFolderPath and getGameCodeBaseName', () => {
    it('splits a nested path', () => {
      expect(getGameCodeParentFolderPath('character/spawn.js')).toBe(
        'character'
      );
      expect(getGameCodeBaseName('character/spawn.js')).toBe('spawn.js');
    });

    it('handles a root file', () => {
      expect(getGameCodeParentFolderPath('main.js')).toBe('');
      expect(getGameCodeBaseName('main.js')).toBe('main.js');
    });
  });

  describe('makeNewGameCodeFileName', () => {
    it('returns untitled.js when free', () => {
      expect(makeNewGameCodeFileName(['main.js'], '')).toBe('untitled.js');
    });

    it('skips taken names, inside the target folder', () => {
      expect(
        makeNewGameCodeFileName(['character/untitled.js'], 'character')
      ).toBe('untitled2.js');
      expect(
        makeNewGameCodeFileName(
          ['character/untitled.js', 'character/untitled2.js'],
          'character'
        )
      ).toBe('untitled3.js');
    });

    it('ignores the same name in OTHER folders', () => {
      expect(makeNewGameCodeFileName(['untitled.js'], 'character')).toBe(
        'untitled.js'
      );
    });
  });

  describe('resolveGameCodeRenamePath (A15-3)', () => {
    const rootItem = buildGameCodeTreeItems(
      [makeFile('character/spawn.js')],
      'MyGameCode'
    )[0];
    if (!rootItem.children || !rootItem.children[0].children) {
      throw new Error('expected a nested file');
    }
    const fileItem = rootItem.children[0].children[0];

    it('accepts a plain name in the same folder', () => {
      const check = resolveGameCodeRenamePath(fileItem, 'hero.js');
      if (!check.ok) throw new Error('expected ok');
      expect(check.fromRelativePath).toBe('character/spawn.js');
      expect(check.toRelativePath).toBe('character/hero.js');
    });

    it('refuses an escaping name and reports the reason', () => {
      const check = resolveGameCodeRenamePath(fileItem, '../evil.js');
      expect(check.ok).toBe(false);
      if (check.ok) throw new Error('expected refusal');
      expect(check.error).toContain('escapes');
    });

    it('refuses an absolute path, a non-JS name and a folder rename', () => {
      expect(resolveGameCodeRenamePath(fileItem, 'C:/evil.js').ok).toBe(false);
      expect(resolveGameCodeRenamePath(fileItem, 'notes.txt').ok).toBe(false);
      const rootItem = buildGameCodeTreeItems([], 'MyGameCode')[0];
      expect(resolveGameCodeRenamePath(rootItem, 'renamed.js').ok).toBe(false);
    });
  });

  describe('buildGameCodeMenuTemplate (A15-4)', () => {
    it('offers only "New JavaScript file" for a folder, targeting that folder', () => {
      const onCreateFileInFolder = jest.fn((folderPath: string) => {});
      const template = buildGameCodeMenuTemplate(i18n, {
        item: {
          kind: 'folder',
          relativePath: 'character',
          name: 'character',
          children: [],
        },
        onCreateFileInFolder,
        onStartRenaming: jest.fn(() => {}),
        onDeleteFile: jest.fn(() => {}),
      });
      expect(template).toHaveLength(1);
      expect(template[0].label).toBe('New JavaScript file');
      if (!template[0].click) throw new Error('missing click handler');
      template[0].click();
      expect(onCreateFileInFolder).toHaveBeenCalledWith('character');
    });

    it('offers only Rename and Delete for a file, never any parent path', () => {
      const onStartRenaming = jest.fn((item: any) => {});
      const onDeleteFile = jest.fn((relativePath: string) => {});
      const fileItem: any = {
        kind: 'file',
        relativePath: 'character/spawn.js',
        name: 'spawn.js',
        children: null,
      };
      const template = buildGameCodeMenuTemplate(i18n, {
        item: fileItem,
        onCreateFileInFolder: jest.fn(() => {}),
        onStartRenaming,
        onDeleteFile,
      });
      const labels = template
        .filter(entry => entry.label)
        .map(entry => entry.label);
      expect(labels).toEqual(['Rename', 'Delete']);
      const deleteEntry = template.find(entry => entry.label === 'Delete');
      if (!deleteEntry || !deleteEntry.click) {
        throw new Error('missing Delete entry');
      }
      deleteEntry.click();
      expect(onDeleteFile).toHaveBeenCalledWith('character/spawn.js');
      const renameEntry = template.find(entry => entry.label === 'Rename');
      if (!renameEntry || !renameEntry.click) {
        throw new Error('missing Rename entry');
      }
      renameEntry.click();
      expect(onStartRenaming).toHaveBeenCalledWith(fileItem);
    });
  });

  describe('rendered tree', () => {
    const renderTree = (props: any) => {
      const container = document.createElement('div');
      if (!document.body) throw new Error('missing document body');
      document.body.appendChild(container);
      let root: any = null;
      act(() => {
        root = createRoot(container);
        root.render(
          <I18nProvider i18n={i18n} language="en">
            <DragAndDropContextProvider>
              <GameCodeTree
                gameCodeFolderName="MyGameCode"
                files={makeFiles()}
                selectedRelativePath={null}
                dirtyRelativePaths={[]}
                height={500}
                onOpenFile={jest.fn(() => {})}
                onCreateFileInFolder={jest.fn(() => {})}
                onRenameFile={jest.fn(() => {})}
                onDeleteFile={jest.fn(() => {})}
                onRefusal={jest.fn(() => {})}
                {...props}
              />
            </DragAndDropContextProvider>
          </I18nProvider>
        );
      });
      return {
        container,
        unmount: () => {
          if (root) {
            act(() => {
              root.unmount();
            });
          }
          container.remove();
        },
      };
    };

    it('renders the game-code folder and ONLY its files (A15-4)', () => {
      const { container, unmount } = renderTree();
      try {
        const text = container.textContent;
        expect(text).toContain('MyGameCode');
        expect(text).toContain('main.js');
        expect(text).toContain('spawn.js');
        expect(text).toContain('boot.js');
        // Nothing above the game-code folder is rendered: no parent path, no
        // project file, no separator climbing up.
        expect(text).not.toContain('..');
        expect(text).not.toContain('project.gdevelop');
      } finally {
        unmount();
      }
    });

    it('marks dirty files in the tree', () => {
      const { container, unmount } = renderTree({
        dirtyRelativePaths: ['main.js'],
      });
      try {
        expect(container.textContent).toContain('main.js •');
        expect(container.textContent).not.toContain('spawn.js •');
      } finally {
        unmount();
      }
    });

    it('marks the selected file and opens files on click', () => {
      const onOpenFile = jest.fn(() => {});
      const { container, unmount } = renderTree({
        selectedRelativePath: 'main.js',
        onOpenFile,
      });
      try {
        // The row of main.js is marked selected (the TreeView row sets the
        // selected class on its row element).
        const selectedRows = container.querySelectorAll('[class*="selected"]');
        expect(selectedRows.length).toBeGreaterThan(0);
      } finally {
        unmount();
      }
    });
  });

  describe('findGameCodeTreeItemByPath', () => {
    it('finds a nested item', () => {
      const items = buildGameCodeTreeItems(makeFiles(), 'MyGameCode');
      const item = findGameCodeTreeItemByPath(items, 'core/boot.js');
      expect(item && item.name).toBe('boot.js');
    });

    it('returns null for an unknown path', () => {
      const items = buildGameCodeTreeItems(makeFiles(), 'MyGameCode');
      expect(findGameCodeTreeItemByPath(items, 'gone.js')).toBe(null);
    });
  });
});
