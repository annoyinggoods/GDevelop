// @flow
import * as React from 'react';
import { Trans } from '@lingui/macro';

import Checkbox from '../../UI/Checkbox';
import { Line } from '../../UI/Grid';
import { ColumnStackLayout } from '../../UI/Layout';
import Text from '../../UI/Text';
import { getForkGuardrailRuleLabel } from './ForkGuardrailBadge';
import {
  getForkGuardrailSettings,
  listForkGuardrailRules,
  setForkGuardrailSettings,
  subscribeForkGuardrailSettings,
  type ForkGuardrailSettings,
} from './ForkGuardrailSettings';

/**
 * Phase 18 ([P18-master-switch]) — the "Editor guardrails" section of the
 * Preferences "Build" tab.
 *
 * Why it exists: the master switch used to live ONLY in the badge's settings
 * popover — and the badge renders nothing while the layer is off, so turning
 * it off on a clean scene left no UI to turn it back on (only the exported
 * setter or the stored key). This section is that always-reachable surface:
 * the master switch plus one mute checkbox per rule, over the same settings
 * store the badges filter by at render time.
 */

/** The section subscribes to the settings store (the badges do the same). */
export const useForkGuardrailSettings = (): ForkGuardrailSettings => {
  const [settings, setSettings] = React.useState<ForkGuardrailSettings>(
    getForkGuardrailSettings
  );
  React.useEffect(() => {
    const sync = () => setSettings(getForkGuardrailSettings());
    sync();
    return subscribeForkGuardrailSettings(sync);
  }, []);
  return settings;
};

const ForkGuardrailSettingsSection = (): React.Node => {
  const settings = useForkGuardrailSettings();

  const toggleRule = (ruleId: string, enabled: boolean) => {
    const disabledRules = new Set<string>(settings.disabledRules);
    if (enabled) {
      disabledRules.delete(ruleId);
    } else {
      disabledRules.add(ruleId);
    }
    setForkGuardrailSettings({ disabledRules: Array.from(disabledRules) });
  };

  return (
    <ColumnStackLayout noMargin>
      <Text size="block-title">
        <Trans>Editor guardrails</Trans>
      </Text>
      <Text>
        <Trans>
          Inline warnings on the events sheet for common logic traps (a Trigger
          Once inside a loop, a Wait stacking up in a loop, actions hitting
          every instance, duplicated Trigger Once conditions). They never change
          your events.
        </Trans>
      </Text>
      <Checkbox
        id="fork-guardrail-preferences-master-switch"
        checked={settings.enabled}
        onCheck={(event, checked) => {
          setForkGuardrailSettings({ enabled: checked });
        }}
        label={<Trans>Enable guardrails</Trans>}
      />
      {listForkGuardrailRules().map(rule => (
        <Checkbox
          key={rule.ruleId}
          id={`fork-guardrail-preferences-rule-${rule.ruleId}`}
          checked={!settings.disabledRules.includes(rule.ruleId)}
          onCheck={(event, checked) => {
            toggleRule(rule.ruleId, checked);
          }}
          label={getForkGuardrailRuleLabel(rule.ruleId)}
        />
      ))}
      <Line noMargin>
        <Text size="body2" color="secondary">
          <Trans>
            The warnings also appear and can be tuned from the icon on an event
            row.
          </Trans>
        </Text>
      </Line>
    </ColumnStackLayout>
  );
};

export default ForkGuardrailSettingsSection;
