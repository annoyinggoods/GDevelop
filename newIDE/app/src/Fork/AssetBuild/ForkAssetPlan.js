// @flow

/**
 * Phase 16.1 — the pure optimization planner.
 *
 * Decide, from a listing and the settings, exactly what happens to each file
 * — with no filesystem, no `sharp`, no Electron — so the policy is testable
 * in isolation (the Electron main only *applies* the plan, see 16.2).
 *
 * The listing is the export folder itself: the exporter copies every
 * resource FLAT by basename (ExporterHelper → ProjectResourcesCopier with
 * `PreserveDirectoriesStructure(false)`), so the per-file kind has to be
 * decided by extension, never by a manifest (there is none).
 *
 * The rules are the safe defaults of D16-6:
 * - in place, same format, same file name (a rename would break the runtime's
 *   resource-name lookup);
 * - PNG stays a lossless PNG re-encode; JPEG and WebP keep their format and
 *   take the quality knob; a transparent PNG is therefore NEVER planned as a
 *   JPEG transform;
 * - lossy audio is re-encoded at the bitrate knob (opt-out); lossless audio
 *   (.wav/.flac) is never touched — it would lose fidelity without a real
 *   size win, and audio transcode-to-a-new-codec is explicitly out of this
 *   phase;
 * - GIF is re-encoded with { animated: true } so the animation survives;
 * - anything else (SVG, BMP, TIFF, JSON, fonts, …) is skipped with a reason.
 */

import {
  DEFAULT_FORK_ASSET_BUILD_SETTINGS,
  type ForkAssetBuildSettings,
} from './ForkAssetBuildSettings';

/** One file of the export folder listing (the planner's only input). */
export type ForkAssetPlanFile = {|
  relativePath: string,
  /** Lower-case, dot included ('.png'), '' when the name has no extension. */
  extension: string,
  sizeBytes: number,
|};

/** What the encoders of this build can actually do (probed, 16.2). */
export type ForkAssetPlanEncoderCapabilities = {|
  images: boolean,
  audio: boolean,
|};

export const DEFAULT_FORK_ASSET_ENCODER_CAPABILITIES: ForkAssetPlanEncoderCapabilities = {
  images: true,
  audio: true,
};

export type ForkAssetPlanEntry = {|
  relativePath: string,
  kind: 'image' | 'audio' | 'skip',
  /** 'png' | 'jpeg' | 'webp' | 'gif' | 'audio'; null for a skip. */
  transform: ?string,
  /** The encoder options (already decided here — the applier owns no policy). */
  options: Object,
  /** Why the file is skipped; null for a planned transform. */
  skipReason: ?string,
  /**
   * The stable machine code of the skip reason ('below-byte-floor', …), for
   * the report UI's translation layer; null for a planned transform. The
   * prose `skipReason` stays the model-facing text.
   */
  skipReasonCode: ?string,
|};

/** What the applier reports back per planned file (16.2). */
export type ForkAssetApplyResult = {|
  relativePath: string,
  bytesBefore: number,
  bytesAfter: number,
  error: ?string,
|};

export type ForkAssetOptimizationSummary = {|
  totalBytesBefore: number,
  totalBytesAfter: number,
  savedBytes: number,
  /** Planned files the applier re-encoded without an error. */
  optimizedCount: number,
  /** Planned files the applier refused/whose encoder failed (left as-is). */
  failedCount: number,
  largestSavings: Array<{| relativePath: string, savedBytes: number |}>,
|};

/** The images re-encoded in place, and the transform each one maps to. */
export const FORK_ASSET_IMAGE_TRANSFORMS: { [string]: string } = {
  '.png': 'png',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.webp': 'webp',
  // GIF is re-encoded with { animated: true } — without it, sharp keeps only
  // the first frame and an animated GIF silently loses its animation.
  '.gif': 'gif',
};

/** Lossy audio that gains from a bitrate re-encode, and lossless audio. */
export const FORK_ASSET_LOSSY_AUDIO_EXTENSIONS: Set<string> = new Set<string>([
  '.mp3',
  '.ogg',
  '.m4a',
  '.aac',
  '.opus',
]);
export const FORK_ASSET_LOSSLESS_AUDIO_EXTENSIONS: Set<string> = new Set<string>(
  ['.wav', '.flac']
);

/**
 * Below this size a re-encode is not worth a decoder round-trip (tiny icons,
 * one-pixel placeholders): the file is skipped with a reason instead of being
 * silently dropped.
 */
