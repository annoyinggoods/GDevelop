// @flow
import {
  type ByokChatMessage,
  type ByokChatCompletionResponse,
} from './ByokTypes';
import { parseByokEventScript } from './ByokEventScriptParser';
import {
  getByokToolSchemasForNames,
  toOpenAiToolsFormat,
} from './ByokToolSchema';

/**
 * The built-in mini-benchmark (Phase 9.5): four fixed tasks a model must
 * solve against a scratch project (never the user's), scored mechanically —
 * model quality dominates every other design choice, so the user gets
 * evidence about which of their models actually builds GDevelop games
 * instead of a vibe.
 *
 * The module is pure orchestration + scoring: the endpoint client, the tool
 * executor (which edits the scratch project) and the project snapshot
 * builder (which reads it back into a plain shape) are injected, so tests
 * run on fakes and the settings tab wires the real ones.
 */

/**
 * The `max_tokens` sent with every benchmark call. The tasks are small and
 * the loop is round-capped, but an uncapped reasoning model can still burn
 * an enormous token budget on a trivial prompt — the cap keeps a benchmark
 * run a bounded expense (QA 2026-09-24: a four-task run once cost ~1M
 * tokens with no tools sent and no cap).
 */
export const BYOK_BENCHMARK_MAX_OUTPUT_TOKENS = 4096;

/**
 * A 64×64 PNG with four colored quadrants (red top-left, green top-right,
 * blue bottom-left, yellow bottom-right) — the vision task's fixture. It
 * ships inline: the benchmark never touches the network beyond the user's
 * own endpoint.
 */
export const BYOK_BENCHMARK_VISION_FIXTURE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAVElEQVR42u3PMQ0AMAwDsPBHNlYZhh75LJmA02Qqb0xAQEBAQEBAQEBAQEBAQEBAQEBAQEBA4GxdaDMlICAgICAgICAgICAgICAgICAgICAgIHD2ASrmER7CtP9PAAAAAElFTkSuQmCC';

/**
 * The plain snapshot of the scratch project the scorers run on — plain
 * data, so the scorers never touch libGDevelop and the tests can pass
 * hand-built snapshots (including deliberately broken ones).
 */
export type ByokBenchmarkProjectSnapshot = {|
  scenes: Array<{|
    name: string,
    objectNames: Array<string>,
    // The scene's events, as the EventScript text (what the event-writing
    // tool applies and what parseByokEventScript validates).
    eventsSource: ?string,
  |}>,
  firstSceneName: ?string,
|};

export type ByokBenchmarkTaskId =
  | 'create-scene-and-objects'
  | 'write-event-batch'
  | 'fix-broken-events'
  | 'read-screenshot';

export type ByokBenchmarkTask = {|
  id: ByokBenchmarkTaskId,
  title: string,
  prompt: string,
  toolNames: Array<string>,
  requiresVision: boolean,
|};

const BROKEN_EVENT_SHEET = `Bench Level:
if Timer(3, "spawn"):
  Create(Coin, 100, 200)`;

export const BYOK_BENCHMARK_TASKS: Array<ByokBenchmarkTask> = [
  {
    id: 'create-scene-and-objects',
    title: 'Create a scene with objects',
    prompt:
      'Create a scene named "Bench Level" containing a Sprite object named "Player". Use the tools.',
    toolNames: ['create_scene', 'create_or_replace_object'],
    requiresVision: false,
  },
  {
    id: 'write-event-batch',
    title: 'Write a working event batch',
    prompt:
      'In scene "Bench Level", write events so that every 3 seconds a new instance of object "Coin" is created at position 100, 200. Use the event-writing tool with a standard event: the timer condition "BuiltinCommonInstructions::Timer" with parameter elapsed time > 3 seconds (timer name "spawn"), and the creation action "CreerObjet" creating "Coin" at 100, 200 in "Bench Level".',
    toolNames: ['add_scene_events'],
    requiresVision: false,
  },
  {
    id: 'fix-broken-events',
    title: 'Fix a broken event sheet',
    prompt: `The scene "Bench Level" has a broken event sheet — the timer is never reset, so the coin spawns every frame once 3 seconds passed. Fix it by adding the timer reset action ResetTimer("spawn") to the event. Here is the current sheet (EventScript form):\n${BROKEN_EVENT_SHEET}`,
    toolNames: ['add_scene_events'],
    requiresVision: false,
  },
  {
    id: 'read-screenshot',
    title: 'Read a screenshot (vision)',
    prompt:
      'Look at the attached screenshot. What color is the top-right quadrant? Answer with just the color name.',
    toolNames: [],
    requiresVision: true,
  },
];

/** Look up a task by id (the settings button runs one model at a time). */
export const getByokBenchmarkTask = (
  taskId: string
): ByokBenchmarkTask | null =>
  BYOK_BENCHMARK_TASKS.find(task => task.id === taskId) || null;

// ----------------------------------------------------------------------
// The mechanical scorers: pure functions over the snapshot / the answer.
// ----------------------------------------------------------------------

