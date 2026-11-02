// @flow
import { fetchRawByokModels } from './ByokClient';
import {
  DEFAULT_BYOK_SETTINGS,
  type ByokConnection,
  type ByokModelInfo,
  type ByokSettings,
} from './ByokTypes';

/**
 * Read the context window from a raw `/models` entry, trying in order the
 * fields that different OpenAI-compatible servers actually use. Returns the
 * first positive number found, or null when the server does not report the
 * context window (OpenAI itself does not).
 */
export const extractContextWindowTokens = (modelEntry: Object): ?number => {
  if (!modelEntry || typeof modelEntry !== 'object') return null;

  // vLLM and some gateways.
  if (
    typeof modelEntry.context_length === 'number' &&
    modelEntry.context_length > 0
  ) {
    return modelEntry.context_length;
  }

  // LM Studio.
  if (
    typeof modelEntry.max_context_length === 'number' &&
    modelEntry.max_context_length > 0
  ) {
    return modelEntry.max_context_length;
  }

  // text-generation-webui, llama.cpp server, some gateways.
  if (
    typeof modelEntry.max_model_len === 'number' &&
    modelEntry.max_model_len > 0
  ) {
    return modelEntry.max_model_len;
  }

  // A few local servers name it like the llama.cpp option.
  if (
    typeof modelEntry.context_size === 'number' &&
    modelEntry.context_size > 0
  ) {
    return modelEntry.context_size;
  }

  // Some gateways nest it in a metadata object.
  const metadata = modelEntry.metadata;
  if (
    metadata &&
    typeof metadata === 'object' &&
    typeof metadata.context_length === 'number' &&
    metadata.context_length > 0
  ) {
    return metadata.context_length;
  }

  return null;
};

/**
 * Normalize the raw entries of a `/models` response: parse the context
 * window when the server reports one, drop the entries without an id, and
 * sort by id ascending (so the settings dropdown is stable).
 */
const compareByModelIds = (a: ByokModelInfo, b: ByokModelInfo): number => {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
};

export const normalizeByokModels = (
  rawModels: Array<Object>
): Array<ByokModelInfo> => {
  const models: Array<ByokModelInfo> = [];
  for (const rawModel of rawModels) {
    if (!rawModel || typeof rawModel !== 'object') continue;
    if (typeof rawModel.id !== 'string') continue;
    models.push({
      id: rawModel.id,
      contextWindowTokens: extractContextWindowTokens(rawModel),
    });
  }

  return models.sort(compareByModelIds);
};

// The only mutable module state of the BYOK modules: a per-session read
// cache of the model lists, keyed by the normalized base URL. It is safe
// because it only ever holds copies of what the server answered (a stale
// entry is replaced by the next refresh, and a caller mutating the array it
// got cannot corrupt the cache), and because BYOK settings live in the main
// window only.
const modelsByBaseUrl: Map<string, Array<ByokModelInfo>> = new Map();

// The same normalization the client applies to build URLs, so
// `https://host/v1` and `https://host/v1/` are one cache entry.
const normalizeCacheBaseUrl = (baseUrl: string): string =>
  baseUrl.trim().replace(/\/+$/, '');

// A model list is a function of BOTH the endpoint AND the key: two
// providers pointing at the same aggregator URL with different accounts see
// different models. The key itself is encrypted in safeStorage and cannot
// be read synchronously here, so the cache is keyed by (URL, scope) where
// the scope is the provider id (or 'global' for the single-endpoint
// fallback) — which is what actually distinguishes the two entries
// (audit100226 CACHE-4). A caller with no scope falls back to any entry of
// that URL, so an unscoped read never misses a fetched list.
const makeCacheKey = (baseUrl: string, scope?: ?string): string =>
  scope
    ? `${normalizeCacheBaseUrl(baseUrl)}::${scope}`
    : normalizeCacheBaseUrl(baseUrl);

/**
 * Remember the model list of an endpoint for this session (a copy of it).
 */
export const cacheByokModels = (
  baseUrl: string,
  models: Array<ByokModelInfo>,
  scope?: ?string
): void => {
  if (scope) {
    modelsByBaseUrl.set(makeCacheKey(baseUrl, scope), models.slice());
    return;
  }
  // Unscoped: also keep it reachable under the bare URL.
  modelsByBaseUrl.set(normalizeCacheBaseUrl(baseUrl), models.slice());
};

/**
 * The model list remembered for an endpoint (a copy of it), or null when it
 * was never fetched (or the app was restarted: the cache is in-memory only).
 */
export const getCachedByokModels = (
  baseUrl: string,
  scope?: ?string
): ?Array<ByokModelInfo> => {
  const scoped = scope
    ? modelsByBaseUrl.get(makeCacheKey(baseUrl, scope))
    : null;
  if (scoped) return scoped.slice();
  const cachedModels = modelsByBaseUrl.get(normalizeCacheBaseUrl(baseUrl));
  return cachedModels ? cachedModels.slice() : null;
};

/**
 * Forget every cached model list — used when the stored API key changes, so
 * the next fetch reflects the new key's accessible models instead of showing
 * the previous key's list.
 */
export const clearByokModels = (): void => {
  modelsByBaseUrl.clear();
};

/**
 * Fetch, normalize and cache the model list of an endpoint. This is what the
 * settings tab calls from its "Fetch models" button.
 */
export const refreshByokModels = async (
  connection: ByokConnection,
  scope?: ?string
): Promise<Array<ByokModelInfo>> => {
  // The raw entries are needed here so the context-window fields reported by
  // the server can be parsed by normalizeByokModels.
  const rawModels = await fetchRawByokModels(connection);
  const models = normalizeByokModels(rawModels);
  cacheByokModels(connection.baseUrl, models, scope);
  return models;
};

/**
 * The context window to use for a model, following the fallback chain:
 * 1. what the server reported for the model (when it reports one),
 * 2. the per-model value set in the provider's advanced settings (13.4),
 * 3. the value the user set for this model (the legacy global map),
 * 4. the global value the user set (kept from Phase 1),
 * 5. the default (8192).
 */
export const resolveContextWindowTokens = (
  settings: ByokSettings,
  modelInfo: ?ByokModelInfo,
  modelId: string,
  providerModelTokens?: ?number
): number => {
  if (
    modelInfo &&
    typeof modelInfo.contextWindowTokens === 'number' &&
    modelInfo.contextWindowTokens > 0
  ) {
    return modelInfo.contextWindowTokens;
  }

  if (typeof providerModelTokens === 'number' && providerModelTokens > 0) {
    return providerModelTokens;
  }

  const perModelTokens = settings.contextWindowByModel[modelId];
  if (typeof perModelTokens === 'number' && perModelTokens > 0) {
    return perModelTokens;
  }

  if (settings.contextWindowTokens > 0) {
    return settings.contextWindowTokens;
  }

  return DEFAULT_BYOK_SETTINGS.contextWindowTokens;
};
