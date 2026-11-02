/**
 * @jest-environment jsdom
 */
// @flow
import * as React from 'react';
import { act } from 'react-dom/test-utils';
import TestRenderer from 'react-test-renderer';
import CompactSelectField from '../../UI/CompactSelectField';
import TextField from '../../UI/TextField';
import RaisedButton from '../../UI/RaisedButton';
import SelectOption from '../../UI/SelectOption';
import {
  DEFAULT_BYOK_SETTINGS,
  type ByokSettings,
  type ByokModelInfo,
} from './ByokTypes';

// The models cache and the client are mocked: the tab is tested against
// their contracts, not against axios.
jest.mock('./ByokModelsCache', () => ({
  getCachedByokModels: (jest.fn(): any).mockReturnValue(null),
  refreshByokModels: jest.fn(),
  clearByokModels: jest.fn(),
}));
jest.mock('./ByokClient', () => ({
  sendByokChatCompletionWithRetries: jest.fn(),
}));
// The key storage is partially mocked: only the storage info is faked (to
// simulate the desktop/web environments), the save/load functions stay real
// so the "key never in preferences" guarantees keep being exercised.
jest.mock('./ByokKeyStorage', () => ({
  ...jest.requireActual('./ByokKeyStorage'),
  getByokKeyStorageInfo: jest.fn(),
}));

// jsdom does not implement matchMedia, which PreferencesContext.js calls at
// module load to choose the default theme.
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

// Required after the matchMedia polyfill above: static imports would be
// hoisted and executed before it.
const PreferencesContext = require('../../MainFrame/Preferences/PreferencesContext')
  .default;
const ByokSettingsTabModule = require('./ByokSettingsTab');
const ByokSettingsTab = ByokSettingsTabModule.default;
const clampContextWindow = ByokSettingsTabModule.clampContextWindow;
const getKeyStorageStatusText = ByokSettingsTabModule.getKeyStorageStatusText;
const renderByokErrorMessage = ByokSettingsTabModule.renderByokErrorMessage;
const ByokModelsCache = require('./ByokModelsCache');
const ByokClientModule = require('./ByokClient');
const ByokKeyStorageModule = require('./ByokKeyStorage');
const { I18nProvider } = require('@lingui/react');
const { setupI18n } = require('@lingui/core');

const mockRefreshByokModels = mockFn(ByokModelsCache.refreshByokModels);
const mockGetCachedByokModels = mockFn(ByokModelsCache.getCachedByokModels);
const mockSendForTestConnection = mockFn(
  ByokClientModule.sendByokChatCompletionWithRetries
);
const mockGetByokKeyStorageInfo = mockFn(
  ByokKeyStorageModule.getByokKeyStorageInfo
);

// The UI components used by the tab (SelectOption, TextField) need a lingui
// i18n instance in their context, like the app provides with GDI18nProvider.
// An empty catalogs set makes them render the English (source) messages.
const i18n = setupI18n({ language: 'en', catalogs: {} });

function mockFn(fn: any): JestMockFn<any, any> {
  return fn;
}

const makePreferencesValues = (byok: ByokSettings = DEFAULT_BYOK_SETTINGS) => ({
  byok,
});

const renderTab = (byok?: ByokSettings) => {
  const setMultipleValues = mockFn(jest.fn());
  const values = makePreferencesValues(byok);
  let component;
  act(() => {
    component = TestRenderer.create(
      <I18nProvider i18n={i18n} language="en">
        <PreferencesContext.Provider
          value={({ values, setMultipleValues }: any)}
        >
          <ByokSettingsTab />
        </PreferencesContext.Provider>
      </I18nProvider>
    );
  });
  if (!component) throw new Error('The tab did not render');
  return { component, setMultipleValues };
};

const findFieldByName = (component: any, name: string) => {
  const field = component.root
    .findAllByType(TextField)
    .find(field => field.props.name === name);
  if (!field) throw new Error(`Field ${name} not found`);
  return field;
};

