// @flow
import { t, Trans } from '@lingui/macro';
import { I18n } from '@lingui/react';
import * as React from 'react';

import Dialog from '../../UI/Dialog';
import FlatButton from '../../UI/FlatButton';
import RaisedButton from '../../UI/RaisedButton';
import Text from '../../UI/Text';
import Checkbox from '../../UI/Checkbox';
import SemiControlledTextField from '../../UI/SemiControlledTextField';
import SelectField from '../../UI/SelectField';
import SelectOption from '../../UI/SelectOption';
import { ColumnStackLayout, LineStackLayout } from '../../UI/Layout';
import { Line } from '../../UI/Grid';
import optionalRequire from '../../Utils/OptionalRequire';
import {
  makeForkSpriteSheetFileUrl,
  type ForkSpriteSheetGrid,
} from './ForkSpriteSheetPort';
import { planForkSpriteSheetFrames } from './ForkSpriteSheetPlan';
import {
  importForkSpriteSheet,
  makeDefaultForkSpriteSheetToolDeps,
  type ForkSpriteSheetToolDeps,
} from './ForkSpriteSheetToolHandler';

/** The established native open-file picker shape (LocalResourceSources). */
export type ForkSpriteSheetPickFileOptions = {|
  title: string,
  defaultPath?: string,
|};
export type ForkSpriteSheetPickFile = (
  options: ForkSpriteSheetPickFileOptions
) => Promise<string>;

/**
 * The desktop file picker: @electron/remote's showOpenDialog, image files
 * only. Null outside the Electron app — the same discipline as the port's
 * default deps.
 */
export const makeDefaultForkSpriteSheetPickFile = (): ?ForkSpriteSheetPickFile => {
  const remote = optionalRequire('@electron/remote');
  const electron = optionalRequire('electron');
  if (!remote || !electron || !remote.dialog) return null;
  const dialog = remote.dialog;
  return async options => {
    const { filePaths } = await dialog.showOpenDialog(
      remote.getCurrentWindow(),
      {
        title: options.title,
        properties: ['openFile'],
        filters: [
          {
            name: 'Images',
            extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'],
          },
        ],
        defaultPath: options.defaultPath,
      }
    );
    return (filePaths && filePaths[0]) || '';
  };
};

export type ForkSpriteSheetDialogDeps = {|
  /** The pipeline deps (port + assembly + path); null outside desktop. */
  importDeps: ?ForkSpriteSheetToolDeps,
  /** The native file picker; null outside desktop. */
  pickFile: ?ForkSpriteSheetPickFile,
|};

export const makeDefaultForkSpriteSheetDialogDeps = (): ForkSpriteSheetDialogDeps => ({
  importDeps: makeDefaultForkSpriteSheetToolDeps(),
  pickFile: makeDefaultForkSpriteSheetPickFile(),
});

export type ForkSpriteSheetDialogProps = {|
  project: any,
  /** The Sprite object being edited — the import target, given not chosen. */
  objectName: string,
  /** Called with true when the dialog closes after a successful import. */
  onClose: (didImport: boolean) => void,
  deps?: ForkSpriteSheetDialogDeps,
|};

type ForkSpriteSheetDialogResult = {|
  ok: boolean,
  message: string,
|};

type ForkSpriteSheetGridMode = 'rows-columns' | 'frame-size';

const DEFAULT_ANIMATION_NAME = 'Imported';
const DEFAULT_FPS = 10;
const PREVIEW_MAX_WIDTH = 420;
const PREVIEW_STROKE_STYLE = 'rgba(255, 82, 82, 0.95)';

/** A positive integer from a text field; empty or invalid → undefined. */
const parsePositiveIntText = (text: string): number | void => {
  if (!text.trim()) return undefined;
  const value = Number(text);
  return Number.isInteger(value) && value > 0 ? value : undefined;
};

/** A non-negative integer (margin and spacing may be 0); invalid → undefined. */
const parseNonNegativeIntText = (text: string): number | void => {
  if (!text.trim()) return undefined;
  const value = Number(text);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
};

