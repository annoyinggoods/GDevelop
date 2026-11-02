// @flow
import {
  BYOK_VERIFY_TOOL_NAMES,
  buildByokCompletionGateBlock,
  checkByokCompletionGate,
  findUnfixedFailingGameplayTests,
} from './ByokCompletionGate';
import { createByokOrchestrator } from './ByokOrchestrator';
import { sendByokChatCompletionWithRetries } from './ByokClient';
import { createByokAiRequestShell } from './ByokTranscript';
import { DEFAULT_BYOK_SETTINGS } from './ByokTypes';
import { createByokUsageTracker } from './ByokUsageTracker';

jest.mock('./ByokClient', () => ({
  sendByokChatCompletionWithRetries: (jest.fn(): any),
  createByokCancellation: jest.fn(() => ({
    token: { __fakeCancelToken: true },
    cancel: (jest.fn(): any),
  })),
}));

const mockSendByokChatCompletion: any = sendByokChatCompletionWithRetries;

const gd: libGDevelop = global.gd;

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

const makeAssistantToolCallMessage = (
  callId: string,
  name: string,
  args: Object
): any => ({
  type: 'message',
  role: 'assistant',
  content: [
    {
      type: 'function_call',
      status: 'completed',
      call_id: callId,
      name,
      arguments: JSON.stringify(args),
    },
  ],
});

const makeToolOutputMessage = (callId: string, output: Object): any => ({
  type: 'function_call_output',
  call_id: callId,
  output: JSON.stringify(output),
});

describe('ByokCompletionGate (unit)', () => {
  it('lists the verify-type tools', () => {
    expect(BYOK_VERIFY_TOOL_NAMES).toContain('capture_preview_screenshot');
    expect(BYOK_VERIFY_TOOL_NAMES).toContain('run_gameplay_test');
    expect(BYOK_VERIFY_TOOL_NAMES).toContain('read_preview_logs');
    expect(BYOK_VERIFY_TOOL_NAMES).not.toContain('add_scene_events');
  });

  it('finds failing gameplay tests, cleared by a later green re-run', () => {
    const transcript: Array<any> = [
      makeAssistantToolCallMessage('c1', 'run_gameplay_test', {
        test_name: 'coin pickup',
      }),
      makeToolOutputMessage('c1', { success: false }),
      makeAssistantToolCallMessage('c2', 'run_gameplay_test', {
        test_name: 'jump height',
      }),
      makeToolOutputMessage('c2', { success: false }),
      makeAssistantToolCallMessage('c3', 'run_gameplay_test', {
        test_name: 'coin pickup',
      }),
      makeToolOutputMessage('c3', { success: true }),
    ];
    expect(findUnfixedFailingGameplayTests(transcript)).toEqual([
      'jump height',
    ]);
    expect(findUnfixedFailingGameplayTests([])).toEqual([]);
  });

  it('passes a fully verified completion', () => {
    const result = checkByokCompletionGate({
      transcript: [],
      hasEditsSinceLastVerification: false,
      serializeProject: () => '{}',
      hasCrashedPreview: () => false,
    });
    expect(result.needsNudge).toBe(false);
    expect(result.verified).toContain('project serializes');
    expect(result.verified).toContain('no crashed preview pending');
    expect(result.verified).toContain('no failing gameplay test left behind');
  });

  it('fails on unserializable project, crashed preview and failing tests', () => {
    const result = checkByokCompletionGate({
      transcript: [
        makeAssistantToolCallMessage('c1', 'run_gameplay_test', {
          test_name: 'move',
        }),
        makeToolOutputMessage('c1', { success: false }),
      ],
      hasEditsSinceLastVerification: false,
      serializeProject: () => null,
      hasCrashedPreview: () => true,
    });
    expect(result.needsNudge).toBe(true);
    expect(result.failures).toContain('the project could not be serialized');
    expect(result.failures).toContain(
      'the preview crashed and was not restarted'
    );
    expect(result.failures.join(' ')).toContain('"move"');
    expect(result.nudgeMessage).toContain('gameplay test');
  });

  it('nudges unverified work even when the checks pass', () => {
    const result = checkByokCompletionGate({
      transcript: [],
      hasEditsSinceLastVerification: true,
      serializeProject: () => '{}',
      hasCrashedPreview: () => false,
    });
    expect(result.needsNudge).toBe(true);
    expect(result.nudgeMessage).toContain('never looked at the result');
  });

  it('builds the evidence block, with a warning line when the gate did not pass', () => {
    const passing = buildByokCompletionGateBlock({
      verified: ['project serializes'],
      failures: [],
      needsNudge: false,
      nudgeMessage: null,
    });
    expect(passing).toContain('[Completion gate]');
    expect(passing).toContain('Verified: project serializes.');
    expect(passing).not.toContain('Warning');

    const warned = buildByokCompletionGateBlock({
      verified: [],
      failures: ['the preview crashed and was not restarted'],
      needsNudge: true,
      nudgeMessage: 'nudge',
    });
    expect(warned).toContain('Warning: done claimed without passing the gate');
    expect(warned).toContain('the preview crashed and was not restarted');
  });
});

