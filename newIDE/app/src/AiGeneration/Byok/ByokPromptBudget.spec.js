// @flow
/**
 * The Phase 13.5 budget guard: the advertised tool schemas + the composed
 * system prompt together must fit the owner's directive — an 8–10k token
 * target, a 15k hard cap (D13-6). The estimate is the char/4 baseline the
 * composer uses; the exact number is printed in every failure message so a
 * budget blow-up is debuggable in one look.
 */
import { buildByokSystemPrompt } from './ByokPrompts';
import {
  BYOK_TASK_CATALOG,
  makeByokPromptContext,
} from './Knowledge/ByokKnowledgeSections';
import {
  getByokAdvertisedToolNames,
  getByokToolSchemasForNames,
  searchByokToolSchemas,
  toOpenAiToolsFormat,
} from './ByokToolSchema';
import { searchByokEngineReference } from './ByokEngineReference';
import { findByNameokSkill, listByokSkillMetadata } from './ByokSkills';

const BYOK_BUDGET_WARNING_TOKENS = 10000;
const BYOK_BUDGET_HARD_CAP_TOKENS = 15000;

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * Where the prompt's tokens actually go: each knowledge section at FULL size
 * (not the degraded version the budget keeps), plus the biggest tool schemas.
 * Printed with the over-budget warning so the next slimming decision starts
 * from measurements instead of guesses (the 8-10k aim of D13-6 has been open
 * since Phase 13 for want of this).
 */
const reportLargestPromptParts = (): string => {
  const {
    getByokKnowledgeSections,
  } = require('./Knowledge/ByokKnowledgeSections');
  const sections = getByokKnowledgeSections()
    .map(section => ({
      id: section.id,
      tokens: estimateTokens(
        section.build(
          makeByokPromptContext({ toolNames: [], hasOpenedProject: true })
        )
      ),
    }))
    .sort((first, second) => second.tokens - first.tokens)
    .slice(0, 6)
    .map(section => `    ${section.id}: ${section.tokens}`);
  const toolSchemas = getByokToolSchemasForNames(
    getByokAdvertisedToolNames({ hasOpenedProject: true })
  )
    .map(schema => ({
      name: schema.name,
      tokens: estimateTokens(JSON.stringify(schema)),
    }))
    .sort((first, second) => second.tokens - first.tokens)
    .slice(0, 6)
    .map(schema => `    tool ${schema.name}: ${schema.tokens}`);
  return [
    '  largest prompt sections (full size):',
    ...sections,
    '  largest tool schemas:',
    ...toolSchemas,
  ].join('\n');
};

