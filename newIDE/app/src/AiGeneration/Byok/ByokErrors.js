// @flow

/**
 * The kinds of failures a BYOK endpoint (or the network in between) can
 * produce. The kind drives what the app does next: whether to retry (see
 * `isRetryableByokError`), what to tell the user, and how to degrade
 * gracefully (see `isInvalidRequestForReasoningEffort`).
 */
export type ByokErrorKind =
  | 'authentication' // 401 / invalid key
  | 'forbidden' // 403
  | 'not-found' // 404 — a wrong base URL is the usual cause
  | 'rate-limit' // 429
  | 'invalid-request' // 400 — e.g. an unknown parameter
  | 'server' // 5xx
  | 'network' // the request never got a response
  | 'timeout'
  | 'cancelled' // aborted locally (e.g. the user pressed Stop)
  | 'unknown';

/**
 * Every failure surfaced by the BYOK modules, ready to be shown to the user
 * as-is. Note that the API key must never end up in `message` — see
 * `redactSecretFromMessage`. `retryAfterMs` carries the endpoint's
 * `Retry-After` hint (when it sent one) so the retry policy can respect it.
 */
export type ByokError = {|
  kind: ByokErrorKind,
  message: string,
  status: ?number,
  retryAfterMs: ?number,
|};

export const makeByokError = (
  kind: ByokErrorKind,
  message: string,
  status: ?number,
  retryAfterMs: ?number = null
): ByokError => ({
  kind,
  message,
  status,
  retryAfterMs,
});

/**
 * The human-readable fallback for each kind, used when the server did not
 * provide a readable message of its own. Exported so display code can tell a
 * generic fallback apart from a server-provided (dynamic) message.
 */
export const getGenericMessageForKind = (kind: ByokErrorKind): string => {
  if (kind === 'authentication') {
    return 'Your API key was rejected by the endpoint (401). Check the API key in the BYOK settings.';
  }
  if (kind === 'forbidden') {
    return 'The endpoint refused the request (403). Your API key may not have access to this model or resource.';
  }
  if (kind === 'not-found') {
    return 'The endpoint was not found (404). Check the base URL in the BYOK settings: for most providers it should end with /v1.';
  }
  if (kind === 'rate-limit') {
    return 'The endpoint is rate-limiting the requests (429). Wait a moment and try again.';
  }
  if (kind === 'invalid-request') {
    return 'The endpoint rejected the request as invalid (400). The request contained something it does not accept.';
  }
  if (kind === 'server') {
    return 'The endpoint had an internal error. Try again later.';
  }
  if (kind === 'network') {
    return 'Could not reach the endpoint (network error). Check the base URL and your internet connection.';
  }
  if (kind === 'timeout') {
    return 'The endpoint took too long to answer (timeout). Try again in a moment.';
  }
  return 'The endpoint returned an unexpected error.';
};

/**
 * Extract a readable message out of an OpenAI-style error body
 * (`{ error: { message: "..." } }`), or null when the body has none. Bodies
 * from OpenAI-compatible servers vary a lot, so this stays defensive.
 */
const extractOpenAiErrorMessage = (data: any): ?string => {
  if (!data || typeof data !== 'object') return null;

  const error = data.error;
  if (error && typeof error === 'object' && typeof error.message === 'string') {
    return error.message;
  }

  // Some servers put the message at the top level of the body instead.
  if (typeof data.message === 'string') return data.message;

  return null;
};

/**
 * Map an HTTP status code to an error kind. Returns null for the statuses
 * that have no specific kind (they become `unknown`).
 */
const getKindForStatus = (status: number): ?ByokErrorKind => {
  if (status === 401) return 'authentication';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limit';
  // 422 ("Unprocessable Entity") is the same "your request contains
  // something I don't accept" failure as 400 on many OpenAI-compatible
  // servers (e.g. an unknown reasoning_effort parameter) — classified the
  // same so the degraded retries can engage on it too.
  if (status === 400 || status === 422) return 'invalid-request';
  if (status >= 500 && status < 600) return 'server';
  return null;
};

/**
 * Read the `Retry-After` header of a 429 response (delay in seconds, or an
 * HTTP-date), as milliseconds from now. Returns null when the header is
 * absent or unparseable. The headers come from the axios error: untrusted
 * wire data.
 */
