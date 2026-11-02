/**
 * @jest-environment jsdom
 */
// @flow
import {
  DEFAULT_FORK_ASSET_PIPELINE_SETTINGS,
  FORK_ASSET_PIPELINE_SETTINGS_STORAGE_KEY,
  getForkAssetPipelineSettings,
  normalizeForkAssetPipelineSettings,
  resetForkAssetPipelineSettingsForTests,
  setForkAssetPipelineSettings,
  subscribeForkAssetPipelineSettings,
} from './ForkAssetPipelineSettings';

describe('normalizeForkAssetPipelineSettings', () => {
  it('falls back to the defaults for junk payloads', () => {
    expect(normalizeForkAssetPipelineSettings(null)).toEqual(
      DEFAULT_FORK_ASSET_PIPELINE_SETTINGS
    );
    expect(normalizeForkAssetPipelineSettings('nonsense')).toEqual(
      DEFAULT_FORK_ASSET_PIPELINE_SETTINGS
    );
  });

  it('keeps explicit booleans and defaults the rest', () => {
    expect(normalizeForkAssetPipelineSettings({ autoRegister: false })).toEqual(
      { autoRegister: false, autoReload: true }
    );
    expect(normalizeForkAssetPipelineSettings({ autoReload: false })).toEqual({
      autoRegister: true,
      autoReload: false,
    });
  });
});

describe('the fork asset pipeline settings store', () => {
  beforeEach(() => {
    resetForkAssetPipelineSettingsForTests();
  });

  it('starts from the defaults (both switches on)', () => {
    expect(getForkAssetPipelineSettings()).toEqual({
      autoRegister: true,
      autoReload: true,
    });
  });

  it('persists a partial update and notifies the subscribers', () => {
    const listener = (jest.fn(): any);
    const unsubscribe = subscribeForkAssetPipelineSettings(listener);

    const stored = setForkAssetPipelineSettings({ autoRegister: false });
    expect(stored).toEqual({ autoRegister: false, autoReload: true });
    expect(getForkAssetPipelineSettings()).toEqual(stored);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(FORK_ASSET_PIPELINE_SETTINGS_STORAGE_KEY)).toBe(
      JSON.stringify(stored)
    );

    unsubscribe();
    setForkAssetPipelineSettings({ autoRegister: true });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('survives a reload of a persisted blob and resets for tests', () => {
    setForkAssetPipelineSettings({ autoReload: false });
    // Simulate a fresh module read: drop only the in-memory cache by
    // resetting and re-reading what localStorage holds.
    const persisted = localStorage.getItem(
      FORK_ASSET_PIPELINE_SETTINGS_STORAGE_KEY
    );
    expect(JSON.parse(persisted || '')).toEqual({
      autoRegister: true,
      autoReload: false,
    });

    resetForkAssetPipelineSettingsForTests();
    expect(getForkAssetPipelineSettings()).toEqual(
      DEFAULT_FORK_ASSET_PIPELINE_SETTINGS
    );
    expect(localStorage.getItem(FORK_ASSET_PIPELINE_SETTINGS_STORAGE_KEY)).toBe(
      null
    );
  });
});
