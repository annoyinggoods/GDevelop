// @flow
import {
  classifyByokError,
  describeInvalidRequestForImageContent,
  isInvalidRequestForReasoningEffort,
  isRetryableByokError,
  makeByokError,
  redactSecretFromByokError,
  redactSecretFromMessage,
  type ByokError,
  type ByokErrorKind,
} from './ByokErrors';

// A synthetic axios-shaped error, like the ones axios rejects with.
const makeAxiosError = (overrides?: Object): Object => ({
  isAxiosError: true,
  response: null,
  request: {},
  code: null,
  ...overrides,
});

const makeAxiosResponseError = (status: number, data?: any): Object =>
  makeAxiosError({
    response: { status, data: data === undefined ? {} : data },
  });

describe('classifyByokError', () => {
  it('classifies a 401 response as authentication', () => {
    const error = classifyByokError(makeAxiosResponseError(401));
    expect(error.kind).toBe('authentication');
    expect(error.status).toBe(401);
  });

  it('classifies a 403 response as forbidden', () => {
    const error = classifyByokError(makeAxiosResponseError(403));
    expect(error.kind).toBe('forbidden');
    expect(error.status).toBe(403);
  });

  it('classifies a 404 response as not-found', () => {
    const error = classifyByokError(makeAxiosResponseError(404));
    expect(error.kind).toBe('not-found');
    expect(error.status).toBe(404);
  });

  it('classifies a 429 response as rate-limit', () => {
    const error = classifyByokError(makeAxiosResponseError(429));
    expect(error.kind).toBe('rate-limit');
    expect(error.status).toBe(429);
  });

  it('classifies a 400 response as invalid-request', () => {
    const error = classifyByokError(makeAxiosResponseError(400));
    expect(error.kind).toBe('invalid-request');
    expect(error.status).toBe(400);
  });

  it('classifies a 500 response as server', () => {
    const error = classifyByokError(makeAxiosResponseError(500));
    expect(error.kind).toBe('server');
    expect(error.status).toBe(500);
  });

  it('classifies a 503 response as server', () => {
    const error = classifyByokError(makeAxiosResponseError(503));
    expect(error.kind).toBe('server');
    expect(error.status).toBe(503);
  });

  it('classifies an unexpected status (302) as unknown', () => {
    const error = classifyByokError(makeAxiosResponseError(302));
    expect(error.kind).toBe('unknown');
    expect(error.status).toBe(302);
  });

  it('classifies an axios error without a response as network', () => {
    const error = classifyByokError(makeAxiosError());
    expect(error.kind).toBe('network');
    expect(error.status).toBe(null);
  });

  it('classifies an aborted request (ECONNABORTED) as timeout', () => {
    const error = classifyByokError(
      makeAxiosError({
        code: 'ECONNABORTED',
        message: 'timeout of 100ms exceeded',
      })
    );
    expect(error.kind).toBe('timeout');
    expect(error.status).toBe(null);
  });

  it('classifies anything else (a string, no request at all) as unknown', () => {
    expect(classifyByokError('boom').kind).toBe('unknown');
    expect(classifyByokError(null).kind).toBe('unknown');
    expect(classifyByokError(undefined).kind).toBe('unknown');
    expect(classifyByokError(new Error('boom')).kind).toBe('unknown');
  });

  it('keeps the original message as a detail for a local (non-endpoint) failure', () => {
    const error = classifyByokError(new Error('boom'));
    expect(error.kind).toBe('unknown');
    expect(error.message).toContain('unexpected error');
    expect(error.message).toContain('(boom)');
  });

  it('classifies a cancelled request (axios Cancel) as cancelled', () => {
    const error = classifyByokError({
      __CANCEL__: true,
      message: 'The request was cancelled by the user.',
    });
    expect(error.kind).toBe('cancelled');
    expect(error.status).toBe(null);
    expect(isRetryableByokError(error)).toBe(false);
  });

  it('reads the Retry-After delay (seconds) of a 429 response', () => {
    const error = classifyByokError(
      makeAxiosError({
        response: {
          status: 429,
          data: { error: { message: 'Too many requests' } },
          headers: { 'retry-after': '30' },
        },
      })
    );
    expect(error.kind).toBe('rate-limit');
    expect(error.retryAfterMs).toBe(30000);
  });

  it('reads the Retry-After delay (HTTP-date) of a 429 response', () => {
    const twoMinutesFromNow = new Date(Date.now() + 120000).toUTCString();
    const error = classifyByokError(
      makeAxiosError({
        response: {
          status: 429,
          data: {},
          headers: { 'retry-after': twoMinutesFromNow },
        },
      })
    );
    expect(error.retryAfterMs).toBeGreaterThanOrEqual(110000);
    expect(error.retryAfterMs).toBeLessThanOrEqual(120000);
  });

  it('reports a null Retry-After when the header is absent or garbage', () => {
    expect(
      classifyByokError(
        makeAxiosError({
          response: { status: 429, data: {}, headers: {} },
        })
      ).retryAfterMs
    ).toBe(null);
    expect(
      classifyByokError(
        makeAxiosError({
          response: {
            status: 429,
            data: {},
            headers: { 'retry-after': 'soon' },
          },
        })
      ).retryAfterMs
    ).toBe(null);
  });

  it('uses the message of the OpenAI-style error body when present', () => {
    const error = classifyByokError(
      makeAxiosResponseError(401, {
        error: {
          message: 'Incorrect API key provided.',
          type: 'invalid_request_error',
        },
      })
    );
    expect(error.kind).toBe('authentication');
    expect(error.message).toBe('Incorrect API key provided.');
  });

  it('uses a top-level message in the body when there is no error object', () => {
    const error = classifyByokError(
      makeAxiosResponseError(400, { message: 'Model not found.' })
    );
    expect(error.message).toBe('Model not found.');
  });

  it('falls back to a human-readable sentence per kind when the body has no message', () => {
    const error = classifyByokError(makeAxiosResponseError(401, {}));
    expect(error.kind).toBe('authentication');
    expect(error.message).toContain('API key');
  });

  it('keeps an already-classified ByokError unchanged', () => {
    const byokError = makeByokError('rate-limit', 'Slow down!', 429);
    expect(classifyByokError(byokError)).toEqual(byokError);
  });
});

