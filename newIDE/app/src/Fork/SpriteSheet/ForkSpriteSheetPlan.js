// @flow

/**
 * Phase 19.1 — the pure sprite-sheet slicing plan (D19-1/D19-4/D19-7).
 *
 * From an image's dimensions + a grid spec, produce the ordered frame
 * rectangles — no canvas, no `sharp`, no filesystem, no `gd`. This module is
 * the layer every other sprite-sheet module (the renderer port, the Electron
 * crop handler, the import dialog and the BYOK tool handler) agrees on, so
 * it is the layer the specs pin.
 *
 * ## Grid semantics (D19-4: an explicit grid, no automatic detection)
 *
 * - `margin` is the OUTER border on all four sides (default 0).
 * - `spacing` is the gap BETWEEN frames, horizontally and vertically
 *   (default 0).
 * - `mode: 'rows-columns'` gives the cell COUNT; the frame size is DERIVED
 *   so the cells tile the inner region exactly. If the derivation is not a
 *   whole number of pixels, the grid does not divide the image and is
 *   refused (a "4 columns over 513 px" grid would need a partial frame).
 * - `mode: 'frame-size'` gives the frame SIZE; the cell count is derived by
 *   flooring. The uncovered strip left on an axis is accepted only while it
 *   is empty or no larger than `margin` — slack of that magnitude is
 *   indistinguishable from a slightly generous margin, while anything larger
 *   means the declared grid does not match the image (A19-3: refuse before
 *   any file is written, and never emit a partial frame).
 *
 * Frames are returned in ROW-MAJOR order (left to right, then top to
 * bottom), which is the reading order D19-6 appends them in.
 *
 * ## Naming (D19-7)
 *
 * `makeForkSpriteSheetFrameNames` builds `<Object>_<Animation>_<index>.png`
 * names, sanitized to safe file names and deduped through the app's
 * `NewNameGenerator` convention so an import never collides with an existing
 * asset — with itself included (every emitted name is taken).
 */

import newNameGenerator from '../../Utils/NewNameGenerator';
import { sanitizeFilename } from '../../Utils/Filename';

export type ForkSpriteSheetGrid = {|
  mode: 'rows-columns' | 'frame-size',
  rows?: number,
  columns?: number,
  frameWidth?: number,
  frameHeight?: number,
  margin?: number,
  spacing?: number,
|};

export type ForkSpriteSheetFrame = {|
  index: number,
  x: number,
  y: number,
  width: number,
  height: number,
|};

export type ForkSpriteSheetPlanResult =
  | {| ok: true, frames: Array<ForkSpriteSheetFrame> |}
  | {| ok: false, error: string |};

/**
 * The geometry both modes converge on: how many cells, and the size each
 * cell takes (all frames of a grid are equal).
 */
type ForkSpriteSheetGeometry =
  | {|
      ok: true,
      rowsCount: number,
      columnsCount: number,
      frameWidth: number,
      frameHeight: number,
    |}
  | {| ok: false, error: string |};

/** 'rows-columns': the frame size is derived so the grid tiles exactly. */
const resolveRowsColumnsGeometry = (
  grid: ForkSpriteSheetGrid,
  innerWidth: number,
  innerHeight: number,
  spacing: number
): ForkSpriteSheetGeometry => {
  const { rows, columns } = grid;
  if (
    rows === undefined ||
    columns === undefined ||
    !Number.isInteger(rows) ||
    !Number.isInteger(columns) ||
    rows <= 0 ||
    columns <= 0
  ) {
    return {
      ok: false,
      error:
        'In "rows-columns" mode, rows and columns must be positive integers.',
    };
  }
  const horizontalBudget = innerWidth - (columns - 1) * spacing;
  if (horizontalBudget <= 0) {
    return {
      ok: false,
      error: `The ${columns} columns and their ${spacing} px spacing do not fit the ${innerWidth} px of image inside the margin.`,
    };
  }
  if (horizontalBudget % columns !== 0) {
    return {
      ok: false,
      error: `The grid does not divide the image: ${columns} columns over ${innerWidth} px (with ${spacing} px spacing) would need a partial frame.`,
    };
  }
  const verticalBudget = innerHeight - (rows - 1) * spacing;
  if (verticalBudget <= 0) {
    return {
      ok: false,
      error: `The ${rows} rows and their ${spacing} px spacing do not fit the ${innerHeight} px of image inside the margin.`,
    };
  }
  if (verticalBudget % rows !== 0) {
    return {
      ok: false,
      error: `The grid does not divide the image: ${rows} rows over ${innerHeight} px (with ${spacing} px spacing) would need a partial frame.`,
    };
  }
  return {
    ok: true,
    rowsCount: rows,
    columnsCount: columns,
    frameWidth: horizontalBudget / columns,
    frameHeight: verticalBudget / rows,
  };
};

