// @flow

/**
 * The reasoning effort to ask from the model. The exact behavior depends on
 * the provider; it is sent as-is with the requests (starting from Phase 2).
 */
export type ByokReasoningEffort = 'default' | 'low' | 'medium' | 'high';

/**
 * Whether the endpoint sees images: 'auto' sends them and degrades to
 * text-only on a rejection, 'yes' always sends them, 'no' never does (the
 * perception tools then return textual descriptions only).
 */
export type ByokImageSupport = 'auto' | 'yes' | 'no';

export const BYOK_IMAGE_SUPPORTS: Array<ByokImageSupport> = [
  'auto',
  'yes',
  'no',
];

export const isByokImageSupport = (value: mixed): boolean =>
  BYOK_IMAGE_SUPPORTS.some(support => support === value);

/**
 * The per-model advanced settings of one provider (Phase 13.4): unset
 * values are omitted from the request body (the provider default applies).
 * Lives on the provider (not the routing profile): the same model reached
 * through any profile gets the same advanced treatment.
 */
export type ByokProviderModelSettings = {|
  modelName: string,
  temperature: ?number,
  maxTokens: ?number,
  contextWindowTokens: ?number,
|};

/**
 * One registered provider (Phase 9.4, decision #6): a name, the base URL of
 * its OpenAI-compatible endpoint, and a reference to the slot its API key
 * lives in (`ByokKeyStorage`). The key itself is never part of the settings.
 * An empty `keyRef` is the legacy Phase 2 slot, so the migrated
 * single-endpoint provider #1 keeps working without re-entering the key.
 */
export type ByokProvider = {|
  id: string,
  name: string,
  endpointUrl: string,
  keyRef: string,
  // The per-model advanced blocks (13.4): temperature / max tokens /
  // context window per model of THIS provider.
  modelSettings: Array<ByokProviderModelSettings>,
|};

/**
 * The advanced per-profile request fields (Phase 9.4): unset values are
 * omitted from the request body (the provider default applies). `maxTokens`
 * is recommended for small local models, where an omitted limit can make
 * the model ramble until its context is exhausted.
 */
export type ByokModelProfile = {|
  providerId: string,
  modelName: string,
  temperature: ?number,
  maxTokens: ?number,
|};

export type ByokRoutingMode = 'automatic' | 'always-strong';

export const BYOK_ROUTING_MODES: Array<ByokRoutingMode> = [
  'automatic',
  'always-strong',
];

export const isByokRoutingMode = (value: mixed): boolean =>
  BYOK_ROUTING_MODES.some(mode => mode === value);

/**
 * What external MCP clients (Phase 10) may do with the tools they call:
 * 'read-only' rejects every project-modifying call, 'read-write' executes
 * everything the chat loop could do.
 */
export type ByokMcpAccessMode = 'read-only' | 'read-write';

export const BYOK_MCP_ACCESS_MODES: Array<ByokMcpAccessMode> = [
  'read-only',
  'read-write',
];

export const isByokMcpAccessMode = (value: mixed): boolean =>
  BYOK_MCP_ACCESS_MODES.some(mode => mode === value);

/**
 * The GDevelop MCP server settings (Phase 10): the loopback endpoint that
 * lets external MCP clients (Claude Code, ZCode, …) call the BYOK tool
 * registry against the live project. `enabled` starts and stops the
 * listener; `accessMode` is the consent surface for edits over MCP — there
 * is no chat approval row to render for an external agent, so the mode plus
 * the activity log carry that role.
 */
export type ByokMcpServerSettings = {|
  enabled: boolean,
  accessMode: ByokMcpAccessMode,
|};

/**
 * Decision D10-2 (2026-09-23): enabling the token-gated loopback server is
 * the consent act, so writes are allowed as soon as it is on. Read-only
 * stays one dropdown away.
 */
export const DEFAULT_BYOK_MCP_ACCESS_MODE: ByokMcpAccessMode = 'read-write';

export const makeDefaultByokMcpServerSettings = (): ByokMcpServerSettings => ({
  enabled: false,
  accessMode: DEFAULT_BYOK_MCP_ACCESS_MODE,
});

/**
 * The per-model capability record (Phase 9.5): what the endpoint was probed
 * to support (or to reject), keyed per endpoint+model. `null` means "not
 * probed yet". The remembered `reasoningEffortDegraded` state is what ends
 * the per-turn 400-dance on endpoints without `reasoning_effort` support.
 */
