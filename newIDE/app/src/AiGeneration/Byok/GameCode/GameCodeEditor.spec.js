/**
 * @jest-environment jsdom
 */
// @flow

import * as React from 'react';
import { act } from 'react-dom/test-utils';
import reactTestRenderer from 'react-test-renderer';
import { I18nProvider } from '@lingui/react';
import { setupI18n } from '@lingui/core';

// Monaco cannot load in jsdom: capture the props instead, so the tests can
// drive the editor through the exact API GameCodeEditor uses (value, onChange,
// onBlur) and assert what Monaco is told to display.
let mockLastCodeEditorProps: any = null;
// Flow types createElement as the React$CreateElement type rather than a
// callable: take it untyped for the mock factories.
const mockCreateElement: any = (React: any).createElement;
jest.mock('../../../CodeEditor', () => ({
  CodeEditor: (props: any) => {
    mockLastCodeEditorProps = props;
    return null;
  },
}));

const GameCodeEditor = require('./GameCodeEditor').default;
const RaisedButton = require('../../../UI/RaisedButton').default;
const FlatButton = require('../../../UI/FlatButton').default;
// After the mock below is applied, this is the passthrough mock component.
const AlertMessage = require('../../../UI/AlertMessage').default;

// AlertMessage reads the Material-UI theme, which no provider supplies under
// react-test-renderer. The tests only need to know it appears/disappears and
// to reach the buttons inside it.
jest.mock('../../../UI/AlertMessage', () => ({
  __esModule: true,
  default: (props: any) => mockCreateElement('div', null, props.children),
}));

const i18n = setupI18n({ language: 'en', catalogs: {} });

const makeProps = (overrides: Object = {}) => ({
  relativePath: 'character/spawn.js',
  contentOnDisk: 'const spawn = 1;',
  onWriteFile: (jest.fn(async () => ({ ok: true })): any),
  onDirtyStateChange: (jest.fn(): any),
  ...overrides,
});

const renderEditor = (props: any) => {
  let renderer: any = null;
  act(() => {
    renderer = reactTestRenderer.create(
      <I18nProvider i18n={i18n} language="en">
        <GameCodeEditor {...props} />
      </I18nProvider>
    );
  });
  return renderer;
};

const findButtons = (renderer: any) => {
  const raisedButtons = renderer.root.findAllByType(RaisedButton);
  const flatButtons = renderer.root.findAllByType(FlatButton);
  return { raisedButtons, flatButtons };
};

const findAlertMessages = (renderer: any) =>
  renderer.root.findAllByType(AlertMessage);

// Collect the human-readable strings of a React element tree (Trans
// elements, buttons...), so assertions can check the visible words. The
// Lingui macro puts the source message in `props.id` (children stay
// undefined), so both are read.
const collectElementText = (node: any): string => {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectElementText).join(' ');
  if (node && node.props) {
    return (
      collectElementText(node.props.id) +
      ' ' +
      collectElementText(node.props.children)
    );
  }
  return '';
};

