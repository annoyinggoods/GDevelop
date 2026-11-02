// @flow
import {
  createByokOrchestrator,
  createByokSubAgentRunner,
  capToolOutput,
  BYOK_TOOL_OUTPUT_CAP,
  MAX_BYOK_TOOL_ROUNDS,
} from './ByokOrchestrator';
import { DEFAULT_BYOK_SETTINGS } from './ByokTypes';
import { createByokUsageTracker } from './ByokUsageTracker';
import { createByokAiRequestShell } from './ByokTranscript';
import {
  createByokCancellation,
  sendByokChatCompletionWithRetries,
} from './ByokClient';
import { cacheByokModels, clearByokModels } from './ByokModelsCache';
import { registerByokImage } from './ByokImageContent';
import * as ByokProjectNotesModule from './ByokProjectNotes';
import * as ByokPromptsModule from './ByokPrompts';

jest.mock('./ByokClient', () => ({
  sendByokChatCompletionWithRetries: jest.fn(),
  createByokCancellation: jest.fn(() => ({
    token: { __fakeCancelToken: true },
    cancel: jest.fn(),
  })),
}));

const mockSendByokChatCompletion = mockFn(sendByokChatCompletionWithRetries);

function mockFn(fn: any): any {
  return fn;
}

const makeToolCall = (id: string, name: string, args: string) => ({
  id,
  type: 'function',
  function: { name, arguments: args },
});

