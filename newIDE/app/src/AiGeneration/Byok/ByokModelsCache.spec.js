// @flow
import axios from 'axios';
import {
  cacheByokModels,
  clearByokModels,
  extractContextWindowTokens,
  getCachedByokModels,
  normalizeByokModels,
  refreshByokModels,
  resolveContextWindowTokens,
} from './ByokModelsCache';
import {
  DEFAULT_BYOK_SETTINGS,
  type ByokModelInfo,
  type ByokSettings,
} from './ByokTypes';

jest.mock('axios');

// The automocked axios, untyped: jest replaces get with a mock function,
// and Flow refuses to unbind the real (typed) method to wrap it.
const mockAxios = (axios: any);

const makeSettings = (overrides?: Partial<ByokSettings>): ByokSettings => ({
  ...DEFAULT_BYOK_SETTINGS,
  ...overrides,
});

describe('extractContextWindowTokens', () => {
  it('returns null on an OpenAI-style entry without context fields', () => {
    expect(extractContextWindowTokens({ id: 'gpt-4o' })).toBe(null);
  });

  it('reads context_length (vLLM and gateways)', () => {
    expect(extractContextWindowTokens({ id: 'a', context_length: 32768 })).toBe(
      32768
    );
  });

  it('reads max_context_length (LM Studio)', () => {
    expect(
      extractContextWindowTokens({ id: 'a', max_context_length: 16384 })
    ).toBe(16384);
  });

  it('reads max_model_len (text-generation-webui, llama.cpp)', () => {
    expect(extractContextWindowTokens({ id: 'a', max_model_len: 8192 })).toBe(
      8192
    );
  });

  it('reads context_size', () => {
    expect(extractContextWindowTokens({ id: 'a', context_size: 4096 })).toBe(
      4096
    );
  });

  it('reads metadata.context_length when nested', () => {
    expect(
      extractContextWindowTokens({
        id: 'a',
        metadata: { context_length: 2048 },
      })
    ).toBe(2048);
  });

  it('returns the first positive number in the documented field order', () => {
    expect(
      extractContextWindowTokens({
        id: 'a',
        context_length: 32768,
        max_context_length: 16384,
      })
    ).toBe(32768);
    expect(
      extractContextWindowTokens({
        id: 'a',
        max_context_length: 16384,
        max_model_len: 8192,
      })
    ).toBe(16384);
  });

  it('ignores zero, negative and non-number values', () => {
    expect(extractContextWindowTokens({ id: 'a', context_length: 0 })).toBe(
      null
    );
    expect(extractContextWindowTokens({ id: 'a', context_length: -5 })).toBe(
      null
    );
    expect(extractContextWindowTokens({ id: 'a', context_length: 'big' })).toBe(
      null
    );
  });

  it('returns null on a non-object entry', () => {
    expect((extractContextWindowTokens: any)(null)).toBe(null);
    expect((extractContextWindowTokens: any)('a string')).toBe(null);
  });
});

describe('normalizeByokModels', () => {
  it('parses the context windows of a vLLM-style response', () => {
    const models = normalizeByokModels([
      { id: 'model-b', context_length: 32768 },
      { id: 'model-a', context_length: 8192 },
    ]);
    expect(models).toEqual([
      { id: 'model-a', contextWindowTokens: 8192 },
      { id: 'model-b', contextWindowTokens: 32768 },
    ]);
  });

  it('parses the context windows of an LM Studio-style response', () => {
    const models = normalizeByokModels([
      { id: 'model-a', max_context_length: 4096 },
    ]);
    expect(models).toEqual([{ id: 'model-a', contextWindowTokens: 4096 }]);
  });

  it('keeps null when the server does not report a context window', () => {
    const models = normalizeByokModels([{ id: 'gpt-4o' }, { id: 'gpt-3.5' }]);
    expect(models).toEqual([
      { id: 'gpt-3.5', contextWindowTokens: null },
      { id: 'gpt-4o', contextWindowTokens: null },
    ]);
  });

  it('drops entries without an id and sorts the rest by id', () => {
    const models = normalizeByokModels([
      { nope: true },
      { id: 'zeta' },
      { id: 'alpha', max_model_len: 1024 },
      'not an object',
    ]);
    expect(models).toEqual([
      { id: 'alpha', contextWindowTokens: 1024 },
      { id: 'zeta', contextWindowTokens: null },
    ]);
  });
});