describe('GameCodeEditor (D15-7 single-writer guard)', () => {
  afterEach(() => {
    mockLastCodeEditorProps = null;
  });

  it('shows the on-disk content and is clean at mount', () => {
    const props = makeProps();
    renderEditor(props);
    expect(mockLastCodeEditorProps.value).toBe('const spawn = 1;');
    expect(props.onDirtyStateChange).toHaveBeenLastCalledWith(
      'character/spawn.js',
      false
    );
  });

  it('marks the buffer dirty when the user types', () => {
    const props = makeProps();
    renderEditor(props);

    act(() => {
      mockLastCodeEditorProps.onChange('const spawn = 2;');
    });

    expect(mockLastCodeEditorProps.value).toBe('const spawn = 2;');
    expect(props.onDirtyStateChange).toHaveBeenLastCalledWith(
      'character/spawn.js',
      true
    );
  });

  it('NEVER replaces a dirty buffer with an incoming disk change: it shows the notice instead', () => {
    const props = makeProps();
    const renderer = renderEditor(props);

    // The user types.
    act(() => {
      mockLastCodeEditorProps.onChange('const spawn = myTypedVersion;');
    });
    // Meanwhile the AI writes the same file on disk, and the pane hands the
    // new content to the editor.
    act(() => {
      renderer.update(
        <I18nProvider i18n={i18n} language="en">
          <GameCodeEditor
            {...props}
            contentOnDisk="const spawn = aiWrittenVersion;"
          />
        </I18nProvider>
      );
    });

    // The notice is shown...
    const alertMessages = findAlertMessages(renderer);
    expect(alertMessages.length).toBe(1);
    expect(collectElementText(alertMessages[0].props.children)).toContain(
      'changed outside the editor'
    );
    // ...and Monaco still displays the user's buffer, not the AI content.
    expect(mockLastCodeEditorProps.value).toBe('const spawn = myTypedVersion;');
    expect(props.onDirtyStateChange).toHaveBeenLastCalledWith(
      'character/spawn.js',
      true
    );
  });

  it('loads the incoming version only when the user asks for it', () => {
    const props = makeProps();
    const renderer = renderEditor(props);

    act(() => {
      mockLastCodeEditorProps.onChange('const spawn = myTypedVersion;');
    });
    act(() => {
      renderer.update(
        <I18nProvider i18n={i18n} language="en">
          <GameCodeEditor
            {...props}
            contentOnDisk="const spawn = aiWrittenVersion;"
          />
        </I18nProvider>
      );
    });
    // The notice's buttons: Load (first) and Keep (second). The labels are
    // Lingui <Trans> elements, so the buttons are told apart by position.
    const bannerButtons = findButtons(renderer).flatButtons;
    const loadButton = bannerButtons[0];
    if (!loadButton) throw new Error('Load button not found');
    act(() => {
      loadButton.props.onClick();
    });

    expect(mockLastCodeEditorProps.value).toBe(
      'const spawn = aiWrittenVersion;'
    );
    expect(props.onDirtyStateChange).toHaveBeenLastCalledWith(
      'character/spawn.js',
      false
    );
    expect(findAlertMessages(renderer).length).toBe(0);
  });

  it('keeps the user version on demand: the notice goes away, the buffer stays dirty', () => {
    const props = makeProps();
    const renderer = renderEditor(props);

    act(() => {
      mockLastCodeEditorProps.onChange('const spawn = myTypedVersion;');
    });
    act(() => {
      renderer.update(
        <I18nProvider i18n={i18n} language="en">
          <GameCodeEditor
            {...props}
            contentOnDisk="const spawn = aiWrittenVersion;"
          />
        </I18nProvider>
      );
    });
    const bannerButtons = findButtons(renderer).flatButtons;
    const keepButton = bannerButtons[1];
    if (!keepButton) throw new Error('Keep button not found');
    act(() => {
      keepButton.props.onClick();
    });

    expect(mockLastCodeEditorProps.value).toBe('const spawn = myTypedVersion;');
    expect(props.onDirtyStateChange).toHaveBeenLastCalledWith(
      'character/spawn.js',
      true
    );
    expect(findAlertMessages(renderer).length).toBe(0);

    // A SECOND, different incoming change is surfaced again (it is not the
    // dismissed one).
    act(() => {
      renderer.update(
        <I18nProvider i18n={i18n} language="en">
          <GameCodeEditor
            {...props}
            contentOnDisk="const spawn = secondAiVersion;"
          />
        </I18nProvider>
      );
    });
    expect(findAlertMessages(renderer).length).toBe(1);
  });

  it('follows the disk when the buffer is clean (no notice)', () => {
    const props = makeProps();
    const renderer = renderEditor(props);

    act(() => {
      renderer.update(
        <I18nProvider i18n={i18n} language="en">
          <GameCodeEditor
            {...props}
            contentOnDisk="const spawn = externalEdit;"
          />
        </I18nProvider>
      );
    });

    expect(mockLastCodeEditorProps.value).toBe('const spawn = externalEdit;');
    expect(findAlertMessages(renderer).length).toBe(0);
    expect(props.onDirtyStateChange).toHaveBeenLastCalledWith(
      'character/spawn.js',
      false
    );
  });

  it('saves the buffer through the pane writer and clears the dirty mark', async () => {
    const props = makeProps();
    const renderer = renderEditor(props);

    act(() => {
      mockLastCodeEditorProps.onChange('const spawn = 2;');
    });
    const saveButton = findButtons(renderer).raisedButtons[0];
    await act(async () => {
      saveButton.props.onClick();
      // Let the writer's promise settle so the save finishes within act.
      await Promise.resolve();
    });

    expect(props.onWriteFile).toHaveBeenCalledWith(
      'character/spawn.js',
      'const spawn = 2;'
    );
    expect(props.onDirtyStateChange).toHaveBeenLastCalledWith(
      'character/spawn.js',
      false
    );
  });

  it('stays dirty when the write fails', async () => {
    const props = makeProps({
      onWriteFile: jest.fn(async () => ({
        ok: false,
        error: 'The disk is full.',
      })),
    });
    const renderer = renderEditor(props);

    act(() => {
      mockLastCodeEditorProps.onChange('const spawn = 2;');
    });
    const saveButton = findButtons(renderer).raisedButtons[0];
    await act(async () => {
      saveButton.props.onClick();
      await Promise.resolve();
    });

    expect(props.onDirtyStateChange).toHaveBeenLastCalledWith(
      'character/spawn.js',
      true
    );
  });

  it('saves on blur when the buffer is dirty', async () => {
    const props = makeProps();
    renderEditor(props);

    act(() => {
      mockLastCodeEditorProps.onChange('const spawn = 3;');
    });
    await act(async () => {
      mockLastCodeEditorProps.onBlur();
      await Promise.resolve();
    });

    expect(props.onWriteFile).toHaveBeenCalledWith(
      'character/spawn.js',
      'const spawn = 3;'
    );
  });

  it('does not save on blur when the buffer is clean', async () => {
    const props = makeProps();
    renderEditor(props);

    await act(async () => {
      mockLastCodeEditorProps.onBlur();
    });

    expect(props.onWriteFile).not.toHaveBeenCalled();
  });
});
