// @flow
import * as React from 'react';
import { Trans } from '@lingui/macro';
import Tooltip from '@material-ui/core/Tooltip';
import Popover from '@material-ui/core/Popover';
import Warning from '../../UI/CustomSvgIcons/Warning';
import SmallCircledInfo from '../../UI/CustomSvgIcons/SmallCircledInfo';
import Tune from '../../UI/CustomSvgIcons/Tune';
import IconButton from '../../UI/IconButton';
import Checkbox from '../../UI/Checkbox';
import GDevelopThemeContext from '../../UI/Theme/GDevelopThemeContext';
import type { ForkGuardrailEventDiagnostic } from './ForkGuardrailRules';
import {
  getForkGuardrailSettings,
  isForkGuardrailRuleEnabled,
  listForkGuardrailRules,
  setForkGuardrailSettings,
  subscribeForkGuardrailSettings,
} from './ForkGuardrailSettings';

/**
 * Phase 18.2 — the inline guardrail badge shown on an event row.
 *
 * What this is: the warning/info icon (with a tooltip listing the rule
 * messages) plus an inlined settings menu — the master switch and the
 * per-rule mutes (D18-7). The node it renders for keeps ALL diagnostics; the
 * badge filters by the settings AT RENDER TIME and subscribes to the
 * settings store, so toggling a rule makes the badges disappear without any
 * events-tree rebuild and without touching event data.
 *
 * Everything is inline-styled on purpose ([A18-5]): no CSS class, no CSS
 * file edit — and the badge is absolutely positioned inside the event
 * container so it never changes the row height the events sheet caches.
 */

/**
 * The human label of a rule id — shared by the badge's popover and the
 * Preferences "Editor guardrails" section (Phase 18 [P18-master-switch]).
 */
export const getForkGuardrailRuleLabel = (ruleId: string): React.Node => {
  if (ruleId === 'G18-once-in-loop') {
    return <Trans>Trigger Once inside a loop</Trans>;
  }
  if (ruleId === 'G18-wait-in-loop') {
    return <Trans>Wait action inside a loop</Trans>;
  }
  if (ruleId === 'G18-action-without-picking') {
    return <Trans>Actions that no condition picks objects for</Trans>;
  }
  if (ruleId === 'G18-duplicate-once') {
    return <Trans>Duplicated Trigger Once conditions</Trans>;
  }
  return ruleId;
};

/** The popover body: the master switch and one checkbox per rule. */
export const ForkGuardrailSettingsMenuContent = (): React.Node => {
  const [settings, setSettings] = React.useState(getForkGuardrailSettings());
  React.useEffect(
    () =>
      subscribeForkGuardrailSettings(() =>
        setSettings(getForkGuardrailSettings())
      ),
    []
  );

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
    <div style={{ padding: 8, maxWidth: 340 }}>
      <Checkbox
        id="fork-guardrail-master-switch"
        checked={settings.enabled}
        onCheck={(event, checked) => {
          setForkGuardrailSettings({ enabled: checked });
        }}
        label={<Trans>Enable guardrails</Trans>}
      />
      {listForkGuardrailRules().map(rule => (
        <Checkbox
          key={rule.ruleId}
          id={`fork-guardrail-rule-${rule.ruleId}`}
          checked={!settings.disabledRules.includes(rule.ruleId)}
          onCheck={(event, checked) => {
            toggleRule(rule.ruleId, checked);
          }}
          label={getForkGuardrailRuleLabel(rule.ruleId)}
        />
      ))}
    </div>
  );
};

type Props = {|
  diagnostics: $ReadOnlyArray<ForkGuardrailEventDiagnostic>,
|};

const ForkGuardrailBadge = (props: Props): React.Node => {
  const theme = React.useContext(GDevelopThemeContext);
  const [settings, setSettings] = React.useState(getForkGuardrailSettings());
  React.useEffect(
    () =>
      subscribeForkGuardrailSettings(() =>
        setSettings(getForkGuardrailSettings())
      ),
    []
  );
  const [
    menuAnchorElement,
    setMenuAnchorElement,
  ] = React.useState<?HTMLElement>(null);

  const visibleDiagnostics = props.diagnostics.filter(diagnostic =>
    isForkGuardrailRuleEnabled(settings, diagnostic.ruleId)
  );
  if (visibleDiagnostics.length === 0) return null;

  const hasWarning = visibleDiagnostics.some(
    diagnostic => diagnostic.severity === 'warning'
  );
  const iconColor = hasWarning ? theme.message.warning : theme.text.disabled;
  const iconStyle = {
    color: iconColor,
    width: 16,
    height: 16,
  };

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        right: 4,
        zIndex: 2,
        display: 'inline-flex',
        alignItems: 'center',
        // Only the icons are interactive: the corner they occupy must keep
        // letting clicks through to the event row around them.
        pointerEvents: 'none',
      }}
    >
      <Tooltip
        title={
          <div>
            {visibleDiagnostics.map((diagnostic, index) => (
              <div key={index}>{diagnostic.message}</div>
            ))}
          </div>
        }
      >
        <span style={{ display: 'inline-flex', pointerEvents: 'auto' }}>
          {hasWarning ? (
            <Warning style={iconStyle} />
          ) : (
            <SmallCircledInfo style={iconStyle} />
          )}
        </span>
      </Tooltip>
      <span style={{ display: 'inline-flex', pointerEvents: 'auto' }}>
        <IconButton
          id="fork-guardrail-settings-button"
          size="small"
          style={{ padding: 2 }}
          onClick={event => setMenuAnchorElement(event.currentTarget)}
        >
          <Tune />
        </IconButton>
      </span>
      <Popover
        open={!!menuAnchorElement}
        anchorEl={menuAnchorElement}
        onClose={() => setMenuAnchorElement(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <ForkGuardrailSettingsMenuContent />
      </Popover>
    </div>
  );
};

export default ForkGuardrailBadge;
