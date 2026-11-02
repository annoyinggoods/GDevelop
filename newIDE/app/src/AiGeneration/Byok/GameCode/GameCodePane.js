// @flow
import { t, Trans } from '@lingui/macro';
import * as React from 'react';

import AlertMessage from '../../../UI/AlertMessage';
import Checkbox from '../../../UI/Checkbox';
import CloseButton from '../../../UI/EditorMosaic/CloseButton';
import EditorMosaic, { type EditorMosaicNode } from '../../../UI/EditorMosaic';
import { Column, Line } from '../../../UI/Grid';
import Text from '../../../UI/Text';
import { FullSizeMeasurer } from '../../../UI/FullSizeMeasurer';
import { type Editor } from '../../../UI/EditorMosaic';
import { type RenderEditorContainerPropsWithRef } from '../../../MainFrame/EditorContainers/BaseEditor';
import Window from '../../../Utils/Window';
import GameCodeEditor from './GameCodeEditor';
import {
  useByokGameCodePaneState,
  type ByokGameCodePaneReloadFunction,
} from './GameCodePaneState';
import GameCodeTree from './GameCodeTree';
import { type ByokGameCodeStore } from './ByokGameCodeStore';
import { type SetupResourcesWatcher } from '../../../ProjectsStorage/LocalFileStorageProvider/LocalFileResourcesWatcher';
import { ensureByokGameCodeCarrier } from './ByokGameCodeCarrier';

/**
 * Resolve the standalone Ask AI renderer at CALL time (the deferred-require
 * pattern of ByokGameCodeTools.js): the module drags the whole editor
 * functions graph (and PIXI, which touches a canvas at import time) into
 * every consumer, which breaks the specs that run in jsdom.
 */
const loadDefaultChatRenderer = (): (RenderEditorContainerPropsWithRef => React.Node) =>
  require('../../AskAiEditorContainer').renderAskAiEditorContainer;

/**
 * Step 15.5 — the game-code tab: a three-pane editor mosaic
 * (tree | code editor | Ask AI chat), VS-Code-like (D15-7 layout, D15-11
 * single chat).
 *
 * The chat pane renders the very same `AskAiEditor` as the standalone Ask AI
 * tab (same render function, same render props), so it shows the same chat;
 * `openGameCode` closes the standalone tab on the way in, so exactly one
 * chat UI is ever mounted.
 */

const initialMosaicEditorNodes: EditorMosaicNode = {
  direction: 'row',
  first: 'game-code-tree',
  splitPercentage: 22,
  second: {
    direction: 'row',
    first: 'game-code-editor',
    splitPercentage: 62,
    second: 'game-code-ask-ai',
  },
};

type GameCodePaneProps = {|
  renderEditorContainerProps: RenderEditorContainerPropsWithRef,
  // Injectables (production defaults in useByokGameCodePaneState):
  store?: ByokGameCodeStore,
  ensureCarrier?: typeof ensureByokGameCodeCarrier,
  reloadGameCode?: ?ByokGameCodePaneReloadFunction,
  /** The chat pane renderer; the default is the standalone Ask AI editor. */
  renderChatEditor?: RenderEditorContainerPropsWithRef => React.Node,
  setupWatcher?: SetupResourcesWatcher,
  debounceDelayMs?: number,
|};

/**
 * The game-code editor content (the tab's renderEditorContainer).
 */
const GameCodePane = (props: GameCodePaneProps): React.MixedElement => {
  const { renderEditorContainerProps } = props;
  const { project } = renderEditorContainerProps;
  const paneState = useByokGameCodePaneState({
    project,
    store: props.store,
    ensureCarrier: props.ensureCarrier,
    reloadGameCode: props.reloadGameCode,
    setupWatcher: props.setupWatcher,
    debounceDelayMs: props.debounceDelayMs,
  });
  const renderChatEditor = props.renderChatEditor || loadDefaultChatRenderer();

  if (!project) {
    return (
      <Column expand noMargin justifyContent="center" alignItems="center">
        <Text>
          <Trans>Open a project to edit its game code.</Trans>
        </Text>
      </Column>
    );
  }

  const renderCodeEditor = (): React.Node => {
    if (!paneState.selectedRelativePath) {
      return (
        <Column expand noMargin justifyContent="center" alignItems="center">
          <Text>
            <Trans>Select a JavaScript file in the tree to edit it.</Trans>
          </Text>
        </Column>
      );
    }
    return (
      <GameCodeEditor
        key={paneState.selectedRelativePath}
        relativePath={paneState.selectedRelativePath}
        contentOnDisk={paneState.contentOnDisk}
        onWriteFile={paneState.saveFile}
        onDirtyStateChange={paneState.setFileDirtyState}
      />
    );
  };

  const deleteFileAfterConfirmation = (relativePath: string): void => {
    // Window.showConfirmDialog falls back to window.confirm outside Electron.
    const confirmed = Window.showConfirmDialog(
      'Delete this game code file? A running preview will be reloaded.'
    );
    if (!confirmed) return;
    paneState.deleteFile(relativePath);
  };

  const renderTreePane = (): React.Node => (
    <Column expand noMargin>
      <Line noMargin>
        <Checkbox
          label={
            <Text noMargin size="body-small">
              <Trans>Auto-reload the preview</Trans>
            </Text>
          }
          checked={paneState.isAutoReloadEnabled}
          onCheck={(e, checked) => paneState.setIsAutoReloadEnabled(checked)}
        />
      </Line>
      <FullSizeMeasurer>
        {({ width, height }) => (
          <GameCodeTree
            gameCodeFolderName={paneState.gameCodeFolderName || ''}
            files={paneState.files}
            selectedRelativePath={paneState.selectedRelativePath}
            dirtyRelativePaths={paneState.dirtyRelativePaths}
            height={height}
            onOpenFile={paneState.openFile}
            onCreateFileInFolder={paneState.createFileInFolder}
            onRenameFile={paneState.renameFile}
            onDeleteFile={deleteFileAfterConfirmation}
            onRefusal={paneState.showStatusMessage}
          />
        )}
      </FullSizeMeasurer>
      {paneState.statusMessage && (
        <AlertMessage kind="warning" onHide={paneState.clearStatusMessage}>
          {paneState.statusMessage}
        </AlertMessage>
      )}
    </Column>
  );

  // The pane layout is not persisted: extending the shared
  // EditorMosaicName preference union would touch two preference files
  // outside this phase's approved touchpoints, for a cosmetic gain.
  const editors: { [string]: Editor | null } = {
    'game-code-tree': {
      type: 'secondary',
      title: t`Game code files`,
      toolbarControls: [<CloseButton key="close" />],
      renderEditor: renderTreePane,
    },
    'game-code-editor': {
      type: 'primary',
      noTitleBar: true,
      renderEditor: renderCodeEditor,
    },
    'game-code-ask-ai': {
      type: 'secondary',
      title: t`Ask AI`,
      toolbarControls: [<CloseButton key="close" />],
      renderEditor: () => renderChatEditor(renderEditorContainerProps),
    },
  };

  return (
    <EditorMosaic
      editors={editors}
      centralNodeId="game-code-editor"
      initialNodes={initialMosaicEditorNodes}
    />
  );
};

export default GameCodePane;

/**
 * The renderer of the 'game-code' tab (the entry of
 * MainFrame's editorKindToRenderer).
 */
export const renderGameCodeEditorContainer = (
  props: RenderEditorContainerPropsWithRef
): React.Node => <GameCodePane renderEditorContainerProps={props} />;
