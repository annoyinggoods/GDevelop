// @flow
import {
  type AiRequest,
  type AiRequestMessage,
  type AiRequestMessageAssistantFunctionCall,
} from '../../Utils/GDevelopServices/Generation';
import { type EditorFunctionCallResult } from '../../EditorFunctions';
import {
  type ExternalLayoutOutsideEditorChanges,
  type ExternalEventsOutsideEditorChanges,
} from '../../EditorFunctions/OutsideEditorChanges';
import {
  getFunctionCallsToProcess,
  getFunctionCallOutputsFromEditorFunctionCallResults,
  getLastMessagesFromAiRequestOutput,
  getLatestActivePlan,
} from '../AiRequestUtils';
import type { ByokSubAgentRunner } from './ByokSubAgents';
import {
  createByokCancellation,
  sendByokChatCompletionWithRetries,
} from './ByokClient';
import {
  classifyByokError,
  describeInvalidRequestForImageContent,
} from './ByokErrors';
import { buildByokSystemPrompt } from './ByokPrompts';
import {
  BYOK_VERIFY_TOOL_NAMES,
  buildByokCompletionGateBlock,
  checkByokCompletionGate,
  type ByokCompletionGateResult,
} from './ByokCompletionGate';
import { getByokPreviewHasCrashed } from './ByokRuntimeTools';
import { serializeToJSON } from '../../Utils/Serializer';
import { flushByokExtensionRegeneration } from './ByokExtensionTools';
import { takeByokProjectSnapshot } from './ByokFork';
import { runExclusiveByokProjectMutation } from './ByokMutationLock';
import {
  getByokAdvertisedToolNames,
  getByokDispatchableToolNames,
  getByokToolSchemasForNames,
  toOpenAiToolsFormat,
} from './ByokToolSchema';
import {
  findByNameokExtraTool,
  type ByokExtraToolCollaborators,
} from './ByokExtraTools';
import type { ByokRuntimeToolDeps } from './ByokRuntimeTools';
import {
  BYOK_LOOP_GUARD_CORRECTIVE_MESSAGE,
  createByokLoopGuard,
} from './ByokLoopGuards';
import {
  listByokSkillMetadata,
  isByokBuildIntent,
  findByNameokSkill,
} from './ByokSkills';
import { isByokEngineReferenceAvailable } from './ByokEngineReference';
import { loadByokProjectNotes } from './ByokProjectNotes';
import { makeByokPromptContext } from './Knowledge/ByokKnowledgeSections';
import {
  byokMessagesForTranscriptItem,
  byokResponseToAssistantMessage,
  byokToolResultToFunctionCallOutput,
  getByokSurvivingImageIdsExcluding,
  getByokTranscriptImageIds,
  makeByokMessageId,
  makeByokNotice,
  type ByokNoticeKind,
} from './ByokTranscript';
import { getByokImage, makeDefaultByokImageStore } from './ByokImageContent';
import {
  type ByokCancellation,
  type ByokCapabilityRecord,
  type ByokSettings,
  type ByokSharedTurnBudget,
  BYOK_GLOBAL_TURN_BUDGET,
  DEFAULT_STALL_WINDOW_SECONDS,
} from './ByokTypes';
import {
  getCachedByokModels,
  resolveContextWindowTokens,
} from './ByokModelsCache';
import { getByokProviderModelSettings } from './ByokTypes';
import {
  contextStatsFromUsage,
  usageFromResponse,
  type ByokUsageTracker,
} from './ByokUsageTracker';
import { createByokWatchdog, buildByokStallNoticeText } from './ByokWatchdog';
import {
  BYOK_COMPACTION_CONTEXT_RATIO,
  compactByokTranscript,
} from './ByokCompactor';
import {
  resolveByokModelTarget,
  resolveByokReasoningEffort,
  getByokChatModelSelection,
  type ByokCallKind,
} from './ByokModelRouter';
import { getByokCapabilityRecord } from './ByokCapabilities';

/**
 * The client-side agent loop — the BYOK replacement of GDevelop's
 * server-side orchestrator: send conversation + tool definitions → execute
 * the model's tool calls through the injected executor → feed the results
 * back → repeat until the model answers in plain text (or a guard stops
 * it).
 *
 * Everything is injected (model client, tool executor, approval, project
 * content): the orchestrator imports no React and no editor implementation,
 * which is what makes it unit-testable. The executor and the project
 * content are injected as **getters** and re-read per turn, so a chat that
 * creates its project mid-flight (initialize_project) edits it in the same
 * conversation.
 */

// The sub-agent machinery lives in ByokSubAgents (Phase 8.1); re-exported
// here because this module is where the Phase 4 null-seam promised it.
export { createByokSubAgentRunner } from './ByokSubAgents';
export type { ByokSubAgentRunner } from './ByokSubAgents';

/** Runaway protection: stop after this many model rounds of tool calls. */
export const MAX_BYOK_TOOL_ROUNDS = 20;

/**
 * Runaway protection: stop when the conversation fills this share of the
 * model's context window (the next round would re-send the whole history).
 */
export const MAX_BYOK_CONTEXT_RATIO = 0.9;

/** Safety valve on tool outputs, so one cannot blow up the context. */
export const BYOK_TOOL_OUTPUT_CAP = 20000;

/**
 * How many of the chat's most recent images are re-sent to the model (the
 * eviction rule): old screenshots are the most expensive tool payloads and
 * the least useful — a new capture is one call away.
 */
export const BYOK_IMAGES_TO_KEEP = 2;

/**
 * The plan tool: a permanent failure stub in the editor registry (it is
 * handled server-side upstream), so the orchestrator owns it — see
 * `appendPlanToolOutput`.
 */
export const BYOK_PLAN_TOOL_NAME = 'create_or_update_plan';

/**
 * The error code of the repeated-tool-call-loop guard (the BYOK counterpart
 * of the hosted protection of the same name).
 */
export const BYOK_REPEATED_TOOL_CALL_LOOP_ERROR_CODE =
  'byok-repeated-tool-call-loop';

/**
 * Errors a retry would replay identically (the transcript itself is the
 * problem — only a new chat can continue), so `retryAfterError` refuses
 * them instead of re-sending the oversized history to the endpoint.
 */
const NON_RETRYABLE_BYOK_ERROR_CODES: Set<string> = new Set([
  'byok-context-full',
  // The budget object is never replenished, so Retry re-entered the loop,
  // re-hit the exhausted budget and re-marked the identical error on every
  // click — a dead button that only re-persisted state (audit100226 LOOP-6).
  'byok-turn-budget-exhausted',
]);

/** The tool names the loop may actually dispatch to the executor. */
const DISPATCHABLE_TOOL_NAMES: Set<string> = new Set(
  getByokDispatchableToolNames()
);

/** The calls that count as verifying one's work (see ByokCompletionGate). */
const VERIFY_TOOL_NAMES: Set<string> = new Set(BYOK_VERIFY_TOOL_NAMES);

/**
 * Cap a tool output to BYOK_TOOL_OUTPUT_CAP characters, marking the cut.
 */
export const capToolOutput = (output: string): string => {
  if (output.length <= BYOK_TOOL_OUTPUT_CAP) return output;
  return `${output.slice(0, BYOK_TOOL_OUTPUT_CAP)}\n…[output truncated]`;
};

// The sub-agent machinery lives in ByokSubAgents (Phase 8.1); re-exported
// here because this module is where the Phase 4 null-seam promised it.

