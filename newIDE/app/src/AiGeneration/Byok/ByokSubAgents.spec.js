// @flow
import {
  BYOK_SUB_AGENT_MAX_ROUNDS,
  BYOK_SUB_AGENT_SUMMARY_MAX_CHARS,
  BYOK_SUB_AGENT_TOOL_NAMES,
  BYOK_SUB_AGENT_TRANSCRIPTS_CAPACITY,
  buildByokSubAgentSystemPrompt,
  capByokSubAgentSummary,
  createByokSubAgentRunner,
  extractByokSubAgentSummary,
  getByokSubAgentTranscript,
} from './ByokSubAgents';
import { sendByokChatCompletionWithRetries } from './ByokClient';
import { createByokOrchestrator } from './ByokOrchestrator';
import { createByokAiRequestShell } from './ByokTranscript';
import { DEFAULT_BYOK_SETTINGS, type ByokSharedTurnBudget } from './ByokTypes';
import { createByokUsageTracker } from './ByokUsageTracker';
import { getByokDispatchableToolNames } from './ByokToolSchema';

jest.mock('./ByokClient', () => ({
  sendByokChatCompletionWithRetries: (jest.fn(): any),
  createByokCancellation: jest.fn(() => ({
    token: { __fakeCancelToken: true },
    cancel: (jest.fn(): any),
  })),
}));

const mockSendByokChatCompletion: any = sendByokChatCompletionWithRetries;

