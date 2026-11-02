// @flow
/**
 * @jest-environment jsdom
 */

// The prompt→registry guard (audit011026, the audit's "biggest gap"):
// every tool-like call token the taught surfaces use must resolve to a
// real DISPATCHABLE tool, a known engine name, or a documented
// prompt-vocabulary/code idiom. The read_doc_page gap (B-PROMPT-1 — a
// tool taught by ~1.5k corpus chunks but never registered) and the
// knowledge-section tool-name typo before it would both have failed here.

// jsdom does not implement matchMedia, which modules of the (lazily
// required) import chain call at load time — polyfill BEFORE the requires.
if (typeof window !== 'undefined' && !(window: any).matchMedia) {
  (window: any).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

jest.setTimeout(120000);

// JS/std idioms the skills legitimately teach inside run_script snippets.
const GENERIC_CODE_TOKENS = new Set([
  'cos',
  'sin',
  'min',
  'max',
  'abs',
  'sqrt',
  'floor',
  'ceil',
  'round',
  'pow',
  'random',
  'parseInt',
  'parseFloat',
  'setTimeout',
  'setInterval',
  'console',
  'fetch',
  'lerp',
]);

// EventScript cheat-sheet shorthand: instruction names written in their
// human-readable form (the parser accepts any instruction and refills
// parameters from the engine metadata, so these are intentional
// vocabulary, not stale tool names).
const EVENTSCRIPT_SHORTHAND_TOKENS = new Set([
  'Cond',
  'GetX',
  'GetY',
  'SetGlobalNumberVariable',
  'SetSceneNumberVariable',
]);

// Runtime JS-API vocabulary the skills teach (the gdjs runtime object
// model and the gameplay-testing harness helpers) — not engine-reference
// actions/expressions, not tools, legitimately callable from run_script
// and test code.
const RUNTIME_JS_API_TOKENS = new Set([
  'CellWidth',
  'GetAlignment',
  'GetBBText',
  'GetFontFamily',
  'GetFontSize',
  'GetWrappingWidth',
  'NearestEnemyX',
  'assert',
  'get3DRendererObject',
  'getArgument',
  'getLayer',
  'getObjects',
  'getPIXIRenderer',
  'getRenderer',
  'getRendererContainer',
  'getRendererObject',
  'getSceneName',
  'getThreeScene',
  'getX',
  'releaseAllInputs',
  'setGameResolutionSize',
  'setKeyPressed',
  'setMousePosition',
  'stepFrames',
  'stepUntil',
  'stepUntilObjectIsStable',
]);

// The EventScript placement relations (the writer's KNOWN_PLACEMENT_RELATIONS
// vocabulary). The pack teaches them as VALUES of `placement_relation`, and
// they are spelled exactly like tool names — which is why the widened guard
// has to know they are not (audit100226 PROMPT-3/PROMPT-5).
const EVENTSCRIPT_PLACEMENT_RELATION_TOKENS = new Set([
  'insert_at_end',
  'insert_before_event',
  'insert_after_event',
  'insert_as_sub_event',
  'insert_and_replace_event',
  'replace_entire_event_and_sub_events',
  'replace_event_but_keep_existing_sub_events',
  'replace_all_actions',
  'replace_all_conditions',
  'insert_actions_conditions_at_end',
  'insert_actions_conditions_at_start',
  'delete_event',
]);

// ARGUMENT names the prompt legitimately teaches. They are fields of a tool
// call, not tools: the widened guard cannot tell the two apart by shape
// (audit100226 PROMPT-3). Keep this list explicit and commented — a name that
// disappears from the prompt is harmless, but one added to a tool schema
// without a line here makes this guard fail and someone will "fix" it by
// widening the allowlist blindly.
const TOOL_ARGUMENT_TOKENS = new Set([
  // The event-writing tools.
  'changed_properties',
  'event_script',
  'expected_event_source',
  'placement_relation',
  'placement_target_event_id',
  // The catalog / asset tools.
  'effect_type',
  'search_terms',
  // change_sprite_frames operation names.
  'delete_even_if_used',
  'set_frame_image',
  // The docs pages argument.
  'about_translations',
  // The extension authoring arguments (duplication, expression type and
  // the getter an ActionWithOperator changes).
  'duplicated_extension_name',
  'duplicated_function_name',
  'duplicated_custom_object_name',
  'duplicated_custom_behavior_name',
  'duplicated_from_extension_name',
  'expression_type',
  'getter_name',
  // The area of a custom object fitted to its children, and its two
  // modes (they read as snake_case, so the guard collects them).
  'fit_area_to_children',
  'min_at_origin',
  'centered_on_origin',
]);

/**
 * Every identifier the prompt could be teaching as a tool name.
 *
 * Two shapes are collected, because the prompt uses both (audit100226
 * PROMPT-3): the call-shaped `name(` — which is what a model is told to
 * write — AND the BARE `snake_case` mention, which is how most tool names
 * actually appear in prose ("Use describe_instances and read_events_source
 * to check…", "found with search_tools(query)"). The old guard only matched
 * the first shape, so nearly all of the prompt's tool teaching escaped it.
 */
const collectCallTokens = (text: string): Set<string> => {
  const tokens = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*\(/g)) {
    tokens.add(match[0].slice(0, -1));
  }
  // Snake_case, which is the tool naming convention (`read_scene_events`),
  // and which English prose essentially never produces.
  for (const match of text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) {
    tokens.add(match[0]);
  }
  // The namespaced tools (`create_extension_BYOK`): snake_case with an
  // UPPERCASE suffix. The pattern above cannot match them (the underscore
  // of the suffix is a word character, so there is no word boundary after
  // the snake_case part) — without this second pass, the namespaced tools
  // would escape the guard entirely.
  for (const match of text.matchAll(
    /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)*_[A-Z][A-Z0-9]+\b/g
  )) {
    tokens.add(match[0]);
  }
  return tokens;
};

