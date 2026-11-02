// @flow
import {
  BYOK_BENCHMARK_TASKS,
  formatByokBenchmarkReport,
  getByokBenchmarkTask,
  runByokBenchmark,
  runByokBenchmarkTask,
  scoreByokBenchmarkTask,
  type ByokBenchmarkProjectSnapshot,
} from './ByokBenchmark';
import { parseByokEventScript } from './ByokEventScriptParser';

const emptySnapshot = (): ByokBenchmarkProjectSnapshot => ({
  scenes: [],
  firstSceneName: null,
});

const goodSnapshot = (): ByokBenchmarkProjectSnapshot => ({
  scenes: [
    {
      name: 'Bench Level',
      objectNames: ['Player'],
      eventsSource: [
        'if Timer(3, "spawn"):',
        '  Create(Coin, 100, 200)',
        '  ResetTimer("spawn")',
      ].join('\n'),
    },
  ],
  firstSceneName: 'Bench Level',
});

const timerOnlySnapshot = (): ByokBenchmarkProjectSnapshot => ({
  scenes: [
    {
      name: 'Bench Level',
      objectNames: ['Player'],
      eventsSource: ['if Timer(3, "spawn"):', '  Create(Coin, 100, 200)'].join(
        '\n'
      ),
    },
  ],
  firstSceneName: 'Bench Level',
});

describe('ByokBenchmark: the mechanical scorers', () => {
  it('scores the scene+objects task against good and broken snapshots', () => {
    const pass = scoreByokBenchmarkTask(
      'create-scene-and-objects',
      goodSnapshot(),
      ''
    );
    expect(pass.passed).toBe(true);

    const noScene = scoreByokBenchmarkTask(
      'create-scene-and-objects',
      emptySnapshot(),
      ''
    );
    expect(noScene.passed).toBe(false);

    const noObject = scoreByokBenchmarkTask(
      'create-scene-and-objects',
      {
        scenes: [{ name: 'Bench Level', objectNames: [], eventsSource: null }],
        firstSceneName: 'Bench Level',
      },
      ''
    );
    expect(noObject.passed).toBe(false);
  });

  it('scores the event-batch task on parse success and expected markers', () => {
    expect(
      scoreByokBenchmarkTask('write-event-batch', goodSnapshot(), '').passed
    ).toBe(true);

    // A sheet that does not parse fails.
    const unparsable = scoreByokBenchmarkTask(
      'write-event-batch',
      {
        scenes: [
          {
            name: 'Bench Level',
            objectNames: ['Player'],
            eventsSource: 'if this is not the grammar:',
          },
        ],
        firstSceneName: 'Bench Level',
      },
      ''
    );
    expect(unparsable.passed).toBe(false);

    // A parsable sheet without the coin creation fails.
    const noCoin = scoreByokBenchmarkTask(
      'write-event-batch',
      {
        scenes: [
          {
            name: 'Bench Level',
            objectNames: ['Player'],
            eventsSource: 'if Timer(3, "spawn"):\n  ResetTimer("spawn")',
          },
        ],
        firstSceneName: 'Bench Level',
      },
      ''
    );
    expect(noCoin.passed).toBe(false);
  });

  it('scores the broken-sheet repair on the specific fix', () => {
    // The broken sheet (timer never reset) must NOT pass.
    expect(
      scoreByokBenchmarkTask('fix-broken-events', timerOnlySnapshot(), '')
        .passed
    ).toBe(false);

    // The fixed sheet (reset added) passes.
    expect(
      scoreByokBenchmarkTask('fix-broken-events', goodSnapshot(), '').passed
    ).toBe(true);
  });

  it('scores the vision task on the fixture answer (green top-right)', () => {
    expect(
      scoreByokBenchmarkTask('read-screenshot', emptySnapshot(), 'Green').passed
    ).toBe(true);
    expect(
      scoreByokBenchmarkTask('read-screenshot', emptySnapshot(), '  green ')
        .passed
    ).toBe(true);
    expect(
      scoreByokBenchmarkTask('read-screenshot', emptySnapshot(), 'red').passed
    ).toBe(false);
  });

  it('is grounded: the fixture really carries the events the scorer parses', () => {
    const parseResult = parseByokEventScript(
      goodSnapshot().scenes[0].eventsSource || ''
    );
    expect(parseResult.error).toBeUndefined();
    expect(parseResult.events && parseResult.events[0].actions).toHaveLength(2);
  });
});

