/**
 * @jest-environment jsdom
 */
// @flow
import * as React from 'react';
import { act } from 'react-dom/test-utils';
import TestRenderer from 'react-test-renderer';

// jsdom does not implement matchMedia, which the UI component stack (the
// theme) calls at module load. Polyfill it BEFORE anything that transitively
// needs it — hence the require() calls below instead of static imports.
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

// The Electron module is mocked (desktop/web modes) with a plain closure:
// the Jest config resets mock implementations between tests, and a closure
// is immune.
let mockElectronModule: any = null;
const mockIpcInvoke = (jest.fn(): any);
const mockIpcSend = (jest.fn(): any);

const makeDesktopElectron = () => ({
  ipcRenderer: { invoke: mockIpcInvoke, send: mockIpcSend },
});

jest.mock('../../../Utils/OptionalRequire', () => ({
  __esModule: true,
  default: () => mockElectronModule,
}));

const Checkbox = require('../../../UI/Checkbox').default;
const CompactSelectField = require('../../../UI/CompactSelectField').default;
const FlatButton = require('../../../UI/FlatButton').default;
const ByokMcpSettingsCardModule = require('./ByokMcpSettingsCard');
const ByokMcpSettingsCard = ByokMcpSettingsCardModule.ByokMcpSettingsCard;
const {
  clearByokMcpActivity,
  executeByokMcpToolCall,
  makeByokMcpToolHost,
  setByokMcpToolHost,
} = require('./ByokMcpToolHost');
const { DEFAULT_BYOK_SETTINGS } = require('../ByokTypes');

const { I18nProvider } = require('@lingui/react');
const { setupI18n } = require('@lingui/core');

const i18n = setupI18n({ language: 'en', catalogs: {} });

const flushMicrotasks = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
};

const makeMcpServer = (overrides?: Object) => ({
  enabled: false,
  accessMode: 'read-write',
  ...(DEFAULT_BYOK_SETTINGS: any).mcpServer,
  ...overrides,
});

// A main-side aggregate entry, as `byok-mcp-status` serves them: by default
// from another window, newer than anything the local ring can hold today.
const makeRemoteActivityEntry = (overrides?: Object) => ({
  at: '2027-01-01T00:00:00.000Z',
  tool: 'other_window_tool',
  argsPreview: '{}',
  outcome: 'completed',
  didModifyProject: false,
  durationMs: 12,
  ...(overrides || {}),
});

const renderCard = async (props: {
  mcpServer: Object,
  onChange: (partial: Object) => void,
}) => {
  let component: any = null;
  await act(async () => {
    component = TestRenderer.create(
      <I18nProvider i18n={i18n} language="en">
        <ByokMcpSettingsCard
          mcpServer={props.mcpServer}
          onChange={props.onChange}
        />
      </I18nProvider>
    );
    await flushMicrotasks();
  });
  renderedComponents.push(component);
  return component;
};

const findEnableCheckbox = (component: any) => {
  const checkboxes = component.root.findAllByType(Checkbox);
  const enableCheckbox = checkboxes.find(
    candidate => candidate.props.checked !== undefined
  );
  if (!enableCheckbox) throw new Error('The enable checkbox was not rendered');
  return enableCheckbox;
};

// Every rendered card is unmounted after its test: an enabled card runs a
// status-refresh interval that would otherwise leak past the suite.
const renderedComponents: Array<any> = [];

beforeEach(() => {
  jest.clearAllMocks();
  mockIpcInvoke.mockResolvedValue({
    ok: true,
    running: true,
    port: 51234,
    discoveryPath: 'C:/fake/gdevelop-mcp-endpoint.json',
  });
  clearByokMcpActivity();
  setByokMcpToolHost(null);
});

afterEach(() => {
  renderedComponents.forEach(component => {
    if (component) component.unmount();
  });
  renderedComponents.length = 0;
  setByokMcpToolHost(null);
});

