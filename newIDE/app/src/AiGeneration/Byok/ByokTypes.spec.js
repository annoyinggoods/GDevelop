// @flow
import {
  BYOK_IMAGE_SUPPORTS,
  BYOK_MCP_ACCESS_MODES,
  DEFAULT_BYOK_SETTINGS,
  DEFAULT_BYOK_MCP_ACCESS_MODE,
  getByokProviderModelSettings,
  getByokSettings,
  isByokFullyConfigured,
  isByokImageSupport,
  isByokMcpAccessMode,
  isByokReasoningEffort,
  makeDefaultByokMcpServerSettings,
  removeByokProviderModelSettings,
  upsertByokProviderModelSettings,
  type ByokSettings,
  type ByokProvider,
} from './ByokTypes';

const makeByokSettings = (overrides?: Partial<ByokSettings>): ByokSettings => ({
  ...DEFAULT_BYOK_SETTINGS,
  ...overrides,
});

describe('DEFAULT_BYOK_SETTINGS', () => {
  it('has the documented default values', () => {
    expect(DEFAULT_BYOK_SETTINGS).toEqual({
      enabled: false,
      endpointUrl: '',
      modelName: '',
      reasoningEffort: 'default',
      imageSupport: 'auto',
      contextWindowTokens: 8192,
      contextWindowByModel: {},
      onlineDocsEnabled: false,
      customInstructions: '',
      buildWorkflowAutoSuggest: true,
      stallWatchdogEnabled: true,
      stallWindowSeconds: 90,
      suggestionsEnabled: false,
      providers: [],
      routingMode: 'automatic',
      fastProfile: {
        providerId: '',
        modelName: '',
        temperature: null,
        maxTokens: null,
      },
      strongProfile: {
        providerId: '',
        modelName: '',
        temperature: null,
        maxTokens: null,
      },
      capabilitiesByTargetKey: {},
      mcpServer: {
        enabled: false,
        accessMode: 'read-write',
      },
    });
  });
});

describe('ByokMcpServerSettings', () => {
  it('offers the two documented access modes and rejects the others', () => {
    for (const mode of BYOK_MCP_ACCESS_MODES) {
      expect(isByokMcpAccessMode(mode)).toBe(true);
    }
    expect(isByokMcpAccessMode('admin')).toBe(false);
    expect(isByokMcpAccessMode(null)).toBe(false);
  });

  it('defaults to the server off and writes allowed (decision D10-2)', () => {
    expect(DEFAULT_BYOK_MCP_ACCESS_MODE).toBe('read-write');
    const defaults = makeDefaultByokMcpServerSettings();
    expect(defaults).toEqual({ enabled: false, accessMode: 'read-write' });
    expect(makeDefaultByokMcpServerSettings()).not.toBe(defaults);
  });

  it('is read back by getByokSettings, defaulting corrupted values', () => {
    const valid = getByokSettings({
      byok: ({
        mcpServer: { enabled: true, accessMode: 'read-only' },
      }: any),
    }).mcpServer;
    expect(valid).toEqual({ enabled: true, accessMode: 'read-only' });

    const corruptedAccessMode = getByokSettings({
      byok: ({
        mcpServer: { enabled: true, accessMode: 'sudo' },
      }: any),
    }).mcpServer;
    expect(corruptedAccessMode).toEqual({
      enabled: true,
      accessMode: 'read-write',
    });

    const garbage = getByokSettings({ byok: ({ mcpServer: 42 }: any) })
      .mcpServer;
    expect(garbage).toEqual({ enabled: false, accessMode: 'read-write' });

    expect(getByokSettings(({}: any)).mcpServer).toEqual({
      enabled: false,
      accessMode: 'read-write',
    });
  });
});

describe('ByokImageSupport', () => {
  it('accepts the three documented values and rejects the others', () => {
    for (const support of BYOK_IMAGE_SUPPORTS) {
      expect(isByokImageSupport(support)).toBe(true);
    }
    expect(isByokImageSupport('maybe')).toBe(false);
    expect(isByokImageSupport(null)).toBe(false);
  });

  it('is read back by getByokSettings, defaulting corrupted values', () => {
    expect(
      getByokSettings({ byok: ({ imageSupport: 'no' }: any) }).imageSupport
    ).toBe('no');
    expect(
      getByokSettings({ byok: ({ imageSupport: 'sometimes' }: any) })
        .imageSupport
    ).toBe('auto');
    expect(getByokSettings(({}: any)).imageSupport).toBe('auto');
  });
});