export type ByokCapabilityRecord = {|
  images: ?boolean,
  effortLevels: ?Array<string>,
  reasoningEffortDegraded: boolean,
  strictSchemas: ?boolean,
  parallelToolCalls: ?boolean,
  updatedAt: string,
|};

/**
 * The BYOK settings of the user. Note that the API key is intentionally not
 * part of this type: it never enters the preferences blob, it is stored by
 * `ByokKeyStorage` instead.
 *
 * `contextWindowTokens` is the global fallback of the context window, kept
 * from Phase 1. `contextWindowByModel` holds the per-model values (model id
 * → tokens), which take precedence for these models.
 */
export type ByokSettings = {|
  enabled: boolean,
  endpointUrl: string,
  modelName: string,
  reasoningEffort: ByokReasoningEffort,
  imageSupport: ByokImageSupport,
  contextWindowTokens: number,
  contextWindowByModel: { [string]: number },
  // When true, docs pages that are not bundled can be fetched from the
  // upstream documentation repository (cached for a day). Off by default:
  // offline-first.
  onlineDocsEnabled: boolean,
  // The user's global custom instructions, injected verbatim as the last
  // section of the system prompt (persona, house rules). 2 KB cap.
  customInstructions: string,
  // When true (Phase 8.3), a first message that looks like a game-build
  // request auto-includes the build-workflow skill body from turn one.
  buildWorkflowAutoSuggest: boolean,
  // ---- Phase 9 ----
  // The F2 stall watchdog (9.1): in-chat notices when a turn goes silent.
  stallWatchdogEnabled: boolean,
  stallWindowSeconds: number,
  // Follow-up suggestion chips generated by the user's endpoint (9.6). Off
  // by default: the chips' token spend is the user's.
  suggestionsEnabled: boolean,
  // The provider registry (9.4). Empty means "the legacy single endpoint
  // only" — which migrates into provider #1 on first run.
  providers: Array<ByokProvider>,
  // How the fast/strong profiles route the calls (9.4).
  routingMode: ByokRoutingMode,
  // The fast/strong model profiles over the provider registry. An empty
  // modelName means "fall back to the global endpoint/model".
  fastProfile: ByokModelProfile,
  strongProfile: ByokModelProfile,
  // The per (endpoint, model) capability cache (9.5).
  capabilitiesByTargetKey: { [string]: ByokCapabilityRecord },
  // The GDevelop MCP server (Phase 10): off by default.
  mcpServer: ByokMcpServerSettings,
|};

export const BYOK_CUSTOM_INSTRUCTIONS_MAX_CHARS = 2000;

export const MIN_CONTEXT_WINDOW_TOKENS = 512;
export const MAX_CONTEXT_WINDOW_TOKENS = 1000000;

/**
 * The editor-functions protocol version BYOK executes with — the same
 * value as AI_ORCHESTRATOR_TOOLS_VERSION (AiGeneration/Utils.js). Declared
 * here instead of imported because Utils.js pulls renderer-only modules
 * that cannot load in the tests. v12+ means script-based-agent semantics:
 * an idempotent no-op tool call is a success (IsNoOpConsideredSuccess).
 */
export const BYOK_TOOLS_VERSION: string = 'v15';

// ---- Phase 9: providers, routing profiles, watchdog, suggestions ----

export const makeDefaultByokCapabilityRecord = (): ByokCapabilityRecord => ({
  images: null,
  effortLevels: null,
  reasoningEffortDegraded: false,
  strictSchemas: null,
  parallelToolCalls: null,
  updatedAt: new Date().toISOString(),
});

/** The default stall window of the Phase 9.1 watchdog, in seconds. */
export const DEFAULT_STALL_WINDOW_SECONDS = 90;
export const MIN_STALL_WINDOW_SECONDS = 10;
export const MAX_STALL_WINDOW_SECONDS = 600;

/** How many follow-up suggestion chips the endpoint is asked for (9.6). */
export const BYOK_SUGGESTIONS_COUNT = 3;

/** How many feedback ratings are kept locally (9.6). */
export const BYOK_FEEDBACK_CAPACITY = 500;

/**
 * The storage quota of the durable chat history (9.3): image sidecar
 * entries of the oldest chats are evicted first, transcript texts last.
 */
