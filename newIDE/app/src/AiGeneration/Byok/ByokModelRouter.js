// @flow
import {
  type ByokCapabilityRecord,
  type ByokModelProfile,
  type ByokProvider,
  type ByokReasoningEffort,
  type ByokSettings,
  getByokProviderModelSettings,
  isByokReasoningEffort,
} from './ByokTypes';

/**
 * The multi-provider model routing (Phase 9.4, owner decision #6): cheap
 * reads on the `fast` profile, strong writes on the `strong` one, with the
 * per-chat dropdowns overriding both. This module is the pure core: the
 * registry CRUD, the migration of the legacy single endpoint, the routing
 * policy (call kind → profile) and the resolution order (per-chat override
 * > profile policy > global fallback). It knows nothing about React, axios
 * or the key storage — the caller resolves the key through `ByokKeyStorage`
 * with the provider's `keyRef`.
 *
 * Call kinds are the "who is asking" labels the orchestrator and the helper
 * callers pass with every request. The routing truth table:
 * - `main` (edits/generation/event-writing), `reviewer`, `benchmark` → strong;
 * - `scout` (read-only sub-agent fan-out), `compaction` (9.2 summaries),
 *   `suggestions` (9.6 chips), `docs` (reference/docs summarization) → fast.
 * `reviewer` deliberately rides the strong profile: it gates the quality of
 * the final work, the one place cheapness must not win (recorded decision,
 * worklog 2026-09-23).
 */

export type ByokCallKind =
  | 'main'
  | 'scout'
  | 'reviewer'
  | 'compaction'
  | 'suggestions'
  | 'docs'
  | 'benchmark';

export const BYOK_CALL_KINDS: Array<ByokCallKind> = [
  'main',
  'scout',
  'reviewer',
  'compaction',
  'suggestions',
  'docs',
  'benchmark',
];

/** The kinds routed to the `fast` profile (everything else goes strong). */
const FAST_CALL_KINDS: Set<ByokCallKind> = new Set([
  'scout',
  'compaction',
  'suggestions',
  'docs',
]);

export const isFastByokCallKind = (kind: ByokCallKind): boolean =>
  FAST_CALL_KINDS.has(kind);

/** The profile a call kind routes to under the current routing mode. */
export const resolveByokRoutingProfile = (
  settings: ByokSettings,
  kind: ByokCallKind
): 'fast' | 'strong' => {
  if (settings.routingMode === 'always-strong') return 'strong';
  return isFastByokCallKind(kind) ? 'fast' : 'strong';
};

/** A fresh provider id. */
export const makeByokProviderId = (): string =>
  'byok-provider-' +
  Date.now().toString(36) +
  '-' +
  Math.random()
    .toString(36)
    .slice(2, 8);

/**
 * Insert or replace a provider in a registry copy (the settings UI works on
 * copies, the preferences blob is replaced whole).
 */
export const upsertByokProvider = (
  providers: Array<ByokProvider>,
  provider: ByokProvider
): Array<ByokProvider> => {
  const next = providers.filter(entry => entry.id !== provider.id);
  next.push(provider);
  return next;
};

/** Remove a provider from a registry copy. */
export const removeByokProvider = (
  providers: Array<ByokProvider>,
  providerId: string
): Array<ByokProvider> => providers.filter(entry => entry.id !== providerId);

/**
 * The migration of the legacy single endpoint (Phase 1–8 settings) into
 * provider #1 (9.4). Returns null when there is nothing to migrate: a
 * registry that already has providers, or no legacy endpoint configured.
 * The migrated provider keeps `keyRef: ''` — the legacy key slot — so the
 * stored key keeps working without being re-entered.
 */
export const buildLegacyMigrationProviders = (
  settings: ByokSettings
): Array<ByokProvider> | null => {
  if (settings.providers.length > 0) return null;
  if (!settings.endpointUrl.trim()) return null;
  return [
    {
      id: makeByokProviderId(),
      name: 'Provider 1',
      endpointUrl: settings.endpointUrl,
      keyRef: '',
      modelSettings: [],
    },
  ];
};

/**
 * The per-chat model/effort selection (the chat-header dropdowns). Stored
 * on the chat record itself, so it survives the durable history (9.3)
 * without a second storage.
 */
export type ByokChatModelSelection = {|
  providerId: string,
  modelName: string,
  reasoningEffort: ByokReasoningEffort,
|};

