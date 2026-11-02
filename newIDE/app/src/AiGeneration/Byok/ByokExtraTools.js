// @flow
import {
  type ExternalLayoutOutsideEditorChanges,
  type ExternalEventsOutsideEditorChanges,
} from '../../EditorFunctions/OutsideEditorChanges';
import {
  byokApplySceneEventBatches,
  type ByokEventBatch,
} from './ByokLocalEventWriter';
import { makeByokRuntimeTools } from './ByokRuntimeTools';
import type { ByokRuntimeToolDeps } from './ByokRuntimeTools';
import { getByokDebuggerTools } from './ByokDebuggerTools';
// Importing the engine reference module also registers its always-on
// cheat-sheet knowledge section.
import { searchByokEngineReference } from './ByokEngineReference';
import { searchByokToolSchemas } from './ByokToolSchema';
import { findByNameokSkill, listByokSkillMetadata } from './ByokSkills';
import {
  getByokRagSearchDepsAsync,
  searchByokRagKnowledge,
} from './Rag/ByokRagSearch';
import {
  searchByokDocs,
  readByokDocPage,
  listByokBundledDocPages,
} from './ByokDocs';
import {
  listByokMinifiedDocCategories,
  readByokMinifiedDocPage,
} from './ByokMinifiedDocs';
import {
  loadByokProjectNotes,
  mergeByokProjectNotes,
  saveByokProjectNotes,
} from './ByokProjectNotes';
import type { ByokSubAgentKind, ByokSubAgentRunResult } from './ByokSubAgents';
import { getByokExtensionTools } from './ByokExtensionTools';
import { getByokExternalSceneTools } from './ByokExternalSceneTools';
import { getByokCatalogTools } from './ByokCatalogTools';
import { getByokSpriteTools } from './ByokSpriteTools';
import { getByokResourceTools } from './ByokResourceTools';
import { getByokGameCodeTools } from './GameCode/ByokGameCodeTools';
import { getByokAssetTools } from './ByokAssetTools';
import { getByokGuardrailTools } from './ByokGuardrailTools';
import { getByokSpriteSheetTools } from './ByokSpriteSheetTools';
import {
  getByokProjectSnapshot,
  listByokProjectSnapshots,
  restoreByokProjectFromSnapshot,
} from './ByokFork';

/**
 * The BYOK interception registry: tools the orchestrator resolves itself,
 * BEFORE the editor registry lookup — either because the registry
 * implementation would call GDevelop's backend (add_scene_events posts to
 * the event-generation job upstream; the BYOK implementation in
 * ByokLocalEventWriter is fully client-side), because the name only
 * exists as an alias a model may emit out of hosted-agent habit
 * (generate_events), or because the result must be shaped before the model
 * reads it (run_gameplay_test screenshots, Phase 6).
 */

/** Everything an intercepted tool may need from its host. */
export type ByokExtraToolCollaborators = {|
  // The live project, read at call time (a chat can create its project
  // mid-flight — see the getter injection in AskAiEditorContainer).
  getProject: () => any,
  onSceneEventsModifiedOutsideEditor: (changes: any) => void,
  // Fired by tools that mutate objects directly (sprite frames): the same
  // payload the registry tools send, so open editors redraw. Optional —
  // hosts without it still apply the changes.
  onObjectsModifiedOutsideEditor?: (changes: any) => void,
  // The resources loader, when the host has one: the tools that MEASURE
  // something (the area of a custom object fitted to its children) need it
  // to read a 3D model file. Optional: without it, a 3D model is not
  // measured and the measurement is refused rather than guessed.
  getPixiResourcesLoader?: () => any,
  // Fired by the external-items tools (put_external_layout_instances,
  // add_external_events) so an already-open editor of that item redraws —
  // the fan-out channel these items never had (scenes key on their
  // gdLayout, which external items don't have). Optional: hosts without
  // the MainFrame fan-out (the standalone form) still apply the changes.
  onExternalLayoutModifiedOutsideEditor?: (
    changes: ExternalLayoutOutsideEditorChanges
  ) => void,
  onExternalEventsModifiedOutsideEditor?: (
    changes: ExternalEventsOutsideEditorChanges
  ) => void,
  // The perception tools' dependencies (screenshots, previews, the image
  // pipeline, single registry calls) — absent in environments without
  // them, where the tools answer with actionable failures.
  runtimeDeps?: ByokRuntimeToolDeps,
  // The user's "online docs expansion" setting (Phase 7.7): when true,
  // read_doc may fetch pages that are not bundled.
  onlineDocsEnabled?: boolean,
  // The storage identifier of the open project's notes (Phase 7.8): the
  // file identifier of the project, or a name-hash fallback. Null while no
  // project is open.
  getProjectNotesIdentifier?: () => string | null,
  // The sub-agent runner of the parent chat (Phase 8.1). ABSENT inside a
  // sub-agent's own orchestrator: that is the structural nesting guard —
  // the tools then answer with a refusal instead of delegating.
  runSubAgent?: (options: {|
    kind: ByokSubAgentKind,
    instructions: string,
  |}) => Promise<ByokSubAgentRunResult>,
  // The extension regeneration hooks (Phase 8.4): the editor context's
  // reload functions, flushed ONCE PER BATCH of extension tool calls (see
  // flushByokExtensionRegeneration). Absent in hosts without them: the
  // changes still apply, but the editor only picks them up at its next
  // reload.
  reloadEventsFunctionsExtensions?: (project: any) => Promise<void>,
  reloadEventsFunctionsExtensionMetadata?: (
    project: any,
    extension: any
  ) => void,
  // The id of the BYOK chat whose batch this is (Phase 8.6): the
  // restore-point tool keys the snapshot store on it.
  byokChatId?: string,
|};