describe('ByokMcpSettingsCard', () => {
  it('is disabled with an explainer in the web build', async () => {
    mockElectronModule = null;
    const onChange = (jest.fn(): any);
    const component = await renderCard({
      mcpServer: makeMcpServer(),
      onChange,
    });
    const checkbox = findEnableCheckbox(component);
    expect(checkbox.props.disabled).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows the running endpoint and discovery path when enabled on desktop', async () => {
    mockElectronModule = makeDesktopElectron();
    const component = await renderCard({
      mcpServer: makeMcpServer({ enabled: true }),
      onChange: jest.fn(),
    });
    expect(mockIpcInvoke).toHaveBeenCalledWith('byok-mcp-status');
    const rendered = JSON.stringify(component.toJSON());
    expect(rendered).toContain('51234');
    expect(rendered).toContain('gdevelop-mcp-endpoint.json');
  });

  it('toggles the server through onChange', async () => {
    mockElectronModule = makeDesktopElectron();
    const onChange = (jest.fn(): any);
    const component = await renderCard({
      mcpServer: makeMcpServer({ enabled: true }),
      onChange,
    });
    const checkbox = findEnableCheckbox(component);
    await act(async () => {
      checkbox.props.onCheck({}, false);
    });
    expect(onChange).toHaveBeenCalledWith({ enabled: false });
  });

  it('changes the access mode through onChange', async () => {
    mockElectronModule = makeDesktopElectron();
    const onChange = (jest.fn(): any);
    const component = await renderCard({
      mcpServer: makeMcpServer({ enabled: true, accessMode: 'read-write' }),
      onChange,
    });
    const select = component.root.findAllByType(CompactSelectField)[0];
    if (!select) throw new Error('The access mode select was not rendered');
    await act(async () => {
      select.props.onChange('read-only');
    });
    expect(onChange).toHaveBeenCalledWith({ accessMode: 'read-only' });
  });

  it('lists the recent activity and clears it', async () => {
    mockElectronModule = makeDesktopElectron();
    const host = makeByokMcpToolHost(
      ({
        executeRegistryTool: jest.fn(),
        executeExtraTool: jest.fn(),
        getExtraTool: () => null,
        editorFunctions: {},
        editorFunctionsWithoutProject: {},
        getProject: () => null,
        getSettings: () => ({
          mcpServer: { enabled: true, accessMode: 'read-write' },
        }),
      }: any)
    );
    setByokMcpToolHost(host);
    await executeByokMcpToolCall('read_scene_events', {}, { timeoutMs: 1000 });

    const component = await renderCard({
      mcpServer: makeMcpServer({ enabled: true }),
      onChange: jest.fn(),
    });
    const rendered = JSON.stringify(component.toJSON());
    expect(rendered).toContain('read_scene_events');

    const clearButton = component.root
      .findAllByType(FlatButton)
      .find(button => {
        const label = button.props.label;
        return (
          label &&
          label.props &&
          label.props.id &&
          label.props.id.includes('Clear')
        );
      });
    if (!clearButton) throw new Error('The clear button was not rendered');
    await act(async () => {
      clearButton.props.onClick();
    });
    const renderedAfterClear = JSON.stringify(component.toJSON());
    expect(renderedAfterClear).not.toContain('read_scene_events');
  });

  it('merges the main-side aggregate into the activity list (B-MCP-13)', async () => {
    mockElectronModule = makeDesktopElectron();
    mockIpcInvoke.mockResolvedValue({
      ok: true,
      running: true,
      port: 51234,
      discoveryPath: 'C:/fake/gdevelop-mcp-endpoint.json',
      activity: [makeRemoteActivityEntry()],
    });
    const host = makeByokMcpToolHost(
      ({
        executeRegistryTool: jest.fn(),
        executeExtraTool: jest.fn(),
        getExtraTool: () => null,
        editorFunctions: {},
        editorFunctionsWithoutProject: {},
        getProject: () => null,
        getSettings: () => ({
          mcpServer: { enabled: true, accessMode: 'read-write' },
        }),
      }: any)
    );
    setByokMcpToolHost(host);
    await executeByokMcpToolCall('read_scene_events', {}, { timeoutMs: 1000 });

    const component = await renderCard({
      mcpServer: makeMcpServer({ enabled: true }),
      onChange: jest.fn(),
    });
    const rendered = JSON.stringify(component.toJSON());
    // This window's own entry...
    expect(rendered).toContain('read_scene_events');
    // ...and the other window's entry from the main-side aggregate.
    expect(rendered).toContain('other_window_tool');
  });

  it('falls back to the local ring alone when the status invoke fails', async () => {
    mockElectronModule = makeDesktopElectron();
    mockIpcInvoke.mockRejectedValue(new Error('no handler'));
    const host = makeByokMcpToolHost(
      ({
        executeRegistryTool: jest.fn(),
        executeExtraTool: jest.fn(),
        getExtraTool: () => null,
        editorFunctions: {},
        editorFunctionsWithoutProject: {},
        getProject: () => null,
        getSettings: () => ({
          mcpServer: { enabled: true, accessMode: 'read-write' },
        }),
      }: any)
    );
    setByokMcpToolHost(host);
    await executeByokMcpToolCall('read_scene_events', {}, { timeoutMs: 1000 });

    const component = await renderCard({
      mcpServer: makeMcpServer({ enabled: true }),
      onChange: jest.fn(),
    });
    const rendered = JSON.stringify(component.toJSON());
    expect(rendered).toContain('read_scene_events');
    expect(rendered).toContain('unavailable');
  });

  it('clears the merged log in this window and the main aggregate', async () => {
    mockElectronModule = makeDesktopElectron();
    mockIpcInvoke.mockResolvedValue({
      ok: true,
      running: true,
      port: 51234,
      discoveryPath: 'C:/fake/gdevelop-mcp-endpoint.json',
      activity: [makeRemoteActivityEntry()],
    });
    const component = await renderCard({
      mcpServer: makeMcpServer({ enabled: true }),
      onChange: jest.fn(),
    });
    const rendered = JSON.stringify(component.toJSON());
    expect(rendered).toContain('other_window_tool');

    const clearButton = component.root
      .findAllByType(FlatButton)
      .find(button => {
        const label = button.props.label;
        return (
          label &&
          label.props &&
          label.props.id &&
          label.props.id.includes('Clear')
        );
      });
    if (!clearButton) throw new Error('The clear button was not rendered');
    await act(async () => {
      clearButton.props.onClick();
    });
    expect(mockIpcSend).toHaveBeenCalledWith('byok-mcp-activity-clear');
    const renderedAfterClear = JSON.stringify(component.toJSON());
    expect(renderedAfterClear).not.toContain('other_window_tool');
  });
});
