const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { makeByokAtomicTempName } = require('./SharedCore').loadSharedModule(
  'AiGeneration/Byok/ByokAtomicWriteCore'
);
const {
  isPathInsideFolder,
  resolveGameCodeFile,
} = require('./SharedCore').loadSharedModule(
  'AiGeneration/Byok/GameCode/ByokGameCodePathCore'
);

// Phase 19.2 — the desktop side of the sprite-sheet slicer.
//
// This module is deliberately a THIN APPLIER, like ForkAssetOptimizer.js:
// the pure plan (which frames, which origins) was decided by the
// renderer-side policy (Fork/SpriteSheet/ForkSpriteSheetPlan.js) and arrives
// over IPC already final. All this side does is:
//   1. re-check the payload shape and re-confine every write target inside
//      the assets folder (the renderer applies the same rules in its own
//      tested code; the check is repeated HERE because this is the process
//      that writes to disk),
//   2. refuse the whole call when any target file already exists (A19-2:
//      an import never overwrites an existing asset — checked before ANY
//      crop runs),
//   3. crop each frame with `sharp` (lazily required, like the optimizer)
//      and write it through a unique temp name + same-folder rename, so a
//      failure leaves no partial frame behind.
//
// The SOURCE image may be any file the user picked — it is never written
// to, so it is not confined; it is only read. Every WRITE target must stay
// inside the assets folder derived by the renderer from the project file.
//
// Per-frame failure semantics (A19-2): frames already renamed before the
// failure STAY on disk — they are complete, correctly named files the user
// can keep or delete; the error names the frame and index that failed. A
// retry is safe because the existing-file guard refuses to overwrite them.
//
// Every handler answers with a value and never throws, because an exception
// inside ipcMain.handle rejects the renderer's invoke and turns an ordinary
// refusal into a crash (the ByokRagFiles.js discipline).

const FORK_SPRITE_SHEET_SLICE_CHANNEL = 'fork-sprite-sheet-slice';

/** A generous ceiling for the source image, mirroring the optimizer. */
const FORK_SPRITE_SHEET_MAX_SOURCE_BYTES = 512 * 1024 * 1024;

const describeError = error =>
  error && error.message ? error.message : String(error);

let sharpModule = null;
let sharpLoaded = false;
const getSharp = () => {
  if (sharpLoaded) return sharpModule;
  sharpLoaded = true;
  try {
    sharpModule = require('sharp');
  } catch (error) {
    sharpModule = null;
  }
  return sharpModule;
};

/**
 * Validate the payload and resolve every write target. The file NAME is
 * treated as one untrusted relative path segment: `resolveGameCodeFile`
 * (the tested BYOK path core) refuses `..` escapes, separators, absolute
 * paths, Windows Alternate Data Stream colons and reserved device names,
 * and the final containment check keeps the target inside the assets
 * folder.
 */
const validateSliceRequest = payload => {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'The slicer received a malformed payload.' };
  }
  const sourceAbsolutePath = payload.sourceAbsolutePath;
  const assetsFolderAbsolutePath = payload.assetsFolderAbsolutePath;
  const frames = payload.frames;
  const frameFileNames = payload.frameFileNames;
  if (typeof sourceAbsolutePath !== 'string' || !sourceAbsolutePath) {
    return { ok: false, error: 'No source image was given.' };
  }
  if (
    typeof assetsFolderAbsolutePath !== 'string' ||
    !assetsFolderAbsolutePath
  ) {
    return { ok: false, error: 'No assets folder was given.' };
  }
  // The assets folder is derived by the renderer from the project file; a
  // filesystem root is never one (a project never lives at a drive root).
  if (path.parse(assetsFolderAbsolutePath).root === assetsFolderAbsolutePath) {
    return {
      ok: false,
      error: 'Refused: the assets folder is a filesystem root.',
    };
  }
  if (!Array.isArray(frames) || frames.length === 0) {
    return { ok: false, error: 'The slice request has no frames.' };
  }
  if (
    !Array.isArray(frameFileNames) ||
    frameFileNames.length !== frames.length
  ) {
    return {
      ok: false,
      error: 'The frame file names do not match the frames.',
    };
  }
  const targets = [];
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    if (
      !frame ||
      typeof frame !== 'object' ||
      !Number.isInteger(frame.x) ||
      !Number.isInteger(frame.y) ||
      !Number.isInteger(frame.width) ||
      !Number.isInteger(frame.height) ||
      frame.x < 0 ||
      frame.y < 0 ||
      frame.width <= 0 ||
      frame.height <= 0
    ) {
      return {
        ok: false,
        error: `Frame ${index} is not a valid rectangle.`,
      };
    }
    const fileName = frameFileNames[index];
    const resolved = resolveGameCodeFile(assetsFolderAbsolutePath, fileName);
    if (!resolved.ok) {
      return {
        ok: false,
        error: `Frame ${index} has an invalid file name "${String(
          fileName
        )}": ${resolved.error}`,
      };
    }
    if (!isPathInsideFolder(assetsFolderAbsolutePath, resolved.absolutePath)) {
      return {
        ok: false,
        error: `Frame ${index} escapes the assets folder.`,
      };
    }
    targets.push(resolved.absolutePath);
  }
  return {
    ok: true,
    data: { sourceAbsolutePath, assetsFolderAbsolutePath, frames, targets },
  };
};

