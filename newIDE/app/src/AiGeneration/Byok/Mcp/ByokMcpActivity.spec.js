// @flow
import {
  BYOK_MCP_ACTIVITY_CAPACITY,
  type ByokMcpActivityEntry,
} from './ByokMcpToolHost';
import { mergeByokMcpActivity } from './ByokMcpActivity';

const makeEntry = (overrides?: Object) => ({
  at: '2026-10-02T10:00:00.000Z',
  tool: 'read_scene_events',
  argsPreview: '{}',
  outcome: 'completed',
  didModifyProject: false,
  durationMs: 5,
  ...(overrides || {}),
});

const BASE_MS = Date.parse('2026-10-02T10:00:00Z');

// Distinct tools sharing a timestamp would collide with dedupe assertions;
// distinct timestamps keep every entry individually addressable.
const makeTimestampedEntry = (
  tool: string,
  index: number
): ByokMcpActivityEntry =>
  (makeEntry({
    tool,
    at: new Date(BASE_MS + index * 1000).toISOString(),
  }): any);

describe('mergeByokMcpActivity (audit011026 B-MCP-13)', () => {
  it('dedupes an entry present in both the local ring and the aggregate', () => {
    const shared = makeEntry();
    const merged = mergeByokMcpActivity([shared], [shared]);
    expect(merged).toEqual([shared]);
  });

  it('keeps same-second entries apart when a field differs', () => {
    const completed = makeEntry({ outcome: 'completed' });
    const timedOut = makeEntry({ outcome: 'timeout' });
    const merged = mergeByokMcpActivity([completed], [timedOut]);
    expect(merged).toHaveLength(2);
  });

  it('orders the union newest first', () => {
    const older = makeEntry({
      tool: 'older_tool',
      at: '2026-10-02T09:00:00.000Z',
    });
    const newer = makeEntry({
      tool: 'newer_tool',
      at: '2026-10-02T11:00:00.000Z',
    });
    const merged = mergeByokMcpActivity([older], [newer]);
    expect(merged.map(entry => entry.tool)).toEqual([
      'newer_tool',
      'older_tool',
    ]);
  });

  it('caps the union at the ring capacity, dropping the oldest', () => {
    const local = [];
    const remote = [];
    for (let index = 0; index < BYOK_MCP_ACTIVITY_CAPACITY + 5; index++) {
      local.push(makeTimestampedEntry(`local_${index}`, index));
      remote.push(makeTimestampedEntry(`remote_${index}`, index));
    }
    const merged = mergeByokMcpActivity(local, remote);
    expect(merged).toHaveLength(BYOK_MCP_ACTIVITY_CAPACITY);
    // Same timestamp: the local entry is listed first (stable sort).
    expect(merged[0].tool).toBe(`local_${BYOK_MCP_ACTIVITY_CAPACITY + 4}`);
    expect(merged[1].tool).toBe(`remote_${BYOK_MCP_ACTIVITY_CAPACITY + 4}`);
    expect(merged.some(entry => entry.tool === 'local_0')).toBe(false);
    expect(merged.some(entry => entry.tool === 'remote_0')).toBe(false);
  });

  it('returns the local ring alone when the aggregate is empty', () => {
    const newest = makeEntry({
      tool: 'newest_tool',
      at: '2026-10-02T11:00:00.000Z',
    });
    const oldest = makeEntry({
      tool: 'oldest_tool',
      at: '2026-10-02T09:00:00.000Z',
    });
    const merged = mergeByokMcpActivity([newest, oldest], []);
    expect(merged).toEqual([newest, oldest]);
  });

  it('returns the aggregate alone when the local ring is empty', () => {
    const entry = makeEntry({ tool: 'remote_only_tool' });
    const merged = mergeByokMcpActivity([], [entry]);
    expect(merged).toEqual([entry]);
  });
});

describe('ByokMcpActivity: the dedupe key (audit100226 MCP-8)', () => {
  it('keeps two DISTINCT calls recorded in the same millisecond', () => {
    // Everything except the call id repeats: same tool, same arguments, same
    // outcome, same duration, same ISO timestamp (millisecond precision).
    // Keying on those alone dropped the second entry, which was then never
    // displayed at all.
    const first = makeEntry({ callId: 'mcp-1' });
    const second = makeEntry({ callId: 'mcp-2' });

    const merged = mergeByokMcpActivity([first], [second]);

    expect(merged).toHaveLength(2);
  });

  it('still dedupes a local entry against its mirrored copy', () => {
    // The mirror of a local entry comes back through the aggregate; both must
    // collapse to ONE row in the settings card.
    const entry = makeEntry({ callId: 'mcp-7' });

    const merged = mergeByokMcpActivity([entry], [entry]);

    expect(merged).toHaveLength(1);
  });

  it('falls back to the descriptive fields when no call id is present', () => {
    // Entries recorded before the call id existed must keep deduping against
    // their mirror rather than showing twice.
    const entry = makeEntry();

    expect(mergeByokMcpActivity([entry], [entry])).toHaveLength(1);
    // ...and two identical entries without ids stay collapsed.
    expect(mergeByokMcpActivity([entry], [makeEntry()])).toHaveLength(1);
  });
});
