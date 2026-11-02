// @flow

/**
 * Phase 19.2 — the renderer side of the sprite-sheet slicer (D19-2/D19-3).
 *
 * The port resolves the source image's dimensions, plans the frames (19.1),
 * dedupes the frame file names against the project's existing resource
 * files, then invokes the confined Electron crop handler
 * (`fork-sprite-sheet-slice`) which writes the frame PNGs into the project's
 * assets folder. Everything platform-shaped (the dimension reader, the IPC)
 * is injected so the whole port is unit-testable without Electron, and the
 * default deps builder returns null on a non-desktop runtime — the same
 * discipline as ForkAssetOptimizerPort.
 *
 * Never-throws contract: every failure (unreadable image, refused plan, IPC
 * error, slicer refusal) maps to an explicit `{ ok: false, error }` and
 * nothing is written — A19-3: a non-dividing grid is refused BEFORE any
 * file is written (the slice handler is never invoked).
 */

import optionalRequire from '../../Utils/OptionalRequire';
import {
  makeForkSpriteSheetFrameNames,
  planForkSpriteSheetFrames,
  type ForkSpriteSheetFrame,
  type ForkSpriteSheetGrid,
  type ForkSpriteSheetPlanResult,
} from './ForkSpriteSheetPlan';
import { sanitizeFilename } from '../../Utils/Filename';

// Re-exported for the consumers of this module (the tool handler, the
// dialog, the BYOK adapter) so the grid type has ONE import site.
export type {
  ForkSpriteSheetGrid,
  ForkSpriteSheetFrame,
  ForkSpriteSheetPlanResult,
} from './ForkSpriteSheetPlan';

/** The one slice channel (the Electron handler of the same name). */
export const FORK_SPRITE_SHEET_SLICE_CHANNEL = 'fork-sprite-sheet-slice';

/** The frames folder suffix, mirroring the game-code carrier's 'Code'. */
export const FORK_SPRITE_SHEET_ASSETS_FOLDER_SUFFIX = 'Assets';

export type ForkSpriteSheetSliceRequest = {|
  sourceAbsolutePath: string,
  assetsFolderAbsolutePath: string,
  frames: Array<ForkSpriteSheetFrame>,
  frameFileNames: Array<string>,
|};

export type ForkSpriteSheetSliceOutcome =
  | {| ok: true, writtenAbsolutePaths: Array<string> |}
  | {| ok: false, error: string |};

export type ForkSpriteSheetPortDeps = {|
  invokeSlice: (
    request: ForkSpriteSheetSliceRequest
  ) => Promise<ForkSpriteSheetSliceOutcome>,
  readImageSize: (
    absolutePath: string
  ) => Promise<{| width: number, height: number |}>,
|};

export type ForkSpriteSheetImportOutcome =
  | {|
      ok: true,
      plan: ForkSpriteSheetPlanResult,
      frames: Array<ForkSpriteSheetFrame>,
      frameFileNames: Array<string>,
      writtenAbsolutePaths: Array<string>,
    |}
  | {| ok: false, error: string |};

const describeError = (error: mixed): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The assets folder name for a project: `<GameName>Assets`.
 *
 * Mirrors `getByokGameCodeFolderName` exactly (the Phase 15 carrier): the
 * project name is user text, so it goes through the app's file-name
 * sanitizer and falls back to a readable default when nothing readable
 * survives.
 */
export const getForkSpriteSheetAssetsFolderName = (
  projectName: string
): string => {
  const safeProjectName = sanitizeFilename((projectName || '').trim()).trim();
  const hasReadableCharacter = /[a-zA-Z0-9]/.test(safeProjectName);
  const baseName = hasReadableCharacter ? safeProjectName : 'Game';
  return baseName + FORK_SPRITE_SHEET_ASSETS_FOLDER_SUFFIX;
};

export type ForkSpriteSheetAssetsFolder =
  | {| ok: true, folderName: string, folderAbsolutePath: string |}
  | {| ok: false, error: string |};

/**
 * Where the sliced frames land: `<project folder>/<GameName>Assets/`,
 * derived from the project file the same way the game-code folder is (the
 * renderer derives it; the Electron handler re-confines every write inside
 * it). Kept pure (no `path` module) so it is testable anywhere.
 */
export const getForkSpriteSheetAssetsFolder = (
  project: any
): ForkSpriteSheetAssetsFolder => {
  const projectFile =
    project && typeof project.getProjectFile === 'function'
      ? project.getProjectFile()
      : '';
  if (typeof projectFile !== 'string' || !projectFile) {
    return {
      ok: false,
      error:
        'The project must be saved before importing a sprite sheet (it has no file on disk yet).',
    };
  }
  const lastSeparator = Math.max(
    projectFile.lastIndexOf('/'),
    projectFile.lastIndexOf('\\')
  );
  if (lastSeparator <= 0) {
    return {
      ok: false,
      error: `The project file has no folder part: "${projectFile}".`,
    };
  }
  const projectName =
    project && typeof project.getName === 'function'
      ? String(project.getName())
      : '';
  const folderName = getForkSpriteSheetAssetsFolderName(projectName);
  const separator =
    projectFile.lastIndexOf('\\') > projectFile.lastIndexOf('/') ? '\\' : '/';
  return {
    ok: true,
    folderName,
    folderAbsolutePath:
      projectFile.slice(0, lastSeparator) + separator + folderName,
  };
};

/**
 * The file BASE names every project resource already uses — the dedupe set
 * of D19-7, so a frame never takes the name of an existing asset (the
 * exporter copies resources flat, so even a file in another folder would
 * collide on export).
 */
