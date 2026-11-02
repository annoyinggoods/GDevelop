// @flow
import {
  BYOK_LOOP_GUARD_CORRECTIVE_MESSAGE,
  BYOK_LOOP_GUARD_HISTORY_SIZE,
  BYOK_LOOP_GUARD_STOP_COUNT,
  BYOK_LOOP_GUARD_TRIGGER_COUNT,
  createByokLoopGuard,
  makeByokCallFingerprint,
} from './ByokLoopGuards';

describe('makeByokCallFingerprint', () => {
  it('is equal for the same name and arguments', () => {
    expect(
      makeByokCallFingerprint('describe_instances', { scene_name: 'S' })
    ).toBe(makeByokCallFingerprint('describe_instances', { scene_name: 'S' }));
  });

  it('differs when the name or the arguments differ', () => {
    expect(
      makeByokCallFingerprint('describe_instances', { scene_name: 'S' })
    ).not.toBe(
      makeByokCallFingerprint('read_scene_events', { scene_name: 'S' })
    );
    expect(
      makeByokCallFingerprint('describe_instances', { scene_name: 'A' })
    ).not.toBe(
      makeByokCallFingerprint('describe_instances', { scene_name: 'B' })
    );
  });

  it('is stable for unparsable arguments (null)', () => {
    expect(makeByokCallFingerprint('wait', null)).toBe('wait(null)');
  });
});

describe('createByokLoopGuard', () => {
  it('lets the first two identical calls through', () => {
    const guard = createByokLoopGuard();
    expect(guard.checkCall('describe_instances', { scene_name: 'S' })).toBe(
      'ok'
    );
    expect(guard.checkCall('describe_instances', { scene_name: 'S' })).toBe(
      'ok'
    );
  });

  it('refuses the third identical call with the corrective verdict', () => {
    const guard = createByokLoopGuard();
    guard.checkCall('describe_instances', { scene_name: 'S' });
    guard.checkCall('describe_instances', { scene_name: 'S' });
    expect(guard.checkCall('describe_instances', { scene_name: 'S' })).toBe(
      'corrective'
    );
    expect(BYOK_LOOP_GUARD_TRIGGER_COUNT).toBe(3);
  });

  it('stops the chat on the fourth identical call', () => {
    const guard = createByokLoopGuard();
    for (let index = 0; index < 3; index++) {
      guard.checkCall('describe_instances', { scene_name: 'S' });
    }
    expect(guard.checkCall('describe_instances', { scene_name: 'S' })).toBe(
      'stop'
    );
    expect(BYOK_LOOP_GUARD_STOP_COUNT).toBe(4);
  });

  it('resets the streak when the arguments change (a different look is progress)', () => {
    const guard = createByokLoopGuard();
    guard.checkCall('describe_instances', { scene_name: 'S' });
    guard.checkCall('describe_instances', { scene_name: 'S' });
    guard.checkCall('describe_instances', { scene_name: 'S2' });
    expect(guard.checkCall('describe_instances', { scene_name: 'S3' })).toBe(
      'ok'
    );
    expect(guard.checkCall('describe_instances', { scene_name: 'S4' })).toBe(
      'ok'
    );
  });

  it('never trips on the plan tool (re-sending updated tasks is normal)', () => {
    const guard = createByokLoopGuard();
    for (let index = 0; index < 10; index++) {
      expect(guard.checkCall('create_or_update_plan', { tasks: [] })).toBe(
        'ok'
      );
    }
  });

  it('counts an identical re-read of an inspection tool (outputs-only is not exempt)', () => {
    const guard = createByokLoopGuard();
    guard.checkCall('read_scene_events', { scene_name: 'S' });
    guard.checkCall('read_scene_events', { scene_name: 'S' });
    expect(guard.checkCall('read_scene_events', { scene_name: 'S' })).toBe(
      'corrective'
    );
  });

  it('keeps at most the last history-size fingerprints', () => {
    const guard = createByokLoopGuard();
    for (let index = 0; index < BYOK_LOOP_GUARD_HISTORY_SIZE + 5; index++) {
      guard.checkCall('describe_instances', { scene_name: `S${index}` });
    }
    expect(guard.getHistory().length).toBe(BYOK_LOOP_GUARD_HISTORY_SIZE);
  });

  it('exposes the corrective message the model reads', () => {
    expect(BYOK_LOOP_GUARD_CORRECTIVE_MESSAGE).toContain(
      'already called this exact tool'
    );
    expect(BYOK_LOOP_GUARD_CORRECTIVE_MESSAGE).toContain(
      'Change your approach'
    );
  });
});

describe('ByokLoopGuard: audit100226 fixes', () => {
  it('TOOL-7: a batch that executed nothing does not move the thresholds', () => {
    // The user REFUSED the batch, so its calls never ran: they must not
    // count, or a chat could die with "repeated tool call" for a tool that
    // had executed zero times.
    const guard = createByokLoopGuard();
    guard.beginBatch();
    expect(guard.checkCall('put_2d_instances', { x: 1 })).toBe('ok');
    guard.restoreBatch();
    expect(guard.getHistory()).toEqual([]);
    // Four more refused rounds: still nothing recorded, still 'ok'.
    for (let round = 0; round < 4; round++) {
      guard.beginBatch();
      expect(guard.checkCall('put_2d_instances', { x: 1 })).toBe('ok');
      guard.restoreBatch();
    }
    expect(guard.getHistory()).toEqual([]);
  });

  it('TOOL-7: rounds that DID execute still build a streak across batches', () => {
    const guard = createByokLoopGuard();
    guard.beginBatch();
    expect(guard.checkCall('read_events_source', { scene: 'S' })).toBe('ok');
    guard.beginBatch();
    expect(guard.checkCall('read_events_source', { scene: 'S' })).toBe('ok');
    guard.beginBatch();
    // No restoreBatch: the third identical call executed, so the streak
    // reaches the corrective threshold exactly as before.
    expect(guard.checkCall('read_events_source', { scene: 'S' })).toBe(
      'corrective'
    );
    guard.beginBatch();
    expect(guard.checkCall('read_events_source', { scene: 'S' })).toBe('stop');
  });

  it('TOOL-8: an ALTERNATING loop is caught (its trailing streak is only 1)', () => {
    const guard = createByokLoopGuard();
    // A, B, A, B, ... never exceeds a trailing streak of 1, so the streak
    // thresholds alone let it run to the round cap.
    const verdicts = [];
    for (let round = 0; round < 10; round++) {
      guard.beginBatch();
      // Identical arguments each time: only the TOOL alternates, which is
      // exactly the shape a real stuck loop has (a fingerprint is the name
      // AND its arguments).
      verdicts.push(
        guard.checkCall(
          round % 2 === 0 ? 'describe_instances' : 'list_effects',
          {
            scene: 'Level 1',
          }
        )
      );
    }
    expect(verdicts).toContain('stop');
  });

  it('TOOL-8: ordinary exploration that is NOT a tight cycle is not stopped', () => {
    const guard = createByokLoopGuard();
    for (let round = 0; round < 8; round++) {
      guard.beginBatch();
      expect(
        guard.checkCall('describe_instances', { scene: `S${round}` })
      ).toBe('ok');
    }
  });
});