export type ByokExtraToolResult = {|
  // The tool output serialized to the model, mirroring the editor runner's
  // `{success, message, …}` shape.
  output: Object,
  // True when the call changed the project (approval gating and unsaved
  // changes rely on it).
  didModifyProject: boolean,
  // The image ids the output references (materialized at replay time —
  // see ByokTranscript).
  images?: Array<string>,
|};

export type ByokExtraTool = {|
  name: string,
  // Whether running this tool modifies the project — the static flag the
  // host's approval decision reads for the tools that exist ONLY here (the
  // ones that also live in the editor registry keep their registry-side,
  // sometimes per-arguments decision).
  modifiesProject: boolean,
  run: (
    args: Object,
    collaborators: ByokExtraToolCollaborators
  ) => Promise<ByokExtraToolResult>,
|};

/**
 * Read the batches argument defensively: it is model-provided JSON, so a
 * wrong shape must degrade into a failure output, never a crash.
 */
const readEventBatches = (args: Object): Array<ByokEventBatch> => {
  if (!Array.isArray(args.event_batches)) return [];
  return args.event_batches.map(batch =>
    batch && typeof batch === 'object' ? batch : {}
  );
};

/**
 * add_scene_events and its hosted alias generate_events: one shared
 * implementation writing the events locally.
 */
const makeLocalEventWritingTool = (name: string): ByokExtraTool => ({
  name,
  modifiesProject: true,
  run: async (args, collaborators) => {
    const output = byokApplySceneEventBatches({
      project: collaborators.getProject(),
      sceneName: typeof args.scene_name === 'string' ? args.scene_name : '',
      eventBatches: readEventBatches(args),
      onSceneEventsModifiedOutsideEditor:
        collaborators.onSceneEventsModifiedOutsideEditor,
    });
    return { output, didModifyProject: output.success };
  },
});

/**
 * search_reference: query the generated engine reference catalog, so the
 * model can look up the exact name and parameters of any instruction,
 * object, behavior or expression instead of guessing them. Results are
 * compacted (descriptions trimmed, parameters capped) so the 40-entry cap
 * stays well under the tool-output budget.
 */
const compactReferenceEntry = (entry: {
  kind: string,
  owner: string,
  name: string,
  description: string,
  parameters: Array<{| type: string, description: string |}>,
}) => ({
  kind: entry.kind,
  owner: entry.owner,
  name: entry.name,
  description:
    entry.description.length > 200
      ? `${entry.description.slice(0, 200)}…`
      : entry.description,
  parameters: entry.parameters.slice(0, 8).map(parameter => ({
    type: parameter.type,
    description:
      parameter.description.length > 80
        ? `${parameter.description.slice(0, 80)}…`
        : parameter.description,
  })),
});

