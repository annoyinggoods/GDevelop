/**
 * @jest-environment jsdom
 */
// @flow
import * as React from 'react';
import { act } from 'react-dom/test-utils';
import TestRenderer from 'react-test-renderer';
import Tooltip from '@material-ui/core/Tooltip';
import { I18nProvider } from '@lingui/react';
import { setupI18n } from '@lingui/core';
import Warning from '../../UI/CustomSvgIcons/Warning';
import Checkbox from '../../UI/Checkbox';

// jsdom does not implement matchMedia and the UI components reached through
// imports may need it — stubbed BEFORE the badge module is required.
if (!(window: any).matchMedia) {
  (window: any).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  });
}

// MUI's Popover mounts through a Portal react-test-renderer cannot drive.
// The spec is about the menu's content and behaviour, so the Popover is
// replaced by a passthrough that renders its children when open.
jest.mock('@material-ui/core/Popover', () => {
  const react: any = require('react');
  return {
    __esModule: true,
    default: (props: any) =>
      props.open ? react.createElement('div', null, props.children) : null,
  };
});

const { default: ForkGuardrailBadge } = require('./ForkGuardrailBadge');
const {
  resetForkGuardrailSettingsForTests,
  setForkGuardrailSettings,
} = require('./ForkGuardrailSettings');

const i18n = setupI18n({ language: 'en', catalogs: {} });
const withI18n = (element: React.Node) => (
  <I18nProvider i18n={i18n} language="en">
    {element}
  </I18nProvider>
);

const makeDiagnostic = (
  ruleId: string,
  severity: 'warning' | 'info',
  message: string
) => ({ ruleId, severity, message });

const warningDiagnostic = makeDiagnostic(
  'G18-once-in-loop',
  'warning',
  'Trigger Once is used inside a loop.'
);
const infoDiagnostic = makeDiagnostic(
  'G18-action-without-picking',
  'info',
  'No condition of this event picks "Enemy".'
);

/** Every string leaf of a React ELEMENT tree (props.children), joined. */
const collectElementText = (node: any): string => {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectElementText).join(' ');
  if (node.props) return collectElementText(node.props.children);
  return '';
};

describe('ForkGuardrailBadge', () => {
  beforeEach(() => {
    resetForkGuardrailSettingsForTests();
  });

  const renderBadge = (diagnostics: Array<any>): any => {
    let renderer: any = null;
    act(() => {
      renderer = TestRenderer.create(
        withI18n(<ForkGuardrailBadge diagnostics={diagnostics} />)
      );
    });
    return renderer;
  };

  it('renders a warning icon for a warning diagnostic, none when clean', () => {
    const renderer = renderBadge([warningDiagnostic]);
    expect(renderer.root.findAllByType(Warning)).toHaveLength(1);

    renderer.unmount();
    const clean = renderBadge([]);
    expect(clean.toJSON()).toBeNull();
    clean.unmount();
  });

  it('renders the muted info icon when only info diagnostics are visible', () => {
    const renderer = renderBadge([infoDiagnostic]);
    expect(renderer.root.findAllByType(Warning)).toHaveLength(0);
    // SmallCircledInfo is a memo(plain function), for which react-test-renderer
    // creates no component instance — so the icon is asserted by its svg
    // (viewBox unique to UI/CustomSvgIcons/SmallCircledInfo).
    const svgViewBoxes = renderer.root
      .findAll((node: any) => node.type === 'svg')
      .map((node: any) => node.props.viewBox);
    expect(svgViewBoxes).toContain('-2 -2 20 20');
    renderer.unmount();
  });

  it('lists every visible diagnostic message in the tooltip', () => {
    const renderer = renderBadge([warningDiagnostic, infoDiagnostic]);
    const tooltip = renderer.root.findByType(Tooltip);
    const tooltipText = collectElementText(tooltip.props.title);
    expect(tooltipText).toContain('Trigger Once is used inside a loop.');
    expect(tooltipText).toContain('No condition of this event picks "Enemy".');
    renderer.unmount();
  });

  it('renders nothing when the rule is muted, and when the master switch is off', () => {
    setForkGuardrailSettings({ disabledRules: ['G18-once-in-loop'] });
    const muted = renderBadge([warningDiagnostic]);
    expect(muted.toJSON()).toBeNull();
    muted.unmount();

    resetForkGuardrailSettingsForTests();
    setForkGuardrailSettings({ enabled: false });
    const masterOff = renderBadge([warningDiagnostic]);
    expect(masterOff.toJSON()).toBeNull();
    masterOff.unmount();
  });

  it('disappears on a settings change while mounted (no tree rebuild needed)', () => {
    const renderer = renderBadge([warningDiagnostic]);
    expect(renderer.toJSON()).not.toBeNull();

    act(() => {
      setForkGuardrailSettings({ disabledRules: ['G18-once-in-loop'] });
    });
    expect(renderer.toJSON()).toBeNull();

    act(() => {
      setForkGuardrailSettings({ disabledRules: [] });
    });
    expect(renderer.toJSON()).not.toBeNull();
    renderer.unmount();
  });

  it('opens the settings menu from the badge and mutes a rule through it', () => {
    const renderer = renderBadge([warningDiagnostic]);
    const settingsButtons = renderer.root.findAllByProps({
      id: 'fork-guardrail-settings-button',
    });
    expect(settingsButtons.length).toBeGreaterThan(0);

    act(() => {
      settingsButtons[0].props.onClick({ currentTarget: {} });
    });
    // The menu shows the master switch and one checkbox per rule.
    const checkboxes = renderer.root.findAllByType(Checkbox);
    expect(checkboxes).toHaveLength(5);

    const onceRuleCheckbox = renderer.root.findByProps({
      id: 'fork-guardrail-rule-G18-once-in-loop',
    });
    act(() => {
      onceRuleCheckbox.props.onCheck({}, false);
    });
    // Muting the only rule's diagnostic removes the badge without unmounting.
    expect(renderer.toJSON()).toBeNull();
    renderer.unmount();
  });

  it('hides the badge when the master switch is toggled off from the menu', () => {
    const renderer = renderBadge([warningDiagnostic]);
    const settingsButtons = renderer.root.findAllByProps({
      id: 'fork-guardrail-settings-button',
    });
    act(() => {
      settingsButtons[0].props.onClick({ currentTarget: {} });
    });
    const masterSwitch = renderer.root.findByProps({
      id: 'fork-guardrail-master-switch',
    });
    act(() => {
      masterSwitch.props.onCheck({}, false);
    });
    expect(renderer.toJSON()).toBeNull();
    renderer.unmount();
  });
});
