/**
 * The eval harness self-check (Phase 9.8): the trivially-passing and
 * trivially-failing tasks must both score correctly, the suite must hold
 * the planned task counts, and no shipped module may import the dev-only
 * eval code.
 */
const fs = require('fs');
const path = require('path');
const {
  tasks,
  makeSelfCheckTasks,
  parseEvalAnswer,
  parseJudgeAnswer,
  formatReport,
  runEvalTask,
  runJudgePass,
} = require('../../../../scripts/run-byok-evals.js');

describe('Byok eval harness: self-check', () => {
  it('scores the trivially-passing task as passed', () => {
    const { passing, failing } = makeSelfCheckTasks();
    const result = passing.scorer({ answerText: '', toolCalls: [] });
    expect(result.passed).toBe(true);
    expect(failing).toBeTruthy();
  });

  it('scores the trivially-failing task as failed', () => {
    const { failing } = makeSelfCheckTasks();
    const result = failing.scorer({ answerText: '', toolCalls: [] });
    expect(result.passed).toBe(false);
  });
});

describe('Byok eval harness: the task suite', () => {
  it('ships the planned category split', () => {
    expect(tasks).toHaveLength(41);
    const byCategory = {};
    for (const task of tasks) {
      byCategory[task.category] = (byCategory[task.category] || 0) + 1;
    }
    expect(byCategory).toEqual({
      'event-logic': 10,
      layout: 5,
      variables: 5,
      'js-extension': 5,
      'perception-repair': 5,
      'authoring-reach': 6,
      'discovery-runtime': 5,
    });
  });

  it('has unique task ids and a scorer for every task', () => {
    const ids = new Set(tasks.map(task => task.id));
    expect(ids.size).toBe(tasks.length);
    for (const task of tasks) {
      expect(typeof task.scorer({ answerText: '', toolCalls: [] })).toBe(
        'object'
      );
      expect(task.prompt.length).toBeGreaterThan(20);
    }
  });

  it('scores a correct layout answer through numeric geometry', () => {
    const task = tasks.find(entry => entry.id === 'grid-5x5-platform');
    const instances = [];
    for (let row = 0; row < 5; row++) {
      for (let column = 0; column < 5; column++) {
        instances.push({ x: column * 128, y: row * 128 });
      }
    }
    const result = task.scorer({
      answerText: '',
      toolCalls: [
        {
          name: 'put_2d_instances',
          arguments: { instances },
        },
      ],
    });
    expect(result.passed).toBe(true);

    // One instance off-grid → fail.
    instances[7].x += 5;
    const broken = task.scorer({
      answerText: '',
      toolCalls: [{ name: 'put_2d_instances', arguments: { instances } }],
    });
    expect(broken.passed).toBe(false);
  });

  it('scores an event-logic answer on the emitted tool arguments', () => {
    const task = tasks.find(entry => entry.id === 'coin-spawner-every-3s');
    const good = task.scorer({
      answerText: '',
      toolCalls: [
        {
          name: 'add_scene_events',
          arguments: {
            scene_name: 'Level 1',
            // The EventScript BYOK's local writer actually accepts — the
            // harness used to assert a serialized hosted-backend shape
            // (`CreerObjet`) the real tool rejects (audit100226 SCRIPT-1).
            event_batches: [
              {
                placement_relation: 'insert_at_end',
                event_script: 'if Timer(3, "spawn"):\n  Create(Coin, 100, 200)',
              },
            ],
          },
        },
      ],
    });
    expect(good.passed).toBe(true);

    const noCall = task.scorer({
      answerText: 'I would add events.',
      toolCalls: [],
    });
    expect(noCall.passed).toBe(false);
  });
});

describe('Byok eval harness: the runner pieces', () => {
  it('parses fenced, prose-wrapped and broken answers', () => {
    const fenced = parseEvalAnswer(
      'Here you go:\n```json\n{"tool_calls":[{"name":"a","arguments":{"x":1}}]}\n```'
    );
    expect(fenced.toolCalls).toEqual([{ name: 'a', arguments: { x: 1 } }]);

    const broken = parseEvalAnswer('no json at all');
    expect(broken.toolCalls).toEqual([]);

    const malformed = parseEvalAnswer('{"tool_calls": "not-a-list"}');
    expect(malformed.toolCalls).toEqual([]);
  });

  it('tracks rounds, tool calls and tokens per task', async () => {
    const task = tasks.find(entry => entry.id === 'grid-5x5-platform');
    const result = await runEvalTask(task, async () => ({
      choices: [
        {
          message: {
            role: 'assistant',
            content: '{"tool_calls": []}',
          },
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }));
    expect(result.tokens).toBe(7);
    expect(result.rounds).toBe(1);
    expect(result.passed).toBe(false);
  });

  it('writes a markdown report with the four tracked numbers', () => {
    const report = formatReport(
      'eval-model',
      [
        {
          taskId: 't1',
          category: 'layout',
          passed: true,
          reason: 'even grid',
          rounds: 1,
          toolCalls: 1,
          tokens: 42,
        },
      ],
      { judgeModel: null }
    );
    expect(report).toContain('# BYOK eval report');
    expect(report).toContain('1/1 tasks passed');
    expect(report).toContain('42 tokens');
  });
});

describe('Byok eval harness: the dev-only build boundary', () => {
  it('is never imported by any shipped module', () => {
    const evalsDir = path.join(__dirname);
    const byokDir = path.join(__dirname, '..');
    const offenders: Array<string> = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'evals' || entry.name === '__tests__') continue;
          walk(entryPath);
          continue;
        }
        if (!entry.name.endsWith('.js')) continue;
        const content = fs.readFileSync(entryPath, 'utf8');
        if (
          content.includes('Byok/evals') ||
          content.includes('run-byok-evals')
        ) {
          offenders.push(entryPath);
        }
      }
    };
    walk(byokDir);
    expect(offenders).toEqual([]);
    // The boundary guard itself lives inside the dev-only folder.
    expect(evalsDir).toContain('evals');
  });
});

