/**
 * @jest-environment jsdom
 */
// @flow
import {
  DEFAULT_FORK_ASSET_BUILD_SETTINGS,
  FORK_ASSET_BUILD_SETTINGS_PREFERENCES_FIELD,
  FORK_ASSET_BUILD_SETTINGS_STORAGE_KEY,
  PREFERENCES_STORAGE_ITEM,
  getForkAssetBuildSettings,
  normalizeForkAssetBuildSettings,
  resetForkAssetBuildSettingsForTests,
  setForkAssetBuildSettings,
  subscribeForkAssetBuildSettings,
} from './ForkAssetBuildSettings';

describe('normalizeForkAssetBuildSettings', () => {
  it('clamps the numeric knobs into their documented ranges', () => {
    const settings = normalizeForkAssetBuildSettings({
      enabled: true,
      pngLevel: 42,
      jpegQuality: 0,
      webpQuality: 999,
      audioBitrateKbps: 1000,
    });
    expect(settings.enabled).toBe(true);
    expect(settings.pngLevel).toBe(9);
    expect(settings.jpegQuality).toBe(1);
    expect(settings.webpQuality).toBe(100);
    expect(settings.audioBitrateKbps).toBe(320);
  });

  it('honors an explicit false knob and falls back for junk payloads', () => {
    const settings = normalizeForkAssetBuildSettings({
      optimizeManualExports: false,
      audioEnabled: false,
      pngLevel: 'not a number',
    });
    expect(settings.optimizeManualExports).toBe(false);
    expect(settings.audioEnabled).toBe(false);
    expect(settings.pngLevel).toBe(DEFAULT_FORK_ASSET_BUILD_SETTINGS.pngLevel);
    // A preferences blob written before the WebP knob existed keeps working
    // (the knob falls back to its default, like every other missing field).
    expect(settings.webpQuality).toBe(
      DEFAULT_FORK_ASSET_BUILD_SETTINGS.webpQuality
    );

    expect(normalizeForkAssetBuildSettings(null)).toEqual(
      DEFAULT_FORK_ASSET_BUILD_SETTINGS
    );
    expect(normalizeForkAssetBuildSettings('nonsense')).toEqual(
      DEFAULT_FORK_ASSET_BUILD_SETTINGS
    );
  });

  it('rounds a fractional knob to the nearest integer', () => {
    expect(
      normalizeForkAssetBuildSettings({ jpegQuality: 84.6 }).jpegQuality
    ).toBe(85);
    expect(
      normalizeForkAssetBuildSettings({ webpQuality: 90.4 }).webpQuality
    ).toBe(90);
  });
});

describe('the fork asset build settings store', () => {
  beforeEach(() => {
    resetForkAssetBuildSettingsForTests();
  });

  it('starts from the safe defaults (optimization off)', () => {
    expect(getForkAssetBuildSettings()).toEqual(
      DEFAULT_FORK_ASSET_BUILD_SETTINGS
    );
    expect(getForkAssetBuildSettings().enabled).toBe(false);
  });

  it('reads the settings from the shared preferences blob', () => {
    localStorage.setItem(
      PREFERENCES_STORAGE_ITEM,
      JSON.stringify({
        language: 'en',
        [FORK_ASSET_BUILD_SETTINGS_PREFERENCES_FIELD]: {
          enabled: true,
          jpegQuality: 70,
        },
      })
    );
    // A fresh module instance (the cache is empty on first read).
    jest.isolateModules(() => {
      const freshModule = require('./ForkAssetBuildSettings');
      expect(freshModule.getForkAssetBuildSettings().enabled).toBe(true);
      expect(freshModule.getForkAssetBuildSettings().jpegQuality).toBe(70);
      // The other preferences of the blob are none of this store's business.
      expect(freshModule.getForkAssetBuildSettings().pngLevel).toBe(9);
    });
  });

  it('adopts the legacy fork-owned blob when the preferences have no field yet', () => {
    localStorage.setItem(
      FORK_ASSET_BUILD_SETTINGS_STORAGE_KEY,
      JSON.stringify({ enabled: true, jpegQuality: 60 })
    );
    jest.isolateModules(() => {
      const freshModule = require('./ForkAssetBuildSettings');
      expect(freshModule.getForkAssetBuildSettings().enabled).toBe(true);
      expect(freshModule.getForkAssetBuildSettings().jpegQuality).toBe(60);
    });
  });

  it('prefers the shared preferences blob over the legacy one', () => {
    localStorage.setItem(
      FORK_ASSET_BUILD_SETTINGS_STORAGE_KEY,
      JSON.stringify({ enabled: true })
    );
    localStorage.setItem(
      PREFERENCES_STORAGE_ITEM,
      JSON.stringify({
        [FORK_ASSET_BUILD_SETTINGS_PREFERENCES_FIELD]: { enabled: false },
      })
    );
    jest.isolateModules(() => {
      const freshModule = require('./ForkAssetBuildSettings');
      expect(freshModule.getForkAssetBuildSettings().enabled).toBe(false);
    });
  });

  it('hands the persisted value to the subscribers (the provider bridge persists it)', () => {
    // This is the production wiring, in miniature: the PreferencesProvider
    // subscribes and folds the value into the shared preferences blob.
    const unsubscribe = subscribeForkAssetBuildSettings(() => {
      const blob = JSON.parse(
        (localStorage.getItem(PREFERENCES_STORAGE_ITEM): any) || '{}'
      );
      blob[
        FORK_ASSET_BUILD_SETTINGS_PREFERENCES_FIELD
      ] = getForkAssetBuildSettings();
      localStorage.setItem(PREFERENCES_STORAGE_ITEM, JSON.stringify(blob));
    });

    const stored = setForkAssetBuildSettings({
      enabled: true,
      jpegQuality: 70,
    });
    expect(stored.enabled).toBe(true);
    expect(stored.jpegQuality).toBe(70);
    unsubscribe();

    // A fresh process (a new module instance, storage untouched) still sees
    // the change — that is what makes the setting survive a restart.
    jest.isolateModules(() => {
      const freshModule = require('./ForkAssetBuildSettings');
      expect(freshModule.getForkAssetBuildSettings().jpegQuality).toBe(70);
      expect(freshModule.getForkAssetBuildSettings().enabled).toBe(true);
    });
  });

  it('notifies the subscribers on every accepted change', () => {
    const listener = (jest.fn(): any);
    const unsubscribe = subscribeForkAssetBuildSettings(listener);
    setForkAssetBuildSettings({ pngLevel: 3 });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setForkAssetBuildSettings({ pngLevel: 4 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('tolerates a corrupt persisted payload', () => {
    localStorage.setItem(PREFERENCES_STORAGE_ITEM, '{not json');
    expect(getForkAssetBuildSettings()).toEqual(
      DEFAULT_FORK_ASSET_BUILD_SETTINGS
    );
  });
});
