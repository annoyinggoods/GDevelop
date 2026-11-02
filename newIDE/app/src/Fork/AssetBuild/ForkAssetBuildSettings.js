// @flow

/**
 * Phase 16 — the build-time asset optimization settings (D16-6/D16-7/D16-8).
 *
 * What they are: the policy the exporter applies to the files it copied into
 * the export folder. In-place, same-format, same-filename — never the
 * project's originals (D16-2).
 *
 * Where they live: the shared `PreferencesValues` blob, under the
 * `forkAssetBuild` field (persisted by PreferencesProvider in the
 * `gd-preferences` localStorage key). This module stays the ONE access point
 * — the same get/set/subscribe API the tab, the export pipeline and the chat
 * tools already use — so nothing else needs to know how the blob is laid
 * out:
 * - the getter reads the persisted preferences lazily (a cache miss parses
 *   the blob) and normalizes everything, so a missing or corrupt payload
 *   degrades to the safe defaults;
 * - the setter only updates the in-memory value and notifies; the
 *   PERSISTENCE is done by the PreferencesProvider, which subscribes to this
 *   store (the bridge in its componentDidMount) and folds the value into its
 *   state — a single writer for the whole `gd-preferences` blob, so the
 *   provider's full-blob writes can never clobber a setting changed here;
 * - a settings blob written by the pre-Preferences storage (the fork-owned
 *   `gd-fork-asset-build-settings` localStorage key) is adopted on read, so
 *   an upgrade keeps what was configured.
 *
 * Storage discipline: the getter is total, the setter never throws (a
 * storage refusal — private mode, quota — still updates the in-memory value,
 * so the running session honors the change).
 */

export type ForkAssetBuildSettings = {|
  /** Master switch (D16-7: opt-in, off until the owner turns it on). */
  enabled: boolean,
  /** PNG zlib compression level, 0 (fast) to 9 (smallest, still lossless). */
  pngLevel: number,
  /** JPEG quality, 1-100; 85 is visually lossless at game resolutions. */
  jpegQuality: number,
  /** WebP quality, 1-100; separate from JPEG since 2026-10-08 ([P16-audio-webp-knob]). */
  webpQuality: number,
  /** Also optimize the manual "export to folder" path (D16-5). */
  optimizeManualExports: boolean,
  /** Re-encode lossy audio (mp3/ogg/m4a/aac/opus) at the chosen bitrate. */
  audioEnabled: boolean,
  /** The target bitrate (kbps) of the lossy audio re-encode. */
  audioBitrateKbps: number,
|};

export const DEFAULT_FORK_ASSET_BUILD_SETTINGS: ForkAssetBuildSettings = {
  enabled: false,
  pngLevel: 9,
  jpegQuality: 85,
  webpQuality: 85,
  optimizeManualExports: true,
  audioEnabled: true,
  audioBitrateKbps: 128,
};

/**
 * The field name inside the shared preferences blob (`gd-preferences`, the
 * localStorage item PreferencesProvider owns). Keep in sync with the
 * `localStorageItem` constant of PreferencesProvider.js.
 */
export const FORK_ASSET_BUILD_SETTINGS_PREFERENCES_FIELD = 'forkAssetBuild';

/**
 * The localStorage item of the shared preferences blob. This mirrors
 * PreferencesProvider.js's `localStorageItem` (duplicated here only to avoid
 * an import cycle: the provider imports this module for its bridge).
 */
export const PREFERENCES_STORAGE_ITEM = 'gd-preferences';

/**
 * The localStorage key of the LEGACY, fork-owned settings blob (used before
 * the settings moved into the shared preferences). Only read, for adoption.
 */
export const FORK_ASSET_BUILD_SETTINGS_STORAGE_KEY =
  'gd-fork-asset-build-settings';

/** Coerce one numeric knob into its documented range (or the fallback). */
const clampInteger = (
  value: mixed,
  min: number,
  max: number,
  fallback: number
): number => {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  const rounded = Math.round(number);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
};

/** One boolean knob: only an explicit `false` turns a default-on knob off. */
const booleanOrDefault = (value: mixed, fallback: boolean): boolean => {
  if (value === true) return true;
  if (value === false) return false;
  return fallback;
};

/**
 * Normalize an untrusted payload (a chat tool argument, a hand-edited
 * preferences entry) into a valid settings object: every knob is clamped
 * into its documented range and every missing field falls back to its safe
 * default. Never throws.
 */