/**
 * Crop one frame out of the source and land it at the target path: sharp
 * extract → PNG → unique temp name in the same folder → rename, so a
 * failure at any point leaves the target exactly as it was (the
 * ByokAtomicWriteCore discipline; its unique temp name is reused here).
 */
const cropFrameToFile = async (sourceAbsolutePath, frame, targetPath) => {
  const sharpInstance = getSharp();
  if (!sharpInstance) {
    throw new Error('the sharp image encoder is not installed');
  }
  const tempName = makeByokAtomicTempName(
    path.basename(targetPath),
    crypto.randomBytes(6).toString('hex')
  );
  const tempPath = path.join(path.dirname(targetPath), tempName);
  try {
    await sharpInstance(sourceAbsolutePath, { failOn: 'none' })
      .extract({
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
      })
      .png()
      .toFile(tempPath);
    fs.renameSync(tempPath, targetPath);
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (error) {
      // The temp file is already gone (or unremovable) — never fatal.
    }
  }
};

/**
 * Apply a whole slice request. Answers `{ ok: true, writtenAbsolutePaths }`
 * in frame order, or `{ ok: false, error }` — never throws, even when the
 * payload itself is malformed.
 */
const sliceForkSpriteSheet = async payload => {
  const validated = validateSliceRequest(payload);
  if (!validated.ok) return validated;
  const {
    sourceAbsolutePath,
    assetsFolderAbsolutePath,
    frames,
    targets,
  } = validated.data;

  // The source is only READ, but it must exist, be a file and be sane.
  try {
    const stat = fs.statSync(sourceAbsolutePath);
    if (!stat.isFile()) {
      return { ok: false, error: 'The source sprite sheet is not a file.' };
    }
    if (stat.size > FORK_SPRITE_SHEET_MAX_SOURCE_BYTES) {
      return {
        ok: false,
        error: `Refused: the source image is larger than ${FORK_SPRITE_SHEET_MAX_SOURCE_BYTES} bytes.`,
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: `The source image could not be read: ${describeError(error)}`,
    };
  }

  try {
    fs.mkdirSync(assetsFolderAbsolutePath, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      error: `The assets folder could not be created: ${describeError(error)}`,
    };
  }

  // A19-2: refuse the WHOLE call when any target already exists — checked
  // before any crop, so nothing is ever overwritten and no half-run starts.
  for (let index = 0; index < targets.length; index++) {
    if (fs.existsSync(targets[index])) {
      return {
        ok: false,
        error: `Refused: "${path.basename(
          targets[index]
        )}" already exists in the assets folder — no file was overwritten.`,
      };
    }
  }

  const written = [];
  for (let index = 0; index < frames.length; index++) {
    try {
      await cropFrameToFile(sourceAbsolutePath, frames[index], targets[index]);
      written.push(targets[index]);
    } catch (error) {
      // Frames already renamed stay (complete, correctly named files); the
      // retry is safe thanks to the existing-file guard above.
      return {
        ok: false,
        error: `Frame ${index} ("${path.basename(
          targets[index]
        )}") could not be written: ${describeError(error)} — the ${
          written.length
        } frame(s) already written stay on disk.`,
      };
    }
  }
  return { ok: true, writtenAbsolutePaths: written };
};

const registerForkSpriteSheetSlicer = ipcMain => {
  ipcMain.handle(FORK_SPRITE_SHEET_SLICE_CHANNEL, async (event, payload) => {
    try {
      return await sliceForkSpriteSheet(payload);
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  });
};

module.exports = {
  FORK_SPRITE_SHEET_SLICE_CHANNEL,
  FORK_SPRITE_SHEET_MAX_SOURCE_BYTES,
  validateSliceRequest,
  sliceForkSpriteSheet,
  registerForkSpriteSheetSlicer,
};