const makeResponse = ({
  text,
  toolCalls = [],
  usage,
}: {
  text?: string | null,
  toolCalls?: Array<any>,
  usage?: any,
}) => ({
  choices: [
    {
      message: {
        role: 'assistant',
        content: text === undefined ? null : text,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    },
  ],
  usage,
});

// A successful executor: every call succeeds with a small output.
const makeFakeExecutor = () =>
  mockFn(
    jest.fn(async (functionCalls: Array<any>) => ({
      results: functionCalls.map((functionCall: any) => ({
        status: 'finished',
        call_id: functionCall.call_id,
        success: true,
        output: { message: 'done' },
      })),
      createdSceneNames: [],
      createdProject: null,
    }))
  );

const makeOrchestrator = (overrides: any = {}) => {
  const aiRequest = createByokAiRequestShell('byok-test-chat');
  const onAiRequestUpdated = mockFn(jest.fn());
  const usageTracker = {
    recordTurn: mockFn((jest.fn(): any)),
    getTotals: () => ({}),
  };
  // Back-compat with the pre-Phase-5 option name used across the tests
  // below: the orchestrator itself takes the getter (getExecutor).
  const { executeFunctionCalls, getExecutor, ...otherOverrides } = overrides;
  const defaultExecutor = makeFakeExecutor();
  const orchestrator = createByokOrchestrator({
    connection: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test' },
    settings: { ...DEFAULT_BYOK_SETTINGS, modelName: 'test-model' },
    aiRequest,
    hasOpenedProject: () => true,
    getProject: () => null,
    getExecutor:
      getExecutor !== undefined
        ? getExecutor
        : () =>
            executeFunctionCalls !== undefined
              ? executeFunctionCalls
              : defaultExecutor,
    getProjectUserContent: async () => '{"scenes":[]}',
    onAiRequestUpdated,
    doesCallRequireApproval: () => false,
    onRequestEditApproval: async () => true,
    usageTracker,
    onFunctionCallsExecuted: mockFn(jest.fn()),
    ...otherOverrides,
  });
  return { orchestrator, aiRequest, onAiRequestUpdated, usageTracker };
};

// Phase 7: building the system prompt now goes through async storages
// (skills metadata, project notes), so reaching the model call takes a few
// extra microtasks. This flushes them deterministically.
const flushMicrotasks = async () => {
  for (let index = 0; index < 20; index++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};

describe('ByokOrchestrator', () => {
  beforeEach(() => {
    mockSendByokChatCompletion.mockReset();
    // The jest preset resets every mock's implementation before each test
    // (resetMocks): the factory-provided cancellation mock must be
    // re-implemented here, or createByokCancellation returns undefined.
    (createByokCancellation: any).mockImplementation(() => ({
      token: { __fakeCancelToken: true },
      cancel: jest.fn(),
    }));
    // The models cache is module state: no test may see another's models.
    clearByokModels();
  });

  it('runs the happy path: tool call → result fed back → final text answer', async () => {
    const executeFunctionCalls = makeFakeExecutor();
    mockSendByokChatCompletion
      .mockResolvedValueOnce(
        makeResponse({
          toolCalls: [
            makeToolCall('call-1', 'create_scene', '{"scene_name":"Forest"}'),
          ],
        })
      )
      .mockResolvedValueOnce(makeResponse({ text: 'Scene created!' }));
    const { orchestrator, aiRequest } = makeOrchestrator({
      executeFunctionCalls,
    });

    await orchestrator.startNewChat('Create a Forest scene');

    expect(aiRequest.status).toBe('ready');
    expect(aiRequest.error).toBe(null);
    // The transcript tells the whole story, in order.
    const transcript = aiRequest.output || [];
    expect(transcript).toHaveLength(4);
    expect(transcript[0].role).toBe('user');
    expect(transcript[1].content).toEqual([
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call-1',
        name: 'create_scene',
      }),
    ]);
    expect(transcript[2].type).toBe('function_call_output');
    expect(transcript[2].call_id).toBe('call-1');
    expect(JSON.parse((transcript[2]: any).output)).toEqual({
      success: true,
      message: 'done',
    });
    expect(transcript[3].content).toEqual([
      expect.objectContaining({ type: 'output_text', text: 'Scene created!' }),
    ]);

    // The executor ran the call, and the second model call got the tool
    // result back as a `tool` message.
    expect(executeFunctionCalls).toHaveBeenCalledTimes(1);
    expect(mockSendByokChatCompletion).toHaveBeenCalledTimes(2);
    const secondCallMessages =
      mockSendByokChatCompletion.mock.calls[1][0].options.messages;
    expect(
      secondCallMessages.filter((message: any) => message.role === 'tool')
    ).toHaveLength(1);
  });

  it('persists the turn start exactly once while the first model call is pending', async () => {
    // The model call never resolves until the test allows it: the persists
    // counted below are exactly the turn-start ones.
    let resolveModelCall = (null: ?(response: any) => void);
    mockSendByokChatCompletion.mockReturnValueOnce(
      new Promise(resolve => {
        resolveModelCall = resolve;
      })
    );
    const { orchestrator, aiRequest, onAiRequestUpdated } = makeOrchestrator();

    const chatPromise = orchestrator.startNewChat('Hello');
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }

    // Once by appendUserMessage — not twice (the loop no longer re-persists
    // the same 'working' status).
    expect(onAiRequestUpdated).toHaveBeenCalledTimes(1);

    if (!resolveModelCall) throw new Error('The model call never started');
    resolveModelCall(makeResponse({ text: 'Done.' }));
    await chatPromise;
    expect(aiRequest.status).toBe('ready');
  });

  it('persists the turn start exactly once on a retry', async () => {
    const serverError = (new Error('boom'): any);
    serverError.response = { status: 500, data: null };
    mockSendByokChatCompletion.mockRejectedValueOnce(serverError);
    const { orchestrator, aiRequest, onAiRequestUpdated } = makeOrchestrator();

    await orchestrator.startNewChat('Hello');
    expect(aiRequest.status).toBe('error');
    onAiRequestUpdated.mockClear();

    let resolveModelCall = (null: ?(response: any) => void);
    mockSendByokChatCompletion.mockReturnValueOnce(
      new Promise(resolve => {
        resolveModelCall = resolve;
      })
    );
    const retryPromise = orchestrator.retryAfterError();
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }

    expect(onAiRequestUpdated).toHaveBeenCalledTimes(1);

    if (!resolveModelCall) throw new Error('The model call never started');
    resolveModelCall(makeResponse({ text: 'Recovered.' }));
    await retryPromise;
    expect(aiRequest.status).toBe('ready');
  });

  it('chains two rounds of tool calls before answering', async () => {
    mockSendByokChatCompletion
      .mockResolvedValueOnce(
        makeResponse({
          toolCalls: [makeToolCall('call-1', 'describe_instances', '{}')],
        })
      )
      .mockResolvedValueOnce(
        makeResponse({
          toolCalls: [makeToolCall('call-2', 'create_scene', '{}')],
        })
      )
      .mockResolvedValueOnce(makeResponse({ text: 'All done.' }));
    const { orchestrator, aiRequest } = makeOrchestrator();

    await orchestrator.startNewChat('Do two things');

    expect(mockSendByokChatCompletion).toHaveBeenCalledTimes(3);
    const functionCalls = (aiRequest.output || [])
      .filter(
        message => message.type === 'message' && message.role === 'assistant'
      )
      .flatMap(message => message.content)
      .filter(item => item.type === 'function_call');
    expect(functionCalls.map(item => item.name)).toEqual([
      'describe_instances',
      'create_scene',
    ]);
    expect(aiRequest.status).toBe('ready');
  });

  it('stops runaway tool loops with an error status at the round cap', async () => {
    const runawayResponse = makeResponse({
      toolCalls: [
        makeToolCall(`call-x`, 'create_or_update_plan', '{"tasks":[]}'),
      ],
    });
    mockSendByokChatCompletion.mockImplementation(async () => runawayResponse);
    const { orchestrator, aiRequest } = makeOrchestrator();

    await orchestrator.startNewChat('Loop forever');

    expect(mockSendByokChatCompletion).toHaveBeenCalledTimes(
      MAX_BYOK_TOOL_ROUNDS
    );
    expect(aiRequest.status).toBe('error');
    expect(aiRequest.error && aiRequest.error.code).toBe(
      'byok-too-many-tool-rounds'
    );
  });

  it('feeds a failed tool call back to the model as success:false, which recovers', async () => {
    const executeFunctionCalls = mockFn(
      jest.fn(async () => ({
        results: [
          {
            status: 'finished',
            call_id: 'call-1',
            success: false,
            output: { message: 'Invalid arguments (not a valid JSON string).' },
          },
        ],
        createdSceneNames: [],
        createdProject: null,
      }))
    );
    mockSendByokChatCompletion
      .mockResolvedValueOnce(
        makeResponse({
          toolCalls: [makeToolCall('call-1', 'create_scene', '{broken')],
        })
      )
      .mockResolvedValueOnce(makeResponse({ text: 'Fixed and done.' }));
    const { orchestrator, aiRequest } = makeOrchestrator({
      executeFunctionCalls,
    });

    await orchestrator.startNewChat('Break then fix');

    const toolOutput = (aiRequest.output || []).find(
      message => message.type === 'function_call_output'
    );
    expect(toolOutput).toBeTruthy();
    expect(JSON.parse((toolOutput: any).output).success).toBe(false);
    expect(JSON.parse((toolOutput: any).output).message).toContain(
      'Invalid arguments'
    );
    // The loop continued so the model could correct itself.
    expect(aiRequest.status).toBe('ready');
    expect(mockSendByokChatCompletion).toHaveBeenCalledTimes(2);
  });

  it('suspends the chat when an edit approval is refused, recording not-executed outputs', async () => {
    const executeFunctionCalls = makeFakeExecutor();
    const onRequestEditApproval = mockFn((jest.fn(async () => false): any));
    mockSendByokChatCompletion.mockResolvedValueOnce(
      makeResponse({
        toolCalls: [
          makeToolCall('call-1', 'describe_instances', '{}'),
          makeToolCall('call-2', 'create_scene', '{}'),
        ],
      })
    );
    const { orchestrator, aiRequest } = makeOrchestrator({
      executeFunctionCalls,
      onRequestEditApproval,
      doesCallRequireApproval: functionCall =>
        functionCall.name === 'create_scene',
    });

    await orchestrator.startNewChat('Create something');

    expect(onRequestEditApproval).toHaveBeenCalledTimes(1);
    expect(executeFunctionCalls).not.toHaveBeenCalled();
    expect(aiRequest.status).toBe('suspended');
    // Every call of the refused batch got a failure output — including the
    // non-modifying one, which was never run: the transcript stays a valid
    // OpenAI conversation (no dangling tool_calls).
    const transcript = aiRequest.output || [];
    const outputs = transcript.filter(
      message => message.type === 'function_call_output'
    );
    expect(outputs).toHaveLength(2);
    expect(outputs.map(output => output.call_id).sort()).toEqual([
      'call-1',
      'call-2',
    ]);
    for (const output of outputs) {
      expect(JSON.parse(output.output).success).toBe(false);
      expect(JSON.parse(output.output).message).toContain('refused');
    }
  });

  it('resumes cleanly after a refused edit: the next message is a protocol-valid request', async () => {
    const executeFunctionCalls = makeFakeExecutor();
    const onRequestEditApproval = mockFn((jest.fn(async () => false): any));
    mockSendByokChatCompletion
      .mockResolvedValueOnce(
        makeResponse({
          toolCalls: [makeToolCall('call-1', 'create_scene', '{}')],
        })
      )
      .mockResolvedValueOnce(
        makeResponse({ text: 'Understood, standing by.' })
      );
    const { orchestrator, aiRequest } = makeOrchestrator({
      executeFunctionCalls,
      onRequestEditApproval,
      doesCallRequireApproval: () => true,
    });

    await orchestrator.startNewChat('Create something');
    await orchestrator.sendUserMessage('Actually, do nothing');

    expect(aiRequest.status).toBe('ready');
    expect(mockSendByokChatCompletion).toHaveBeenCalledTimes(2);
    // The resume request replays the assistant tool_calls followed by their
    // tool results, then the new user message — no dangling tool_calls.
    const resumeMessages =
      mockSendByokChatCompletion.mock.calls[1][0].options.messages;
    const toolCallIndex = resumeMessages.findIndex(
      (message: any) =>
        message.role === 'assistant' && message.tool_calls !== undefined
    );
    expect(toolCallIndex).toBeGreaterThan(-1);
    expect(resumeMessages[toolCallIndex + 1].role).toBe('tool');
  });

  it('does not execute an arrived batch when suspended mid-model-call', async () => {
    const executeFunctionCalls = makeFakeExecutor();
    let resolveModelCall: (response: any) => void = () => {};
    mockSendByokChatCompletion.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveModelCall = resolve;
        })
    );
    const { orchestrator, aiRequest } = makeOrchestrator({
      executeFunctionCalls,
    });

    const startPromise = orchestrator.startNewChat('Slow round');
    // Let the user message append and the project content resolve, so the
    // loop is now awaiting the model call.
    await flushMicrotasks();
    orchestrator.suspend();
    resolveModelCall(
      makeResponse({
        toolCalls: [makeToolCall('call-1', 'create_scene', '{}')],
      })
    );
    await startPromise;

    expect(executeFunctionCalls).not.toHaveBeenCalled();
    expect(aiRequest.status).toBe('suspended');
    // The arrived batch is recorded as not executed, keeping the transcript
    // protocol-valid.
    const outputs = (aiRequest.output || []).filter(
      message => message.type === 'function_call_output'
    );
    expect(outputs).toHaveLength(1);
    expect(JSON.parse((outputs[0]: any).output).message).toContain('stopped');
  });

  it('proceeds when an edit approval is accepted', async () => {
    const executeFunctionCalls = makeFakeExecutor();
    const onRequestEditApproval = mockFn((jest.fn(async () => true): any));
    mockSendByokChatCompletion
      .mockResolvedValueOnce(
        makeResponse({
          toolCalls: [makeToolCall('call-1', 'create_scene', '{}')],
        })
      )
      .mockResolvedValueOnce(makeResponse({ text: 'Done.' }));
    const { orchestrator, aiRequest } = makeOrchestrator({
      executeFunctionCalls,
      onRequestEditApproval,
      doesCallRequireApproval: () => true,
    });

    await orchestrator.startNewChat('Create something');

    expect(onRequestEditApproval).toHaveBeenCalledTimes(1);
    expect(executeFunctionCalls).toHaveBeenCalledTimes(1);
    expect(aiRequest.status).toBe('ready');
  });

  it('updates contextStats each round and reports usage', async () => {
    mockSendByokChatCompletion
      .mockResolvedValueOnce(
        makeResponse({
          toolCalls: [makeToolCall('call-1', 'describe_instances', '{}')],
          usage: {
            prompt_tokens: 3000,
            completion_tokens: 500,
            total_tokens: 3500,
          },
        })
      )
      .mockResolvedValueOnce(
        makeResponse({
          text: 'Done.',
          usage: {
            prompt_tokens: 4000,
            completion_tokens: 200,
            total_tokens: 4200,
          },
        })
      );
    const { orchestrator, aiRequest, usageTracker } = makeOrchestrator();

    await orchestrator.startNewChat('Check usage');

    // The default context window of the settings is 8192 tokens.
    expect(aiRequest.contextStats).toEqual({
      totalTokens: 4200,
      usedPercentage: 4200 / 8192,
    });
    expect(usageTracker.recordTurn).toHaveBeenCalledTimes(2);
  });

  it('stops the loop at the context-ratio threshold, before executing more tools', async () => {
    const executeFunctionCalls = makeFakeExecutor();
    mockSendByokChatCompletion.mockResolvedValue(
      makeResponse({
        toolCalls: [
          makeToolCall('call-1', 'create_or_update_plan', '{"tasks":[]}'),
        ],
        // 8000+512 tokens of an 8192-token window: ~98% used.
        usage: {
          prompt_tokens: 8000,
          completion_tokens: 512,
          total_tokens: 8512,
        },
      })
    );
    const { orchestrator, aiRequest } = makeOrchestrator({
      executeFunctionCalls,
    });

    await orchestrator.startNewChat('Fill the context');

    expect(aiRequest.status).toBe('error');
    expect(aiRequest.error && aiRequest.error.code).toBe('byok-context-full');
    // The assistant turn was recorded (so the user sees what happened), but
    // no further tool was executed.
    expect(executeFunctionCalls).not.toHaveBeenCalled();
  });

  it('notifies onAiRequestUpdated after every transcript mutation', async () => {
    mockSendByokChatCompletion
      .mockResolvedValueOnce(
        makeResponse({
          toolCalls: [makeToolCall('call-1', 'create_scene', '{}')],
        })
      )
      .mockResolvedValueOnce(makeResponse({ text: 'Done.' }));
    const { orchestrator, onAiRequestUpdated } = makeOrchestrator();

    await orchestrator.startNewChat('Trace updates');

    // user message, loop start, assistant turn, tool outputs, ready —
    // strictly increasing, and always the same record.
    expect(onAiRequestUpdated.mock.calls.length).toBeGreaterThanOrEqual(5);
    for (const call of onAiRequestUpdated.mock.calls) {
      expect(call[0].id).toBe('byok-test-chat');
    }
  });

  it('reports a classified error when the endpoint call fails', async () => {
    mockSendByokChatCompletion.mockRejectedValue({
      kind: 'authentication',
      message: 'Your API key was rejected by the endpoint (401).',
      status: 401,
    });
    const { orchestrator, aiRequest } = makeOrchestrator();

    await orchestrator.startNewChat('Hello');

    expect(aiRequest.status).toBe('error');
    expect(aiRequest.error && aiRequest.error.code).toBe('authentication');
    expect(aiRequest.error && aiRequest.error.message).toContain('401');
  });

  it('continues an existing chat with sendUserMessage', async () => {
    mockSendByokChatCompletion
      .mockResolvedValueOnce(makeResponse({ text: 'First answer.' }))
      .mockResolvedValueOnce(makeResponse({ text: 'Second answer.' }));
    const { orchestrator, aiRequest } = makeOrchestrator();

    await orchestrator.startNewChat('First question');
    await orchestrator.sendUserMessage('Second question');

    const userMessages = (aiRequest.output || []).filter(
      message => message.type === 'message' && message.role === 'user'
    );
    expect(userMessages).toHaveLength(2);
    expect(aiRequest.status).toBe('ready');
    expect(mockSendByokChatCompletion).toHaveBeenCalledTimes(2);
  });

  it('handles create_or_update_plan itself, echoing the tasks as the plan output', async () => {
    const executeFunctionCalls = makeFakeExecutor();
    const tasks = [{ id: 't1', title: 'Do it', status: 'pending' }];
    mockSendByokChatCompletion
      .mockResolvedValueOnce(
        makeResponse({
          toolCalls: [
            makeToolCall(
              'call-plan',
              'create_or_update_plan',
              JSON.stringify({ tasks })
            ),
          ],
        })
      )
      .mockResolvedValueOnce(makeResponse({ text: 'Planned and done.' }));
    const { orchestrator, aiRequest } = makeOrchestrator({
      executeFunctionCalls,
    });

    await orchestrator.startNewChat('Plan then act');

    // The plan call never reaches the editor executor: its registry
    // implementation is a permanent failure stub (handled server-side
    // upstream), so the orchestrator answers it directly.
    expect(executeFunctionCalls).not.toHaveBeenCalled();
    const planOutput = (aiRequest.output || []).find(
      message => message.type === 'function_call_output'
    );
    const parsedOutput = JSON.parse((planOutput: any).output);
    expect(parsedOutput.success).toBe(true);
    // The wire field `depends_on` is mapped to the internal `dependsOn` of
    // AiRequestPlanTask (and defaults to an empty array).
    expect(parsedOutput.plan.tasks).toEqual([
      { id: 't1', title: 'Do it', status: 'pending', dependsOn: [] },
    ]);
    expect(aiRequest.status).toBe('ready');
  });

  it('reports invalid create_or_update_plan arguments as a failed output', async () => {
    mockSendByokChatCompletion
      .mockResolvedValueOnce(
        makeResponse({
          toolCalls: [
            makeToolCall('call-plan', 'create_or_update_plan', '{broken'),
          ],
        })
      )
      .mockResolvedValueOnce(makeResponse({ text: 'Recovered.' }));
    const { orchestrator, aiRequest } = makeOrchestrator();

    await orchestrator.startNewChat('Plan badly');

    const planOutput = (aiRequest.output || []).find(
      message => message.type === 'function_call_output'
    );
    const parsedOutput = JSON.parse((planOutput: any).output);
    expect(parsedOutput.success).toBe(false);
    expect(parsedOutput.message).toContain('tasks');
    expect(aiRequest.status).toBe('ready');
  });

  it('retries after an error without adding anything to the conversation', async () => {
    mockSendByokChatCompletion
      .mockRejectedValueOnce({
        kind: 'network',
        message: 'The endpoint could not be reached.',
      })
      .mockResolvedValueOnce(makeResponse({ text: 'Back online.' }));
    const { orchestrator, aiRequest } = makeOrchestrator();

    await orchestrator.startNewChat('Hello');
    expect(aiRequest.status).toBe('error');
    const outputLengthAfterFailure = (aiRequest.output || []).length;

    await orchestrator.retryAfterError();

    expect(aiRequest.status).toBe('ready');
    expect(mockSendByokChatCompletion).toHaveBeenCalledTimes(2);
    // Only the new final answer was appended — no extra user message.
    expect((aiRequest.output || []).length).toBe(outputLengthAfterFailure + 1);
  });

  it('ignores retryAfterError when the chat is not in the error state', async () => {
    mockSendByokChatCompletion.mockResolvedValueOnce(
      makeResponse({ text: 'ok' })
    );
    const { orchestrator } = makeOrchestrator();

    await orchestrator.startNewChat('Hello');
    await orchestrator.retryAfterError();

    expect(mockSendByokChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('marks the chat suspended when suspend() is called', async () => {
    const { orchestrator, aiRequest } = makeOrchestrator();

    orchestrator.suspend();

    expect(aiRequest.status).toBe('suspended');
  });

  it('sends the system prompt and the snapshot as its own trailing user message', async () => {
    mockSendByokChatCompletion.mockResolvedValueOnce(
      makeResponse({ text: 'ok' })
    );
    const { orchestrator } = makeOrchestrator();

    await orchestrator.startNewChat('Inspect this');

    const firstCallOptions =
      mockSendByokChatCompletion.mock.calls[0][0].options;
    expect(firstCallOptions.model).toBe('test-model');
    expect(firstCallOptions.tools).toEqual(expect.any(Array));
    expect(firstCallOptions.tools.length).toBeGreaterThan(0);
    const messages = firstCallOptions.messages;
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('GDevelop');
    const userMessage = messages.find(
      (message: any) => message.role === 'user'
    );
    expect(userMessage.content).toContain('Inspect this');
    // The snapshot never touches the user's message: it rides the LAST
    // message of the request (the append-only cache contract).
    expect(userMessage.content).not.toContain('{"scenes":[]}');
    const lastMessage = messages[messages.length - 1];
    expect(lastMessage.role).toBe('user');
    expect(lastMessage.content).toContain(
      '[Current simplified project snapshot, as JSON'
    );
    expect(lastMessage.content).toContain('{"scenes":[]}');
  });

  it('refuses to dispatch a hallucinated non-whitelisted tool and tells the model', async () => {
    const executeFunctionCalls = makeFakeExecutor();
    mockSendByokChatCompletion
      .mockResolvedValueOnce(
        makeResponse({
          toolCalls: [makeToolCall('call-x', 'run_tests', '{"query":"evil"}')],
        })
      )
      .mockResolvedValueOnce(makeResponse({ text: 'Recovered.' }));
    const { orchestrator, aiRequest } = makeOrchestrator({
      executeFunctionCalls,
    });

    await orchestrator.startNewChat('Do something');

    // The whitelist is enforced at dispatch, not only in the advertisement:
    // run_tests (a server-side stub) must never reach the executor.
    expect(executeFunctionCalls).not.toHaveBeenCalled();
    const outputs = (aiRequest.output || []).filter(
      message => message.type === 'function_call_output'
    );
    expect(outputs).toHaveLength(1);
    expect(outputs[0].call_id).toBe('call-x');
    expect(JSON.parse((outputs[0]: any).output).success).toBe(false);
    expect(JSON.parse((outputs[0]: any).output).message).toContain(
      'not available'
    );
    // The loop continued so the model could correct itself.
    expect(aiRequest.status).toBe('ready');
    expect(mockSendByokChatCompletion).toHaveBeenCalledTimes(2);
  });

  it('dispatches only the whitelisted calls of a mixed batch', async () => {
    const executeFunctionCalls = makeFakeExecutor();
    mockSendByokChatCompletion
      .mockResolvedValueOnce(
        makeResponse({
          toolCalls: [
            makeToolCall('call-1', 'run_tests', '{}'),
            makeToolCall('call-2', 'describe_instances', '{}'),
          ],
        })
      )
      .mockResolvedValueOnce(makeResponse({ text: 'Done.' }));
    const { orchestrator, aiRequest } = makeOrchestrator({
      executeFunctionCalls,
    });

    await orchestrator.startNewChat('Mixed batch');

    expect(executeFunctionCalls).toHaveBeenCalledTimes(1);
    expect(
      executeFunctionCalls.mock.calls[0][0].map((call: any) => call.name)
    ).toEqual(['describe_instances']);
    // Both calls got an output (one refusal, one result).
    const outputs = (aiRequest.output || []).filter(
      message => message.type === 'function_call_output'
    );
    expect(outputs.map(output => output.call_id).sort()).toEqual([
      'call-1',
      'call-2',
    ]);
    expect(aiRequest.status).toBe('ready');
  });

  it('aborts the in-flight model request on suspend and keeps the suspended status', async () => {
    let rejectModelCall: (error: any) => void = () => {};
    mockSendByokChatCompletion.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectModelCall = reject;
        })
    );
    const { orchestrator, aiRequest } = makeOrchestrator();

    const startPromise = orchestrator.startNewChat('Slow round');
    await flushMicrotasks();
    // The model call carries a cancellation handle, so suspend() can abort
    // it instead of letting it run (and bill) to its timeout.
    expect(
      mockSendByokChatCompletion.mock.calls[0][0].options.cancellation
    ).toBeDefined();

    orchestrator.suspend();
    const cancellationResults = (createByokCancellation: any).mock.results;
    const lastCancellation =
      cancellationResults[cancellationResults.length - 1].value;
    expect(lastCancellation.cancel).toHaveBeenCalled();

    // The client surfaces the abort as a cancelled rejection: no error is
    // shown, the status suspend() set wins.
    rejectModelCall({ __CANCEL__: true });
    await startPromise;

    expect(aiRequest.status).toBe('suspended');
    expect(aiRequest.error).toBe(null);
  });

  it('records a late plain-text answer after a suspension but keeps the suspended status', async () => {
    let resolveModelCall: (response: any) => void = () => {};
    mockSendByokChatCompletion.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveModelCall = resolve;
        })
    );
    const { orchestrator, aiRequest } = makeOrchestrator();

    const startPromise = orchestrator.startNewChat('Slow answer');
    await flushMicrotasks();
    orchestrator.suspend();
    resolveModelCall(makeResponse({ text: 'Late answer' }));
    await startPromise;

    expect(aiRequest.status).toBe('suspended');
    const output = aiRequest.output || [];
    const lastMessage = output[output.length - 1];
    expect(lastMessage.content).toEqual([
      expect.objectContaining({ type: 'output_text', text: 'Late answer' }),
    ]);
  });

  it('does not run an approved batch when Stop was pressed while the approval was pending', async () => {
    const executeFunctionCalls = makeFakeExecutor();
    let resolveApproval: (approved: boolean) => void = () => {};
    const onRequestEditApproval = mockFn(
      (jest.fn(
        () =>
          new Promise(resolve => {
            resolveApproval = resolve;
          })
      ): any)
    );
    mockSendByokChatCompletion.mockResolvedValueOnce(
      makeResponse({
        toolCalls: [makeToolCall('call-1', 'create_scene', '{}')],
      })
    );
    const { orchestrator, aiRequest } = makeOrchestrator({
      executeFunctionCalls,
      onRequestEditApproval,
      doesCallRequireApproval: () => true,
    });

    const startPromise = orchestrator.startNewChat('Edit something');
    await flushMicrotasks();
    await Promise.resolve();
    orchestrator.suspend();
    resolveApproval(true);
    await startPromise;

    // Approved or not, a batch must not run after the user pressed Stop.
    expect(executeFunctionCalls).not.toHaveBeenCalled();
    expect(aiRequest.status).toBe('suspended');
    const outputs = (aiRequest.output || []).filter(
      message => message.type === 'function_call_output'
    );
    expect(outputs).toHaveLength(1);
    expect(JSON.parse((outputs[0]: any).output).message).toContain('stopped');
  });

  it('computes the context ratio against the per-model context window', async () => {
    mockSendByokChatCompletion
      .mockResolvedValueOnce(
        makeResponse({
          toolCalls: [makeToolCall('call-1', 'describe_instances', '{}')],
          usage: {
            prompt_tokens: 9000,
            completion_tokens: 500,
            total_tokens: 9500,
          },
        })
      )
      .mockResolvedValueOnce(makeResponse({ text: 'Done.' }));
    const { orchestrator, aiRequest } = makeOrchestrator({
      settings: {
        ...DEFAULT_BYOK_SETTINGS,
        modelName: 'test-model',
        contextWindowByModel: { 'test-model': 100000 },
      },
    });

    await orchestrator.startNewChat('Big context');

    // 9500 tokens of the 100000-token window the user set for this model
    // (not of the 8192 global default: the guard must not fire).
    expect(aiRequest.contextStats).toEqual({
      totalTokens: 9500,
      usedPercentage: 9500 / 100000,
    });
    expect(aiRequest.status).toBe('ready');
  });

  it('computes the context ratio against the server-reported context window', async () => {
    cacheByokModels('https://api.example.com/v1', [
      { id: 'test-model', contextWindowTokens: 32768 },
    ]);
    mockSendByokChatCompletion
      .mockResolvedValueOnce(
        makeResponse({
          toolCalls: [makeToolCall('call-1', 'describe_instances', '{}')],
          usage: {
            prompt_tokens: 8000,
            completion_tokens: 512,
            total_tokens: 8512,
          },
        })
      )
      .mockResolvedValueOnce(makeResponse({ text: 'Done.' }));
    const { orchestrator, aiRequest } = makeOrchestrator();

    await orchestrator.startNewChat('Server-reported window');

    expect(aiRequest.contextStats).toEqual({
      totalTokens: 8512,
      usedPercentage: 8512 / 32768,
    });
    expect(aiRequest.status).toBe('ready');
  });

  it('closes the pending batch when the context guard fires, and refuses a retry', async () => {
    mockSendByokChatCompletion.mockResolvedValue(
      makeResponse({
        toolCalls: [
          makeToolCall('call-1', 'create_or_update_plan', '{"tasks":[]}'),
        ],
        usage: {
          prompt_tokens: 8000,
          completion_tokens: 512,
          total_tokens: 8512,
        },
      })
    );
    const { orchestrator, aiRequest } = makeOrchestrator();

    await orchestrator.startNewChat('Fill the context');

    expect(aiRequest.error && aiRequest.error.code).toBe('byok-context-full');
    // While older images could still be evicted (the default budget of 2),
    // the pending batch executed and the loop continued; only once no image
    // was left did the guard close the batch with a not-executed output and
    // settle into the clean error state.
    const outputs = (aiRequest.output || []).filter(
      message => message.type === 'function_call_output'
    );
    expect(outputs).toHaveLength(3);
    expect(outputs[0].call_id).toBe('call-1');
    expect(
      JSON.parse((outputs[outputs.length - 1]: any).output).message
    ).toContain('context window limit');

    // Retrying would re-send the oversized history to the user's endpoint
    // only to fail identically: it must be refused.
    await orchestrator.retryAfterError();
    expect(mockSendByokChatCompletion).toHaveBeenCalledTimes(3);
  });

  it('appends a failure output for a result that never finished, keeping the transcript valid', async () => {
    const executeFunctionCalls = mockFn(
      jest.fn(async () => ({
        results: [
          { status: 'aborted', call_id: 'call-1', success: false, output: {} },
        ],
        createdSceneNames: [],
        createdProject: null,
      }))
    );
    mockSendByokChatCompletion
      .mockResolvedValueOnce(
        makeResponse({
          toolCalls: [makeToolCall('call-1', 'describe_instances', '{}')],
        })
      )
      .mockResolvedValueOnce(makeResponse({ text: 'Noted.' }));
    const { orchestrator, aiRequest } = makeOrchestrator({
      executeFunctionCalls,
    });

    await orchestrator.startNewChat('Abort a tool');

    const outputs = (aiRequest.output || []).filter(
      message => message.type === 'function_call_output'
    );
    expect(outputs).toHaveLength(1);
    expect(outputs[0].call_id).toBe('call-1');
    expect(JSON.parse((outputs[0]: any).output).success).toBe(false);
    expect(JSON.parse((outputs[0]: any).output).message).toContain('aborted');
    // The follow-up request stays protocol-valid: the assistant tool_calls
    // are followed by a tool message.
    const secondCallMessages =
      mockSendByokChatCompletion.mock.calls[1][0].options.messages;
    const toolCallIndex = secondCallMessages.findIndex(
      (message: any) =>
        message.role === 'assistant' && message.tool_calls !== undefined
    );
    expect(toolCallIndex).toBeGreaterThan(-1);
    expect(secondCallMessages[toolCallIndex + 1].role).toBe('tool');
    expect(aiRequest.status).toBe('ready');
  });

  it('contains an executor crash as failure outputs and continues the loop', async () => {
    const executeFunctionCalls = mockFn(
      jest.fn(async () => {
        throw new Error('boom');
      })
    );
    mockSendByokChatCompletion
      .mockResolvedValueOnce(
        makeResponse({
          toolCalls: [makeToolCall('call-1', 'describe_instances', '{}')],
        })
      )
      .mockResolvedValueOnce(makeResponse({ text: 'Recovered.' }));
    const { orchestrator, aiRequest } = makeOrchestrator({
      executeFunctionCalls,
    });

    await orchestrator.startNewChat('Crash the executor');

    const outputs = (aiRequest.output || []).filter(
      message => message.type === 'function_call_output'
    );
    expect(outputs).toHaveLength(1);
    expect(JSON.parse((outputs[0]: any).output).success).toBe(false);
    expect(JSON.parse((outputs[0]: any).output).message).toContain('crashed');
    expect(aiRequest.status).toBe('ready');
    expect(mockSendByokChatCompletion).toHaveBeenCalledTimes(2);
  });

  it('marks an empty model answer as an error instead of a silent ready', async () => {
    mockSendByokChatCompletion.mockResolvedValueOnce(
      makeResponse({ text: null })
    );
    const { orchestrator, aiRequest } = makeOrchestrator();

    await orchestrator.startNewChat('Say nothing');

    expect(aiRequest.status).toBe('error');
    expect(aiRequest.error && aiRequest.error.code).toBe('byok-empty-answer');
  });
});