export type ByokOrchestratorOptions = {|
  connection: {| baseUrl: string, apiKey: string |},
  settings: ByokSettings,
  // The local chat record (from ByokChatStore): the transcript the loop
  // appends to and the UI renders.
  aiRequest: AiRequest,
  // Read live at every turn, so opening or closing a project mid-chat is
  // reflected in the system prompt instead of being frozen at creation.
  hasOpenedProject: () => boolean,
  // The current project, read at call time — the intercepted tools (local
  // event writing) work on the live project, including one created
  // mid-chat by initialize_project.
  getProject: () => any,
  // The tool executor (see createByokEditorFunctionCallExecutor in
  // ByokSeam.js), wrapping processEditorFunctionCalls — read at call time
  // so a project created mid-chat is edited with the fresh executor.
  getExecutor: () =>
    | ((
        functionCalls: Array<{|
          name: string,
          arguments: string,
          call_id: string,
        |}>,
        context: {|
          aiRequestId: string,
          getRelatedAiRequestLastMessages: () => any,
        |}
      ) => Promise<{|
        results: Array<EditorFunctionCallResult>,
        createdSceneNames: Array<string>,
        createdProject: any,
      |}>)
    | null,
  // Builds the simplified project snapshot sent to the model as the
  // request's trailing user message (the local replacement of
  // prepareAiUserContent, which uploads to GDevelop's servers) — also read
  // at call time.
  getProjectUserContent: () => Promise<string | null>,
  onAiRequestUpdated: (aiRequest: AiRequest) => void,
  // Whether a call would modify the project (byokCallRequiresApproval +
  // registry lookup, composed by the container).
  doesCallRequireApproval: (
    functionCall: AiRequestMessageAssistantFunctionCall
  ) => boolean,
  // Pause the loop for the user to approve a batch of modifying calls;
  // false refuses the batch (the chat is then suspended).
  onRequestEditApproval: (
    functionCalls: Array<AiRequestMessageAssistantFunctionCall>
  ) => Promise<boolean>,
  usageTracker: ByokUsageTracker,
  // Called after each executed batch, so the container can flag unsaved
  // changes, open created scenes and remember a created project.
  onFunctionCallsExecuted?: (
    results: Array<EditorFunctionCallResult>,
    meta: {| createdSceneNames: Array<string>, createdProject: any |}
  ) => void,
  // Passed through to the intercepted tools (ByokExtraTools) that edit the
  // events outside the events editor.
  onSceneEventsModifiedOutsideEditor?: (changes: any) => void,
  // Passed through to the intercepted tools that edit objects directly
  // (sprite frames) so open editors redraw.
  onObjectsModifiedOutsideEditor?: (changes: any) => void,
  // Passed through to the external-items tools (put_external_layout_instances,
  // add_external_events) so an already-open editor of that item redraws.
  onExternalLayoutModifiedOutsideEditor?: (
    changes: ExternalLayoutOutsideEditorChanges
  ) => void,
  onExternalEventsModifiedOutsideEditor?: (
    changes: ExternalEventsOutsideEditorChanges
  ) => void,
  // The perception tools' environment hooks (screenshots, preview capture
  // IPC, preview launcher). Absent: the perception tools answer with
  // actionable failures instead of crashing. `storeImage` overrides the
  // default image pipeline (tests).
  runtimeDeps?: {|
    captureSceneCanvas: () => ?string,
    invokePreviewCapture: (
      previewId: ?number
    ) => Promise<{| ok: boolean, data?: string, error?: string |}>,
    getPreviewLauncher: () => ?any,
    storeImage?: (dataUrl: string) => Promise<any>,
  |},
  // The storage identifier of the open project's notes (Phase 7.8): null
  // while no project is open. Used both by the update_project_notes tool
  // and to inject the notes into the system prompt.
  getProjectNotesIdentifier?: () => string | null,
  // ---- Sub-agent support (Phase 8.1; the options a CHILD gets) ----
  // Replaces the composed knowledge prompt with a fixed one (the scoped
  // charter of a sub-agent).
  systemPrompt?: string,
  // Overrides the dispatchable-tool whitelist (the read-only surface of a
  // sub-agent — enforcement happens here, not only at advertisement).
  allowedToolNames?: Array<string>,
  // Overrides the tools advertised to the model (defaults to the standard
  // advertisement rule; a sub-agent passes its read-only list).
  advertisedToolNames?: () => Array<string>,
  // Overrides the per-message tool-round budget (sub-agents get less).
  maxToolRounds?: number,
  // Shared parent+children model-turn budget: any loop finding it
  // exhausted stops (runaway-cost protection across delegation).
  sharedTurnBudget?: ByokSharedTurnBudget,
  // ---- Sub-agent support (the options a PARENT gets) ----
  // The runner of this chat's sub-agents (scout/reviewer). Absent: the
  // sub-agent tools answer with a refusal instead of crashing.
  subAgentRunner?: ByokSubAgentRunner,
  // ---- Extension regeneration (Phase 8.4) ----
  // The editor context's extension reload hooks, flushed once per batch of
  // extension tool calls (see ByokExtensionTools). Absent: the changes
  // apply, but the editor only picks them up at its next reload.
  reloadEventsFunctionsExtensions?: (project: any) => Promise<void>,
  reloadEventsFunctionsExtensionMetadata?: (
    project: any,
    extension: any
  ) => void,
  // ---- Multi-provider routing, capabilities, watchdog (Phase 9) ----
  // Live settings, read at turn time (the getters pattern): routing
  // changes and capability records written mid-chat apply from the next
  // round. Absent: the settings frozen at creation are used.
  getSettings?: () => ByokSettings,
  // The live chat record (the store copy — audit011026 B-UI-1): the
  // per-chat model/effort selection is written there by the bottom bar,
  // and the orchestrator's own closure record diverges from it after the
  // first message. Absent: the frozen `aiRequest` is used.
  getLiveAiRequest?: () => AiRequest,
  // Resolves the API key of a provider key slot (ByokKeyStorage). Absent:
  // the injected `connection.apiKey` is used for every target.
  getApiKeyForProvider?: (keyRef: string) => Promise<string>,
  // Writes a capability record patch (remembered degradation). Absent: the
  // degradations apply to the current turn only.
  onCapabilityUpdate?: (
    baseUrl: string,
    modelName: string,
    patch: Partial<ByokCapabilityRecord>
  ) => void,
  // The call kind this loop routes as ('main' for chats; sub-agents pass
  // their own kind — scout/reviewer).
  callKind?: ByokCallKind,
  // Called once the chat reaches 'ready' (the seam fetches the opt-in
  // suggestion chips there, outside the loop).
  onChatReady?: () => void,
|};

export type ByokOrchestrator = {|
  startNewChat: (
    userRequest: string,
    imageIds?: Array<string>
  ) => Promise<void>,
  sendUserMessage: (text: string, imageIds?: Array<string>) => Promise<void>,
  suspend: () => void,
  // Re-run the loop after an error without adding anything to the
  // conversation (the transcript replay is exactly a retry).
  retryAfterError: () => Promise<void>,
|};

/**
 * Map the plan tasks from their wire (snake_case) field names to the
 * internal `AiRequestPlanTask` shape the plan UI consumes — keep snake_case
 * on the wire (consistent with every other tool argument), map once here.
 */
const normalizePlanTasks = (tasks: Array<Object>): Array<Object> =>
  tasks.map(task => ({
    ...task,
    dependsOn: Array.isArray(task.depends_on) ? task.depends_on : [],
  }));

/**
 * Create the orchestrator of one BYOK chat.
 */