export type ByokBenchmarkScore = {|
  passed: boolean,
  reason: string,
|};

const findScene = (snapshot: ByokBenchmarkProjectSnapshot, sceneName: string) =>
  snapshot.scenes.find(scene => scene.name === sceneName) || null;

export const scoreByokBenchmarkTask = (
  taskId: ByokBenchmarkTaskId,
  snapshot: ByokBenchmarkProjectSnapshot,
  answerText: string
): ByokBenchmarkScore => {
  if (taskId === 'create-scene-and-objects') {
    const scene = findScene(snapshot, 'Bench Level');
    if (!scene) {
      return { passed: false, reason: 'No scene named "Bench Level".' };
    }
    if (!scene.objectNames.includes('Player')) {
      return {
        passed: false,
        reason: 'Scene exists but no object named "Player".',
      };
    }
    return { passed: true, reason: 'Scene and object found.' };
  }

  if (taskId === 'write-event-batch') {
    const scene = findScene(snapshot, 'Bench Level');
    if (!scene || !scene.eventsSource) {
      return { passed: false, reason: 'No events were written.' };
    }
    const parseResult = parseByokEventScript(scene.eventsSource);
    if (parseResult.error || !parseResult.events) {
      return {
        passed: false,
        reason: 'The written events do not parse.',
      };
    }
    const serialized = JSON.stringify(parseResult.events);
    const hasTimer = serialized.includes('Timer');
    const createsCoin =
      serialized.includes('Create') && serialized.includes('Coin');
    if (!hasTimer || !createsCoin) {
      return {
        passed: false,
        reason:
          'The events miss the 3-second timer condition or the coin creation.',
      };
    }
    return { passed: true, reason: 'Timer condition and coin creation found.' };
  }

  if (taskId === 'fix-broken-events') {
    const scene = findScene(snapshot, 'Bench Level');
    if (!scene || !scene.eventsSource) {
      return { passed: false, reason: 'No fixed events were written.' };
    }
    const parseResult = parseByokEventScript(scene.eventsSource);
    if (parseResult.error || !parseResult.events) {
      return {
        passed: false,
        reason: 'The fixed events do not parse.',
      };
    }
    const serialized = JSON.stringify(parseResult.events);
    if (!serialized.includes('ResetTimer')) {
      return {
        passed: false,
        reason: 'The fix does not reset the "spawn" timer.',
      };
    }
    return { passed: true, reason: 'Timer reset applied.' };
  }

  if (taskId === 'read-screenshot') {
    const answer = answerText.trim().toLowerCase();
    // The fixture's top-right quadrant is green (see the generator in the
    // comment of the fixture constant).
    if (answer.includes('green')) {
      return { passed: true, reason: 'The quadrant color was read correctly.' };
    }
    return {
      passed: false,
      reason: `The answer "${answerText.trim().slice(0, 60)}" is not "green".`,
    };
  }

  return { passed: false, reason: 'Unknown task.' };
};

// ----------------------------------------------------------------------
// The runner.
// ----------------------------------------------------------------------

export type ByokBenchmarkSendCompletion = ({|
  messages: Array<ByokChatMessage>,
  // The OpenAI-format `tools` array of the running task (the schemas of its
  // `toolNames`). Empty for tasks without tools (the vision task).
  tools: Array<Object>,
|}) => Promise<ByokChatCompletionResponse>;

export type ByokBenchmarkExecutor = ({|
  calls: Array<{| name: string, arguments: string |}>,
  scratchProject: any,
|}) => Promise<Array<{| call_id: string, success: boolean, output: string |}>>;

export type ByokBenchmarkTaskResult = {|
  taskId: ByokBenchmarkTaskId,
  passed: boolean,
  reason: string,
  rounds: number,
  toolCallCount: number,
  totalTokens: number,
  error: ?string,
|};

export type ByokBenchmarkReport = {|
  modelName: string,
  ranAt: string,
  results: Array<ByokBenchmarkTaskResult>,
  passCount: number,
  totalTokens: number,
|};

const extractToolCalls = (response: ByokChatCompletionResponse) => {
  const choice = response.choices[0];
  const message = choice ? choice.message : null;
  if (!message || !Array.isArray(message.tool_calls)) return [];
  return message.tool_calls;
};

const extractAnswerText = (response: ByokChatCompletionResponse): string => {
  const choice = response.choices[0];
  const message = choice ? choice.message : null;
  return message && typeof message.content === 'string' ? message.content : '';
};

const usageTotalOf = (response: ByokChatCompletionResponse): number =>
  response.usage && typeof response.usage.total_tokens === 'number'
    ? response.usage.total_tokens
    : 0;

/**
 * Run one benchmark task: a mini agent loop (prompt → tool calls →
 * executed against the scratch project → …) ending at the model's plain
 * answer or the round cap, then scored mechanically.
 */