describe('capToolOutput', () => {
  it('keeps a short output unchanged', () => {
    expect(capToolOutput('{"success":true}')).toBe('{"success":true}');
  });

  it('truncates a long output to the cap and marks the cut', () => {
    const longOutput = 'x'.repeat(BYOK_TOOL_OUTPUT_CAP + 5000);
    const capped = capToolOutput(longOutput);

    expect(capped.length).toBeLessThanOrEqual(BYOK_TOOL_OUTPUT_CAP + 50);
    expect(capped).toContain('[output truncated]');
    expect(capped.startsWith('x'.repeat(BYOK_TOOL_OUTPUT_CAP))).toBe(true);
  });
});

describe('createByokSubAgentRunner', () => {
  it('is the real Phase 8 sub-agent runner (re-exported from ByokSubAgents)', () => {
    // The Phase 4 null-seam became real in Phase 8: the factory now builds
    // the scout/reviewer runner (its behavior is covered in
    // ByokSubAgents.spec.js) — assert the seam is no longer null.
    expect(typeof createByokSubAgentRunner).toBe('function');
    expect(
      createByokSubAgentRunner({
        connection: { baseUrl: 'https://example.invalid/v1', apiKey: 'k' },
        settings: DEFAULT_BYOK_SETTINGS,
        hasOpenedProject: () => false,
        getProject: () => null,
        getProjectUserContent: async () => null,
        createExecutor: () => {
          throw new Error('not used');
        },
        usageTracker: createByokUsageTracker(),
        sharedTurnBudget: { remaining: 10 },
      })
    ).not.toBe(null);
  });
});