export const FORK_ASSET_IMAGE_FLOOR_BYTES = 4096;

/** How many entries the report's "largest savings" list keeps. */
export const FORK_ASSET_LARGEST_SAVINGS_LIMIT = 5;

/**
 * The lower-case extension of a relative path ('.PNG' → '.png'), or '' when
 * the file has none (or is a dot-file like '.gitignore').
 */
export const getForkAssetFileExtension = (relativePath: string): string => {
  const name = relativePath.split('/').pop() || '';
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex <= 0) return '';
  return name.slice(dotIndex).toLowerCase();
};

const makeSkipEntry = (
  relativePath: string,
  skipReasonCode: string,
  skipReason: string
): ForkAssetPlanEntry => ({
  relativePath,
  kind: 'skip',
  transform: null,
  options: {},
  skipReason,
  skipReasonCode,
});

const makeImageOptions = (
  transform: string,
  settings: ForkAssetBuildSettings
): Object => {
  if (transform === 'png') {
    // Lossless: full zlib level, no palette quantization (that would drop
    // colors) and alpha preserved — a transparency-safe re-encode.
    return {
      compressionLevel: settings.pngLevel,
      effort: 10,
      palette: false,
    };
  }
  if (transform === 'gif') {
    // animated: true is what keeps every frame — see FORK_ASSET_IMAGE_TRANSFORMS.
    return { animated: true };
  }
  if (transform === 'webp') {
    // WebP has its own quality knob ([P16-audio-webp-knob]); alpha kept when
    // the source has it (D16-6: never strip alpha, never migrate).
    return { quality: settings.webpQuality };
  }
  // JPEG keeps its format and takes the JPEG quality knob.
  return { quality: settings.jpegQuality };
};

const planImageFile = (options: {|
  relativePath: string,
  extension: string,
  sizeBytes: number,
  settings: ForkAssetBuildSettings,
  capabilities: ForkAssetPlanEncoderCapabilities,
|}): ForkAssetPlanEntry => {
  const { relativePath, extension, sizeBytes, settings } = options;
  if (!options.capabilities.images) {
    return makeSkipEntry(
      relativePath,
      'encoder-unavailable-image',
      'No image encoder is available in this build, so the file was left as exported.'
    );
  }
  const transform = FORK_ASSET_IMAGE_TRANSFORMS[extension];
  if (!transform) {
    return makeSkipEntry(
      relativePath,
      'unsupported-image-format',
      `Unsupported image format "${extension}" — only PNG, JPEG, WebP and GIF are re-encoded.`
    );
  }
  if (sizeBytes < FORK_ASSET_IMAGE_FLOOR_BYTES) {
    return makeSkipEntry(
      relativePath,
      'below-byte-floor',
      `The image is ${sizeBytes} bytes, below the ${FORK_ASSET_IMAGE_FLOOR_BYTES}-byte floor — re-encoding would not help.`
    );
  }
  return {
    relativePath,
    kind: 'image',
    transform,
    options: makeImageOptions(transform, settings),
    skipReason: null,
    skipReasonCode: null,
  };
};

const planAudioFile = (options: {|
  relativePath: string,
  extension: string,
  settings: ForkAssetBuildSettings,
  capabilities: ForkAssetPlanEncoderCapabilities,
|}): ForkAssetPlanEntry => {
  const { relativePath, extension, settings } = options;
  if (!settings.audioEnabled) {
    return makeSkipEntry(
      relativePath,
      'audio-disabled',
      'Audio optimization is turned off in the Build preferences.'
    );
  }
  if (!options.capabilities.audio) {
    return makeSkipEntry(
      relativePath,
      'encoder-unavailable-audio',
      'No audio encoder is configured (the ffmpeg dependency is missing), so the file was left as exported.'
    );
  }
  if (FORK_ASSET_LOSSLESS_AUDIO_EXTENSIONS.has(extension)) {
    return makeSkipEntry(
      relativePath,
      'lossless-audio',
      `Lossless audio ("${extension}") is not re-encoded — it would lose fidelity without a real size win.`
    );
  }
  if (!FORK_ASSET_LOSSY_AUDIO_EXTENSIONS.has(extension)) {
    return makeSkipEntry(
      relativePath,
      'unsupported-audio-format',
      `Unsupported audio format "${extension}".`
    );
  }
  return {
    relativePath,
    kind: 'audio',
    transform: 'audio',
    options: {
      format: extension.slice(1),
      bitrateKbps: settings.audioBitrateKbps,
    },
    skipReason: null,
    skipReasonCode: null,
  };
};

