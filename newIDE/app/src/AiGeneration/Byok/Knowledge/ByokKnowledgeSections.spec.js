// @flow
import {
  BYOK_SYSTEM_PROMPT_BUDGET_TOKENS,
  BYOK_CHARS_PER_TOKEN,
  estimateByokTokens,
  summarizeByokSectionText,
  composeByokPromptSections,
  registerByokKnowledgeSection,
  getByokKnowledgeSections,
  resetByokKnowledgeSectionsForTests,
  makeByokPromptContext,
  type ByokKnowledgeSection,
} from './ByokKnowledgeSections';
import { BYOK_TOOL_NAMES } from '../ByokToolSchema';

const makeSection = (overrides: any = {}): ByokKnowledgeSection => ({
  id: 'fake-section',
  title: 'Fake section',
  priority: 200,
  budgetTokens: 10000,
  degradable: true,
  build: () => 'Fake section body line one.\nFake body line two.',
  ...overrides,
});

const makeContext = (overrides: any = {}) =>
  makeByokPromptContext({
    toolNames: ['create_scene'],
    hasOpenedProject: true,
    ...overrides,
  });

describe('ByokKnowledgeSections: budget estimation', () => {
  it('estimates tokens from the character count', () => {
    expect(estimateByokTokens('')).toBe(0);
    expect(estimateByokTokens('abcd')).toBe(1);
    expect(estimateByokTokens('a'.repeat(80))).toBe(
      Math.ceil(80 / BYOK_CHARS_PER_TOKEN)
    );
    expect(BYOK_SYSTEM_PROMPT_BUDGET_TOKENS * BYOK_CHARS_PER_TOKEN).toBe(22000);
  });
});

describe('ByokKnowledgeSections: registry', () => {
  afterEach(() => {
    resetByokKnowledgeSectionsForTests();
  });

  it('registers the core sections once, in priority order', () => {
    const sections = getByokKnowledgeSections();
    const ids = sections.map(section => section.id);

    expect(ids[0]).toBe('role');
    expect(ids).toContain('tools');
    expect(ids).toContain('project-context');
    expect(ids).toContain('output-rules');
    expect(ids).toContain('planning');
    expect(ids).toContain('skills-appendix');
    // The user's custom instructions are always the last section.
    expect(ids[ids.length - 1]).toBe('custom-instructions');

    const priorities = sections.map(section => section.priority);
    const sortedPriorities = priorities.slice().sort((a, b) => a - b);
    expect(priorities).toEqual(sortedPriorities);
  });

  it('is stable across calls and registrations are idempotent', () => {
    const first = getByokKnowledgeSections().map(section => section.id);
    const second = getByokKnowledgeSections().map(section => section.id);
    expect(first).toEqual(second);

    registerByokKnowledgeSection(makeSection({ id: 'role' }));
    expect(getByokKnowledgeSections().map(section => section.id)).toEqual(
      first
    );
  });

  it('inserts a registered knowledge section after the core ones', () => {
    registerByokKnowledgeSection(
      makeSection({ id: 'knowledge-fake', priority: 300 })
    );
    const ids = getByokKnowledgeSections().map(section => section.id);
    expect(ids).toContain('knowledge-fake');
    expect(ids.indexOf('knowledge-fake')).toBeGreaterThan(
      ids.indexOf('skills-appendix')
    );
    expect(ids[ids.length - 1]).toBe('custom-instructions');
  });
});

