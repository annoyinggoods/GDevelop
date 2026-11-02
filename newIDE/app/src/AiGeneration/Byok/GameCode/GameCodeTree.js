// @flow
import * as React from 'react';
import { t } from '@lingui/macro';
import { I18n } from '@lingui/react';
import { type I18n as I18nType } from '@lingui/core';

import Text from '../../../UI/Text';
import IconButton from '../../../UI/IconButton';
import NewFileIcon from '../../../UI/CustomSvgIcons/Add';
import TreeView, { type TreeViewInterface } from '../../../UI/TreeView';
import { type MenuItemTemplate } from '../../../UI/Menu/Menu.flow';
import { type ByokGameCodeFileInfo } from './ByokGameCodeStore';
import { normalizeByokGameCodeRelativePath } from './ByokGameCodeCore';

/**
 * Step 15.5 — the tree of the game-code pane (A15-4).
 *
 * The tree is rooted at the game-code folder and can represent NOTHING
 * else: every item is derived from the store listing (already confined by
 * A15-3), items carry game-code-relative paths, and every path a user
 * gesture produces (rename, new file) goes through
 * `normalizeByokGameCodeRelativePath` before it leaves this component.
 * There is no item above the root to render, offer in a menu, or drop on.
 */

export type GameCodeTreeItem = {|
  +kind: 'folder' | 'file',
  /**
   * The path relative to the game-code folder ('' for the root item, which
   * IS the folder).
   */
  +relativePath: string,
  +name: string,
  +isRoot?: boolean,
  +children: ?Array<GameCodeTreeItem>,
|};

/** The folder part of a game-code-relative path ('' for a root file). */
export const getGameCodeParentFolderPath = (relativePath: string): string => {
  const separatorIndex = relativePath.lastIndexOf('/');
  return separatorIndex === -1 ? '' : relativePath.slice(0, separatorIndex);
};

/** The last segment of a game-code-relative path. */
export const getGameCodeBaseName = (relativePath: string): string => {
  const separatorIndex = relativePath.lastIndexOf('/');
  return separatorIndex === -1
    ? relativePath
    : relativePath.slice(separatorIndex + 1);
};

/**
 * Folders before files, then alphabetical (case-insensitive): the small
 * VS-Code-like ordering a game-code tree should have. The D15-3a load order
 * stays the store listing's business — this is display only.
 */
const compareGameCodeTreeItems = (
  left: GameCodeTreeItem,
  right: GameCodeTreeItem
): number => {
  if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
  const lowerLeft = left.name.toLowerCase();
  const lowerRight = right.name.toLowerCase();
  if (lowerLeft < lowerRight) return -1;
  if (lowerLeft > lowerRight) return 1;
  return 0;
};

/**
 * Build the tree from a store listing. Folders are created on the way and
 * every children list is sorted folders-first, alphabetically.
 */
export const buildGameCodeTreeItems = (
  files: $ReadOnlyArray<ByokGameCodeFileInfo>,
  gameCodeFolderName: string
): Array<GameCodeTreeItem> => {
  const rootItem: GameCodeTreeItem = {
    kind: 'folder',
    relativePath: '',
    name: gameCodeFolderName,
    isRoot: true,
    children: [],
  };

  const foldersToSort: Array<?Array<GameCodeTreeItem>> = [rootItem.children];

  const ensureFolder = (
    parent: GameCodeTreeItem,
    name: string
  ): GameCodeTreeItem => {
    const children = parent.children || [];
    const existing = children.find(
      child => child.kind === 'folder' && child.name === name
    );
    if (existing) return existing;
    const folderItem: GameCodeTreeItem = {
      kind: 'folder',
      relativePath: parent.relativePath
        ? parent.relativePath + '/' + name
        : name,
      name,
      children: [],
    };
    children.push(folderItem);
    foldersToSort.push(folderItem.children);
    return folderItem;
  };

  for (const file of files) {
    const segments = file.relativePath.split('/');
    let currentFolder = rootItem;
    // Every segment but the last is a folder to walk (or create); the last
    // one is the file itself.
    for (let index = 0; index < segments.length - 1; index++) {
      currentFolder = ensureFolder(currentFolder, segments[index]);
    }
    const fileName = segments[segments.length - 1];
    const children = currentFolder.children || [];
    children.push({
      kind: 'file',
      relativePath: file.relativePath,
      name: fileName,
      children: null,
    });
  }

  for (const children of foldersToSort) {
    if (children) children.sort(compareGameCodeTreeItems);
  }

  return [rootItem];
};

