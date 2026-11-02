// @flow
import { type AiRequestContextStats } from '../../Utils/GDevelopServices/Generation';
import { type ByokChatCompletionResponse, type ByokUsage } from './ByokTypes';

/**
 * Extract the token usage of a chat-completions response, in the normalized
 * shape used by the BYOK modules. Returns null when the server omitted the
 * `usage` field (some proxies do): the caller then simply has no numbers to
 * display, instead of displaying zeros.
 */
export const usageFromResponse = (
  response: ByokChatCompletionResponse
): ?ByokUsage => {
  const usage = response.usage;
  if (!usage || typeof usage !== 'object') return null;
  if (typeof usage.prompt_tokens !== 'number') return null;
  if (typeof usage.completion_tokens !== 'number') return null;
  if (typeof usage.total_tokens !== 'number') return null;

  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
};

/**
 * Convert the usage of the latest call into the `AiRequestContextStats`
 * shape the existing chat UI consumes ("Chat context" bar). The next prompt
 * re-sends the whole conversation history, so the context used *now* is the
 * `promptTokens + completionTokens` of the latest call: this is the one
 * non-obvious line of the module. The ratio is clamped to [0, 1]: a model
 * can exceed its nominal window before erroring, and the UI bar expects a
 * ratio it can render.
 */
export const contextStatsFromUsage = (
  usage: ByokUsage,
  contextWindowTokens: number
): AiRequestContextStats => {
  const usedTokens = usage.promptTokens + usage.completionTokens;
  const usedPercentage =
    contextWindowTokens > 0 ? usedTokens / contextWindowTokens : 0;

  return {
    totalTokens: usage.totalTokens,
    usedPercentage: Math.min(1, Math.max(0, usedPercentage)),
  };
};

export type ByokUsageTotals = {|
  promptTokens: number,
  completionTokens: number,
  totalTokens: number,
  turns: number,
|};

export type ByokUsageTracker = {|
  recordTurn: (usage: ByokUsage) => void,
  getTotals: () => ByokUsageTotals,
|};

/**
 * Accumulate the exact token usage of the turns of one chat, for the
 * optional exact-token row. A plain object with closure state — the BYOK
 * modules avoid classes.
 */
export const createByokUsageTracker = (): ByokUsageTracker => {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let turns = 0;

  return {
    recordTurn: (usage: ByokUsage) => {
      promptTokens += usage.promptTokens;
      completionTokens += usage.completionTokens;
      totalTokens += usage.totalTokens;
      turns += 1;
    },
    getTotals: (): ByokUsageTotals => ({
      promptTokens,
      completionTokens,
      totalTokens,
      turns,
    }),
  };
};