describe('ByokKnowledgeSections: composer', () => {
  afterEach(() => {
    resetByokKnowledgeSectionsForTests();
  });

  it('includes every fitting section in full, in priority order', () => {
    const first = makeSection({
      id: 'first',
      priority: 10,
      degradable: false,
      build: () => 'First body.',
    });
    const second = makeSection({
      id: 'second',
      priority: 20,
      degradable: false,
      build: () => 'Second body.',
    });

    const composition = composeByokPromptSections(
      [first, second],
      makeContext()
    );

    expect(composition.text).toBe('First body.\n\nSecond body.');
    expect(composition.degradedSectionIds).toEqual([]);
    expect(composition.droppedSectionIds).toEqual([]);
  });

  it('degrades an oversized degradable section to its summary line', () => {
    const bigBody = `Big knowledge header.\n${'x'.repeat(20000)}`;
    const knowledge = makeSection({
      id: 'big-knowledge',
      budgetTokens: 100,
      degradable: true,
      build: () => bigBody,
    });

    const composition = composeByokPromptSections(
      [knowledge],
      makeContext(),
      6000
    );

    // The summary is present, the body is gone.
    expect(composition.text).toContain('Big knowledge header.');
    expect(composition.text).not.toContain('x'.repeat(20000));
    expect(composition.text).toContain('shortened to save context');
    expect(composition.degradedSectionIds).toEqual(['big-knowledge']);
    expect(composition.estimatedTokens).toBeLessThanOrEqual(6000);
  });

  it('drops a section whose summary alone would not fit', () => {
    const knowledge = makeSection({
      id: 'undroppable-summary',
      budgetTokens: 100000,
      degradable: true,
      build: () => `Header.\n${'y'.repeat(20000)}`,
    });

    const composition = composeByokPromptSections(
      [knowledge],
      makeContext(),
      1
    );

    expect(composition.text).toBe('');
    expect(composition.droppedSectionIds).toEqual(['undroppable-summary']);
  });

  it('truncates an oversized non-degradable section instead of dropping it', () => {
    const core = makeSection({
      id: 'big-core',
      priority: 10,
      budgetTokens: 50,
      degradable: false,
      build: () => 'z'.repeat(2000),
    });

    const composition = composeByokPromptSections([core], makeContext(), 6000);

    expect(composition.text).toContain('z'.repeat(50 * BYOK_CHARS_PER_TOKEN));
    expect(composition.text).toContain('[section truncated');
    expect(composition.estimatedTokens).toBeLessThanOrEqual(6000);
  });

  it('respects the budget with many sections registered', () => {
    const sections: Array<ByokKnowledgeSection> = [];
    for (let index = 0; index < 30; index++) {
      sections.push(
        makeSection({
          id: `knowledge-${index}`,
          priority: 200 + index,
          // Each body exceeds its own budget: every section must degrade
          // (or be dropped), never be included in full.
          budgetTokens: 100,
          degradable: true,
          build: () => `Knowledge ${index}.\n${'w'.repeat(8000)}`,
        })
      );
    }

    const composition = composeByokPromptSections(
      sections,
      makeContext(),
      BYOK_SYSTEM_PROMPT_BUDGET_TOKENS
    );

    expect(composition.estimatedTokens).toBeLessThanOrEqual(
      BYOK_SYSTEM_PROMPT_BUDGET_TOKENS
    );
    // Every section is accounted for exactly once.
    expect(
      composition.degradedSectionIds.length +
        composition.droppedSectionIds.length
    ).toBe(30);
  });

  it('skips sections that build to an empty text', () => {
    const empty = makeSection({ id: 'empty', build: () => '' });
    const filled = makeSection({
      id: 'filled',
      priority: 10,
      degradable: false,
      build: () => 'Filled body.',
    });

    const composition = composeByokPromptSections(
      [empty, filled],
      makeContext()
    );

    expect(composition.text).toBe('Filled body.');
    expect(composition.degradedSectionIds).toEqual([]);
  });

  it('keeps a degradable section in full while it fits its own budget', () => {
    const knowledge = makeSection({
      id: 'fits',
      budgetTokens: estimateByokTokens('A short knowledge body.'),
      degradable: true,
      build: () => 'A short knowledge body.',
    });

    const composition = composeByokPromptSections(
      [knowledge],
      makeContext(),
      6000
    );

    expect(composition.text).toBe('A short knowledge body.');
    expect(composition.degradedSectionIds).toEqual([]);
  });
});

describe('ByokKnowledgeSections: summary', () => {
  it('keeps the first non-empty line and points to the full body', () => {
    const summary = summarizeByokSectionText(
      'Game design core.\nLine two.\nLine three.'
    );
    expect(summary.startsWith('Game design core.')).toBe(true);
    expect(summary).toContain('reachable via the skills and tools');
  });
});

