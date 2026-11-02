/**
 * @jest-environment jsdom
 */
// @flow
import {
  DEFAULT_FORK_GUARDRAIL_SETTINGS,
  FORK_GUARDRAIL_SETTINGS_STORAGE_KEY,
  getForkGuardrailSettings,
  isForkGuardrailRuleEnabled,
  listForkGuardrailRules,
  normalizeForkGuardrailSettings,
  resetForkGuardrailSettingsForTests,
  setForkGuardrailSettings,
  subscribeForkGuardrailSettings,
} from './ForkGuardrailSettings';
import { FORK_GUARDRAIL_RULE_IDS } from './ForkGuardrailRules';

describe('normalizeForkGuardrailSettings', () => {
  it('falls back to the safe defaults for junk payloads', () => {
    expect(normalizeForkGuardrailSettings(null)).toEqual(
      DEFAULT_FORK_GUARDRAIL_SETTINGS
    );
    expect(normalizeForkGuardrailSettings('nonsense')).toEqual(
      DEFAULT_FORK_GUARDRAIL_SETTINGS
    );
    expect(DEFAULT_FORK_GUARDRAIL_SETTINGS.enabled).toBe(true);
  });

  it('keeps only string rule ids in the mute list', () => {
    const settings = normalizeForkGuardrailSettings({
      disabledRules: ['G18-once-in-loop', 42, null, 'made-up-rule'],
    });
    expect(settings.disabledRules).toEqual([
      'G18-once-in-loop',
      'made-up-rule',
    ]);
  });

  it('honors an explicit false master switch and ignores junk booleans', () => {
    expect(normalizeForkGuardrailSettings({ enabled: false }).enabled).toBe(
      false
    );
    expect(normalizeForkGuardrailSettings({ enabled: 'yes' }).enabled).toBe(
      true
    );
  });
});

describe('the fork guardrail settings store', () => {
  beforeEach(() => {
    resetForkGuardrailSettingsForTests();
  });

  it('starts from the safe defaults (guardrails on, nothing muted)', () => {
    expect(getForkGuardrailSettings()).toEqual(DEFAULT_FORK_GUARDRAIL_SETTINGS);
  });

  it('persists a partial update and reads it back after a reload', () => {
    const stored = setForkGuardrailSettings({
      enabled: true,
      disabledRules: ['G18-wait-in-loop'],
    });
    expect(stored.disabledRules).toEqual(['G18-wait-in-loop']);
    const persisted = JSON.parse(
      (localStorage.getItem(FORK_GUARDRAIL_SETTINGS_STORAGE_KEY): any)
    );
    expect(persisted).toEqual(stored);

    jest.isolateModules(() => {
      const freshModule = require('./ForkGuardrailSettings');
      expect(freshModule.getForkGuardrailSettings().disabledRules).toEqual([
        'G18-wait-in-loop',
      ]);
    });
  });

  it('notifies the subscribers on every accepted change', () => {
    const listener = (jest.fn(): any);
    const unsubscribe = subscribeForkGuardrailSettings(listener);
    setForkGuardrailSettings({ enabled: false });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setForkGuardrailSettings({ enabled: true });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('tolerates a corrupt persisted payload', () => {
    localStorage.setItem(FORK_GUARDRAIL_SETTINGS_STORAGE_KEY, '{not json');
    expect(getForkGuardrailSettings()).toEqual(DEFAULT_FORK_GUARDRAIL_SETTINGS);
  });

  it('still updates the in-memory value when storage refuses the write', () => {
    const setItem = jest
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('quota exceeded');
      });
    const stored = setForkGuardrailSettings({ enabled: false });
    expect(stored.enabled).toBe(false);
    expect(getForkGuardrailSettings().enabled).toBe(false);
    setItem.mockRestore();
  });
});

describe('isForkGuardrailRuleEnabled', () => {
  it('is on by default for every registered rule', () => {
    const settings = DEFAULT_FORK_GUARDRAIL_SETTINGS;
    for (const ruleId of FORK_GUARDRAIL_RULE_IDS) {
      expect(isForkGuardrailRuleEnabled(settings, ruleId)).toBe(true);
    }
  });

  it('is false for a muted rule, and for every rule when the master switch is off', () => {
    const muted = {
      ...DEFAULT_FORK_GUARDRAIL_SETTINGS,
      disabledRules: ['G18-once-in-loop'],
    };
    expect(isForkGuardrailRuleEnabled(muted, 'G18-once-in-loop')).toBe(false);
    expect(isForkGuardrailRuleEnabled(muted, 'G18-wait-in-loop')).toBe(true);

    const masterOff = { ...DEFAULT_FORK_GUARDRAIL_SETTINGS, enabled: false };
    expect(isForkGuardrailRuleEnabled(masterOff, 'G18-once-in-loop')).toBe(
      false
    );
  });

  it('ignores unknown rule ids stored in the mute list (no crash, no effect on real rules)', () => {
    const settings = {
      ...DEFAULT_FORK_GUARDRAIL_SETTINGS,
      disabledRules: ['not-a-rule'],
    };
    expect(isForkGuardrailRuleEnabled(settings, 'G18-once-in-loop')).toBe(true);
  });
});

describe('listForkGuardrailRules', () => {
  it('lists the four v1 rules with their severity and default', () => {
    const rules = listForkGuardrailRules();
    expect(rules.map(rule => rule.ruleId)).toEqual(FORK_GUARDRAIL_RULE_IDS);
    expect(rules.find(rule => rule.ruleId === 'G18-once-in-loop')).toEqual({
      ruleId: 'G18-once-in-loop',
      severity: 'warning',
      defaultEnabled: true,
    });
  });
});