const makeTextResponse = (text: string) => ({
  choices: [{ message: { role: 'assistant', content: text } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const makeToolCallResponse = (calls: Array<Object>) => ({
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: calls.map((call, index) => ({
          id: `call-${index}`,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      },
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const makeRunnerDeps = (overrides: Object = {}) => ({
  connection: { baseUrl: 'https://example.invalid/v1', apiKey: 'key' },
  settings: DEFAULT_BYOK_SETTINGS,
  hasOpenedProject: () => false,
  getProject: () => null,
  getProjectUserContent: async () => null,
  createExecutor: jest.fn(() =>
    jest.fn(async () => ({
      results: [],
      createdSceneNames: [],
      createdProject: null,
    }))
  ),
  usageTracker: createByokUsageTracker(),
  sharedTurnBudget: { remaining: 100 },
  ...overrides,
});

describe('ByokSubAgents: prompt and helpers', () => {
  it('builds the scoped charter of each kind with its tool list', () => {
    const scoutPrompt = buildByokSubAgentSystemPrompt({
      kind: 'scout',
      toolNames: BYOK_SUB_AGENT_TOOL_NAMES,
    });
    expect(scoutPrompt).toContain('read-only scout');
    expect(scoutPrompt).toContain('Available tools (read-only):');
    expect(scoutPrompt).toContain('- read_events_source');
    expect(scoutPrompt).toContain('ONLY thing the parent agent will see');

    const reviewerPrompt = buildByokSubAgentSystemPrompt({
      kind: 'reviewer',
      toolNames: BYOK_SUB_AGENT_TOOL_NAMES,
    });
    expect(reviewerPrompt).toContain('reviewer sub-agent');
    expect(reviewerPrompt).toContain('flag gaps');
    expect(reviewerPrompt).toContain('NOT to propose or make edits');
  });

  it('caps summaries at the token-derived limit, marking the cut', () => {
    const longSummary = 'a'.repeat(BYOK_SUB_AGENT_SUMMARY_MAX_CHARS + 500);
    const capped = capByokSubAgentSummary(longSummary);
    expect(capped.length).toBeLessThanOrEqual(
      BYOK_SUB_AGENT_SUMMARY_MAX_CHARS + '[summary truncated]'.length + 2
    );
    expect(capped).toContain('[summary truncated]');
    expect(capByokSubAgentSummary('short')).toBe('short');
  });

  it('extracts the last assistant text of a transcript', () => {
    const output: Array<any> = [
      { type: 'message', role: 'user', content: [] },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'first' }],
      },
      { type: 'function_call_output', call_id: 'c', output: '{}' },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'final answer' }],
      },
    ];
    expect(extractByokSubAgentSummary(output)).toBe('final answer');
    expect(extractByokSubAgentSummary([])).toBe('');
  });
});

describe('ByokSubAgents: read-only surface', () => {
  it('only lists read tools, all of them dispatchable in the standard set', () => {
    const dispatchable = new Set(getByokDispatchableToolNames());
    for (const name of BYOK_SUB_AGENT_TOOL_NAMES) {
      expect(dispatchable.has(name)).toBe(true);
    }
    // The modifying and preview-controlling tools are absent.
    expect(BYOK_SUB_AGENT_TOOL_NAMES).not.toContain('create_scene');
    expect(BYOK_SUB_AGENT_TOOL_NAMES).not.toContain('add_scene_events');
    expect(BYOK_SUB_AGENT_TOOL_NAMES).not.toContain('put_2d_instances');
    expect(BYOK_SUB_AGENT_TOOL_NAMES).not.toContain('run_gameplay_test');
    expect(BYOK_SUB_AGENT_TOOL_NAMES).not.toContain('start_preview');
    expect(BYOK_SUB_AGENT_TOOL_NAMES).not.toContain('initialize_project');
    expect(BYOK_SUB_AGENT_TOOL_NAMES).not.toContain('run_explorer_agent');
    expect(BYOK_SUB_AGENT_TOOL_NAMES).not.toContain('run_review_agent');
  });

  it('builds the scout executor with runScriptReadOnly (lazily, on first dispatch)', async () => {
    const executor = jest.fn(async () => ({
      results: [
        {
          status: 'finished',
          call_id: 'call-0',
          success: true,
          output: { success: true },
        },
      ],
      createdSceneNames: [],
      createdProject: null,
    }));
    const createExecutor = (jest.fn(() => executor): any);
    mockSendByokChatCompletion
      .mockResolvedValueOnce(
        makeToolCallResponse([
          { name: 'describe_instances', args: { scene_name: 'S' } },
        ])
      )
      .mockResolvedValueOnce(makeTextResponse('Scouted.'));
    const runner = createByokSubAgentRunner(makeRunnerDeps({ createExecutor }));
    const result = await runner.runSubAgent({
      kind: 'scout',
      instructions: 'Find the scenes.',
    });

    expect(result.success).toBe(true);
    // The read-only flag is a launch option of the editor runner, passed
    // through the executor factory when the child builds its executor.
    expect(createExecutor).toHaveBeenCalledWith({ runScriptReadOnly: true });
  });

  it('refuses dispatching modifying tools even when the model hallucinates them', async () => {
    const executor = jest.fn(async () => ({
      results: [
        {
          status: 'finished',
          call_id: 'call-0',
          success: true,
          output: { success: true },
        },
      ],
      createdSceneNames: [],
      createdProject: null,
    }));
    const createExecutor = () => executor;
    // One round mixing a read and a write, then a final answer.
    mockSendByokChatCompletion
      .mockResolvedValueOnce(
        makeToolCallResponse([
          { name: 'describe_instances', args: { scene_name: 'S' } },
          { name: 'create_scene', args: { scene_name: 'Evil' } },
        ])
      )
      .mockResolvedValueOnce(makeTextResponse('Done scouting.'));

    const runner = createByokSubAgentRunner(makeRunnerDeps({ createExecutor }));
    const result = await runner.runSubAgent({
      kind: 'scout',
      instructions: 'Look around.',
    });

    expect(result.success).toBe(true);
    // Only the read call reached the executor: the write was refused by
    // the whitelist enforced at dispatch.
    expect(executor).toHaveBeenCalledTimes(1);
    const firstExecutorCall: any = (executor: any).mock.calls[0];
    const dispatchedNames = firstExecutorCall[0].map(
      (call: Object) => call.name
    );
    expect(dispatchedNames).toEqual(['describe_instances']);
    // The refusal is visible in the stored transcript.
    const transcript = getByokSubAgentTranscript(result.transcriptId) || [];
    const refusalOutput = transcript.find(
      (message: Object) =>
        message.type === 'function_call_output' &&
        message.output.includes('create_scene')
    );
    expect(refusalOutput).toBeTruthy();
  });
});

describe('ByokSubAgents: runner behavior', () => {
  beforeEach(() => {
    mockSendByokChatCompletion.mockReset();
  });

  it('runs a scout in a fresh context and returns its capped summary', async () => {
    mockSendByokChatCompletion.mockResolvedValue(
      makeTextResponse('Three scenes: Menu, Level1, Level2.')
    );
    const runner = createByokSubAgentRunner(makeRunnerDeps());
    const result = await runner.runSubAgent({
      kind: 'scout',
      instructions: 'List the scenes.',
    });

    expect(result.success).toBe(true);
    expect(result.kind).toBe('scout');
    expect(result.summary).toBe('Three scenes: Menu, Level1, Level2.');
    // The full transcript is stored under its own id, disjoint from any
    // parent conversation (never replayed into it).
    const transcript: any = getByokSubAgentTranscript(result.transcriptId);
    expect(transcript).not.toBe(null);
    expect(transcript.length).toBe(2);
    expect(transcript[0].role).toBe('user');
    expect(transcript[1].role).toBe('assistant');
  });

  it('refuses to run without instructions', async () => {
    const runner = createByokSubAgentRunner(makeRunnerDeps());
    const result = await runner.runSubAgent({
      kind: 'scout',
      instructions: '',
    });
    expect(result.success).toBe(false);
    expect(result.summary).toContain('instructions');
    expect(mockSendByokChatCompletion).not.toHaveBeenCalled();
  });

  it('degrades a child failure into a success:false output the parent can ignore', async () => {
    mockSendByokChatCompletion.mockRejectedValue(new Error('endpoint down'));
    const runner = createByokSubAgentRunner(makeRunnerDeps());
    const result = await runner.runSubAgent({
      kind: 'reviewer',
      instructions: 'Check the work.',
    });

    expect(result.success).toBe(false);
    expect(result.summary).toContain('failed');
  });

  it('stops the reviewer after its smaller round budget', async () => {
    // The reviewer always asks for a tool call: it must be stopped by its
    // own maxToolRounds (3), not the default 20.
    mockSendByokChatCompletion.mockImplementation(async () =>
      makeToolCallResponse([{ name: 'read_game_project_json', args: {} }])
    );
    const executor = jest.fn(async () => ({
      results: [
        {
          status: 'finished',
          call_id: 'call-0',
          success: true,
          output: { success: true },
        },
      ],
      createdSceneNames: [],
      createdProject: null,
    }));
    const runner = createByokSubAgentRunner(
      makeRunnerDeps({ createExecutor: () => executor })
    );
    const result = await runner.runSubAgent({
      kind: 'reviewer',
      instructions: 'Review.',
    });

    expect(BYOK_SUB_AGENT_MAX_ROUNDS.reviewer).toBe(3);
    expect(result.success).toBe(false);
    expect(mockSendByokChatCompletion).toHaveBeenCalledTimes(3);
  });

  it('shares the turn budget: an exhausted budget stops the child', async () => {
    mockSendByokChatCompletion.mockImplementation(async () =>
      makeToolCallResponse([{ name: 'read_game_project_json', args: {} }])
    );
    const executor = jest.fn(async () => ({
      results: [
        {
          status: 'finished',
          call_id: 'call-0',
          success: true,
          output: { success: true },
        },
      ],
      createdSceneNames: [],
      createdProject: null,
    }));
    const sharedTurnBudget: ByokSharedTurnBudget = { remaining: 1 };
    const runner = createByokSubAgentRunner(
      makeRunnerDeps({ createExecutor: () => executor, sharedTurnBudget })
    );
    const result = await runner.runSubAgent({
      kind: 'scout',
      instructions: 'Look.',
    });

    expect(result.success).toBe(false);
    expect(result.summary).toContain('failed');
    expect(sharedTurnBudget.remaining).toBe(0);
  });

  it('suspends the still-running children when the parent is suspended', async () => {
    let resolveModel: ?(response: Object) => void = null;
    mockSendByokChatCompletion.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveModel = resolve;
        })
    );
    const runner = createByokSubAgentRunner(makeRunnerDeps());
    const pending = runner.runSubAgent({
      kind: 'scout',
      instructions: 'Look.',
    });
    // Wait (microtask by microtask) until the child's model call is really
    // in flight, then suspend the parent while it runs, and finally let
    // the model answer.
    for (let i = 0; i < 50 && !resolveModel; i++) {
      await Promise.resolve();
    }
    expect(resolveModel).not.toBe(null);
    runner.suspendAll();
    if (resolveModel) resolveModel(makeTextResponse('late answer'));

    const result = await pending;
    // The child was suspended: the suspended status wins over the late
    // answer — the parent gets a failure it can ignore.
    expect(result.success).toBe(false);
  });
});

