// @flow
import {
  BYOK_ENGINE_REFERENCE_SEARCH_RESULT_CAP,
  searchByokEngineReference,
  isByokEngineReferenceAvailable,
  setByokEngineReferenceLoaderForTests,
} from './ByokEngineReference';

// A small fixture catalog with the shapes the ranking relies on.
const makeFixtureCatalog = () => [
  {
    kind: 'expression',
    owner: 'BuiltinMathematicalTools',
    name: 'lerp',
    description: 'Linearly interpolate a to b by x',
    parameters: [{ type: 'expression', description: 'a' }],
  },
  {
    kind: 'expression',
    owner: 'BuiltinMathematicalTools',
    name: 'clamp',
    description: 'Restrict a value to a given range',
    parameters: [],
  },
  {
    kind: 'behavior',
    owner: 'Physics2',
    name: 'Physics2Behavior',
    description: 'Allows to use the Box2D physics engine: lerping forces.',
    parameters: [],
  },
  {
    kind: 'action',
    owner: 'BuiltinAudio',
    name: 'PlaySound',
    description: 'Play a sound file on a channel.',
    parameters: [],
  },
];

describe('ByokEngineReference', () => {
  beforeEach(() => {
    setByokEngineReferenceLoaderForTests(() => makeFixtureCatalog());
  });

  afterAll(() => {
    // Restore the real (generated) catalog loader for the other suites.
    setByokEngineReferenceLoaderForTests(null);
  });

  it('ranks name prefix matches above substring matches', () => {
    const result = searchByokEngineReference({ query: 'lerp' });

    expect(result.available).toBe(true);
    expect(result.entries[0].name).toBe('lerp');
    // The physics behavior only mentions "lerp" in its description.
    expect(result.entries.map(entry => entry.name)).toEqual([
      'lerp',
      'Physics2Behavior',
    ]);
  });

  it('is case-insensitive', () => {
    const result = searchByokEngineReference({ query: 'PLAYSOUND' });
    expect(result.entries[0].name).toBe('PlaySound');
  });

  it('filters by kind and owner', () => {
    const expressions = searchByokEngineReference({
      query: '',
      kind: 'expression',
    });
    expect(expressions.entries.map(entry => entry.name).sort()).toEqual([
      'clamp',
      'lerp',
    ]);

    const physics = searchByokEngineReference({
      query: '',
      owner: 'physics2',
    });
    expect(physics.entries.map(entry => entry.name)).toEqual([
      'Physics2Behavior',
    ]);
  });

  it('lists everything of a kind when the query is empty', () => {
    const result = searchByokEngineReference({ query: '' });
    expect(result.totalMatches).toBe(4);
    expect(result.entries).toHaveLength(4);
    expect(result.truncated).toBe(false);
    expect(result.steeringLine).toBe(null);
  });

  it('caps the results and adds a steering line when truncated', () => {
    const bigCatalog = [];
    for (
      let index = 0;
      index < BYOK_ENGINE_REFERENCE_SEARCH_RESULT_CAP + 20;
      index++
    ) {
      bigCatalog.push({
        kind: 'action',
        owner: 'Big',
        name: `Action${index}`,
        description: 'A filler action.',
        parameters: [],
      });
    }
    setByokEngineReferenceLoaderForTests(() => bigCatalog);

    const result = searchByokEngineReference({ query: 'action' });

    expect(result.entries).toHaveLength(
      BYOK_ENGINE_REFERENCE_SEARCH_RESULT_CAP
    );
    expect(result.totalMatches).toBe(
      BYOK_ENGINE_REFERENCE_SEARCH_RESULT_CAP + 20
    );
    expect(result.truncated).toBe(true);
    expect(result.steeringLine).toContain('narrow your query');
  });

  it('answers "unavailable" when the catalog cannot be loaded', () => {
    setByokEngineReferenceLoaderForTests(() => {
      throw new Error('The reference file is missing.');
    });
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    expect(isByokEngineReferenceAvailable()).toBe(false);
    const result = searchByokEngineReference({ query: 'anything' });
    expect(result.available).toBe(false);
    expect(result.entries).toEqual([]);

    consoleErrorSpy.mockRestore();
  });

  it('never returns entries that are not shaped like catalog entries', () => {
    setByokEngineReferenceLoaderForTests(() => [
      null,
      'not an entry',
      { kind: 'action', name: 'HalfDefined' },
      {
        kind: 'action',
        owner: 'Ok',
        name: 'WellDefined',
        description: 'Fine.',
        parameters: [],
      },
    ]);

    const result = searchByokEngineReference({ query: '' });
    expect(result.entries.map(entry => entry.name)).toEqual(['WellDefined']);
  });

  it('ships the generated catalog and can answer a real query', () => {
    // Back to the real loader: the catalog must be bundled with the app.
    setByokEngineReferenceLoaderForTests(null);
    expect(isByokEngineReferenceAvailable()).toBe(true);

    const lerp = searchByokEngineReference({
      query: 'lerp',
      kind: 'expression',
    });
    expect(lerp.entries.length).toBeGreaterThan(0);
    expect(lerp.entries[0].name).toBe('lerp');
    expect(lerp.entries[0].owner).toBe('BuiltinMathematicalTools');
  });
});
