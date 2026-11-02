// @flow

/**
 * The cross-window activity merge (audit011026 B-MCP-13): the activity ring
 * in `ByokMcpToolHost` is this renderer's module state only, while the main
 * process aggregates every window's mirrored entries and serves them through
 * `byok-mcp-status`. The settings card shows the union of both — local
 * entries may not have reached main yet at query time, remote entries come
 * from the other windows. Pure so the merge is testable without any IPC.
 */

import {
  BYOK_MCP_ACTIVITY_CAPACITY,
  type ByokMcpActivityEntry,
} from './ByokMcpToolHost';

/**
 * The identity of an entry across the local ring and the main aggregate: an
 * entry this window recorded is mirrored to main, so it comes back once more.
 *
 * The call id leads, because everything else can repeat: two DISTINCT calls
 * sharing tool, arguments, outcome, duration and millisecond produced the
 * same key, so the second entry was silently dropped and never displayed
 * (audit100226 MCP-8). Entries without one (older mirrors, hand-built
 * fixtures) fall back to the descriptive fields.
 */
const makeByokMcpActivityKey = (entry: ByokMcpActivityEntry): string =>
  [
    entry.callId || '',
    entry.at,
    entry.tool,
    entry.argsPreview,
    entry.outcome,
    String(entry.durationMs),
    entry.didModifyProject ? 'modified' : 'unmodified',
  ].join('|');

const compareByokMcpActivityNewestFirst = (
  first: ByokMcpActivityEntry,
  second: ByokMcpActivityEntry
): number => {
  // ISO 8601 timestamps sort lexicographically.
  if (first.at > second.at) return -1;
  if (first.at < second.at) return 1;
  return 0;
};

/**
 * The deduplicated union of the local ring and the main-side aggregate,
 * newest first, capped at the ring capacity. Local entries win ties (the
 * stable sort keeps them ahead when timestamps are identical).
 */
export const mergeByokMcpActivity = (
  local: Array<ByokMcpActivityEntry>,
  remote: Array<ByokMcpActivityEntry>
): Array<ByokMcpActivityEntry> => {
  const seenKeys = new Set<string>();
  const merged: Array<ByokMcpActivityEntry> = [];
  for (const entry of local.concat(remote)) {
    const key = makeByokMcpActivityKey(entry);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    merged.push(entry);
  }
  return merged
    .sort(compareByokMcpActivityNewestFirst)
    .slice(0, BYOK_MCP_ACTIVITY_CAPACITY);
};
