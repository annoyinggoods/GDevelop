// @flow
import { makeTestProject } from '../../fixtures/TestProject';
import { renderEventsAsEventScript } from '../../EventsSheet/EventsTree/TextRenderer/EventScriptRenderer';
import { makeEventsList } from '../../EventsSheet/EventsTree/TextRenderer/EventScriptTestHelpers';
import {
  makeLibGdInstructionMetadataProvider,
  parseByokEventScript,
} from './ByokEventScriptParser';

const gd: libGDevelop = global.gd;

// Conformance fixtures shared with the backend serializer and the editor
// renderer: the EventScript they show must parse back into events that the
// editor renders to the same source — the grammar contract of Phase 5.
const serializerFixtures = require('../../EventsSheet/EventsTree/TextRenderer/EventScriptRenderer.fixtures.json');

const stripIdAnnotations = (text: string): string =>
  text
    .split('\n')
    .map(line => line.replace(/\s*# event-[\d.]+$/, ''))
    .join('\n');

// A non-representable event (fixture "unknown instruction and
// non-representable event") is shown as a lossy comment: parsing drops it,
// so the comparison drops such lines from the expected source too.
const dropLossyCommentLines = (lines: Array<string>): Array<string> =>
  lines.filter(line => !line.trim().startsWith('# (event'));

describe('ByokEventScriptParser conformance fixtures (parse → gd → render)', () => {
  serializerFixtures.fixtures.forEach(fixture => {
    it(`round-trips: ${fixture.name}`, () => {
      const { project } = makeTestProject(gd);
      try {
        const parseResult = parseByokEventScript(
          fixture.expectedEventScript.join('\n')
        );
        expect(parseResult.error).toBeUndefined();
        if (!parseResult.events) throw new Error('unreachable');

        const eventsList = makeEventsList(project, parseResult.events);
        try {
          const { text, renderingErrors } = renderEventsAsEventScript({
            eventsList,
          });
          expect(renderingErrors).toEqual([]);
          expect(stripIdAnnotations(text)).toBe(
            dropLossyCommentLines(fixture.expectedEventScript).join('\n')
          );
        } finally {
          eventsList.delete();
        }
      } finally {
        project.delete();
      }
    });
  });
});

describe('ByokEventScriptParser parameter refill', () => {
  it('re-inserts the code-only parameter slots the renderer hides', () => {
    const parseResult = parseByokEventScript(
      'if Timer(2, "SpawnTimer") and once:\n  ResetTimer("SpawnTimer")'
    );
    if (!parseResult.events) throw new Error('expected events');
    const standardEvent = parseResult.events[0];
    expect(standardEvent.conditions[0]).toEqual({
      type: { value: 'Timer' },
      // The leading "" is the hidden object-scope slot, refilled from the
      // instruction metadata.
      parameters: ['', '2', '"SpawnTimer"'],
    });
    expect(standardEvent.actions[0]).toEqual({
      type: { value: 'ResetTimer' },
      parameters: ['', '"SpawnTimer"'],
    });
  });

  it('keeps the parameters of unknown instructions as-is', () => {
    const unknownMetadataProvider = () => ({
      isKnown: false,
      parameterCount: 0,
      isParameterCodeOnly: (index: number) => false,
    });
    const parseResult = parseByokEventScript(
      'always:\n  SomeUnknownExtension::Unknown(A, , B)',
      { metadataProvider: unknownMetadataProvider }
    );
    if (!parseResult.events) throw new Error('expected events');
    expect(parseResult.events[0].actions[0]).toEqual({
      type: { value: 'SomeUnknownExtension::Unknown' },
      parameters: ['A', '', 'B'],
    });
  });

  it('pads the trailing optional slots the renderer trims', () => {
    const parseResult = parseByokEventScript(
      'always:\n  Create(Star, 100, -50)'
    );
    if (!parseResult.events) throw new Error('expected events');
    expect(parseResult.events[0].actions[0]).toEqual({
      type: { value: 'Create' },
      parameters: ['', 'Star', '100', '-50', ''],
    });
  });

  it('keeps an explicit empty-string literal on a required parameter', () => {
    const parseResult = parseByokEventScript(
      'if StringVariable(MoveDirection, =, "Left"):\n  SetStringVariable(MoveDirection, =, "")'
    );
    if (!parseResult.events) throw new Error('expected events');
    expect(parseResult.events[0].actions[0]).toEqual({
      type: { value: 'SetStringVariable' },
      parameters: ['MoveDirection', '=', '""'],
    });
  });
});

describe('ByokEventScriptParser compositions and flags', () => {
  it('parses not, Or and parenthesized and-groups', () => {
    const parseResult = parseByokEventScript(
      'if not PlatformBehavior::IsFalling(Player, Platformer) and Or(DepartScene(), not Timer(2, "T")) and (Timer(1) and once):'
    );
    if (!parseResult.events) throw new Error('expected events');
    const conditions = parseByokEvents0Conditions(parseResult);
    expect(conditions[0]).toEqual({
      type: { value: 'PlatformBehavior::IsFalling', inverted: true },
      parameters: ['Player', 'Platformer'],
    });
    expect(conditions[1]).toEqual({
      type: { value: 'BuiltinCommonInstructions::Or' },
      parameters: [],
      subInstructions: [
        { type: { value: 'DepartScene' }, parameters: [''] },
        {
          type: { value: 'Timer', inverted: true },
          parameters: ['', '2', '"T"'],
        },
      ],
    });
    expect(conditions[2]).toEqual({
      type: { value: 'BuiltinCommonInstructions::And' },
      parameters: [],
      subInstructions: [
        { type: { value: 'Timer' }, parameters: ['', '1', ''] },
        { type: { value: 'BuiltinCommonInstructions::Once' }, parameters: [] },
      ],
    });
  });

  it('parses an awaited action with the await flag', () => {
    const parseResult = parseByokEventScript('always:\n  await Wait(1)');
    if (!parseResult.events) throw new Error('expected events');
    expect(parseResult.events[0].actions[0]).toEqual({
      type: { value: 'Wait', await: true },
      parameters: ['1'],
    });
  });

  it('parses a disabled event', () => {
    const parseResult = parseByokEventScript('disabled always:\n  Wait(1)');
    if (!parseResult.events) throw new Error('expected events');
    expect(parseResult.events[0].disabled).toBe(true);
  });

  it('parses for each order by / limit / index clauses', () => {
    const parseResult = parseByokEventScript(
      'for each Player order by Player.Y() desc limit 3 index I if once:'
    );
    if (!parseResult.events) throw new Error('expected events');
    expect(parseResult.events[0]).toEqual(
      expect.objectContaining({
        type: 'BuiltinCommonInstructions::ForEach',
        object: 'Player',
        orderBy: 'Player.Y()',
        order: 'desc',
        limit: '3',
        loopIndexVariable: 'I',
      })
    );
    expect(parseResult.events[0].conditions).toEqual([
      { type: { value: 'BuiltinCommonInstructions::Once' }, parameters: [] },
    ]);
  });

  it('parses a link event and unicode identifiers', () => {
    const parseResult = parseByokEventScript(
      'link "Other scene"\nfor each Héros:\n  Delete(Héros)'
    );
    if (!parseResult.events) throw new Error('expected events');
    expect(parseResult.events[0]).toEqual({
      type: 'BuiltinCommonInstructions::Link',
      target: 'Other scene',
    });
    expect(parseResult.events[1].object).toBe('Héros');
  });

  it('unescapes \\n in parameter values', () => {
    const parseResult = parseByokEventScript(
      'always:\n  SetStringVariable(Story, =, "line one\\nline two")'
    );
    if (!parseResult.events) throw new Error('expected events');
    expect(parseResult.events[0].actions[0].parameters[2]).toBe(
      '"line one\nline two"'
    );
  });
});

// Helper keeping the expect blocks above readable.
const parseByokEvents0Conditions = (parseResult: any): Array<Object> => {
  return parseResult.events[0].conditions;
};

describe('ByokEventScriptParser errors', () => {
  it('reports a wrong indentation with its line number', () => {
    const parseResult = parseByokEventScript('always:\n      Wait(1)');
    if (!parseResult.error) throw new Error('expected an error');
    expect(parseResult.error.lineNumber).toBe(2);
    expect(parseResult.error.message).toContain('indented');
  });

  it('reports an unclosed call', () => {
    const parseResult = parseByokEventScript('always:\n  Wait(1');
    if (!parseResult.error) throw new Error('expected an error');
    expect(parseResult.error.message).toContain('unclosed');
    expect(parseResult.error.lineNumber).toBe(2);
  });

  it('reports an unknown statement', () => {
    const parseResult = parseByokEventScript('whenever something:');
    if (!parseResult.error) throw new Error('expected an error');
    expect(parseResult.error.message).toContain('is not an event statement');
  });

  it('reports a comment event with a body', () => {
    const parseResult = parseByokEventScript('comment "note"\n  Wait(1)');
    if (!parseResult.error) throw new Error('expected an error');
    expect(parseResult.error.message).toContain('cannot have a body');
  });

  it('reports a malformed local variable declaration', () => {
    const parseResult = parseByokEventScript(
      'always:\n  local number Count = {not json'
    );
    if (!parseResult.error) throw new Error('expected an error');
    expect(parseResult.error.message).toContain('not valid JSON');
  });

  it('reports a repeat without the times keyword', () => {
    const parseResult = parseByokEventScript('repeat 3:');
    if (!parseResult.error) throw new Error('expected an error');
    expect(parseResult.error.message).toContain('Malformed repeat');
  });

  it('reports a comment statement without a quoted text', () => {
    const parseResult = parseByokEventScript('comment note');
    if (!parseResult.error) throw new Error('expected an error');
    expect(parseResult.error.message).toContain('double-quoted');
  });
});

describe('ByokEventScriptParser module surface', () => {
  it('exposes a libGD metadata provider answering known instructions', () => {
    const provider = makeLibGdInstructionMetadataProvider();
    const timerMetadata = provider('condition', 'Timer');
    expect(timerMetadata.isKnown).toBe(true);
    expect(timerMetadata.parameterCount).toBeGreaterThan(0);

    const unknownMetadata = provider('action', 'NotARealExtension::Nope');
    expect(unknownMetadata.isKnown).toBe(false);
  });
});
