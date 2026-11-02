/**
 * @jest-environment jsdom
 */
// @flow
import * as React from 'react';
import { act } from 'react-dom/test-utils';
import TestRenderer from 'react-test-renderer';
import { I18nProvider } from '@lingui/react';
import { setupI18n } from '@lingui/core';
import Checkbox from '../../UI/Checkbox';
import ForkGuardrailSettingsSection from './ForkGuardrailSettingsSection';
import {
  getForkGuardrailSettings,
  resetForkGuardrailSettingsForTests,
} from './ForkGuardrailSettings';

// jsdom does not implement matchMedia (MUI's theming reads it).
if (!(window: any).matchMedia) {
  (window: any).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

/**
 * The visible text of a React ELEMENT (not a rendered tree): a <Trans> element
 * carries the English source message in `props.id` at runtime.
 */
const elementText = (element: any): string => {
  if (element === null || element === undefined) return '';
  if (typeof element === 'string' || typeof element === 'number') {
    return String(element);
  }
  if (Array.isArray(element)) return element.map(elementText).join(' ');
  if (React.isValidElement(element)) {
    const props: any = element.props;
    return [props.id, elementText(props.children)].filter(Boolean).join(' ');
  }
  return '';
};

const i18n = setupI18n({ language: 'en', catalogs: {} });

const renderSection = async () => {
  let renderer: any = null;
  await act(async () => {
    renderer = TestRenderer.create(
      <I18nProvider i18n={i18n} language="en">
        <ForkGuardrailSettingsSection />
      </I18nProvider>
    );
  });
  return renderer;
};

const findCheckboxByLabelPart = (renderer: Object, part: string) => {
  const checkbox = renderer.root
    .findAllByType(Checkbox)
    .find(node => elementText(node.props.label).includes(part));
  if (!checkbox) throw new Error(`No checkbox labelled "${part}".`);
  return checkbox;
};

describe('ForkGuardrailSettingsSection', () => {
  beforeEach(() => {
    resetForkGuardrailSettingsForTests();
  });

  afterEach(() => {
    resetForkGuardrailSettingsForTests();
  });

  it('renders the master switch and every rule of the catalog', async () => {
    const renderer = await renderSection();
    const checkboxes = renderer.root.findAllByType(Checkbox);
    // One master switch + the four rules of Phase 18.
    expect(checkboxes).toHaveLength(5);
    findCheckboxByLabelPart(renderer, 'Enable guardrails');
    findCheckboxByLabelPart(renderer, 'Trigger Once inside a loop');
    findCheckboxByLabelPart(renderer, 'Wait action inside a loop');
    findCheckboxByLabelPart(renderer, 'Actions that no condition picks');
    findCheckboxByLabelPart(renderer, 'Duplicated Trigger Once');
  });

  it('turns the layer back on after it was off (the one-way-door fix)', async () => {
    // The bug this guards: with the layer off, the badge renders nothing, so
    // its popover cannot bring it back — this section always can.
    const { setForkGuardrailSettings } = require('./ForkGuardrailSettings');
    setForkGuardrailSettings({ enabled: false });

    const renderer = await renderSection();
    const masterSwitch = findCheckboxByLabelPart(renderer, 'Enable guardrails');
    expect(masterSwitch.props.checked).toBe(false);

    await act(async () => {
      masterSwitch.props.onCheck(null, true);
    });
    expect(getForkGuardrailSettings().enabled).toBe(true);
    // The section re-rendered from the store it just wrote.
    expect(
      findCheckboxByLabelPart(renderer, 'Enable guardrails').props.checked
    ).toBe(true);
  });

  it('mutes and restores a single rule through the shared store', async () => {
    const renderer = await renderSection();
    const rule = findCheckboxByLabelPart(renderer, 'Wait action inside a loop');
    expect(rule.props.checked).toBe(true);

    await act(async () => {
      rule.props.onCheck(null, false);
    });
    expect(getForkGuardrailSettings().disabledRules).toEqual([
      'G18-wait-in-loop',
    ]);
    expect(
      findCheckboxByLabelPart(renderer, 'Wait action inside a loop').props
        .checked
    ).toBe(false);

    await act(async () => {
      findCheckboxByLabelPart(
        renderer,
        'Wait action inside a loop'
      ).props.onCheck(null, true);
    });
    expect(getForkGuardrailSettings().disabledRules).toEqual([]);
  });
});
