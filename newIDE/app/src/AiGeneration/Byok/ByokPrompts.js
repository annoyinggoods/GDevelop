// @flow
import {
  composeByokPromptSections,
  getByokKnowledgeSections,
  makeByokPromptContext,
  type ByokPromptContext,
} from './Knowledge/ByokKnowledgeSections';
// The knowledge modules register their sections at import time — importing
// them here guarantees the composed prompt is complete no matter which
// entry point loads the prompt first.
import './ByokEngineReference';
import './Knowledge/ByokEventScriptPack';
import './Knowledge/ByokGameDesignPack';
import './Knowledge/ByokMathPhysicsPack';
import './Knowledge/ByokJsApiPack';

/**
 * The system prompt of the BYOK agent loop, composed from the registered
 * knowledge sections under a token budget (see Knowledge/ByokKnowledgeSections).
 * GDevelop's own prompts are server-side and unavailable, so BYOK owns this
 * one. Quality here decides BYOK quality.
 *
 * Bump BYOK_AGENT_PROMPT_VERSION whenever a change alters the prompt's
 * behavior, and note it in the worklog. byok-v18 (2026-10-19): the
 * `fit_area_to_children` argument of `change_custom_object_BYOK` (the area
 * of a custom object fitted to its children — the upstream capability the
 * fork's tool was missing). byok-v17 (2026-10-19): the
 * extension authoring tools gained the duplication arguments upstream's
 * tools have (`duplicated_extension_name`, `duplicated_function_name`,
 * `duplicated_custom_object_name`, `duplicated_custom_behavior_name`,
 * `duplicated_from_extension_name`), plus `expression_type` and
 * `getter_name` for the functions. byok-v16 (2026-10-19, upstream
 * sync): the extension authoring tools moved to the `_BYOK` namespace
 * (`create_extension_BYOK` and friends) so they cannot collide with
 * upstream's own extension tools, which use another argument shape and no
 * `event_script` at all. byok-v15 (Phase 19.5): the
 * task-catalog entry that lets `search_tools` surface `import_sprite_sheet`
 * (D19-1 — dispatchable and discoverable, never advertised inline, so the
 * token budget is untouched). byok-v14 (Phases 17.7 + 18.3): the
 * asset-tag and guardrail lines in the retrieval map plus the two
 * task-catalog entries that let `search_tools` surface `list_assets`,
 * `set_asset_tags` and `scan_scene_events` (D17-10/D18-6 — dispatchable and
 * discoverable, never advertised inline, so the token budget is untouched).
 * byok-v13 (Phase 16.5): the build-size
 * line in the retrieval map plus the task-catalog entry that let
 * `search_tools` surface `report_asset_optimization` and
 * `set_asset_optimization_settings` (D16-9 — the two tools are dispatchable
 * and discoverable, but never advertised inline, so the token budget is
 * untouched). byok-v12 (Phase 15.3): the
 * game-code section (the `<GameName>Code/` folder next to the project, its
 * D15-3a load order, the GameCode.* namespace and the classic-script rule)
 * joined the always-on prompt, with the five game-code tools. byok-v11
 * (audit011026): the
 * read_doc_page tool (the docs-min drill-down), the corrected EventScript
 * examples and the external-events wording. byok-v10 (Phase 14): the
 * retrieval map gained the minified-wiki drill-down line (category maps →
 * page chunks → read_doc_page, D14-2) and the system prompt became
 * snapshot-once per chat for provider prefix caching (14.1 — identical
 * bytes within a chat). byok-v9 (Phase 13): the tiered tool
 * advertisement (core list inline, the rest via the search_tools meta-tool),
 * the retrieval map + task catalog, and the pinned EventScript block (13.6).
 * byok-v8 (Phase 12): discovery and runtime — the starter-catalog guidance
 * in the no-project section, the store-search and runtime-steering lines in
 * the authoring-reach section, read_project_notes and the seven new tools
 * in the tool list. byok-v7 (Phase 11): the authoring-reach section
 * (external events & layouts, effects catalog, sprite internals, resource
 * import) and the eight new tools in the tool list. byok-v6 (Phase 8): the
 * single-agent section became the agents policy (scout/reviewer delegation,
 * completion rules, skill pointers). byok-v5 (Phase 7): section composer
 * with a token budget + the F2 progress discipline in the planning section.
 */
export const BYOK_AGENT_PROMPT_VERSION: string = 'byok-v18';

/**
 * Build the system prompt of the BYOK agent loop. The signature keeps the
 * two original options (they win over the context, so the advertised tools
 * always match the schemas sent with the turn); the optional `context`
 * carries the enrichments (skills metadata, knowledge flags, project notes,
 * custom instructions) — absent, the defaults are used.
 */
export const buildByokSystemPrompt = (options: {|
  toolNames: Array<string>,
  hasOpenedProject: boolean,
  context?: ByokPromptContext,
|}): string => {
  const promptContext: ByokPromptContext = options.context
    ? {
        ...options.context,
        toolNames: options.toolNames,
        hasOpenedProject: options.hasOpenedProject,
      }
    : makeByokPromptContext({
        toolNames: options.toolNames,
        hasOpenedProject: options.hasOpenedProject,
      });

  const composition = composeByokPromptSections(
    getByokKnowledgeSections(),
    promptContext
  );
  console.info(
    `BYOK system prompt (${BYOK_AGENT_PROMPT_VERSION}): ~${
      composition.estimatedTokens
    } tokens, ${composition.degradedSectionIds.length} section(s) degraded.`
  );
  return composition.text;
};