describe('Byok eval harness: the LLM-as-judge pass', () => {
  const failedResults = [
    {
      taskId: 't1',
      category: 'layout',
      passed: false,
      reason: 'uneven grid',
      rounds: 2,
      toolCalls: 3,
      tokens: 90,
    },
  ];

  it('parses the strict judge envelope, fences tolerated', () => {
    expect(
      parseJudgeAnswer('{"acceptable":true,"reason":"good enough"}')
    ).toEqual({ acceptable: true, reason: 'good enough' });
    expect(
      parseJudgeAnswer('```json\n{"acceptable":false,"reason":"broken"}\n```')
    ).toEqual({ acceptable: false, reason: 'broken' });
    expect(parseJudgeAnswer('not json')).toBe(null);
    expect(parseJudgeAnswer('{"acceptable":"yes"}')).toBe(null);
  });

  it('judges only the failed tasks and classifies the verdicts', async () => {
    const sendJudgeCompletion = jest.fn();
    sendJudgeCompletion.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: '{"acceptable":true,"reason":"the grid is usable"}',
          },
        },
      ],
      // The judge's own cost used to be discarded, so a judge pass reported
      // only the TASK tokens and the eval looked far cheaper than it is
      // (audit100226 SCRIPT-3).
      usage: { total_tokens: 321 },
    });
    const judged = await runJudgePass({
      results: [
        { taskId: 'pass-1', category: 'layout', passed: true },
        ...failedResults,
      ],
      judgeModel: 'judge-model',
      sendJudgeCompletion,
    });
    expect(sendJudgeCompletion).toHaveBeenCalledTimes(1);
    expect(sendJudgeCompletion.mock.calls[0][0].model).toBe('judge-model');
    expect(judged).toEqual([
      {
        taskId: 't1',
        verdict: 'acceptable',
        tokens: 321,
        reason: 'the grid is usable',
      },
    ]);
  });

  it('marks unparseable and failed judge calls without failing the run', async () => {
    const sendJudgeCompletion = jest
      .fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: 'no json' } }] })
      .mockRejectedValueOnce(new Error('endpoint down'));
    const judged = await runJudgePass({
      results: [
        { taskId: 't1', category: 'layout', passed: false },
        { taskId: 't2', category: 'layout', passed: false },
      ],
      judgeModel: 'judge-model',
      sendJudgeCompletion,
    });
    expect(judged).toEqual([
      {
        taskId: 't1',
        verdict: 'unparseable',
        tokens: 0,
        reason: 'The judge answer was not the expected JSON envelope.',
      },
      {
        taskId: 't2',
        verdict: 'unavailable',
        tokens: 0,
        reason: 'endpoint down',
      },
    ]);
  });

  it('renders the advisory judge section only when results are provided', () => {
    const base = formatReport('eval-model', failedResults, {
      judgeModel: null,
    });
    expect(base).not.toContain('LLM-as-judge');

    const judged = formatReport('eval-model', failedResults, {
      judgeModel: 'judge-model',
      judgeResults: [
        { taskId: 't1', verdict: 'not-acceptable', reason: 'truly broken' },
      ],
    });
    expect(judged).toContain('LLM-as-judge (advisory, judge-model)');
    expect(judged).toContain('not-acceptable: truly broken');

    const noFailures = formatReport('eval-model', [], {
      judgeModel: 'judge-model',
      judgeResults: [],
    });
    expect(noFailures).toContain('No failed tasks to judge.');
  });
});

describe('Byok eval harness: the real BYOK prompt and tools (audit100226 SCRIPT-2)', () => {
  it('sends the BYOK system prompt and the tool schemas, not a generic chat', async () => {
    // The harness used to send a two-message chat with NEITHER, while its
    // scorers require argument names the model was never shown — so the
    // authoring-reach tasks were near-unpassable except by training prior,
    // and a prompt or schema change had no measurable effect.
    const task = tasks.find(entry => entry.id === 'grid-5x5-platform');
    if (!task) throw new Error('the grid task is missing from the suite');

    let sentRequest = null;
    const byokModules = {
      systemPrompt: 'THE REAL BYOK SYSTEM PROMPT',
      tools: [{ type: 'function', function: { name: 'put_2d_instances' } }],
    };
    await runEvalTask(
      task,
      async request => {
        sentRequest = request;
        return {
          choices: [{ message: { role: 'assistant', content: '{}' } }],
          usage: { total_tokens: 1 },
        };
      },
      byokModules
    );

    expect(sentRequest).toBeTruthy();
    expect(sentRequest.messages[0].role).toBe('system');
    expect(sentRequest.messages[0].content).toContain(
      'THE REAL BYOK SYSTEM PROMPT'
    );
    // The tools ride the request, so the model sees the argument names the
    // scorers check (create_if_missing, brush_position, children_to_add...).
    expect(sentRequest.tools).toEqual(byokModules.tools);
    // The task prompt itself is untouched.
    expect(sentRequest.messages[1].content).toBe(task.prompt);
  });

  it('still works without the modules (the self-check path)', async () => {
    const task = tasks.find(entry => entry.id === 'grid-5x5-platform');
    if (!task) throw new Error('the grid task is missing from the suite');
    let sentRequest = null;
    const result = await runEvalTask(task, async request => {
      sentRequest = request;
      return {
        choices: [{ message: { role: 'assistant', content: '{}' } }],
        usage: { total_tokens: 2 },
      };
    });
    expect(sentRequest.tools).toBeUndefined();
    expect(result.tokens).toBe(2);
  });
});