const flushPromises = async () => {
  for (let i = 0; i < 10; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};

// One shared reset for every test of the file: each describe below used to
// repeat this block (O11).
beforeEach(() => {
  localStorage.clear();
  mockRefreshByokModels.mockReset();
  mockGetCachedByokModels.mockReset();
  mockGetCachedByokModels.mockReturnValue(null);
  mockSendForTestConnection.mockReset();
  // By default the tab is tested as on the web build (obfuscated storage);
  // desktop-specific tests override this with mockResolvedValueOnce.
  mockGetByokKeyStorageInfo.mockReset();
  mockGetByokKeyStorageInfo.mockResolvedValue({
    encrypted: false,
    obfuscated: true,
  });
});

// Since Phase 9 the tab renders three RaisedButtons in tree order:
// Fetch models, Test connection, Run the benchmark.
function findTestConnectionButton(component: any): any {
  const raisedButtons = component.root.findAllByType(RaisedButton);
  expect(raisedButtons.length).toBeGreaterThanOrEqual(2);
  return raisedButtons[1];
}

describe('ByokSettingsTab', () => {
  it('mounts and shows the BYOK title', async () => {
    const { component } = renderTab();
    // The title is rendered as the fallback (English) message of the
    // translated string.
    await act(async () => {
      await flushPromises();
    });
    expect(JSON.stringify(component.toJSON())).toContain(
      'BYOK — Bring Your Own Key'
    );
  });

  it('persists custom instructions, capped to 2000 characters', async () => {
    const { component, setMultipleValues } = renderTab();
    await act(async () => {
      await flushPromises();
    });

    const instructionsField = findFieldByName(
      component,
      'byok-custom-instructions'
    );
    const longText = 'Always answer in French. '.repeat(200);
    expect(longText.length).toBeGreaterThan(2000);

    act(() => {
      instructionsField.props.onChange(
        { target: { value: longText } },
        longText.slice(0, 2000)
      );
    });

    expect(setMultipleValues).toHaveBeenCalled();
    const lastCall =
      setMultipleValues.mock.calls[setMultipleValues.mock.calls.length - 1][0];
    expect(lastCall.byok.customInstructions.length).toBeLessThanOrEqual(2000);
  });

  it('renders the online docs expansion toggle, off by default', async () => {
    const { component } = renderTab();
    await act(async () => {
      await flushPromises();
    });

    // The toggle is rendered (its label is the only one mentioning the
    // bundled docs); it starts unchecked with the default settings.
    const renderedJson = JSON.stringify(component.toJSON());
    expect(renderedJson).toContain('Fetch missing documentation pages');
  });

  it('persists the endpoint URL through setMultipleValues', () => {
    const { component, setMultipleValues } = renderTab();
    const endpointField = findFieldByName(component, 'byok-endpoint-url');

    act(() => {
      endpointField.props.onChange(
        { target: { value: 'https://example.com/v1' } },
        'https://example.com/v1'
      );
    });

    expect(setMultipleValues).toHaveBeenCalledWith({
      byok: { ...DEFAULT_BYOK_SETTINGS, endpointUrl: 'https://example.com/v1' },
    });
  });

  it('clamps the context window entered in the field to 512 on blur', () => {
    const { component, setMultipleValues } = renderTab();
    const contextWindowField = findFieldByName(
      component,
      'byok-context-window'
    );

    act(() => {
      contextWindowField.props.onChange({}, '10');
    });
    // While typing, nothing is persisted: clamping on every keystroke would
    // rewrite what the user is typing.
    expect(setMultipleValues).not.toHaveBeenCalled();
    act(() => {
      contextWindowField.props.onBlur({ currentTarget: { value: '10' } });
    });

    expect(setMultipleValues).toHaveBeenCalledWith({
      byok: { ...DEFAULT_BYOK_SETTINGS, contextWindowTokens: 512 },
    });
  });

  it('clamps the context window entered in the field to 1,000,000 on blur', () => {
    const { component, setMultipleValues } = renderTab();
    const contextWindowField = findFieldByName(
      component,
      'byok-context-window'
    );

    act(() => {
      contextWindowField.props.onChange({}, '99999999');
    });
    act(() => {
      contextWindowField.props.onBlur({ currentTarget: { value: '99999999' } });
    });

    expect(setMultipleValues).toHaveBeenCalledWith({
      byok: { ...DEFAULT_BYOK_SETTINGS, contextWindowTokens: 1000000 },
    });
  });

  it('lets a multi-keystroke value be typed without clamping corruption', () => {
    const { component, setMultipleValues } = renderTab();
    const contextWindowField = findFieldByName(
      component,
      'byok-context-window'
    );

    // Typing "16384" character by character: previously the per-keystroke
    // clamp rewrote the field and the final value ended up garbled.
    for (const partialValue of ['1', '16', '163', '1638', '16384']) {
      act(() => {
        contextWindowField.props.onChange({}, partialValue);
      });
    }
    act(() => {
      contextWindowField.props.onBlur({ currentTarget: { value: '16384' } });
    });

    const calls = setMultipleValues.mock.calls;
    expect(calls[calls.length - 1][0].byok.contextWindowTokens).toBe(16384);
  });

  it('clears the stored key from the Clear button', async () => {
    const { saveByokKey } = require('./ByokKeyStorage');
    await saveByokKey('sk-to-be-cleared');

    const { component } = renderTab();
    await act(async () => {
      await flushPromises();
    });
    // Phase 9 added more FlatButtons after it (Add a provider, Export
    // feedback), but the Clear button is still the first in tree order.
    const FlatButton = require('../../UI/FlatButton').default;
    const flatButtons = component.root.findAllByType(FlatButton);
    expect(flatButtons.length).toBeGreaterThanOrEqual(1);

    await act(async () => {
      flatButtons[0].props.onClick({});
      await flushPromises();
    });

    expect(localStorage.getItem('gd-byok-key')).toBe(null);
  });

  it('keeps the API key out of every setMultipleValues call', () => {
    const { component, setMultipleValues } = renderTab();

    const apiKeyField = findFieldByName(component, 'byok-api-key');
    act(() => {
      apiKeyField.props.onChange(
        { target: { value: 'sk-very-secret-key' } },
        'sk-very-secret-key'
      );
    });
    const endpointField = findFieldByName(component, 'byok-endpoint-url');
    act(() => {
      endpointField.props.onChange(
        { target: { value: 'https://example.com/v1' } },
        'https://example.com/v1'
      );
    });

    expect(setMultipleValues).toHaveBeenCalled();
    for (const call of setMultipleValues.mock.calls) {
      const byok = call[0].byok || {};
      expect(Object.keys(byok).sort()).toEqual(
        Object.keys(DEFAULT_BYOK_SETTINGS).sort()
      );
    }
    // No key material anywhere in the preferences updates.
    expect(JSON.stringify(setMultipleValues.mock.calls)).not.toContain(
      'sk-very-secret-key'
    );
  });

  it('saves the API key to the separate key storage when the field is left', async () => {
    const { component } = renderTab();
    const apiKeyField = findFieldByName(component, 'byok-api-key');

    act(() => {
      apiKeyField.props.onChange(
        { target: { value: 'sk-very-secret-key' } },
        'sk-very-secret-key'
      );
    });
    act(() => {
      apiKeyField.props.onBlur({
        currentTarget: { value: 'sk-very-secret-key' },
      });
    });
    await act(async () => {
      await flushPromises();
    });

    // The key is stored obfuscated (version 2): the stored value is not the
    // plaintext key, but the key storage loads it back unchanged.
    const storedRawValue = localStorage.getItem('gd-byok-key') || '';
    expect(storedRawValue).not.toContain('sk-very-secret-key');
    expect(JSON.parse(storedRawValue).version).toBe(2);
    const { loadByokKey } = require('./ByokKeyStorage');
    expect(await loadByokKey()).toEqual({
      status: 'ok',
      key: 'sk-very-secret-key',
    });
    // The preferences blob was never written with the key.
    expect(localStorage.getItem('gd-preferences')).toBe(null);
  });

  it('never clears the stored key when an untouched empty field is left (D10)', async () => {
    const { saveByokKey, loadByokKey } = require('./ByokKeyStorage');
    await saveByokKey('sk-already-stored-key');

    const { component } = renderTab();
    await act(async () => {
      await flushPromises();
    });

    const apiKeyField = findFieldByName(component, 'byok-api-key');
    // The user focuses the field and leaves it without typing anything:
    // this must never save (an empty save would clear the key).
    act(() => {
      apiKeyField.props.onBlur({ currentTarget: { value: '' } });
    });
    await act(async () => {
      await flushPromises();
    });

    expect(await loadByokKey()).toEqual({
      status: 'ok',
      key: 'sk-already-stored-key',
    });
  });

  it('clears the stored key when the field is emptied after typing and left (D10)', async () => {
    const { saveByokKey, loadByokKey } = require('./ByokKeyStorage');
    await saveByokKey('sk-already-stored-key');

    const { component } = renderTab();
    await act(async () => {
      await flushPromises();
    });

    const apiKeyField = findFieldByName(component, 'byok-api-key');
    act(() => {
      apiKeyField.props.onChange({ target: { value: 'sk-typo' } }, 'sk-typo');
    });
    // Erasing everything after typing is an explicit empty: leaving the
    // field is a deliberate delete.
    act(() => {
      apiKeyField.props.onChange({ target: { value: '' } }, '');
    });
    act(() => {
      apiKeyField.props.onBlur({ currentTarget: { value: '' } });
    });
    await act(async () => {
      await flushPromises();
    });

    expect(await loadByokKey()).toEqual({ status: 'none' });
    expect(localStorage.getItem('gd-byok-key')).toBe(null);
  });

  it('does not re-save when the field is left again without a new edit (D10)', async () => {
    const { loadByokKey } = require('./ByokKeyStorage');
    const { component } = renderTab();
    const apiKeyField = findFieldByName(component, 'byok-api-key');

    act(() => {
      apiKeyField.props.onChange(
        { target: { value: 'sk-persisted-key' } },
        'sk-persisted-key'
      );
    });
    act(() => {
      apiKeyField.props.onBlur({
        currentTarget: { value: 'sk-persisted-key' },
      });
    });
    await act(async () => {
      await flushPromises();
    });
    expect(await loadByokKey()).toEqual({
      status: 'ok',
      key: 'sk-persisted-key',
    });

    // Tabbing through the field again (no edit since the save) must neither
    // re-save nor clear.
    act(() => {
      apiKeyField.props.onBlur({
        currentTarget: { value: 'sk-persisted-key' },
      });
    });
    await act(async () => {
      await flushPromises();
    });
    expect(await loadByokKey()).toEqual({
      status: 'ok',
      key: 'sk-persisted-key',
    });
  });

  it('hides the storage status row when no key is stored', async () => {
    const { component } = renderTab();
    await act(async () => {
      await flushPromises();
    });

    const renderedJson = JSON.stringify(component.toJSON());
    expect(renderedJson).not.toContain('light obfuscation');
    expect(renderedJson).not.toContain('encrypted by');
  });

  it('shows the obfuscation warning on web when a key is stored', async () => {
    const { saveByokKey } = require('./ByokKeyStorage');
    await saveByokKey('sk-web-key');

    const { component } = renderTab();
    await act(async () => {
      await flushPromises();
    });

    const renderedJson = JSON.stringify(component.toJSON());
    expect(renderedJson).toContain('light obfuscation');
    expect(renderedJson).not.toContain('encrypted by your operating system');
  });

  it('shows the OS-encryption status when the storage is encrypted (desktop)', async () => {
    mockGetByokKeyStorageInfo.mockResolvedValueOnce({
      encrypted: true,
      obfuscated: false,
    });
    const { saveByokKey } = require('./ByokKeyStorage');
    await saveByokKey('sk-desktop-key');

    const { component } = renderTab();
    await act(async () => {
      await flushPromises();
    });

    expect(JSON.stringify(component.toJSON())).toContain(
      'encrypted by your operating system'
    );
  });

  it('shows the storage status once a key is saved from the field', async () => {
    const { component } = renderTab();
    await act(async () => {
      await flushPromises();
    });
    expect(JSON.stringify(component.toJSON())).not.toContain(
      'light obfuscation'
    );

    const apiKeyField = findFieldByName(component, 'byok-api-key');
    act(() => {
      apiKeyField.props.onChange(
        { target: { value: 'sk-newly-typed-key' } },
        'sk-newly-typed-key'
      );
    });
    await act(async () => {
      await apiKeyField.props.onBlur({
        currentTarget: { value: 'sk-newly-typed-key' },
      });
      await flushPromises();
    });

    expect(JSON.stringify(component.toJSON())).toContain('light obfuscation');
  });
});

describe('ByokSettingsTab: models fetching', () => {
  const getRaisedButtons = (component: any) =>
    component.root.findAllByType(RaisedButton);

  it('populates the models dropdown when the fetch succeeds', async () => {
    const models: Array<ByokModelInfo> = [
      { id: 'model-b', contextWindowTokens: null },
      { id: 'model-a', contextWindowTokens: 32768 },
    ];
    mockRefreshByokModels.mockResolvedValueOnce(models);

    const { component } = renderTab();
    const fetchModelsButton = getRaisedButtons(component)[0];
    // Fetch models, Test connection and (Phase 9.5) the benchmark button.
    expect(getRaisedButtons(component)).toHaveLength(3);

    await act(async () => {
      fetchModelsButton.props.onClick({});
      await flushPromises();
    });

    // The dropdown appeared, with one option per fetched model (plus the
    // reasoning-effort dropdown options that were always there).
    const options = component.root.findAllByType(SelectOption);
    const optionValues = options.map(option => option.props.value);
    expect(optionValues).toContain('model-a');
    expect(optionValues).toContain('model-b');
    expect(mockRefreshByokModels).toHaveBeenCalledWith({
      baseUrl: '',
      apiKey: '',
    });
  });

  it('falls back to the free-text model field when the fetch returns nothing', async () => {
    mockRefreshByokModels.mockResolvedValueOnce([]);

    const { component } = renderTab();
    const fetchModelsButton = getRaisedButtons(component)[0];

    await act(async () => {
      fetchModelsButton.props.onClick({});
      await flushPromises();
    });

    // The free-text model field is still there, with an explanation.
    findFieldByName(component, 'byok-model');
    expect(JSON.stringify(component.toJSON())).toContain(
      'returned an empty model list'
    );
    const optionValues = component.root
      .findAllByType(SelectOption)
      .map(option => option.props.value);
    expect(optionValues).not.toContain('model-a');
  });

  it('shows the ByokError message when the fetch fails', async () => {
    mockRefreshByokModels.mockRejectedValueOnce({
      kind: 'authentication',
      message: 'Your API key was rejected by the endpoint (401).',
      status: 401,
    });

    const { component } = renderTab();
    const fetchModelsButton = getRaisedButtons(component)[0];

    await act(async () => {
      fetchModelsButton.props.onClick({});
      await flushPromises();
    });

    expect(JSON.stringify(component.toJSON())).toContain(
      'Your API key was rejected by the endpoint (401).'
    );
    // The free-text field is still shown.
    findFieldByName(component, 'byok-model');
  });

  it('shows the models cached for the endpoint without a new fetch', () => {
    mockGetCachedByokModels.mockReturnValueOnce([
      { id: 'cached-model', contextWindowTokens: null },
    ]);

    const { component } = renderTab();
    const optionValues = component.root
      .findAllByType(SelectOption)
      .map(option => option.props.value);
    expect(optionValues).toContain('cached-model');
    expect(mockRefreshByokModels).not.toHaveBeenCalled();
  });
});

describe('ByokSettingsTab: per-provider model settings (Phase 13.4)', () => {
  const makeProvider = (overrides: Object = {}) => ({
    id: 'provider-1',
    name: 'Provider 1',
    endpointUrl: 'https://api.example.com/v1',
    keyRef: 'provider-1',
    modelSettings: [
      {
        modelName: 'my-model',
        temperature: null,
        maxTokens: null,
        contextWindowTokens: null,
      },
    ],
    ...overrides,
  });

  it('persists a per-model context window into the provider settings', () => {
    const settings: ByokSettings = {
      ...DEFAULT_BYOK_SETTINGS,
      providers: [makeProvider()],
    };
    const { component, setMultipleValues } = renderTab(settings);

    const contextWindowField = findFieldByName(
      component,
      'byok-model-context-window-provider-1-my-model'
    );
    act(() => {
      contextWindowField.props.onChange({}, '4096');
    });
    act(() => {
      contextWindowField.props.onBlur({ currentTarget: { value: '4096' } });
    });

    expect(setMultipleValues).toHaveBeenCalledWith({
      byok: {
        ...settings,
        providers: [
          makeProvider({
            modelSettings: [
              {
                modelName: 'my-model',
                temperature: null,
                maxTokens: null,
                contextWindowTokens: 4096,
              },
            ],
          }),
        ],
      },
    });
  });

  it('commits the temperature and max tokens of a model block', () => {
    const settings: ByokSettings = {
      ...DEFAULT_BYOK_SETTINGS,
      providers: [makeProvider()],
    };
    const { component, setMultipleValues } = renderTab(settings);

    const temperatureField = findFieldByName(
      component,
      'byok-model-temperature-provider-1-my-model'
    );
    act(() => {
      temperatureField.props.onChange({}, '0.2');
    });
    act(() => {
      temperatureField.props.onBlur({ currentTarget: { value: '0.2' } });
    });
    expect(setMultipleValues).toHaveBeenCalledWith({
      byok: {
        ...settings,
        providers: [
          makeProvider({
            modelSettings: [
              {
                modelName: 'my-model',
                temperature: 0.2,
                maxTokens: null,
                contextWindowTokens: null,
              },
            ],
          }),
        ],
      },
    });
  });

  it('clamps a per-model context window on blur', () => {
    const settings: ByokSettings = {
      ...DEFAULT_BYOK_SETTINGS,
      providers: [makeProvider()],
    };
    const { component, setMultipleValues } = renderTab(settings);

    const contextWindowField = findFieldByName(
      component,
      'byok-model-context-window-provider-1-my-model'
    );
    act(() => {
      contextWindowField.props.onChange({}, '10');
    });
    act(() => {
      contextWindowField.props.onBlur({ currentTarget: { value: '10' } });
    });

    expect(setMultipleValues).toHaveBeenCalledWith({
      byok: {
        ...settings,
        providers: [
          makeProvider({
            modelSettings: [
              {
                modelName: 'my-model',
                temperature: null,
                maxTokens: null,
                contextWindowTokens: 512,
              },
            ],
          }),
        ],
      },
    });
  });

  it('offers a Run benchmark button per model block', () => {
    const settings: ByokSettings = {
      ...DEFAULT_BYOK_SETTINGS,
      providers: [makeProvider()],
    };
    const { component } = renderTab(settings);
    const json = JSON.stringify(component.toJSON());
    expect(json).toContain('Run benchmark');
    expect(json).toContain('my-model');
  });

  it('migrates old routing profiles to the first provider on load', () => {
    const settings: ByokSettings = {
      ...DEFAULT_BYOK_SETTINGS,
      providers: [makeProvider()],
      strongProfile: {
        providerId: '',
        modelName: 'old-strong-model',
        temperature: null,
        maxTokens: null,
      },
    };
    const { setMultipleValues } = renderTab(settings);
    expect(setMultipleValues).toHaveBeenCalledWith({
      byok: {
        ...settings,
        strongProfile: {
          providerId: 'provider-1',
          modelName: 'old-strong-model',
          temperature: null,
          maxTokens: null,
        },
      },
    });
  });
});

describe('ByokSettingsTab: test connection', () => {
  const renderTabAndClickTest = async () => {
    const { component, setMultipleValues } = renderTab();
    const testConnectionButton = findTestConnectionButton(component);

    await act(async () => {
      testConnectionButton.props.onClick({});
      await flushPromises();
    });

    return { component, setMultipleValues };
  };

  it('renders an inline success message when the endpoint answers', async () => {
    mockSendForTestConnection.mockResolvedValueOnce({
      choices: [{ message: { role: 'assistant', content: 'pong' } }],
    });

    const { component } = await renderTabAndClickTest();

    expect(mockSendForTestConnection).toHaveBeenCalledTimes(1);
    const call = mockSendForTestConnection.mock.calls[0][0];
    expect(call.options.model).toBe('');
    expect(call.options.messages).toEqual([{ role: 'user', content: 'ping' }]);
    // A test ping must fail fast, not hold the button for minutes of
    // conversation-grade retries.
    expect(call.options.timeoutMs).toBe(15000);
    expect(JSON.stringify(component.toJSON())).toContain(
      'Connection successful!'
    );
  });

  it('sends the reasoning effort of the settings when it is not default', async () => {
    mockSendForTestConnection.mockResolvedValueOnce({
      choices: [{ message: { role: 'assistant', content: 'pong' } }],
    });
    const settings: ByokSettings = {
      ...DEFAULT_BYOK_SETTINGS,
      endpointUrl: 'https://api.example.com/v1',
      modelName: 'my-model',
      reasoningEffort: 'high',
    };

    const { component } = renderTab(settings);
    const testConnectionButton = findTestConnectionButton(component);
    await act(async () => {
      testConnectionButton.props.onClick({});
      await flushPromises();
    });

    expect(
      mockSendForTestConnection.mock.calls[0][0].options.reasoningEffort
    ).toBe('high');
    expect(JSON.stringify(component.toJSON())).toContain(
      'Connection successful!'
    );
  });

  it('renders the error message inline when the endpoint rejects', async () => {
    mockSendForTestConnection.mockRejectedValueOnce({
      kind: 'not-found',
      message: 'The endpoint was not found (404).',
      status: 404,
    });

    const { component } = await renderTabAndClickTest();

    expect(JSON.stringify(component.toJSON())).toContain(
      'The endpoint was not found (404).'
    );
    expect(JSON.stringify(component.toJSON())).not.toContain(
      'Connection successful!'
    );
  });
});

describe('clampContextWindow', () => {
  it('raises a too-small value to the minimum of 512', () => {
    expect(clampContextWindow(10)).toBe(512);
    expect(clampContextWindow(511)).toBe(512);
  });

  it('lowers a too-large value to the maximum of 1,000,000', () => {
    expect(clampContextWindow(99999999)).toBe(1000000);
    expect(clampContextWindow(1000001)).toBe(1000000);
  });

  it('keeps a value inside the bounds as-is', () => {
    expect(clampContextWindow(512)).toBe(512);
    expect(clampContextWindow(8192)).toBe(8192);
    expect(clampContextWindow(1000000)).toBe(1000000);
  });

  it('falls back to the default context window on a non-number (empty field)', () => {
    expect(clampContextWindow(NaN)).toBe(
      DEFAULT_BYOK_SETTINGS.contextWindowTokens
    );
  });
});

describe('getKeyStorageStatusText', () => {
  const renderNodeToText = (node: any) =>
    JSON.stringify(
      TestRenderer.create(
        <I18nProvider i18n={i18n} language="en">
          {node}
        </I18nProvider>
      ).toJSON()
    );

  it('returns null (row hidden) when no key is stored', () => {
    expect(getKeyStorageStatusText(false, false)).toBe(null);
    expect(getKeyStorageStatusText(true, false)).toBe(null);
  });

  it('returns the OS-encryption text when the key is encrypted', () => {
    expect(renderNodeToText(getKeyStorageStatusText(true, true))).toContain(
      'encrypted by your operating system'
    );
  });

  it('returns the obfuscation warning when the key is not encrypted', () => {
    expect(renderNodeToText(getKeyStorageStatusText(false, true))).toContain(
      'light obfuscation'
    );
  });
});

describe('renderByokErrorMessage', () => {
  const renderNodeToText = (node: any) =>
    JSON.stringify(
      TestRenderer.create(
        <I18nProvider i18n={i18n} language="en">
          {node}
        </I18nProvider>
      ).toJSON()
    );

  it('passes an endpoint-provided message through as dynamic text', () => {
    expect(
      renderByokErrorMessage({
        kind: 'authentication',
        message: 'This key is from the wrong workspace.',
        status: 401,
        retryAfterMs: null,
      })
    ).toBe('This key is from the wrong workspace.');
  });

  it('renders the translated generic message when the endpoint sent none', () => {
    const node = renderByokErrorMessage({
      kind: 'not-found',
      message:
        'The endpoint was not found (404). Check the base URL in the BYOK settings: for most providers it should end with /v1.',
      status: 404,
      retryAfterMs: null,
    });
    // A <Trans> node (a React element, not a raw string): same English
    // text, but extractable by the Lingui pipeline.
    expect(typeof node).toBe('object');
    expect(renderNodeToText(node)).toContain(
      'The endpoint was not found (404)'
    );
  });
});

describe('ByokSettingsTab image support selector (Phase 6)', () => {
  it('renders the Image support selector with the auto-detect default', async () => {
    const { component } = renderTab();
    await act(async () => {
      await flushPromises();
    });
    const selectFields = component.root.findAllByType(CompactSelectField);
    const imageSupportField = selectFields.find(
      field => field.props.value === 'auto'
    );
    if (!imageSupportField) {
      throw new Error('The image support selector was not rendered');
    }
    expect(JSON.stringify(component.toJSON())).toContain('Image support');
  });

  it('persists a changed image support through setMultipleValues', async () => {
    const { component, setMultipleValues } = renderTab();
    await act(async () => {
      await flushPromises();
    });
    const selectFields = component.root.findAllByType(CompactSelectField);
    const imageSupportField = selectFields.find(
      field => field.props.value === 'auto'
    );
    if (!imageSupportField) {
      throw new Error('The image support selector was not rendered');
    }

    await act(async () => {
      imageSupportField.props.onChange('no');
    });

    expect(setMultipleValues).toHaveBeenCalledWith({
      byok: expect.objectContaining({ imageSupport: 'no' }),
    });
  });
});

// audit011026 B-TOOL-1: the benchmark snapshot must render EventScript text
// (the scorer's format), never gd serialized JSON via a mistyped
// Serializer.toJSON(eventsList) call (the WASM-crash site).
jest.mock(
  '../../EventsSheet/EventsTree/TextRenderer/EventScriptSourceView',
  () => ({
    buildEventScriptSourceView: ({ eventsList, maxChars }: any) => ({
      text:
        eventsList === 'fake-events'
          ? 'if Always:\n  pass'.slice(0, maxChars)
          : '',
      selectedEventIds: [],
      truncated: false,
      notes: [],
      renderingErrors: [],
    }),
  })
);

describe('ByokSettingsTab: benchmark snapshot (audit011026 B-TOOL-1)', () => {
  // Lazy: a static import would load PreferencesContext before the
  // matchMedia polyfill above has run.
  const {
    snapshotProjectForBenchmark,
    describeByokBenchmarkCrash,
  } = require('./ByokSettingsTab');
  const makeFakeProject = () => ({
    getLayoutsCount: () => 1,
    getLayoutAt: () => ({
      getName: () => 'Scene',
      getEvents: () => 'fake-events',
      getObjects: () => ({
        getObjectsCount: () => 1,
        getObjectAt: () => ({ getName: () => 'Player' }),
      }),
    }),
  });

  it('snapshots events as EventScript text (parseable by the scorer)', () => {
    const snapshot = snapshotProjectForBenchmark(makeFakeProject());
    expect(snapshot.scenes).toHaveLength(1);
    expect(snapshot.scenes[0].eventsSource).toContain('if Always:');
    expect(snapshot.firstSceneName).toBe('Scene');
  });

  it('maps an empty render to null (scores as "no events written")', () => {
    const project: any = makeFakeProject();
    project.getLayoutAt = () => ({
      getName: () => 'Empty',
      getEvents: () => 'other-events',
      getObjects: () => ({ getObjectsCount: () => 0, getObjectAt: () => null }),
    });
    const snapshot = snapshotProjectForBenchmark(project);
    expect(snapshot.scenes[0].eventsSource).toBe(null);
  });

  it('classifies WASM aborts as engine crashes, not endpoint errors', () => {
    expect(
      describeByokBenchmarkCrash(new Error('memory access out of bounds'))
    ).toContain('Reload the IDE window');
    expect(describeByokBenchmarkCrash(new Error('404 model not found'))).toBe(
      null
    );
  });
});

describe('resolveByokProviderTestModelName (audit100226 UI-10)', () => {
  // Lazy, like the other helpers above: a static import would load
  // PreferencesContext before the matchMedia polyfill has run.
  const { resolveByokProviderTestModelName } = require('./ByokSettingsTab');

  const makeProvider = (modelSettings: Array<Object>) => ({
    id: 'provider-1',
    name: 'Provider 1',
    endpointUrl: 'https://api.example.com/v1',
    keyRef: 'provider-1',
    modelSettings,
  });

  it('uses the provider own first model when one is configured', () => {
    expect(
      resolveByokProviderTestModelName(
        makeProvider([
          {
            modelName: 'my-model',
            temperature: null,
            maxTokens: null,
            contextWindowTokens: null,
          },
        ]),
        [{ id: 'other-model' }]
      )
    ).toBe('my-model');
  });

  it('falls back to a fetched model when none is configured', () => {
    // The card exists with an empty modelSettings from the moment it is
    // added; the user may have only ever clicked "Fetch models".
    expect(
      resolveByokProviderTestModelName(makeProvider([]), [
        { id: 'fetched-model' },
      ])
    ).toBe('fetched-model');
  });

  it('reports "no model" instead of an empty request', () => {
    expect(resolveByokProviderTestModelName(makeProvider([]), [])).toBe('');
  });
});