export const BYOK_CHAT_STORAGE_QUOTA_BYTES = 200 * 1000 * 1000;

export const BYOK_REASONING_EFFORTS: Array<ByokReasoningEffort> = [
  'default',
  'low',
  'medium',
  'high',
];

export const DEFAULT_BYOK_SETTINGS: ByokSettings = {
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
  stallWindowSeconds: DEFAULT_STALL_WINDOW_SECONDS,
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
    accessMode: DEFAULT_BYOK_MCP_ACCESS_MODE,
  },
};

/**
 * A model as reported by the endpoint (GET /models), with the context window
 * size when the server reports one (many OpenAI-compatible servers do; OpenAI
 * itself does not — it is then filled from the user settings or a default).
 */
export type ByokModelInfo = {|
  id: string,
  contextWindowTokens: ?number,
|};

/**
 * One tool call asked by the model, in the exact shape of the OpenAI
 * chat-completions API.
 */
export type ByokToolCall = {|
  id: string,
  type: 'function',
  function: {|
    name: string,
    // A JSON string, not a parsed object: this is the wire format.
    arguments: string,
  |},
|};

/**
 * One content part of a multi-part user message (the OpenAI-compatible
 * vision format): text, or an image referenced by data URL. Re-exported
 * from ByokImageContent, which owns the image pipeline.
 */
export type ByokUserContentItem =
  | {| type: 'text', text: string |}
  | {| type: 'image_url', image_url: {| url: string |} |};

/**
 * A message of the OpenAI chat-completions API. This is the contract with
 * the user's endpoint: the internal GDevelop transcript (`AiRequestMessage`)
 * is translated to/from these in `ByokTranscript.js`. A user message
 * carries either plain text or an array of content parts (strings pass
 * through unchanged for back-compat).
 */
export type ByokChatMessage =
  | {| role: 'system', content: string |}
  | {| role: 'user', content: string | Array<ByokUserContentItem> |}
  | {|
      role: 'assistant',
      content: string | null,
      tool_calls?: Array<ByokToolCall>,
    |}
  | {| role: 'tool', content: string, tool_call_id: string |};

/**
 * The response of a chat-completions call (non-streaming). Note that `usage`
 * is optional: some proxies omit it.
 */
export type ByokChatCompletionResponse = {|
  choices: Array<{|
    message: {|
      role: 'assistant',
      content: string | null,
      tool_calls?: Array<ByokToolCall>,
    |},
    finish_reason: ?string,
  |}>,
  usage?: {|
    prompt_tokens: number,
    completion_tokens: number,
    total_tokens: number,
  |},
|};

/**
 * The token usage of one chat-completions call, normalized from the
 * snake_case `usage` field of the response.
 */
export type ByokUsage = {|
  promptTokens: number,
  completionTokens: number,
  totalTokens: number,
|};

/**
 * A cancellation handle for an in-flight request: `token` is the (opaque)
 * axios cancel token passed with the request, `cancel` aborts it. Created by
 * `createByokCancellation` in `ByokClient.js` so this module stays free of
 * the axios import.
 */
export type ByokCancellation = {|
  token: Object,
  cancel: () => void,
|};

/**
 * The options of a chat-completions request. `reasoningEffort` is included in
 * the request body only when set (a `'default'` effort from the settings
 * means "do not send the parameter at all"). `temperature`/`maxTokens` (the
 * Phase 9.4 profile advanced fields) are omitted when unset, like every
 * optional parameter, so endpoints that reject unknown fields keep working.
 */
export type ByokChatCompletionOptions = {|
  model: string,
  messages: Array<ByokChatMessage>,
  tools?: Array<Object>,
  toolChoice?: 'auto' | 'none' | 'required',
  parallelToolCalls?: boolean,
  reasoningEffort?: 'low' | 'medium' | 'high',
  temperature?: number,
  maxTokens?: number,
  timeoutMs?: number,
  cancellation?: ByokCancellation,
|};

/**
 * Where to reach the user's endpoint: the base URL (including `/v1` when the
 * provider uses it) and the API key.
 */
export type ByokConnection = {|
  baseUrl: string,
  apiKey: string,
|};

/**
 * True when the given value is one of the documented reasoning efforts. Used
 * to check values read back from localStorage, and to narrow the value of a
 * select field.
 */
