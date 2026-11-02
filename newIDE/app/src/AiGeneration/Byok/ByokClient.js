// @flow
import axios from 'axios';
import { retryIfFailed } from '../../Utils/RetryIfFailed';
import {
  classifyByokError,
  makeByokError,
  redactSecretFromByokError,
  isInvalidRequestForReasoningEffort,
  isRetryableByokError,
  type ByokError,
} from './ByokErrors';
import {
  type ByokCancellation,
  type ByokChatCompletionOptions,
  type ByokChatCompletionResponse,
  type ByokConnection,
} from './ByokTypes';

// Tool-heavy turns can legitimately take a while: the default timeout of a
// chat-completions call is generous on purpose.
const CHAT_COMPLETION_DEFAULT_TIMEOUT_MS = 120000;
const MODELS_TIMEOUT_MS = 15000;

// Transient failures (server error, rate limit, network hiccup) are retried
// with a small backoff: 2 attempts after the first one, a single 800ms delay
// between them (see Utils/RetryIfFailed.js).
const RETRY_TIMES = 2;
const RETRY_BACKOFF_INITIAL_DELAY_MS = 800;
const RETRY_BACKOFF_FACTOR = 2;

// A rate limit's Retry-After is honored as the backoff delay, capped: an
// endpoint asking to wait longer than this is not waited on (the error is
// surfaced instead — hammering it would only extend the limit).
const RETRY_AFTER_MAX_MS = 30000;

const wait = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/**
 * The base URL of the user's endpoint is used as-is: it already includes
 * `/v1` when their provider uses it (https://api.openai.com/v1, most local
 * servers, etc.). Only surrounding whitespace and a trailing slash are
 * trimmed, so both `https://host/v1` and `https://host/v1/` (pasted with a
 * trailing newline or space) produce the same URLs. The settings tab explains
 * this in its helper text.
 */
export const buildEndpointUrl = (baseUrl: string, path: string): string => {
  const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
  return `${trimmedBaseUrl}${path}`;
};

/**
 * Create the cancellation handle of a chat: pass `token` with each request of
 * the conversation, call `cancel` (from `suspend`) to abort the in-flight
 * one. A cancelled request rejects with a `cancelled` ByokError (never
 * retried), so the user stops paying for tokens the moment they press Stop.
 */
export const createByokCancellation = (): ByokCancellation => {
  const source = axios.CancelToken.source();
  return {
    token: source.token,
    cancel: () => source.cancel('The request was cancelled by the user.'),
  };
};

/**
 * Build the errors thrown by the client: always classified, and always
 * stripped of the API key, so that no error can ever leak it (it travels in
 * headers only — this redaction is the safety net that keeps that promise).
 */
const makeThrownByokError = (rawError: any, apiKey: string): ByokError => {
  const byokError = classifyByokError(rawError);
  return redactSecretFromByokError(byokError, apiKey);
};

/**
 * The endpoint did not answer with a model list — the base URL is probably
 * not an OpenAI-compatible endpoint.
 */
const makeNoModelListError = (): ByokError => ({
  kind: 'unknown',
  message:
    'The endpoint did not return a model list — check the base URL in the BYOK settings.',
  status: null,
  retryAfterMs: null,
});

/**
 * Fetch the raw entries of the model list exposed by the endpoint
 * (GET /models), validated as a list. The entries themselves are untrusted
 * wire data (hence the `any` elements — the boundary of what the endpoint
 * sent); `normalizeByokModels` in `ByokModelsCache.js` is what converts them
 * to the typed `ByokModelInfo` shape.
 */
export const fetchRawByokModels = async ({
  baseUrl,
  apiKey,
}: ByokConnection): Promise<Array<any>> => {
  // The JSON body of a /models response is the OpenAI "list" envelope:
  // `{ data: [...] }`. A few servers return a bare array instead; accept
  // both, reject anything else. It is untrusted data: `mixed` until proven
  // to be one of the two accepted shapes.
  let body: mixed = null;
  try {
    // The API key is only sent in the Authorization header, never in the
    // URL, the body, or any error message or log.
    // Same suppression as the other services (Generation.js): the
    // flow-typed axios definition has an underconstrained generic on
    // get/post.
    // $FlowFixMe[underconstrained-implicit-instantiation]
    const response = await axios.get(buildEndpointUrl(baseUrl, '/models'), {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: MODELS_TIMEOUT_MS,
    });
    body = ((response ? response.data : null): mixed);
  } catch (error) {
    throw makeThrownByokError(error, apiKey);
  }

  if (Array.isArray(body)) {
    // `.slice()` turns the read-only array Flow refines to into the mutable
    // array the callers iterate on.
    return body.slice();
  }
  if (body && typeof body === 'object' && Array.isArray(body.data)) {
    return body.data.slice();
  }
  throw makeNoModelListError();
};

