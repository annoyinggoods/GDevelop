// @flow
import {
  makeDefaultByokCapabilityRecord,
  type ByokCapabilityRecord,
  type ByokConnection,
  type ByokSettings,
} from './ByokTypes';
import { sendByokChatCompletion } from './ByokClient';

/**
 * The per (endpoint, model) capability cache (Phase 9.5): what an endpoint
 * was probed — or seen — to support, remembered in the settings so the same
 * feature is never re-attempted (and never 400-ed) again on later turns.
 *
 * Two of the fields are *remembered failures* rather than probes:
 * `reasoningEffortDegraded` (the audit's repeated-400 finding: once an
 * endpoint rejected `reasoning_effort`, later turns send none) and `images:
 * false` (the Phase 6 auto-detect result, remembered per model instead of
 * being re-discovered every chat). The probe fields the app never sends by
 * itself (`strictSchemas`, `parallelToolCalls`) degrade to `false` — the
 * behavior already in place client-side — when a probe fails.
 */

/** The cache key of one (endpoint, model) pair. */
export const makeByokCapabilityTargetKey = (
  baseUrl: string,
  modelName: string
): string => `${baseUrl.trim().replace(/\/+$/, '')}::${modelName}`;

/**
 * The remembered record for a target, or null when nothing was probed.
 * The record comes from the preferences blob (untrusted data): every field
 * is narrowed before use, a malformed record reads as "nothing known".
 */
export const getByokCapabilityRecord = (
  settings: ByokSettings,
  baseUrl: string,
  modelName: string
): ?ByokCapabilityRecord => {
  const rawRecord =
    settings.capabilitiesByTargetKey[
      makeByokCapabilityTargetKey(baseUrl, modelName)
    ];
  if (!rawRecord || typeof rawRecord !== 'object') return null;
  const raw: Object = rawRecord;
  return {
    images: typeof raw.images === 'boolean' ? raw.images : null,
    effortLevels: Array.isArray(raw.effortLevels)
      ? raw.effortLevels.filter(level => typeof level === 'string' && !!level)
      : null,
    reasoningEffortDegraded: raw.reasoningEffortDegraded === true,
    strictSchemas:
      typeof raw.strictSchemas === 'boolean' ? raw.strictSchemas : null,
    parallelToolCalls:
      typeof raw.parallelToolCalls === 'boolean' ? raw.parallelToolCalls : null,
    updatedAt:
      typeof raw.updatedAt === 'string'
        ? raw.updatedAt
        : new Date().toISOString(),
  };
};

/**
 * Merge a patch into the record of a target and return the partial
 * settings object to spread into the preferences (`updateByokSetting`).
 * A missing record is created on first write.
 */
export const patchByokCapabilityRecord = (
  settings: ByokSettings,
  baseUrl: string,
  modelName: string,
  patch: Partial<ByokCapabilityRecord>
): {| capabilitiesByTargetKey: { [string]: ByokCapabilityRecord } |} => {
  const key = makeByokCapabilityTargetKey(baseUrl, modelName);
  const existing =
    settings.capabilitiesByTargetKey[key] || makeDefaultByokCapabilityRecord();
  const nextRecord: ByokCapabilityRecord = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  return {
    capabilitiesByTargetKey: {
      ...settings.capabilitiesByTargetKey,
      [key]: nextRecord,
    },
  };
};

/**
 * Remember that an endpoint rejected the `reasoning_effort` parameter: the
 * caller that saw the degraded retry passes it here once, and every later
 * turn skips the parameter (the 400-dance is over).
 */
export const rememberByokReasoningEffortDegraded = (
  settings: ByokSettings,
  baseUrl: string,
  modelName: string
): {| capabilitiesByTargetKey: { [string]: ByokCapabilityRecord } |} =>
  patchByokCapabilityRecord(settings, baseUrl, modelName, {
    reasoningEffortDegraded: true,
  });

/**
 * Remember the image support of a model (the Phase 6 auto-detect outcome).
 */
export const rememberByokImageSupport = (
  settings: ByokSettings,
  baseUrl: string,
  modelName: string,
  supported: boolean
): {| capabilitiesByTargetKey: { [string]: ByokCapabilityRecord } |} =>
  patchByokCapabilityRecord(settings, baseUrl, modelName, {
    images: supported,
  });

/**
 * Read the effort levels a server lists for a model, out of a raw `/models`
 * entry (untrusted wire data). Servers vary: accept the known field names,
 * keep only the three levels the UI offers, and return null when the entry
 * lists nothing usable (the dropdown then uses its defaults).
 */
export const extractByokEffortLevels = (modelEntry: Object): ?Array<string> => {
  if (!modelEntry || typeof modelEntry !== 'object') return null;

  const candidates = [
    modelEntry.supported_reasoning_efforts,
    modelEntry.reasoning_efforts,
    modelEntry.supportedEffortLevels,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const levels = candidate.filter(
      level => level === 'low' || level === 'medium' || level === 'high'
    );
    if (levels.length > 0) return levels;
  }

  const metadata = modelEntry.metadata;
  if (metadata && typeof metadata === 'object') {
    const nested = extractByokEffortLevels(metadata);
    if (nested) return nested;
  }
  return null;
};

const PROBE_TIMEOUT_MS = 20000;

const makeProbeTool = (strict: boolean): Array<Object> => [
  {
    type: 'function',
    function: {
      name: 'report_ok',
      description: 'Report that you understood the instruction.',
      ...(strict ? { strict: true } : {}),
      parameters: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        ...(strict ? { additionalProperties: false } : {}),
      },
    },
  },
];

/**
 * Probe whether an endpoint accepts `strict` tool schemas: a minimal
 * tool-call request with a strict schema. Returns true (accepted), false
 * (rejected — the client-side validation stays the only guarantee), and
 * throws on network-level failures (the caller decides whether a probe was
 * possible at all).
 */
export const probeByokStrictSchemas = async (
  connection: ByokConnection,
  modelName: string
): Promise<boolean> => {
  await sendByokChatCompletion({
    baseUrl: connection.baseUrl,
    apiKey: connection.apiKey,
    options: {
      model: modelName,
      messages: [{ role: 'user', content: 'Call report_ok.' }],
      tools: makeProbeTool(true),
      toolChoice: 'auto',
      timeoutMs: PROBE_TIMEOUT_MS,
    },
  });
  return true;
};

/**
 * Probe whether an endpoint accepts `parallel_tool_calls: true`: a minimal
 * request carrying the flag. Same contract as `probeByokStrictSchemas`.
 */
export const probeByokParallelToolCalls = async (
  connection: ByokConnection,
  modelName: string
): Promise<boolean> => {
  await sendByokChatCompletion({
    baseUrl: connection.baseUrl,
    apiKey: connection.apiKey,
    options: {
      model: modelName,
      messages: [{ role: 'user', content: 'Call report_ok twice.' }],
      tools: makeProbeTool(false),
      toolChoice: 'auto',
      parallelToolCalls: true,
      timeoutMs: PROBE_TIMEOUT_MS,
    },
  });
  return true;
};
