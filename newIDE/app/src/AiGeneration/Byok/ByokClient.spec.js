// @flow
import axios from 'axios';
import {
  buildEndpointUrl,
  createByokCancellation,
  fetchRawByokModels,
  sendByokChatCompletion,
  sendByokChatCompletionWithRetries,
} from './ByokClient';
import { type ByokChatCompletionOptions } from './ByokTypes';

jest.mock('axios');

// The automocked axios, untyped: jest replaces get/post with mock functions,
// and Flow refuses to unbind the real (typed) methods to wrap them.
const mockAxios = (axios: any);

const API_KEY = 'sk-test-key-1234567890';
const BASE_URL = 'https://api.example.com/v1';
const CONNECTION = { baseUrl: BASE_URL, apiKey: API_KEY };

// A synthetic axios-shaped rejection, like axios produces for an HTTP error.
const makeResponseError = (
  status: number,
  data?: any,
  headers?: Object
): Object => ({
  response: {
    status,
    data: data === undefined ? {} : data,
    headers: headers || {},
  },
  request: {},
});

// A synthetic axios-shaped rejection for a request that got no response.
const makeRequestError = (code?: string | null): Object => ({
  response: null,
  request: {},
  code: code === undefined ? null : code,
});

// The axios response of a /models call: the JSON body is the OpenAI "list"
// envelope, `{ data: [...] }`.
const makeModelListResponse = (entries: any): Object => ({
  data: { data: entries },
});