/**
 * Check that a chat-completions response has the shape everything downstream
 * (the transcript mapping, the tool dispatch) assumes: `choices[0].message`
 * is an object, and every tool call has the string `id` and `function.name`
 * the follow-up `tool` messages need. Returns null when valid, a reason
 * string otherwise.
 */
const findChatResponseShapeProblem = (data: mixed): ?string => {
  if (!data || typeof data !== 'object') {
    return 'The endpoint returned an unexpected chat response.';
  }
  const record: Object = data;
  if (!Array.isArray(record.choices) || record.choices.length === 0) {
    return 'The endpoint returned an unexpected chat response.';
  }

  const firstChoice: any = record.choices[0];
  const message = firstChoice ? firstChoice.message : null;
  if (!message || typeof message !== 'object') {
    return 'The endpoint returned a response without a message.';
  }
  // `content` must be a string (or absent): a gateway that returns it as an
  // ARRAY of content parts made every turn look like an empty answer, and
  // Retry replayed the same deterministic failure (audit100226 LOOP-4).
  if (
    message.content !== undefined &&
    message.content !== null &&
    typeof message.content !== 'string'
  ) {
    return 'The endpoint returned a message whose content is not text.';
  }
  if (message.tool_calls === undefined || message.tool_calls === null) {
    return null;
  }
  if (!Array.isArray(message.tool_calls)) {
    return 'The endpoint returned malformed tool calls.';
  }

  for (const toolCall of message.tool_calls) {
    if (!toolCall || typeof toolCall !== 'object') {
      return 'The endpoint returned malformed tool calls.';
    }
    if (typeof toolCall.id !== 'string' || !toolCall.id) {
      return 'The endpoint returned a tool call without an id.';
    }
    if (
      !toolCall.function ||
      typeof toolCall.function !== 'object' ||
      typeof toolCall.function.name !== 'string' ||
      !toolCall.function.name
    ) {
      return 'The endpoint returned a tool call without a function name.';
    }
    // `function.arguments` must be a STRING. When a server omitted it, the
    // call was recorded as undefined and replayed as a tool_call with no
    // arguments field — which strict endpoints reject with a 400 on the
    // whole transcript, and Retry replays the same one, so the chat was
    // bricked (audit100226 LOOP-4). An absent arguments is normalized to
    // '{}' instead: a no-argument call is a legitimate shape.
    if (
      toolCall.function.arguments !== undefined &&
      toolCall.function.arguments !== null &&
      typeof toolCall.function.arguments !== 'string'
    ) {
      return 'The endpoint returned a tool call whose arguments are not text.';
    }
    if (typeof toolCall.function.arguments !== 'string') {
      toolCall.function.arguments = '{}';
    }
  }
  return null;
};

/**
 * Send a chat-completions request (non-streaming) to the endpoint, with the
 * optional tool definitions and reasoning effort. Throws a ByokError when
 * anything goes wrong. Most consumers should prefer
 * `sendByokChatCompletionWithRetries`, which adds the retry policy on top.
 */
export const sendByokChatCompletion = async ({
  baseUrl,
  apiKey,
  options,
}: {|
  ...ByokConnection,
  options: ByokChatCompletionOptions,
|}): Promise<ByokChatCompletionResponse> => {
  const body: Object = {
    model: options.model,
    messages: options.messages,
  };
  if (options.tools) {
    body.tools = options.tools;
  }
  if (options.toolChoice) {
    body.tool_choice = options.toolChoice;
  }
  if (typeof options.parallelToolCalls === 'boolean') {
    body.parallel_tool_calls = options.parallelToolCalls;
  }
  if (typeof options.temperature === 'number') {
    body.temperature = options.temperature;
  }
  if (typeof options.maxTokens === 'number') {
    body.max_tokens = options.maxTokens;
  }
  // Only send `reasoning_effort` when the user asked for a specific effort:
  // many OpenAI-compatible servers reject unknown parameters.
  if (
    options.reasoningEffort === 'low' ||
    options.reasoningEffort === 'medium' ||
    options.reasoningEffort === 'high'
  ) {
    body.reasoning_effort = options.reasoningEffort;
  }

  let response;
  try {
    // The API key is only sent in the Authorization header, never in the
    // URL, the body, or any error message or log.
    // Same suppression as the other services (Generation.js): the flow-typed
    // axios definition has an underconstrained generic on get/post.
    // $FlowFixMe[underconstrained-implicit-instantiation]
    response = await axios.post(
      buildEndpointUrl(baseUrl, '/chat/completions'),
      body,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: options.timeoutMs || CHAT_COMPLETION_DEFAULT_TIMEOUT_MS,
        cancelToken: options.cancellation
          ? options.cancellation.token
          : undefined,
      }
    );
  } catch (error) {
    throw makeThrownByokError(error, apiKey);
  }

  const data = response ? response.data : null;
  const shapeProblem = findChatResponseShapeProblem(data);
  if (shapeProblem) {
    throw makeByokError('unknown', shapeProblem, null);
  }
  if (!data) {
    throw makeByokError(
      'unknown',
      'The endpoint returned an empty chat response.',
      null
    );
  }

  // Validated by findChatResponseShapeProblem above (untyped axios data).
  return (data: ByokChatCompletionResponse);
};

