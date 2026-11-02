// @flow

/**
 * Phase 17.3 — the asset-pipeline settings (D17-5/D17-7).
 *
 * Two switches:
 * - `autoRegister` (default ON): a file dropped into the project folder is
 *   registered as a resource automatically, confined and reversible;
 * - `autoReload` (default ON): a changed asset reloads in the editors and
 *   the running previews through the existing change-path.
 *
 * The mechanism is a copy of Fork/AssetBuild/ForkAssetBuildSettings.js: one
 * fork-owned localStorage blob with an in-memory cache, a total getter (a
 * missing/corrupt payload normalizes to the defaults), a never-throwing
 * setter (a storage refusal still updates the in-memory value so the
 * running session honors the change), subscription and test reset. The
 * UI lives in the Assets view (ForkAssetsView), not in Preferences.
 */

export type ForkAssetPipelineSettings = {|
  autoRegister: boolean,
  autoReload: boolean,
|};

export const DEFAULT_FORK_ASSET_PIPELINE_SETTINGS: ForkAssetPipelineSettings = {
  autoRegister: true,
  autoReload: true,
};

/** The localStorage key of the settings blob (fork-owned). */
export const FORK_ASSET_PIPELINE_SETTINGS_STORAGE_KEY =
  'gd-fork-asset-pipeline-settings';

const booleanOrDefault = (value: mixed, fallback: boolean): boolean => {
  if (value === true) return true;
  if (value === false) return false;
  return fallback;
};

/**
 * Normalize an untrusted payload (a hand-edited localStorage entry) into a
 * valid settings object. Never throws.
 */
export const normalizeForkAssetPipelineSettings = (
  raw: mixed
): ForkAssetPipelineSettings => {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_FORK_ASSET_PIPELINE_SETTINGS };
  }
  const source: Object = raw;
  return {
    autoRegister: booleanOrDefault(
      source.autoRegister,
      DEFAULT_FORK_ASSET_PIPELINE_SETTINGS.autoRegister
    ),
    autoReload: booleanOrDefault(
      source.autoReload,
      DEFAULT_FORK_ASSET_PIPELINE_SETTINGS.autoReload
    ),
  };
};

let cachedSettings: ?ForkAssetPipelineSettings = null;
const settingsListeners: Set<() => void> = new Set();

const readPersistedSettings = (): mixed => {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(FORK_ASSET_PIPELINE_SETTINGS_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (error) {
    // A corrupt payload must not break the app — the defaults take over.
    return null;
  }
};

/** The current settings (defaults when nothing was ever stored). */
export const getForkAssetPipelineSettings = (): ForkAssetPipelineSettings => {
  if (cachedSettings) return cachedSettings;
  cachedSettings = normalizeForkAssetPipelineSettings(readPersistedSettings());
  return cachedSettings;
};

/**
 * Merge a partial update into the current settings, persist the whole blob
 * and notify the subscribers. Returns the settings that took effect.
 */
export const setForkAssetPipelineSettings = (
  partial: mixed
): ForkAssetPipelineSettings => {
  const merged =
    partial && typeof partial === 'object'
      ? { ...getForkAssetPipelineSettings(), ...(partial: Object) }
      : getForkAssetPipelineSettings();
  const next = normalizeForkAssetPipelineSettings(merged);
  cachedSettings = next;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(
        FORK_ASSET_PIPELINE_SETTINGS_STORAGE_KEY,
        JSON.stringify(next)
      );
    }
  } catch (error) {
    // A storage refusal keeps the in-memory value; the next write may
    // succeed.
  }
  settingsListeners.forEach(listener => listener());
  return next;
};

/** Subscribe to settings changes (the Assets view re-renders from this). */
export const subscribeForkAssetPipelineSettings = (
  listener: () => void
): (() => void) => {
  settingsListeners.add(listener);
  return () => {
    settingsListeners.delete(listener);
  };
};

/** Test-only: drop the cache, the listeners and the persisted blob. */
export const resetForkAssetPipelineSettingsForTests = (): void => {
  cachedSettings = null;
  settingsListeners.clear();
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(FORK_ASSET_PIPELINE_SETTINGS_STORAGE_KEY);
    }
  } catch (error) {
    // Nothing to clean up when storage is unavailable.
  }
};