/** Read the chat's selection (untrusted data — it round-trips files). */
export const getByokChatModelSelection = (
  chat: any
): ByokChatModelSelection | null => {
  const selection = chat && chat.byokModelSelection;
  if (!selection || typeof selection !== 'object') return null;
  if (typeof selection.modelName !== 'string' || !selection.modelName) {
    return null;
  }
  return {
    providerId:
      typeof selection.providerId === 'string' ? selection.providerId : '',
    modelName: selection.modelName,
    reasoningEffort: isByokReasoningEffort(selection.reasoningEffort)
      ? selection.reasoningEffort
      : 'default',
  };
};

/** Write the chat's selection (mutates the record, like the id fields do). */
export const setByokChatModelSelection = (
  chat: any,
  selection: ByokChatModelSelection | null
): void => {
  chat.byokModelSelection = selection;
};

/**
 * Where a request should go: the endpoint, the model, and the advanced
 * profile fields (unset = omitted from the request body). `source` records
 * which resolution level answered, for the badge and the tests.
 */
export type ByokResolvedTarget = {|
  providerId: string,
  endpointUrl: string,
  modelName: string,
  temperature: ?number,
  maxTokens: ?number,
  source: 'chat-override' | 'policy' | 'global',
|};

/**
 * Overlay the provider's per-model advanced settings (Phase 13.4) on a
 * resolved target: a temperature/max-tokens value set for THIS provider's
 * model wins over the profile-level value; null keeps whatever was already
 * resolved. Pure helper of the resolvers below.
 */
const applyProviderModelSettings = (
  settings: ByokSettings,
  target: ByokResolvedTarget
): ByokResolvedTarget => {
  if (!target.modelName) return target;
  const provider = settings.providers.find(
    entry => entry.id === target.providerId
  );
  if (!provider) return target;
  const modelSettings = getByokProviderModelSettings(
    provider,
    target.modelName
  );
  if (!modelSettings) return target;
  return {
    ...target,
    temperature:
      modelSettings.temperature !== null
        ? modelSettings.temperature
        : target.temperature,
    maxTokens:
      modelSettings.maxTokens !== null
        ? modelSettings.maxTokens
        : target.maxTokens,
  };
};

const targetFromProfile = (
  settings: ByokSettings,
  profile: ByokModelProfile,
  source: 'chat-override' | 'policy'
): ByokResolvedTarget => {
  const provider = settings.providers.find(
    entry => entry.id === profile.providerId
  );
  return applyProviderModelSettings(settings, {
    providerId: provider ? provider.id : '',
    endpointUrl: provider ? provider.endpointUrl : settings.endpointUrl,
    modelName: profile.modelName,
    temperature: profile.temperature,
    maxTokens: profile.maxTokens,
    source,
  });
};

const globalTarget = (settings: ByokSettings): ByokResolvedTarget => ({
  providerId: '',
  endpointUrl: settings.endpointUrl,
  modelName: settings.modelName,
  temperature: null,
  maxTokens: null,
  source: 'global',
});

/**
 * Resolve where a call of this kind should go, following the order the
 * phase document fixes: the per-chat override first, then the profile
 * policy, then the global settings. A profile entry without a model name
 * falls through to the global fallback (single-model users are unaffected
 * by the whole mechanism).
 */
export const resolveByokModelTarget = ({
  settings,
  chatSelection,
  callKind,
}: {|
  settings: ByokSettings,
  chatSelection: ByokChatModelSelection | null,
  callKind: ByokCallKind,
|}): ByokResolvedTarget => {
  if (chatSelection) {
    const routed = resolveByokRoutingProfile(settings, callKind);
    const profile =
      routed === 'fast' ? settings.fastProfile : settings.strongProfile;
    const provider = settings.providers.find(
      entry => entry.id === chatSelection.providerId
    );
    // The chat pinned a provider that no longer exists (it was deleted in
    // Preferences; the selection outlives it inside the saved chat file).
    // Falling back to the GLOBAL endpoint with the dead provider's model
    // name sent the user's request to an endpoint that never knew that
    // model — the same failure B-UI-9 fixed for routing profiles, which
    // chat selections were not covered for (audit100226 UI-4). Fall
    // through to normal profile/global resolution instead.
    if (!provider && chatSelection.providerId) {
      return resolveByokModelTarget({
        settings,
        chatSelection: null,
        callKind,
      });
    }
    return applyProviderModelSettings(settings, {
      providerId: provider ? provider.id : '',
      endpointUrl: provider ? provider.endpointUrl : settings.endpointUrl,
      modelName: chatSelection.modelName,
      temperature: profile.temperature,
      maxTokens: profile.maxTokens,
      source: 'chat-override',
    });
  }

  const routed = resolveByokRoutingProfile(settings, callKind);
  const profile =
    routed === 'fast' ? settings.fastProfile : settings.strongProfile;
  if (profile.modelName.trim()) {
    return targetFromProfile(settings, profile, 'policy');
  }
  return globalTarget(settings);
};