describe('resolveContextWindowTokens', () => {
  it('prefers the context window reported by the server', () => {
    const settings = makeSettings({
      contextWindowTokens: 12345,
      contextWindowByModel: { 'my-model': 23456 },
    });
    expect(
      resolveContextWindowTokens(
        settings,
        { id: 'my-model', contextWindowTokens: 32768 },
        'my-model'
      )
    ).toBe(32768);
  });

  it('falls back to the per-model value set by the user', () => {
    const settings = makeSettings({
      contextWindowTokens: 12345,
      contextWindowByModel: { 'my-model': 23456 },
    });
    expect(
      resolveContextWindowTokens(
        settings,
        { id: 'my-model', contextWindowTokens: null },
        'my-model'
      )
    ).toBe(23456);
  });

  it('falls back to the global value set by the user', () => {
    const settings = makeSettings({ contextWindowTokens: 12345 });
    expect(
      resolveContextWindowTokens(
        settings,
        { id: 'my-model', contextWindowTokens: null },
        'my-model'
      )
    ).toBe(12345);
  });

  it('falls back to the default (8192) as the last resort', () => {
    expect(
      resolveContextWindowTokens(
        makeSettings(),
        { id: 'my-model', contextWindowTokens: null },
        'my-model'
      )
    ).toBe(DEFAULT_BYOK_SETTINGS.contextWindowTokens);
  });

  it('ignores a non-positive or invalid reported context window', () => {
    const settings = makeSettings({
      contextWindowByModel: { 'my-model': 23456 },
    });
    expect(
      resolveContextWindowTokens(
        settings,
        { id: 'my-model', contextWindowTokens: 0 },
        'my-model'
      )
    ).toBe(23456);
    expect(
      resolveContextWindowTokens(
        settings,
        { id: 'my-model', contextWindowTokens: -1 },
        'my-model'
      )
    ).toBe(23456);
  });

  it('works without a model info at all', () => {
    expect(resolveContextWindowTokens(makeSettings(), null, 'my-model')).toBe(
      DEFAULT_BYOK_SETTINGS.contextWindowTokens
    );
  });
});

describe('models cache and refreshByokModels', () => {
  beforeEach(() => {
    mockAxios.get.mockReset();
    clearByokModels();
  });

  it('fetches, normalizes, caches and returns the model list', async () => {
    // The JSON body of a /models response is the OpenAI "list" envelope.
    mockAxios.get.mockResolvedValueOnce({
      data: {
        data: [{ id: 'model-b', context_length: 32768 }, { id: 'model-a' }],
      },
    });

    const models = await refreshByokModels({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
    });

    expect(models).toEqual([
      { id: 'model-a', contextWindowTokens: null },
      { id: 'model-b', contextWindowTokens: 32768 },
    ]);
    expect(getCachedByokModels('https://api.example.com/v1')).toEqual(models);
  });

  it('caches per base URL, without mixing endpoints', async () => {
    cacheByokModels('https://one.example.com/v1', [
      { id: 'one-model', contextWindowTokens: null },
    ]);

    expect(getCachedByokModels('https://one.example.com/v1')).toEqual([
      { id: 'one-model', contextWindowTokens: null },
    ]);
    expect(getCachedByokModels('https://other.example.com/v1')).toBe(null);
  });

  it('normalizes the cache key: trailing slash and whitespace are one entry', () => {
    cacheByokModels('https://host/v1/', [{ id: 'm', contextWindowTokens: 1 }]);

    expect(getCachedByokModels('https://host/v1')).toEqual([
      { id: 'm', contextWindowTokens: 1 },
    ]);
    expect(getCachedByokModels(' https://host/v1 ')).toEqual([
      { id: 'm', contextWindowTokens: 1 },
    ]);
  });

  it('caches a copy: mutating the returned list cannot corrupt the cache', () => {
    const models: Array<ByokModelInfo> = [
      { id: 'm', contextWindowTokens: null },
    ];
    cacheByokModels('https://host/v1', models);
    models.push({ id: 'intruder', contextWindowTokens: null });

    expect(getCachedByokModels('https://host/v1')).toHaveLength(1);

    const cached = getCachedByokModels('https://host/v1');
    if (!cached) throw new Error('Expected cached models');
    cached.push({ id: 'intruder', contextWindowTokens: null });
    expect(getCachedByokModels('https://host/v1')).toHaveLength(1);
  });

  it('clearByokModels forgets every endpoint (used when the API key changes)', () => {
    cacheByokModels('https://one.example.com/v1', [
      { id: 'one-model', contextWindowTokens: null },
    ]);
    cacheByokModels('https://two.example.com/v1', [
      { id: 'two-model', contextWindowTokens: null },
    ]);

    clearByokModels();

    expect(getCachedByokModels('https://one.example.com/v1')).toBe(null);
    expect(getCachedByokModels('https://two.example.com/v1')).toBe(null);
  });

  it('returns null from the cache for an endpoint that was never fetched', () => {
    expect(getCachedByokModels('https://never-fetched.example.com/v1')).toBe(
      null
    );
  });

  it('propagates the errors of the fetch, without caching anything', async () => {
    mockAxios.get.mockRejectedValueOnce({
      response: { status: 401, data: {} },
      request: {},
    });

    let thrownError: any = null;
    try {
      await refreshByokModels({
        baseUrl: 'https://failing-endpoint.example.com/v1',
        apiKey: 'sk-test',
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError.kind).toBe('authentication');
    expect(getCachedByokModels('https://failing-endpoint.example.com/v1')).toBe(
      null
    );
  });
});

describe('resolveContextWindowTokens: the provider per-model slot (13.4)', () => {
  it('prefers the provider block over the legacy global map', () => {
    const settings: ByokSettings = {
      ...DEFAULT_BYOK_SETTINGS,
      contextWindowTokens: 8192,
      contextWindowByModel: { 'my-model': 4096 },
    };
    expect(resolveContextWindowTokens(settings, null, 'my-model', 65536)).toBe(
      65536
    );
  });

  it('still falls back to the legacy map and the global default', () => {
    const settings: ByokSettings = {
      ...DEFAULT_BYOK_SETTINGS,
      contextWindowTokens: 8192,
      contextWindowByModel: { 'my-model': 4096 },
    };
    expect(resolveContextWindowTokens(settings, null, 'my-model', null)).toBe(
      4096
    );
    expect(resolveContextWindowTokens(settings, null, 'other')).toBe(8192);
  });
});
