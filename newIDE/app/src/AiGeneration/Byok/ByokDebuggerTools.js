// @flow
import type { ByokExtraTool, ByokExtraToolResult } from './ByokExtraTools';
import type { ByokRuntimeToolDeps } from './ByokRuntimeTools';
import { getOrCreateByokPreviewSession } from './ByokRuntimeTools';
import { reduceByokRuntimeDump } from './ByokPreviewSession';

/**
 * The debugger/profiler tools (Phase 12, D12-5): the agent sees and steers
 * the preview IT launched — pause/resume, a targeted runtime dump, and a
 * profiled scene. Everything goes through the session's TARGETED debugger
 * channel (its own connection id, never a broadcast), and runtime-only
 * state is not project state: `modifiesProject` stays false for all three
 * (they pass the MCP read-only gate like the other runtime reads).
 */

/** How long profile_runtime listens per default. */
export const BYOK_PROFILE_DEFAULT_DURATION_MS = 2000;

/** The cap of a profiling wait (the bounded wait of D12-5). */
export const BYOK_PROFILE_MAX_DURATION_MS = 60000;

/** How long to wait for the pushed profiler output after the stop. */
export const BYOK_PROFILE_OUTPUT_TIMEOUT_MS = 10000;

const makeFailure = (message: string): ByokExtraToolResult => ({
  output: { success: false, message },
  didModifyProject: false,
});

const makeNoPreviewFailure = (): ByokExtraToolResult =>
  makeFailure(
    'No BYOK preview is running — start_preview first (these tools act on the preview launched by this chat only).'
  );

/**
 * The shared refusal of a command the runtime ignored — the gameplay-test
 * guard the engine itself enforces (its own guard list): surfaced as a
 * typed failure instead of a fake success.
 */
const makeCommandIgnoredFailure = (
  command: string,
  payload: Object
): ByokExtraToolResult =>
  makeFailure(
    `The runtime ignored "${command}"${
      payload && typeof payload.reason === 'string'
        ? `: ${payload.reason}`
        : ' (a gameplay test may be running, or the command does not apply to this preview).'
    } Nothing was changed.`
  );

const sleep = (durationMs: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, durationMs);
  });