export const listForkSpriteSheetTakenFileNames = (
  project: any
): Array<string> => {
  if (!project || typeof project.getResourcesManager !== 'function') {
    return [];
  }
  const resourcesManager = project.getResourcesManager();
  const names = resourcesManager
    .getAllResourceNames()
    .toJSArray()
    .map(String);
  const baseNames: Array<string> = [];
  for (const name of names) {
    const file = resourcesManager.getResource(name).getFile();
    if (typeof file !== 'string' || !file) continue;
    const lastSeparator = Math.max(
      file.lastIndexOf('/'),
      file.lastIndexOf('\\')
    );
    baseNames.push(lastSeparator === -1 ? file : file.slice(lastSeparator + 1));
  }
  return baseNames;
};

/**
 * Slice a sprite sheet into frame files. Pure orchestration: read the
 * dimensions, plan (19.1), name (19.7), then hand the whole thing to the
 * confined Electron cropper. A plan refusal or any dep failure returns
 * `{ ok: false, error }` with NOTHING written.
 */
export const importForkSpriteSheetFrames = async (options: {|
  project: any,
  sourceAbsolutePath: string,
  grid: ForkSpriteSheetGrid,
  objectName: string,
  animationName: string,
  deps: ForkSpriteSheetPortDeps,
|}): Promise<ForkSpriteSheetImportOutcome> => {
  const {
    project,
    sourceAbsolutePath,
    grid,
    objectName,
    animationName,
    deps,
  } = options;
  if (typeof sourceAbsolutePath !== 'string' || !sourceAbsolutePath) {
    return { ok: false, error: 'No source image was given.' };
  }
  const assetsFolder = getForkSpriteSheetAssetsFolder(project);
  if (!assetsFolder.ok) {
    return { ok: false, error: assetsFolder.error };
  }

  let size;
  try {
    size = await deps.readImageSize(sourceAbsolutePath);
  } catch (error) {
    return {
      ok: false,
      error: `The source image could not be read: ${describeError(error)}`,
    };
  }
  if (
    !size ||
    !Number.isInteger(size.width) ||
    !Number.isInteger(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    return {
      ok: false,
      error: 'The source image has no usable dimensions.',
    };
  }

  const plan = planForkSpriteSheetFrames({
    imageWidth: size.width,
    imageHeight: size.height,
    grid,
  });
  if (!plan.ok) {
    // A19-3: refused BEFORE any file is written — the slice handler is
    // never invoked, so nothing touches the disk.
    return { ok: false, error: plan.error };
  }

  const frameFileNames = makeForkSpriteSheetFrameNames({
    objectName,
    animationName,
    count: plan.frames.length,
    existingFileNames: listForkSpriteSheetTakenFileNames(project),
  });
  if (frameFileNames.length === 0) {
    return { ok: false, error: 'No frame file names could be generated.' };
  }

  let outcome;
  try {
    outcome = await deps.invokeSlice({
      sourceAbsolutePath,
      assetsFolderAbsolutePath: assetsFolder.folderAbsolutePath,
      frames: plan.frames,
      frameFileNames,
    });
  } catch (error) {
    return {
      ok: false,
      error: `The slicing failed: ${describeError(error)}`,
    };
  }
  if (!outcome || !outcome.ok) {
    return {
      ok: false,
      error: (outcome && outcome.error) || 'The slicing failed.',
    };
  }
  if (!Array.isArray(outcome.writtenAbsolutePaths)) {
    return {
      ok: false,
      error: 'The slicer returned no written paths.',
    };
  }
  return {
    ok: true,
    plan,
    frames: plan.frames,
    frameFileNames,
    writtenAbsolutePaths: outcome.writtenAbsolutePaths,
  };
};

/**
 * The file:// URL of a local absolute path, for the renderer `Image` loader:
 * backslashes become forward slashes, a Windows drive prefix gets the
 * triple-slash form, and reserved characters are percent-encoded.
 */
export const makeForkSpriteSheetFileUrl = (absolutePath: string): string => {
  const withForwardSlashes = absolutePath.replace(/\\/g, '/');
  const prefix = withForwardSlashes.startsWith('/') ? 'file://' : 'file:///';
  return prefix + encodeURI(withForwardSlashes);
};

/**
 * Read a local image's dimensions in the renderer: load it through a
 * file:// URL and resolve the natural dimensions.
 */
const readImageSizeFromFileUrl = (
  absolutePath: string
): Promise<{| width: number, height: number |}> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener('load', () => {
      resolve({
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
    });
    image.addEventListener('error', () => {
      reject(new Error(`"${absolutePath}" could not be decoded as an image.`));
    });
    image.src = makeForkSpriteSheetFileUrl(absolutePath);
  });

/**
 * The production deps: the Electron IPC for the cropping, the renderer
 * Image loader for the dimensions — or null when the runtime is not the
 * desktop app (D19-2: the slicer is desktop-only).
 */
export const makeDefaultForkSpriteSheetPortDeps = (): ?ForkSpriteSheetPortDeps => {
  const electron = optionalRequire('electron');
  if (!electron || !electron.ipcRenderer) return null;
  const ipcRenderer = electron.ipcRenderer;
  return {
    invokeSlice: async request => {
      try {
        const result = await ipcRenderer.invoke(
          FORK_SPRITE_SHEET_SLICE_CHANNEL,
          request
        );
        if (result && typeof result === 'object') return result;
        return {
          ok: false,
          error: 'The slicer answered with an unexpected result.',
        };
      } catch (error) {
        return { ok: false, error: describeError(error) };
      }
    },
    readImageSize: readImageSizeFromFileUrl,
  };
};
