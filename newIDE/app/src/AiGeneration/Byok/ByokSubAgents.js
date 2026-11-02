// @flow
import type {
  AiRequest,
  AiRequestMessage,
} from '../../Utils/GDevelopServices/Generation';
import type { EditorFunctionCallResult } from '../../EditorFunctions';
import {
  createByokOrchestrator,
  type ByokOrchestrator,
} from './ByokOrchestrator';
import { createByokAiRequestShell } from './ByokTranscript';
import type { ByokUsageTracker } from './ByokUsageTracker';
import { type ByokSettings, type ByokSharedTurnBudget } from './ByokTypes';

/**
 * The sub-agents of a BYOK chat (Phase 8.1): nested orchestrator
 * conversations with their own, scoped system prompt and their own
 * transcript, whose only contribution to the parent is a capped summary
 * returned as the `function_call_output` of the tool call that started
 * them — the orchestrator-worker pattern (context isolation for reads and
 * review; implementation stays single-context on purpose, see Phase8.md).
 *
 * Two kinds exist:
 * - **scout** (exposed as `run_explorer_agent`): read-only fan-out. Its
 *   dispatch whitelist only contains read tools, and its `run_script` runs
 *   in read-only mode (the editor runner's `runScriptReadOnly` flag), so a
 *   scout can never modify the project — enforced twice, at advertisement
 *   and at dispatch.
 * - **reviewer** (exposed as `run_review_agent`): a fresh-context check of
 *   the finished work against the original request. Read-only too: its
 *   charter is to *flag gaps, not propose edits*.
 *
 * Nesting is refused structurally: a sub-agent's own tool collaborators
 * carry no `runSubAgent` (see ByokExtraTools), so one level of delegation
 * is all that exists. A shared turn budget (parent + children) makes
 * runaway cost impossible even if a model loops.
 */

export type ByokSubAgentKind = 'scout' | 'reviewer';

/** The tool-round budgets per kind (runaway protection of the child). */
export const BYOK_SUB_AGENT_MAX_ROUNDS: {|
  [kind: ByokSubAgentKind]: number,
|} = {
  scout: 8,
  reviewer: 3,
};

/**
 * The cap on what a sub-agent's final message may cost the parent context:
 * ~1.5k tokens (4 chars/token, the prompt composer's estimate rule).
 */
export const BYOK_SUB_AGENT_SUMMARY_MAX_CHARS = 6000;

/** How many sub-agent transcripts are kept for later inspection. */
export const BYOK_SUB_AGENT_TRANSCRIPTS_CAPACITY = 20;

/**
 * The read-only tool surface of the sub-agents: the inspect/read tools,
 * the perception reads, and `run_script` (which runs read-only inside a
 * scout — see createByokSubAgentRunner). Everything that can modify the
 * project, the tests or the preview state is absent, so the whitelist
 * enforced at dispatch is the read-only guarantee.
 */
export const BYOK_SUB_AGENT_TOOL_NAMES: Array<string> = [
  'describe_instances',
  'inspect_variables',
  'read_scene_events',
  'read_events_source',
  'read_game_project_json',
  'inspect_object_properties_effects',
  'inspect_behavior_properties',
  'inspect_scene_properties_layers_effects',
  'inspect_project_properties_resources',
  'search_reference',
  'search_docs',
  'read_doc',
  'load_skill',
  'run_script',
  'capture_scene_screenshot',
  'capture_preview_screenshot',
  'read_preview_logs',
  'get_runtime_errors',
  'inspect_runtime_state',
];

/** Cap a sub-agent summary, marking the cut (the capToolOutput pattern). */
export const capByokSubAgentSummary = (summary: string): string => {
  if (summary.length <= BYOK_SUB_AGENT_SUMMARY_MAX_CHARS) return summary;
  return `${summary.slice(
    0,
    BYOK_SUB_AGENT_SUMMARY_MAX_CHARS
  )}\n…[summary truncated]`;
};

/**
 * The scoped system prompt of a sub-agent: its charter, its read-only tool
 * list, and the output contract (the final message is ALL the parent sees).
 */