const makeReadRuntimeDetailsTool = (): ByokExtraTool => ({
  name: 'read_runtime_details',
  modifiesProject: false,
  run: async (args, collaborators): Promise<ByokExtraToolResult> => {
    const runtimeDeps = (collaborators.runtimeDeps: ?ByokRuntimeToolDeps);
    if (!runtimeDeps) {
      return makeFailure('Runtime inspection is not available here.');
    }
    const session = getOrCreateByokPreviewSession(runtimeDeps);
    if (!session.isRunning()) return makeNoPreviewFailure();

    try {
      const statusResponse = await session.sendDebuggerCommand({
        command: 'getStatus',
      });
      const statusPayload =
        statusResponse && statusResponse.payload ? statusResponse.payload : {};
      if (statusPayload.commandIgnored) {
        return makeCommandIgnoredFailure('getStatus', statusPayload);
      }
      const dumpResponse = await session.sendDebuggerCommand({
        command: 'refresh',
      });
      const dumpPayload =
        dumpResponse && dumpResponse.payload ? dumpResponse.payload : null;
      // The same narrowing inspect_runtime_state accepts: without it an
      // instance-heavy game serialized to ~120k chars and the 20k tool cap
      // cut it mid-JSON (audit100226 TOOL-9).
      const sceneName =
        typeof args.scene_name === 'string' && args.scene_name
          ? args.scene_name
          : null;
      const variablePaths = Array.isArray(args.variable_paths)
        ? args.variable_paths.filter(path => typeof path === 'string')
        : null;
      return {
        output: {
          success: true,
          status: statusPayload,
          state: reduceByokRuntimeDump(dumpPayload, {
            sceneName,
            variablePaths,
          }),
          note:
            'Live details of the preview launched by this chat (paused state from getStatus, instances and variables from a targeted refresh). Pass scene_name to read one scene and variable_paths to read specific variables.',
        },
        didModifyProject: false,
      };
    } catch (error) {
      return makeFailure(
        `The runtime details could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  },
});

const makeControlRuntimeTool = (): ByokExtraTool => ({
  name: 'control_runtime',
  modifiesProject: false,
  run: async (args, collaborators): Promise<ByokExtraToolResult> => {
    const runtimeDeps = (collaborators.runtimeDeps: ?ByokRuntimeToolDeps);
    if (!runtimeDeps) {
      return makeFailure('Runtime control is not available here.');
    }
    const requestedAction = typeof args.action === 'string' ? args.action : '';
    const command =
      requestedAction === 'pause'
        ? 'pause'
        : requestedAction === 'play' || requestedAction === 'resume'
        ? 'play'
        : requestedAction === 'getStatus'
        ? 'getStatus'
        : null;
    if (!command) {
      return makeFailure(
        'The "action" must be pause, play (resume), or getStatus.'
      );
    }
    const session = getOrCreateByokPreviewSession(runtimeDeps);
    if (!session.isRunning()) return makeNoPreviewFailure();

    try {
      const response = await session.sendDebuggerCommand({ command });
      const payload = response && response.payload ? response.payload : {};
      if (payload.commandIgnored) {
        return makeCommandIgnoredFailure(command, payload);
      }
      return {
        output: {
          success: true,
          action: command,
          status: payload,
          note:
            'Steers the preview launched by this chat only. The runtime refuses mutating commands while a gameplay test runs — those refusals come back as failures.',
        },
        didModifyProject: false,
      };
    } catch (error) {
      return makeFailure(
        `The command "${command}" failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  },
});

const makeProfileRuntimeTool = (): ByokExtraTool => ({
  name: 'profile_runtime',
  modifiesProject: false,
  run: async (args, collaborators): Promise<ByokExtraToolResult> => {
    const runtimeDeps = (collaborators.runtimeDeps: ?ByokRuntimeToolDeps);
    if (!runtimeDeps) {
      return makeFailure('Profiling is not available here.');
    }
    const session = getOrCreateByokPreviewSession(runtimeDeps);
    if (!session.isRunning()) return makeNoPreviewFailure();

    const requestedDuration =
      typeof args.duration_ms === 'number' ? args.duration_ms : null;
    if (requestedDuration !== null && requestedDuration < 0) {
      return makeFailure('duration_ms must be 0 or positive.');
    }
    const durationMs = Math.min(
      requestedDuration === null
        ? BYOK_PROFILE_DEFAULT_DURATION_MS
        : requestedDuration,
      BYOK_PROFILE_MAX_DURATION_MS
    );

    try {
      // The engine pushes the stats when profiling STOPS (never as a
      // response): start → let the game run → stop → await the push.
      await session.sendDebuggerCommand({ command: 'profiler.start' });
      await sleep(durationMs);
      await session.sendDebuggerCommand({ command: 'profiler.stop' });
      const output = await session.waitForPushedDebuggerMessage({
        command: 'profiler.output',
        timeoutMs: BYOK_PROFILE_OUTPUT_TIMEOUT_MS,
      });
      return {
        output: {
          success: true,
          durationMs,
          framesAverageMeasures: output.framesAverageMeasures || [],
          stats: output.stats || null,
          note:
            'Measured on the preview launched by this chat. framesAverageMeasures times are per subsystem (ms/frame); read the heaviest entries first.',
        },
        didModifyProject: false,
      };
    } catch (error) {
      return makeFailure(
        `The profiling run failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  },
});

/** The debugger/profiler tools (a fresh read, like ByokExtraTools). */
export const getByokDebuggerTools = (): Array<ByokExtraTool> => [
  makeReadRuntimeDetailsTool(),
  makeControlRuntimeTool(),
  makeProfileRuntimeTool(),
];