const getRetryAfterMsFromHeaders = (headers: any): ?number => {
  if (!headers || typeof headers !== 'object') return null;

  const rawRetryAfter = headers['retry-after'];
  if (typeof rawRetryAfter !== 'string' && typeof rawRetryAfter !== 'number') {
    return null;
  }

  const retryAfterSeconds = parseInt(String(rawRetryAfter), 10);
  if (Number.isFinite(retryAfterSeconds)) {
    return retryAfterSeconds * 1000;
  }

  // An HTTP-date ("Tue, 11 Nov 2026 08:00:00 GMT"): the wait is the distance
  // from now. NaN (unparseable) resolves to null below.
  const httpDateMs = Date.parse(String(rawRetryAfter));
  if (Number.isNaN(httpDateMs)) return null;
  return Math.max(0, httpDateMs - Date.now());
};

/**
 * Remove a secret (typically the API key) from an error message, so that no
 * thrown or displayed string can ever carry it. A safety net used by the
 * client when it builds its errors: the key travels in headers only, but the
 * "the key never appears in an error" promise should not depend on that
 * staying true forever.
 */
export const redactSecretFromMessage = (
  message: string,
  secret: string
): string => {
  if (!secret) return message;
  return message.split(secret).join('[redacted]');
};

/**
 * Same as `redactSecretFromMessage`, for an already-built ByokError.
 */
export const redactSecretFromByokError = (
  error: ByokError,
  secret: string
): ByokError => ({
  kind: error.kind,
  message: redactSecretFromMessage(error.message, secret),
  status: error.status,
  retryAfterMs: error.retryAfterMs,
});

/**
 * Normalize any error (an axios error, anything thrown) into a typed,
 * user-presentable ByokError. A ByokError is returned unchanged, so it is
 * always safe to call this on whatever a piece of code threw.
 */
export const classifyByokError = (error: any): ByokError => {
  // A request aborted locally (axios Cancel): not an endpoint failure, and
  // never retried — the caller decides to stop.
  if (error && error.__CANCEL__ === true) {
    return makeByokError('cancelled', 'The request was cancelled.', null);
  }

  // Already classified (e.g. a ByokError re-thrown through a retry helper).
  if (
    error &&
    typeof error === 'object' &&
    typeof error.kind === 'string' &&
    typeof error.message === 'string' &&
    !error.response &&
    !error.request
  ) {
    return error;
  }

  // The server answered with an HTTP error status.
  if (error && error.response && typeof error.response.status === 'number') {
    const status = error.response.status;
    const kind = getKindForStatus(status) || 'unknown';
    const serverMessage = extractOpenAiErrorMessage(error.response.data);
    const message = serverMessage || getGenericMessageForKind(kind);
    const retryAfterMs =
      kind === 'rate-limit'
        ? getRetryAfterMsFromHeaders(error.response.headers)
        : null;
    return makeByokError(kind, message, status, retryAfterMs);
  }

  // The request was made but never got a response.
  if (error && error.request && error.code === 'ECONNABORTED') {
    return makeByokError('timeout', getGenericMessageForKind('timeout'), null);
  }
  if (error && error.request) {
    return makeByokError('network', getGenericMessageForKind('network'), null);
  }

  // Anything else is a local/unclassified failure: keep the original message
  // as a detail (it never carries the key — see the redaction safety net).
  const originalDetail =
    error instanceof Error && error.message ? ` (${error.message})` : '';
  return makeByokError(
    'unknown',
    `${getGenericMessageForKind('unknown')}${originalDetail}`,
    null
  );
};

/**
 * True for the failures worth retrying as-is: the endpoint is temporarily
 * unavailable or asked us to slow down. Authentication and invalid-request
 * errors would fail again identically, so they are never retried.
 */
export const isRetryableByokError = (error: ByokError): boolean => {
  return (
    error.kind === 'rate-limit' ||
    error.kind === 'server' ||
    error.kind === 'network' ||
    error.kind === 'timeout'
  );
};

/**
 * True when the endpoint rejected the request specifically because of the
 * `reasoning_effort` parameter (some OpenAI-compatible servers don't know
 * it; they answer 400 or 422 — both classify as 'invalid-request'). The
 * caller can then retry once without the parameter instead of failing the
 * whole chat.
 */
export const isInvalidRequestForReasoningEffort = (
  error: ByokError
): boolean => {
  if (error.kind !== 'invalid-request') return false;
  return error.message.toLowerCase().includes('reasoning_effort');
};

/**
 * True when the endpoint rejected the request specifically because of its
 * image content (a text-only model asked for vision): the caller can then
 * degrade to a text-only retry instead of failing the whole chat.
 */
export const describeInvalidRequestForImageContent = (
  error: ByokError
): boolean => {
  if (error.kind !== 'invalid-request') return false;
  const message = error.message.toLowerCase();
  if (message.includes('image') || message.includes('image_url')) return true;
  if (message.includes('multimodal') || message.includes('vision')) {
    return true;
  }
  return message.includes('content') && message.includes('type');
};