describe('ByokBenchmark: the runner', () => {
  const makeExecutor = () => async ({ calls }: any) =>
    calls.map((call, index) => ({
      call_id: `c${index}`,
      success: true,
      output: JSON.stringify({ success: true }),
    }));

  it('runs a task to completion and scores the snapshot', async () => {
    let rounds = 0;
    const result = await runByokBenchmarkTask({
      task:
        getByokBenchmarkTask('create-scene-and-objects') ||
        BYOK_BENCHMARK_TASKS[0],
      scratchProject: {},
      sendCompletion: async (): Promise<any> => {
        rounds++;
        if (rounds === 1) {
          return {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 't1',
                      type: 'function',
                      function: {
                        name: 'create_scene',
                        arguments: '{"scene_name": "Bench Level"}',
                      },
                    },
                  ],
                },
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          };
        }
        return {
          choices: [{ message: { role: 'assistant', content: 'Done.' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
      },
      executeToolCalls: makeExecutor(),
      snapshotProject: () => goodSnapshot(),
    });
    expect(result.passed).toBe(true);
    expect(result.rounds).toBe(2);
    expect(result.toolCallCount).toBe(1);
    expect(result.totalTokens).toBe(30);
  });

  it('sends the task tool schemas with every request (QA 2026-09-24 regression)', async () => {
    const seenTools: Array<any> = [];
    const result = await runByokBenchmarkTask({
      task:
        getByokBenchmarkTask('write-event-batch') || BYOK_BENCHMARK_TASKS[1],
      scratchProject: {},
      sendCompletion: async ({ tools }: any): Promise<any> => {
        seenTools.push(tools);
        return {
          choices: [{ message: { role: 'assistant', content: 'Done.' } }],
        };
      },
      executeToolCalls: makeExecutor(),
      snapshotProject: () => goodSnapshot(),
    });
    // One round: the plain answer ends the loop — but the schema of the
    // task's tool traveled with the request, so the model CAN call it.
    expect(seenTools.length).toBe(1);
    expect(seenTools[0].map(tool => tool.function.name)).toEqual([
      'add_scene_events',
    ]);
    expect(seenTools[0][0].type).toBe('function');
    expect(result.rounds).toBe(1);
  });

  it('sends no tools for the task that needs none', async () => {
    let seenTools: any = null;
    await runByokBenchmarkTask({
      task: getByokBenchmarkTask('read-screenshot') || BYOK_BENCHMARK_TASKS[3],
      scratchProject: {},
      sendCompletion: async ({ tools }: any): Promise<any> => {
        seenTools = tools;
        return {
          choices: [{ message: { role: 'assistant', content: 'green' } }],
        };
      },
      executeToolCalls: makeExecutor(),
      snapshotProject: () => goodSnapshot(),
    });
    expect(seenTools).toEqual([]);
  });

  it('reports a failing task with the scorer reason and never throws', async () => {
    const result = await runByokBenchmarkTask({
      task:
        getByokBenchmarkTask('create-scene-and-objects') ||
        BYOK_BENCHMARK_TASKS[0],
      scratchProject: {},
      sendCompletion: async (): Promise<any> => ({
        choices: [{ message: { role: 'assistant', content: 'I refuse.' } }],
      }),
      executeToolCalls: makeExecutor(),
      snapshotProject: () => emptySnapshot(),
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('Bench Level');
    expect(result.error).toBe(null);
  });

  it('skips the vision task when vision is off, and runs it when on', async () => {
    const report = await runByokBenchmark({
      modelName: 'test-model',
      scratchProject: {},
      sendCompletion: async (): Promise<any> => ({
        choices: [{ message: { role: 'assistant', content: 'green' } }],
      }),
      executeToolCalls: makeExecutor(),
      snapshotProject: () => goodSnapshot(),
      isVisionEnabled: () => false,
      tasks: [
        getByokBenchmarkTask('read-screenshot') || BYOK_BENCHMARK_TASKS[3],
      ],
    });
    expect(report.results[0].error).toBe('skipped');
    expect(report.passCount).toBe(0);

    const reportWithVision = await runByokBenchmark({
      modelName: 'test-model',
      scratchProject: {},
      sendCompletion: async (): Promise<any> => ({
        choices: [{ message: { role: 'assistant', content: 'green' } }],
      }),
      executeToolCalls: makeExecutor(),
      snapshotProject: () => goodSnapshot(),
      isVisionEnabled: () => true,
      tasks: [
        getByokBenchmarkTask('read-screenshot') || BYOK_BENCHMARK_TASKS[3],
      ],
    });
    expect(reportWithVision.passCount).toBe(1);
  });

  it('formats the report with pass counts and token costs', async () => {
    const report = await runByokBenchmark({
      modelName: 'test-model',
      scratchProject: {},
      sendCompletion: async (): Promise<any> => ({
        choices: [{ message: { role: 'assistant', content: 'nope' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      executeToolCalls: makeExecutor(),
      snapshotProject: () => emptySnapshot(),
      isVisionEnabled: () => false,
    });
    const text = formatByokBenchmarkReport(report);
    expect(text).toContain('test-model');
    expect(text).toContain('FAIL');
    expect(text).toContain('skipped');
    expect(text).toContain('tokens');
  });
});