export const isByokReasoningEffort = (value: mixed): boolean =>
  BYOK_REASONING_EFFORTS.some(effort => effort === value);

const getBooleanOrDefault = (value: mixed, defaultValue: boolean): boolean => {
  if (typeof value === 'boolean') return value;
  return defaultValue;
};

const getStringOrDefault = (value: mixed, defaultValue: string): string => {
  if (typeof value === 'string') return value;
  return defaultValue;
};

const getNumberOrDefault = (value: mixed, defaultValue: number): number => {
  if (typeof value === 'number') return value;
  return defaultValue;
};

/**
 * Read the per-model context window map, keeping only the entries that are
 * positive finite numbers (the map is read back from localStorage, so every
 * entry is untrusted data). Entries for models are dropped, not defaulted:
 * a missing entry means "use the fallbacks" for this model.
 */
const getContextWindowByModelOrDefault = (
  value: mixed
): { [string]: number } => {
  const contextWindowByModel: { [string]: number } = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return contextWindowByModel;
  }

  const rawMap = value;
  for (const modelId of Object.keys(rawMap)) {
    const tokens = rawMap[modelId];
    if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) {
      contextWindowByModel[modelId] = tokens;
    }
  }
  return contextWindowByModel;
};

const getOptionalNumber = (value: mixed): ?number =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Read one per-model settings block (untrusted preferences data): the model
 * name is required, the numbers are optional (null = "use the defaults").
 */
const getProviderModelSettingsOrDefault = (
  value: mixed
): ?ByokProviderModelSettings => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record: Object = value;
  if (typeof record.modelName !== 'string' || !record.modelName) return null;
  return {
    modelName: record.modelName,
    temperature: getOptionalNumber(record.temperature),
    maxTokens: getOptionalNumber(record.maxTokens),
    contextWindowTokens: getOptionalNumber(record.contextWindowTokens),
  };
};

/**
 * Read one provider entry (untrusted preferences data): keep only the
 * well-shaped ones, with every field narrowed to its type.
 */
const getProviderOrDefault = (value: mixed): ?ByokProvider => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record: Object = value;
  if (typeof record.id !== 'string' || !record.id) return null;
  if (typeof record.endpointUrl !== 'string') return null;
  const modelSettings: Array<ByokProviderModelSettings> = [];
  if (Array.isArray(record.modelSettings)) {
    for (const entry of record.modelSettings) {
      const settings = getProviderModelSettingsOrDefault(entry);
      if (settings) modelSettings.push(settings);
    }
  }
  return {
    id: record.id,
    name: typeof record.name === 'string' ? record.name : record.id,
    endpointUrl: record.endpointUrl,
    keyRef: typeof record.keyRef === 'string' ? record.keyRef : record.id,
    modelSettings,
  };
};

const getProvidersOrDefault = (value: mixed): Array<ByokProvider> => {
  if (!Array.isArray(value)) return [];
  const providers: Array<ByokProvider> = [];
  for (const entry of value) {
    const provider = getProviderOrDefault(entry);
    if (provider) providers.push(provider);
  }
  return providers;
};

const makeEmptyModelProfile = (): ByokModelProfile => ({
  providerId: '',
  modelName: '',
  temperature: null,
  maxTokens: null,
});

const getModelProfileOrDefault = (value: mixed): ByokModelProfile => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return makeEmptyModelProfile();
  }
  const record: Object = value;
  return {
    providerId: typeof record.providerId === 'string' ? record.providerId : '',
    modelName: typeof record.modelName === 'string' ? record.modelName : '',
    temperature:
      typeof record.temperature === 'number' &&
      Number.isFinite(record.temperature)
        ? record.temperature
        : null,
    maxTokens:
      typeof record.maxTokens === 'number' &&
      Number.isFinite(record.maxTokens) &&
      record.maxTokens > 0
        ? record.maxTokens
        : null,
  };
};

const clampStallWindowSeconds = (value: mixed): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_STALL_WINDOW_SECONDS;
  }
  if (value < MIN_STALL_WINDOW_SECONDS) return MIN_STALL_WINDOW_SECONDS;
  if (value > MAX_STALL_WINDOW_SECONDS) return MAX_STALL_WINDOW_SECONDS;
  return Math.round(value);
};