/** Find one item of the built tree by its game-code-relative path. */
export const findGameCodeTreeItemByPath = (
  items: $ReadOnlyArray<GameCodeTreeItem>,
  relativePath: string
): ?GameCodeTreeItem => {
  for (const item of items) {
    if (item.relativePath === relativePath) return item;
    const children = item.children;
    if (children) {
      const found = findGameCodeTreeItemByPath(children, relativePath);
      if (found) return found;
    }
  }
  return null;
};

/**
 * The name of a not-yet-existing "untitled" file in a folder: `untitled.js`,
 * then `untitled2.js`, `untitled3.js`... (the NewNameGenerator convention).
 */
export const makeNewGameCodeFileName = (
  existingRelativePaths: $ReadOnlyArray<string>,
  targetFolderPath: string
): string => {
  const isTaken = (fileName: string): boolean =>
    existingRelativePaths.includes(
      targetFolderPath ? targetFolderPath + '/' + fileName : fileName
    );
  if (!isTaken('untitled.js')) return 'untitled.js';
  let suffix = 2;
  while (isTaken('untitled' + suffix + '.js')) suffix++;
  return 'untitled' + suffix + '.js';
};

/**
 * The context menu of the tree, as a pure builder (spec-driven directly).
 */
export const buildGameCodeMenuTemplate = (
  i18n: I18nType,
  options: {|
    item: GameCodeTreeItem,
    onCreateFileInFolder: string => void | Promise<void>,
    onStartRenaming: GameCodeTreeItem => void,
    onDeleteFile: string => void | Promise<void>,
  |}
): Array<MenuItemTemplate> => {
  const { item } = options;
  if (item.kind === 'folder') {
    return [
      {
        label: i18n._(t`New JavaScript file`),
        click: () => options.onCreateFileInFolder(item.relativePath),
      },
    ];
  }
  return [
    {
      label: i18n._(t`Rename`),
      click: () => options.onStartRenaming(item),
      accelerator: 'F2',
    },
    { type: 'separator' },
    {
      label: i18n._(t`Delete`),
      click: () => options.onDeleteFile(item.relativePath),
      accelerator: 'Backspace',
    },
  ];
};

export type GameCodeRenameCheck =
  | {|
      ok: true,
      fromRelativePath: string,
      toRelativePath: string,
    |}
  | {| ok: false, error: string |};

/**
 * Check a rename proposed by the user (A15-3): the candidate path is the
 * file's folder plus the new name, and it goes through the confinement
 * gate BEFORE any handler or the store is reached. An escaping name
 * (`../evil.js`, an absolute path...) is refused here.
 */
export const resolveGameCodeRenamePath = (
  item: GameCodeTreeItem,
  newName: string
): GameCodeRenameCheck => {
  if (item.kind !== 'file') {
    return { ok: false, error: 'Only files can be renamed.' };
  }
  const parentFolderPath = getGameCodeParentFolderPath(item.relativePath);
  const candidatePath = parentFolderPath
    ? parentFolderPath + '/' + newName
    : newName;
  const check = normalizeByokGameCodeRelativePath(candidatePath);
  if (!check.ok) return { ok: false, error: check.error };
  return {
    ok: true,
    fromRelativePath: item.relativePath,
    toRelativePath: check.relativePath,
  };
};

const styles = {
  container: { display: 'flex', flexDirection: 'column', flex: 1 },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '4px 8px',
  },
};

