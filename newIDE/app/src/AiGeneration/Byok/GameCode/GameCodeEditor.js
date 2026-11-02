// @flow
import { Trans } from '@lingui/macro';
import * as React from 'react';

import { CodeEditor } from '../../../CodeEditor';
import AlertMessage from '../../../UI/AlertMessage';
import FlatButton from '../../../UI/FlatButton';
import RaisedButton from '../../../UI/RaisedButton';
import Text from '../../../UI/Text';
import { Line } from '../../../UI/Grid';
import { FullSizeMeasurer } from '../../../UI/FullSizeMeasurer';

/**
 * Step 15.5 — the Monaco editor of the game-code pane, with the D15-7
 * single-writer guard.
 *
 * The pane hands the content as it is on disk (`contentOnDisk`); the user's
 * typing lives in a local buffer. While the buffer is dirty, an incoming
 * disk change (an AI `write_game_code_file`, or an external edit) is
 * SURFACED as a banner with the incoming content available — never applied
 * over the typing. When the buffer is clean, the editor follows the disk.
 */

export type GameCodeWriteResult =
  | {| ok: true |}
  | {| ok: false, error: string |};

type Props = {|
  relativePath: string,
  /** The content currently on disk, as last read by the pane. */
  contentOnDisk: string,
  /** The pane's writer: store write + carrier + reload + listing refresh. */
  onWriteFile: (
    relativePath: string,
    content: string
  ) => Promise<GameCodeWriteResult>,
  /** The pane tracks dirty state per file (the tree marks it with a dot). */
  onDirtyStateChange: (relativePath: string, isDirty: boolean) => void,
|};

const styles = {
  container: { display: 'flex', flex: 1, flexDirection: 'column' },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 8,
    paddingRight: 8,
  },
  editorContainer: { flex: 1, minHeight: 0 },
};

/**
 * The game-code editor of one file.
 *
 * Must be keyed by the file's relative path (the pane does it), so a file
 * switch resets the buffer instead of carrying one file's state into the
 * next.
 */
const GameCodeEditor = ({
  relativePath,
  contentOnDisk,
  onWriteFile,
  onDirtyStateChange,
}: Props): React.MixedElement => {
  const [buffer, setBuffer] = React.useState<string>(contentOnDisk);
  const [savedContent, setSavedContent] = React.useState<string>(contentOnDisk);
  const [
    dismissedExternalContent,
    setDismissedExternalContent,
  ] = React.useState<string | null>(null);
  const [isSaving, setIsSaving] = React.useState<boolean>(false);

  const isDirty = buffer !== savedContent;
  // An incoming disk change that is not the one the user already decided
  // about ("keep my version") and not yet saved: this is what the banner
  // surfaces (D15-7).
  const externalChange: ?string =
    contentOnDisk !== savedContent && contentOnDisk !== dismissedExternalContent
      ? contentOnDisk
      : null;

  // Follow the disk when the buffer is clean — never when it is dirty
  // (D15-7): an AI write must not silently replace what the user types.
  React.useEffect(
    () => {
      if (contentOnDisk === savedContent) return;
      if (buffer !== savedContent) return;
      setBuffer(contentOnDisk);
      setSavedContent(contentOnDisk);
    },
    [contentOnDisk, savedContent, buffer]
  );

  React.useEffect(
    () => {
      onDirtyStateChange(relativePath, isDirty);
    },
    [onDirtyStateChange, relativePath, isDirty]
  );

  const performSave = React.useCallback(
    async (): Promise<void> => {
      if (!isDirty || isSaving) return;
      setIsSaving(true);
      try {
        const result = await onWriteFile(relativePath, buffer);
        if (!result.ok) return;
        setSavedContent(buffer);
        setDismissedExternalContent(null);
      } finally {
        setIsSaving(false);
      }
    },
    [buffer, isDirty, isSaving, onWriteFile, relativePath]
  );

  // The code editor registers its blur handler once at mount, so the
  // callback it receives must survive re-renders: go through a ref.
  const performSaveRef = React.useRef<?() => Promise<void>>(null);
  React.useEffect(
    () => {
      performSaveRef.current = performSave;
    },
    [performSave]
  );
  const handleEditorBlur = React.useCallback(() => {
    if (performSaveRef.current) performSaveRef.current();
  }, []);

  const handleLoadIncomingVersion = () => {
    if (!externalChange) return;
    setBuffer(externalChange);
    setSavedContent(externalChange);
    setDismissedExternalContent(null);
  };

  const handleKeepMyVersion = () => {
    if (!externalChange) return;
    setDismissedExternalContent(externalChange);
  };

  return (
    <div style={styles.container}>
      <Line noMargin alignItems="center" justifyContent="space-between">
        <Text noMargin>{relativePath + (isDirty ? ' •' : '')}</Text>
        <RaisedButton
          label={<Trans>Save</Trans>}
          primary
          disabled={!isDirty || isSaving}
          onClick={performSave}
        />
      </Line>
      {externalChange !== null && (
        <AlertMessage kind="warning">
          <Trans>
            This file was changed outside the editor (for example by the AI).
            Loading the new version will replace your unsaved changes.
          </Trans>
          <Line noMargin>
            <FlatButton
              label={<Trans>Load the new version</Trans>}
              primary
              onClick={handleLoadIncomingVersion}
            />
            <FlatButton
              label={<Trans>Keep my version</Trans>}
              onClick={handleKeepMyVersion}
            />
          </Line>
        </AlertMessage>
      )}
      <div style={styles.editorContainer}>
        <FullSizeMeasurer>
          {({ width, height }) => (
            <CodeEditor
              value={buffer}
              onChange={setBuffer}
              initialScrollTop={0}
              initialCursorColumn={0}
              initialCursorLine={0}
              saveEditorState={() => {}}
              onFocus={() => {}}
              onBlur={handleEditorBlur}
              width={width}
              height={height}
            />
          )}
        </FullSizeMeasurer>
      </div>
    </div>
  );
};

export default GameCodeEditor;
