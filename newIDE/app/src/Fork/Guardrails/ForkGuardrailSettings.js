// @flow

/**
 * Phase 18 / D18-7 — the event-sheet guardrails settings.
 *
 * What they are: the master switch of the diagnostics layer and the per-rule
 * mute list. The badge (18.2) filters at render time from these settings, so
 * toggling a rule removes its badges without rebuilding the events tree, and
 * without ever touching event data.
 *
 * Where they live: one small fork-owned blob, persisted under its own
 * localStorage key with an in-memory cache — the same mechanism as
 * ForkAssetBuildSettings (the shared Preferences provider is deliberately
 * not used, to keep the upstream diff at zero for this concern).
 *
 * Storage discipline: the getter is total (a missing/corrupt payload
 * normalizes to the safe defaults), the setter never throws (a storage
 * refusal still updates the in-memory value, so the running session honors
 * the change).
 */

import {
  FORK_GUARDRAIL_RULES,
  type ForkGuardrailSeverity,
} from './ForkGuardrailRules';

export type ForkGuardrailSettings = {|
  /** Master switch (D18-7: on by default). */
  enabled: boolean,
  /** The muted rule ids; every other rule stays active. */
  disabledRules: Array<string>,
|};

export const DEFAULT_FORK_GUARDRAIL_SETTINGS: ForkGuardrailSettings = {
  enabled: true,
  disabledRules: [],
};

/** The localStorage key of the settings blob (fork-owned). */
export const FORK_GUARDRAIL_SETTINGS_STORAGE_KEY = 'gd-fork-guardrail-settings';

const booleanOrDefault = (value: mixed, fallback: boolean): boolean => {
  if (value === true) return true;
  if (value === false) return false;
  return fallback;
};

const stringsFromArray = (value: mixed): Array<string> => {
  if (!Array.isArray(value)) return [];
  return value.filter(item => typeof item === 'string');
};

/**
 * Normalize an untrusted payload (a hand-edited localStorage entry, a chat
 * tool argument) into a valid settings object. Unknown rule ids are kept in
 * the mute list (they simply never match a diagnostic) — the stored user
 * choice is not silently rewritten. Never throws.
 */
export const normalizeForkGuardrailSettings = (
  raw: mixed
): ForkGuardrailSettings => {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_FORK_GUARDRAIL_SETTINGS };
  }
  const source: Object = raw;
  return {
    enabled: booleanOrDefault(
      source.enabled,
      DEFAULT_FORK_GUARDRAIL_SETTINGS.enabled
    ),
    disabledRules: source.disabledRules
      ? stringsFromArray(source.disabledRules)
      : [],
  };
};

let cachedSettings: ?ForkGuardrailSettings = null;
const settingsListeners: Set<() => void> = new Set<() => void>();

const readPersistedSettings = (): mixed => {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(FORK_GUARDRAIL_SETTINGS_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (error) {
    // A corrupt payload must not break the events sheet — the defaults take over.
    return null;
  }
};

/** The current settings (the safe defaults when nothing was ever stored). */
export const getForkGuardrailSettings = (): ForkGuardrailSettings => {
  if (cachedSettings) return cachedSettings;
  cachedSettings = normalizeForkGuardrailSettings(readPersistedSettings());
  return cachedSettings;
};

/**
 * Merge a partial update into the current settings, persist the whole blob
 * and notify the subscribers (the badges re-render themselves from this).
 * Returns the normalized settings that were stored.
 */
export const setForkGuardrailSettings = (
  partial: mixed
): ForkGuardrailSettings => {
  const merged =
    partial && typeof partial === 'object'
      ? { ...getForkGuardrailSettings(), ...(partial: Object) }
      : getForkGuardrailSettings();
  const next = normalizeForkGuardrailSettings(merged);
  cachedSettings = next;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(
        FORK_GUARDRAIL_SETTINGS_STORAGE_KEY,
        JSON.stringify(next)
      );
    }
  } catch (error) {
    // A storage refusal keeps the in-memory value (the session still honors
    // the change); the next write attempt may succeed.
  }
  settingsListeners.forEach(listener => listener());
  return next;
};

/** Subscribe to settings changes (the badges re-render from this). */
export const subscribeForkGuardrailSettings = (
  listener: () => void
): (() => void) => {
  settingsListeners.add(listener);
  return () => {
    settingsListeners.delete(listener);
  };
};

/** Test-only: drop the cache, the listeners and the persisted blob. */
export const resetForkGuardrailSettingsForTests = (): void => {
  cachedSettings = null;
  settingsListeners.clear();
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(FORK_GUARDRAIL_SETTINGS_STORAGE_KEY);
    }
  } catch (error) {
    // Nothing to clean up when storage is unavailable.
  }
};

/**
 * Whether a rule is effectively active: the master switch must be on and the
 * rule must not be muted. Unknown rule ids are simply never muted.
 */
export const isForkGuardrailRuleEnabled = (
  settings: ForkGuardrailSettings,
  ruleId: string
): boolean => {
  if (!settings.enabled) return false;
  return !settings.disabledRules.includes(ruleId);
};

export type ForkGuardrailRuleListing = {|
  ruleId: string,
  severity: ForkGuardrailSeverity,
  defaultEnabled: boolean,
|};

/** The rule catalog, for the settings UI and the AI-facing descriptions. */
export const listForkGuardrailRules = (): Array<ForkGuardrailRuleListing> =>
  Object.keys(FORK_GUARDRAIL_RULES).map(ruleId => ({
    ruleId,
    severity: FORK_GUARDRAIL_RULES[ruleId].severity,
    defaultEnabled: FORK_GUARDRAIL_RULES[ruleId].defaultEnabled,
  }));