describe('getByokSettings', () => {
  it('returns the defaults when the byok field is missing', () => {
    expect(getByokSettings(({}: any))).toEqual(DEFAULT_BYOK_SETTINGS);
  });

  it('returns the defaults when the byok field is null', () => {
    expect(getByokSettings({ byok: null })).toEqual(DEFAULT_BYOK_SETTINGS);
  });

  it('returns the defaults when the byok field is not an object (corrupted storage)', () => {
    expect(getByokSettings({ byok: ('not an object': any) })).toEqual(
      DEFAULT_BYOK_SETTINGS
    );
  });

  it('returns a fresh copy of the defaults, never the shared constant', () => {
    // A caller mutating what it got must not pollute the module default
    // (which also seeds the preferences defaults).
    const first = getByokSettings(({}: any));
    first.contextWindowByModel['some-model'] = 1234;
    first.endpointUrl = 'https://mutated.example.com/v1';

    expect(getByokSettings(({}: any)).contextWindowByModel).toEqual({});
    expect(getByokSettings(({}: any)).endpointUrl).toBe(
      DEFAULT_BYOK_SETTINGS.endpointUrl
    );
  });

  it('returns the defaults for missing fields on a partially-filled object', () => {
    // Simulates settings saved by an older build, before some fields existed.
    const partialByok = { endpointUrl: 'https://example.com/v1' };
    expect(getByokSettings({ byok: (partialByok: any) })).toEqual({
      ...DEFAULT_BYOK_SETTINGS,
      endpointUrl: 'https://example.com/v1',
    });
  });

  it('ignores fields with an unexpected type on a partially-filled object', () => {
    const corruptedByok = {
      enabled: 'yes',
      contextWindowTokens: 'a lot',
      reasoningEffort: 42,
    };
    expect(getByokSettings({ byok: (corruptedByok: any) })).toEqual(
      DEFAULT_BYOK_SETTINGS
    );
  });

  it('returns the stored values when the object is complete', () => {
    const storedSettings = makeByokSettings({
      enabled: true,
      endpointUrl: 'https://api.example.com/v1',
      modelName: 'my-model',
      reasoningEffort: 'high',
      contextWindowTokens: 32768,
    });
    expect(getByokSettings({ byok: storedSettings })).toEqual(storedSettings);
  });
});

describe('getByokSettings: contextWindowByModel', () => {
  it('defaults to an empty map when the field is missing', () => {
    expect(getByokSettings({ byok: ({ endpointUrl: 'x' }: any) })).toEqual({
      ...DEFAULT_BYOK_SETTINGS,
      endpointUrl: 'x',
    });
  });

  it('keeps the per-model entries that are positive numbers', () => {
    const storedByok = {
      contextWindowByModel: { 'model-a': 32768, 'model-b': 4096 },
    };
    expect(
      getByokSettings({ byok: (storedByok: any) }).contextWindowByModel
    ).toEqual({
      'model-a': 32768,
      'model-b': 4096,
    });
  });

  it('drops the per-model entries that are not positive numbers', () => {
    const storedByok = {
      contextWindowByModel: {
        'model-a': 'big',
        'model-b': 0,
        'model-c': -1,
        'model-d': 2048,
      },
    };
    expect(
      getByokSettings({ byok: (storedByok: any) }).contextWindowByModel
    ).toEqual({
      'model-d': 2048,
    });
  });

  it('defaults to an empty map when the field is not an object', () => {
    expect(
      getByokSettings({ byok: ({ contextWindowByModel: 'nope' }: any) })
        .contextWindowByModel
    ).toEqual({});
    expect(
      getByokSettings({ byok: ({ contextWindowByModel: [8192] }: any) })
        .contextWindowByModel
    ).toEqual({});
  });
});

describe('isByokReasoningEffort', () => {
  it('accepts the four documented efforts', () => {
    expect(isByokReasoningEffort('default')).toBe(true);
    expect(isByokReasoningEffort('low')).toBe(true);
    expect(isByokReasoningEffort('medium')).toBe(true);
    expect(isByokReasoningEffort('high')).toBe(true);
  });

  it('rejects any other value', () => {
    expect(isByokReasoningEffort('gigachad')).toBe(false);
    expect(isByokReasoningEffort(null)).toBe(false);
    expect(isByokReasoningEffort(undefined)).toBe(false);
  });
});