export const buildByokSubAgentSystemPrompt = (options: {|
  kind: ByokSubAgentKind,
  toolNames: Array<string>,
|}): string => {
  const charter =
    options.kind === 'scout'
      ? [
          'You are a read-only scout sub-agent of a BYOK chat.',
          'Your job: explore the game project and gather the facts the parent agent asked for.',
          'You cannot modify anything: every modifying tool is refused. Do not try to edit — report instead.',
        ].join(' ')
      : [
          'You are a reviewer sub-agent of a BYOK chat.',
          'Your job: check the finished work against the original request you are given, using the read tools to look at the real state of the project.',
          'Your charter is to flag gaps and problems, NOT to propose or make edits: describe what is missing or broken, and stop there.',
        ].join(' ');

  return [
    charter,
    '',
    'Available tools (read-only):',
    ...options.toolNames.map(name => `- ${name}`),
    '',
    'Output contract: your final plain-text message is the ONLY thing the parent agent will see',
    '(your whole conversation is discarded otherwise). Make it a complete, self-contained answer',
    'to the instructions — facts found, files/objects/scenes concerned, and for a review, a clear',
    'list of gaps with evidence. Be concise: the summary is capped around 1000 words.',
  ].join('\n');
};

/**
 * The final plain-text answer of a sub-agent transcript: the text of the
 * last assistant message that carries some (an error or an aborted loop
 * leaves none — the runner reports that as a failure instead).
 */
export const extractByokSubAgentSummary = (
  output: Array<AiRequestMessage>
): string => {
  for (let index = output.length - 1; index >= 0; index--) {
    const message = output[index];
    if (message.type !== 'message' || message.role !== 'assistant') continue;
    const text = message.content
      .filter(item => item.type === 'output_text')
      .map(item => item.text)
      .join('\n')
      .trim();
    if (text) return text;
  }
  return '';
};

// The sub-agent transcripts, kept for later inspection (renderable in the
// chat UI if wanted): keyed by the id returned to the parent, capped, and
// NEVER replayed into the parent context.
const byokSubAgentTranscripts: Map<string, Array<AiRequestMessage>> = new Map();

/** The stored transcript of a sub-agent run (or null when evicted/unknown). */
export const getByokSubAgentTranscript = (
  transcriptId: string
): Array<AiRequestMessage> | null =>
  byokSubAgentTranscripts.get(transcriptId) || null;

const storeByokSubAgentTranscript = (
  transcriptId: string,
  output: Array<AiRequestMessage>
): void => {
  if (byokSubAgentTranscripts.size >= BYOK_SUB_AGENT_TRANSCRIPTS_CAPACITY) {
    // Evict the oldest entry: these are debugging/introspection artifacts,
    // not conversation state.
    const oldestId = byokSubAgentTranscripts.keys().next().value;
    if (oldestId !== undefined) byokSubAgentTranscripts.delete(oldestId);
  }
  byokSubAgentTranscripts.set(transcriptId, output);
};

export type ByokSubAgentRunResult = {|
  success: boolean,
  kind: ByokSubAgentKind,
  summary: string,
  transcriptId: string,
|};

export type ByokSubAgentRunner = {|
  runSubAgent: (options: {|
    kind: ByokSubAgentKind,
    instructions: string,
  |}) => Promise<ByokSubAgentRunResult>,
  /** Suspend every still-running child (called when the parent is suspended). */
  suspendAll: () => void,
|};

export type ByokSubAgentRunnerDeps = {|
  connection: {| baseUrl: string, apiKey: string |},
  settings: ByokSettings,
  hasOpenedProject: () => boolean,
  getProject: () => any,
  getProjectUserContent: () => Promise<string | null>,
  // Builds the tool executor of a child; the scout's run_script must be
  // read-only, which is a launch option of the editor runner — hence a
  // factory and not a single shared executor.
  createExecutor: (options: {| runScriptReadOnly: boolean |}) => (
    functionCalls: Array<any>,
    context: any
  ) => Promise<{|
    results: Array<EditorFunctionCallResult>,
    createdSceneNames: Array<string>,
    createdProject: any,
  |}>,
  // The parent chat's tracker, so sub-agent turns count toward the chat's
  // usage (they spend the same API key).
  usageTracker: ByokUsageTracker,
  // Shared with the children: any loop finding it exhausted stops.
  sharedTurnBudget: ByokSharedTurnBudget,
  // ---- Multi-provider routing (Phase 9.4): scouts ride the fast profile,
  // reviewers the strong one. The passthroughs mirror the parent's. ----
  getSettings?: () => ByokSettings,
  getApiKeyForProvider?: (keyRef: string) => Promise<string>,
  onCapabilityUpdate?: (
    baseUrl: string,
    modelName: string,
    patch: Object
  ) => void,
|};