const readOptionalString = (value: mixed): string | void =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const makeSearchReferenceTool = (): ByokExtraTool => ({
  name: 'search_reference',
  modifiesProject: false,
  run: async args => {
    const result = searchByokEngineReference({
      query: typeof args.query === 'string' ? args.query : '',
      kind: readOptionalString(args.kind),
      owner: readOptionalString(args.owner),
    });
    if (!result.available) {
      return {
        output: {
          success: false,
          message:
            'The engine reference is not available in this environment. Rely on the read tools to discover what the project supports.',
        },
        didModifyProject: false,
      };
    }
    const lines = [
      result.entries.length === 0
        ? 'No entry matched the query. Try a shorter or more general query.'
        : `${result.totalMatches} match(es), showing ${result.entries.length}:`,
    ];
    if (result.steeringLine) lines.push(result.steeringLine);
    return {
      output: {
        success: true,
        message: lines.join(' '),
        entries: result.entries.map(compactReferenceEntry),
      },
      didModifyProject: false,
    };
  },
});

/**
 * load_skill: the on-demand level of the skills system — the body becomes a
 * tool output, which stays in the conversation (it is never re-loaded per
 * turn). An unknown name lists what is available so the model can correct
 * itself.
 */
const makeLoadSkillTool = (): ByokExtraTool => ({
  name: 'load_skill',
  modifiesProject: false,
  run: async args => {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) {
      return {
        output: {
          success: false,
          message: 'The "name" of the skill to load is required.',
        },
        didModifyProject: false,
      };
    }
    const skill = await findByNameokSkill(name);
    if (!skill) {
      const skills = await listByokSkillMetadata();
      return {
        output: {
          success: false,
          message: `No skill named "${name}". Available skills: ${skills
            .map(skill => skill.name)
            .join(', ') || '(none)'}.`,
        },
        didModifyProject: false,
      };
    }
    return {
      output: {
        success: true,
        message: `Skill "${
          skill.name
        }" loaded — its instructions stay available for the rest of the conversation.`,
        skill: { name: skill.name, body: skill.body },
      },
      didModifyProject: false,
    };
  },
});

/**
 * search_docs: the bundled documentation subset (see ByokDocs.js), searched
 * as plain substrings. Returns page paths + titles; read_doc reads them.
 */
const makeSearchDocsTool = (): ByokExtraTool => ({
  name: 'search_docs',
  modifiesProject: false,
  run: async args => {
    const query = typeof args.query === 'string' ? args.query : '';
    const { results, truncated } = searchByokDocs(query);
    const lines = results.map(
      result =>
        `- ${result.path} — ${result.title} (matched in ${result.matchedIn})`
    );
    if (truncated) {
      lines.push(
        `Showing the first ${
          results.length
        } matches — make the query more specific to narrow them.`
      );
    }
    return {
      output: {
        success: true,
        message:
          results.length === 0
            ? 'No documentation page matched. Try a more general query.'
            : `${results.length} page(s) found. Read one with read_doc.`,
        pages: lines,
      },
      didModifyProject: false,
    };
  },
});

/**
 * read_doc: one bundled (or, when the user enabled it, online-cached)
 * documentation page, capped, optionally sliced to one section.
 */
const makeReadDocTool = (): ByokExtraTool => ({
  name: 'read_doc',
  modifiesProject: false,
  run: async (args, collaborators) => {
    const page = typeof args.page === 'string' ? args.page.trim() : '';
    if (!page) {
      return {
        output: {
          success: false,
          message:
            'The "page" to read is required (a path from search_docs, e.g. "events/index.md").',
        },
        didModifyProject: false,
      };
    }
    const result = await readByokDocPage(page, {
      anchor: readOptionalString(args.anchor),
      onlineEnabled: !!collaborators.onlineDocsEnabled,
    });
    return {
      output: {
        success: result.found,
        message:
          result.origin === 'bundled'
            ? `Read from the bundled docs.`
            : result.origin === 'cache'
            ? 'Read from the local cache of the online docs.'
            : result.content,
        page: result.path,
        title: result.title,
        content: result.content,
        truncated: result.truncated,
        bundledPages: result.found
          ? undefined
          : listByokBundledDocPages().map(p => p.path),
      },
      didModifyProject: false,
    };
  },
});

/**
 * update_project_notes: the model's persistent memory of the project.
 * Merge semantics (absent field = unchanged), capped storage, and an
 * explicit answer when no project is open.
 */