const gd: libGDevelop = global.gd;

describe('ByokOrchestrator: local event writing interception (Phase 5)', () => {
  const makeProjectWithScene = (): any => {
    const project = gd.ProjectHelper.createNewGDJSProject();
    project.insertNewLayout('TestScene', 0);
    return project;
  };

  it('intercepts add_scene_events before the editor registry (zero backend, zero executor)', async () => {
    const project = makeProjectWithScene();
    try {
      const executeFunctionCalls = makeFakeExecutor();
      mockSendByokChatCompletion
        .mockResolvedValueOnce(
          makeResponse({
            toolCalls: [
              makeToolCall(
                'call-1',
                'add_scene_events',
                JSON.stringify({
                  scene_name: 'TestScene',
                  event_batches: [
                    {
                      event_script: 'always:\n  Wait(1)',
                      placement_relation: 'insert_at_end',
                    },
                  ],
                })
              ),
            ],
          })
        )
        .mockResolvedValueOnce(makeResponse({ text: 'Done.' }))
        // The completion gate (Phase 8.2) nudges once after an unverified
        // edit: the second claim is honored with the gate block.
        .mockResolvedValueOnce(makeResponse({ text: 'Done (confirmed).' }));
      const { orchestrator, aiRequest } = makeOrchestrator({
        executeFunctionCalls,
        getProject: () => project,
      });

      await orchestrator.startNewChat('Add events');

      expect(executeFunctionCalls).not.toHaveBeenCalled();
      const outputs = (aiRequest.output || []).filter(
        message => message.type === 'function_call_output'
      );
      expect(outputs).toHaveLength(1);
      const parsedOutput = JSON.parse((outputs[0]: any).output);
      expect(parsedOutput.success).toBe(true);
      expect(parsedOutput.message).toContain('Applied 1');
      // The events were really written to the scene, locally.
      const { renderEventsAsEventScript } = (jest.requireActual(
        '../../EventsSheet/EventsTree/TextRenderer/EventScriptRenderer'
      ): any);
      const { text } = renderEventsAsEventScript({
        eventsList: project.getLayout('TestScene').getEvents(),
      });
      expect(text).toContain('Wait(1)');
      expect(aiRequest.status).toBe('ready');
    } finally {
      project.delete();
    }
  });

  it('maps the hosted generate_events alias to the same local implementation', async () => {
    const project = makeProjectWithScene();
    try {
      const executeFunctionCalls = makeFakeExecutor();
      mockSendByokChatCompletion
        .mockResolvedValueOnce(
          makeResponse({
            toolCalls: [
              makeToolCall(
                'call-1',
                'generate_events',
                JSON.stringify({
                  scene_name: 'TestScene',
                  event_batches: [
                    {
                      event_script: 'always:\n  Wait(2)',
                      placement_relation: 'insert_at_end',
                    },
                  ],
                })
              ),
            ],
          })
        )
        .mockResolvedValueOnce(makeResponse({ text: 'Done.' }));
      const { orchestrator, aiRequest } = makeOrchestrator({
        executeFunctionCalls,
        getProject: () => project,
      });

      await orchestrator.startNewChat('Add events');

      expect(executeFunctionCalls).not.toHaveBeenCalled();
      const outputs = (aiRequest.output || []).filter(
        message => message.type === 'function_call_output'
      );
      expect(JSON.parse((outputs[0]: any).output).success).toBe(true);
    } finally {
      project.delete();
    }
  });
});

describe('ByokOrchestrator: stuck-loop guard (Phase 5)', () => {
  it('refuses the third identical call with a corrective output, stops on the fourth', async () => {
    const executeFunctionCalls = makeFakeExecutor();
    let round = 0;
    mockSendByokChatCompletion.mockImplementation(async () => {
      round++;
      return makeResponse({
        toolCalls: [
          makeToolCall(
            `call-${round}`,
            'describe_instances',
            '{"scene_name":"Scene"}'
          ),
        ],
      });
    });
    const { orchestrator, aiRequest } = makeOrchestrator({
      executeFunctionCalls,
    });

    await orchestrator.startNewChat('Loop');

    expect(aiRequest.status).toBe('error');
    expect(aiRequest.error && aiRequest.error.code).toBe(
      'byok-repeated-tool-call-loop'
    );
    // Rounds 1 and 2 executed; round 3 was refused with the corrective
    // message; round 4 stopped the chat.
    expect(executeFunctionCalls).toHaveBeenCalledTimes(2);
    expect(mockSendByokChatCompletion).toHaveBeenCalledTimes(4);
    const outputs = (aiRequest.output || []).filter(
      message => message.type === 'function_call_output'
    );
    expect(outputs).toHaveLength(4);
    expect(JSON.parse((outputs[2]: any).output).message).toContain(
      'already called this exact tool'
    );
    expect(JSON.parse((outputs[3]: any).output).message).toContain(
      'already called this exact tool'
    );
  });

  it('never trips the guard on repeated create_or_update_plan calls', async () => {
    let round = 0;
    mockSendByokChatCompletion.mockImplementation(async () => {
      round++;
      if (round > 3) return makeResponse({ text: 'Planned.' });
      return makeResponse({
        toolCalls: [
          makeToolCall(
            `call-${round}`,
            'create_or_update_plan',
            '{"tasks":[{"id":"task-1"}]}'
          ),
        ],
      });
    });
    const { orchestrator, aiRequest } = makeOrchestrator();

    await orchestrator.startNewChat('Plan');

    expect(aiRequest.status).toBe('ready');
    const outputs = (aiRequest.output || []).filter(
      message => message.type === 'function_call_output'
    );
    expect(outputs).toHaveLength(3);
    for (const output of outputs) {
      expect(JSON.parse((output: any).output).success).toBe(true);
    }
  });
});

