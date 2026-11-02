// @flow
/**
 * The project mutation lock (audit100226 UP-11).
 *
 * Tool execution has several doors: the chat orchestrator's per-batch
 * execution section, the MCP host's registry calls and its intercepted
 * calls. The MCP doors serialize among themselves through the tool host's
 * own queue, but nothing serialized them against the chat — so a chat
 * batch (a preview wait, an asset download, the extensions reload) and an
 * MCP `tools/call`, or two concurrent chats, could interleave `gd.*`
 * mutations on the same project at await points. Nothing corrupts (the
 * editor functions re-resolve by name), but the dirty mark, the completion
 * gate's snapshot and the restore points then describe a state no single
 * agent ever produced.
 *
 * One FIFO chain, three doors. The rules that keep it deadlock-free:
 *
 * 1. Acquire ONLY at a door, never inside one. The interior
 *    `executeSingleToolCall` bridge (run_gameplay_test) deliberately does
 *    not lock: its callers already run inside a door.
 * 2. The chat door is held only across one tool batch's EXECUTION — the
 *    model request before it, the approval prompt before it, and the
 *    transcript bookkeeping after it all run unlocked.
 * 3. No timeout. A mutation finishes and releases; the MCP client-side
 *    timeout answers the external caller early regardless, so a hung
 *    mutator still cannot be overtaken.
 */

let lockTail: Promise<void> = Promise.resolve();

/**
 * Run `task` with exclusive access to the project. Tasks run in call
 * order, and the lock is released however the task settles.
 */
export const runExclusiveByokProjectMutation = <T>(
  task: () => Promise<T>
): Promise<T> => {
  const result = lockTail.then(task);
  lockTail = result.then(() => {}, () => {});
  return result;
};

/** Forget the chain (tests). */
export const resetByokMutationLockForTests = (): void => {
  lockTail = Promise.resolve();
};