const makeUpdateProjectNotesTool = (): ByokExtraTool => ({
  name: 'update_project_notes',
  modifiesProject: false,
  run: async (args, collaborators) => {
    const identifier =
      collaborators.getProjectNotesIdentifier &&
      collaborators.getProjectNotesIdentifier();
    if (!identifier) {
      return {
        output: {
          success: false,
          message:
            'No project is open: the notes are written once a project exists (initialize_project creates one).',
        },
        didModifyProject: false,
      };
    }
    const existing = await loadByokProjectNotes(identifier);
    const merged = mergeByokProjectNotes(existing, {
      conventions:
        typeof args.conventions === 'string' ? args.conventions : undefined,
      inProgress:
        typeof args.inProgress === 'string' ? args.inProgress : undefined,
      decisions:
        typeof args.decisions === 'string' ? args.decisions : undefined,
    });
    const saved = await saveByokProjectNotes(identifier, merged);
    if (!saved) {
      return {
        output: {
          success: false,
          message:
            'The notes are too large to save. Shorten them (each field is capped, keep only what future chats must know).',
        },
        didModifyProject: false,
      };
    }
    return {
      output: {
        success: true,
        message:
          'Project notes updated — they will be visible in future chats.',
        notes: merged,
      },
      didModifyProject: false,
    };
  },
});

/**
 * read_project_notes (Phase 12): the read side of the per-project memory —
 * the merged notes of the chat's project, the same content the MCP
 * notes resource serves. update_project_notes stays the only writer.
 */
const makeReadProjectNotesTool = (): ByokExtraTool => ({
  name: 'read_project_notes',
  modifiesProject: false,
  run: async (args, collaborators) => {
    const identifier =
      collaborators.getProjectNotesIdentifier &&
      collaborators.getProjectNotesIdentifier();
    if (!identifier) {
      return {
        output: {
          success: false,
          message: 'No project is open: there are no notes to read yet.',
        },
        didModifyProject: false,
      };
    }
    const notes = await loadByokProjectNotes(identifier);
    return {
      output: {
        success: true,
        message:
          notes.conventions || notes.inProgress || notes.decisions
            ? 'The notes of this project.'
            : 'The notes of this project are empty — nothing was recorded yet.',
        notes,
      },
      didModifyProject: false,
    };
  },
});

/**
 * search_tools (Phase 13.5): the meta-tool of the tiered advertisement.
 * The system prompt lists the core tools only; this one searches the WHOLE
 * catalog and returns each match with its full parameter schema — so a
 * discovered tool can be called on the very next turn (the executor knows
 * every tool; only the schema injection needed the search). `tools/list`
 * over MCP stays full: external clients are not budget-bound.
 */
const makeSearchToolsTool = (): ByokExtraTool => ({
  name: 'search_tools',
  modifiesProject: false,
  run: async args => {
    const query = typeof args.query === 'string' ? args.query : '';
    if (!query.trim()) {
      return {
        output: {
          success: false,
          message:
            'The "query" is required — keywords about what you want to do, e.g. "external layout", "sprite points", "asset store".',
        },
        didModifyProject: false,
      };
    }
    const matches = searchByokToolSchemas(query);
    if (matches.length === 0) {
      return {
        output: {
          success: false,
          message: `No tool matched "${query}". Try other keywords — the catalog covers scenes, objects, sprites, events, external layouts, extensions, assets, resources, effects, previews and runtime debugging.`,
        },
        didModifyProject: false,
      };
    }
    return {
      output: {
        success: true,
        message: `${
          matches.length
        } tool(s) matched "${query}". Their full schemas follow — call them directly.`,
        tools: matches.map(schema => ({
          name: schema.name,
          description: schema.description,
          parameters: schema.parameters,
        })),
      },
      didModifyProject: false,
    };
  },
});

/**
 * search_knowledge (Phase 13.7): grep-the-docs retrieval over the full
 * on-device corpus (engine reference, bundled docs, skills, EventScript
 * examples) — exact/tag search always, semantic ranking once the RAG index
 * is built. Everything stays on the machine (D13-9).
 */