describe('isByokFullyConfigured', () => {
  it('is false when BYOK is disabled', () => {
    const settings = makeByokSettings({
      enabled: false,
      endpointUrl: 'https://api.example.com/v1',
      modelName: 'my-model',
    });
    expect(isByokFullyConfigured(settings)).toBe(false);
  });

  it('is false when the endpoint URL is empty', () => {
    const settings = makeByokSettings({
      enabled: true,
      endpointUrl: '',
      modelName: 'my-model',
    });
    expect(isByokFullyConfigured(settings)).toBe(false);
  });

  it('is false when the model name is empty', () => {
    const settings = makeByokSettings({
      enabled: true,
      endpointUrl: 'https://api.example.com/v1',
      modelName: '',
    });
    expect(isByokFullyConfigured(settings)).toBe(false);
  });

  it('is true with an https:// endpoint URL', () => {
    const settings = makeByokSettings({
      enabled: true,
      endpointUrl: 'https://api.example.com/v1',
      modelName: 'my-model',
    });
    expect(isByokFullyConfigured(settings)).toBe(true);
  });

  it('is true with an http:// endpoint URL (local server like Ollama)', () => {
    const settings = makeByokSettings({
      enabled: true,
      endpointUrl: 'http://localhost:1234/v1',
      modelName: 'my-model',
    });
    expect(isByokFullyConfigured(settings)).toBe(true);
  });

  it('is false with another protocol like ftp://', () => {
    const settings = makeByokSettings({
      enabled: true,
      endpointUrl: 'ftp://api.example.com/v1',
      modelName: 'my-model',
    });
    expect(isByokFullyConfigured(settings)).toBe(false);
  });

  it('is false with a value that is not a URL at all', () => {
    const settings = makeByokSettings({
      enabled: true,
      endpointUrl: 'not a url',
      modelName: 'my-model',
    });
    expect(isByokFullyConfigured(settings)).toBe(false);
  });
});

describe('ByokProvider model settings (Phase 13.4)', () => {
  const makeProvider = (): ByokProvider => ({
    id: 'p1',
    name: 'Provider 1',
    endpointUrl: 'https://p1.example.com/v1',
    keyRef: 'p1',
    modelSettings: [
      {
        modelName: 'tuned',
        temperature: 0.4,
        maxTokens: 1024,
        contextWindowTokens: 65536,
      },
    ],
  });

  it('reads the block of a model, and null for one without', () => {
    const provider = makeProvider();
    expect(getByokProviderModelSettings(provider, 'tuned')).toEqual({
      modelName: 'tuned',
      temperature: 0.4,
      maxTokens: 1024,
      contextWindowTokens: 65536,
    });
    expect(getByokProviderModelSettings(provider, 'other')).toBe(null);
  });

  it('upserts a block (replacing an existing one for the same model)', () => {
    const provider = makeProvider();
    const updated = upsertByokProviderModelSettings(provider, {
      modelName: 'tuned',
      temperature: 0.9,
      maxTokens: null,
      contextWindowTokens: null,
    });
    expect(updated.modelSettings).toHaveLength(1);
    expect(updated.modelSettings[0].temperature).toBe(0.9);
    // The input provider is not mutated.
    expect(provider.modelSettings[0].temperature).toBe(0.4);
  });

  it('removes a block without touching the others', () => {
    const provider = makeProvider();
    const withTwo = upsertByokProviderModelSettings(provider, {
      modelName: 'second',
      temperature: null,
      maxTokens: null,
      contextWindowTokens: null,
    });
    const removed = removeByokProviderModelSettings(withTwo, 'tuned');
    expect(removed.modelSettings.map(block => block.modelName)).toEqual([
      'second',
    ]);
  });

  it('parses modelSettings defensively from untrusted preferences', () => {
    const settings = getByokSettings({
      byok: ({
        ...DEFAULT_BYOK_SETTINGS,
        providers: [
          {
            id: 'p1',
            name: 'P1',
            endpointUrl: 'https://p1.example.com/v1',
            keyRef: 'p1',
            modelSettings: [
              'not-an-object',
              { modelName: '' },
              {
                modelName: 'good',
                temperature: 'not-a-number',
                maxTokens: 2048,
                contextWindowTokens: null,
              },
            ],
          },
        ],
      }: any),
    });
    expect(settings.providers).toHaveLength(1);
    expect(settings.providers[0].modelSettings).toEqual([
      {
        modelName: 'good',
        temperature: null,
        maxTokens: 2048,
        contextWindowTokens: null,
      },
    ]);
  });
});