export const runByokBenchmarkTask = async ({
  task,
  scratchProject,
  sendCompletion,
  executeToolCalls,
  snapshotProject,
  maxRounds = 6,
}: {|
  task: ByokBenchmarkTask,
  scratchProject: any,
  sendCompletion: ByokBenchmarkSendCompletion,
  executeToolCalls: ByokBenchmarkExecutor,
  snapshotProject: (project: any) => ByokBenchmarkProjectSnapshot,
  maxRounds?: number,
|}): Promise<ByokBenchmarkTaskResult> => {
  let rounds = 0;
  let toolCallCount = 0;
  let totalTokens = 0;
  let answerText = '';
  // The task's own tools, in the OpenAI format the endpoint expects. Without
  // them the model cannot emit tool calls at all — it can only talk about
  // the work (QA 2026-09-24: every tool task failed for exactly that
  // reason), so the schemas travel with each request.
  const tools = toOpenAiToolsFormat(getByokToolSchemasForNames(task.toolNames));
  const messages: Array<ByokChatMessage> = [
    {
      role: 'system',
      content:
        'You are being benchmarked on GDevelop game-building tasks. Use the provided tools to do the work; answer with plain text when done.',
    },
    { role: 'user', content: task.prompt },
  ];

  try {
    for (rounds = 1; rounds <= maxRounds; rounds++) {
      const response = await sendCompletion({ messages, tools });
      totalTokens += usageTotalOf(response);
      const toolCalls = extractToolCalls(response);
      answerText = extractAnswerText(response);

      if (toolCalls.length === 0) break;

      // Built through any: the response wire shape is untyped data.
      messages.push(
        (({
          role: 'assistant',
          content: answerText || null,
          tool_calls: toolCalls,
        }: any): ByokChatMessage)
      );
      toolCallCount += toolCalls.length;
      const results = await executeToolCalls({
        calls: toolCalls.map(toolCall => ({
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        })),
        scratchProject,
      });
      for (let index = 0; index < toolCalls.length; index++) {
        const result = results[index];
        messages.push({
          role: 'tool',
          tool_call_id: toolCalls[index].id,
          content: result
            ? result.output
            : JSON.stringify({ success: false, message: 'No result.' }),
        });
      }
    }

    const score = scoreByokBenchmarkTask(
      task.id,
      snapshotProject(scratchProject),
      answerText
    );
    return {
      taskId: task.id,
      passed: score.passed,
      reason: score.reason,
      rounds,
      toolCallCount,
      totalTokens,
      error: null,
    };
  } catch (error) {
    return {
      taskId: task.id,
      passed: false,
      reason: 'The task run failed.',
      rounds,
      toolCallCount,
      totalTokens,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * Run the benchmark suite for one model, skipping the tasks whose
 * requirements the model does not meet (the vision task without vision).
 */
export const runByokBenchmark = async ({
  modelName,
  scratchProject,
  sendCompletion,
  executeToolCalls,
  snapshotProject,
  isVisionEnabled = () => false,
  tasks = BYOK_BENCHMARK_TASKS,
}: {|
  modelName: string,
  scratchProject: any,
  sendCompletion: ByokBenchmarkSendCompletion,
  executeToolCalls: ByokBenchmarkExecutor,
  snapshotProject: (project: any) => ByokBenchmarkProjectSnapshot,
  isVisionEnabled?: () => boolean,
  tasks?: Array<ByokBenchmarkTask>,
|}): Promise<ByokBenchmarkReport> => {
  const results: Array<ByokBenchmarkTaskResult> = [];
  for (const task of tasks) {
    if (task.requiresVision && !isVisionEnabled()) {
      results.push({
        taskId: task.id,
        passed: false,
        reason: 'Skipped: vision is off.',
        rounds: 0,
        toolCallCount: 0,
        totalTokens: 0,
        error: 'skipped',
      });
      continue;
    }
    results.push(
      await runByokBenchmarkTask({
        task,
        scratchProject,
        sendCompletion,
        executeToolCalls,
        snapshotProject,
      })
    );
  }

  const scoredResults = results.filter(result => result.error !== 'skipped');
  return {
    modelName,
    ranAt: new Date().toISOString(),
    results,
    passCount: scoredResults.filter(result => result.passed).length,
    totalTokens: results.reduce(
      (total, result) => total + result.totalTokens,
      0
    ),
  };
};

/** The report as readable text (the settings display and the log). */
export const formatByokBenchmarkReport = (
  report: ByokBenchmarkReport
): string => {
  const lines = [
    `Benchmark of ${report.modelName} — ${report.passCount}/${
      report.results.filter(result => result.error !== 'skipped').length
    } tasks passed, ${report.totalTokens} tokens.`,
  ];
  for (const result of report.results) {
    const task = getByokBenchmarkTask(result.taskId);
    const status =
      result.error === 'skipped' ? 'skipped' : result.passed ? 'PASS' : 'FAIL';
    lines.push(
      `- [${status}] ${task ? task.title : result.taskId}: ${result.reason} (${
        result.rounds
      } rounds, ${result.toolCallCount} tool calls${
        result.error && result.error !== 'skipped'
          ? `, error: ${result.error}`
          : ''
      })`
    );
  }
  return lines.join('\n');
};
