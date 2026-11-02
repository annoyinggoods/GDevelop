// @flow
import {
  getByokBuiltinSkills,
  isByokBuildIntent,
  parseByokSkill,
} from './ByokSkills';
import { getByokSettings, DEFAULT_BYOK_SETTINGS } from './ByokTypes';
import { createByokOrchestrator } from './ByokOrchestrator';
import { sendByokChatCompletionWithRetries } from './ByokClient';
import { createByokAiRequestShell } from './ByokTranscript';
import { createByokUsageTracker } from './ByokUsageTracker';

jest.mock('./ByokClient', () => ({
  sendByokChatCompletionWithRetries: jest.fn(),
  createByokCancellation: jest.fn(() => ({
    token: { __fakeCancelToken: true },
    cancel: jest.fn(),
  })),
}));

const mockSendByokChatCompletion: any = sendByokChatCompletionWithRetries;

/**
 * The build-workflow skill spec (Phase 8.3): the shipped recipe must parse,
 * ship with the app, and name its required tools — so the recipe and the
 * tool registry cannot drift apart silently.
 */

const REQUIRED_TOOLS = [
  'create_or_update_plan',
  'initialize_project',
  'add_or_edit_variable',
  'run_gameplay_test',
  'add_scene_events',
  'create_or_replace_object',
  'read_events_source',
  'capture_preview_screenshot',
  'capture_scene_screenshot',
  'start_preview',
  'read_preview_logs',
  'get_runtime_errors',
];

describe('The build-workflow skill', () => {
  it('ships with the builtin skills and parses cleanly', () => {
    const skills = getByokBuiltinSkills();
    const skill = skills.find(entry => entry.name === 'build-workflow');
    expect(skill).toBeTruthy();

    // The generated index embeds the file verbatim: the found skill must
    // carry its description and its body.
    expect(skill && skill.description.length).toBeGreaterThan(10);
    expect(skill && skill.body).toContain('# The build workflow');
  });

  it('names its required tools (the recipe and the registry stay in sync)', () => {
    const skills = getByokBuiltinSkills();
    const skill = skills.find(entry => entry.name === 'build-workflow');
    if (!skill) throw new Error('build-workflow skill not found');

    for (const toolName of REQUIRED_TOOLS) {
      expect(skill.body).toContain(toolName);
    }
    // The pipeline phases, in the shipped order.
    const briefIndex = skill.body.indexOf('## 1. Brief');
    const planIndex = skill.body.indexOf('## 2. Plan and scaffold');
    const loopIndex = skill.body.indexOf('## 3. Per-mechanic loop');
    const polishIndex = skill.body.indexOf('## 4. Polish pass');
    const finalIndex = skill.body.indexOf('## 5. Final verification');
    expect(briefIndex).toBeGreaterThan(-1);
    expect(briefIndex).toBeLessThan(planIndex);
    expect(planIndex).toBeLessThan(loopIndex);
    expect(loopIndex).toBeLessThan(polishIndex);
    expect(polishIndex).toBeLessThan(finalIndex);
    // The completion-gate contract is referenced.
    expect(skill.body).toContain('completion gate');
  });

  it('parses frontmatter strictly (name + description required)', () => {
    const skills = getByokBuiltinSkills();
    const skill = skills.find(entry => entry.name === 'build-workflow');
    if (!skill) throw new Error('build-workflow skill not found');

    const frontmatter = [
      '---',
      `name: ${skill.name}`,
      `description: ${skill.description}`,
      '---',
      '',
      skill.body,
    ].join('\n');
    const parsed = parseByokSkill(frontmatter, 'test:build-workflow.md');
    expect(parsed.error).toBe(null);
    expect(parsed.skill && parsed.skill.name).toBe('build-workflow');
  });
});

describe('isByokBuildIntent (the auto-suggest heuristic)', () => {
  it('matches build requests', () => {
    expect(isByokBuildIntent('Build me a small platformer with coins.')).toBe(
      true
    );
    expect(
      isByokBuildIntent('make me a game about a fox collecting gems')
    ).toBe(true);
    expect(isByokBuildIntent('Can you create an arcade shooter?')).toBe(true);
    expect(isByokBuildIntent('Please develop an RPG with a shop')).toBe(true);
  });

  it('does not match questions, edits or unrelated work', () => {
    expect(isByokBuildIntent('What is a variable?')).toBe(false);
    expect(isByokBuildIntent('Add a coin to Level 1')).toBe(false);
    expect(isByokBuildIntent('Fix the bug in the jump events')).toBe(false);
    expect(isByokBuildIntent('Build me a website')).toBe(false);
  });
});

describe('The buildWorkflowAutoSuggest setting', () => {
  it('defaults to on and survives partial stored settings', () => {
    expect(DEFAULT_BYOK_SETTINGS.buildWorkflowAutoSuggest).toBe(true);
    expect(getByokSettings({ byok: null }).buildWorkflowAutoSuggest).toBe(true);
    expect(
      getByokSettings({
        byok: ({ buildWorkflowAutoSuggest: false }: any),
      }).buildWorkflowAutoSuggest
    ).toBe(false);
  });
});

describe('The auto-suggested skill in the conversation (orchestrator)', () => {
  const runFirstTurn = async (
    userRequest: string,
    settingsOverrides: Object = {}
  ) => {
    mockSendByokChatCompletion.mockReset();
    mockSendByokChatCompletion.mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: 'OK.' } }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    });
    const shell = createByokAiRequestShell('byok-suggest-chat');
    const orchestrator = createByokOrchestrator({
      connection: { baseUrl: 'https://example.invalid/v1', apiKey: 'key' },
      settings: { ...DEFAULT_BYOK_SETTINGS, ...settingsOverrides },
      aiRequest: shell,
      hasOpenedProject: () => false,
      getProject: () => null,
      getExecutor: () => null,
      getProjectUserContent: async () => null,
      onAiRequestUpdated: () => {},
      doesCallRequireApproval: () => false,
      onRequestEditApproval: async () => true,
      usageTracker: createByokUsageTracker(),
    });
    await orchestrator.startNewChat(userRequest);
    const sentMessages: Array<any> =
      mockSendByokChatCompletion.mock.calls[0][0].options.messages;
    return { systemPrompt: sentMessages[0].content };
  };

  it('includes the build-workflow body from turn one on a build request', async () => {
    const { systemPrompt } = await runFirstTurn('Build me a platformer');
    expect(systemPrompt).toContain('[Auto-loaded skill: build-workflow');
    expect(systemPrompt).toContain('# The build workflow');
  });

  it('stays out of non-build chats, and out when the user turned it off', async () => {
    const plainChat = await runFirstTurn('What is a variable?');
    expect(plainChat.systemPrompt).not.toContain(
      '[Auto-loaded skill: build-workflow'
    );

    const optedOut = await runFirstTurn('Build me a platformer', {
      buildWorkflowAutoSuggest: false,
    });
    expect(optedOut.systemPrompt).not.toContain(
      '[Auto-loaded skill: build-workflow'
    );
  });
});
