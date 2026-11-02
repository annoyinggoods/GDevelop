const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

// Phase 16.2 — the desktop applier of the build-time asset optimizer.
//
// This module is deliberately a THIN APPLIER: the plan (which file, which
// transform, which options) is decided by the pure renderer-side policy
// (Fork/AssetBuild/ForkAssetPlan.js) and arrives over IPC already final. All
// this side does is:
//   1. re-check that every relative path stays inside the folder it was given
//      (the renderer applies the same rule in its own tested code; the check
//      is repeated HERE because this is the process that writes to disk),
//   2. run the encoder of the entry's transform (sharp for images, the
//      ffmpeg-static binary for audio),
//   3. write the result IN PLACE, same file name, same format — a rename
//      would break the runtime's resource-name lookup (D16-6),
//   4. report per-file before/after bytes, or the error that left the file
//      untouched.
//
// It owns no policy, walks nothing and never throws: every handler answers
// with a value, because an exception inside ipcMain.handle rejects the
// renderer's invoke and turns an ordinary refusal into a crash.
//
// Both encoders are native/optional and are requeried LAZILY: a build without
// `sharp` (or with a broken ABI after an Electron upgrade) must still start
// the app — the capabilities probe reports it as absent and the planner then
// skips every image instead of planning a transform nothing can run.

const FORK_ASSET_OPTIMIZE_APPLY_CHANNEL = 'fork-asset-optimize-apply';
const FORK_ASSET_OPTIMIZE_CAPABILITIES_CHANNEL =
  'fork-asset-optimize-capabilities';

/** The codecs of the lossy formats the planner may ask for. */
const AUDIO_CODECS = {
  mp3: 'libmp3lame',
  ogg: 'libvorbis',
  m4a: 'aac',
  aac: 'aac',
  opus: 'libopus',
};

/** A generous ceiling: a game asset is never this big; a runaway is refused. */
const FORK_ASSET_MAX_FILE_BYTES = 512 * 1024 * 1024;

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

let ffmpegBinaryPath = null;
let ffmpegLoaded = false;
const getFfmpegPath = () => {
  if (ffmpegLoaded) return ffmpegBinaryPath;
  ffmpegLoaded = true;
  try {
    const resolved = require('ffmpeg-static');
    ffmpegBinaryPath = typeof resolved === 'string' ? resolved : null;
  } catch (error) {
    ffmpegBinaryPath = null;
  }
  return ffmpegBinaryPath;
};

const describeError = error =>
  error && error.message ? error.message : String(error);

/**
 * True only when `candidate` resolves inside `folderPath` — the same rule the
 * BYOK file handlers apply (no `..` escape, no absolute target, no sibling
 * prefix like `/projects/game2` inside `/projects/game`).
 */
const isInsideFolder = (folderPath, candidate) => {
  const relative = path.relative(folderPath, candidate);
  if (!relative) return true; // the folder itself
  if (path.isAbsolute(relative)) return false;
  const backslash = String.fromCharCode(92);
  const segments = relative.split(/[\\/]+/);
  return !segments.includes('..');
};

/**
 * The folder-level guard ([P16-paths]): the per-entry confinement already
 * refuses every escape OUT of the folder, but the folder ITSELF was trusted.
 * This closes the residual "which folder" question as far as it can be
 * closed without breaking legitimate exports (the manual "export to a
 * folder" path sends any user-chosen folder, so an allowlist of temp +
 * project folder is NOT an option): a folder that IS a filesystem root, the
 * OS home or the OS temp dir itself is refused — those are never a GDevelop
 * export copy, and re-encoding every same-named file under them would be a
 * runaway.
 */
const isAllowedForkAssetFolder = folderPath => {
  if (typeof folderPath !== 'string' || !folderPath) return false;
  if (path.parse(folderPath).root === folderPath) return false; // "C:\", "/", "\\"
  try {
    if (path.resolve(folderPath) === path.resolve(os.homedir())) return false;
    if (path.resolve(folderPath) === path.resolve(os.tmpdir())) return false;
  } catch (error) {
    return false;
  }
  return true;
};

const resolveEntryPath = (folderPath, relativePath) => {
  if (typeof relativePath !== 'string' || !relativePath) {
    return { ok: false, error: 'The entry has no relative path.' };
  }
  if (relativePath.includes(':')) {
    return { ok: false, error: 'Refused: an absolute path is not allowed.' };
  }
  const absolutePath = path.join(folderPath, relativePath);
  if (!isInsideFolder(folderPath, absolutePath)) {
    return { ok: false, error: 'Refused: the path escapes the export folder.' };
  }
  return { ok: true, absolutePath };
};

