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
import TextField from '../../UI/TextField';
import ForkAssetBuildSettingsTab from './ForkAssetBuildSettingsTab';
import {
  getForkAssetBuildSettings,
  resetForkAssetBuildSettingsForTests,
  setForkAssetBuildSettings,
} from './ForkAssetBuildSettings';
import { resetForkGuardrailSettingsForTests } from '../Guardrails/ForkGuardrailSettings';

// The encoder probe is the only platform-dependent piece of the tab: the spec
// drives its answers (both encoders, a missing one, and no desktop IPC at all).
jest.mock('./ForkAssetOptimizerPort', () => ({
  createDefaultForkAssetOptimizerDeps: (jest.fn(): any),
  probeForkAssetEncoderCapabilities: (jest.fn(): any),
}));
const mockPort: any = require('./ForkAssetOptimizerPort');

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
    dispatchEvent: () => {},
  });
}

const collectText = (node: any): string => {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(collectText).join(' ');
  if (node.children) return collectText(node.children);
  return '';
};

// The UI primitives read the app's i18n context; an empty catalog set renders
// the English source messages (the ByokSettingsTab spec convention).
const i18n = setupI18n({ language: 'en', catalogs: {} });

const renderTab = async () => {
  let renderer: any = null;
  await act(async () => {
    renderer = TestRenderer.create(
      <I18nProvider i18n={i18n} language="en">
        <ForkAssetBuildSettingsTab />
      </I18nProvider>
    );
    // Let the capabilities probe effect settle.
    await Promise.resolve();
  });
  return renderer;
};

/**
 * The visible text of a React ELEMENT (not a rendered tree): a <Trans> element
 * carries the English source message in `props.id` at runtime, and its
 * `props.children` is the same text — either one matches.
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

const findCheckboxByLabelPart = (renderer: Object, part: string) => {
  const checkbox = renderer.root
    .findAllByType(Checkbox)
    .find(node => elementText(node.props.label).includes(part));
  if (!checkbox) throw new Error(`No checkbox labelled "${part}".`);
  return checkbox;
};

describe('ForkAssetBuildSettingsTab', () => {
  beforeEach(() => {
    resetForkAssetBuildSettingsForTests();
    // The tab also renders the guardrails section ([P18-master-switch]).
    resetForkGuardrailSettingsForTests();
    mockPort.createDefaultForkAssetOptimizerDeps.mockReturnValue({
      fs: {},
      path: {},
      invoke: async () => null,
    });
    mockPort.probeForkAssetEncoderCapabilities.mockResolvedValue({
      images: true,
      audio: true,
    });
  });

  it('toggles the master switch into the shared settings store', async () => {
    const renderer = await renderTab();
    const toggle = findCheckboxByLabelPart(renderer, 'Optimize assets');

    expect(getForkAssetBuildSettings().enabled).toBe(false);
    await act(async () => {
      toggle.props.onCheck(null, true);
    });
    expect(getForkAssetBuildSettings().enabled).toBe(true);

    await act(async () => {
      toggle.props.onCheck(null, false);
    });
    expect(getForkAssetBuildSettings().enabled).toBe(false);
  });

  it('writes the manual-export and audio toggles', async () => {
    const renderer = await renderTab();
    await act(async () => {
      findCheckboxByLabelPart(renderer, 'export to a folder').props.onCheck(
        null,
        false
      );
    });
    expect(getForkAssetBuildSettings().optimizeManualExports).toBe(false);

    await act(async () => {
      findCheckboxByLabelPart(renderer, 'lossy audio').props.onCheck(
        null,
        false
      );
    });
    expect(getForkAssetBuildSettings().audioEnabled).toBe(false);
  });

  it('clamps a typed JPEG quality into the store', async () => {
    const renderer = await renderTab();
    const qualityField = renderer.root
      .findAllByType(TextField)
      .find(node => node.props.name === 'fork-asset-jpeg-quality');
    if (!qualityField) throw new Error('No JPEG quality field.');

    await act(async () => {
      qualityField.props.onChange(null, '150');
    });
    expect(getForkAssetBuildSettings().jpegQuality).toBe(100);

    await act(async () => {
      qualityField.props.onChange(null, '70');
    });
    expect(getForkAssetBuildSettings().jpegQuality).toBe(70);
  });

  it('clamps a typed WebP quality into its own knob ([P16-audio-webp-knob])', async () => {
    const renderer = await renderTab();
    const qualityField = renderer.root
      .findAllByType(TextField)
      .find(node => node.props.name === 'fork-asset-webp-quality');
    if (!qualityField) throw new Error('No WebP quality field.');

    await act(async () => {
      qualityField.props.onChange(null, '0');
    });
    expect(getForkAssetBuildSettings().webpQuality).toBe(1);

    await act(async () => {
      qualityField.props.onChange(null, '75');
    });
    expect(getForkAssetBuildSettings().webpQuality).toBe(75);
    // The knobs are independent.
    expect(getForkAssetBuildSettings().jpegQuality).toBe(85);
  });

  it('renders the Editor guardrails section with its master switch', async () => {
    const renderer = await renderTab();
    const masterSwitch = findCheckboxByLabelPart(renderer, 'Enable guardrails');
    expect(masterSwitch.props.checked).toBe(true);
    const text = collectText(renderer.toJSON());
    expect(text).toContain('Editor guardrails');
  });

  it('reflects an external change to the store (same source of truth)', async () => {
    const renderer = await renderTab();
    await act(async () => {
      setForkAssetBuildSettings({ enabled: true });
    });
    const toggle = findCheckboxByLabelPart(renderer, 'Optimize assets');
    expect(toggle.props.checked).toBe(true);
  });

  it('shows the audio-encoder note when ffmpeg is missing', async () => {
    mockPort.probeForkAssetEncoderCapabilities.mockResolvedValue({
      images: true,
      audio: false,
    });
    const renderer = await renderTab();
    const text = collectText(renderer.toJSON());
    expect(text).toContain('No audio encoder is configured');
    expect(text).not.toContain('No image encoder is configured');
  });

  it('shows the image-encoder note when sharp is missing', async () => {
    mockPort.probeForkAssetEncoderCapabilities.mockResolvedValue({
      images: false,
      audio: true,
    });
    const renderer = await renderTab();
    const text = collectText(renderer.toJSON());
    expect(text).toContain('No image encoder is configured');
  });

  it('explains the desktop-only limit when there is no IPC', async () => {
    mockPort.createDefaultForkAssetOptimizerDeps.mockReturnValue(null);
    const renderer = await renderTab();
    const text = collectText(renderer.toJSON());
    expect(text).toContain('only available in the desktop app');
    expect(mockPort.probeForkAssetEncoderCapabilities).not.toHaveBeenCalled();
  });
});
