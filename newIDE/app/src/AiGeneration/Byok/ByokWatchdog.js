// @flow

/**
 * The F2 stall watchdog (Phase 9.1, owner decision #2 — streaming was
 * rejected, this is the approved waiting UX): while a BYOK turn is in
 * flight, the orchestrator reports every activity (request sent, response
 * arrived, tool executing, tool output posted, approval resolved); the
 * watchdog resets a timer on each one and, when a whole window passes
 * without activity, fires `onStall` — which appends one in-chat notice to
 * the transcript. One notice per window: a still-silent turn is reminded
 * again at the next window boundary, never more often. Any activity ends
 * the stalled state (the notice stays in the transcript as history).
 *
 * The watchdog watches GAPS, not calls: a model request in flight is the
 * client timeout's business, so the orchestrator pauses the watchdog for
 * the duration of each model call (`pause`/`resume`), and stops waiting
 * with the user during an approval row (`holdForApproval`/`releaseApproval`).
 * `disarm` (stop, suspend, chat ready) ends the watching entirely.
 */

export type ByokWatchdogActivity =
  | 'response-arrived'
  | 'tool-executing'
  | 'tool-output-posted'
  | 'approval-released'
  | 'notice-posted';

export type ByokWatchdog = {|
  /** Start (or restart) watching a turn. */
  arm: () => void,
  /** Stop watching entirely (stop/suspend/ready). */
  disarm: () => void,
  /** An activity happened: reset the timer, end the stalled state. */
  notifyActivity: (activity: ByokWatchdogActivity) => void,
  /** A model request is in flight: no notices (the client timeout rules). */
  pause: () => void,
  /** The model request ended: watch the gaps again. */
  resume: () => void,
  /** The user is being asked for approval: never nag them while they think. */
  holdForApproval: () => void,
  releaseApproval: () => void,
  /** Whether the watchdog is currently armed at all. */
  isWatching: () => boolean,
  dispose: () => void,
|};

export const createByokWatchdog = ({
  windowMs,
  onStall,
}: {|
  windowMs: number,
  onStall: () => void,
|}): ByokWatchdog => {
  let timerId: any = null;
  let isArmed = false;
  let isPaused = false;
  let isHeldForApproval = false;

  const clearTimer = (): void => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };

  const scheduleStall = (): void => {
    clearTimer();
    if (!isArmed || isPaused || isHeldForApproval) return;
    timerId = setTimeout(() => {
      timerId = null;
      // One notice per window: re-arm for the next window (a still-silent
      // turn is reminded again, never more often than once per window).
      onStall();
      scheduleStall();
    }, windowMs);
  };

  return {
    arm: () => {
      isArmed = true;
      isPaused = false;
      isHeldForApproval = false;
      scheduleStall();
    },
    disarm: () => {
      isArmed = false;
      isPaused = false;
      isHeldForApproval = false;
      clearTimer();
    },
    notifyActivity: () => {
      if (!isArmed) return;
      scheduleStall();
    },
    pause: () => {
      isPaused = true;
      clearTimer();
    },
    resume: () => {
      isPaused = false;
      scheduleStall();
    },
    holdForApproval: () => {
      isHeldForApproval = true;
      clearTimer();
    },
    releaseApproval: () => {
      isHeldForApproval = false;
      scheduleStall();
    },
    isWatching: () => isArmed,
    dispose: () => {
      isArmed = false;
      clearTimer();
    },
  };
};

/** The in-chat notice text for one stall window (kept next to the logic). */
export const buildByokStallNoticeText = (windowSeconds: number): string =>
  `[byok-notice] No activity for ${windowSeconds}s — the model may be stuck. You can stop the chat, or just wait: this notice repeats at most once every ${windowSeconds}s while nothing happens.`;