describe('ByokCompletionGate (orchestrator integration)', () => {
  let project: any = null;

  const makeExecutorWithModifications = () =>
    jest.fn(async (calls: Array<Object>) => ({
      results: calls.map((call: Object) => ({
        status: 'finished',
        call_id: call.call_id,
        success: true,
        output: { success: true },
        didModifyProject: true,
      })),
      createdSceneNames: [],
      createdProject: null,
    }));

  const makeOrchestrator = (executor: any) => {
    const shell = createByokAiRequestShell('byok-gate-chat');
    const orchestrator = createByokOrchestrator({
      connection: { baseUrl: 'https://example.invalid/v1', apiKey: 'key' },
      settings: DEFAULT_BYOK_SETTINGS,
      aiRequest: shell,
      hasOpenedProject: () => true,
      getProject: () => project,
      getExecutor: () => executor,
      getProjectUserContent: async () => null,
      onAiRequestUpdated: () => {},
      doesCallRequireApproval: () => false,
      onRequestEditApproval: async () => true,
      usageTracker: createByokUsageTracker(),
    });
    return { shell, orchestrator };
  };

  beforeEach(() => {
    mockSendByokChatCompletion.mockReset();
    project = gd.ProjectHelper.createNewGDJSProject();
  });

  afterEach(() => {
    project.delete();
    project = null;
  });

  it('nudges exactly once when a done-claim follows an edit without verification', async () => {
    const executor = makeExecutorWithModifications();
    const { shell, orchestrator } = makeOrchestrator(executor);
    // Round 1: an edit. Round 2: a done-claim (nudge). Round 3: the same
    // claim again — honored, with the warning block.
    mockSendByokChatCompletion
      .mockResolvedValueOnce(
        makeToolCallResponse([
          {
            name: 'add_or_edit_variable',
            args: { variable_scope: 'global', variables: [] },
          },
        ])
      )
      .mockResolvedValueOnce(makeTextResponse('Done, the game is built.'))
      .mockResolvedValueOnce(
        makeTextResponse('Done again — I confirmed everything.')
      );

    await orchestrator.startNewChat('Build me a game');
    expect(shell.status).toBe('ready');

    const output: Array<any> = shell.output || [];
    const nudgeMessages = output.filter(
      (message: Object) =>
        message.role === 'user' &&
        message.content.some(
          (item: Object) =>
            item.type === 'user_request' &&
            item.text.includes('[completion gate]')
        )
    );
    expect(nudgeMessages.length).toBe(1);
    expect(nudgeMessages[0].content[0].text).toContain(
      'You have not verified your work'
    );

    // The final message carries the evidence block, with the warning line.
    const finalMessage = output[output.length - 1];
    expect(finalMessage.role).toBe('assistant');
    const gateText = finalMessage.content
      .filter((item: Object) => item.type === 'output_text')
      .map((item: Object) => item.text)
      .join('\n');
    expect(gateText).toContain('[Completion gate]');
    expect(gateText).toContain('Warning');
  });

  it('does not nudge when a verify call followed the edit', async () => {
    const executor = makeExecutorWithModifications();
    const { shell, orchestrator } = makeOrchestrator(executor);
    // Round 1: an edit. Round 2: a screenshot (the verify). Round 3: the
    // done-claim — no nudge, a clean verified block.
    mockSendByokChatCompletion
      .mockResolvedValueOnce(
        makeToolCallResponse([
          {
            name: 'add_or_edit_variable',
            args: { variable_scope: 'global', variables: [] },
          },
        ])
      )
      .mockResolvedValueOnce(
        makeToolCallResponse([{ name: 'capture_scene_screenshot', args: {} }])
      )
      .mockResolvedValueOnce(makeTextResponse('Done and verified.'));

    await orchestrator.startNewChat('Build me a game');
    expect(shell.status).toBe('ready');

    const output: Array<any> = shell.output || [];
    const nudgeMessages = output.filter(
      (message: Object) =>
        message.role === 'user' &&
        message.content.some((item: Object) =>
          item.text.includes('[completion gate]')
        )
    );
    expect(nudgeMessages.length).toBe(0);

    const finalMessage = output[output.length - 1];
    const gateText = finalMessage.content
      .filter((item: Object) => item.type === 'output_text')
      .map((item: Object) => item.text)
      .join('\n');
    expect(gateText).toContain('Verified:');
    expect(gateText).not.toContain('Warning');
  });

  it('mentions an unfixed failing gameplay test in the nudge', async () => {
    const executor = jest.fn(async (calls: Array<Object>) => ({
      results: calls.map((call: Object) => ({
        status: 'finished',
        call_id: call.call_id,
        success: true,
        output: { success: true },
        // The variable edit modifies; the test run does not.
        didModifyProject: call.name === 'add_or_edit_variable',
      })),
      createdSceneNames: [],
      createdProject: null,
    }));
    // The gameplay test must fail: wrap the executor to force its second
    // call (the test run) into a failure output.
    const failingExecutor = jest.fn(async (calls: Array<Object>) => {
      const execution = await executor(calls);
      return {
        ...execution,
        results: execution.results.map((result: Object) =>
          result.call_id === 'call-1'
            ? {
                ...result,
                success: false,
                didModifyProject: false,
                output: { success: false, message: 'assertion failed' },
              }
            : result
        ),
      };
    });
    const failing = makeOrchestrator(failingExecutor);
    mockSendByokChatCompletion
      .mockResolvedValueOnce(
        makeToolCallResponse([
          {
            name: 'add_or_edit_variable',
            args: { variable_scope: 'global', variables: [] },
          },
        ])
      )
      .mockResolvedValueOnce(
        makeToolCallResponse([
          { name: 'run_gameplay_test', args: { test_name: 'move right' } },
        ])
      )
      .mockResolvedValueOnce(makeTextResponse('Claim after failing test.'))
      .mockResolvedValueOnce(makeTextResponse('Second claim.'));

    await failing.orchestrator.startNewChat('Build');
    expect(failing.shell.status).toBe('ready');

    const output: Array<any> = failing.shell.output || [];
    const nudgeMessages = output.filter(
      (message: Object) =>
        message.role === 'user' &&
        message.content.some((item: Object) =>
          item.text.includes('[completion gate]')
        )
    );
    expect(nudgeMessages.length).toBe(1);
    expect(nudgeMessages[0].content[0].text).toContain('"move right"');
  });
});