describe('ByokPromptBudget (Phase 13.5)', () => {
  const measureTurn = async (hasOpenedProject: boolean) => {
    const advertisedNames = getByokAdvertisedToolNames({ hasOpenedProject });
    const skills = await listByokSkillMetadata();
    // audit011026 B-PROMPT-8: the worst case includes the auto-suggested
    // build-workflow body (capped at the orchestrator's constant) and a
    // max-size notes payload — both ride inside the frozen system prompt.
    const buildWorkflowSkill = await findByNameokSkill('build-workflow');
    const autoSuggestSuffix = buildWorkflowSkill
      ? `

[Auto-loaded skill: build-workflow — its pipeline applies to this conversation]
${buildWorkflowSkill.body.slice(0, 6000)}`
      : '';
    const systemPrompt =
      buildByokSystemPrompt({
        toolNames: advertisedNames,
        hasOpenedProject,
        context: makeByokPromptContext({
          toolNames: advertisedNames,
          hasOpenedProject,
          skills,
          engineReferenceAvailable: true,
          projectNotes: {
            conventions: 'c'.repeat(1200),
            inProgress: 'i'.repeat(1200),
            decisions: 'd'.repeat(1200),
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
          customInstructions: 'a'.repeat(2000),
        }),
      }) + autoSuggestSuffix;
    const toolsJson = JSON.stringify(
      toOpenAiToolsFormat(getByokToolSchemasForNames(advertisedNames))
    );
    return {
      advertisedNames,
      systemPrompt,
      systemPromptTokens: estimateTokens(systemPrompt),
      toolsTokens: estimateTokens(toolsJson),
      totalTokens: estimateTokens(systemPrompt) + estimateTokens(toolsJson),
    };
  };

  it('keeps the advertised tools + system prompt under the 15k hard cap (project open)', async () => {
    const measurement = await measureTurn(true);
    if (measurement.totalTokens > BYOK_BUDGET_WARNING_TOKENS) {
      console.warn(
        `BYOK prompt budget above the 8-10k target: ${
          measurement.totalTokens
        } tokens ` +
          `(prompt ${measurement.systemPromptTokens} + tools ${
            measurement.toolsTokens
          }, ` +
          `${measurement.advertisedNames.length} advertised tools).\n` +
          reportLargestPromptParts()
      );
    }
    expect(measurement.totalTokens).toBeLessThanOrEqual(
      BYOK_BUDGET_HARD_CAP_TOKENS
    );
  });

  it('keeps the advertised tools + system prompt under the 15k hard cap (no project)', async () => {
    const measurement = await measureTurn(false);
    expect(measurement.totalTokens).toBeLessThanOrEqual(
      BYOK_BUDGET_HARD_CAP_TOKENS
    );
  });

  it('carries the minified-wiki drill-down hint line in the retrieval map (Phase 14.2)', async () => {
    // One degradable hint line teaches the map → page chunks →
    // read_doc_page drill-down; it must survive inside the budget (the
    // two cap tests above prove the totals, this one proves the line).
    const measurement = await measureTurn(true);
    expect(measurement.systemPrompt).toContain('docs-min');
    expect(measurement.systemPrompt).toContain('read_doc_page');
    expect(measurement.systemPrompt).toContain('tags: ["map"]');
  });

  it('carries the build-size line that teaches the asset tools (Phase 16.5)', async () => {
    // The asset-optimization tools are dispatchable but NOT advertised
    // inline (D16-9): the retrieval map's build-size line is what lets a
    // model find them through search_tools, so it must survive the budget.
    const measurement = await measureTurn(true);
    expect(measurement.systemPrompt).toContain('report_asset_optimization');
    expect(measurement.systemPrompt).toContain(
      'set_asset_optimization_settings'
    );
  });

  it('advertises the core set, not the whole catalog', async () => {
    const measurement = await measureTurn(true);
    // The core list + search_tools: far below the full 63-tool catalog.
    expect(measurement.advertisedNames.length).toBeLessThan(40);
    expect(measurement.advertisedNames).toContain('search_tools');
    expect(measurement.advertisedNames).not.toContain('list_effects');
  });

  it('adds the no-project tools only without a project', () => {
    const withProject = getByokAdvertisedToolNames({ hasOpenedProject: true });
    const withoutProject = getByokAdvertisedToolNames({
      hasOpenedProject: false,
    });
    expect(withProject).not.toContain('initialize_project');
    expect(withoutProject).toContain('initialize_project');
    expect(withoutProject).toContain('get_game_starter_summary');
  });
});

describe('ByokPromptBudget: the task catalog resolves (13.5)', () => {
  it('names only real skills', async () => {
    const skills = await listByokSkillMetadata();
    const skillNames = new Set(skills.map(skill => skill.name));
    const entriesWithSkill = BYOK_TASK_CATALOG.filter(
      entry => !!entry.skillName
    );
    expect(entriesWithSkill.length).toBeGreaterThanOrEqual(10);
    for (const entry of entriesWithSkill) {
      expect(skillNames.has((entry.skillName: any))).toBe(true);
    }
  });

  it('returns tools for every toolQuery of the catalog', () => {
    const entriesWithToolQuery = BYOK_TASK_CATALOG.filter(
      entry => !!entry.toolQuery
    );
    expect(entriesWithToolQuery.length).toBeGreaterThanOrEqual(5);
    for (const entry of entriesWithToolQuery) {
      const matches = searchByokToolSchemas((entry.toolQuery: any));
      expect(matches.length).toBeGreaterThan(0);
    }
  });

  it('returns reference entries for every referenceQuery of the catalog', () => {
    const entriesWithReferenceQuery = BYOK_TASK_CATALOG.filter(
      entry => !!entry.referenceQuery
    );
    expect(entriesWithReferenceQuery.length).toBeGreaterThanOrEqual(3);
    for (const entry of entriesWithReferenceQuery) {
      const result = searchByokEngineReference({
        query: (entry.referenceQuery: any),
      });
      expect(result.available).toBe(true);
      expect(result.entries.length).toBeGreaterThan(0);
    }
  });
});

describe('searchByokToolSchemas (the search_tools engine)', () => {
  it('finds an exact tool name first', () => {
    const matches = searchByokToolSchemas('list_effects');
    expect(matches[0].name).toBe('list_effects');
  });

  it('finds tools by concept keywords', () => {
    const spriteMatches = searchByokToolSchemas('sprite animation');
    expect(spriteMatches.some(schema => schema.name.includes('sprite'))).toBe(
      true
    );
    const storeMatches = searchByokToolSchemas('asset store');
    expect(storeMatches.map(schema => schema.name)).toContain(
      'search_object_asset_store'
    );
  });

  it('returns nothing for a nonsense query, capped results otherwise', () => {
    expect(searchByokToolSchemas('zzzznope')).toEqual([]);
    expect(searchByokToolSchemas('the').length).toBeLessThanOrEqual(10);
    expect(searchByokToolSchemas('')).toEqual([]);
  });
});