describe('ByokOrchestrator: project creation and live getters (Phase 5)', () => {
  it('advertises initialize_project only while no project is open', async () => {
    mockSendByokChatCompletion.mockResolvedValueOnce(
      makeResponse({ text: 'Hi.' })
    );
    const { orchestrator } = makeOrchestrator({
      hasOpenedProject: () => false,
    });
    await orchestrator.startNewChat('Hi');

    const firstCallTools =
      mockSendByokChatCompletion.mock.calls[0][0].options.tools;
    expect(firstCallTools.map((tool: any) => tool.function.name)).toContain(
      'initialize_project'
    );
  });

  it('re-reads the project getters after initialize_project creates a project mid-chat', async () => {
    const createdProject = gd.ProjectHelper.createNewGDJSProject();
    createdProject.insertNewLayout('NewScene', 0);
    try {
      let projectIsOpen = false;
      const getProjectUserContent = mockFn(
        jest.fn(async () => '{"scenes":[]}')
      );
      const executor = mockFn(
        jest.fn(async (functionCalls: Array<any>) => ({
          results: functionCalls.map((functionCall: any) => ({
            status: 'finished',
            call_id: functionCall.call_id,
            success: true,
            output: { message: 'created' },
          })),
          createdSceneNames: [],
          createdProject,
        }))
      );
      mockSendByokChatCompletion
        .mockResolvedValueOnce(
          makeResponse({
            toolCalls: [
              makeToolCall(
                'call-1',
                'initialize_project',
                '{"project_name":"My game","template_slug":""}'
              ),
            ],
          })
        )
        .mockResolvedValueOnce(makeResponse({ text: 'Created.' }));
      const { orchestrator } = makeOrchestrator({
        hasOpenedProject: () => projectIsOpen,
        getProject: () => (projectIsOpen ? createdProject : null),
        getExecutor: () => executor,
        getProjectUserContent,
        onFunctionCallsExecuted: (results: any, meta: any) => {
          // The container remembers the created project synchronously —
          // the getters must see it on the very next round.
          if (meta.createdProject) projectIsOpen = true;
        },
      });

      await orchestrator.startNewChat('Make me a game');

      // The snapshot was fetched once for the message and once after the
      // project was created — not frozen at chat start.
      expect(getProjectUserContent).toHaveBeenCalledTimes(2);
      // The first turn advertised initialize_project; the second (after the
      // project exists) did not, and its system prompt left the
      // "no project" section behind.
      const firstCallOptions =
        mockSendByokChatCompletion.mock.calls[0][0].options;
      const secondCallOptions =
        mockSendByokChatCompletion.mock.calls[1][0].options;
      expect(
        firstCallOptions.tools.map((tool: any) => tool.function.name)
      ).toContain('initialize_project');
      expect(
        secondCallOptions.tools.map((tool: any) => tool.function.name)
      ).not.toContain('initialize_project');
      // The "no project" instructions swap out (13.5's task catalog
      // mentions the starter summary in both states, by design — the
      // section swap is the observable).
      expect(firstCallOptions.messages[0].content).toContain(
        'No project is opened'
      );
      expect(secondCallOptions.messages[0].content).not.toContain(
        'No project is opened'
      );
    } finally {
      createdProject.delete();
    }
  });
});

