// @flow
import type { AiRequestMessage } from '../../Utils/GDevelopServices/Generation';

/**
 * The completion gate of a BYOK chat (Phase 8.2): "done" must be earned.
 * When the model produces a final plain-text answer after the chat edited
 * the project, the orchestrator runs these cheap local checks — and if the
 * work was never verified (no screenshot, preview, gameplay test or log
 * read since the last edit) or a check fails, the model gets exactly one
 * nudge turn to verify before its claim is honored.
 *
 * The gate is a pure module: the orchestrator feeds it the transcript and
 * two environment probes (serialization, preview health), everything else
 * is derived from the transcript itself.
 */

/**
 * The calls that count as verifying one's work: looking at the game
 * (screenshots), exercising it (previews, gameplay tests) or reading its
 * runtime feedback (logs, errors, state).
 */
export const BYOK_VERIFY_TOOL_NAMES: Array<string> = [
  'capture_scene_screenshot',
  'capture_preview_screenshot',
  'start_preview',
  'run_gameplay_test',
  'read_preview_logs',
  'get_runtime_errors',
  'inspect_runtime_state',
];

export type ByokCompletionGateInput = {|
  transcript: Array<AiRequestMessage>,
  // Whether a project-modifying call ran more recently than the last
  // verify-type call (tracked by the orchestrator across batches).
  hasEditsSinceLastVerification: boolean,
  // Serializes the current project (the same call snapshots use); null
  // when there is no project or the serialization failed.
  serializeProject: () => ?string,
  // Whether the BYOK preview crashed and was not restarted since.
  hasCrashedPreview: () => boolean,
|};

export type ByokCompletionGateResult = {|
  // The checks that passed, human-readable (rendered as the `verified`
  // block on the final message).
  verified: Array<string>,
  // The checks that failed, human-readable (also part of the block).
  failures: Array<string>,
  // True when the done-claim must be nudged once before being honored.
  needsNudge: boolean,
  nudgeMessage: string | null,
|};

/**
 * The gameplay tests that failed in the transcript and were never re-run
 * successfully: a run with `success: false` marks its test name; a later
 * successful re-run of the same name clears it.
 */
export const findUnfixedFailingGameplayTests = (
  transcript: Array<AiRequestMessage>
): Array<string> => {
  const testNamesByCallId: Map<string, ?string> = new Map();
  for (const message of transcript) {
    if (message.type !== 'message' || message.role !== 'assistant') continue;
    for (const item of message.content) {
      if (item.type !== 'function_call') continue;
      if (item.name !== 'run_gameplay_test') continue;
      try {
        const testName = JSON.parse(item.arguments).test_name;
        testNamesByCallId.set(
          item.call_id,
          typeof testName === 'string' ? testName : null
        );
      } catch (error) {
        testNamesByCallId.set(item.call_id, null);
      }
    }
  }

  const failingTests: Set<string> = new Set();
  for (const message of transcript) {
    if (message.type !== 'function_call_output') continue;
    const testName = testNamesByCallId.get(message.call_id);
    if (!testName) continue;
    try {
      const output = JSON.parse(message.output);
      if (output && output.success === false) failingTests.add(testName);
      if (output && output.success === true) failingTests.delete(testName);
    } catch (error) {
      // Unparsable output: ignore (the model saw an error message about it
      // already).
    }
  }
  return Array.from(failingTests);
};

/**
 * Run the gate. Pure apart from the two injected probes.
 */
export const checkByokCompletionGate = (
  input: ByokCompletionGateInput
): ByokCompletionGateResult => {
  const verified: Array<string> = [];
  const failures: Array<string> = [];

  if (input.serializeProject() !== null) {
    verified.push('project serializes');
  } else {
    failures.push('the project could not be serialized');
  }

  if (input.hasCrashedPreview()) {
    failures.push('the preview crashed and was not restarted');
  } else {
    verified.push('no crashed preview pending');
  }

  const failingTests = findUnfixedFailingGameplayTests(input.transcript);
  if (failingTests.length > 0) {
    failures.push(
      `gameplay test(s) failing and never re-run green: ${failingTests
        .map(name => `"${name}"`)
        .join(', ')}`
    );
  } else {
    verified.push('no failing gameplay test left behind');
  }

  const unverified = input.hasEditsSinceLastVerification;

  const reasons: Array<string> = [];
  if (unverified) {
    reasons.push(
      'you edited the project but never looked at the result since (no screenshot, preview, gameplay test or log read after your last edit)'
    );
  }
  reasons.push(...failures);

  const needsNudge = unverified || failures.length > 0;
  return {
    verified,
    failures,
    needsNudge,
    nudgeMessage: needsNudge
      ? [
          '[completion gate] You have not verified your work: ',
          reasons.join('; '),
          '. Run a preview or a gameplay test, or capture a screenshot, fix what you find, then confirm you are done.',
        ].join('')
      : null,
  };
};

/**
 * The block attached to the final message: visible evidence in the chat
 * (and in the worklog QA). A second unverified claim keeps its warning
 * line — the claim is honored, never silently.
 */
export const buildByokCompletionGateBlock = (
  result: ByokCompletionGateResult
): string => {
  const lines: Array<string> = ['[Completion gate]'];
  if (result.verified.length > 0) {
    lines.push(`Verified: ${result.verified.join(', ')}.`);
  }
  if (result.needsNudge) {
    lines.push(
      'Warning: done claimed without passing the gate — ' +
        (result.failures.length > 0
          ? result.failures.join('; ')
          : 'the work was not verified since the last edit') +
        '.'
    );
  }
  return lines.join('\n');
};