/** A same-folder temp name with the SAME extension (sharp keys on it). */
const makeTempPath = absolutePath => {
  const extension = path.extname(absolutePath);
  const base = path.basename(absolutePath, extension);
  const random = crypto.randomBytes(6).toString('hex');
  return path.join(
    path.dirname(absolutePath),
    `${base}.forkopt-${random}${extension}`
  );
};

/**
 * Re-encode one image in place. Writes to a temp file first and renames only
 * on success, so a failure at any point leaves the exported file exactly as
 * the exporter wrote it (D16-7).
 */
const optimizeImageEntry = async (absolutePath, entry) => {
  const sharpInstance = getSharp();
  if (!sharpInstance) {
    throw new Error('the sharp image encoder is not installed');
  }
  const options =
    entry.options && typeof entry.options === 'object' ? entry.options : {};
  if (entry.transform === 'gif') {
    // animated: true keeps every frame — without it sharp keeps only the
    // first one and an animated GIF silently loses its animation. The input
    // is read into a buffer first: with an animated source sharp keeps the
    // input file mapped past the write, and renaming the output over a still
    // open input fails with EPERM on Windows (verified with a real
    // ffmpeg-generated GIF). An animated re-encode buffers every frame in
    // memory anyway, so this changes nothing about the peak usage.
    const buffer = fs.readFileSync(absolutePath);
    const tempPath = makeTempPath(absolutePath);
    try {
      await sharpInstance(buffer, {
        failOn: 'none',
        animated: options.animated === true,
      })
        .gif({ animated: options.animated === true })
        .toFile(tempPath);
      fs.renameSync(tempPath, absolutePath);
    } finally {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch (error) {
        // The temp file is already gone (or unremovable) — never fatal.
      }
    }
    return;
  }
  let pipeline = sharpInstance(absolutePath, { failOn: 'none' });
  if (entry.transform === 'png') {
    pipeline = pipeline.png({
      compressionLevel: options.compressionLevel,
      effort: options.effort,
      palette: options.palette === true,
    });
  } else if (entry.transform === 'jpeg') {
    pipeline = pipeline.jpeg({ quality: options.quality });
  } else if (entry.transform === 'webp') {
    pipeline = pipeline.webp({ quality: options.quality });
  } else {
    throw new Error(`unknown image transform "${String(entry.transform)}"`);
  }
  const tempPath = makeTempPath(absolutePath);
  try {
    await pipeline.toFile(tempPath);
    fs.renameSync(tempPath, absolutePath);
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (error) {
      // The temp file is already gone (or unremovable) — never fatal.
    }
  }
};

const runFfmpeg = (binaryPath, args) =>
  new Promise((resolve, reject) => {
    execFile(binaryPath, args, { maxBuffer: 16 * 1024 * 1024 }, error => {
      if (error) reject(error);
      else resolve();
    });
  });

/**
 * Re-encode one lossy-audio file in place, same container, at the bitrate the
 * plan carries. Same temp+rename discipline as the images.
 */
const optimizeAudioEntry = async (absolutePath, entry) => {
  const binaryPath = getFfmpegPath();
  if (!binaryPath) {
    throw new Error('the ffmpeg audio encoder is not installed');
  }
  const options =
    entry.options && typeof entry.options === 'object' ? entry.options : {};
  const format = String(options.format || path.extname(absolutePath).slice(1));
  const codec = AUDIO_CODECS[format];
  if (!codec) {
    throw new Error(`unsupported audio container "${format}"`);
  }
  const bitrateKbps = Number.isFinite(options.bitrateKbps)
    ? Math.round(options.bitrateKbps)
    : 128;
  const tempPath = makeTempPath(absolutePath);
  try {
    await runFfmpeg(binaryPath, [
      '-y',
      '-loglevel',
      'error',
      '-i',
      absolutePath,
      '-codec:a',
      codec,
      '-b:a',
      `${bitrateKbps}k`,
      tempPath,
    ]);
    fs.renameSync(tempPath, absolutePath);
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (error) {
      // Same as the image path: a leftover temp file is never fatal.
    }
  }
};