describe('ByokOrchestrator: images (Phase 6)', () => {
  const makeImageRuntimeDeps = () => ({
    captureSceneCanvas: () => 'data:image/jpeg;base64,QUJD',
    invokePreviewCapture: async () => ({ ok: false, error: 'unused' }),
    getPreviewLauncher: () => null,
    storeImage: async () =>
      registerByokImage({
        dataUrl: 'data:image/jpeg;base64,QUJD',
        width: 1024,
        height: 1024,
      }),
  });

  const countImageParts = (messages: Array<any>): number =>
    messages.reduce((count: number, message: any) => {
      if (message.role !== 'user' || !Array.isArray(message.content)) {
        return count;
      }
      return (
        count +
        message.content.filter((part: any) => part.type === 'image_url').length
      );
    }, 0);

  const runCaptureRounds = async (overrides: any) => {
    let round = 0;
    mockSendByokChatCompletion.mockImplementation(async () => {
      round++;
      if (round > 3) return makeResponse({ text: 'Seen.' });
      return makeResponse({
        toolCalls: [
          makeToolCall(
            `call-${round}`,
            'capture_scene_screenshot',
            JSON.stringify({ scene_name: `Scene ${round}` })
          ),
        ],
      });
    });
    const { orchestrator, aiRequest } = makeOrchestrator(overrides);
    await orchestrator.startNewChat('Look');
    const calls = mockSendByokChatCompletion.mock.calls;
    const lastCallMessages = calls[calls.length - 1][0].options.messages;
    return { aiRequest, lastCallMessages };
  };

  it('materializes screenshots as image parts, replaying every sent image until an explicit eviction (audit011026 B-CORE-4)', async () => {
    const { aiRequest, lastCallMessages } = await runCaptureRounds({
      runtimeDeps: makeImageRuntimeDeps(),
    });

    expect(aiRequest.status).toBe('ready');
    // The monotonic survival rule: a third capture does NOT retroactively
    // evict the first (that rewrote mid-transcript messages and re-busted
    // the provider prefix cache on every capture). All three replay.
    expect(countImageParts(lastCallMessages)).toBe(3);
    const placeholderText = lastCallMessages
      .filter((message: any) => Array.isArray(message.content))
      .map((message: any) => message.content[0].text)
      .join('\n');
    expect(placeholderText).not.toContain('removed to save context');
  });

  it('sends no image part at all with imageSupport "no"', async () => {
    const { aiRequest, lastCallMessages } = await runCaptureRounds({
      settings: {
        ...DEFAULT_BYOK_SETTINGS,
        modelName: 'test-model',
        imageSupport: 'no',
      },
      runtimeDeps: makeImageRuntimeDeps(),
    });

    expect(aiRequest.status).toBe('ready');
    expect(countImageParts(lastCallMessages)).toBe(0);
  });

  it('degrades to text-only once when the endpoint rejects images (auto mode)', async () => {
    const imageRejection = {
      response: {
        status: 400,
        data: {
          error: { message: 'This model does not support image content.' },
        },
      },
    };
    mockSendByokChatCompletion
      .mockResolvedValueOnce(
        makeResponse({
          toolCalls: [makeToolCall('call-1', 'capture_scene_screenshot', '{}')],
        })
      )
      .mockRejectedValueOnce(imageRejection)
      .mockResolvedValueOnce(makeResponse({ text: 'Text is enough.' }));
    const { orchestrator, aiRequest } = makeOrchestrator({
      runtimeDeps: makeImageRuntimeDeps(),
    });

    await orchestrator.startNewChat('Look');

    expect(aiRequest.status).toBe('ready');
    expect(mockSendByokChatCompletion).toHaveBeenCalledTimes(3);
    // The retried request carries no image part.
    const retriedMessages =
      mockSendByokChatCompletion.mock.calls[2][0].options.messages;
    expect(countImageParts(retriedMessages)).toBe(0);
  });

  it('evicts images under context pressure instead of stopping while text is small', async () => {
    // Two captures put two images in the transcript; the model then keeps
    // calling a cheap tool with usage that overflows the ratio until the
    // images are evicted — after which usage drops and the chat finishes.
    let round = 0;
    const inflatedUsage = {
      prompt_tokens: 8000,
      completion_tokens: 512,
      total_tokens: 8512,
    };
    const normalUsage = {
      prompt_tokens: 1000,
      completion_tokens: 100,
      total_tokens: 1100,
    };
    mockSendByokChatCompletion.mockImplementation(async () => {
      round++;
      if (round <= 2) {
        return makeResponse({
          toolCalls: [
            makeToolCall(
              `capture-${round}`,
              'capture_scene_screenshot',
              JSON.stringify({ scene_name: `Scene ${round}` })
            ),
          ],
        });
      }
      if (round <= 4) {
        // Two inflated rounds: enough to evict both images (2 to 1 to 0),
        // not enough to hard-stop while the text is small.
        return makeResponse({
          toolCalls: [
            makeToolCall(
              `plan-${round}`,
              'create_or_update_plan',
              `{"tasks":[{"id":"task-${round}"}]}`
            ),
          ],
          usage: inflatedUsage,
        });
      }
      if (round === 5) {
        return makeResponse({
          toolCalls: [
            makeToolCall(
              `plan-${round}`,
              'create_or_update_plan',
              `{"tasks":[{"id":"task-${round}"}]}`
            ),
          ],
          usage: normalUsage,
        });
      }
      return makeResponse({ text: 'Done.', usage: normalUsage });
    });
    const { orchestrator, aiRequest } = makeOrchestrator({
      runtimeDeps: makeImageRuntimeDeps(),
    });

    await orchestrator.startNewChat('Look then plan');

    // The loop survived the inflated rounds by evicting images (2 → 1 → 0)
    // and completed once usage came back down — images alone never stopped
    // the chat.
    expect(aiRequest.status).toBe('ready');
    const finalMessages =
      mockSendByokChatCompletion.mock.calls[
        mockSendByokChatCompletion.mock.calls.length - 1
      ][0].options.messages;
    expect(countImageParts(finalMessages)).toBe(0);
  });

  // ---- Phase 9: watchdog, compaction, routing, snapshot refresh ----

  describe('Phase 9: the stall watchdog', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('posts exactly one in-chat notice per silent window during a hung tool run', async () => {
      let releaseExecutor: ?() => void = null;
      const hungExecutor = mockFn(
        jest.fn(
          () =>
            new Promise(resolve => {
              releaseExecutor = () =>
                resolve({
                  results: [
                    {
                      status: 'finished',
                      call_id: 'call-1',
                      success: true,
                      output: { message: 'done' },
                    },
                  ],
                  createdSceneNames: [],
                  createdProject: null,
                });
            })
        )
      );
      mockSendByokChatCompletion
        .mockResolvedValueOnce(
          makeResponse({
            toolCalls: [
              makeToolCall('call-1', 'create_scene', '{"scene_name":"X"}'),
            ],
          })
        )
        .mockResolvedValueOnce(makeResponse({ text: 'Recovered.' }));
      const { orchestrator, aiRequest } = makeOrchestrator({
        executeFunctionCalls: hungExecutor,
      });

      const runPromise = orchestrator.startNewChat('Do something');
      // The response arrived, the (hung) tool run started: a gap. One
      // window of silence → one notice; a second window → one more.
      await flushMicrotasks();
      jest.advanceTimersByTime(90000);
      jest.advanceTimersByTime(90000);
      await flushMicrotasks();
      const stallNotices = (aiRequest.output || []).filter(
        (message: any) =>
          message.type === 'byok_notice' && message.noticeKind === 'stall'
      );
      expect(stallNotices).toHaveLength(2);
      expect(((stallNotices[0]: any): any).text).toContain('90s');

      if (releaseExecutor) releaseExecutor();
      await flushMicrotasks();
      await runPromise;
      expect(aiRequest.status).toBe('ready');
    });

    it('never fires when the toggle is off', async () => {
      const liveSettings = {
        ...DEFAULT_BYOK_SETTINGS,
        modelName: 'test-model',
        stallWatchdogEnabled: false,
        stallWindowSeconds: 90,
      };
      mockSendByokChatCompletion
        .mockResolvedValueOnce(
          makeResponse({
            toolCalls: [
              makeToolCall('call-1', 'create_scene', '{"scene_name":"X"}'),
            ],
          })
        )
        .mockResolvedValueOnce(makeResponse({ text: 'Done.' }));
      const { orchestrator, aiRequest } = makeOrchestrator({
        executeFunctionCalls: makeFakeExecutor(),
        getSettings: () => liveSettings,
      });

      const runPromise = orchestrator.startNewChat('Do something');
      await flushMicrotasks();
      jest.advanceTimersByTime(600000);
      await flushMicrotasks();
      expect(
        (aiRequest.output || []).filter(
          (message: any) => message.type === 'byok_notice'
        )
      ).toHaveLength(0);

      await flushMicrotasks();
      await runPromise;
      expect(aiRequest.status).toBe('ready');
    });
  });

  describe('Phase 9: context compaction', () => {
    it('compacts at 0.75 of the window before the model call and marks the transcript', async () => {
      const liveSettings = {
        ...DEFAULT_BYOK_SETTINGS,
        modelName: 'test-model',
        contextWindowTokens: 1000,
      };
      // Response #1: the compaction summarizer (fast profile). Response
      // #2: the main call, which must receive the compacted transcript.
      mockSendByokChatCompletion
        .mockResolvedValueOnce(
          makeResponse({ text: 'The user asked to build a game.' })
        )
        .mockResolvedValueOnce(makeResponse({ text: 'Continuing.' }));

      const transcript: Array<any> = [];
      for (let index = 0; index < 14; index++) {
        transcript.push({
          type: 'message',
          status: 'completed',
          role: 'user',
          content: [
            {
              type: 'user_request',
              status: 'completed',
              text: `old request ${index}`,
            },
          ],
        });
        transcript.push({
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              status: 'completed',
              text: `old answer ${index}`,
              annotations: [],
            },
          ],
        });
      }
      const { orchestrator, aiRequest } = makeOrchestrator({
        getSettings: () => liveSettings,
      });
      aiRequest.contextStats = { totalTokens: 900, usedPercentage: 0.8 };
      aiRequest.output = ((transcript: any): any);

      await orchestrator.sendUserMessage('Keep going');

      expect(aiRequest.status).toBe('ready');
      const notices = (aiRequest.output || []).filter(
        (message: any) =>
          message.type === 'byok_notice' &&
          message.noticeKind === 'context-summarized'
      );
      expect(notices).toHaveLength(1);
      // The summarizer ran (call #1) and the main call (#2) got a shorter
      // transcript: the old region is gone, the summary text present.
      expect(mockSendByokChatCompletion).toHaveBeenCalledTimes(2);
      const mainMessages =
        mockSendByokChatCompletion.mock.calls[1][0].options.messages;
      const serialized = JSON.stringify(mainMessages);
      expect(serialized).not.toContain('old request 3');
      expect(serialized).toContain('The user asked to build a game.');
    });

    it('does not compact below the threshold', async () => {
      const liveSettings = {
        ...DEFAULT_BYOK_SETTINGS,
        modelName: 'test-model',
      };
      mockSendByokChatCompletion.mockResolvedValueOnce(
        makeResponse({ text: 'Done.' })
      );
      const { orchestrator, aiRequest } = makeOrchestrator({
        getSettings: () => liveSettings,
      });
      aiRequest.contextStats = { totalTokens: 100, usedPercentage: 0.4 };
      aiRequest.output = [
        {
          type: 'message',
          status: 'completed',
          role: 'user',
          content: [{ type: 'user_request', status: 'completed', text: 'hi' }],
        },
      ];

      await orchestrator.sendUserMessage('Keep going');
      expect(
        (aiRequest.output || []).filter(
          (message: any) => message.type === 'byok_notice'
        )
      ).toHaveLength(0);
    });
  });

  describe('Phase 9: the per-round snapshot refresh', () => {
    it('re-reads the snapshot after a round that edited the project', async () => {
      const editingExecutor = mockFn(
        jest.fn(async (functionCalls: Array<any>) => ({
          results: functionCalls.map((functionCall: any) => ({
            status: 'finished',
            call_id: functionCall.call_id,
            success: true,
            output: { message: 'edited' },
            didModifyProject: true,
          })),
          createdSceneNames: [],
          createdProject: null,
        }))
      );
      const getProjectUserContent = mockFn(
        jest.fn(async () => '{"scenes":["fresh"]}')
      );
      mockSendByokChatCompletion
        .mockResolvedValueOnce(
          makeResponse({
            toolCalls: [
              makeToolCall('call-1', 'create_scene', '{"scene_name":"X"}'),
            ],
          })
        )
        .mockResolvedValueOnce(makeResponse({ text: 'Done.' }));
      const { orchestrator } = makeOrchestrator({
        executeFunctionCalls: editingExecutor,
        getProjectUserContent,
      });

      await orchestrator.startNewChat('Edit something');

      // Turn start + the refresh after the editing round.
      expect(getProjectUserContent).toHaveBeenCalledTimes(2);
      const secondCallMessages =
        mockSendByokChatCompletion.mock.calls[1][0].options.messages;
      expect(
        secondCallMessages.some(
          (message: any) =>
            typeof message.content === 'string' &&
            message.content.includes('{"scenes":["fresh"]}')
        )
      ).toBe(true);
    });

    it('degrades to the previous snapshot with a warning line when the refresh fails', async () => {
      const editingExecutor = mockFn(
        jest.fn(async (functionCalls: Array<any>) => ({
          results: functionCalls.map((functionCall: any) => ({
            status: 'finished',
            call_id: functionCall.call_id,
            success: true,
            output: { message: 'edited' },
            didModifyProject: true,
          })),
          createdSceneNames: [],
          createdProject: null,
        }))
      );
      const getProjectUserContent = mockFn(jest.fn())
        .mockResolvedValueOnce('{"scenes":["initial"]}')
        .mockRejectedValueOnce(new Error('project closed'));
      mockSendByokChatCompletion
        .mockResolvedValueOnce(
          makeResponse({
            toolCalls: [
              makeToolCall('call-1', 'create_scene', '{"scene_name":"X"}'),
            ],
          })
        )
        // The completion gate nudge (edits were made but unverified) and
        // the honored second claim each take a model call.
        .mockResolvedValueOnce(makeResponse({ text: 'Still working.' }))
        .mockResolvedValueOnce(makeResponse({ text: 'Done.' }));
      const { orchestrator, aiRequest } = makeOrchestrator({
        executeFunctionCalls: editingExecutor,
        getProjectUserContent,
      });

      await orchestrator.startNewChat('Edit something');

      expect(aiRequest.status).toBe('ready');
      const notices = (aiRequest.output || []).filter(
        (message: any) =>
          message.type === 'byok_notice' &&
          message.noticeKind === 'snapshot-stale'
      );
      expect(notices).toHaveLength(1);
    });
  });

  describe('Phase 9: the remembered reasoning_effort degradation', () => {
    it('sends the configured effort until the capability cache says degraded', async () => {
      const liveSettings = {
        ...DEFAULT_BYOK_SETTINGS,
        modelName: 'test-model',
        reasoningEffort: 'high',
      };
      mockSendByokChatCompletion
        .mockResolvedValueOnce(makeResponse({ text: 'First answer.' }))
        .mockResolvedValueOnce(makeResponse({ text: 'Second answer.' }));
      const { orchestrator, aiRequest } = makeOrchestrator({
        getSettings: () => liveSettings,
      });

      await orchestrator.startNewChat('Hello');
      expect(aiRequest.status).toBe('ready');
      expect(
        mockSendByokChatCompletion.mock.calls[0][0].options.reasoningEffort
      ).toBe('high');

      // The capability cache remembers the degradation (written by the
      // client callback through onCapabilityUpdate): the parameter is not
      // sent again, whatever the settings still say.
      liveSettings.capabilitiesByTargetKey = {
        'https://api.example.com/v1::test-model': {
          images: null,
          effortLevels: null,
          reasoningEffortDegraded: true,
          strictSchemas: null,
          parallelToolCalls: null,
          updatedAt: '2026-09-23T00:00:00.000Z',
        },
      };
      await orchestrator.sendUserMessage('And again');
      expect(
        'reasoningEffort' in mockSendByokChatCompletion.mock.calls[1][0].options
      ).toBe(false);
    });
  });

  describe('Phase 9: multi-provider routing', () => {
    it('routes the main call through the per-chat dropdown provider', async () => {
      const liveSettings = {
        ...DEFAULT_BYOK_SETTINGS,
        endpointUrl: 'https://legacy.example.com/v1',
        modelName: 'legacy-model',
        providers: [
          {
            id: 'prov-a',
            name: 'Alpha',
            endpointUrl: 'https://alpha.example.com/v1',
            keyRef: 'prov-a',
          },
        ],
      };
      mockSendByokChatCompletion.mockResolvedValue(
        makeResponse({ text: 'Answer.' })
      );
      const { orchestrator, aiRequest } = makeOrchestrator({
        getSettings: () => liveSettings,
        getApiKeyForProvider: async keyRef =>
          keyRef === 'prov-a' ? 'sk-alpha' : 'sk-legacy',
      });
      (aiRequest: any).byokModelSelection = {
        providerId: 'prov-a',
        modelName: 'alpha-model',
        reasoningEffort: 'default',
      };

      await orchestrator.startNewChat('Hello');

      const call = mockSendByokChatCompletion.mock.calls[0][0];
      expect(call.baseUrl).toBe('https://alpha.example.com/v1');
      expect(call.apiKey).toBe('sk-alpha');
      expect(call.options.model).toBe('alpha-model');
      expect(aiRequest.status).toBe('ready');
    });

    it('uses the injected global connection when no provider resolver exists', async () => {
      mockSendByokChatCompletion.mockResolvedValue(
        makeResponse({ text: 'Answer.' })
      );
      const { orchestrator } = makeOrchestrator();
      await orchestrator.startNewChat('Hello');
      const call = mockSendByokChatCompletion.mock.calls[0][0];
      expect(call.baseUrl).toBe('https://api.example.com/v1');
      expect(call.apiKey).toBe('sk-test');
      expect(call.options.model).toBe('test-model');
    });
  });

  it('attaches the picked image ids to the user message and its replay (Phase 13.3)', async () => {
    const { registerByokImage, getByokImage } = require('./ByokImageContent');
    const image = registerByokImage({
      dataUrl: 'data:image/png;base64,QATTACH',
      width: 64,
      height: 64,
    });
    mockSendByokChatCompletion.mockResolvedValue(
      makeResponse({ text: 'Got it!' })
    );
    const { orchestrator, aiRequest } = makeOrchestrator({});

    await orchestrator.startNewChat('What is on this picture?', [image.id]);

    const firstMessage: any = (aiRequest.output || [])[0];
    expect(firstMessage.role).toBe('user');
    expect(firstMessage.images).toEqual([image.id]);

    // The replay materializes the image part for the model.
    const sentOptions = mockSendByokChatCompletion.mock.calls[0][0].options;
    const firstUserMessage = sentOptions.messages.find(
      (message: any) => message.role === 'user'
    );
    expect(Array.isArray(firstUserMessage.content)).toBe(true);
    expect(firstUserMessage.content).toEqual(
      expect.arrayContaining([
        { type: 'image_url', image_url: { url: image.dataUrl } },
      ])
    );
    expect(getByokImage(image.id)).not.toBe(null);
  });
});

