// @flow
import { DEFAULT_BYOK_SETTINGS, type ByokSettings } from './ByokTypes';
import {
  extractByokEffortLevels,
  getByokCapabilityRecord,
  makeByokCapabilityTargetKey,
  probeByokParallelToolCalls,
  probeByokStrictSchemas,
  rememberByokImageSupport,
  rememberByokReasoningEffortDegraded,
} from './ByokCapabilities';
import { sendByokChatCompletion } from './ByokClient';

jest.mock('./ByokClient', () => ({
  sendByokChatCompletion: jest.fn(),
}));

const makeSettings = (overrides?: Object): ByokSettings => ({
  ...DEFAULT_BYOK_SETTINGS,
  ...overrides,
});

describe('ByokCapabilities: the per (endpoint, model) cache', () => {
  it('keys records per endpoint AND model (same model, two endpoints)', () => {
    expect(makeByokCapabilityTargetKey('https://a/v1/', 'm1')).toBe(
      'https://a/v1::m1'
    );
    expect(
      makeByokCapabilityTargetKey('https://a/v1', 'm1') !==
        makeByokCapabilityTargetKey('https://a/v1', 'm2')
    ).toBe(true);
  });

  it('returns null for a target that was never probed', () => {
    expect(
      getByokCapabilityRecord(makeSettings(), 'https://a/v1', 'unknown-model')
    ).toBe(null);
  });

  it('remembers the reasoning_effort degradation (no repeated 400s)', () => {
    let settings = makeSettings();
    settings = {
      ...settings,
      ...rememberByokReasoningEffortDegraded(settings, 'https://a/v1', 'm1'),
    };
    const record = getByokCapabilityRecord(settings, 'https://a/v1', 'm1');
    expect(record && record.reasoningEffortDegraded).toBe(true);

    // Another model of the same endpoint is untouched.
    const otherModel = getByokCapabilityRecord(settings, 'https://a/v1', 'm2');
    expect(otherModel).toBe(null);
  });

  it('remembers the image auto-detect outcome per model', () => {
    let settings = makeSettings();
    settings = {
      ...settings,
      ...rememberByokImageSupport(
        settings,
        'https://a/v1',
        'vision-model',
        true
      ),
    };
    settings = {
      ...settings,
      ...rememberByokImageSupport(
        settings,
        'https://a/v1',
        'text-model',
        false
      ),
    };
    expect(
      getByokCapabilityRecord(settings, 'https://a/v1', 'vision-model')?.images
    ).toBe(true);
    expect(
      getByokCapabilityRecord(settings, 'https://a/v1', 'text-model')?.images
    ).toBe(false);
  });

  it('merges patches into the existing record instead of replacing it', () => {
    let settings = makeSettings();
    settings = {
      ...settings,
      ...rememberByokImageSupport(settings, 'https://a/v1', 'm1', true),
    };
    settings = {
      ...settings,
      ...rememberByokReasoningEffortDegraded(settings, 'https://a/v1', 'm1'),
    };
    const record = getByokCapabilityRecord(settings, 'https://a/v1', 'm1');
    expect(record && record.images).toBe(true);
    expect(record && record.reasoningEffortDegraded).toBe(true);
  });

  it('ignores unknown shapes when reading the settings back', () => {
    const settings = makeSettings({
      capabilitiesByTargetKey: {
        'https://a/v1::m1': {
          images: 'banana',
          reasoningEffortDegraded: 'yes',
        },
        broken: null,
      },
    });
    const record = getByokCapabilityRecord(settings, 'https://a/v1', 'm1');
    expect(record && record.images).toBe(null);
    expect(record && record.reasoningEffortDegraded).toBe(false);
  });
});

describe('ByokCapabilities: server-listed effort levels', () => {
  it('reads the known field names and keeps only the three levels', () => {
    expect(
      extractByokEffortLevels({
        supported_reasoning_efforts: ['low', 'medium', 'high', 'extreme'],
      })
    ).toEqual(['low', 'medium', 'high']);
    expect(extractByokEffortLevels({ reasoning_efforts: ['high'] })).toEqual([
      'high',
    ]);
    expect(
      extractByokEffortLevels({
        metadata: { supported_reasoning_efforts: ['low'] },
      })
    ).toEqual(['low']);
  });

  it('returns null when the entry lists nothing usable', () => {
    expect(extractByokEffortLevels({})).toBe(null);
    expect(extractByokEffortLevels({ reasoning_efforts: ['turbo'] })).toBe(
      null
    );
    expect(extractByokEffortLevels(null)).toBe(null);
  });
});

describe('ByokCapabilities: the strict/parallel probes', () => {
  beforeEach(() => {
    ((sendByokChatCompletion: any): JestMockFn<any, any>).mockReset();
  });

  it('reports strict-schema support when the request is accepted', async () => {
    ((sendByokChatCompletion: any): JestMockFn<any, any>).mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    });
    await expect(
      probeByokStrictSchemas({ baseUrl: 'https://a/v1', apiKey: 'k' }, 'm1')
    ).resolves.toBe(true);
    const call = ((sendByokChatCompletion: any): JestMockFn<any, any>).mock
      .calls[0][0];
    expect(call.options.tools[0].function.strict).toBe(true);
  });

  it('reports parallel_tool_calls support when the request is accepted', async () => {
    ((sendByokChatCompletion: any): JestMockFn<any, any>).mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    });
    await expect(
      probeByokParallelToolCalls({ baseUrl: 'https://a/v1', apiKey: 'k' }, 'm1')
    ).resolves.toBe(true);
    const call = ((sendByokChatCompletion: any): JestMockFn<any, any>).mock
      .calls[0][0];
    expect(call.options.parallelToolCalls).toBe(true);
  });

  it('propagates endpoint rejections (the caller records the degradation)', async () => {
    ((sendByokChatCompletion: any): JestMockFn<any, any>).mockRejectedValue(
      new Error('rejected')
    );
    await expect(
      probeByokStrictSchemas({ baseUrl: 'https://a/v1', apiKey: 'k' }, 'm1')
    ).rejects.toThrow('rejected');
  });
});