const makeSearchKnowledgeTool = (): ByokExtraTool => ({
  name: 'search_knowledge',
  modifiesProject: false,
  run: async args => {
    const tags = Array.isArray(args.tags)
      ? args.tags.filter((tag: any) => typeof tag === 'string' && !!tag)
      : null;
    const result = await searchByokRagKnowledge({
      query: typeof args.query === 'string' ? args.query : '',
      tags: tags && tags.length > 0 ? tags : null,
      kind: readOptionalString(args.kind),
      nearChunkId: readOptionalString(args.chunk_id),
      deps: await getByokRagSearchDepsAsync(),
    });
    return {
      output: {
        success: result.success,
        message: result.message,
        mode: result.mode,
        chunks: result.hits.map(hit => ({
          id: hit.chunk.id,
          source: hit.chunk.source,
          title: hit.chunk.title,
          tags: hit.chunk.tags.slice(0, 6),
          match: hit.match,
          text:
            hit.chunk.text.length > 1500
              ? `${hit.chunk.text.slice(0, 1500)}…`
              : hit.chunk.text,
        })),
      },
      didModifyProject: false,
    };
  },
});

/**
 * The sub-agent delegation tools (Phase 8.1): `run_explorer_agent` (the
 * scout — same name as the hosted tool, so models porting the habit work)
 * and `run_review_agent`. Both resolve here BEFORE the editor registry,
 * whose implementations are server stubs. They never modify the project;
 * a missing runner (nested call, or a host without sub-agents) is a
 * refusal, never a crash.
 */
const makeSubAgentTool = (
  name: string,
  kind: ByokSubAgentKind
): ByokExtraTool => ({
  name,
  modifiesProject: false,
  run: async (args, collaborators) => {
    if (!collaborators.runSubAgent) {
      return {
        output: {
          success: false,
          message:
            'Sub-agents cannot be nested: do the work yourself with your own tools.',
        },
        didModifyProject: false,
      };
    }
    const instructions =
      typeof args.instructions === 'string' ? args.instructions : '';
    const result = await collaborators.runSubAgent({ kind, instructions });
    return {
      output: {
        success: result.success,
        agent_kind: result.kind,
        summary: result.summary,
        transcript_id: result.transcriptId,
      },
      didModifyProject: false,
    };
  },
});

/**
 * restore_project_point (Phase 8.6): rewind the project to the snapshot
 * taken before a message of this chat. Approval-gated (it overwrites the
 * current project) — the static flag says so.
 */
