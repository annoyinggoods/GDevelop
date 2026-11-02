/**
 * @jest-environment jsdom
 */
// @flow
import * as React from 'react';
import { act } from 'react-dom/test-utils';
import TestRenderer from 'react-test-renderer';
import { I18nProvider } from '@lingui/react';
import { setupI18n } from '@lingui/core';
import TextField from '../../UI/TextField';
import IconButton from '../../UI/IconButton';
import ForkAssetTagEditor from './ForkAssetTagEditor';
import { getForkResourceTags } from './ForkAssetTagStore';

const gd: libGDevelop = global.gd;

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

const i18n = setupI18n({ language: 'en', catalogs: {} });

const makeResource = () => {
  const project = gd.ProjectHelper.createNewGDJSProject();
  const resource = new gd.ImageResource();
  resource.setName('hero.png');
  resource.setFile('hero.png');
  project.getResourcesManager().addResource(resource);
  return {
    project,
    resource: project.getResourcesManager().getResource('hero.png'),
  };
};

/** The visible text of the rendered tree (strings and <Trans> ids). */
const collectText = (node: any): string => {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(collectText).join(' ');
  if (node.children) return collectText(node.children);
  return '';
};

const renderEditor = async (resource: any) => {
  let renderer: any = null;
  await act(async () => {
    renderer = TestRenderer.create(
      <I18nProvider i18n={i18n} language="en">
        <ForkAssetTagEditor resource={resource} />
      </I18nProvider>
    );
    await Promise.resolve();
  });
  return renderer;
};

describe('ForkAssetTagEditor', () => {
  it('shows the resource tags as chips and persists a normalized addition', async () => {
    const { project, resource } = makeResource();
    try {
      const renderer = await renderEditor(resource);
      expect(collectText(renderer.toJSON())).toContain('No tags');

      const textField = renderer.root.findByType(TextField);
      await act(async () => {
        textField.props.onChange({}, '  Enemy ');
        await Promise.resolve();
      });
      await act(async () => {
        textField.props.onKeyUp({ key: 'Enter' });
        await Promise.resolve();
      });

      expect(getForkResourceTags(resource)).toEqual(['enemy']);
      expect(collectText(renderer.toJSON())).toContain('enemy');
    } finally {
      project.delete();
    }
  });

  it('shows an inline refusal for an invalid tag and writes nothing', async () => {
    const { project, resource } = makeResource();
    try {
      const renderer = await renderEditor(resource);
      const textField = renderer.root.findByType(TextField);
      await act(async () => {
        textField.props.onChange({}, 'art/enemy');
        await Promise.resolve();
      });
      await act(async () => {
        textField.props.onKeyUp({ key: 'Enter' });
        await Promise.resolve();
      });

      expect(getForkResourceTags(resource)).toEqual([]);
      const text = collectText(renderer.toJSON());
      expect(text).toContain('A tag cannot contain slashes');
    } finally {
      project.delete();
    }
  });

  it('shows a refusal for an empty input via Enter, but not on empty blur', async () => {
    const { project, resource } = makeResource();
    try {
      const renderer = await renderEditor(resource);
      const textField = renderer.root.findByType(TextField);

      // Enter on an empty draft: an explicit gesture, reported.
      await act(async () => {
        textField.props.onChange({}, '   ');
        await Promise.resolve();
      });
      await act(async () => {
        textField.props.onKeyUp({ key: 'Enter' });
        await Promise.resolve();
      });
      expect(collectText(renderer.toJSON())).toContain('A tag cannot be empty');

      // Blur on an empty draft: leaving the field is not an error.
      await act(async () => {
        textField.props.onChange({}, '   ');
        await Promise.resolve();
      });
      await act(async () => {
        (textField.props.onBlur: any)();
        await Promise.resolve();
      });
      expect(getForkResourceTags(resource)).toEqual([]);
    } finally {
      project.delete();
    }
  });

  it('removes a tag through its chip button and the write persists', async () => {
    const { project, resource } = makeResource();
    try {
      const renderer = await renderEditor(resource);
      const textField = renderer.root.findByType(TextField);
      await act(async () => {
        textField.props.onChange({}, 'enemy');
        await Promise.resolve();
      });
      await act(async () => {
        textField.props.onKeyUp({ key: 'Enter' });
        await Promise.resolve();
      });
      expect(getForkResourceTags(resource)).toEqual(['enemy']);

      const removeButton = renderer.root.findAllByType(IconButton)[0];
      await act(async () => {
        removeButton.props.onClick(new MouseEvent('click'));
        await Promise.resolve();
      });

      expect(getForkResourceTags(resource)).toEqual([]);
      expect(collectText(renderer.toJSON())).toContain('No tags');
    } finally {
      project.delete();
    }
  });
});