describe('ByokOrchestrator: prompt-cache stability (Phase 14.1)', () => {
  // The notes loader is spied on (the spec environment has no DOM): the
  // spy returns fresh notes from the second call on, which a non-frozen
  // prompt would pick up (the exact cache-buster D14-1 freezes).
  let notesLoader: any;
  beforeEach(() => {
    mockSendByokChatCompletion.mockReset();
    (createByokCancellation: any).mockImplementation(() => ({
      token: { __fakeCancelToken: true },
      cancel: mockFn(jest.fn()),
    }));
    clearByokModels();
    notesLoader = mockFn(jest.fn(async () => null));
    jest
      .spyOn(ByokProjectNotesModule, 'loadByokProjectNotes')
      // $FlowFixMe[cannot-write]
      .mockImplementation(identifier => notesLoader(identifier));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reuses the system message byte-identically across rounds, including after update_project_notes', async () => {
    // Round 1: the model updates the project notes (which really persist
    // mid-chat). Round 2: another tool call. Round 3: the final answer.
    mockSendByokChatCompletion
      .mockResolvedValueOnce(
        makeResponse({
          toolCalls: [
            makeToolCall(
              'call-1',
              'update_project_notes',
              '{"conventions":"Pixel-art tiles only"}'
            ),
          ],
        })
      )
      .mockResolvedValueOnce(
        makeResponse({
          toolCalls: [makeToolCall('call-2', 'describe_instances', '{}')],
        })
      )
      .mockResolvedValueOnce(makeResponse({ text: 'Done.' }));
    // The real write path is driven: update_project_notes is an intercepted
    // extra tool, so it never reaches the executor — spying the storage
    // pair (what the handler actually calls) is what makes the mid-chat
    // write real. A previous version of this spec flipped a flag from the
    // EXECUTOR mock, which never fires for an intercepted tool: the notes
    // never arrived and the byte-stability assertion passed vacuously.
    let notesArrived = false;
    const promptComposer = jest.spyOn(
      ByokPromptsModule,
      'buildByokSystemPrompt'
    );
    // The real loader never resolves null (every failure path returns the
    // empty-notes record), so the "no notes yet" state is that record.
    notesLoader.mockImplementation(async () =>
      notesArrived
        ? {
            conventions: 'Pixel-art tiles only',
            inProgress: '',
            decisions: '',
            updatedAt: '2026-09-27T00:00:00.000Z',
          }
        : { conventions: '', inProgress: '', decisions: '', updatedAt: '' }
    );
    jest
      .spyOn(ByokProjectNotesModule, 'saveByokProjectNotes')
      // $FlowFixMe[cannot-write]
      .mockImplementation(async () => {
        notesArrived = true;
        return true;
      });
    const executeFunctionCalls = mockFn(
      jest.fn(async (functionCalls: Array<any>) => ({
        results: functionCalls.map((functionCall: any) => ({
          status: 'finished',
          call_id: functionCall.call_id,
          success: true,
          output: { message: 'done' },
        })),
        createdSceneNames: [],
        createdProject: null,
      }))
    );
    const { orchestrator, aiRequest } = makeOrchestrator({
      executeFunctionCalls,
      getProjectNotesIdentifier: () => 'spec-freeze',
    });

    await orchestrator.startNewChat('Note it down and inspect the scene');

    expect(aiRequest.status).toBe('ready');
    expect(mockSendByokChatCompletion).toHaveBeenCalledTimes(3);
    const modelCalls = mockSendByokChatCompletion.mock.calls.map(
      call => call[0].options
    );
    // The system message is byte-identical across all three rounds — the
    // mid-chat note write must NOT re-compose it (D14-1).
    const systemContents = modelCalls.map(options => options.messages[0]);
    expect(
      systemContents.every(
        message =>
          message.role === 'system' &&
          message.content === systemContents[0].content
      )
    ).toBe(true);
    // The frozen prompt was composed BEFORE the note existed: the fresh
    // notes never leaked into it (staleness accepted until chat end).
    expect(systemContents[0].content).not.toContain('Pixel-art tiles only');
    // The note really was persisted mid-chat (the write path ran), and the
    // prompt was composed EXACTLY ONCE for the whole chat: this is the
    // snapshot-hit assertion that catches a broken invalidation key (the
    // 2026-10-02 audit regression where the notes identifier was compared
    // but never stored, so every round re-composed and busted the cache).
    expect(notesArrived).toBe(true);
    // The prompt was composed EXACTLY ONCE for the whole chat. This is the
    // snapshot-hit assertion that catches a broken invalidation key (the
    // 2026-10-02 audit regression where the notes identifier was compared
    // but never stored, so every round re-composed and busted the provider
    // prefix cache). Counting the composer — not the notes loader, which
    // the update_project_notes handler also calls to read-merge — is what
    // makes this precise.
    expect(promptComposer).toHaveBeenCalledTimes(1);
    // The tools array is identical across rounds too (fixed order, fixed
    // schemas — the other prefix-cache-stable block of the request).
    const toolsJson = modelCalls.map(options => JSON.stringify(options.tools));
    expect(toolsJson.every(json => json === toolsJson[0])).toBe(true);
  });

  it('invalidates the system snapshot exactly once when the project state flips mid-chat', async () => {
    let projectIsOpen = false;
    mockSendByokChatCompletion
      .mockResolvedValueOnce(
        makeResponse({
          toolCalls: [makeToolCall('call-1', 'describe_instances', '{}')],
        })
      )
      .mockResolvedValueOnce(
        makeResponse({
          toolCalls: [makeToolCall('call-2', 'describe_instances', '{}')],
        })
      )
      .mockResolvedValueOnce(makeResponse({ text: 'Done.' }));
    // The project appears between round 1 and round 2 (the way
    // initialize_project or a user opening one does).
    const executeFunctionCalls = mockFn(
      jest.fn(async (functionCalls: Array<any>) => {
        projectIsOpen = true;
        return {
          results: functionCalls.map((functionCall: any) => ({
            status: 'finished',
            call_id: functionCall.call_id,
            success: true,
            output: { message: 'done' },
          })),
          createdSceneNames: [],
          createdProject: null,
        };
      })
    );
    const { orchestrator, aiRequest } = makeOrchestrator({
      executeFunctionCalls,
      hasOpenedProject: () => projectIsOpen,
      getProjectUserContent: async () =>
        projectIsOpen ? '{"scenes":["Scene"]}' : null,
    });

    await orchestrator.startNewChat('Inspect twice');

    expect(aiRequest.status).toBe('ready');
    expect(mockSendByokChatCompletion).toHaveBeenCalledTimes(3);
    const modelCalls = mockSendByokChatCompletion.mock.calls.map(
      call => call[0].options
    );
    const systemContents = modelCalls.map(options => options.messages[0]);
    // Round 1 (no project) vs rounds 2–3 (project open): ONE invalidation —
    // the prompt is re-composed on the flip and then frozen again.
    expect(systemContents[1].content).not.toBe(systemContents[0].content);
    expect(systemContents[2].content).toBe(systemContents[1].content);
    // The advertised tools follow the same state: initialize_project is
    // offered only while no project exists, then drops out — and stays
    // byte-identical within each state.
    const round1Tools = modelCalls[0].tools.map(
      (tool: any) => tool.function.name
    );
    const round2Tools = modelCalls[1].tools.map(
      (tool: any) => tool.function.name
    );
    expect(round1Tools).toContain('initialize_project');
    expect(round2Tools).not.toContain('initialize_project');
    expect(JSON.stringify(modelCalls[2].tools)).toBe(
      JSON.stringify(modelCalls[1].tools)
    );
  });

  it('keeps the transcript replay append-only across EDITING rounds: the refreshed snapshot only ever changes the trailing message (owner order 2026-09-27)', async () => {
    // A 3-round turn where EVERY round edits the project, so the Phase
    // 9.7 per-round refresh fires between rounds — the exact case that
    // used to rewrite the last user message mid-request and re-bust the
    // provider prefix cache on every editing round.
    let snapshotVersion = 1;
    const getProjectUserContent = mockFn(
      jest.fn(async () => `{"version":${snapshotVersion}}`)
    );
    const executeFunctionCalls = mockFn(
      jest.fn(async (functionCalls: Array<any>) => {
        snapshotVersion++;
        return {
          results: functionCalls.map((functionCall: any) => ({
            status: 'finished',
            call_id: functionCall.call_id,
            success: true,
            output: { message: 'done' },
            didModifyProject: true,
          })),
          createdSceneNames: [],
          createdProject: null,
        };
      })
    );
    mockSendByokChatCompletion
      .mockResolvedValueOnce(
        makeResponse({
          toolCalls: [makeToolCall('call-1', 'create_scene', '{}')],
        })
      )
      .mockResolvedValueOnce(
        makeResponse({
          toolCalls: [makeToolCall('call-2', 'create_scene', '{}')],
        })
      )
      // Round 3 claims done WITHOUT verifying after edits — the Phase 8
      // completion gate nudges once (a real build turn's shape), which
      // appends a user-role nudge message and runs one more round.
      .mockResolvedValueOnce(makeResponse({ text: 'Done.' }))
      .mockResolvedValueOnce(makeResponse({ text: 'Done, verified.' }));
    const { orchestrator, aiRequest } = makeOrchestrator({
      executeFunctionCalls,
      getProjectUserContent,
    });

    await orchestrator.startNewChat('Build the game');

    expect(aiRequest.status).toBe('ready');
    expect(mockSendByokChatCompletion).toHaveBeenCalledTimes(4);
    const requests = mockSendByokChatCompletion.mock.calls.map(
      call => call[0].options.messages
    );

    // The snapshot is ALWAYS the request's own last message, carrying the
    // freshest content (refreshed after each editing round; the nudge
    // round executes no tools, so it reuses the last refresh).
    expect(requests[0][requests[0].length - 1].content).toContain(
      '"version":1'
    );
    expect(requests[1][requests[1].length - 1].content).toContain(
      '"version":2'
    );
    expect(requests[2][requests[2].length - 1].content).toContain(
      '"version":3'
    );
    expect(requests[3][requests[3].length - 1].content).toContain(
      '"version":3'
    );
    for (const messages of requests) {
      const last = messages[messages.length - 1];
      expect(last.role).toBe('user');
      expect(last.content).toContain(
        '[Current simplified project snapshot, as JSON'
      );
    }

    // The user's message is never rewritten (the old fold behavior did
    // exactly that): identical bytes across all rounds, snapshot-free.
    const userMessages = requests.map(messages =>
      messages.find(
        (message: any) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.includes('Build the game')
      )
    );
    expect(userMessages).toHaveLength(4);
    for (const userMessage of userMessages) {
      expect(userMessage.content).toBe(userMessages[0].content);
      expect(userMessage.content).not.toContain(
        'Current simplified project snapshot'
      );
    }

    // The cache contract itself: strip the trailing snapshot off each
    // request, and every earlier request is a byte-identical PREFIX of the
    // next one — the provider can cache everything up to the tail, across
    // editing rounds AND the completion-gate nudge alike.
    const stripped = requests.map(messages => messages.slice(0, -1));
    expect(stripped[1].slice(0, stripped[0].length)).toEqual(stripped[0]);
    expect(stripped[2].slice(0, stripped[1].length)).toEqual(stripped[1]);
    expect(stripped[3].slice(0, stripped[2].length)).toEqual(stripped[2]);
  });
});