export const createByokOrchestrator = (
  options: ByokOrchestratorOptions
): ByokOrchestrator => {
  const {
    connection,
    settings,
    aiRequest,
    hasOpenedProject,
    getProject,
    getExecutor,
    getProjectUserContent,
    onAiRequestUpdated,
    doesCallRequireApproval,
    onRequestEditApproval,
    usageTracker,
    onFunctionCallsExecuted,
  } = options;

  let isSuspended = false;
  let isRunning = false;
  let latestProjectContent: string | null = null;
  let activeCancellation: ByokCancellation | null = null;
  const loopGuard = createByokLoopGuard();
  // ---- Completion gate state (Phase 8.2) ----
  // Whether this chat ever modified the project (the gate only runs then)
  // and whether a modifying call ran more recently than the last
  // verify-type call (the nudge condition). The one-shot flag keeps the
  // nudge from ever looping: the second claim is honored, with a warning.
  let chatMadeEdits = false;
  let turnMadeEdits = false;
  let hasEditsSinceLastVerification = false;
  let wasCompletionNudgeSent = false;
  // The whitelist actually enforced at dispatch: the standard set, or the
  // (stricter) read-only surface of a sub-agent.
  const dispatchableToolNames: Set<string> = new Set(
    options.allowedToolNames || DISPATCHABLE_TOOL_NAMES
  );
  const maxToolRounds = options.maxToolRounds || MAX_BYOK_TOOL_ROUNDS;
  // The model-turn budget shared by this chat and (when it is a parent)
  // every sub-agent it spawns; created here when nobody shared one.
  const sharedTurnBudget = options.sharedTurnBudget || {
    remaining: BYOK_GLOBAL_TURN_BUDGET,
  };
  // The image state of the chat: whether images are sent at all (settings,
  // plus the one-way auto degrade), and which ids have been EVICTED from
  // the replay. Survival is monotonic: once an image has been part of a
  // sent request it keeps replaying byte-identically until an explicit
  // context-pressure eviction — the old latest-N sliding window rewrote
  // mid-request messages on every new capture, re-busting the provider
  // prefix cache the append-only replay exists to protect.
  let imagesToKeep = BYOK_IMAGES_TO_KEEP;
  const evictedImageIds: Set<string> = new Set();
  const getReplaySurvivingImageIds = (
    transcript: Array<AiRequestMessage>
  ): Set<string> =>
    getByokSurvivingImageIdsExcluding(transcript, evictedImageIds);
  let imagesDisabledForChat = false;
  let singleInternalCallCounter = 0;
  const storeImage = makeDefaultByokImageStore();
  // The auto-suggested build-workflow skill (Phase 8.3): the body of the
  // flagship playbook, included from turn one when the first message looks
  // like a game-build request and the user did not turn the heuristic off.
  let firstUserRequestOfChat: string | null = null;
  let autoSuggestedSkillBody: string | null = null;
  let autoSuggestChecked = false;

  const getAutoSuggestedSkillBody = async (): Promise<string | null> => {
    if (autoSuggestChecked) return autoSuggestedSkillBody;
    autoSuggestChecked = true;
    if (!firstUserRequestOfChat) return null;
    if (settings.buildWorkflowAutoSuggest === false) return null;
    if (!isByokBuildIntent(firstUserRequestOfChat)) return null;
    const skill = await findByNameokSkill('build-workflow');
    // Capped (audit011026 B-PROMPT-8): this body rides INSIDE the frozen
    // system prompt, and the skills' own 32 KB cap would allow ~8k tokens
    // the budget spec never measured.
    autoSuggestedSkillBody = skill
      ? skill.body.slice(0, BYOK_AUTO_SUGGEST_SKILL_MAX_CHARS)
      : null;
    return autoSuggestedSkillBody;
  };

  // `output` is optional on the AiRequest type: normalize it once, then
  // always read it through getOutput so Flow sees a plain array.
  aiRequest.output = aiRequest.output || [];
  const getOutput = (): Array<AiRequestMessage> => aiRequest.output || [];

  // Every transcript message gets an id (Phase 8.6): the fork/restore UI
  // keys on them. Ids are unique per chat and stable across forks (copied
  // items keep theirs).
  let messageIdCounter = 0;
  const pushTranscriptMessage = (message: AiRequestMessage): void => {
    (message: any).messageId = makeByokMessageId(
      aiRequest.id,
      ++messageIdCounter
    );
    getOutput().push(message);
  };

  /**
   * Append a BYOK-local notice row (stall, compaction, rate-limit): built
   * through any because the notice type is deliberately not part of the
   * upstream transcript union — the chat UI renders it, the replay skips it.
   */
  const pushNotice = (noticeKind: ByokNoticeKind, text: string): void => {
    pushTranscriptMessage(
      ((makeByokNotice(noticeKind, text): any): AiRequestMessage)
    );
  };

  const persistUpdate = (): void => {
    onAiRequestUpdated(aiRequest);
  };

  const markReady = (): void => {
    aiRequest.status = 'ready';
    persistUpdate();
  };

  const markSuspended = (): void => {
    aiRequest.status = 'suspended';
    persistUpdate();
  };

  const markError = (code: string, message: string): void => {
    aiRequest.status = 'error';
    aiRequest.error = { code, message };
    persistUpdate();
  };

  const appendUserMessage = (
    text: string,
    images?: Array<string>
  ): AiRequestMessage => {
    const userMessage: AiRequestMessage = {
      type: 'message',
      status: 'completed',
      role: 'user',
      content: [{ type: 'user_request', status: 'completed', text }],
    };
    // Attached images (the "+" button, Phase 13.3) ride on the message as
    // ids — the same indirection the tool outputs' screenshots use, so the
    // replay and the durable sidecar both handle them for free.
    if (images && images.length > 0) {
      (userMessage: any).images = images;
    }
    pushTranscriptMessage(userMessage);
    aiRequest.status = 'working';
    aiRequest.error = null;
    persistUpdate();
    return userMessage;
  };

  // ---- Phase 9 state ----
  // The stall watchdog of the turn in flight (armed per turn, disarmed on
  // stop/suspend/ready); the loop pauses it while a model call is in flight
  // (a long call is the client timeout's business) and holds it while the
  // user is deciding on an approval row. Typed any: the reference is
  // re-assigned by armWatchdogForTurn from inside closures, which defeats
  // Flow's narrowing on every guarded call.
  let watchdog: any = null;
  // The transcript length at the last compaction: a ratio still ≥ the
  // threshold right after a compaction must not re-summarize every round.
  let lastCompactedOutputLength = -1;
  // The minimum transcript growth required between two compactions: when
  // the kept window alone keeps usage at/above the ratio, re-compacting
  // every round just summarizes the summary (one extra summarizer call +
  // a full history rewrite per round — pure churn) until the chat
  // dead-ends anyway.
  const MIN_MESSAGES_BETWEEN_COMPACTIONS = 8;
  // Whether edits happened since the project snapshot was last refreshed
  // (the per-round snapshot refresh of Phase 9.7).
  let editsSinceSnapshotRefresh = false;
  // Whether the rate-limit notice was already posted this turn (one per
  // turn, whatever the number of backoffs).
  let rateLimitNoticePostedThisTurn = false;

  /** The live settings (getters pattern), or the frozen ones. */
  const getCurrentSettings = (): ByokSettings =>
    options.getSettings ? options.getSettings() : settings;

  // The per-chat model/effort selection, read live from the store copy
  // (audit011026 B-UI-1): the bottom-bar dropdown writes it there while
  // this closure's own record diverged after the first message.
  const getCurrentChatSelection = () =>
    getByokChatModelSelection(
      options.getLiveAiRequest ? options.getLiveAiRequest() : aiRequest
    );

  /**
   * Resolve where a call of this kind goes (per-chat override > profile
   * policy > global fallback) and the API key of its provider. Throws a
   * ByokError-shaped failure when the target is misconfigured: a better
   * message now than a 404 from a half-configured provider.
   */
  const resolveConnectionForCallKind = async (
    callKind: ByokCallKind
  ): Promise<{|
    baseUrl: string,
    apiKey: string,
    modelName: string,
    temperature: ?number,
    maxTokens: ?number,
  |}> => {
    const currentSettings = getCurrentSettings();
    const chatSelection = getCurrentChatSelection();
    const target = resolveByokModelTarget({
      settings: currentSettings,
      chatSelection,
      callKind,
    });

    const provider = currentSettings.providers.find(
      entry => entry.id === target.providerId
    );
    const keyRef = provider ? provider.keyRef : '';
    if (options.getApiKeyForProvider) {
      const apiKey = await options.getApiKeyForProvider(keyRef);
      if (!apiKey) {
        throw new Error(
          `No API key is stored for the provider of ${target.modelName ||
            'this model'} — add it in Preferences > BYOK.`
        );
      }
      return {
        baseUrl: target.endpointUrl,
        apiKey,
        modelName: target.modelName,
        temperature: target.temperature,
        maxTokens: target.maxTokens,
      };
    }
    // No provider resolver injected: only the global connection exists.
    return {
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
      modelName: target.modelName || settings.modelName,
      temperature: target.temperature,
      maxTokens: target.maxTokens,
    };
  };

  /**
   * The context window of this chat's model, following the fallback chain
   * of resolveContextWindowTokens: what the server reported → the
   * provider's per-model setting (13.4) → what the user set for this model
   * → the global setting → the default. Re-read every turn so a models
   * fetch made mid-chat is picked up.
   */
  const resolveChatContextWindowTokens = (): number => {
    const currentSettings = getCurrentSettings();
    const chatSelection = getCurrentChatSelection();
    const target = resolveByokModelTarget({
      settings: currentSettings,
      chatSelection,
      callKind: options.callKind || 'main',
    });
    let cachedModels = getCachedByokModels(target.endpointUrl);
    if (!cachedModels) {
      // The legacy single-endpoint connection (tests, provider-less setups).
      cachedModels = getCachedByokModels(connection.baseUrl);
    }
    const modelName = target.modelName || settings.modelName;
    const modelInfo = cachedModels
      ? cachedModels.find(model => model.id === modelName) || null
      : null;
    const provider = currentSettings.providers.find(
      entry => entry.id === target.providerId
    );
    const providerModelSettings = provider
      ? getByokProviderModelSettings(provider, modelName)
      : null;
    return resolveContextWindowTokens(
      currentSettings,
      modelInfo,
      modelName,
      providerModelSettings ? providerModelSettings.contextWindowTokens : null
    );
  };

  /**
   * The tool names advertised this turn: the default set, plus
   * initialize_project while no project is open (read at turn time, so the
   * same chat transitions the moment its project exists) — unless this
   * orchestrator is a sub-agent with its own read-only list.
   */
  const getAdvertisedToolNames = (): Array<string> =>
    options.advertisedToolNames
      ? options.advertisedToolNames()
      : getByokAdvertisedToolNames({ hasOpenedProject: hasOpenedProject() });

  /** Whether image parts are sent to the model at all. */
  const areImagesEnabled = (): boolean =>
    settings.imageSupport !== 'no' && !imagesDisabledForChat;

  /**
   * The system prompt of this turn: the composed knowledge sections with
   * the live context (advertised tools, project notes, skills metadata,
   * custom instructions). Async: the notes and the skills metadata come
   * from async storages (localStorage reads + a possible IPC round-trip for
   * the user skills).
   *
   * Prompt-cache stability (Phase 14.1, D14-1): the prompt is composed
   * ONCE per chat and then reused byte-identical, so provider prefix
   * caches survive note writes, skill-list churn and settings edits (the
   * stateless chat/completions loop re-sends the whole prompt every round —
   * busting it from position zero ~10–20 times per task was the single
   * biggest avoidable cost). The snapshot invalidates ONLY when
   * `hasOpenedProject()` flips (a project opened or closed mid-chat — that
   * also re-advertises the tool set, which the prompt's tool line mirrors).
   * Mid-chat staleness of notes/skills/custom instructions is accepted
   * until the chat ends: the note changes come from the model's own
   * `update_project_notes` calls, which are already in the transcript.
   * Compaction keeps the same string (its history rewrite busts the cache
   * once regardless — rare by design).
   */
  /** The auto-suggested build-workflow body's char cap inside the prompt. */
  const BYOK_AUTO_SUGGEST_SKILL_MAX_CHARS = 6000;

  let systemPromptSnapshot: string | null = null;
  let systemPromptSnapshotHasProject = false;
  let systemPromptSnapshotNotesIdentifier: string | null = null;

  const buildSystemPrompt = async (): Promise<string> => {
    // A sub-agent carries a fixed, scoped charter instead of the composed
    // knowledge prompt (its context is deliberately minimal).
    if (options.systemPrompt) return options.systemPrompt;
    const hasProject = hasOpenedProject();
    const notesIdentifier = options.getProjectNotesIdentifier
      ? options.getProjectNotesIdentifier()
      : null;
    // The invalidation key carries the notes identifier, not just the
    // has-a-project boolean: switching project A→B between messages (or a
    // "Save as…" mid-chat) must move the notes — note WRITES still never
    // bust the snapshot (same identifier, cached prompt).
    if (
      systemPromptSnapshot !== null &&
      systemPromptSnapshotHasProject === hasProject &&
      systemPromptSnapshotNotesIdentifier === notesIdentifier
    ) {
      return systemPromptSnapshot;
    }
    const projectNotes = notesIdentifier
      ? await loadByokProjectNotes(notesIdentifier)
      : null;
    const skills = await listByokSkillMetadata();
    const composedPrompt = buildByokSystemPrompt({
      toolNames: getAdvertisedToolNames(),
      hasOpenedProject: hasProject,
      context: makeByokPromptContext({
        toolNames: getAdvertisedToolNames(),
        hasOpenedProject: hasProject,
        skills,
        engineReferenceAvailable: isByokEngineReferenceAvailable(),
        projectNotes,
        customInstructions: settings.customInstructions,
      }),
    });
    // The auto-suggested build-workflow skill rides along from turn one:
    // the first message looked like a game-build request, and the user did
    // not turn the heuristic off (Phase 8.3).
    const skillBody = await getAutoSuggestedSkillBody();
    const prompt = skillBody
      ? `${composedPrompt}\n\n[Auto-loaded skill: build-workflow — its pipeline applies to this conversation]\n${skillBody}`
      : composedPrompt;
    systemPromptSnapshot = prompt;
    systemPromptSnapshotHasProject = hasProject;
    systemPromptSnapshotNotesIdentifier = notesIdentifier;
    return prompt;
  };

  /**
   * The system prompt + the transcript replayed as OpenAI messages. Tool
   * outputs referencing images emit a following user message with the
   * surviving image parts (every image ever sent, minus the ones an
   * explicit context-pressure eviction dropped — see
   * getReplaySurvivingImageIds); the latest project snapshot rides its OWN synthetic user message at the
   * very tail of the request (kept out of the transcript itself, so the
   * UI never renders a JSON blob) — the same "fresh state with every
   * message" behavior as the server flow.
   *
   * Why the tail and not a fold into the last user message (the shape
   * until 2026-09-27, owner order): the transcript replay must stay
   * byte-identical APPEND-ONLY so provider prefix caches survive the whole
   * agent loop. Folding rewrote a message that sits MID-request once tool
   * rounds append after it, and the Phase 9.7 per-round snapshot refresh
   * (maybeRefreshProjectSnapshot) re-busted the prefix from that message
   * on every editing round — in a 50–100-round build turn, everything
   * after the system prompt was re-paid almost every round. As the last
   * message, the refreshing snapshot only ever changes the request's final
   * message; everything before it (system + tools + the whole transcript)
   * stays cacheable prefix.
   */
  const buildMessagesForModel = async (): Promise<Array<any>> => {
    const transcript = getOutput();
    const transcriptMessages: Array<any> = [];
    for (const item of transcript) {
      transcriptMessages.push(
        ...byokMessagesForTranscriptItem(item, {
          imagesEnabled: areImagesEnabled(),
          survivingImageIds: getReplaySurvivingImageIds(transcript),
          getImage: getByokImage,
        })
      );
    }
    const messages: Array<any> = [
      {
        role: 'system',
        content: await buildSystemPrompt(),
      },
      ...transcriptMessages,
    ];

    if (!latestProjectContent) return messages;

    messages.push({
      role: 'user',
      content: `[Current simplified project snapshot, as JSON — may be slightly stale after your edits]\n${latestProjectContent}`,
    });
    return messages;
  };

  /** True when any message of the request carries image parts. */
  const doMessagesCarryImages = (messages: Array<any>): boolean => {
    return messages.some(message => {
      if (message.role !== 'user' || !Array.isArray(message.content)) {
        return false;
      }
      return message.content.some(
        (part: any) => part && part.type === 'image_url'
      );
    });
  };

  const callModel = async (): Promise<any> => {
    const currentSettings = getCurrentSettings();
    const {
      baseUrl,
      apiKey,
      modelName,
      temperature,
      maxTokens,
    } = await resolveConnectionForCallKind(options.callKind || 'main');
    const capabilityRecord = getByokCapabilityRecord(
      currentSettings,
      baseUrl,
      modelName
    );
    const chatSelection = getCurrentChatSelection();
    const messages = await buildMessagesForModel();
    const chatOptions: any = {
      model: modelName,
      messages,
      tools: toOpenAiToolsFormat(
        getByokToolSchemasForNames(getAdvertisedToolNames())
      ),
    };
    // The per-model settings (Phase 13.4) and profile advanced fields: the
    // router resolved them for THIS call; an omitted max_tokens makes small
    // local models ramble until their context is exhausted.
    if (typeof temperature === 'number') {
      chatOptions.temperature = temperature;
    }
    if (typeof maxTokens === 'number') {
      chatOptions.maxTokens = maxTokens;
    }
    // The remembered degradation wins (no per-turn 400-dance): a model that
    // once rejected `reasoning_effort` never sees the parameter again.
    const reasoningEffort = resolveByokReasoningEffort({
      settings: currentSettings,
      chatSelection,
      capabilityRecord,
    });
    if (reasoningEffort) {
      chatOptions.reasoningEffort = reasoningEffort;
    }
    if (capabilityRecord && capabilityRecord.parallelToolCalls === false) {
      chatOptions.parallelToolCalls = false;
    }
    if (activeCancellation) {
      chatOptions.cancellation = activeCancellation;
    }

    try {
      return await sendByokChatCompletionWithRetries({
        baseUrl,
        apiKey,
        options: chatOptions,
        onReasoningEffortDegraded: () => {
          if (options.onCapabilityUpdate) {
            options.onCapabilityUpdate(baseUrl, modelName, {
              reasoningEffortDegraded: true,
            });
          }
        },
        onRateLimitWait: waitMs => {
          if (rateLimitNoticePostedThisTurn) return;
          rateLimitNoticePostedThisTurn = true;
          pushNotice(
            'rate-limited',
            `[byok-notice] The endpoint is rate-limiting the requests — waiting ${Math.round(
              waitMs / 1000
            )}s before retrying.`
          );
          persistUpdate();
        },
      });
    } catch (error) {
      // The endpoint may not see images at all (a text-only model): in
      // auto mode, degrade the chat to text-only and retry once — the
      // mirror of the reasoning_effort degraded-retry. The outcome is
      // remembered per model (the capability cache), so no future chat has
      // to rediscover it.
      const byokError = classifyByokError(error);
      const shouldDegrade =
        settings.imageSupport === 'auto' &&
        !imagesDisabledForChat &&
        doMessagesCarryImages(messages) &&
        describeInvalidRequestForImageContent(byokError);
      if (!shouldDegrade) throw error;

      imagesDisabledForChat = true;
      if (options.onCapabilityUpdate) {
        options.onCapabilityUpdate(baseUrl, modelName, { images: false });
      }
      console.info(
        'BYOK orchestrator: the endpoint rejected image content — continuing this chat text-only.'
      );
      const degradedOptions: any = {
        ...chatOptions,
        messages: await buildMessagesForModel(),
      };
      return await sendByokChatCompletionWithRetries({
        baseUrl,
        apiKey,
        options: degradedOptions,
      });
    }
  };

  const recordAssistantTurn = (response: any): void => {
    pushTranscriptMessage(byokResponseToAssistantMessage(response));

    const usage = usageFromResponse(response);
    if (usage) {
      usageTracker.recordTurn(usage);
      aiRequest.contextStats = contextStatsFromUsage(
        usage,
        resolveChatContextWindowTokens()
      );
    }
    persistUpdate();
  };

  const collectPendingToolCalls = (): Array<AiRequestMessageAssistantFunctionCall> => {
    return getFunctionCallsToProcess({
      aiRequest,
      editorFunctionCallResults: null,
    });
  };

  /**
   * True when the last recorded assistant message carries answer text — an
   * answer with neither text nor tool calls cannot move the conversation
   * forward (e.g. a truncated or content-filtered response).
   */
  const hasRecordedAnswerText = (): boolean => {
    const output = getOutput();
    const lastMessage = output.length > 0 ? output[output.length - 1] : null;
    if (!lastMessage || lastMessage.type !== 'message') return false;
    if (lastMessage.role !== 'assistant') return false;
    return lastMessage.content.some(item => item.type === 'output_text');
  };

  /**
   * Record a batch as not executed: one output per call, so the transcript
   * stays a valid OpenAI conversation (an assistant message with tool_calls
   * must be followed by tool messages) and the model can be told what
   * happened when the chat continues.
   */
  const appendNotExecutedToolOutputs = (
    functionCalls: Array<AiRequestMessageAssistantFunctionCall>,
    message: string
  ): void => {
    for (const functionCall of functionCalls) {
      pushTranscriptMessage(
        byokToolResultToFunctionCallOutput(
          functionCall.call_id,
          capToolOutput(JSON.stringify({ success: false, message }))
        )
      );
    }
  };

  /**
   * The transcript's protocol rule: every assistant tool_call needs a
   * matching tool output, or strict endpoints reject every later replay of
   * the chat with a 400 — and Retry replays the same broken transcript, so
   * the chat is bricked until the user starts over (the audit011026
   * B-CORE-2 brick class).
   *
   * Every path that dispatches calls is expected to answer them, but a
   * future unprotected `await` between the assistant message and the
   * outputs would silently reintroduce that failure. This sweep runs at
   * the end of every batch and answers ONLY the calls still missing one,
   * so it can never duplicate an output.
   */
  const answerPendingToolCalls = (
    functionCalls: Array<AiRequestMessageAssistantFunctionCall>,
    message: string
  ): void => {
    const answeredCallIds = new Set<string>();
    for (const transcriptMessage of getOutput()) {
      if (transcriptMessage.type === 'function_call_output') {
        answeredCallIds.add(transcriptMessage.call_id);
      }
    }
    const pendingCalls = functionCalls.filter(
      functionCall => !answeredCallIds.has(functionCall.call_id)
    );
    appendNotExecutedToolOutputs(pendingCalls, message);
  };

  /**
   * Handle `create_or_update_plan` here instead of the editor executor (its
   * registry implementation always fails — "handled server-side" upstream):
   * echo the tasks back as the `plan` output the chat UI's plan component
   * renders (see getLatestActivePlan in AiRequestUtils.js). Returns true
   * when the call was handled here.
   */
  const appendPlanToolOutput = (
    functionCall: AiRequestMessageAssistantFunctionCall
  ): boolean => {
    if (functionCall.name !== BYOK_PLAN_TOOL_NAME) return false;

    let tasks = null;
    try {
      tasks = JSON.parse(functionCall.arguments).tasks;
    } catch (error) {
      // Invalid JSON: reported as a failure output below.
    }
    const output =
      tasks && Array.isArray(tasks)
        ? { success: true, plan: { tasks: normalizePlanTasks(tasks) } }
        : {
            success: false,
            message: 'Invalid arguments: a "tasks" array is required.',
          };
    pushTranscriptMessage(
      byokToolResultToFunctionCallOutput(
        functionCall.call_id,
        capToolOutput(JSON.stringify(output))
      )
    );
    return true;
  };

  /** Parse the arguments of a call, or null when they are not valid JSON. */
  const parseCallArguments = (
    functionCall: AiRequestMessageAssistantFunctionCall
  ): any => {
    try {
      return JSON.parse(functionCall.arguments);
    } catch (error) {
      return null;
    }
  };

  // ---- Completion gate helpers (Phase 8.2) ----

  /**
   * Serialize the live project the way snapshots do; null when there is no
   * project or the serialization fails (both are gate failures).
   */
  const serializeProjectForGate = (): ?string => {
    const project = getProject();
    if (!project) return null;
    try {
      return serializeToJSON(project);
    } catch (error) {
      console.error('BYOK orchestrator: gate serialization failed:', error);
      return null;
    }
  };

  /** The one-shot nudge turn: a user-role message the model must answer. */
  const appendCompletionNudge = (message: string): void => {
    pushTranscriptMessage({
      type: 'message',
      status: 'completed',
      role: 'user',
      content: [{ type: 'user_request', status: 'completed', text: message }],
    });
    persistUpdate();
  };

  /**
   * Attach the gate's evidence block to the final assistant message (an
   * extra text item — visible in the chat, both when it passes and when
   * the claim was honored despite a warning).
   */
  const appendCompletionGateBlock = (
    gateResult: ByokCompletionGateResult
  ): void => {
    const output = getOutput();
    const lastMessage = output.length > 0 ? output[output.length - 1] : null;
    if (!lastMessage || lastMessage.type !== 'message') return;
    if (lastMessage.role !== 'assistant') return;
    // The content items are the assistant-message union: Flow cannot prove
    // the pushed variant matches, the mapper above produces it.
    const content: Array<any> = lastMessage.content;
    content.push({
      type: 'output_text',
      status: 'completed',
      text: buildByokCompletionGateBlock(gateResult),
      annotations: [],
    });
    persistUpdate();
  };

  /**
   * The perception tools' collaborators, assembled from the orchestrator's
   * injected hooks: the image pipeline, the single-call executor (built on
   * the same executor as normal batches) and the environment hooks the
   * container provides. Null when the host supplied none — the tools then
   * answer with actionable failures.
   */
  const getExtraToolRuntimeDeps = (): ?ByokRuntimeToolDeps => {
    if (!options.runtimeDeps) return null;
    return {
      getProject,
      captureSceneCanvas: options.runtimeDeps.captureSceneCanvas,
      invokePreviewCapture: options.runtimeDeps.invokePreviewCapture,
      getPreviewLauncher: options.runtimeDeps.getPreviewLauncher,
      storeImage: options.runtimeDeps.storeImage || storeImage,
      executeSingleToolCall: async (name, args) => {
        const executor = getExecutor();
        if (!executor) {
          throw new Error('The editor is not ready to run this tool call.');
        }
        singleInternalCallCounter++;
        const execution = await executor(
          [
            {
              name,
              arguments: JSON.stringify(args),
              call_id: `byok-internal-${singleInternalCallCounter}`,
            },
          ],
          {
            aiRequestId: aiRequest.id,
            getRelatedAiRequestLastMessages: () =>
              getLastMessagesFromAiRequestOutput(getOutput()),
          }
        );
        return execution.results[0];
      },
    };
  };

  /**
   * Run one call through the interception registry (ByokExtraTools) — the
   * tools resolved before the editor registry, e.g. the fully local
   * add_scene_events. The output is appended to the transcript and a
   * result shaped like the editor runner's is returned, so approval
   * gating, unsaved-changes tracking and onFunctionCallsExecuted see the
   * same shape as for registry tools. Returns null when the name is not
   * intercepted.
   */
  const runExtraToolCall = async (
    functionCall: AiRequestMessageAssistantFunctionCall
  ): Promise<EditorFunctionCallResult | null> => {
    const extraTool = findByNameokExtraTool(functionCall.name);
    if (!extraTool) return null;

    const collaborators: ByokExtraToolCollaborators = {
      getProject,
      // The id of the chat whose tool batch this is (the restore-point
      // tool keys the snapshot store on it).
      byokChatId: aiRequest.id,
      onSceneEventsModifiedOutsideEditor: changes => {
        if (options.onSceneEventsModifiedOutsideEditor) {
          options.onSceneEventsModifiedOutsideEditor(changes);
        }
      },
      onObjectsModifiedOutsideEditor: changes => {
        if (options.onObjectsModifiedOutsideEditor) {
          options.onObjectsModifiedOutsideEditor(changes);
        }
      },
      onExternalLayoutModifiedOutsideEditor: changes => {
        if (options.onExternalLayoutModifiedOutsideEditor) {
          options.onExternalLayoutModifiedOutsideEditor(changes);
        }
      },
      onExternalEventsModifiedOutsideEditor: changes => {
        if (options.onExternalEventsModifiedOutsideEditor) {
          options.onExternalEventsModifiedOutsideEditor(changes);
        }
      },
      runtimeDeps: getExtraToolRuntimeDeps() || undefined,
      // The sub-agent tools (run_explorer_agent / run_review_agent)
      // resolve here before the editor registry, whose implementations are
      // server stubs. A sub-agent's own collaborators carry NO runner:
      // that is what structurally refuses nesting (one level only).
      runSubAgent: options.subAgentRunner
        ? options.subAgentRunner.runSubAgent
        : undefined,
      // The extension regeneration hooks (Phase 8.4), flushed once per
      // batch after the loop (not per call).
      reloadEventsFunctionsExtensions: options.reloadEventsFunctionsExtensions,
      reloadEventsFunctionsExtensionMetadata:
        options.reloadEventsFunctionsExtensionMetadata,
      // The docs tools may fetch missing pages online only if the user
      // opted in (offline-first, see ByokDocs.js).
      onlineDocsEnabled: settings.onlineDocsEnabled,
      getProjectNotesIdentifier: () =>
        options.getProjectNotesIdentifier
          ? options.getProjectNotesIdentifier()
          : null,
    };
    const parsedArguments = parseCallArguments(functionCall);
    try {
      const { output, didModifyProject, images } = await extraTool.run(
        parsedArguments || {},
        collaborators
      );
      pushTranscriptMessage(
        byokToolResultToFunctionCallOutput(
          functionCall.call_id,
          capToolOutput(JSON.stringify(output)),
          images
        )
      );
      return {
        status: 'finished',
        call_id: functionCall.call_id,
        success: !!output.success,
        output,
        ...(didModifyProject ? { didModifyProject: true } : {}),
      };
    } catch (error) {
      console.error(
        `BYOK orchestrator: intercepted tool "${functionCall.name}" crashed:`,
        error
      );
      const output = {
        success: false,
        message: `The tool execution crashed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
      pushTranscriptMessage(
        byokToolResultToFunctionCallOutput(
          functionCall.call_id,
          capToolOutput(JSON.stringify(output))
        )
      );
      return {
        status: 'finished',
        call_id: functionCall.call_id,
        success: false,
        output,
      };
    }
  };

  /**
   * Append the outputs of an executed batch. A result that never finished
   * (status `aborted` or `working`) leaves its call without an output, which
   * would make the transcript protocol-invalid — those calls get a failure
   * output instead, so the conversation can continue.
   */
  const appendExecutedBatchOutputs = (
    results: Array<EditorFunctionCallResult>,
    executedCalls: Array<AiRequestMessageAssistantFunctionCall>
  ): void => {
    const {
      functionCallOutputs,
      hasUnfinishedResult,
    } = getFunctionCallOutputsFromEditorFunctionCallResults(results);
    for (const functionCallOutput of functionCallOutputs) {
      pushTranscriptMessage({
        ...functionCallOutput,
        output: capToolOutput(functionCallOutput.output),
      });
    }

    if (!hasUnfinishedResult) return;

    const callIdsWithOutput = new Set(
      results
        .filter(result => result.status === 'finished')
        .map(result => result.call_id)
    );
    const unfinishedCalls = executedCalls.filter(
      call => !callIdsWithOutput.has(call.call_id)
    );
    appendNotExecutedToolOutputs(
      unfinishedCalls,
      'The tool was aborted before finishing. Check the current state with the read tools, then continue.'
    );
  };

  /**
   * Split a batch by the loop guard: 'ok' calls proceed, 'corrective'
   * calls are refused with the corrective message (the model gets one
   * chance to change course), and a 'stop' verdict refuses the call and
   * everything after it.
   */
  const splitBatchByLoopGuard = (
    functionCalls: Array<AiRequestMessageAssistantFunctionCall>
  ): {|
    proceedingCalls: Array<AiRequestMessageAssistantFunctionCall>,
    correctedCalls: Array<AiRequestMessageAssistantFunctionCall>,
    droppedAfterStopCalls: Array<AiRequestMessageAssistantFunctionCall>,
    stoppedAtCall: AiRequestMessageAssistantFunctionCall | null,
  |} => {
    const proceedingCalls: Array<AiRequestMessageAssistantFunctionCall> = [];
    const correctedCalls: Array<AiRequestMessageAssistantFunctionCall> = [];
    const droppedAfterStopCalls: Array<AiRequestMessageAssistantFunctionCall> = [];
    let stoppedAtCall: AiRequestMessageAssistantFunctionCall | null = null;

    loopGuard.beginBatch();
    for (const functionCall of functionCalls) {
      if (stoppedAtCall) {
        droppedAfterStopCalls.push(functionCall);
        continue;
      }
      const verdict = loopGuard.checkCall(
        functionCall.name,
        parseCallArguments(functionCall)
      );
      if (verdict === 'stop') {
        stoppedAtCall = functionCall;
        continue;
      }
      if (verdict === 'corrective') {
        correctedCalls.push(functionCall);
        continue;
      }
      // The fingerprint is recorded HERE, after the guard's verdict but
      // BEFORE the approval gate; the executed-recording below replaces it
      // once the call really runs (audit100226 TOOL-7).
      proceedingCalls.push(functionCall);
    }
    return {
      proceedingCalls,
      correctedCalls,
      droppedAfterStopCalls,
      stoppedAtCall,
    };
  };

  /**
   * Execute a batch of tool calls: loop-guard them, ask for the user's
   * approval of the modifying ones, run the batch (plan tool and
   * intercepted tools here, everything else through the editor executor),
   * then append the (capped) outputs to the transcript. Returns false when
   * the loop must stop (edit refused, stuck loop, or the chat was
   * suspended mid-flight).
   */
  const executeToolCalls = async (
    functionCalls: Array<AiRequestMessageAssistantFunctionCall>
  ): Promise<boolean> => {
    // The user may have pressed stop while the model call was in flight: an
    // arrived batch must not execute (nor ask for approval) after a
    // suspension.
    if (isSuspended) {
      appendNotExecutedToolOutputs(
        functionCalls,
        'The assistant was stopped before running this tool call. Send a new message to continue.'
      );
      persistUpdate();
      return false;
    }

    // The whitelist is enforced again at dispatch: some OpenAI-compatible
    // servers do not constrain the model to the advertised tool list, so a
    // hallucinated name must be answered with a refusal, not executed.
    const whitelistedCalls: Array<AiRequestMessageAssistantFunctionCall> = [];
    const rejectedCalls: Array<AiRequestMessageAssistantFunctionCall> = [];
    for (const functionCall of functionCalls) {
      if (dispatchableToolNames.has(functionCall.name)) {
        whitelistedCalls.push(functionCall);
        continue;
      }
      rejectedCalls.push(functionCall);
    }
    for (const rejectedCall of rejectedCalls) {
      appendNotExecutedToolOutputs(
        [rejectedCall],
        `The tool "${
          rejectedCall.name
        }" is not available in BYOK chats. Only use the tools listed in the system prompt.`
      );
    }
    if (whitelistedCalls.length === 0) {
      // The loop continues so the model is told about the refusals and can
      // correct itself.
      persistUpdate();
      return true;
    }

    // The stuck-loop guard: refuse a third identical call with a
    // corrective message, stop the chat on the fourth.
    const {
      proceedingCalls,
      correctedCalls,
      droppedAfterStopCalls,
      stoppedAtCall,
    } = splitBatchByLoopGuard(whitelistedCalls);
    if (stoppedAtCall) {
      appendNotExecutedToolOutputs(
        [stoppedAtCall],
        BYOK_LOOP_GUARD_CORRECTIVE_MESSAGE
      );
      // Every other call of the batch needs its tool output too: an
      // orphaned tool_call (no matching tool message) makes the transcript
      // protocol-invalid, and strict endpoints then reject every later
      // replay of this chat with a 400 — the same integrity rule the
      // context-full path follows for a whole pending batch.
      appendNotExecutedToolOutputs(
        proceedingCalls.concat(correctedCalls).concat(droppedAfterStopCalls),
        'The chat was stopped because the assistant repeated the same tool call. This call was not run — send a new message to continue with a different approach.'
      );
      markError(
        BYOK_REPEATED_TOOL_CALL_LOOP_ERROR_CODE,
        'The assistant got stuck repeating the same tool call. Send a new message to continue with a different approach.'
      );
      return false;
    }
    for (const correctedCall of correctedCalls) {
      appendNotExecutedToolOutputs(
        [correctedCall],
        BYOK_LOOP_GUARD_CORRECTIVE_MESSAGE
      );
    }
    if (proceedingCalls.length === 0) {
      persistUpdate();
      return true;
    }

    const modifyingCalls = proceedingCalls.filter(doesCallRequireApproval);
    if (modifyingCalls.length > 0) {
      // While the user decides, they are not witnessing a stall: holding
      // the watchdog (the approval request itself was the last activity).
      if (watchdog) watchdog.holdForApproval();
      let approved = false;
      try {
        approved = await onRequestEditApproval(modifyingCalls);
      } catch (error) {
        // A rejecting approval prompt (a closed dialog, an unmounted
        // container) must not orphan the batch's tool_calls: see
        // answerPendingToolCalls below.
        console.error(
          'BYOK orchestrator: the edit approval request failed:',
          error
        );
      }
      if (watchdog) {
        watchdog.releaseApproval();
        watchdog.notifyActivity('approval-released');
      }
      // The user may have pressed stop while the approval row was open: an
      // approved batch must not run after a suspension either.
      if (isSuspended) {
        appendNotExecutedToolOutputs(
          proceedingCalls,
          'The assistant was stopped before running this tool call. Send a new message to continue.'
        );
        loopGuard.restoreBatch();
        persistUpdate();
        return false;
      }
      if (!approved) {
        appendNotExecutedToolOutputs(
          proceedingCalls,
          'The user refused this edit. Ask them how to proceed before trying again.'
        );
        // A refused batch executed nothing, so its fingerprints must not
        // count toward the stuck-loop thresholds (audit100226 TOOL-7).
        loopGuard.restoreBatch();
        markSuspended();
        return false;
      }
    }

    // The plan tool is handled by the orchestrator itself; intercepted
    // tools (ByokExtraTools) run here; everything else goes to the editor
    // executor. The intercepted tools that upstream also implements (the
    // extension authoring ones) carry a `_BYOK` suffix, so no name can
    // reach the wrong implementation.
    const editorFunctionCalls = [];
    const extraToolCalls = [];
    for (const functionCall of proceedingCalls) {
      if (appendPlanToolOutput(functionCall)) continue;
      if (findByNameokExtraTool(functionCall.name)) {
        extraToolCalls.push(functionCall);
        continue;
      }

      editorFunctionCalls.push(functionCall);
    }

    if (editorFunctionCalls.length === 0 && extraToolCalls.length === 0) {
      persistUpdate();
      return true;
    }

    // Mutation door (audit100226 UP-11): this whole execution section — the
    // intercepted tools, the extensions reload and the editor batch — runs
    // exclusively against the project, so an MCP call (which takes the same
    // lock) can never interleave gd.* changes with a chat round. The model
    // request before it and the approval prompt are OUTSIDE the lock, so a
    // chat never blocks MCP while the model is thinking.
    const {
      executedResults,
      createdSceneNames,
      createdProject,
    } = await runExclusiveByokProjectMutation(
      async (): Promise<{|
        executedResults: Array<EditorFunctionCallResult>,
        createdSceneNames: Array<string>,
        createdProject: any,
      |}> => {
        const results: Array<EditorFunctionCallResult> = [];
        let sceneNames: Array<string> = [];
        let newProject: any = null;

        if (watchdog) watchdog.notifyActivity('tool-executing');
        for (const extraToolCall of extraToolCalls) {
          // Per-call activity: one extra tool can legitimately run for minutes
          // (a sub-agent's whole child loop, a resource download, a profiler
          // wait) — a single batch-level ping would let the watchdog post
          // false "no activity" stall notices while tools are working.
          if (watchdog) watchdog.notifyActivity('tool-executing');
          const result = await runExtraToolCall(extraToolCall);
          if (result) results.push(result);
        }

        // The extension authoring tools regenerate the editor's view of the
        // extensions ONCE for the whole batch (the v18 lesson) — not after
        // every single call. The reload is an editor side effect: a project
        // with a broken generated extension can make it throw, and an
        // exception escaping here would leave the editor calls of this batch
        // without their tool outputs (see answerPendingToolCalls).
        try {
          await flushByokExtensionRegeneration(getProject(), {
            reloadEventsFunctionsExtensions:
              options.reloadEventsFunctionsExtensions,
            reloadEventsFunctionsExtensionMetadata:
              options.reloadEventsFunctionsExtensionMetadata,
          });
        } catch (error) {
          console.error(
            'BYOK orchestrator: the extensions reload after the batch failed:',
            error
          );
        }

        // Tool failures are not thrown: a failed editor function becomes a
        // `function_call_output` with success:false and the error text, and the
        // loop continues so the model can correct itself — exactly like the
        // server-side loop. A crash of the executor itself (outside the per-call
        // containment) is contained the same way, so the transcript always ends
        // with an output for every dispatched call.
        if (editorFunctionCalls.length > 0) {
          const executor = getExecutor();
          if (!executor) {
            appendNotExecutedToolOutputs(
              editorFunctionCalls,
              'The editor is not ready to run this tool call. Send a new message to retry.'
            );
          } else {
            try {
              // Same per-call rationale as the extra-tool loop: one editor
              // batch can wait on a preview, a test run or an approval.
              if (watchdog) watchdog.notifyActivity('tool-executing');
              const execution = await executor(
                editorFunctionCalls.map(functionCall => ({
                  name: functionCall.name,
                  arguments: functionCall.arguments,
                  call_id: functionCall.call_id,
                })),
                {
                  aiRequestId: aiRequest.id,
                  getRelatedAiRequestLastMessages: () =>
                    getLastMessagesFromAiRequestOutput(getOutput()),
                }
              );
              appendExecutedBatchOutputs(
                execution.results,
                editorFunctionCalls
              );
              results.push(...execution.results);
              sceneNames = execution.createdSceneNames;
              newProject = execution.createdProject;
            } catch (error) {
              console.error(
                'BYOK orchestrator: tool execution crashed:',
                error
              );
              appendNotExecutedToolOutputs(
                editorFunctionCalls,
                `The tool execution crashed: ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
            }
          }
        }

        return {
          executedResults: results,
          createdSceneNames: sceneNames,
          createdProject: newProject,
        };
      }
    );

    // The protocol safety net: anything dispatched above without an output
    // (a path that returned early, or an await that threw past its own
    // containment) is answered here so the persisted transcript can never
    // replay as an invalid request.
    answerPendingToolCalls(
      proceedingCalls,
      'This tool call did not complete. Send a new message to continue.'
    );

    persistUpdate();
    if (watchdog) watchdog.notifyActivity('tool-output-posted');

    // Completion-gate tracking (Phase 8.2): a verify-type call in the batch
    // clears the "edits since last verification" flag, a modifying result
    // sets it back (modifications win when a batch did both — the safe
    // direction for the nudge).
    if (proceedingCalls.some(call => VERIFY_TOOL_NAMES.has(call.name))) {
      hasEditsSinceLastVerification = false;
    }
    if (
      executedResults.some(
        result => result.status === 'finished' && result.didModifyProject
      )
    ) {
      chatMadeEdits = true;
      turnMadeEdits = true;
      hasEditsSinceLastVerification = true;
      editsSinceSnapshotRefresh = true;
    }

    if (onFunctionCallsExecuted) {
      try {
        onFunctionCallsExecuted(executedResults, {
          createdSceneNames,
          createdProject,
        });
      } catch (error) {
        // The batch ran and its outputs are recorded: a throwing
        // follow-up (e.g. opening a scene) must not corrupt the chat.
        console.error(
          'BYOK orchestrator: onFunctionCallsExecuted callback threw:',
          error
        );
      }
    }

    // A project created mid-chat (initialize_project) becomes the project
    // of the very next round: re-read the snapshot so the model sees what
    // it just created instead of the stale "no project" state.
    if (createdProject) {
      latestProjectContent = await getProjectUserContent();
    }
    return true;
  };

  /**
   * The preserved block of a compaction (Phase 9.2): rebuilt from explicit
   * sources, never from the model's memory of itself — the durable project
   * notes, the current plan, the open problems (recent failed tool
   * outputs), a fresh object/scene slice, the loaded skills and the latest
   * verification summary.
   */
  const buildPreservedBlock = async (): Promise<string> => {
    const transcript = getOutput();
    const sections: Array<string> = [];

    const notesIdentifier = options.getProjectNotesIdentifier
      ? options.getProjectNotesIdentifier()
      : null;
    if (notesIdentifier) {
      try {
        const notes = await loadByokProjectNotes(notesIdentifier);
        const noteLines: Array<string> = [];
        if (notes.conventions) {
          noteLines.push(`Conventions: ${notes.conventions}`);
        }
        if (notes.inProgress) {
          noteLines.push(`In progress: ${notes.inProgress}`);
        }
        if (notes.decisions) {
          noteLines.push(`Decisions: ${notes.decisions}`);
        }
        if (noteLines.length > 0) {
          sections.push(
            `Project notes (design intent):\n${noteLines.join('\n')}`
          );
        }
      } catch (error) {
        // Notes are best-effort context.
      }
    }

    const plan = getLatestActivePlan(
      (({ output: transcript }: any): AiRequest)
    );
    if (plan) {
      const planLines = plan.tasks.map(
        task => `- [${task.status}] ${task.title}`
      );
      sections.push(`Current plan:\n${planLines.join('\n')}`);
    }

    const openProblems: Array<string> = [];
    for (const message of transcript.slice(-30)) {
      if (message.type !== 'function_call_output') continue;
      try {
        const output = JSON.parse(message.output);
        if (output && output.success === false && output.message) {
          openProblems.push(`- ${String(output.message).slice(0, 200)}`);
        }
      } catch (error) {
        // Not a JSON output: not a problem report.
      }
      if (openProblems.length >= 10) break;
    }
    if (openProblems.length > 0) {
      sections.push(
        `Open problems (recent failures):\n${openProblems.join('\n')}`
      );
    }

    // A fresh object/scene slice, capped: the full snapshot rides its own
    // trailing request message anyway (see buildMessagesForModel).
    try {
      const freshSnapshot = await getProjectUserContent();
      if (freshSnapshot) {
        sections.push(
          `Current project state (simplified, first characters):\n${freshSnapshot.slice(
            0,
            4000
          )}`
        );
      }
    } catch (error) {
      // No project open (or the fetch failed): the block simply omits it.
    }

    const loadedSkills: Array<string> = [];
    for (const message of transcript) {
      if (message.type !== 'message' || message.role !== 'assistant') continue;
      for (const item of message.content) {
        if (item.type !== 'function_call' || item.name !== 'load_skill') {
          continue;
        }
        try {
          const args = JSON.parse(item.arguments);
          // load_skill's schema and handler use `name`, not `skillName`:
          // reading the wrong key left "Loaded skills" permanently empty
          // after a compaction (audit100226 TOOL-5).
          if (args && typeof args.name === 'string') {
            loadedSkills.push(args.name);
          }
        } catch (error) {
          // Unparsable arguments: skip.
        }
      }
    }
    if (loadedSkills.length > 0) {
      sections.push(
        `Loaded skills (reload with load_skill when needed): ${Array.from(
          new Set(loadedSkills)
        ).join(', ')}`
      );
    }

    // The latest verification summary: what the last check of the work said.
    for (let index = transcript.length - 1; index >= 0; index--) {
      const message = transcript[index];
      if (message.type !== 'function_call_output') continue;
      if (message.output.includes('"success":true')) {
        sections.push(
          `Latest tool verification result:\n${message.output.slice(0, 400)}`
        );
        break;
      }
    }

    if (sections.length === 0) {
      return 'No durable context was recorded for this chat yet.';
    }
    return sections.join('\n\n');
  };

  /** The `fast`-profile summarizer call of a compaction. */
  const buildCompactionSummarizer = (): ((
    digest: string
  ) => Promise<string>) => async (digest: string): Promise<string> => {
    const {
      baseUrl,
      apiKey,
      modelName,
      temperature,
      maxTokens,
    } = await resolveConnectionForCallKind('compaction');
    const summarizerOptions: any = {
      model: modelName,
      messages: [
        {
          role: 'system',
          content:
            'You summarize the earlier part of a game-creation AI conversation. Keep every decision, name, path and unfinished task — drop pleasantries and repetition. Answer with the summary only.',
        },
        { role: 'user', content: digest },
      ],
    };
    if (typeof temperature === 'number') {
      summarizerOptions.temperature = temperature;
    }
    if (typeof maxTokens === 'number') {
      summarizerOptions.maxTokens = maxTokens;
    }
    // The summarizer is a real request against the user's key: without the
    // loop's cancellation handle, pressing Stop left it running to
    // completion plus its retries (and a rate-limit wait), contradicting
    // the client's "you stop paying the moment you press Stop" contract
    // (audit100226 LOOP-5).
    if (activeCancellation) {
      summarizerOptions.cancellation = activeCancellation;
    }
    const response = await sendByokChatCompletionWithRetries({
      baseUrl,
      apiKey,
      options: summarizerOptions,
    });
    const choice = response.choices[0];
    const message = choice ? choice.message : null;
    return message && typeof message.content === 'string'
      ? message.content
      : '';
  };

  /**
   * The compaction hook: at ≥ 75% of the context window, before the next
   * model call, summarize the old transcript half and prepend the
   * preserved block. Never fires mid-tool-batch (called at loop top, where
   * every dispatched batch already has its outputs) and never twice on an
   * unchanged transcript.
   */
  const maybeCompactTranscript = async (): Promise<void> => {
    const usedPercentage = aiRequest.contextStats
      ? aiRequest.contextStats.usedPercentage
      : 0;
    if (usedPercentage < BYOK_COMPACTION_CONTEXT_RATIO) return;
    if (getOutput().length === lastCompactedOutputLength) return;
    if (
      lastCompactedOutputLength >= 0 &&
      getOutput().length <
        lastCompactedOutputLength + MIN_MESSAGES_BETWEEN_COMPACTIONS
    )
      return;

    const outcome = await compactByokTranscript({
      transcript: getOutput(),
      summarizer: buildCompactionSummarizer(),
      preservedBlockText: await buildPreservedBlock(),
    });
    if (!outcome) return;

    lastCompactedOutputLength = outcome.transcript.length + 1;
    aiRequest.output = outcome.transcript;
    pushNotice(
      'context-summarized',
      `[byok-notice] Context summarized: ${
        outcome.summarizedMessageCount
      } earlier message(s) condensed, ${
        outcome.droppedImageCount
      } old image(s) and ${
        outcome.summarizedToolOutputCount
      } old tool output(s) dropped to fit the model's window. The recent conversation continues below.`
    );
    persistUpdate();
  };

  /**
   * The per-round snapshot refresh (Phase 9.7): after a round that edited
   * the project, the next model call sees the state as it is now — the
   * prompt's "may be slightly stale" caveat becomes the rare truth. A
   * failing refresh degrades to the previous snapshot with a chat-visible
   * warning.
   */
  const maybeRefreshProjectSnapshot = async (): Promise<void> => {
    if (!editsSinceSnapshotRefresh) return;
    try {
      const freshContent = await getProjectUserContent();
      if (freshContent) latestProjectContent = freshContent;
      editsSinceSnapshotRefresh = false;
    } catch (error) {
      pushNotice(
        'snapshot-stale',
        '[byok-notice] The project state could not be re-read after your last edits — the snapshot below may be slightly stale.'
      );
      persistUpdate();
      editsSinceSnapshotRefresh = false;
    }
  };

  const runLoop = async (): Promise<void> => {
    // The 'working' status is persisted once per turn start by the caller
    // (appendUserMessage, or retryAfterError which has no user message to
    // append) — persisting it here as well wrote the same state twice on
    // every message.
    // Cancelling this handle aborts the in-flight model request (see
    // suspend): without it, a stopped chat keeps spending the user's tokens
    // until the request times out.
    const cancellation = createByokCancellation();
    activeCancellation = cancellation;

    for (let roundCount = 0; roundCount < maxToolRounds; roundCount++) {
      if (isSuspended) return;

      // The shared parent+children budget: sub-agents multiply the model
      // calls made against the user's endpoint, so any loop that finds it
      // exhausted stops here (the pending transcript stays valid).
      if (sharedTurnBudget.remaining <= 0) {
        markError(
          'byok-turn-budget-exhausted',
          'The chat reached its total model-turn budget (parent and sub-agents combined). Start a new chat to continue.'
        );
        return;
      }
      sharedTurnBudget.remaining--;

      // Phase 9 hooks, before the model call: compaction at ~75% of the
      // window, then the snapshot refresh when the previous round edited
      // the project.
      await maybeCompactTranscript();
      await maybeRefreshProjectSnapshot();
      if (isSuspended) return;

      // The model call itself is the client timeout's business: the
      // watchdog watches gaps, not the call.
      if (watchdog) watchdog.pause();
      let response;
      try {
        response = await callModel();
      } finally {
        if (watchdog) watchdog.resume();
      }
      if (watchdog) watchdog.notifyActivity('response-arrived');
      recordAssistantTurn(response);

      const pendingToolCalls = collectPendingToolCalls();
      // A plain-text answer (no tool call) means the model is done. An
      // answer arriving right after a suspension is recorded, but the
      // status the user saw ("suspended") wins.
      if (pendingToolCalls.length === 0) {
        if (isSuspended) return;
        if (!hasRecordedAnswerText()) {
          markError(
            'byok-empty-answer',
            'The model returned an empty answer. Try again, or send a more detailed message.'
          );
          return;
        }
        // The completion gate (Phase 8.2): after edits were made, "done"
        // must be earned. An unverified (or failing) claim gets exactly
        // one nudge turn; the second claim is honored, carrying the gate's
        // evidence block (with a warning line when it did not pass).
        if (chatMadeEdits) {
          const gateResult = checkByokCompletionGate({
            transcript: getOutput(),
            hasEditsSinceLastVerification,
            serializeProject: serializeProjectForGate,
            hasCrashedPreview: getByokPreviewHasCrashed,
          });
          if (gateResult.needsNudge && !wasCompletionNudgeSent) {
            wasCompletionNudgeSent = true;
            appendCompletionNudge(gateResult.nudgeMessage || '');
            continue;
          }
          appendCompletionGateBlock(gateResult);
        }
        markReady();
        if (options.onChatReady) options.onChatReady();
        return;
      }

      // The next round would re-send the whole (longer) history: stop
      // before the context window overflows — unless older images can
      // still be evicted (images must not exhaust the context on their
      // own: text is small, screenshots are the expensive part). The
      // pending batch still executes either way, so the transcript stays
      // protocol-valid.
      const usedPercentage = aiRequest.contextStats
        ? aiRequest.contextStats.usedPercentage
        : 0;
      const isContextFull = usedPercentage >= MAX_BYOK_CONTEXT_RATIO;
      if (isContextFull && imagesToKeep > 0) {
        imagesToKeep--;
        // The eviction bookkeeping of the monotonic survival rule: evict
        // the oldest images down to the new budget, permanently (this is
        // the one documented replay-rewriting event).
        const imageIds = getByokTranscriptImageIds(getOutput());
        const evictCount = imageIds.length - imagesToKeep;
        for (let index = 0; index < evictCount; index++) {
          evictedImageIds.add(imageIds[index]);
        }
        console.info(
          `BYOK orchestrator: context is full — evicting older images (keeping the latest ${imagesToKeep}).`
        );
      } else if (isContextFull) {
        appendNotExecutedToolOutputs(
          pendingToolCalls,
          'The conversation reached the context window limit. The user will start a new chat.'
        );
        markError(
          'byok-context-full',
          'The conversation is close to the context window limit. Start a new chat to continue.'
        );
        return;
      }

      const shouldKeepGoing = await executeToolCalls(pendingToolCalls);
      if (!shouldKeepGoing) return;
    }

    markError(
      'byok-too-many-tool-rounds',
      'The assistant reached the maximum number of tool rounds for one message. Send another message to continue.'
    );
  };

  /**
   * The shared catch of both entries: a cancelled request is the expected
   * rejection of suspend() — the status it set ("suspended") stays, and no
   * endpoint error is shown.
   */
  const handleLoopError = (error: any): void => {
    const byokError = classifyByokError(error);
    if (byokError.kind === 'cancelled') {
      if (!isSuspended) markSuspended();
      return;
    }
    markError(byokError.kind, byokError.message);
  };

  /** Arm the watchdog for a turn (when the user kept stall warnings on). */
  const armWatchdogForTurn = (): void => {
    if (watchdog) watchdog.dispose();
    const currentSettings = getCurrentSettings();
    if (currentSettings.stallWatchdogEnabled === false) {
      watchdog = null;
      return;
    }
    // Settings objects saved by older builds carry no window value: fall
    // back to the default instead of scheduling on NaN.
    const stallWindowSeconds =
      typeof currentSettings.stallWindowSeconds === 'number' &&
      currentSettings.stallWindowSeconds > 0
        ? currentSettings.stallWindowSeconds
        : DEFAULT_STALL_WINDOW_SECONDS;
    watchdog = createByokWatchdog({
      windowMs: stallWindowSeconds * 1000,
      onStall: () => {
        pushNotice('stall', buildByokStallNoticeText(stallWindowSeconds));
        persistUpdate();
      },
    });
    watchdog.arm();
  };

  const runWithUserMessage = async (
    text: string,
    images?: Array<string>
  ): Promise<void> => {
    if (isRunning) {
      // Surfaced, not just logged (audit011026 B-UI-6): a second send that
      // raced a live loop used to vanish into a console line — the user
      // believed the message was answered.
      console.info('BYOK orchestrator: a message is already being processed.');
      pushNotice(
        'stall',
        '[byok-notice] A message is already being processed — this new message was not sent. Wait for the current turn to finish, then send it again.'
      );
      persistUpdate();
      return;
    }
    isRunning = true;
    isSuspended = false;
    turnMadeEdits = false;
    rateLimitNoticePostedThisTurn = false;
    armWatchdogForTurn();
    try {
      // The very first user message decides the build-intent heuristic
      // (a later message never re-triggers the auto-suggested skill).
      if (getOutput().length === 0) firstUserRequestOfChat = text;
      // The restore-point pre-capture (Phase 8.6): serialize now, keep
      // only if the turn edits something (lazy snapshots), after the loop.
      const preTurnProjectSnapshot = serializeProjectForGate();
      // The chat's gameId follows the live project, so the chat UI's
      // restore affordances gate on the right project.
      const liveProject = getProject();
      if (liveProject && typeof liveProject.getProjectUuid === 'function') {
        aiRequest.gameId = liveProject.getProjectUuid();
      }
      const userMessage = appendUserMessage(text, images);
      latestProjectContent = await getProjectUserContent();
      await runLoop();
      if (preTurnProjectSnapshot && turnMadeEdits) {
        takeByokProjectSnapshot(
          aiRequest.id,
          ((userMessage: any).messageId: string),
          preTurnProjectSnapshot
        );
        // The version pointer the chat UI's restore arrow gates on.
        (userMessage: any).projectVersionIdBeforeMessage = ((userMessage: any)
          .messageId: string);
        persistUpdate();
      }
    } catch (error) {
      handleLoopError(error);
    } finally {
      isRunning = false;
      if (watchdog) watchdog.dispose();
    }
  };

  const retryAfterError = async (): Promise<void> => {
    if (isRunning) return;
    if (aiRequest.status !== 'error') return;
    if (
      aiRequest.error &&
      NON_RETRYABLE_BYOK_ERROR_CODES.has(aiRequest.error.code)
    ) {
      // Retrying would re-send the same oversized transcript and fail
      // identically (while charging the user's endpoint for it).
      return;
    }
    isRunning = true;
    isSuspended = false;
    rateLimitNoticePostedThisTurn = false;
    armWatchdogForTurn();
    try {
      // Same single 'working' persist per turn start as a user message: the
      // status was 'error', the transcript is unchanged.
      aiRequest.status = 'working';
      persistUpdate();
      await runLoop();
    } catch (error) {
      handleLoopError(error);
    } finally {
      isRunning = false;
      if (watchdog) watchdog.dispose();
    }
  };

  return {
    startNewChat: (userRequest: string, imageIds?: Array<string>) =>
      runWithUserMessage(userRequest, imageIds),
    // Same as startNewChat in v1: the transcript (and the fresh project
    // snapshot) carries the conversation across messages. The optional
    // image ids are the message's attached images (Phase 13.3).
    sendUserMessage: (text: string, imageIds?: Array<string>) =>
      runWithUserMessage(text, imageIds),
    suspend: () => {
      isSuspended = true;
      // Sub-agents of this chat are stopped too: suspending the parent
      // must never leave a child spending the user's endpoint alone.
      if (options.subAgentRunner) options.subAgentRunner.suspendAll();
      // Stop watching: nothing is in flight anymore.
      if (watchdog) watchdog.disarm();
      // Abort the in-flight model request (see runLoop).
      if (activeCancellation) activeCancellation.cancel();
      markSuspended();
    },
    retryAfterError,
  };
};