describe('ByokPromptGuard (audit011026: every taught tool token resolves)', () => {
  it('the composed prompts, the skill bodies and the docs-min chunk template', async () => {
    const { buildByokSystemPrompt } = require('./ByokPrompts');
    const {
      makeByokPromptContext,
    } = require('./Knowledge/ByokKnowledgeSections');
    const { getByokDispatchableToolNames } = require('./ByokToolSchema');
    const {
      listByokSkillMetadata,
      findByNameokSkill,
    } = require('./ByokSkills');
    const { buildByokRagCorpus } = require('./Rag/ByokRagCorpus');
    const engineReference = require('./docs/engine-reference.json');

    const dispatchable = new Set(getByokDispatchableToolNames());
    const engineTokens = new Set(
      engineReference.map((entry: any) => entry.name)
    );
    const known = (token: string): boolean =>
      dispatchable.has(token) ||
      engineTokens.has(token) ||
      GENERIC_CODE_TOKENS.has(token) ||
      EVENTSCRIPT_SHORTHAND_TOKENS.has(token) ||
      EVENTSCRIPT_PLACEMENT_RELATION_TOKENS.has(token) ||
      TOOL_ARGUMENT_TOKENS.has(token) ||
      RUNTIME_JS_API_TOKENS.has(token);

    const surfaces: Array<string> = [];
    const contexts: Array<Object> = [];
    for (const hasOpenedProject of [true, false]) {
      const skills = await listByokSkillMetadata();
      const context = makeByokPromptContext({
        toolNames: require('./ByokToolSchema').getByokAdvertisedToolNames({
          hasOpenedProject,
        }),
        hasOpenedProject,
        skills,
        engineReferenceAvailable: true,
        projectNotes: null,
        customInstructions: '',
      });
      contexts.push(context);
      surfaces.push(
        buildByokSystemPrompt({
          toolNames: require('./ByokToolSchema').getByokAdvertisedToolNames({
            hasOpenedProject,
          }),
          hasOpenedProject,
          context,
        })
      );
    }
    // Every registered knowledge section, built at FULL size (audit100226
    // PROMPT-4). The composed prompt above is budget-limited: three of the
    // six degradable sections — including the EventScript pack, the most
    // defect-dense text this feature has had — are collapsed to a one-line
    // summary in the default configuration, so the guard was reading an
    // abbreviated version of exactly the text that keeps going stale.
    const {
      getByokKnowledgeSections,
    } = require('./Knowledge/ByokKnowledgeSections');
    for (const section of getByokKnowledgeSections()) {
      for (const context of contexts) {
        surfaces.push(section.build(context));
      }
    }
    const skillsMetadata = await listByokSkillMetadata();
    for (const skill of skillsMetadata) {
      const full = await findByNameokSkill(skill.name);
      if (full) surfaces.push(full.body);
    }
    // The docs-min chunks carry the drill-down hint template — a sample of
    // the built corpus covers it.
    const corpus = await buildByokRagCorpus({});
    const docsMinSample = corpus
      .filter(chunk => chunk.source === 'docs-min')
      .slice(0, 50)
      .map(chunk => chunk.text)
      .join('\n');
    surfaces.push(docsMinSample);

    const unresolvable: Array<string> = [];
    for (const surface of surfaces) {
      for (const token of collectCallTokens(surface)) {
        if (!known(token)) unresolvable.push(token);
      }
    }
    expect([...new Set(unresolvable)].sort()).toEqual([]);
  });
});