/**
 * The reasoning effort to send for a model, or null when none must be sent:
 * the per-chat effort dropdown first, then the global setting — but a
 * remembered degradation (the capability cache, 9.5) suppresses the
 * parameter entirely, so an endpoint without `reasoning_effort` support is
 * never 400-ed again.
 */
export const resolveByokReasoningEffort = ({
  settings,
  chatSelection,
  capabilityRecord,
}: {|
  settings: ByokSettings,
  chatSelection: ByokChatModelSelection | null,
  capabilityRecord: ?ByokCapabilityRecord,
|}): 'low' | 'medium' | 'high' | null => {
  if (capabilityRecord && capabilityRecord.reasoningEffortDegraded) {
    return null;
  }
  if (
    chatSelection &&
    chatSelection.reasoningEffort !== 'default' &&
    isByokReasoningEffort(chatSelection.reasoningEffort)
  ) {
    return ((chatSelection.reasoningEffort: any): 'low' | 'medium' | 'high');
  }
  if (settings.reasoningEffort === 'default') return null;
  return settings.reasoningEffort;
};

/**
 * The effort options of the chat dropdown: the server-listed per-model
 * levels when the capability probe found some, the low/medium/high defaults
 * otherwise.
 */
export const getByokEffortOptions = (
  capabilityRecord: ?ByokCapabilityRecord
): Array<'low' | 'medium' | 'high'> => {
  const defaults: Array<'low' | 'medium' | 'high'> = ['low', 'medium', 'high'];
  if (!capabilityRecord || !capabilityRecord.effortLevels) return defaults;
  const serverLevels: Array<'low' | 'medium' | 'high'> = [];
  for (const level of capabilityRecord.effortLevels) {
    if (level === 'low' || level === 'medium' || level === 'high') {
      serverLevels.push(level);
    }
  }
  return serverLevels.length > 0 ? serverLevels : defaults;
};

/** One entry of the chat model dropdown: `provider name/model name`. */
export type ByokModelChoice = {|
  providerId: string,
  providerName: string,
  modelName: string,
  label: string,
|};

/**
 * The model choices of the chat dropdown: every model of every registered
 * provider (the caller feeds each provider's fetched model list), plus the
 * global fallback models under their own entry. Sorted by label, so the
 * dropdown is stable.
 */
export const listByokModelChoices = ({
  settings,
  modelsByProviderId,
}: {|
  settings: ByokSettings,
  modelsByProviderId: { [providerId: string]: Array<string> },
|}): Array<ByokModelChoice> => {
  const choices: Array<ByokModelChoice> = [];
  for (const provider of settings.providers) {
    const models = modelsByProviderId[provider.id] || [];
    for (const modelName of models) {
      choices.push({
        providerId: provider.id,
        providerName: provider.name,
        modelName,
        label: `${provider.name}/${modelName}`,
      });
    }
  }
  const globalModels = modelsByProviderId[''] || [];
  for (const modelName of globalModels) {
    choices.push({
      providerId: '',
      providerName: 'Default',
      modelName,
      label: `Default/${modelName}`,
    });
  }

  const seenLabels: Set<string> = new Set();
  const uniqueChoices: Array<ByokModelChoice> = [];
  for (const choice of choices) {
    if (seenLabels.has(choice.label)) continue;
    seenLabels.add(choice.label);
    uniqueChoices.push(choice);
  }
  return uniqueChoices.sort((a, b) => (a.label < b.label ? -1 : 1));
};

/**
 * The Phase 13.4 routing-pair migration: profiles saved by the older
 * settings UI carry a model name but no provider id — the model then went
 * to the global endpoint. With provider+model pairs, such a profile falls
 * back to the first registered provider (the legacy single endpoint, once
 * migrated). Returns a settings copy with the profiles filled in, or null
 * when there was nothing to migrate (pure; the caller decides to persist).
 */
export const migrateByokRoutingProfiles = (
  settings: ByokSettings
): ByokSettings | null => {
  if (settings.providers.length === 0) return null;
  const fallbackProviderId = settings.providers[0].id;
  let didChange = false;
  const migrateProfile = (profile: ByokModelProfile): ByokModelProfile => {
    if (!profile.modelName.trim()) return profile;
    if (
      profile.providerId &&
      settings.providers.some(provider => provider.id === profile.providerId)
    ) {
      return profile;
    }
    if (profile.providerId === fallbackProviderId) return profile;
    didChange = true;
    return { ...profile, providerId: fallbackProviderId };
  };
  const fastProfile = migrateProfile(settings.fastProfile);
  const strongProfile = migrateProfile(settings.strongProfile);
  if (!didChange) return null;
  return { ...settings, fastProfile, strongProfile };
};