const getMcpServerOrDefault = (value: mixed): ByokMcpServerSettings => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return makeDefaultByokMcpServerSettings();
  }
  const record: Object = value;
  return {
    enabled: record.enabled === true,
    accessMode: isByokMcpAccessMode(record.accessMode)
      ? record.accessMode
      : DEFAULT_BYOK_MCP_ACCESS_MODE,
  };
};

/**
 * Read the per-model capability records, keeping only the well-shaped ones
 * (the map is read back from the preferences: untrusted data).
 */
const getCapabilitiesByTargetKeyOrDefault = (
  value: mixed
): { [string]: ByokCapabilityRecord } => {
  const capabilities: { [string]: ByokCapabilityRecord } = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return capabilities;
  }
  const rawMap: Object = value;
  for (const key of Object.keys(rawMap)) {
    const record = rawMap[key];
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      continue;
    }
    const raw: Object = record;
    capabilities[key] = {
      images: typeof raw.images === 'boolean' ? raw.images : null,
      effortLevels: Array.isArray(raw.effortLevels)
        ? raw.effortLevels.filter(level => typeof level === 'string' && !!level)
        : null,
      reasoningEffortDegraded: raw.reasoningEffortDegraded === true,
      strictSchemas:
        typeof raw.strictSchemas === 'boolean' ? raw.strictSchemas : null,
      parallelToolCalls:
        typeof raw.parallelToolCalls === 'boolean'
          ? raw.parallelToolCalls
          : null,
      updatedAt:
        typeof raw.updatedAt === 'string'
          ? raw.updatedAt
          : new Date().toISOString(),
    };
  }
  return capabilities;
};

/**
 * A fresh copy of the default settings — `DEFAULT_BYOK_SETTINGS` itself is a
 * shared module constant (it seeds the preferences defaults), so callers that
 * may mutate what they receive must get a copy, never the constant.
 */
const makeDefaultByokSettings = (): ByokSettings => ({
  ...DEFAULT_BYOK_SETTINGS,
  contextWindowByModel: {},
  providers: [],
  fastProfile: makeEmptyModelProfile(),
  strongProfile: makeEmptyModelProfile(),
  capabilitiesByTargetKey: {},
  mcpServer: makeDefaultByokMcpServerSettings(),
});

/**
 * Read the BYOK settings from the preferences values, without ever crashing
 * on missing, partial or corrupted settings (they are read back from
 * localStorage, so they must be treated as untrusted data). Fields are merged
 * over the defaults one by one, so that settings saved by an older build
 * (before a new field was added) still work.
 */
export const getByokSettings = (values: {
  +byok: ?ByokSettings,
  ...
}): ByokSettings => {
  const byok = values.byok;
  if (!byok) return makeDefaultByokSettings();
  if (typeof byok !== 'object') return makeDefaultByokSettings();

  return {
    enabled: getBooleanOrDefault(byok.enabled, DEFAULT_BYOK_SETTINGS.enabled),
    endpointUrl: getStringOrDefault(
      byok.endpointUrl,
      DEFAULT_BYOK_SETTINGS.endpointUrl
    ),
    modelName: getStringOrDefault(
      byok.modelName,
      DEFAULT_BYOK_SETTINGS.modelName
    ),
    reasoningEffort: isByokReasoningEffort(byok.reasoningEffort)
      ? byok.reasoningEffort
      : DEFAULT_BYOK_SETTINGS.reasoningEffort,
    imageSupport: isByokImageSupport(byok.imageSupport)
      ? byok.imageSupport
      : DEFAULT_BYOK_SETTINGS.imageSupport,
    contextWindowTokens: getNumberOrDefault(
      byok.contextWindowTokens,
      DEFAULT_BYOK_SETTINGS.contextWindowTokens
    ),
    contextWindowByModel: getContextWindowByModelOrDefault(
      byok.contextWindowByModel
    ),
    onlineDocsEnabled: getBooleanOrDefault(
      byok.onlineDocsEnabled,
      DEFAULT_BYOK_SETTINGS.onlineDocsEnabled
    ),
    customInstructions: getStringOrDefault(
      byok.customInstructions,
      DEFAULT_BYOK_SETTINGS.customInstructions
    ).slice(0, BYOK_CUSTOM_INSTRUCTIONS_MAX_CHARS),
    buildWorkflowAutoSuggest: getBooleanOrDefault(
      byok.buildWorkflowAutoSuggest,
      DEFAULT_BYOK_SETTINGS.buildWorkflowAutoSuggest
    ),
    stallWatchdogEnabled: getBooleanOrDefault(
      byok.stallWatchdogEnabled,
      DEFAULT_BYOK_SETTINGS.stallWatchdogEnabled
    ),
    stallWindowSeconds: clampStallWindowSeconds(byok.stallWindowSeconds),
    suggestionsEnabled: getBooleanOrDefault(
      byok.suggestionsEnabled,
      DEFAULT_BYOK_SETTINGS.suggestionsEnabled
    ),
    providers: getProvidersOrDefault(byok.providers),
    routingMode: isByokRoutingMode(byok.routingMode)
      ? byok.routingMode
      : DEFAULT_BYOK_SETTINGS.routingMode,
    fastProfile: getModelProfileOrDefault(byok.fastProfile),
    strongProfile: getModelProfileOrDefault(byok.strongProfile),
    capabilitiesByTargetKey: getCapabilitiesByTargetKeyOrDefault(
      byok.capabilitiesByTargetKey
    ),
    mcpServer: getMcpServerOrDefault(byok.mcpServer),
  };
};