export const normalizeForkAssetBuildSettings = (
  raw: mixed
): ForkAssetBuildSettings => {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_FORK_ASSET_BUILD_SETTINGS };
  }
  const source: Object = raw;
  return {
    enabled: booleanOrDefault(
      source.enabled,
      DEFAULT_FORK_ASSET_BUILD_SETTINGS.enabled
    ),
    pngLevel: clampInteger(
      source.pngLevel,
      0,
      9,
      DEFAULT_FORK_ASSET_BUILD_SETTINGS.pngLevel
    ),
    jpegQuality: clampInteger(
      source.jpegQuality,
      1,
      100,
      DEFAULT_FORK_ASSET_BUILD_SETTINGS.jpegQuality
    ),
    webpQuality: clampInteger(
      source.webpQuality,
      1,
      100,
      DEFAULT_FORK_ASSET_BUILD_SETTINGS.webpQuality
    ),
    optimizeManualExports: booleanOrDefault(
      source.optimizeManualExports,
      DEFAULT_FORK_ASSET_BUILD_SETTINGS.optimizeManualExports
    ),
    audioEnabled: booleanOrDefault(
      source.audioEnabled,
      DEFAULT_FORK_ASSET_BUILD_SETTINGS.audioEnabled
    ),
    audioBitrateKbps: clampInteger(
      source.audioBitrateKbps,
      32,
      320,
      DEFAULT_FORK_ASSET_BUILD_SETTINGS.audioBitrateKbps
    ),
  };
};

let cachedSettings: ?ForkAssetBuildSettings = null;
const settingsListeners: Set<() => void> = new Set();

const parseStorageItem = (raw: ?string): ?Object => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    // A corrupt payload must not break the app — the defaults take over.
    return null;
  }
};

const readStoredValue = (): mixed => {
  try {
    if (typeof localStorage === 'undefined') return null;
    const preferences = parseStorageItem(
      localStorage.getItem(PREFERENCES_STORAGE_ITEM)
    );
    const fromPreferences = preferences
      ? preferences[FORK_ASSET_BUILD_SETTINGS_PREFERENCES_FIELD]
      : undefined;
    if (typeof fromPreferences !== 'undefined') return fromPreferences;
    // Nothing in the shared blob yet: adopt the legacy fork-owned blob, so
    // settings configured before the migration survive the upgrade.
    return parseStorageItem(
      localStorage.getItem(FORK_ASSET_BUILD_SETTINGS_STORAGE_KEY)
    );
  } catch (error) {
    return null;
  }
};

/** The current settings (the safe defaults when nothing was ever stored). */
export const getForkAssetBuildSettings = (): ForkAssetBuildSettings => {
  if (cachedSettings) return cachedSettings;
  cachedSettings = normalizeForkAssetBuildSettings(readStoredValue());
  return cachedSettings;
};

/**
 * Merge a partial update into the current settings and notify the
 * subscribers (the PreferencesProvider bridge persists the result into the
 * shared preferences blob). Returns the normalized settings that took
 * effect, so a caller (the chat tool) can report exactly that.
 */
export const setForkAssetBuildSettings = (
  partial: mixed
): ForkAssetBuildSettings => {
  const merged =
    partial && typeof partial === 'object'
      ? { ...getForkAssetBuildSettings(), ...(partial: Object) }
      : getForkAssetBuildSettings();
  const next = normalizeForkAssetBuildSettings(merged);
  cachedSettings = next;
  settingsListeners.forEach(listener => listener());
  return next;
};

/** Subscribe to settings changes (the Build tab re-renders from this). */
export const subscribeForkAssetBuildSettings = (
  listener: () => void
): (() => void) => {
  settingsListeners.add(listener);
  return () => {
    settingsListeners.delete(listener);
  };
};

/** Test-only: drop the cache, the listeners and the persisted blobs. */
export const resetForkAssetBuildSettingsForTests = (): void => {
  cachedSettings = null;
  settingsListeners.clear();
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(FORK_ASSET_BUILD_SETTINGS_STORAGE_KEY);
      localStorage.removeItem(PREFERENCES_STORAGE_ITEM);
    }
  } catch (error) {
    // Nothing to clean up when storage is unavailable.
  }
};