type Props = {|
  gameCodeFolderName: string,
  files: $ReadOnlyArray<ByokGameCodeFileInfo>,
  selectedRelativePath: ?string,
  dirtyRelativePaths: $ReadOnlyArray<string>,
  height: number,
  onOpenFile: (relativePath: string) => void,
  /** The user asked for a new file inside this game-code folder. */
  onCreateFileInFolder: (folderPath: string) => void | Promise<void>,
  /** Both paths are already normalized and confined when this is called. */
  onRenameFile: (
    fromRelativePath: string,
    toRelativePath: string
  ) => void | Promise<void>,
  onDeleteFile: (relativePath: string) => void | Promise<void>,
  /** A path proposed by the user was refused (A15-3) — show it. */
  onRefusal: (reason: string) => void,
|};

/**
 * The game-code tree, rooted at the game-code folder and nothing above it.
 */
const GameCodeTree = ({
  gameCodeFolderName,
  files,
  selectedRelativePath,
  dirtyRelativePaths,
  height,
  onOpenFile,
  onCreateFileInFolder,
  onRenameFile,
  onDeleteFile,
  onRefusal,
}: Props): React.MixedElement => {
  const treeViewRef = React.useRef<?TreeViewInterface<GameCodeTreeItem>>(null);
  const items = React.useMemo(
    () => buildGameCodeTreeItems(files, gameCodeFolderName),
    [files, gameCodeFolderName]
  );
  const selectedItem = selectedRelativePath
    ? findGameCodeTreeItemByPath(items, selectedRelativePath)
    : null;

  const handleRename = (item: GameCodeTreeItem, newName: string): void => {
    const check = resolveGameCodeRenamePath(item, newName);
    if (!check.ok) {
      onRefusal(check.error);
      return;
    }
    onRenameFile(check.fromRelativePath, check.toRelativePath);
  };

  const handleNewFileClick = React.useCallback(
    (folderPath: string) => {
      onCreateFileInFolder(folderPath);
    },
    [onCreateFileInFolder]
  );

  const renderTreeView = (i18n: I18nType): React.Node => (
    // $FlowFixMe[incompatible-type] - TreeView typing has issues (see "treeview typing issues" in the codebase).
    <TreeView
      ref={treeViewRef}
      items={items}
      height={height}
      multiSelect={false}
      getItemId={(item: GameCodeTreeItem) => item.relativePath}
      getItemName={(item: GameCodeTreeItem) =>
        item.kind === 'file' && dirtyRelativePaths.includes(item.relativePath)
          ? item.name + ' •'
          : item.name
      }
      getItemChildren={(item: GameCodeTreeItem) => item.children}
      onClickItem={(item: GameCodeTreeItem) => {
        if (item.kind !== 'file') return;
        onOpenFile(item.relativePath);
      }}
      selectedItems={selectedItem ? [selectedItem] : []}
      onSelectItems={(selectedItems: Array<GameCodeTreeItem>) => {
        const firstItem = selectedItems[0];
        if (!firstItem || firstItem.kind !== 'file') return;
        onOpenFile(firstItem.relativePath);
      }}
      onRenameItem={handleRename}
      buildMenuTemplate={(item: GameCodeTreeItem) =>
        buildGameCodeMenuTemplate(i18n, {
          item,
          onCreateFileInFolder: handleNewFileClick,
          onStartRenaming: itemToRename => {
            if (treeViewRef.current) {
              treeViewRef.current.renameItem(itemToRename);
            }
          },
          onDeleteFile,
        })
      }
      // Moves are refused in every direction: the tree has no destination
      // outside the game-code folder to offer (A15-4), and reordering files
      // would silently change the D15-3a load order.
      canMoveSelectionToItem={() => false}
      onMoveSelectionToItem={() => {}}
      reactDndType="game-code-tree-item"
      shouldSelectUponContextMenuOpening
      forceAllOpened
    />
  );

  return (
    <I18n>
      {({ i18n }) => (
        <div style={styles.container}>
          <div style={styles.header}>
            <Text noMargin size="body-small">
              {gameCodeFolderName + '/'}
            </Text>
            <IconButton
              size="small"
              tooltip={t`New JavaScript file`}
              onClick={() => handleNewFileClick('')}
            >
              <NewFileIcon />
            </IconButton>
          </div>
          {renderTreeView(i18n)}
        </div>
      )}
    </I18n>
  );
};

export default GameCodeTree;