describe('isRetryableByokError', () => {
  const cases: Array<[ByokErrorKind, boolean]> = [
    ['authentication', false],
    ['forbidden', false],
    ['not-found', false],
    ['rate-limit', true],
    ['invalid-request', false],
    ['server', true],
    ['network', true],
    ['timeout', true],
    ['cancelled', false],
    ['unknown', false],
  ];

  for (const [kind, expected] of cases) {
    it(`returns ${String(expected)} for ${kind}`, () => {
      expect(isRetryableByokError(makeByokError(kind, 'message', null))).toBe(
        expected
      );
    });
  }
});

describe('isInvalidRequestForReasoningEffort', () => {
  it('is true for an invalid-request mentioning reasoning_effort', () => {
    const error = classifyByokError(
      makeAxiosResponseError(400, {
        error: {
          message:
            'Unknown parameter: reasoning_effort is not supported by this model.',
        },
      })
    );
    expect(isInvalidRequestForReasoningEffort(error)).toBe(true);
  });

  it('is true for a 422 naming reasoning_effort (classified as invalid-request)', () => {
    const error = classifyByokError(
      makeAxiosResponseError(422, {
        error: {
          message:
            'Request failed: reasoning_effort is not an accepted parameter.',
        },
      })
    );
    expect(error.kind).toBe('invalid-request');
    expect(error.status).toBe(422);
    expect(isInvalidRequestForReasoningEffort(error)).toBe(true);
  });

  it('matches reasoning_effort regardless of case', () => {
    const error = classifyByokError(
      makeAxiosResponseError(400, {
        error: { message: 'REASONING_EFFORT is not a valid parameter.' },
      })
    );
    expect(isInvalidRequestForReasoningEffort(error)).toBe(true);
  });

  it('is false for an invalid-request about something else', () => {
    const error = classifyByokError(
      makeAxiosResponseError(400, {
        error: { message: "Model 'nope' does not exist." },
      })
    );
    expect(isInvalidRequestForReasoningEffort(error)).toBe(false);
  });

  it('is false for another kind even when the message mentions reasoning_effort', () => {
    const error = classifyByokError(
      makeAxiosResponseError(500, {
        error: { message: 'Internal error while applying reasoning_effort.' },
      })
    );
    expect(isInvalidRequestForReasoningEffort(error)).toBe(false);
  });
});

describe('redactSecretFromMessage', () => {
  it('replaces every occurrence of the secret', () => {
    expect(
      redactSecretFromMessage('key sk-abc and sk-abc again', 'sk-abc')
    ).toBe('key [redacted] and [redacted] again');
  });

  it('leaves the message alone when the secret is empty', () => {
    expect(redactSecretFromMessage('normal message', '')).toBe(
      'normal message'
    );
  });
});

describe('redactSecretFromByokError', () => {
  it('redacts the secret from the message and keeps the rest', () => {
    const error: ByokError = makeByokError(
      'network',
      'failed to call sk-secret-endpoint',
      null
    );
    expect(redactSecretFromByokError(error, 'sk-secret-endpoint')).toEqual({
      kind: 'network',
      message: 'failed to call [redacted]',
      status: null,
      retryAfterMs: null,
    });
  });
});

describe('describeInvalidRequestForImageContent', () => {
  const makeInvalidRequestError = (message: string) =>
    makeByokError('invalid-request', message, 400);

  it('detects the rejections naming images', () => {
    expect(
      describeInvalidRequestForImageContent(
        makeInvalidRequestError('This model does not support image content.')
      )
    ).toBe(true);
    expect(
      describeInvalidRequestForImageContent(
        makeInvalidRequestError('Invalid content type: image_url.')
      )
    ).toBe(true);
    expect(
      describeInvalidRequestForImageContent(
        makeInvalidRequestError('This endpoint is not multimodal.')
      )
    ).toBe(true);
    expect(
      describeInvalidRequestForImageContent(
        makeInvalidRequestError('Vision input is not enabled for this model.')
      )
    ).toBe(true);
  });

  it('ignores other invalid requests and other kinds', () => {
    expect(
      describeInvalidRequestForImageContent(
        makeInvalidRequestError('Unknown parameter: reasoning_effort')
      )
    ).toBe(false);
    expect(
      describeInvalidRequestForImageContent(
        makeByokError('authentication', 'Bad image key', 401)
      )
    ).toBe(false);
  });
});