/** 'frame-size': the cell count is derived by flooring, slack up to margin. */
const resolveFrameSizeGeometry = (
  grid: ForkSpriteSheetGrid,
  innerWidth: number,
  innerHeight: number,
  margin: number,
  spacing: number
): ForkSpriteSheetGeometry => {
  const { frameWidth, frameHeight } = grid;
  if (
    frameWidth === undefined ||
    frameHeight === undefined ||
    !Number.isInteger(frameWidth) ||
    !Number.isInteger(frameHeight) ||
    frameWidth <= 0 ||
    frameHeight <= 0
  ) {
    return {
      ok: false,
      error:
        'In "frame-size" mode, frameWidth and frameHeight must be positive integers.',
    };
  }
  const columnsCount = Math.floor(
    (innerWidth + spacing) / (frameWidth + spacing)
  );
  const rowsCount = Math.floor(
    (innerHeight + spacing) / (frameHeight + spacing)
  );
  if (columnsCount <= 0 || rowsCount <= 0) {
    return {
      ok: false,
      error: `The frames do not fit the image: a ${frameWidth}x${frameHeight} frame leaves no complete frame inside the ${innerWidth}x${innerHeight} region.`,
    };
  }
  const leftoverWidth =
    innerWidth - (columnsCount * frameWidth + (columnsCount - 1) * spacing);
  if (leftoverWidth > margin) {
    return {
      ok: false,
      error: `The grid does not divide the image: ${frameWidth} px frames over ${innerWidth} px leave ${leftoverWidth} px uncovered — only slack up to the margin (${margin} px) is accepted.`,
    };
  }
  const leftoverHeight =
    innerHeight - (rowsCount * frameHeight + (rowsCount - 1) * spacing);
  if (leftoverHeight > margin) {
    return {
      ok: false,
      error: `The grid does not divide the image: ${frameHeight} px frames over ${innerHeight} px leave ${leftoverHeight} px uncovered — only slack up to the margin (${margin} px) is accepted.`,
    };
  }
  return {
    ok: true,
    rowsCount,
    columnsCount,
    frameWidth,
    frameHeight,
  };
};

/** Lay the equal frames out in row-major order from the geometry. */
const buildFrames = (
  geometry: ForkSpriteSheetGeometry,
  margin: number,
  spacing: number
): ForkSpriteSheetPlanResult => {
  if (!geometry.ok) return geometry;
  const { rowsCount, columnsCount, frameWidth, frameHeight } = geometry;
  const frames: Array<ForkSpriteSheetFrame> = [];
  for (let index = 0; index < rowsCount * columnsCount; index++) {
    const row = Math.floor(index / columnsCount);
    const column = index % columnsCount;
    frames.push({
      index,
      x: margin + column * (frameWidth + spacing),
      y: margin + row * (frameHeight + spacing),
      width: frameWidth,
      height: frameHeight,
    });
  }
  if (frames.length === 0) {
    return { ok: false, error: 'The grid produces zero frames.' };
  }
  return { ok: true, frames };
};