const applyOneEntry = async (folderPath, entry) => {
  const relativePath =
    entry && typeof entry.relativePath === 'string' ? entry.relativePath : '';
  const resolved = resolveEntryPath(folderPath, relativePath);
  if (!resolved.ok) {
    return {
      relativePath,
      bytesBefore: 0,
      bytesAfter: 0,
      error: resolved.error,
    };
  }
  const { absolutePath } = resolved;

  let bytesBefore;
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) {
      return {
        relativePath,
        bytesBefore: 0,
        bytesAfter: 0,
        error: 'That export entry is not a file.',
      };
    }
    bytesBefore = stat.size;
    if (bytesBefore > FORK_ASSET_MAX_FILE_BYTES) {
      return {
        relativePath,
        bytesBefore,
        bytesAfter: bytesBefore,
        error: `Refused: the file is larger than ${FORK_ASSET_MAX_FILE_BYTES} bytes.`,
      };
    }
  } catch (error) {
    return {
      relativePath,
      bytesBefore: 0,
      bytesAfter: 0,
      error: `The export file could not be read: ${describeError(error)}`,
    };
  }

  try {
    if (entry.kind === 'image') {
      await optimizeImageEntry(absolutePath, entry);
    } else if (entry.kind === 'audio') {
      await optimizeAudioEntry(absolutePath, entry);
    } else {
      throw new Error(`unknown entry kind "${String(entry.kind)}"`);
    }
  } catch (error) {
    // The file is untouched (temp+rename): report the size it kept.
    return {
      relativePath,
      bytesBefore,
      bytesAfter: bytesBefore,
      error: describeError(error),
    };
  }

  let bytesAfter = bytesBefore;
  try {
    bytesAfter = fs.statSync(absolutePath).size;
  } catch (error) {
    // Unreadable after the write: report it as unchanged rather than lying.
    return {
      relativePath,
      bytesBefore,
      bytesAfter: bytesBefore,
      error: `The optimized file could not be measured: ${describeError(
        error
      )}`,
    };
  }
  return { relativePath, bytesBefore, bytesAfter, error: null };
};

/**
 * Apply a whole plan. Answers one result per entry, in the same order, and
 * never throws even when the payload itself is malformed.
 */
const applyForkAssetOptimizationPlan = async (payload, overrides) => {
  const dependencies = {
    applyEntry: applyOneEntry,
    ...(overrides || {}),
  };
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'The optimizer received a malformed payload.' };
  }
  const folderPath = payload.folderPath;
  if (typeof folderPath !== 'string' || !folderPath) {
    return { ok: false, error: 'The optimizer received no export folder.' };
  }
  if (!isAllowedForkAssetFolder(folderPath)) {
    return {
      ok: false,
      error:
        'Refused: the export folder is a system folder (a drive root, the home or the temp directory).',
    };
  }
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  const results = [];
  for (const entry of entries) {
    try {
      results.push(await dependencies.applyEntry(folderPath, entry));
    } catch (error) {
      const relativePath =
        entry && typeof entry.relativePath === 'string'
          ? entry.relativePath
          : '';
      results.push({
        relativePath,
        bytesBefore: 0,
        bytesAfter: 0,
        error: describeError(error),
      });
    }
  }
  return { ok: true, data: results };
};

const probeForkAssetEncoderCapabilities = () => ({
  images: !!getSharp(),
  audio: !!getFfmpegPath(),
});

const registerForkAssetOptimizer = ipcMain => {
  ipcMain.handle(FORK_ASSET_OPTIMIZE_APPLY_CHANNEL, async (event, payload) => {
    try {
      return await applyForkAssetOptimizationPlan(payload);
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  });
  ipcMain.handle(FORK_ASSET_OPTIMIZE_CAPABILITIES_CHANNEL, () => {
    try {
      return probeForkAssetEncoderCapabilities();
    } catch (error) {
      return { images: false, audio: false };
    }
  });
};

module.exports = {
  FORK_ASSET_OPTIMIZE_APPLY_CHANNEL,
  FORK_ASSET_OPTIMIZE_CAPABILITIES_CHANNEL,
  FORK_ASSET_MAX_FILE_BYTES,
  isInsideFolder,
  isAllowedForkAssetFolder,
  resolveEntryPath,
  applyForkAssetOptimizationPlan,
  probeForkAssetEncoderCapabilities,
  registerForkAssetOptimizer,
};