/**
 * The advanced settings registered for one model of a provider (Phase
 * 13.4), or null when this model has no block yet.
 */
export const getByokProviderModelSettings = (
  provider: ByokProvider,
  modelName: string
): ?ByokProviderModelSettings =>
  Array.isArray(provider.modelSettings)
    ? provider.modelSettings.find(
        settings => settings.modelName === modelName
      ) || null
    : null;

/**
 * Insert or replace one model's settings block on a provider copy (the
 * settings UI works on copies; the preferences blob is replaced whole).
 */
export const upsertByokProviderModelSettings = (
  provider: ByokProvider,
  modelSettings: ByokProviderModelSettings
): ByokProvider => ({
  ...provider,
  modelSettings: [
    ...(Array.isArray(provider.modelSettings) ? provider.modelSettings : []),
  ]
    .filter(existing => existing.modelName !== modelSettings.modelName)
    .concat([modelSettings]),
});

/**
 * Remove one model's settings block from a provider copy.
 */
export const removeByokProviderModelSettings = (
  provider: ByokProvider,
  modelName: string
): ByokProvider => ({
  ...provider,
  modelSettings: (Array.isArray(provider.modelSettings)
    ? provider.modelSettings
    : []
  ).filter(existing => existing.modelName !== modelName),
});

/**
 * True when BYOK can actually be used: enabled, with an endpoint URL that
 * looks like an HTTP(S) URL (`http://` is allowed for local servers like
 * Ollama) and a model name.
 */
export const isByokFullyConfigured = (settings: ByokSettings): boolean => {
  if (!settings.enabled) return false;

  // The legacy single-endpoint form: global endpoint + model.
  const endpointUrl = settings.endpointUrl.trim();
  const hasGlobalConnection =
    !!endpointUrl &&
    (endpointUrl.startsWith('https://') || endpointUrl.startsWith('http://')) &&
    !!settings.modelName.trim();
  if (hasGlobalConnection) return true;

  // The Phase 13.4 provider form (audit011026 B-UI-2): the strong pair
  // names a registered provider whose endpoint is set — the keys live in
  // the per-provider slots, so requiring the global endpoint+model here
  // kept a providers-only setup from ever turning the header toggle
  // green.
  const strongProfile = settings.strongProfile;
  if (!strongProfile.modelName.trim()) return false;
  const strongProvider = (settings.providers || []).find(
    provider => provider.id === strongProfile.providerId
  );
  if (!strongProvider) return false;
  const providerUrl = strongProvider.endpointUrl.trim();
  return (
    !!providerUrl &&
    (providerUrl.startsWith('https://') || providerUrl.startsWith('http://'))
  );
};

/**
 * The global model-turn budget shared by a parent BYOK chat and all of its
 * sub-agents (Phase 8.1): every model round of the parent and of every
 * child decrements `remaining`, and any loop that finds it exhausted stops
 * — sub-agents multiply the calls made against the user's paid endpoint, so
 * runaway cost must be impossible. A plain mutable object so parent and
 * children truly share one counter.
 */
export type ByokSharedTurnBudget = {| remaining: number |};

/** The default size of the shared parent+sub-agents turn budget. */
export const BYOK_GLOBAL_TURN_BUDGET = 150;