/**
 * The same request without the reasoning effort (and nothing else changed):
 * used for the one-shot degradation when an endpoint rejects the parameter.
 */
const stripReasoningEffort = (
  options: ByokChatCompletionOptions
): ByokChatCompletionOptions => {
  const degradedOptions: ByokChatCompletionOptions = {
    model: options.model,
    messages: options.messages,
  };
  if (options.tools) {
    degradedOptions.tools = options.tools;
  }
  if (options.toolChoice) {
    degradedOptions.toolChoice = options.toolChoice;
  }
  if (typeof options.parallelToolCalls === 'boolean') {
    degradedOptions.parallelToolCalls = options.parallelToolCalls;
  }
  if (typeof options.temperature === 'number') {
    degradedOptions.temperature = options.temperature;
  }
  if (typeof options.maxTokens === 'number') {
    degradedOptions.maxTokens = options.maxTokens;
  }
  if (options.timeoutMs) {
    degradedOptions.timeoutMs = options.timeoutMs;
  }
  if (options.cancellation) {
    degradedOptions.cancellation = options.cancellation;
  }
  return degradedOptions;
};

/**
 * Send a chat-completions request with the full retry policy:
 * - a rejection that names `reasoning_effort` is retried once without the
 *   parameter (the endpoint does not support it — degrade instead of fail);
 *   `onReasoningEffortDegraded` fires the moment that happens, so the caller
 *   can remember the outcome per model and never send the parameter again
 *   (Phase 9.7 — the per-turn 400-dance is over);
 * - a rate limit whose Retry-After fits our budget is honored: the request
 *   is retried once after exactly that wait, capped at 30s; a longer wait
 *   is surfaced instead of waited out;
 * - transient failures (server error, rate limit, network, timeout) are
 *   retried with a short backoff;
 * - everything else (authentication, invalid request, a cancelled request,
 *   …) fails right away, as retrying would fail again identically.
 *
 * The degradation and the backoff are mutually exclusive: a
 * `reasoning_effort` rejection is never retried again, and a transient
 * failure is never retried without the parameter.
 */
export const sendByokChatCompletionWithRetries = async ({
  baseUrl,
  apiKey,
  options,
  onReasoningEffortDegraded,
  onRateLimitWait,
}: {|
  ...ByokConnection,
  options: ByokChatCompletionOptions,
  onReasoningEffortDegraded?: () => void,
  onRateLimitWait?: (waitMs: number) => void,
|}): Promise<ByokChatCompletionResponse> => {
  try {
    return await sendByokChatCompletion({ baseUrl, apiKey, options });
  } catch (rawError) {
    const error = makeThrownByokError(rawError, apiKey);

    if (isInvalidRequestForReasoningEffort(error) && options.reasoningEffort) {
      // Retry once without the reasoning effort: the endpoint does not
      // support the parameter. Tell the caller first, so the degraded state
      // is remembered even if the retry fails for another reason.
      if (onReasoningEffortDegraded) onReasoningEffortDegraded();
      return await sendByokChatCompletion({
        baseUrl,
        apiKey,
        options: stripReasoningEffort(options),
      });
    }

    const retryAfterMs = error.retryAfterMs;
    if (
      error.kind === 'rate-limit' &&
      typeof retryAfterMs === 'number' &&
      retryAfterMs > 0 &&
      retryAfterMs <= RETRY_AFTER_MAX_MS
    ) {
      // The endpoint told us how long to wait, and the wait is bearable:
      // honor it exactly, with a single retry.
      if (onRateLimitWait) onRateLimitWait(retryAfterMs);
      await wait(retryAfterMs);
      return await sendByokChatCompletion({ baseUrl, apiKey, options });
    }

    if (
      error.kind === 'rate-limit' &&
      typeof retryAfterMs === 'number' &&
      retryAfterMs > RETRY_AFTER_MAX_MS
    ) {
      // The endpoint explicitly asked for a longer wait than we honor:
      // surface the error instead of retrying into the rate limit.
      throw error;
    }

    if (!isRetryableByokError(error)) {
      throw error;
    }

    return await retryIfFailed(
      {
        times: RETRY_TIMES,
        backoff: {
          initialDelay: RETRY_BACKOFF_INITIAL_DELAY_MS,
          factor: RETRY_BACKOFF_FACTOR,
        },
      },
      () => sendByokChatCompletion({ baseUrl, apiKey, options })
    );
  }
};