/**
 * Plan the frame rectangles of a sprite sheet. Every refusal is an explicit
 * `{ ok: false, error }` with a message naming the offending number — never
 * a throw, never a partial plan.
 */
export const planForkSpriteSheetFrames = (options: {|
  imageWidth: number,
  imageHeight: number,
  grid: ForkSpriteSheetGrid,
|}): ForkSpriteSheetPlanResult => {
  const { imageWidth, imageHeight, grid } = options;
  if (
    !Number.isInteger(imageWidth) ||
    !Number.isInteger(imageHeight) ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) {
    return {
      ok: false,
      error: `The image dimensions must be positive integers (got ${String(
        imageWidth
      )}x${String(imageHeight)}).`,
    };
  }
  if (!grid || typeof grid !== 'object') {
    return { ok: false, error: 'The grid is missing.' };
  }
  const margin = grid.margin === undefined ? 0 : grid.margin;
  const spacing = grid.spacing === undefined ? 0 : grid.spacing;
  if (!Number.isInteger(margin) || margin < 0) {
    return {
      ok: false,
      error: 'The grid margin must be a non-negative integer.',
    };
  }
  if (!Number.isInteger(spacing) || spacing < 0) {
    return {
      ok: false,
      error: 'The grid spacing must be a non-negative integer.',
    };
  }
  const innerWidth = imageWidth - 2 * margin;
  const innerHeight = imageHeight - 2 * margin;
  if (innerWidth <= 0 || innerHeight <= 0) {
    return {
      ok: false,
      error: `The ${margin} px margin leaves no room for frames in a ${imageWidth}x${imageHeight} image.`,
    };
  }
  if (grid.mode === 'rows-columns') {
    return buildFrames(
      resolveRowsColumnsGeometry(grid, innerWidth, innerHeight, spacing),
      margin,
      spacing
    );
  }
  if (grid.mode === 'frame-size') {
    return buildFrames(
      resolveFrameSizeGeometry(grid, innerWidth, innerHeight, margin, spacing),
      margin,
      spacing
    );
  }
  return {
    ok: false,
    error: `Unknown grid mode "${String(
      grid.mode
    )}": use "rows-columns" or "frame-size".`,
  };
};

/**
 * One sanitized part of the frame-name prefix: the app's file-name rule,
 * then the carrier's readable-character fallback (a name made only of
 * punctuation sanitizes to underscores — confined but unreadable).
 */
const makeSanitizedNamePart = (value: string, fallback: string): string => {
  const sanitized = sanitizeFilename(String(value || '').trim()).trim();
  const hasReadableCharacter = /[a-zA-Z0-9]/.test(sanitized);
  return hasReadableCharacter ? sanitized : fallback;
};

/**
 * The D19-7 frame file names: `Object_anim_0.png`, `Object_anim_1.png`, …
 * deduped through the `NewNameGenerator` convention against the taken names
 * (the existing files AND every name this call already emitted), so two
 * frames can never collide with each other or with an existing asset.
 */
export const makeForkSpriteSheetFrameNames = (options: {|
  objectName: string,
  animationName: string,
  count: number,
  existingFileNames?: $ReadOnlyArray<string>,
|}): Array<string> => {
  const { objectName, animationName, count } = options;
  if (!Number.isInteger(count) || count <= 0) return [];
  const taken: Set<string> = new Set();
  const existingFileNames = options.existingFileNames;
  if (existingFileNames) {
    for (const fileName of existingFileNames) taken.add(fileName);
  }
  const prefix =
    makeSanitizedNamePart(objectName, 'Object') +
    '_' +
    makeSanitizedNamePart(animationName, 'Animation');
  const names: Array<string> = [];
  for (let index = 0; index < count; index++) {
    // `newNameGenerator`'s predicate answers "is this name TAKEN" — a free
    // name makes it false so the search (and the loop inside it) stops.
    const name =
      newNameGenerator(`${prefix}_${index}`, candidate =>
        taken.has(`${candidate}.png`)
      ) + '.png';
    names.push(name);
    taken.add(name);
  }
  return names;
};