/**
 * The Phase 19.4 import dialog: pick a source image, state the grid
 * (D19-4 — explicit, never auto-detected), and watch the slice lines on a
 * live canvas preview before anything is written. The preview runs the
 * REAL plan (planForkSpriteSheetFrames over the image's natural size) and
 * writes nothing; the Import button stays disabled until the plan accepts
 * the grid (A19-3: a non-dividing grid is refused before any file exists).
 * The import itself is the shared pipeline handler (port + assembly).
 */
const ForkSpriteSheetDialog = ({
  project,
  objectName,
  onClose,
  deps,
}: ForkSpriteSheetDialogProps): React.Node => {
  const [defaultDeps] = React.useState<ForkSpriteSheetDialogDeps>(
    makeDefaultForkSpriteSheetDialogDeps
  );
  const resolvedDeps = deps || defaultDeps;
  const portDeps = React.useMemo(
    () =>
      resolvedDeps.importDeps && resolvedDeps.importDeps.portDeps
        ? resolvedDeps.importDeps.portDeps
        : null,
    [resolvedDeps]
  );
  const isDesktopAvailable =
    !!portDeps && !!resolvedDeps.importDeps && !!resolvedDeps.pickFile;

  const [sourcePath, setSourcePath] = React.useState<string>('');
  const [imageSize, setImageSize] = React.useState<?{|
    width: number,
    height: number,
  |}>(null);
  const [imageElement, setImageElement] = React.useState<?Image>(null);
  const [gridMode, setGridMode] = React.useState<ForkSpriteSheetGridMode>(
    'rows-columns'
  );
  const [rowsText, setRowsText] = React.useState<string>('4');
  const [columnsText, setColumnsText] = React.useState<string>('4');
  const [frameWidthText, setFrameWidthText] = React.useState<string>('32');
  const [frameHeightText, setFrameHeightText] = React.useState<string>('32');
  const [marginText, setMarginText] = React.useState<string>('0');
  const [spacingText, setSpacingText] = React.useState<string>('0');
  const [animationName, setAnimationName] = React.useState<string>(
    DEFAULT_ANIMATION_NAME
  );
  const [fpsText, setFpsText] = React.useState<string>(String(DEFAULT_FPS));
  const [loop, setLoop] = React.useState<boolean>(true);
  const [importing, setImporting] = React.useState<boolean>(false);
  const [result, setResult] = React.useState<?ForkSpriteSheetDialogResult>(
    null
  );

  // Reading the image (dimensions through the port's dep, the pixels for
  // the preview through a file:// URL) — never writes anything.
  React.useEffect(
    () => {
      setImageElement(null);
      if (!sourcePath || !portDeps) {
        setImageSize(null);
        return;
      }
      let cancelled = false;
      portDeps
        .readImageSize(sourcePath)
        .then(size => {
          if (!cancelled)
            setImageSize({ width: size.width, height: size.height });
        })
        .catch(() => {
          if (!cancelled) setImageSize(null);
        });
      const image = new Image();
      image.addEventListener('load', () => {
        if (!cancelled) setImageElement(image);
      });
      image.addEventListener('error', () => {
        if (!cancelled) setImageElement(null);
      });
      image.src = makeForkSpriteSheetFileUrl(sourcePath);
      return () => {
        cancelled = true;
      };
    },
    [sourcePath, portDeps]
  );

  const grid: ForkSpriteSheetGrid =
    gridMode === 'rows-columns'
      ? {
          mode: gridMode,
          rows: parsePositiveIntText(rowsText),
          columns: parsePositiveIntText(columnsText),
          margin: parseNonNegativeIntText(marginText),
          spacing: parseNonNegativeIntText(spacingText),
        }
      : {
          mode: gridMode,
          frameWidth: parsePositiveIntText(frameWidthText),
          frameHeight: parsePositiveIntText(frameHeightText),
          margin: parseNonNegativeIntText(marginText),
          spacing: parseNonNegativeIntText(spacingText),
        };
  const plan =
    imageSize && sourcePath
      ? planForkSpriteSheetFrames({
          imageWidth: imageSize.width,
          imageHeight: imageSize.height,
          grid,
        })
      : null;
  const frameCount = plan && plan.ok ? plan.frames.length : 0;
  const fps = Number(fpsText);
  const resultSucceeded = !!(result && result.ok);
  const canImport =
    isDesktopAvailable &&
    !importing &&
    !resultSucceeded &&
    !!sourcePath &&
    !!plan &&
    plan.ok &&
    Number.isFinite(fps) &&
    fps > 0;

  const canvasRef = React.useRef<?HTMLCanvasElement>(null);

  // The preview: the source image scaled to fit, then the planned slice
  // lines stroked over it (A19-3's "the preview reflects the grid without
  // writing files" — it only ever reads).
  React.useEffect(
    () => {
      const canvas = canvasRef.current;
      if (!canvas || !imageElement || !plan || !plan.ok) return;
      const context = canvas.getContext('2d');
      if (!context) return;
      const scale = Math.min(1, PREVIEW_MAX_WIDTH / imageElement.naturalWidth);
      canvas.width = Math.max(1, Math.round(imageElement.naturalWidth * scale));
      canvas.height = Math.max(
        1,
        Math.round(imageElement.naturalHeight * scale)
      );
      context.drawImage(imageElement, 0, 0, canvas.width, canvas.height);
      context.strokeStyle = PREVIEW_STROKE_STYLE;
      for (const frame of plan.frames) {
        context.strokeRect(
          frame.x * scale,
          frame.y * scale,
          frame.width * scale,
          frame.height * scale
        );
      }
    },
    [imageElement, plan]
  );

  const onChooseImage = async (i18n: any) => {
    if (!resolvedDeps.pickFile) return;
    const pickedPath = await resolvedDeps.pickFile({
      title: i18n._(t`Choose a sprite sheet image`),
    });
    if (!pickedPath) return;
    setResult(null);
    setSourcePath(pickedPath);
  };

  const onImport = async () => {
    if (!canImport || !plan || !plan.ok) return;
    setImporting(true);
    setResult(null);
    try {
      const outcome = await importForkSpriteSheet(
        project,
        {
          objectName,
          sourceAbsolutePath: sourcePath,
          grid,
          animationName: animationName.trim() || DEFAULT_ANIMATION_NAME,
          fps,
          loop,
        },
        resolvedDeps.importDeps || undefined
      );
      setResult(
        outcome.success
          ? { ok: true, message: outcome.output }
          : { ok: false, message: outcome.message }
      );
    } finally {
      setImporting(false);
    }
  };

  const close = () => {
    if (importing) return;
    onClose(resultSucceeded);
  };

  return (
    <I18n>
      {({ i18n }) => (
        <Dialog
          title={<Trans>Import sprite sheet</Trans>}
          subtitle={
            <Trans>
              Slice one image into animation frames, written to the project
              assets folder
            </Trans>
          }
          open
          maxWidth="sm"
          cannotBeDismissed={importing}
          onRequestClose={close}
          actions={[
            <FlatButton
              key="close"
              label={<Trans>Close</Trans>}
              onClick={close}
              disabled={importing}
            />,
            <RaisedButton
              key="import"
              label={<Trans>Import</Trans>}
              primary
              disabled={!canImport}
              onClick={onImport}
            />,
          ]}
        >
          <ColumnStackLayout noMargin>
            {!isDesktopAvailable && (
              <Text color="error">
                <Trans>
                  Importing a sprite sheet is only available in the desktop app
                  (it needs the local filesystem).
                </Trans>
              </Text>
            )}
            <LineStackLayout noMargin alignItems="center">
              <Text noMargin style={{ flex: 1, overflowWrap: 'anywhere' }}>
                {sourcePath || <Trans>No sprite sheet image chosen yet.</Trans>}
              </Text>
              <FlatButton
                label={<Trans>Choose image...</Trans>}
                disabled={!isDesktopAvailable || importing}
                onClick={() => onChooseImage(i18n)}
              />
            </LineStackLayout>
            <SelectField
              fullWidth
              floatingLabelText={<Trans>Grid</Trans>}
              value={gridMode}
              onChange={(event, index, value) =>
                setGridMode(
                  value === 'frame-size' ? 'frame-size' : 'rows-columns'
                )
              }
              disabled={importing}
            >
              <SelectOption
                value="rows-columns"
                label={<Trans>Rows × columns (frame size derived)</Trans>}
              />
              <SelectOption
                value="frame-size"
                label={<Trans>Frame width × height (count derived)</Trans>}
              />
            </SelectField>
            {gridMode === 'rows-columns' ? (
              <LineStackLayout noMargin>
                <SemiControlledTextField
                  fullWidth
                  floatingLabelText={<Trans>Rows</Trans>}
                  type="number"
                  value={rowsText}
                  onChange={setRowsText}
                  disabled={importing}
                />
                <SemiControlledTextField
                  fullWidth
                  floatingLabelText={<Trans>Columns</Trans>}
                  type="number"
                  value={columnsText}
                  onChange={setColumnsText}
                  disabled={importing}
                />
              </LineStackLayout>
            ) : (
              <LineStackLayout noMargin>
                <SemiControlledTextField
                  fullWidth
                  floatingLabelText={<Trans>Frame width</Trans>}
                  type="number"
                  value={frameWidthText}
                  onChange={setFrameWidthText}
                  disabled={importing}
                />
                <SemiControlledTextField
                  fullWidth
                  floatingLabelText={<Trans>Frame height</Trans>}
                  type="number"
                  value={frameHeightText}
                  onChange={setFrameHeightText}
                  disabled={importing}
                />
              </LineStackLayout>
            )}
            <LineStackLayout noMargin>
              <SemiControlledTextField
                fullWidth
                floatingLabelText={<Trans>Margin</Trans>}
                type="number"
                value={marginText}
                onChange={setMarginText}
                disabled={importing}
              />
              <SemiControlledTextField
                fullWidth
                floatingLabelText={<Trans>Spacing</Trans>}
                type="number"
                value={spacingText}
                onChange={setSpacingText}
                disabled={importing}
              />
            </LineStackLayout>
            <LineStackLayout noMargin>
              <SemiControlledTextField
                fullWidth
                floatingLabelText={<Trans>Animation name</Trans>}
                value={animationName}
                onChange={setAnimationName}
                disabled={importing}
              />
              <SemiControlledTextField
                fullWidth
                floatingLabelText={<Trans>Frames per second</Trans>}
                type="number"
                value={fpsText}
                onChange={setFpsText}
                disabled={importing}
              />
            </LineStackLayout>
            <Line noMargin>
              <Checkbox
                label={<Trans>Loop the animation</Trans>}
                checked={loop}
                onCheck={(event, value) => setLoop(value)}
                disabled={importing}
              />
            </Line>
            <Text size="block-title">
              <Trans>Preview</Trans>
            </Text>
            {!imageSize && (
              <Text color="secondary">
                <Trans>
                  Choose a sprite sheet image to see the slice preview.
                </Trans>
              </Text>
            )}
            {imageSize && plan && !plan.ok && (
              <Text color="error">{plan.error}</Text>
            )}
            {imageSize && plan && plan.ok && (
              <Text>
                <Trans>Frames</Trans>: {String(frameCount)}
              </Text>
            )}
            <canvas
              ref={canvasRef}
              style={{ maxWidth: '100%', alignSelf: 'flex-start' }}
            />
            {result && (
              <Text color={result.ok ? 'secondary' : 'error'}>
                {result.message}
              </Text>
            )}
          </ColumnStackLayout>
        </Dialog>
      )}
    </I18n>
  );
};

export default ForkSpriteSheetDialog;
