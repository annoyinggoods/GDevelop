// @flow

/**
 * The BYOK counterpart of the hosted agent's repeated-tool-call-loop
 * protection: a model that keeps sending the exact same tool call (same
 * name, same arguments) is stuck — the outputs clearly did not help it
 * move on. It gets one corrective round to change its approach, then the
 * chat stops with a clean error instead of burning the user's tokens.
 */

/** How many recent call fingerprints are kept (the guard's memory). */
export const BYOK_LOOP_GUARD_HISTORY_SIZE = 8;

/** Consecutive identical fingerprints after which execution is refused. */
export const BYOK_LOOP_GUARD_TRIGGER_COUNT = 3;

/** Consecutive identical fingerprints after which the chat stops. */
export const BYOK_LOOP_GUARD_STOP_COUNT = 4;

/**
 * How many times a short repeating cycle must repeat before the chat stops.
 * An alternating loop (A, B, A, B, …) has a trailing streak of 1, so the
 * streak thresholds never fired and it ran to the round cap
 * (audit100226 TOOL-8). Two full repeats of a cycle of 2..4 calls is the
 * signal; a single repeat of a 2-call cycle is normal exploration.
 */
export const BYOK_LOOP_GUARD_CYCLE_STOP_REPEATS = 4;

/**
 * The corrective message the model reads instead of the tool output — it
 * must teach the way out, not just report the refusal.
 */
export const BYOK_LOOP_GUARD_CORRECTIVE_MESSAGE =
  'You already called this exact tool with these arguments and it did not advance the task. Change your approach or ask the user.';

/**
 * Tools whose repeated identical calls are legitimate by design: the plan
 * tool is re-sent with updated tasks, and re-inspection tools are only
 * exempt while their arguments differ (an identical re-read is still a
 * stuck signal — the streak counts it).
 */
const BYOK_LOOP_GUARD_EXEMPT_TOOL_NAMES: Set<string> = new Set([
  'create_or_update_plan',
]);

export type ByokLoopGuardVerdict = 'ok' | 'corrective' | 'stop';

/**
 * The fingerprint of one call: the tool name and its parsed arguments.
 * Identical fingerprints (regardless of the outputs returned in between)
 * are the stuck signal.
 */
export const makeByokCallFingerprint = (
  name: string,
  parsedArguments: any
): string => `${name}(${JSON.stringify(parsedArguments)})`;

export type ByokLoopGuard = {|
  /**
   * Classify a call before it executes: 'ok' runs it, 'corrective' refuses
   * it with the corrective message (the model gets one chance to change
   * course), 'stop' refuses it and stops the chat.
   */
  checkCall: (name: string, parsedArguments: any) => ByokLoopGuardVerdict,
  /** Snapshot the history: called once before checking a batch. */
  beginBatch: () => void,
  /** Undo the calls recorded since beginBatch (none of them executed). */
  restoreBatch: () => void,
  /** The recent fingerprints, oldest first (capped, for introspection). */
  getHistory: () => Array<string>,
|};

/**
 * Create the loop guard of one chat. The guard only tracks calls that go
 * through it — exempt tools are answered 'ok' without touching the
 * streak, so interleaving them cannot mask (nor fabricate) a stuck loop.
 */
export const createByokLoopGuard = (): ByokLoopGuard => {
  let history: Array<string> = [];

  const getTrailingStreak = (): number => {
    if (history.length === 0) return 0;
    const lastFingerprint = history[history.length - 1];
    let streak = 0;
    for (let index = history.length - 1; index >= 0; index--) {
      if (history[index] !== lastFingerprint) break;
      streak++;
    }
    return streak;
  };

  /**
   * How many times the tail of the history repeats a short cycle. A real
   * stuck loop often ALTERNATES two calls (read A, read B, read A, …): its
   * trailing streak is 1, so the streak thresholds never fired and the chat
   * ran until the round cap (audit100226 TOOL-8). Returns 0 when the tail is
   * not a repeated block.
   */
  const getTrailingCycleRepeats = (): number => {
    const maxCycleLength = 4;
    for (
      let cycleLength = 1;
      cycleLength <= maxCycleLength && cycleLength * 2 <= history.length;
      cycleLength++
    ) {
      const cycleStart = history.length - cycleLength;
      if (cycleStart - cycleLength < 0) continue;
      let isRepeated = true;
      for (let index = cycleStart - cycleLength; index < cycleStart; index++) {
        if (history[index] !== history[index + cycleLength]) {
          isRepeated = false;
          break;
        }
      }
      if (!isRepeated) continue;
      const repeatedBlocks = Math.floor(history.length / cycleLength);
      if (repeatedBlocks >= 2) return repeatedBlocks;
    }
    return 0;
  };

  const pushFingerprint = (fingerprint: string): void => {
    history.push(fingerprint);
    if (history.length > BYOK_LOOP_GUARD_HISTORY_SIZE) {
      history = history.slice(-BYOK_LOOP_GUARD_HISTORY_SIZE);
    }
  };

  const classify = (): ByokLoopGuardVerdict => {
    // A repeated cycle of length >= 2 counts as a stuck loop directly: its
    // trailing streak is only 1, so the streak thresholds never see it.
    const cycleRepeats = getTrailingCycleRepeats();
    if (cycleRepeats >= BYOK_LOOP_GUARD_CYCLE_STOP_REPEATS) return 'stop';
    const streak = getTrailingStreak();
    if (streak >= BYOK_LOOP_GUARD_STOP_COUNT) return 'stop';
    if (streak >= BYOK_LOOP_GUARD_TRIGGER_COUNT) return 'corrective';
    return 'ok';
  };

  // The history as it stood before the batch currently being checked. A
  // batch whose calls NEVER ran (the user refused the approval, or the chat
  // was suspended while the prompt was open) must not move the thresholds:
  // counting it let a chat die with "repeated tool call" for a tool that had
  // never run once (audit100226 TOOL-7). Rolling back to this snapshot is
  // exact — the rounds before it keep their history.
  let historyBeforeBatch: Array<string> = [];

  return {
    checkCall: (name, parsedArguments) => {
      if (BYOK_LOOP_GUARD_EXEMPT_TOOL_NAMES.has(name)) return 'ok';

      const fingerprint = makeByokCallFingerprint(name, parsedArguments);
      pushFingerprint(fingerprint);
      return classify();
    },
    /** Snapshot the history: call once before checking a batch. */
    beginBatch: () => {
      historyBeforeBatch = history.slice();
    },
    /** Undo everything recorded since beginBatch (nothing executed). */
    restoreBatch: () => {
      history = historyBeforeBatch;
      historyBeforeBatch = history.slice();
    },
    getHistory: () => history.slice(),
  };
};
