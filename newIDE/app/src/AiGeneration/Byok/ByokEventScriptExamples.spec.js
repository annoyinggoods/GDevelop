// @flow
import {
  findByNameokEventScriptExample,
  getByokEventScriptExamples,
  isByokEventScriptExamplesAvailable,
  makeByokEventScriptRetryHint,
  pickByokEventScriptRetryHintId,
  searchByokEventScriptExamples,
} from './ByokEventScriptExamples';

describe('ByokEventScriptExamples (the Phase 13.6 bank)', () => {
  it('loads the generated bank with well-formed entries', () => {
    const examples = getByokEventScriptExamples();
    expect(examples.length).toBeGreaterThanOrEqual(10);
    for (const example of examples) {
      expect(example.id).toBeTruthy();
      expect(example.name).toBeTruthy();
      expect(example.tags.length).toBeGreaterThan(0);
      expect(example.source).toContain(':');
    }
    expect(isByokEventScriptExamplesAvailable()).toBe(true);
  });

  it('finds an example by id, null for an unknown id', () => {
    expect(findByNameokEventScriptExample('timer-spawn')).not.toBe(null);
    expect(findByNameokEventScriptExample('nope')).toBe(null);
  });

  it('searches by tag and by word', () => {
    const timerHits = searchByokEventScriptExamples('timer');
    expect(timerHits.map(example => example.id)).toContain('timer-spawn');

    const spawnHits = searchByokEventScriptExamples('collision variable');
    expect(spawnHits.map(example => example.id)).toContain('collision-counter');

    expect(searchByokEventScriptExamples('zzznonsense')).toEqual([]);
    expect(searchByokEventScriptExamples('   ')).toEqual([]);
  });
});

describe('pickByokEventScriptRetryHintId (the error-class map)', () => {
  it('maps the failing construct to its example', () => {
    expect(
      pickByokEventScriptRetryHintId(
        'EventScript is not valid',
        'Scene("Menu")'
      )
    ).toBe('scene-switch');
    expect(
      pickByokEventScriptRetryHintId(
        'EventScript is not valid',
        'ResetTimer("T")'
      )
    ).toBe('timer-spawn');
    expect(
      pickByokEventScriptRetryHintId(
        'EventScript is not valid',
        'for each Enemy:'
      )
    ).toBe('for-each-enemy');
    expect(
      pickByokEventScriptRetryHintId(
        'EventScript is not valid',
        'repeat 3 times:'
      )
    ).toBe('loops-groups-waves');
    expect(
      pickByokEventScriptRetryHintId(
        'unknown condition CollisionXYZ',
        'collision stuff'
      )
    ).toBe('collision-counter');
  });

  it('defaults to the most canonical example', () => {
    expect(pickByokEventScriptRetryHintId('something odd', '')).toBe(
      'collision-counter'
    );
  });
});

describe('makeByokEventScriptRetryHint', () => {
  it('returns the full hint: id, name, and the runnable source', () => {
    const hint: any = makeByokEventScriptRetryHint(
      'Batch 0 EventScript is not valid',
      'Timer(2, "SpawnTimer")'
    );
    expect(hint).not.toBe(null);
    expect(hint.exampleId).toBe('timer-spawn');
    expect(hint.exampleName).toBeTruthy();
    expect(hint.source).toContain('ResetTimer("SpawnTimer")');
  });
});