describe('ByokSubAgents: transcript store', () => {
  it('evicts the oldest transcript beyond the capacity', async () => {
    mockSendByokChatCompletion.mockResolvedValue(makeTextResponse('ok'));
    const runner = createByokSubAgentRunner(makeRunnerDeps());
    const first = await runner.runSubAgent({
      kind: 'scout',
      instructions: 'one',
    });
    expect(getByokSubAgentTranscript(first.transcriptId)).not.toBe(null);

    for (let i = 0; i < BYOK_SUB_AGENT_TRANSCRIPTS_CAPACITY; i++) {
      await runner.runSubAgent({ kind: 'scout', instructions: `run ${i}` });
    }
    expect(getByokSubAgentTranscript(first.transcriptId)).toBe(null);
  });
});

describe('ByokSubAgents: integration with a parent chat', () => {
  beforeEach(() => {
    mockSendByokChatCompletion.mockReset();
  });

  it('the parent loop continues after a failed sub-agent (fresh context: the child transcript never enters the parent)', async () => {
    const executor = jest.fn(async () => ({
      results: [],
      createdSceneNames: [],
      createdProject: null,
    }));
    const sharedTurnBudget: ByokSharedTurnBudget = { remaining: 100 };
    const deps = makeRunnerDeps({
      createExecutor: () => executor,
      sharedTurnBudget,
    });
    const subAgentRunner = createByokSubAgentRunner(deps);

    const parentShell = createByokAiRequestShell('byok-parent-chat');
    const parent = createByokOrchestrator({
      connection: deps.connection,
      settings: deps.settings,
      aiRequest: parentShell,
      hasOpenedProject: () => false,
      getProject: () => null,
      getExecutor: () => (executor: any),
      getProjectUserContent: async () => null,
      onAiRequestUpdated: () => {},
      doesCallRequireApproval: () => false,
      onRequestEditApproval: async () => true,
      usageTracker: createByokUsageTracker(),
      sharedTurnBudget,
      subAgentRunner,
    });

    // The child model fails; the parent then wraps up in plain text.
    mockSendByokChatCompletion
      .mockResolvedValueOnce(
        makeToolCallResponse([
          {
            name: 'run_explorer_agent',
            args: { instructions: 'inventory the scenes' },
          },
        ])
      )
      .mockRejectedValueOnce(new Error('child endpoint error'))
      .mockResolvedValueOnce(makeTextResponse('Continuing without the scout.'));

    await parent.startNewChat('Build me a game');
    expect(parentShell.status).toBe('ready');

    // The parent transcript contains the delegation and its failure
    // output — and nothing from the child's own conversation (its whole
    // transcript stayed behind in the sub-agent store).
    const delegationOutput: any = (parentShell.output || []).find(
      (message: Object) => message.type === 'function_call_output'
    );
    expect(delegationOutput).toBeTruthy();
    expect(JSON.parse(delegationOutput.output).success).toBe(false);
    expect(((parentShell.output || []: any): Array<any>).length).toBe(4);
    const parentUserMessages = (parentShell.output || []).filter(
      (message: Object) => message.role === 'user'
    );
    expect(parentUserMessages.length).toBe(1);
  });
});