const makeChatResponse = (overrides?: Object): Object => ({
  choices: [
    {
      message: { role: 'assistant', content: 'Hello!' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  ...overrides,
});

const makeChatOptions = (
  overrides?: Partial<ByokChatCompletionOptions>
): ByokChatCompletionOptions => ({
  model: 'my-model',
  messages: [{ role: 'user', content: 'Hi' }],
  ...overrides,
});

describe('buildEndpointUrl', () => {
  it('appends the path to the base URL', () => {
    expect(buildEndpointUrl('https://host/v1', '/models')).toBe(
      'https://host/v1/models'
    );
  });

  it('trims a trailing slash from the base URL', () => {
    expect(buildEndpointUrl('https://host/v1/', '/models')).toBe(
      'https://host/v1/models'
    );
    expect(buildEndpointUrl('https://host/v1//', '/chat/completions')).toBe(
      'https://host/v1/chat/completions'
    );
  });

  it('trims whitespace around the base URL (pasted URLs carry some)', () => {
    expect(buildEndpointUrl('  https://host/v1/ ', '/models')).toBe(
      'https://host/v1/models'
    );
    expect(buildEndpointUrl('https://host/v1/\n', '/models')).toBe(
      'https://host/v1/models'
    );
  });

  it('keeps the /v1 segment of the base URL as-is', () => {
    // The base URL already includes /v1 if the provider uses it: it must
    // not be added or removed by the client.
    expect(buildEndpointUrl('http://localhost:1234/v1', '/models')).toBe(
      'http://localhost:1234/v1/models'
    );
    expect(buildEndpointUrl('https://host', '/models')).toBe(
      'https://host/models'
    );
  });
});

describe('fetchRawByokModels', () => {
  beforeEach(() => {
    mockAxios.get.mockReset();
  });

  it('gets {baseUrl}/models with the key in the Authorization header only', async () => {
    mockAxios.get.mockResolvedValueOnce(
      makeModelListResponse([{ id: 'model-a' }, { id: 'model-b' }])
    );

    await fetchRawByokModels(CONNECTION);

    expect(mockAxios.get).toHaveBeenCalledTimes(1);
    const [url, config] = mockAxios.get.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/models');
    expect(config.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    // The URL and the (absent) body never contain the key: it travels in
    // the Authorization header only.
    expect(url).not.toContain(API_KEY);
  });

  it('throws a ByokError when the response is not a model list', async () => {
    mockAxios.get.mockResolvedValueOnce(makeModelListResponse({ nope: 1 }));

    let thrownError: any = null;
    try {
      await fetchRawByokModels(CONNECTION);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).not.toBe(null);
    expect(thrownError.kind).toBe('unknown');
    expect(thrownError.message).toContain('did not return a model list');
  });

  it('accepts a bare array as the response body (non-standard servers)', async () => {
    mockAxios.get.mockResolvedValueOnce({ data: [{ id: 'model-a' }] });

    const rawModels = await fetchRawByokModels(CONNECTION);

    expect(rawModels).toEqual([{ id: 'model-a' }]);
  });

  it('throws an authentication error on a 401, without leaking the key', async () => {
    mockAxios.get.mockRejectedValueOnce(
      makeResponseError(401, { error: { message: 'Invalid API key' } })
    );

    let thrownError: any = null;
    try {
      await fetchRawByokModels(CONNECTION);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError.kind).toBe('authentication');
    expect(thrownError.status).toBe(401);
    expect(thrownError.message).toBe('Invalid API key');
    expect(thrownError.message).not.toContain(API_KEY);
  });
});

describe('sendByokChatCompletion', () => {
  beforeEach(() => {
    mockAxios.post.mockReset();
    // The automocked axios returns undefined from CancelToken.source (and
    // the jest preset resets implementations before each test anyway).
    mockAxios.CancelToken.source.mockImplementation(() => ({
      token: { __fakeCancelToken: true },
      cancel: (jest.fn(): any),
    }));
  });

  it('posts to {baseUrl}/chat/completions with the key in the Authorization header only', async () => {
    mockAxios.post.mockResolvedValueOnce({ data: makeChatResponse() });

    await sendByokChatCompletion({
      ...CONNECTION,
      options: makeChatOptions(),
    });

    expect(mockAxios.post).toHaveBeenCalledTimes(1);
    const [url, body, config] = mockAxios.post.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(body).toEqual({
      model: 'my-model',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(config.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    // The URL and the body never contain the key: it travels in the
    // Authorization header only.
    expect(url).not.toContain(API_KEY);
    expect(JSON.stringify(body)).not.toContain(API_KEY);
  });

  it('includes reasoning_effort in the body only when it is set', async () => {
    mockAxios.post.mockResolvedValueOnce({ data: makeChatResponse() });
    await sendByokChatCompletion({
      ...CONNECTION,
      options: makeChatOptions({ reasoningEffort: 'high' }),
    });
    expect(mockAxios.post.mock.calls[0][1].reasoning_effort).toBe('high');

    mockAxios.post.mockResolvedValueOnce({ data: makeChatResponse() });
    await sendByokChatCompletion({
      ...CONNECTION,
      options: makeChatOptions(),
    });
    expect(mockAxios.post.mock.calls[1][1].reasoning_effort).toBeUndefined();
  });

  it('includes the tools when provided, and not otherwise', async () => {
    const tools = [{ type: 'function', function: { name: 'create_scene' } }];
    mockAxios.post.mockResolvedValueOnce({ data: makeChatResponse() });
    await sendByokChatCompletion({
      ...CONNECTION,
      options: makeChatOptions({ tools }),
    });
    expect(mockAxios.post.mock.calls[0][1].tools).toEqual(tools);

    mockAxios.post.mockResolvedValueOnce({ data: makeChatResponse() });
    await sendByokChatCompletion({
      ...CONNECTION,
      options: makeChatOptions(),
    });
    expect('tools' in mockAxios.post.mock.calls[1][1]).toBe(false);
  });

  it('uses a 120 seconds default timeout, overridable with timeoutMs', async () => {
    mockAxios.post.mockResolvedValueOnce({ data: makeChatResponse() });
    await sendByokChatCompletion({
      ...CONNECTION,
      options: makeChatOptions(),
    });
    expect(mockAxios.post.mock.calls[0][2].timeout).toBe(120000);

    mockAxios.post.mockResolvedValueOnce({ data: makeChatResponse() });
    await sendByokChatCompletion({
      ...CONNECTION,
      options: makeChatOptions({ timeoutMs: 5000 }),
    });
    expect(mockAxios.post.mock.calls[1][2].timeout).toBe(5000);
  });

  it('returns the response when it has at least one choice', async () => {
    const response = makeChatResponse();
    mockAxios.post.mockResolvedValueOnce({ data: response });

    const result = await sendByokChatCompletion({
      ...CONNECTION,
      options: makeChatOptions(),
    });

    expect(result).toEqual(response);
  });

  it('throws an unknown ByokError when the response has no choice', async () => {
    mockAxios.post.mockResolvedValueOnce({
      data: makeChatResponse({ choices: [] }),
    });

    let thrownError: any = null;
    try {
      await sendByokChatCompletion({
        ...CONNECTION,
        options: makeChatOptions(),
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError.kind).toBe('unknown');
    expect(thrownError.message).toContain('unexpected chat response');
  });

  it('throws an unknown ByokError when the choice has no message', async () => {
    mockAxios.post.mockResolvedValueOnce({
      data: { choices: [{}] },
    });

    let thrownError: any = null;
    try {
      await sendByokChatCompletion({
        ...CONNECTION,
        options: makeChatOptions(),
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError.kind).toBe('unknown');
    expect(thrownError.message).toContain('without a message');
  });

  it('throws an unknown ByokError when a tool call is malformed', async () => {
    mockAxios.post.mockResolvedValueOnce({
      data: makeChatResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ function: { name: 'create_scene' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    });

    let thrownError: any = null;
    try {
      await sendByokChatCompletion({
        ...CONNECTION,
        options: makeChatOptions(),
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError.kind).toBe('unknown');
    expect(thrownError.message).toContain('without an id');
  });

  it('passes the cancellation token with the request', async () => {
    mockAxios.post.mockResolvedValueOnce({ data: makeChatResponse() });
    const cancellation = createByokCancellation();

    await sendByokChatCompletion({
      ...CONNECTION,
      options: makeChatOptions({ cancellation }),
    });

    expect(mockAxios.post.mock.calls[0][2].cancelToken).toBe(
      cancellation.token
    );
  });

  it('classifies a cancelled request as cancelled, never retried', async () => {
    const cancellation = createByokCancellation();
    cancellation.cancel();
    mockAxios.post.mockRejectedValueOnce({
      __CANCEL__: true,
      message: 'The request was cancelled by the user.',
    });

    let thrownError: any = null;
    try {
      await sendByokChatCompletionWithRetries({
        ...CONNECTION,
        options: makeChatOptions({ cancellation }),
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError.kind).toBe('cancelled');
    expect(mockAxios.post).toHaveBeenCalledTimes(1);
  });

  it('throws an unknown ByokError when the response is not an object', async () => {
    mockAxios.post.mockResolvedValueOnce({ data: 'not an object' });

    let thrownError: any = null;
    try {
      await sendByokChatCompletion({
        ...CONNECTION,
        options: makeChatOptions(),
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError.kind).toBe('unknown');
  });

  it('classifies a 429 response as rate-limit', async () => {
    mockAxios.post.mockRejectedValueOnce(
      makeResponseError(429, { error: { message: 'Too many requests' } })
    );

    let thrownError: any = null;
    try {
      await sendByokChatCompletion({
        ...CONNECTION,
        options: makeChatOptions(),
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError.kind).toBe('rate-limit');
    expect(thrownError.status).toBe(429);
  });

  it('classifies a request that never got a response as network', async () => {
    mockAxios.post.mockRejectedValueOnce(makeRequestError());

    let thrownError: any = null;
    try {
      await sendByokChatCompletion({
        ...CONNECTION,
        options: makeChatOptions(),
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError.kind).toBe('network');
  });

  it('never includes the API key in a thrown message, even if the server echoes it', async () => {
    mockAxios.post.mockRejectedValueOnce(
      makeResponseError(401, {
        error: { message: `The key ${API_KEY} is invalid.` },
      })
    );

    let thrownError: any = null;
    try {
      await sendByokChatCompletion({
        ...CONNECTION,
        options: makeChatOptions(),
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError.message).not.toContain(API_KEY);
    expect(thrownError.message).toContain('[redacted]');
  });
});

describe('sendByokChatCompletionWithRetries', () => {
  beforeEach(() => {
    mockAxios.post.mockReset();
  });

  it('retries a 500 and succeeds on the second attempt', async () => {
    mockAxios.post
      .mockRejectedValueOnce(
        makeResponseError(500, { error: { message: 'Overloaded' } })
      )
      .mockResolvedValueOnce({ data: makeChatResponse() });

    const result = await sendByokChatCompletionWithRetries({
      ...CONNECTION,
      options: makeChatOptions(),
    });

    expect(result).toEqual(makeChatResponse());
    expect(mockAxios.post).toHaveBeenCalledTimes(2);
  });

  it('fails with the original error after the retries are exhausted', async () => {
    const serverError = makeResponseError(500, {
      error: { message: 'Overloaded' },
    });
    mockAxios.post
      .mockRejectedValueOnce(serverError)
      .mockRejectedValueOnce(serverError)
      .mockRejectedValueOnce(serverError);

    let thrownError: any = null;
    try {
      await sendByokChatCompletionWithRetries({
        ...CONNECTION,
        options: makeChatOptions(),
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError.kind).toBe('server');
    expect(thrownError.message).toBe('Overloaded');
    // The first attempt + 2 retries.
    expect(mockAxios.post).toHaveBeenCalledTimes(3);
  });

  it('does not retry an authentication error', async () => {
    mockAxios.post.mockRejectedValueOnce(makeResponseError(401));

    let thrownError: any = null;
    try {
      await sendByokChatCompletionWithRetries({
        ...CONNECTION,
        options: makeChatOptions(),
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError.kind).toBe('authentication');
    expect(mockAxios.post).toHaveBeenCalledTimes(1);
  });

  it('does not retry a rate limit whose Retry-After exceeds the backoff budget', async () => {
    mockAxios.post.mockRejectedValueOnce(
      makeResponseError(
        429,
        { error: { message: 'Too many requests' } },
        { 'retry-after': '60' }
      )
    );

    let thrownError: any = null;
    try {
      await sendByokChatCompletionWithRetries({
        ...CONNECTION,
        options: makeChatOptions(),
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError.kind).toBe('rate-limit');
    expect(thrownError.retryAfterMs).toBe(60000);
    // Hammering the endpoint with an early retry would only extend the
    // limit: the error is surfaced instead.
    expect(mockAxios.post).toHaveBeenCalledTimes(1);
  });

  it('retries a rate limit with a short (or absent) Retry-After', async () => {
    mockAxios.post
      .mockRejectedValueOnce(
        makeResponseError(
          429,
          { error: { message: 'Slow down' } },
          { 'retry-after': '0' }
        )
      )
      .mockResolvedValueOnce({ data: makeChatResponse() });

    const result = await sendByokChatCompletionWithRetries({
      ...CONNECTION,
      options: makeChatOptions(),
    });

    expect(result).toEqual(makeChatResponse());
    expect(mockAxios.post).toHaveBeenCalledTimes(2);
  });

  it('retries a timeout error', async () => {
    mockAxios.post
      .mockRejectedValueOnce(makeRequestError('ECONNABORTED'))
      .mockResolvedValueOnce({ data: makeChatResponse() });

    const result = await sendByokChatCompletionWithRetries({
      ...CONNECTION,
      options: makeChatOptions(),
    });

    expect(result).toEqual(makeChatResponse());
    expect(mockAxios.post).toHaveBeenCalledTimes(2);
  });

  it('retries a network error with backoff', async () => {
    mockAxios.post
      .mockRejectedValueOnce(makeRequestError(null))
      .mockRejectedValueOnce(makeRequestError(null))
      .mockRejectedValueOnce(makeRequestError(null));

    let thrownError: any = null;
    try {
      await sendByokChatCompletionWithRetries({
        ...CONNECTION,
        options: makeChatOptions(),
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError.kind).toBe('network');
    // The first attempt + 2 retries.
    expect(mockAxios.post).toHaveBeenCalledTimes(3);
  });

  it('retries once without reasoning_effort when the rejection names it', async () => {
    mockAxios.post
      .mockRejectedValueOnce(
        makeResponseError(400, {
          error: {
            message: "Unknown parameter: 'reasoning_effort' is not supported.",
          },
        })
      )
      .mockResolvedValueOnce({ data: makeChatResponse() });

    const result = await sendByokChatCompletionWithRetries({
      ...CONNECTION,
      options: makeChatOptions({ reasoningEffort: 'high' }),
    });

    expect(result).toEqual(makeChatResponse());
    expect(mockAxios.post).toHaveBeenCalledTimes(2);
    expect(mockAxios.post.mock.calls[0][1].reasoning_effort).toBe('high');
    expect('reasoning_effort' in mockAxios.post.mock.calls[1][1]).toBe(false);
  });

  it('does not strip reasoning_effort for a 400 about something else', async () => {
    mockAxios.post.mockRejectedValueOnce(
      makeResponseError(400, {
        error: { message: "Model 'nope' does not exist." },
      })
    );

    let thrownError: any = null;
    try {
      await sendByokChatCompletionWithRetries({
        ...CONNECTION,
        options: makeChatOptions({ reasoningEffort: 'high' }),
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError.kind).toBe('invalid-request');
    expect(mockAxios.post).toHaveBeenCalledTimes(1);
  });

  it('does not retry the reasoning-effort degradation when no effort was set', async () => {
    // A server rejecting reasoning_effort cannot happen when none was sent,
    // but the guard must not degrade an already-parameter-free request.
    mockAxios.post.mockRejectedValueOnce(
      makeResponseError(400, {
        error: { message: 'reasoning_effort is not supported.' },
      })
    );

    let thrownError: any = null;
    try {
      await sendByokChatCompletionWithRetries({
        ...CONNECTION,
        options: makeChatOptions(),
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError.kind).toBe('invalid-request');
    expect(mockAxios.post).toHaveBeenCalledTimes(1);
  });

  // ---- Phase 9.7: retry and robustness polish ----

  describe('Phase 9: Retry-After honoring', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('honors a Retry-After within the 30s cap: waits exactly that, once', async () => {
      mockAxios.post
        .mockRejectedValueOnce(
          makeResponseError(
            429,
            { error: { message: 'Slow down' } },
            { 'retry-after': '2' }
          )
        )
        .mockResolvedValueOnce({ data: makeChatResponse() });

      const onRateLimitWait = (jest.fn(): any);
      const runPromise = sendByokChatCompletionWithRetries({
        ...CONNECTION,
        options: makeChatOptions(),
        onRateLimitWait,
      });
      // Not retried before the requested delay elapsed: the backoff timer
      // is scheduled (the callback fired) but nothing else happens.
      for (let index = 0; index < 5; index++) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
      expect(onRateLimitWait).toHaveBeenCalledWith(2000);
      expect(mockAxios.post).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(1999);
      expect(mockAxios.post).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(1);
      for (let index = 0; index < 10; index++) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
      const result = await runPromise;

      expect(result).toEqual(makeChatResponse());
      expect(mockAxios.post).toHaveBeenCalledTimes(2);
    });

    it('surfaces a rate limit asking for more than the 30s cap', async () => {
      mockAxios.post.mockRejectedValueOnce(
        makeResponseError(
          429,
          { error: { message: 'Too many requests' } },
          { 'retry-after': '60' }
        )
      );

      let thrownError: any = null;
      try {
        await sendByokChatCompletionWithRetries({
          ...CONNECTION,
          options: makeChatOptions(),
        });
      } catch (error) {
        thrownError = error;
      }
      expect(thrownError.kind).toBe('rate-limit');
      expect(thrownError.retryAfterMs).toBe(60000);
      expect(mockAxios.post).toHaveBeenCalledTimes(1);
    });
  });

  describe('Phase 9: the degraded reasoning_effort callback', () => {
    it('fires the moment the strip-retry engages', async () => {
      mockAxios.post
        .mockRejectedValueOnce(
          makeResponseError(400, {
            error: {
              message:
                "Unknown parameter: 'reasoning_effort' is not supported.",
            },
          })
        )
        .mockResolvedValueOnce({ data: makeChatResponse() });

      const onReasoningEffortDegraded = (jest.fn(): any);
      await sendByokChatCompletionWithRetries({
        ...CONNECTION,
        options: makeChatOptions({ reasoningEffort: 'high' }),
        onReasoningEffortDegraded,
      });

      expect(onReasoningEffortDegraded).toHaveBeenCalledTimes(1);
    });
  });

  describe('Phase 9: the new request body fields', () => {
    it('omits the optional profile fields when unset', async () => {
      mockAxios.post.mockResolvedValueOnce({ data: makeChatResponse() });
      await sendByokChatCompletion({
        ...CONNECTION,
        options: makeChatOptions(),
      });
      const body = mockAxios.post.mock.calls[0][1];
      expect('temperature' in body).toBe(false);
      expect('max_tokens' in body).toBe(false);
      expect('tool_choice' in body).toBe(false);
      expect('parallel_tool_calls' in body).toBe(false);
    });

    it('sends the profile fields when set', async () => {
      mockAxios.post.mockResolvedValueOnce({ data: makeChatResponse() });
      await sendByokChatCompletion({
        ...CONNECTION,
        options: makeChatOptions({
          temperature: 0.3,
          maxTokens: 512,
          parallelToolCalls: false,
        }),
      });
      const body = mockAxios.post.mock.calls[0][1];
      expect(body.temperature).toBe(0.3);
      expect(body.max_tokens).toBe(512);
      expect(body.parallel_tool_calls).toBe(false);
    });

    it('keeps the advanced fields on the degraded (stripped) retry', async () => {
      mockAxios.post
        .mockRejectedValueOnce(
          makeResponseError(400, {
            error: {
              message:
                "Unknown parameter: 'reasoning_effort' is not supported.",
            },
          })
        )
        .mockResolvedValueOnce({ data: makeChatResponse() });

      await sendByokChatCompletionWithRetries({
        ...CONNECTION,
        options: makeChatOptions({
          reasoningEffort: 'high',
          temperature: 0.3,
          maxTokens: 512,
          parallelToolCalls: false,
        }),
      });

      const retryBody = mockAxios.post.mock.calls[1][1];
      expect('reasoning_effort' in retryBody).toBe(false);
      expect(retryBody.temperature).toBe(0.3);
      expect(retryBody.max_tokens).toBe(512);
      expect(retryBody.parallel_tool_calls).toBe(false);
    });
  });
});