let subAgentCounter = 0;

/**
 * Create the sub-agent runner of one parent chat (the Phase 4
 * `createByokSubAgentRunner` null-seam, now real). Every run builds a
 * FRESH orchestrator conversation — its own transcript, its own scoped
 * system prompt — and returns only the capped summary to the parent.
 */
export const createByokSubAgentRunner = (
  deps: ByokSubAgentRunnerDeps
): ByokSubAgentRunner => {
  const activeChildren: Set<ByokOrchestrator> = new Set();
  let scoutExecutor: any = null;
  let reviewerExecutor: any = null;

  const getExecutorForKind = (kind: ByokSubAgentKind): any => {
    // Only the scout's script tool is read-only today, but reviewers are
    // read-only too (their whole whitelist is): build both variants with
    // the flag on — a sub-agent never gets a modifying run_script.
    if (kind === 'scout') {
      if (!scoutExecutor) {
        scoutExecutor = deps.createExecutor({ runScriptReadOnly: true });
      }
      return scoutExecutor;
    }
    if (!reviewerExecutor) {
      reviewerExecutor = deps.createExecutor({ runScriptReadOnly: true });
    }
    return reviewerExecutor;
  };

  return {
    runSubAgent: async ({ kind, instructions }) => {
      const transcriptId = `byok-subagent-${kind}-${++subAgentCounter}`;
      if (!instructions || !instructions.trim()) {
        return {
          success: false,
          kind,
          summary:
            'The sub-agent was called without instructions: pass what to scout or review in the "instructions" argument.',
          transcriptId,
        };
      }

      const toolNames = BYOK_SUB_AGENT_TOOL_NAMES;
      const shell: AiRequest = createByokAiRequestShell(transcriptId);
      const child = createByokOrchestrator({
        connection: deps.connection,
        settings: deps.settings,
        aiRequest: shell,
        hasOpenedProject: deps.hasOpenedProject,
        getProject: deps.getProject,
        getExecutor: () => getExecutorForKind(kind),
        getProjectUserContent: deps.getProjectUserContent,
        // The child's transcript lives only in the module store below —
        // persisting it into the parent's chat store would replay it.
        onAiRequestUpdated: () => {},
        doesCallRequireApproval: () =>
          // Read-only surface: nothing dispatchable modifies the project,
          // so no approval row can ever come out of a sub-agent.
          false,
        onRequestEditApproval: async () => true,
        usageTracker: deps.usageTracker,
        allowedToolNames: toolNames,
        advertisedToolNames: () => toolNames,
        systemPrompt: buildByokSubAgentSystemPrompt({ kind, toolNames }),
        maxToolRounds: BYOK_SUB_AGENT_MAX_ROUNDS[kind],
        sharedTurnBudget: deps.sharedTurnBudget,
        callKind: kind === 'scout' ? 'scout' : 'reviewer',
        getSettings: deps.getSettings,
        getApiKeyForProvider: deps.getApiKeyForProvider,
        onCapabilityUpdate: deps.onCapabilityUpdate,
      });
      activeChildren.add(child);
      try {
        await child.startNewChat(instructions);
      } finally {
        activeChildren.delete(child);
      }

      storeByokSubAgentTranscript(transcriptId, shell.output || []);
      const summary = extractByokSubAgentSummary(shell.output || []);
      // Only a child that reached 'ready' produced a usable summary: an
      // error, a suspension (the parent was stopped) or an empty answer
      // degrades to a failure the parent can ignore.
      if (shell.status !== 'ready' || !summary) {
        const reason =
          shell.error && shell.error.message
            ? shell.error.message
            : 'The sub-agent ended without a summary.';
        return {
          success: false,
          kind,
          summary: `The ${kind} sub-agent failed: ${reason} You can continue without it or try again.`,
          transcriptId,
        };
      }
      return {
        success: true,
        kind,
        summary: capByokSubAgentSummary(summary),
        transcriptId,
      };
    },
    suspendAll: () => {
      activeChildren.forEach(child => child.suspend());
      activeChildren.clear();
    },
  };
};
