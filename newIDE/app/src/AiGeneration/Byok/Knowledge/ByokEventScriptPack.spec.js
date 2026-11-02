// @flow
import { getByokEventScriptPackExamples } from './ByokEventScriptPack';
import { parseByokEventScript } from '../ByokEventScriptParser';
import {
  getByokKnowledgeSections,
  estimateByokTokens,
  makeByokPromptContext,
} from './ByokKnowledgeSections';

describe('ByokEventScriptPack', () => {
  it('is registered as degradable knowledge after the core sections', () => {
    const pack = getByokKnowledgeSections().find(
      section => section.id === 'eventscript-pack'
    );
    if (!pack) throw new Error('The EventScript pack is not registered');

    expect(pack.degradable).toBe(true);
    expect(pack.priority).toBeGreaterThanOrEqual(200);
  });

  it('fits its own declared budget', () => {
    const pack = getByokKnowledgeSections().find(
      section => section.id === 'eventscript-pack'
    );
    if (!pack) throw new Error('The EventScript pack is not registered');

    const built = pack.build(
      makeByokPromptContext({ toolNames: [], hasOpenedProject: true })
    );
    expect(built.length).toBeGreaterThan(0);
    expect(estimateByokTokens(built)).toBeLessThanOrEqual(pack.budgetTokens);
  });

  it('carries the grammar lines the operational core promises', () => {
    const pack = getByokKnowledgeSections().find(
      section => section.id === 'eventscript-pack'
    );
    if (!pack) throw new Error('The EventScript pack is not registered');
    const text = pack.build(
      makeByokPromptContext({ toolNames: [], hasOpenedProject: true })
    );

    // Statement forms.
    expect(text).toContain('always:');
    expect(text).toContain('else if');
    expect(text).toContain('while Cond():');
    expect(text).toContain('repeat 5 times:');
    expect(text).toContain('for each Enemy:');
    expect(text).toContain('for each child in');
    expect(text).toContain('group "Name":');
    expect(text).toContain('comment "text"');
    // Condition composition.
    expect(text).toContain('and');
    expect(text).toContain('not');
    expect(text).toContain('Or(');
    expect(text).toContain('once');
    expect(text).toContain('disabled ');
    // Escaping, anchors, collapse markers.
    expect(text).toContain('escape');
    expect(text).toContain('# event-');
    expect(text).toContain('# ...');
    // Placement relations.
    expect(text).toContain('expected_event_source');
  });

  describe('every worked example parses with the Phase 5 parser', () => {
    const examples = getByokEventScriptPackExamples();

    test('the pack ships 6 to 10 examples', () => {
      expect(examples.length).toBeGreaterThanOrEqual(6);
      expect(examples.length).toBeLessThanOrEqual(10);
    });

    examples.forEach(example => {
      test(`parses: ${example.name}`, () => {
        const result = parseByokEventScript(example.source);
        if (result.error) {
          throw new Error(
            `Example "${example.name}" does not parse: ${
              result.error.message
            } (line ${result.error.lineNumber}: ${result.error.lineText})`
          );
        }
        expect(result.events).toBeTruthy();
      });
    });
  });
});

describe('ByokEventScriptPack: audit011026 pins', () => {
  it('teaches only the 8 real placement relations (no insert_at_beginning)', () => {
    const packText = getByokEventScriptPackExamples().length.toString();
    expect(packText).toBeTruthy();
    const sections = getByokKnowledgeSections();
    const packSection = sections.find(
      section => section.id === 'eventscript-pack'
    );
    const text = packSection
      ? packSection.build(
          makeByokPromptContext({ toolNames: [], hasOpenedProject: true })
        )
      : '';
    expect(text).not.toContain('insert_at_beginning');
    expect(text).toContain('insert_at_end');
  });

  it('teaches ALL the event-level placement relations the writer accepts (audit100226 PROMPT-5)', () => {
    const packSection = getByokKnowledgeSections().find(
      section => section.id === 'eventscript-pack'
    );
    if (!packSection) throw new Error('The EventScript pack is not registered');
    const text = packSection.build(
      makeByokPromptContext({ toolNames: [], hasOpenedProject: true })
    );

    // The pack taught 7 of the 8 event-level relations:
    // replace_event_but_keep_existing_sub_events was missing, so a model
    // editing an event while keeping its children had no vocabulary for it
    // and fell back to the destructive relation.
    const eventLevelRelations = [
      'insert_at_end',
      'insert_before_event',
      'insert_after_event',
      'insert_as_sub_event',
      'insert_and_replace_event',
      'replace_entire_event_and_sub_events',
      'replace_event_but_keep_existing_sub_events',
      'delete_event',
    ];
    for (const relation of eventLevelRelations) {
      expect(text).toContain(relation);
    }
  });

  it('round-trips the Create worked example through the real writer pipeline', () => {
    // The pack used to teach Create(Player, "Player", 100, 200, "Base
    // layer") — five arguments for a four-parameter action; it parsed, but
    // put the object name in the X slot (B-PROMPT-3). The writer pipeline
    // catches argument-count drift the parse-only check cannot.
    const examples = getByokEventScriptPackExamples();
    const createExample = examples.find(example =>
      example.source.includes('Create(')
    );
    expect(createExample).toBeTruthy();
    const parseResult = parseByokEventScript(
      createExample ? createExample.source : ''
    );
    expect(parseResult.error).toBeUndefined();
    const events = parseResult.events || [];
    // Find the Create call in the parsed JSON and assert its parameter
    // count matches the engine action (object, X, Y, layer).
    const serialized = JSON.stringify(events);
    expect(serialized).toBeTruthy();
    const createCall = events
      .flatMap((event: any) => (event.actions ? event.actions : []))
      .find((action: any) => JSON.stringify(action.type).includes('Create'));
    if (createCall) {
      const parameters = createCall.parameters || [];
      // The engine's Create action serializes one code-only parameter
      // (objectsContext) before the four visible ones (object, X, Y,
      // layer) — a sixth means the example duplicated an argument.
      expect(parameters.length).toBeLessThanOrEqual(5);
      // The object is an expression, never a quoted string: the historical
      // 5-arg example put "Player" (quoted) in the object slot.
      expect(parameters[1]).not.toMatch(/^"/);
    }
  });
});