describe('ByokOrchestrator: audit011026 fixes', () => {
  let notesLoader: any;
  beforeEach(() => {
    mockSendByokChatCompletion.mockReset();
    (createByokCancellation: any).mockImplementation(() => ({
      token: { __fakeCancelToken: true },
      cancel: mockFn(jest.fn()),
    }));
    clearByokModels();
    notesLoader = mockFn(jest.fn(async () => null));
    jest
      .spyOn(ByokProjectNotesModule, 'loadByokProjectNotes')
      // $FlowFixMe[cannot-write]
      .mockImplementation(identifier => notesLoader(identifier));
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('B-CORE-1: sends the profile-resolved temperature and max_tokens on every main-loop call', async () => {
    mockSendByokChatCompletion.mockResolvedValueOnce(
      makeResponse({ text: 'Done.' })
    );
    const { orchestrator } = makeOrchestrator({
      settings: {
        ...DEFAULT_BYOK_SETTINGS,
        providers: [
          {
            id: 'p1',
            name: 'Provider One',
            endpointUrl: 'https://p1.example.com/v1',
            keyRef: 'p1',
            modelSettings: [],
          },
        ],
        strongProfile: {
          providerId: 'p1',
          modelName: 'small-local-model',
          temperature: 0.7,
          maxTokens: 999,
        },
      },
      getApiKeyForProvider: async () => 'sk-p1',
    });

    await orchestrator.startNewChat('Hello');

    expect(mockSendByokChatCompletion).toHaveBeenCalledTimes(1);
    const options = mockSendByokChatCompletion.mock.calls[0][0].options;
    expect(options.model).toBe('small-local-model');
    expect(options.temperature).toBe(0.7);
    expect(options.maxTokens).toBe(999);
  });

  it('B-CORE-2: a loop-guard stop in a parallel batch leaves no orphaned tool call', async () => {
    const executeFunctionCalls = makeFakeExecutor();
    let round = 0;
    mockSendByokChatCompletion.mockImplementation(async () => {
      round++;
      if (round <= 3) {
        return makeResponse({
          toolCalls: [
            makeToolCall(
              `call-${round}`,
              'describe_instances',
              '{"scene_name":"Scene"}'
            ),
          ],
        });
      }
      // Round 4: the identical call (the 4th repeat → stop) arrives in a
      // parallel batch with siblings before and after it.
      return makeResponse({
        toolCalls: [
          makeToolCall('call-4a', 'describe_scene', '{"scene_name":"Scene"}'),
          makeToolCall(
            'call-4b',
            'describe_instances',
            '{"scene_name":"Scene"}'
          ),
          makeToolCall('call-4c', 'read_game_project_json', '{}'),
        ],
      });
    });
    const { orchestrator, aiRequest } = makeOrchestrator({
      executeFunctionCalls,
    });

    await orchestrator.startNewChat('Loop in parallel');

    expect(aiRequest.status).toBe('error');
    expect(aiRequest.error && aiRequest.error.code).toBe(
      'byok-repeated-tool-call-loop'
    );
    // Every tool call of the final batch — proceeding, stopped and
    // dropped-after-stop alike — has its matching function_call_output:
    // an orphaned tool_call would make the transcript protocol-invalid
    // and un-retryable on strict endpoints.
    const lastAssistant = (aiRequest.output || [])
      .filter(
        message => message.type === 'message' && message.role === 'assistant'
      )
      .pop();
    if (!lastAssistant) throw new Error('No assistant message found.');
    const lastCallIds = lastAssistant.content
      .filter((item: any) => item.type === 'function_call')
      .map((item: any) => item.call_id);
    expect(lastCallIds).toHaveLength(3);
    const outputCallIds = new Set(
      (aiRequest.output || [])
        .filter(message => message.type === 'function_call_output')
        .map(message => message.call_id)
    );
    for (const callId of lastCallIds) {
      expect(outputCallIds.has(callId)).toBe(true);
    }
  });

  it('B-CORE-3: switching the notes identifier between messages recomposes the prompt', async () => {
    let identifier = 'proj-a';
    mockSendByokChatCompletion
      .mockResolvedValueOnce(makeResponse({ text: 'A talk' }))
      .mockResolvedValueOnce(makeResponse({ text: 'B talk' }));
    notesLoader.mockImplementation(async id =>
      id === 'proj-a'
        ? {
            conventions: 'Conventions of project A',
            inProgress: '',
            decisions: '',
            updatedAt: '2026-10-01T00:00:00.000Z',
          }
        : {
            conventions: 'Conventions of project B',
            inProgress: '',
            decisions: '',
            updatedAt: '2026-10-01T00:00:00.000Z',
          }
    );
    const { orchestrator } = makeOrchestrator({
      getProjectNotesIdentifier: () => identifier,
    });

    await orchestrator.startNewChat('First');
    identifier = 'proj-b';
    await orchestrator.sendUserMessage('Second');

    const systemContents = mockSendByokChatCompletion.mock.calls.map(
      call => call[0].options.messages[0].content
    );
    expect(systemContents[0]).toContain('Conventions of project A');
    expect(systemContents[1]).toContain('Conventions of project B');
  });
});

describe('ByokOrchestrator: tool-call pairing safety net', () => {
  beforeEach(() => {
    mockSendByokChatCompletion.mockReset();
    (createByokCancellation: any).mockImplementation(() => ({
      token: { __fakeCancelToken: true },
      cancel: mockFn(jest.fn()),
    }));
    clearByokModels();
  });

  // Every assistant tool_call must be followed by a tool message, or a
  // strict endpoint rejects every later replay with a 400 and Retry
  // replays the same broken transcript (the B-CORE-2 brick class).
  const orphanCallIds = (transcript: Array<any>): Array<string> => {
    const calledIds: Array<string> = [];
    const answeredIds = new Set<string>();
    for (const message of transcript) {
      if (message.type === 'function_call_output') {
        answeredIds.add(message.call_id);
      }
      if (message.type !== 'message' || message.role !== 'assistant') continue;
      for (const item of message.content || []) {
        if (item.type === 'function_call') calledIds.push(item.call_id);
      }
    }
    return calledIds.filter(callId => !answeredIds.has(callId));
  };

  it('answers the batch when the extensions reload throws after the calls', async () => {
    // The editor-side extensions reload runs once per batch, after the
    // intercepted tools, whenever one of them edited an extension. A
    // project with a broken generated extension makes it throw — and an
    // exception escaping there used to leave the editor calls of the batch
    // with no tool output at all (this batch mixes an intercepted tool and
    // a registry tool).
    mockSendByokChatCompletion
      .mockResolvedValueOnce(
        makeResponse({
          toolCalls: [
            makeToolCall(
              'call-1',
              'create_extension_BYOK',
              '{"extension_name":"MyExt"}'
            ),
            makeToolCall('call-2', 'describe_instances', '{}'),
          ],
        })
      )
      .mockResolvedValueOnce(makeResponse({ text: 'Done.' }));
    const extensionStub: any = {
      setName: mockFn(jest.fn()),
      setFullName: mockFn(jest.fn()),
      setShortDescription: mockFn(jest.fn()),
      setDescription: mockFn(jest.fn()),
      setVersion: mockFn(jest.fn()),
      setAuthor: mockFn(jest.fn()),
      setCategory: mockFn(jest.fn()),
      setOrigin: mockFn(jest.fn()),
    };
    // The extension does not exist until create_extension_BYOK inserts it; the
    // metadata reload then finds it by name.
    let extensionExists = false;
    const projectStub: any = {
      hasEventsFunctionsExtensionNamed: () => extensionExists,
      insertNewEventsFunctionsExtension: () => {
        extensionExists = true;
        return extensionStub;
      },
      getEventsFunctionsExtensionsCount: () => 0,
      getEventsFunctionsExtension: () => extensionStub,
    };
    let reloadAttempted = false;
    const { orchestrator, aiRequest } = makeOrchestrator({
      getProject: () => projectStub,
      reloadEventsFunctionsExtensionMetadata: () => {
        reloadAttempted = true;
        throw new Error('broken generated extension');
      },
    });

    await orchestrator.startNewChat('Add an extension and inspect the scene');

    // Non-vacuity: the reload really ran and really threw. Without the
    // fix this throws out of the batch, the editor call of the batch never
    // gets its output, and the assertion below fails.
    expect(reloadAttempted).toBe(true);
    expect(orphanCallIds(aiRequest.output || [])).toEqual([]);
    // (The chat's final status is not asserted: create_extension_BYOK trips the
    // completion gate, which is orthogonal to the pairing invariant.)
  });

  it('answers the batch when the edit approval prompt rejects', async () => {
    mockSendByokChatCompletion
      .mockResolvedValueOnce(
        makeResponse({
          toolCalls: [makeToolCall('call-1', 'put_2d_instances', '{}')],
        })
      )
      .mockResolvedValueOnce(makeResponse({ text: 'Done.' }));
    const { orchestrator, aiRequest } = makeOrchestrator({
      doesCallRequireApproval: () => true,
      onRequestEditApproval: async () => {
        throw new Error('the approval dialog was closed');
      },
    });

    await orchestrator.startNewChat('Place the player');

    expect(orphanCallIds(aiRequest.output || [])).toEqual([]);
  });

  it('never duplicates an output for a call that already answered', async () => {
    mockSendByokChatCompletion
      .mockResolvedValueOnce(
        makeResponse({
          toolCalls: [makeToolCall('call-1', 'describe_instances', '{}')],
        })
      )
      .mockResolvedValueOnce(makeResponse({ text: 'Done.' }));
    const { orchestrator, aiRequest } = makeOrchestrator();

    await orchestrator.startNewChat('Inspect the scene');

    const outputIds = (aiRequest.output || []: any[])
      .filter(message => message.type === 'function_call_output')
      .map(message => message.call_id);
    expect(outputIds).toEqual(['call-1']);
  });
});