const makeRestoreProjectPointTool = (): ByokExtraTool => ({
  name: 'restore_project_point',
  modifiesProject: true,
  run: async (args, collaborators) => {
    const project = collaborators.getProject();
    if (!project) {
      return {
        output: {
          success: false,
          message: 'No project is open: there is nothing to restore.',
        },
        didModifyProject: false,
      };
    }
    const chatId = collaborators.byokChatId || '';
    const messageId =
      typeof args.message_id === 'string' ? args.message_id : '';
    const snapshot = chatId ? getByokProjectSnapshot(chatId, messageId) : null;
    if (!snapshot) {
      const available = chatId
        ? listByokProjectSnapshots(chatId)
            .map(item => item.messageId)
            .join(', ')
        : '(none)';
      return {
        output: {
          success: false,
          message: `No restore point for message "${messageId}" of this chat. Available restore points: ${available ||
            '(none)'}.`,
        },
        didModifyProject: false,
      };
    }
    try {
      restoreByokProjectFromSnapshot(project, snapshot);
    } catch (error) {
      return {
        output: {
          success: false,
          message: `The restore failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
        didModifyProject: false,
      };
    }
    return {
      output: {
        success: true,
        message: `Project restored to the state saved before message "${messageId}". The current conversation continues; read the project state before editing further.`,
      },
      didModifyProject: true,
    };
  },
});

/**
 * read_doc_page (audit011026 B-PROMPT-1): the FULL page behind a docs-min
 * chunk — the whole gdevelop5 wiki, minified, bundled OFFLINE with the app
 * (Phase 14.2). Every docs-min chunk ends with
 * `Full page: read_doc_page('<path>')`; until this tool existed that hint
 * pointed at a tool that was never registered, and the wiki drill-down
 * died in a refusal.
 */
const BYOK_DOC_PAGE_MAX_CHARS = 12000;

const makeReadDocPageTool = (): ByokExtraTool => ({
  name: 'read_doc_page',
  modifiesProject: false,
  run: async (args): Promise<ByokExtraToolResult> => {
    const pagePath = typeof args.path === 'string' ? args.path.trim() : '';
    if (!pagePath) {
      return {
        output: {
          success: false,
          message:
            'The "path" is required — the path a docs-min chunk suggested, or find one with search_knowledge (tags: ["docs-min"]).',
        },
        didModifyProject: false,
      };
    }
    const page = readByokMinifiedDocPage(pagePath);
    if (!page) {
      return {
        output: {
          success: false,
          message: `No wiki page at "${pagePath}". Categories: ${listByokMinifiedDocCategories().join(
            ', '
          )}. Find the right path with search_knowledge (tags: ["docs-min"]).`,
        },
        didModifyProject: false,
      };
    }
    const fullBody = `${page.summary}

${page.body}`;
    const truncated = fullBody.length > BYOK_DOC_PAGE_MAX_CHARS;
    return {
      output: {
        success: true,
        message: `Wiki page "${page.title}" (${page.category}).`,
        path: page.path,
        title: page.title,
        category: page.category,
        tags: page.tags,
        truncated,
        content: truncated
          ? `${fullBody.slice(0, BYOK_DOC_PAGE_MAX_CHARS)}…`
          : fullBody,
      },
      didModifyProject: false,
    };
  },
});

const BYOK_EXTRA_TOOLS: Array<ByokExtraTool> = [
  makeLocalEventWritingTool('add_scene_events'),
  makeLocalEventWritingTool('generate_events'),
  makeSearchReferenceTool(),
  makeLoadSkillTool(),
  makeSearchDocsTool(),
  makeReadDocTool(),
  makeReadDocPageTool(),
  makeSearchToolsTool(),
  makeSearchKnowledgeTool(),
  makeUpdateProjectNotesTool(),
  makeReadProjectNotesTool(),
  makeSubAgentTool('run_explorer_agent', 'scout'),
  makeSubAgentTool('run_review_agent', 'reviewer'),
  makeRestoreProjectPointTool(),
  ...makeByokRuntimeTools(),
  // Events-based extension authoring (Phase 8.4), ported from the upstream
  // v18 branch and driving libGD directly.
  ...getByokExtensionTools(),
  // External events & external layouts (Phase 11): dedicated tools over the
  // same EventScript and instance pipelines the scene tools use.
  ...getByokExternalSceneTools(),
  // Catalogs (Phase 11): the effect-type catalog; grows in Phase 12 with the
  // public starter/asset/resource store catalogs.
  ...getByokCatalogTools(),
  // Sprite internals (Phase 11): animations/directions/frames, points and
  // collision masks of Sprite objects.
  ...getByokSpriteTools(),
  // Resource import/replace (Phase 11): URL / absolute path / in-project
  // sources, desktop-only.
  ...getByokResourceTools(),
  // Debugger/profiler tools (Phase 12): pause, dump and profile the preview
  // this chat launched — targeted, never cross-preview.
  ...getByokDebuggerTools(),
  // Game code (Phase 15.3): read/write/delete/list over the game code
  // folder (`<GameName>Code/`), plus the hot-reload router. Writes and
  // deletes re-sync the carrier extension themselves.
  ...getByokGameCodeTools(),
  // Build-time asset optimization (Phase 16.5, D16-9) + tag-driven asset
  // management (Phase 17.7, D17-10): the savings projection, the export
  // settings, and the asset tag read/write surface. Thin adapters over
  // Fork/AssetBuild and Fork/AssetPipeline — advertised only through
  // search_tools, never in the core set.
  ...getByokAssetTools(),
  // Event-sheet guardrails (Phase 18.3, D18-6): the read-only trap report
  // (Once-in-loop, Wait-in-loop, unpicked actions, duplicate Once) the
  // events sheet also shows as inline badges. Thin adapter over
  // Fork/Guardrails — advertised only through search_tools.
  ...getByokGuardrailTools(),
  // Sprite-sheet import (Phase 19.5, D19-1): slice one local image along an
  // explicit grid into frame files + a new animation of a Sprite object.
  // Thin adapter over Fork/SpriteSheet — desktop-guarded by the handler,
  // approval-gated (it writes the project), advertised only through
  // search_tools.
  ...getByokSpriteSheetTools(),
];

/** All the intercepted tools (a fresh read: the list may grow per phase). */
export const getByokExtraTools = (): Array<ByokExtraTool> =>
  BYOK_EXTRA_TOOLS.slice();

/** The intercepted tool of this name, or null when the name is not one. */
export const findByNameokExtraTool = (name: string): ByokExtraTool | null => {
  return BYOK_EXTRA_TOOLS.find(tool => tool.name === name) || null;
};
