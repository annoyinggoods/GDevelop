// @flow
import {
  contextStatsFromUsage,
  createByokUsageTracker,
  usageFromResponse,
} from './ByokUsageTracker';
import { type ByokChatCompletionResponse, type ByokUsage } from './ByokTypes';

const makeResponse = (usage?: Object): ByokChatCompletionResponse => ({
  choices: [
    {
      message: { role: 'assistant', content: 'Hello!' },
      finish_reason: 'stop',
    },
  ],
  ...(usage === undefined ? {} : { usage }),
});

const makeUsage = (overrides?: Partial<ByokUsage>): ByokUsage => ({
  promptTokens: 100,
  completionTokens: 50,
  totalTokens: 150,
  ...overrides,
});

describe('usageFromResponse', () => {
  it('maps the snake_case usage fields to the normalized shape', () => {
    expect(
      usageFromResponse(
        makeResponse({
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
        })
      )
    ).toEqual(makeUsage());
  });

  it('returns null when the server omitted the usage', () => {
    expect(usageFromResponse(makeResponse())).toBe(null);
    expect(usageFromResponse(makeResponse(undefined))).toBe(null);
  });

  it('returns null when the usage is incomplete', () => {
    expect(usageFromResponse(makeResponse({ prompt_tokens: 100 }))).toBe(null);
    expect(
      usageFromResponse(
        makeResponse({ prompt_tokens: 100, completion_tokens: 'nope' })
      )
    ).toBe(null);
  });
});

describe('contextStatsFromUsage', () => {
  it('computes the ratio from prompt + completion tokens over the window', () => {
    // 150 tokens used in a 8192 window ≈ 1.83%.
    const stats = contextStatsFromUsage(makeUsage(), 8192);
    expect(stats.usedPercentage).toBeCloseTo(0.0183, 4);
    expect(stats.totalTokens).toBe(150);
  });

  it('clamps the ratio to 1 when the usage exceeds the window', () => {
    const stats = contextStatsFromUsage(makeUsage(), 100);
    expect(stats.usedPercentage).toBe(1);
  });

  it('never returns a negative ratio', () => {
    const stats = contextStatsFromUsage(
      makeUsage({ promptTokens: -10, completionTokens: -20, totalTokens: -30 }),
      8192
    );
    expect(stats.usedPercentage).toBe(0);
  });

  it('produces the exact shape AiUsageIndicator consumes', () => {
    const stats = contextStatsFromUsage(makeUsage(), 8192);
    // `contextUsedRatio` of the chat UI is fed from
    // `aiRequest.contextStats.usedPercentage`, and `totalTokens` is part of
    // the type (Generation.js AiRequestContextStats).
    expect(Object.keys(stats).sort()).toEqual([
      'totalTokens',
      'usedPercentage',
    ]);
  });
});

describe('createByokUsageTracker', () => {
  it('starts at zero', () => {
    expect(createByokUsageTracker().getTotals()).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      turns: 0,
    });
  });

  it('accumulates the usage across turns', () => {
    const tracker = createByokUsageTracker();
    tracker.recordTurn(makeUsage());
    tracker.recordTurn(makeUsage({ promptTokens: 200, totalTokens: 250 }));
    tracker.recordTurn(makeUsage({ completionTokens: 70, totalTokens: 170 }));

    expect(tracker.getTotals()).toEqual({
      promptTokens: 400,
      completionTokens: 170,
      totalTokens: 570,
      turns: 3,
    });
  });
});