describe('ByokKnowledgeSections: core content', () => {
  afterEach(() => {
    resetByokKnowledgeSectionsForTests();
  });

  it('carries the F2 progress discipline in the planning section', () => {
    const planning = getByokKnowledgeSections().find(
      section => section.id === 'planning'
    );
    if (!planning) throw new Error('The planning section is not registered');

    const text = planning.build(makeContext());
    expect(text).toContain('create_or_update_plan');
    expect(text).toContain('one-sentence progress update');
    expect(text).toContain('to-do');
  });

  it('carries the Phase 11 authoring-reach guidance with the real tool names', () => {
    const authoringSection = getByokKnowledgeSections().find(
      section => section.id === 'authoring-reach'
    );
    if (!authoringSection) {
      throw new Error('The authoring-reach section is not registered');
    }

    const text = authoringSection.build(makeContext());
    // The external-scenes guidance paragraph (Phase 11), naming the tools
    // exactly as they are advertised (regression: a garbled
    // "read/add_external_events_source" name once slipped in).
    expect(text).toContain('read_external_events_source/add_external_events');
    expect(text).toContain('describe/put_external_layout_instances');
    expect(text).toContain('list_effects');
    expect(text).toContain('describe_sprite_frames');
    expect(text).toContain('import_project_resources');
    expect(text).toContain('Create objects from external layout');
  });

  it('renders the project notes section only when notes exist', () => {
    const notesSection = getByokKnowledgeSections().find(
      section => section.id === 'project-notes'
    );
    if (!notesSection) throw new Error('The notes section is not registered');

    expect(notesSection.build(makeContext())).toBe('');
    const withNotes = notesSection.build(
      makeContext({
        projectNotes: {
          conventions: 'Use "mob_" prefixes for enemies.',
          inProgress: 'Level 3 boss.',
          decisions: 'Pixel art style.',
          updatedAt: '2026-09-22T10:00:00.000Z',
        },
      })
    );
    expect(withNotes).toContain('Use "mob_" prefixes for enemies.');
    expect(withNotes).toContain('Level 3 boss.');
    expect(withNotes).toContain('Pixel art style.');
  });

  it('renders the skills appendix from the context metadata', () => {
    const skillsSection = getByokKnowledgeSections().find(
      section => section.id === 'skills-appendix'
    );
    if (!skillsSection) throw new Error('The skills section is not registered');

    expect(skillsSection.build(makeContext())).toBe('');
    const withSkills = skillsSection.build(
      makeContext({
        skills: [
          { name: 'platformer-game', description: 'Platformer recipes.' },
        ],
      })
    );
    expect(withSkills).toContain('load_skill');
    expect(withSkills).toContain('- platformer-game: Platformer recipes.');
  });

  it('renders the custom instructions as the very end of the prompt', () => {
    const instructions = 'Always answer in French.';
    const composition = composeByokPromptSections(
      getByokKnowledgeSections(),
      makeContext({ customInstructions: instructions })
    );

    expect(composition.text).toContain('Always answer in French.');
    expect(
      composition.text.trimEnd().endsWith('Always answer in French.')
    ).toBe(true);
  });

  it('builds the tools section from the advertised names only', () => {
    const toolsSection = getByokKnowledgeSections().find(
      section => section.id === 'tools'
    );
    if (!toolsSection) throw new Error('The tools section is not registered');

    const text = toolsSection.build(
      makeContext({ toolNames: BYOK_TOOL_NAMES })
    );
    // Since 13.5 the section lists the NAMES (the schemas ride with the
    // request) and points at search_tools for the rest of the catalog.
    expect(text).toContain('create_scene');
    expect(text).toContain('search_tools');
    expect(text).not.toContain('initialize_project');
    expect(text).not.toContain('- create_scene:');
  });

  it('swaps the project context with the no-project instructions', () => {
    const projectSection = getByokKnowledgeSections().find(
      section => section.id === 'project-context'
    );
    if (!projectSection) {
      throw new Error('The project section is not registered');
    }

    expect(projectSection.build(makeContext())).toContain(
      'inspect before editing'
    );
    expect(projectSection.build(makeContext())).not.toContain(
      'No project is opened'
    );
    expect(
      projectSection.build(makeContext({ hasOpenedProject: false }))
    ).toContain('No project is opened');
  });
});

describe('ByokKnowledgeSections: context factory', () => {
  it('fills every field with a default', () => {
    const context = makeByokPromptContext({
      toolNames: ['create_scene'],
      hasOpenedProject: false,
    });
    expect(context).toEqual({
      toolNames: ['create_scene'],
      hasOpenedProject: false,
      skills: [],
      engineReferenceAvailable: false,
      projectNotes: null,
      customInstructions: '',
    });
  });
});