const planOneForkAssetFile = (options: {|
  file: ForkAssetPlanFile,
  settings: ForkAssetBuildSettings,
  capabilities: ForkAssetPlanEncoderCapabilities,
|}): ForkAssetPlanEntry => {
  const { file, settings, capabilities } = options;
  const extension = (file.extension || '').toLowerCase();
  const sizeBytes = file.sizeBytes;

  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return makeSkipEntry(
      file.relativePath,
      'empty-file',
      'The file is empty (0 bytes) — nothing to re-encode.'
    );
  }
  if (FORK_ASSET_IMAGE_TRANSFORMS[extension]) {
    return planImageFile({
      relativePath: file.relativePath,
      extension,
      sizeBytes,
      settings,
      capabilities,
    });
  }
  if (
    FORK_ASSET_LOSSY_AUDIO_EXTENSIONS.has(extension) ||
    FORK_ASSET_LOSSLESS_AUDIO_EXTENSIONS.has(extension)
  ) {
    return planAudioFile({
      relativePath: file.relativePath,
      extension,
      settings,
      capabilities,
    });
  }
  return makeSkipEntry(
    file.relativePath,
    'unsupported-extension',
    `Unsupported extension "${extension ||
      '(none)'}" — only PNG, JPEG, WebP, GIF images and lossy audio are re-encoded.`
  );
};

/**
 * Plan exactly what happens to every file of a listing. Pure: the same
 * listing and settings always produce the same plan. `enabled` is NOT read
 * here — the caller gates on it (the pipeline never plans while the feature
 * is off), so the same planner also serves the read-only projection of the
 * `report_asset_optimization` tool.
 */
export const planForkAssetOptimization = (options: {|
  files: Array<ForkAssetPlanFile>,
  /** Absent: the safe defaults of D16-6 are used. */
  settings?: ?ForkAssetBuildSettings,
  capabilities?: ForkAssetPlanEncoderCapabilities,
|}): Array<ForkAssetPlanEntry> => {
  const settings: ForkAssetBuildSettings =
    options.settings || DEFAULT_FORK_ASSET_BUILD_SETTINGS;
  const capabilities =
    options.capabilities || DEFAULT_FORK_ASSET_ENCODER_CAPABILITIES;
  return options.files.map(file =>
    planOneForkAssetFile({ file, settings, capabilities })
  );
};

/**
 * Fold the applier's per-file results into the report totals: the sum of the
 * before/after bytes, the saved total, how many files were really re-encoded
 * (an entry with an `error` was left untouched — D16-7), and the largest
 * wins. Entries that came back bigger than they went in are reported with
 * zero savings (the applier should keep the original; the planner's floor and
 * the lossless settings make real growth unlikely, but a report must not
 * claim a win it did not get).
 */
export const summarizeForkAssetPlanResults = (
  results: Array<ForkAssetApplyResult>
): ForkAssetOptimizationSummary => {
  const savings = [];
  let totalBytesBefore = 0;
  let totalBytesAfter = 0;
  let savedBytes = 0;
  let optimizedCount = 0;
  let failedCount = 0;

  for (const result of results) {
    const bytesBefore =
      Number.isFinite(result.bytesBefore) && result.bytesBefore >= 0
        ? result.bytesBefore
        : 0;
    const bytesAfter = Number.isFinite(result.bytesAfter)
      ? result.bytesAfter
      : bytesBefore;
    totalBytesBefore += bytesBefore;
    totalBytesAfter += bytesAfter;
    if (result.error) {
      failedCount += 1;
      continue;
    }
    optimizedCount += 1;
    const saved = bytesBefore - bytesAfter;
    if (saved > 0) {
      savedBytes += saved;
      savings.push({ relativePath: result.relativePath, savedBytes: saved });
    }
  }

  savings.sort(
    (first, second) =>
      second.savedBytes - first.savedBytes ||
      (first.relativePath < second.relativePath ? -1 : 1)
  );

  return {
    totalBytesBefore,
    totalBytesAfter,
    savedBytes,
    optimizedCount,
    failedCount,
    largestSavings: savings.slice(0, FORK_ASSET_LARGEST_SAVINGS_LIMIT),
  };
};
