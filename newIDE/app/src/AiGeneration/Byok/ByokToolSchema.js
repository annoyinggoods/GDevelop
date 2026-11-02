// @flow
import {
  editorFunctions,
  editorFunctionsWithoutProject,
} from '../../EditorFunctions';

/**
 * GDevelop's own tool descriptions and argument JSON-schemas live on its
 * servers (the client-side `EditorFunction` type carries none of them), so
 * BYOK owns the schemas of the tools it exposes: they describe exactly the
 * arguments the `launchFunction` implementations read (each schema below was
 * checked against the `SafeExtractor.extract…` calls of its implementation
 * in `EditorFunctions/index.js`). A schema being wrong here can never be
 * broken by an upstream change — but it must be maintained by us.
 */

export type ByokToolSchema = {|
  name: string,
  description: string,
  parameters: {|
    type: 'object',
    properties: Object,
    required: Array<string>,
  |},
|};

// The JSON-schema property types used by the schemas below (and the ones
// the validator accepts). Only string/number/boolean/array/object are
// actually used today; `integer` is allowed for future schemas.
const BYOK_PROPERTY_TYPES: Array<string> = [
  'string',
  'number',
  'boolean',
  'integer',
  'array',
  'object',
];

const stringProperty = (description: string) => ({
  type: 'string',
  description,
});

const numberProperty = (description: string) => ({
  type: 'number',
  description,
});

const booleanProperty = (description: string) => ({
  type: 'boolean',
  description,
});

const arrayProperty = (description: string, items: Object) => ({
  type: 'array',
  description,
  items,
});

const objectProperty = (description: string, properties: Object) => ({
  type: 'object',
  description,
  properties,
});

const enumProperty = (description: string, values: Array<string>) => ({
  type: 'string',
  description,
  enum: values,
});

// The item shape shared by every effect change (object effects and layer
// effects read the same fields through `applyEffectChange`).
const effectChangeProperty = objectProperty('One effect change.', {
  effect_name: stringProperty('Name of the effect to change (or to create).'),
  effect_type: stringProperty(
    'Type of the effect, needed to create an effect that does not exist yet.'
  ),
  new_effect_name: stringProperty(
    'New name of the effect, or the name to give a newly created effect.'
  ),
  new_effect_position: numberProperty(
    'Position of the effect in the list (moves it, or the index where to insert a new one).'
  ),
  delete_this_effect: booleanProperty(
    'Set to true to remove the effect instead of changing it.'
  ),
  changed_properties: arrayProperty(
    'The effect properties to change.',
    objectProperty('One effect property change.', {
      property_name: stringProperty('Name of the effect property.'),
      new_value: stringProperty(
        'New value of the property, as a string (numbers and booleans are parsed).'
      ),
    })
  ),
});

/**
 * The tools exposed to the model by default in BYOK v3 (see
 * REVIEW/phase5-tool-decisions.md for the full admit/exclude table): the
 * read/inspect surface, the edit surface, local event writing and the
 * script agent. Deliberately **excluded**:
 * - `generate_events`: exact upstream alias of `add_scene_events` — not
 *   advertised, but still dispatchable (ByokExtraTools maps it to the same
 *   local implementation).
 * - `create_object`, the legacy aliases (`inspect_object_properties`,
 *   `change_object_property`, `remove_behavior`): covered by their modern
 *   equivalents.
 * - `read_full_docs`, `run_tests`, `report_fulfilment_problem`:
 *   server-side stubs (Phase 7/8). The Phase 12 flip (D12-1):
 *   `search_object_asset_store`, `search_resource_store` and
 *   `get_game_starter_summary` were in this list until Phase 12 replaced
 *   the stubs with local implementations over the public catalogs.
 */ export const BYOK_TOOL_NAMES: Array<string> = [
  'describe_instances',
  'inspect_variables',
  'read_scene_events',
  'read_events_source',
  'read_game_project_json',
  'create_scene',
  'create_or_replace_object',
  'inspect_object_properties_effects',
  'change_object_properties_effects',
  'add_behavior',
  'inspect_behavior_properties',
  'change_behavior_property',
  'inspect_scene_properties_layers_effects',
  'change_scene_properties_layers_effects_groups',
  'inspect_project_properties_resources',
  'change_project_properties_resources',
  'add_or_edit_variable',
  'put_2d_instances',
  'put_3d_instances',
  // Its registry launchFunction is a permanent failure stub ("handled
  // server-side" upstream): ByokOrchestrator (BYOK_PLAN_TOOL_NAME) executes
  // it client-side instead. Do not remove without removing the whitelist
  // entry — and vice versa.
  'create_or_update_plan',
  // Intercepts in ByokExtraTools before the editor registry: the registry
  // implementation of add_scene_events posts to GDevelop's event-generation
  // backend, the BYOK one (ByokLocalEventWriter) is fully client-side.
  'add_scene_events',
  'run_script',
  // Perception (Phase 6): screenshots of the scene editor and of a running
  // preview, preview control and runtime feedback — the capture tools are
  // intercepted (images), the read/control tools wrap the preview session.
  'capture_scene_screenshot',
  'capture_preview_screenshot',
  'start_preview',
  'stop_preview',
  'read_preview_logs',
  'get_runtime_errors',
  'inspect_runtime_state',
  // Gameplay tests (Phase 6): the strongest existing run-&-self-correct
  // loop. run_gameplay_test is intercepted (its screenshots become image
  // parts); change_gameplay_tests goes through the registry as-is.
  'run_gameplay_test',
  'change_gameplay_tests',
  // Engine reference (Phase 7): queries the generated catalog instead of
  // carrying it in the prompt. Intercepted (ByokExtraTools) — there is no
  // upstream editor function for it.
  'search_reference',
  // Skills (Phase 7): progressive disclosure — metadata in the prompt,
  // bodies on demand. Intercepted (ByokExtraTools).
  'load_skill',
  // Docs access (Phase 7): the curated bundled subset, optionally expanded
  // online. Intercepted (ByokExtraTools).
  'search_docs',
  'read_doc',
  // Per-project memory (Phase 7): the agent's own notes, injected at chat
  // start. Intercepted (ByokExtraTools).
  'update_project_notes',
  // Sub-agents (Phase 8): read-only scout (same name as the hosted tool)
  // and fresh-context reviewer, both intercepted (ByokExtraTools) before
  // the registry stubs. run_edit_agent stays deliberately excluded:
  // sequential edits belong to the main context.
  'run_explorer_agent',
  'run_review_agent',
  // Events-based extension authoring (Phase 8.4), ported from the upstream
  // v18 branch: intercepted (ByokExtensionTools), driving libGD directly.
  'create_extension_BYOK',
  'change_extension_properties_BYOK',
  'create_custom_object_BYOK',
  'change_custom_object_BYOK',
  'create_custom_behavior_BYOK',
  'change_custom_behavior_BYOK',
  'create_custom_function_BYOK',
  'change_custom_function_BYOK',
  'find_extension_usages_BYOK',
  // Restore points (Phase 8.6): rewind the project to a pre-message
  // snapshot. Intercepted (ByokExtraTools), approval-gated.
  'restore_project_point',
  // External events & external layouts (Phase 11): dedicated tools over the
  // same EventScript and instance pipelines the scene tools use — all
  // intercepted (ByokExternalSceneTools).
  'read_external_events_source',
  'add_external_events',
  'describe_external_layout',
  'put_external_layout_instances',
  // Effect catalog (Phase 11): the effect types + property schemas the
  // effect-change tools consume. Intercepted (ByokCatalogTools).
  'list_effects',
  // Sprite internals (Phase 11): animations/directions/frames, points and
  // collision masks. Intercepted (ByokSpriteTools).
  'describe_sprite_frames',
  'change_sprite_frames',
  // Resource import/replace (Phase 11): URL / absolute path / in-project
  // sources. Intercepted (ByokResourceTools), desktop-only.
  'import_project_resources',
  // Store discovery (Phase 12): intercepted (ByokCatalogTools) over the
  // auth-free public catalogs; the names reuse the hosted tools' (D12-1),
  // so the phase5-tool-decisions exclusions flipped.
  'search_object_asset_store',
  'search_resource_store',
  // The notes read side (Phase 12): intercepted (ByokExtraTools).
  'read_project_notes',
  // Debugger/profiler (Phase 12): intercepted (ByokDebuggerTools), acting
  // on the chat's own preview only — runtime state, not project state.
  'read_runtime_details',
  'control_runtime',
  'profile_runtime',
  // The tool-discovery meta-tool (Phase 13.5): the advertised list is the
  // core set, everything else is found through this one.
  'search_tools',
  // The on-device knowledge search (Phase 13.7).
  'search_knowledge',
  // Game code (Phase 15.3): the read/write surface of the game code folder
  // (`<GameName>Code/` next to the project file), intercepted
  // (ByokGameCodeTools). reload_game_code routes to the Phase 15.4 hot
  // reload and degrades to an honest failure before it exists.
  'list_game_code_files',
  'read_game_code_file',
  'write_game_code_file',
  'delete_game_code_file',
  'reload_game_code',
  // Build-time asset optimization (Phase 16.5, D16-9): the savings
  // projection over the project's resources and the settings the export
  // reads (Fork/AssetBuild). Both are read/config — neither writes to the
  // project, and both are advertised only through search_tools.
  'report_asset_optimization',
  'set_asset_optimization_settings',
  // Tag-driven asset management (Phase 17.7, D17-10): the tagged asset
  // listing and the tag writer over the resource metadata (Fork/
  // AssetPipeline). list_assets reads; set_asset_tags writes the metadata
  // (a project change). Both advertised only through search_tools.
  'list_assets',
  'set_asset_tags',
  // Event-sheet guardrails (Phase 18.3, D18-6): the read-only trap report
  // over the project's scenes (Fork/Guardrails) — the same diagnostics the
  // events sheet shows as inline badges. Advertised only through
  // search_tools.
  'scan_scene_events',
  // Sprite-sheet import (Phase 19.5, D19-1): slice one local image along an
  // explicit grid into frame files + a new animation of a Sprite object.
  // Intercepted (ByokSpriteSheetTools), desktop-guarded by the handler,
  // advertised only through search_tools.
  'import_sprite_sheet',
];

/**
 * The tools advertised ONLY while no project is open. With a project open
 * the runner refuses `initialize_project` anyway, so advertising it would
 * waste a slot of the (billed) tool list; without one, it is the entry
 * point of "make me a game from scratch". `get_game_starter_summary`
 * (Phase 12) is its companion: the real template catalog instead of the
 * model's memory. The names stay dispatchable at all times — only the
 * advertisement is conditional.
 */
export const BYOK_NO_PROJECT_TOOL_NAMES: Array<string> = [
  'initialize_project',
  'get_game_starter_summary',
  'read_doc_page',
];

/**
 * The CORE tool set of the Phase 13.5 budget pass: the ~25-30 tools whose
 * schemas are advertised inline on every turn (scene/object/instance/
 * variable/events/preview/notes + the knowledge tools + the search_tools
 * meta-tool). Every other tool of `BYOK_TOOL_NAMES` stays dispatchable but
 * is NOT advertised — the model discovers it through `search_tools`, and
 * executing a discovered tool works immediately (the executor knows every
 * tool; only the schema injection needed the search).
 */
export const BYOK_CORE_TOOL_NAMES: Array<string> = [
  // Reads (grounding before editing).
  'describe_instances',
  'read_events_source',
  // Scene and object editing.
  'create_scene',
  'create_or_replace_object',
  'inspect_object_properties_effects',
  'change_object_properties_effects',
  'add_behavior',
  'inspect_scene_properties_layers_effects',
  // Variables and instances.
  'add_or_edit_variable',
  'put_2d_instances',
  // Events (the local EventScript writer) and scripting.
  'create_or_update_plan',
  'add_scene_events',
  'run_script',
  // Perception and preview.
  'capture_scene_screenshot',
  'start_preview',
  'read_preview_logs',
  'inspect_runtime_state',
  // Notes and knowledge retrieval.
  'update_project_notes',
  'read_project_notes',
  'search_reference',
  'load_skill',
  'search_docs',
  'read_doc',
  // The wiki drill-down exit. It is project-independent, and three prompt
  // surfaces teach it unconditionally (the retrieval map, the
  // search_knowledge description, and every docs-min chunk's "Full page:
  // read_doc_page(...)"). Advertising it only in the no-project set meant
  // the common docs-lookup case invited a call whose schema was NOT in the
  // turn's tools array, contradicting the prompt's own "only call the tools
  // listed below" (audit100226 TOOL-11).
  'read_doc_page',
  // The meta-tool of the tiered advertisement (13.5).
  'search_tools',
  // The knowledge/grep search (13.7).
  'search_knowledge',
  // The delegation tools the agents policy section teaches (13.5 kept them
  // core: the section's instructions name them directly).
  'run_explorer_agent',
  'run_review_agent',
];

const BYOK_CORE_TOOL_NAMES_SET: Set<string> = new Set(BYOK_CORE_TOOL_NAMES);

/** True for the tools advertised inline (the Phase 13.5 core set). */
export const isByokCoreToolName = (name: string): boolean =>
  BYOK_CORE_TOOL_NAMES_SET.has(name);

/**
 * Every tool name the BYOK loop may dispatch: the default set, the
 * no-project additions, and the unadvertised alias(es) the model may still
 * emit out of hosted-agent habit (generate_events). The orchestrator
 * enforces this set at dispatch time.
 */
export const getByokDispatchableToolNames = (): Array<string> => [
  ...BYOK_TOOL_NAMES,
  ...BYOK_NO_PROJECT_TOOL_NAMES,
  'generate_events',
];

/**
 * The FULL tool list served over MCP `tools/list` (Phase 13.5): external
 * clients are not budget-bound, so unlike the chat's core advertisement
 * they see every dispatchable tool (minus the hosted-habit alias).
 */
export const getByokMcpToolNames = (options: {|
  hasOpenedProject: boolean,
|}): Array<string> =>
  options.hasOpenedProject
    ? BYOK_TOOL_NAMES.slice()
    : [...BYOK_TOOL_NAMES, ...BYOK_NO_PROJECT_TOOL_NAMES];

/**
 * The names of the tools sent to the model for a turn: the CORE set (13.5's
 * tiered advertisement — the rest is discoverable via search_tools), plus
 * the no-project tools while no project is open (read at turn time, so a
 * chat that creates its project stops advertising initialize_project on the
 * next turn).
 */
export const getByokAdvertisedToolNames = (options: {|
  hasOpenedProject: boolean,
|}): Array<string> => {
  if (options.hasOpenedProject) return BYOK_CORE_TOOL_NAMES.slice();
  // Deduped: a tool in BOTH sets would be advertised twice, and a
  // duplicate entry in a request's `tools` array is rejected by strict
  // endpoints (`read_doc_page` moved into the core set while this list
  // still named it — audit100226 TOOL-11).
  const advertised = new Set([
    ...BYOK_CORE_TOOL_NAMES,
    ...BYOK_NO_PROJECT_TOOL_NAMES,
  ]);
  return Array.from(advertised);
};

const BYOK_TOOL_SCHEMAS: Array<ByokToolSchema> = [
  {
    name: 'describe_instances',
    description:
      'List the instances placed in a scene, with their object name, position, size, z-order, layer and variables. Inspect the current state of a scene before modifying it, and get the instance `id`s needed by put_2d_instances and add_or_edit_variable.',
    parameters: {
      type: 'object',
      properties: {
        scene_name: stringProperty('Name of the scene to read.'),
        filter_by_object_name: stringProperty(
          'Optional: comma-separated object names. Only instances of these objects are returned.'
        ),
      },
      required: ['scene_name'],
    },
  },
  {
    name: 'inspect_variables',
    description:
      'Read the variables of the game: global variables, scene variables, object or group variables, or the variables of a specific instance. Use a variable path with dots (e.g. "player.stats.hp") to read children of structure variables.',
    parameters: {
      type: 'object',
      properties: {
        variable_scope: enumProperty('Which variables to read.', [
          'global',
          'scene',
          'object',
          'group',
          'instance',
        ]),
        scene_name: stringProperty(
          'Name of the scene (required for the "scene" and "instance" scopes).'
        ),
        object_name: stringProperty(
          'Name of the object or group (required for the "object" and "group" scopes).'
        ),
        instance_id: stringProperty(
          'Id of the instance (required for the "instance" scope). Get ids from describe_instances.'
        ),
        variable_names_or_paths: arrayProperty(
          'Optional: read only these variables (paths with dots for children of structures). All variables are returned when omitted.',
          stringProperty('Name or path of a variable.')
        ),
      },
      required: ['variable_scope'],
    },
  },
  {
    name: 'read_scene_events',
    description:
      'Read the events (the game logic) of a scene, rendered as an indented text tree. Read the existing events before changing them.',
    parameters: {
      type: 'object',
      properties: {
        scene_name: stringProperty('Name of the scene to read.'),
      },
      required: ['scene_name'],
    },
  },
  {
    name: 'read_events_source',
    description:
      'Read the events of a scene as EventScript source — the exact syntax add_scene_events accepts back, with `# event-N.M` ids usable as placement targets. Prefer this over read_scene_events when preparing an edit.',
    parameters: {
      type: 'object',
      properties: {
        scene_name: stringProperty('Name of the scene to read.'),
        event_ids: arrayProperty(
          'Optional: read only these events (e.g. ["event-0", "event-2.1"]). All events are read when omitted.',
          stringProperty('Id of an event, e.g. "event-2.1".')
        ),
        search: stringProperty(
          'Optional: only show the events containing this text.'
        ),
        object_names: arrayProperty(
          'Optional: only show the events involving these objects.',
          stringProperty('Name of an object.')
        ),
        sub_events_depth: numberProperty(
          'Optional: how deep to show sub-events of the selected events.'
        ),
        max_chars: numberProperty(
          'Optional: maximum length of the returned source (default 12000, clamped to 2000-30000).'
        ),
      },
      required: ['scene_name'],
    },
  },
  {
    name: 'read_game_project_json',
    description:
      'Read the structure of the game project as simplified JSON. Start with the whole project (or a path) to discover the scenes, objects and resources, then read more precisely with a path.',
    parameters: {
      type: 'object',
      properties: {
        path: stringProperty(
          'Optional: path into the project JSON to read (e.g. "layouts.Level 1"). The whole project is returned when omitted.'
        ),
        filter: objectProperty(
          'Optional: for arrays, only return the items matching these field values, as field name → expected value (e.g. { "name": "Player" }).',
          {}
        ),
        maxDepth: numberProperty(
          'Optional: maximum depth of the returned JSON (default 2).'
        ),
        maxStringLength: numberProperty(
          'Optional: maximum length of the returned strings (default 200).'
        ),
        offset: numberProperty(
          'Optional: for arrays, index of the first returned item (default 0).'
        ),
        limit: numberProperty(
          'Optional: for arrays, maximum number of returned items.'
        ),
        countOnly: booleanProperty(
          'Optional: return only the number of items of the array, not the items.'
        ),
      },
      required: [],
    },
  },
  {
    name: 'create_scene',
    description:
      'Create a scene (doing nothing if a scene with this name already exists), optionally with a UI layer and a background color, and optionally set it as the first (startup) scene.',
    parameters: {
      type: 'object',
      properties: {
        scene_name: stringProperty('Name of the scene to create.'),
        include_ui_layer: booleanProperty(
          'Also add a "UI" layer, meant for HUD elements drawn above the game.'
        ),
        background_color: stringProperty(
          'Optional background color of the scene, as a color name or hex string (e.g. "#2a2a2a").'
        ),
        is_first_scene: booleanProperty(
          'Also set the scene as the first (startup) scene of the game.'
        ),
      },
      required: ['scene_name'],
    },
  },
  {
    name: 'create_or_replace_object',
    description:
      'Add an object to a scene (or replace/duplicate an existing object). The object can be created from a type, from a description (searched in the asset store), or as a copy of another object.',
    parameters: {
      type: 'object',
      properties: {
        scene_name: stringProperty('Name of the scene.'),
        object_name: stringProperty('Name of the object to create.'),
        object_type: stringProperty(
          'Type of the object (e.g. "Sprite", "TextObject::Text"). Defaults to the type of the existing object with the same name, when there is one.'
        ),
        target_object_scope: enumProperty(
          'Whether the object should live in the scene or be global (shared by all scenes).',
          ['scene', 'global']
        ),
        replace_existing_object: booleanProperty(
          'Replace an existing object with the same name instead of failing.'
        ),
        duplicated_object_name: stringProperty(
          'Create the object as a copy of this existing object instead of using object_type.'
        ),
        duplicated_object_scene: stringProperty(
          'Scene of the object to duplicate, when different from scene_name.'
        ),
        description: stringProperty(
          'Description of what the object should look like, used to find a suitable asset.'
        ),
        search_terms: stringProperty(
          'Optional search terms to find a suitable asset in the asset store.'
        ),
        asset_id: stringProperty(
          'Id of an asset store asset to use for the object.'
        ),
        two_dimensional_view_kind: stringProperty(
          'Optional: which 2D view of an asset to prefer (e.g. "side view", "top-down").'
        ),
      },
      required: ['scene_name', 'object_name'],
    },
  },
  {
    name: 'inspect_object_properties_effects',
    description:
      'Read the properties, behaviors and effects of an object. Inspect before changing an object.',
    parameters: {
      type: 'object',
      properties: {
        scene_name: stringProperty('Name of the scene.'),
        object_name: stringProperty(
          'Name of the object to inspect (searched in the scene, then in the global objects).'
        ),
      },
      required: ['scene_name', 'object_name'],
    },
  },
  {
    name: 'change_object_properties_effects',
    description:
      'Change the properties or effects of an object, rename it, or delete it (delete_this_object).',
    parameters: {
      type: 'object',
      properties: {
        scene_name: stringProperty('Name of the scene.'),
        object_name: stringProperty(
          'Name of the object to change (searched in the scene, then in the global objects).'
        ),
        changed_properties: arrayProperty(
          'The object properties to change. Use "name" as property_name to rename the object. Instance attributes (position, angle, ...) belong to put_2d_instances / put_3d_instances instead.',
          objectProperty('One property change.', {
            property_name: stringProperty('Name of the property.'),
            new_value: stringProperty(
              'New value of the property, as a string (numbers and booleans are parsed).'
            ),
          })
        ),
        changed_effects: arrayProperty(
          'The effect changes to apply to the object.',
          effectChangeProperty
        ),
        delete_this_object: booleanProperty(
          'Set to true to delete the object instead of changing it.'
        ),
      },
      required: ['scene_name', 'object_name'],
    },
  },
  {
    name: 'add_behavior',
    description:
      'Add a behavior to an object (or to every object of a group). The extension providing the behavior is installed automatically when needed.',
    parameters: {
      type: 'object',
      properties: {
        scene_name: stringProperty('Name of the scene.'),
        object_name: stringProperty(
          'Name of the object (or group) to add the behavior to.'
        ),
        behavior_type: stringProperty(
          'Type of the behavior (e.g. "PlatformerObject::PlatformerObject" for a behavior from an extension, "Draggable" for a base behavior).'
        ),
        behavior_name: stringProperty(
          'Optional custom name of the behavior. Defaults to the standard name of the behavior type.'
        ),
      },
      required: ['scene_name', 'object_name', 'behavior_type'],
    },
  },
  {
    name: 'inspect_behavior_properties',
    description:
      'Read the properties of a behavior on an object (or group), or the shared data of an extension behavior. Inspect before changing a behavior.',
    parameters: {
      type: 'object',
      properties: {
        scene_name: stringProperty('Name of the scene.'),
        object_name: stringProperty(
          'Name of the object (or group) owning the behavior.'
        ),
        behavior_name: stringProperty('Name of the behavior to inspect.'),
      },
      required: ['scene_name', 'object_name', 'behavior_name'],
    },
  },
  {
    name: 'change_behavior_property',
    description:
      'Change properties of a behavior on an object (or on every object of a group), or remove the behavior with delete_this_behavior.',
    parameters: {
      type: 'object',
      properties: {
        scene_name: stringProperty('Name of the scene.'),
        object_name: stringProperty(
          'Name of the object (or group) owning the behavior.'
        ),
        behavior_name: stringProperty('Name of the behavior.'),
        delete_this_behavior: booleanProperty(
          'Set to true to remove the behavior instead of changing properties.'
        ),
        changed_properties: arrayProperty(
          'The properties to change. Provide at least one change, or delete_this_behavior.',
          objectProperty('A property change.', {
            property_name: stringProperty('Name of the property.'),
            new_value: stringProperty(
              'New value of the property, as a string (numbers and booleans are parsed).'
            ),
          })
        ),
      },
      required: ['scene_name', 'object_name', 'behavior_name'],
    },
  },
  {
    name: 'inspect_scene_properties_layers_effects',
    description:
      'Read the properties, layers and effects of a scene. Inspect a scene before changing it.',
    parameters: {
      type: 'object',
      properties: {
        scene_name: stringProperty('Name of the scene to inspect.'),
      },
      required: ['scene_name'],
    },
  },
  {
    name: 'change_scene_properties_layers_effects_groups',
    description:
      'Change the properties, layers, layer effects and object groups of a scene, or delete the scene (delete_this_scene).',
    parameters: {
      type: 'object',
      properties: {
        scene_name: stringProperty('Name of the scene to change.'),
        delete_this_scene: booleanProperty(
          'Set to true to delete the whole scene instead of changing it.'
        ),
        changed_properties: arrayProperty(
          'The scene settings to change (e.g. name, backgroundColor, gameResolutionWidth, gameResolutionHeight, gameOrientation, gameScaleMode, isFirstScene, stopSoundsOnStartup).',
          objectProperty('One scene property change.', {
            property_name: stringProperty('Name of the scene property.'),
            new_value: stringProperty(
              'New value of the property, as a string (numbers and booleans are parsed).'
            ),
          })
        ),
        changed_layers: arrayProperty(
          'The layer changes to apply: create, rename, reorder, show/hide or delete layers.',
          objectProperty('One layer change.', {
            layer_name: stringProperty(
              'Name of the layer (the empty string is the base layer).'
            ),
            new_layer_name: stringProperty('New name of the layer.'),
            new_layer_position: numberProperty(
              'Position of the layer in the list (moves it, or the index where to insert a new one).'
            ),
            delete_this_layer: booleanProperty(
              'Set to true to delete the layer (the base layer cannot be deleted).'
            ),
            move_instances_to_layer: stringProperty(
              'When deleting the layer, move its instances to this layer instead.'
            ),
            new_visibility: booleanProperty('Visibility of the layer.'),
          })
        ),
        changed_layer_effects: arrayProperty(
          'The effect changes to apply to a layer.',
          objectProperty(
            'The effect changes of one layer (same shape as object effect changes), starting with its layer_name.',
            {
              layer_name: stringProperty('Name of the layer.'),
              ...effectChangeProperty.properties,
            }
          )
        ),
        changed_groups: arrayProperty(
          'The object group changes to apply: create, rename, fill or delete groups of objects.',
          objectProperty('One group change.', {
            group_name: stringProperty('Name of the group.'),
            delete_this_group: booleanProperty(
              'Set to true to delete the group.'
            ),
            objects_to_add: arrayProperty(
              'Names of the objects to add to the group.',
              stringProperty('Name of an object.')
            ),
            objects_to_remove: arrayProperty(
              'Names of the objects to remove from the group.',
              stringProperty('Name of an object.')
            ),
            new_group_name: stringProperty('New name of the group.'),
          })
        ),
      },
      required: ['scene_name'],
    },
  },
  {
    name: 'inspect_project_properties_resources',
    description:
      'Read the properties of the project (name, resolution, orientation, ...) and its resources. Inspect the project before changing it.',
    parameters: {
      type: 'object',
      properties: {
        filter_by_resource_name: stringProperty(
          'Optional: only list the resources whose name contains this text (case-insensitive).'
        ),
        list_all_resources: booleanProperty(
          'Optional: list up to 200 resources instead of only the summary.'
        ),
      },
      required: [],
    },
  },
  {
    name: 'change_project_properties_resources',
    description:
      'Change the properties of the project (name, resolution, orientation, scale mode, first scene, ...) or rename/delete its resources. Provide at least one change.',
    parameters: {
      type: 'object',
      properties: {
        changed_properties: arrayProperty(
          'The project properties to change.',
          objectProperty('One project property change.', {
            property_name: stringProperty(
              'Name of the property (e.g. name, version, author, orientation, windowWidth, windowHeight, scaleMode, sizeOnStartupMode, adaptGameResolutionAtRuntime, pixelsRounding, antialiasingMode, minimumFPS, maximumFPS, firstLayout).'
            ),
            new_value: stringProperty(
              'New value of the property, as a string (numbers and booleans are parsed).'
            ),
          })
        ),
        changed_resources: arrayProperty(
          'The resource changes to apply: rename or delete resources.',
          objectProperty('One resource change.', {
            resource_name: stringProperty('Name of the resource to change.'),
            new_resource_name: stringProperty(
              'New name of the resource (skipped when only deleting).'
            ),
            delete_this_resource: booleanProperty(
              'Set to true to delete the resource (refused while it is still used).'
            ),
          })
        ),
      },
      required: [],
    },
  },
  {
    name: 'add_or_edit_variable',
    description:
      'Create, change or delete variables, in the global scope, of a scene, of an object/group, or of an instance. A variable path with dots (e.g. "player.stats.hp") addresses children of structure variables.',
    parameters: {
      type: 'object',
      properties: {
        variable_scope: enumProperty('Which variables to change.', [
          'global',
          'scene',
          'object',
          'group',
          'instance',
        ]),
        variables: arrayProperty(
          'The operations to apply, in order.',
          objectProperty('One variable operation.', {
            variable_name_or_path: stringProperty(
              'Name or path of the variable.'
            ),
            value: stringProperty(
              'New value of the variable, as a string (numbers and booleans are parsed). Not needed when deleting.'
            ),
            variable_type: enumProperty(
              'Type of the variable, when creating it. Inferred from the value when omitted.',
              ['number', 'string', 'boolean', 'structure', 'array']
            ),
            delete_this_variable: booleanProperty(
              'Set to true to delete the variable instead of setting its value.'
            ),
          })
        ),
        scene_name: stringProperty(
          'Name of the scene (required for the "scene" and "instance" scopes).'
        ),
        object_name: stringProperty(
          'Name of the object or group (required for the "object" and "group" scopes).'
        ),
        instance_id: stringProperty(
          'Id of the instance (required for the "instance" scope). Get ids from describe_instances.'
        ),
      },
      required: ['variable_scope', 'variables'],
    },
  },
  {
    name: 'put_2d_instances',
    description:
      'Place, move, transform or erase instances of 2D objects in a scene, using a brush: "point" places at a position, "line" between two positions, "grid" in a rectangle with rows and columns, "random_in_circle" inside a radius, "erase" removes, "none" only moves or transforms existing instances identified by their ids.',
    parameters: {
      type: 'object',
      properties: {
        scene_name: stringProperty('Name of the scene.'),
        layer_name: stringProperty(
          'Name of the layer. Use the empty string for the base layer.'
        ),
        brush_kind: enumProperty('The brush to use.', [
          'point',
          'line',
          'grid',
          'random_in_circle',
          'erase',
          'none',
        ]),
        object_name: stringProperty(
          'Name of the object to place (or of the objects to erase/modify).'
        ),
        brush_position: stringProperty(
          'Position of the brush, as "x,y" in pixels. Required when creating instances (point/line/grid/random_in_circle brushes); only the "none" and "erase" brushes working on existing instances may omit it.'
        ),
        brush_end_position: stringProperty(
          'End position, as "x,y" (required for the "line" and "grid" brushes).'
        ),
        brush_size: numberProperty(
          'Radius in pixels (used by the "erase" and "random_in_circle" brushes).'
        ),
        existing_instance_ids: stringProperty(
          'Comma-separated ids of instances to move/erase/transform (from describe_instances).'
        ),
        new_instances_count: numberProperty(
          'Instances to create (default 1; omit to only move/transform existing ones).'
        ),
        row_count: numberProperty('Rows of the grid ("grid" brush).'),
        column_count: numberProperty('Columns of the grid ("grid" brush).'),
        instances_z_order: numberProperty('Z-order of the instances.'),
        instances_size: stringProperty(
          'Custom size of the instances, as "width,height" in pixels.'
        ),
        instances_rotation: numberProperty(
          'Rotation angle of the instances, in degrees.'
        ),
        instances_opacity: numberProperty(
          'Opacity of the instances, from 0 (transparent) to 255 (opaque).'
        ),
        instances_hidden: booleanProperty('Set to true to hide the instances.'),
      },
      required: ['scene_name', 'layer_name', 'brush_kind'],
    },
  },
  {
    name: 'put_3d_instances',
    description:
      'Place, move, transform or erase instances of 3D objects in a 3D layer of a scene, using a brush: "point" places at a position, "line" between two positions, "random_in_sphere" inside a radius, "erase" removes, "none" only moves or transforms existing instances identified by their ids.',
    parameters: {
      type: 'object',
      properties: {
        scene_name: stringProperty('Name of the scene.'),
        layer_name: stringProperty(
          'Name of the 3D layer. Use the empty string for the base layer.'
        ),
        brush_kind: enumProperty('The brush to use.', [
          'point',
          'line',
          'random_in_sphere',
          'erase',
          'none',
        ]),
        object_name: stringProperty(
          'Name of the 3D object to place (or of the objects to erase/modify).'
        ),
        brush_position: stringProperty(
          'Position of the brush, as "x,y,z" in pixels. Required when creating instances; only the "none" and "erase" brushes working on existing instances may omit it.'
        ),
        brush_end_position: stringProperty(
          'End position, as "x,y,z" (required for the "line" brush).'
        ),
        brush_size: numberProperty(
          'Radius in pixels (used by the "erase" and "random_in_sphere" brushes).'
        ),
        existing_instance_ids: stringProperty(
          'Comma-separated ids of instances to move/erase/transform (from describe_instances).'
        ),
        new_instances_count: numberProperty(
          'Instances to create (default 1; omit to only move/transform existing ones).'
        ),
        instances_size: stringProperty(
          'Custom size of the instances, as "width,height,depth" in pixels.'
        ),
        instances_rotation: stringProperty(
          'Rotation of the instances, as "rotationX,rotationY,rotationZ" in degrees.'
        ),
        instances_hidden: booleanProperty('Set to true to hide the instances.'),
      },
      required: ['scene_name', 'layer_name', 'brush_kind'],
    },
  },
  {
    name: 'add_scene_events',
    description:
      'Write the events (the game logic) of a scene: each batch is EventScript source placed with an operation (insert_at_end, insert_and_replace_event, replace_entire_event_and_sub_events, replace_event_but_keep_existing_sub_events, insert_before_event, insert_after_event, insert_as_sub_event, delete_event). Runs fully locally — read_events_source first, then anchor the edits.',
    parameters: {
      type: 'object',
      properties: {
        scene_name: stringProperty('Name of the scene to edit.'),
        event_batches: arrayProperty(
          'The batches to apply, in order. Each batch carries EventScript source (the same syntax read_events_source returns) and a placement.',
          objectProperty('One batch of events to write.', {
            event_script: stringProperty(
              'The events to write, as EventScript source (statements like `if Timer(2, "T") and once:` with indented actions). Not needed for delete_event.'
            ),
            placement_relation: enumProperty('How to place the batch.', [
              'insert_at_end',
              'insert_and_replace_event',
              'replace_entire_event_and_sub_events',
              'replace_event_but_keep_existing_sub_events',
              'insert_before_event',
              'insert_after_event',
              'insert_as_sub_event',
              'delete_event',
            ]),
            placement_target_event_id: stringProperty(
              'Target of the placement: an event id from read_events_source (e.g. "event-2.1") or a group name. Not needed for insert_at_end.'
            ),
            placement_expected_parent_event_id: stringProperty(
              'For insert_as_sub_event: the event that will own the new sub-events (defaults to the target).'
            ),
            expected_event_source: stringProperty(
              'Safety anchor for replace operations: the current source of the target event (as read). The edit is refused when it no longer matches.'
            ),
          })
        ),
      },
      required: ['scene_name', 'event_batches'],
    },
  },
  {
    name: 'run_script',
    description:
      'Run one JavaScript script that calls the other tools as async functions (e.g. `const created = await create_scene({ scene_name: "Level 2" });`), batching many operations or computations into a single call. Every call in the script must be awaited, and a refused approval means nothing in the script ran.',
    parameters: {
      type: 'object',
      properties: {
        js_code: stringProperty(
          'The JavaScript to run. Call the tools by their name, passing the arguments as a JS object (e.g. `await add_or_edit_variable({ variable_scope: "global", variables: [...] });`).'
        ),
        title: stringProperty('Optional short title, shown to the user.'),
      },
      required: ['js_code'],
    },
  },
  {
    name: 'capture_scene_screenshot',
    description:
      'Capture a screenshot of the currently open scene editor canvas. Look at the scene after visual edits instead of assuming them.',
    parameters: {
      type: 'object',
      properties: {
        scene_name: stringProperty(
          'Optional: the scene you want to see. Only the editor canvas that is currently open can be captured — the output says when it may be another scene.'
        ),
        layer_name: stringProperty(
          'Optional: the layer of interest (informational — the whole canvas is captured).'
        ),
      },
      required: [],
    },
  },
  {
    name: 'capture_preview_screenshot',
    description:
      'Capture a screenshot of a running preview window (the game as it plays). Pair it with read_preview_logs and inspect_runtime_state for the machine-readable state.',
    parameters: {
      type: 'object',
      properties: {
        preview_id: numberProperty(
          'Optional: the window id of the preview to capture. The most recently opened preview is captured when omitted.'
        ),
      },
      required: [],
    },
  },
  {
    name: 'start_preview',
    description:
      'Start a preview of the game (on its first scene, or the given one) and keep it running for the chat. One preview at a time.',
    parameters: {
      type: 'object',
      properties: {
        scene_name: stringProperty(
          'Optional: the scene to preview. The first scene of the game is used when omitted.'
        ),
      },
      required: [],
    },
  },
  {
    name: 'stop_preview',
    description: 'Stop the preview started by this chat.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'read_preview_logs',
    description:
      'Read the console logs of the running preview (e.g. the console.log calls of the game).',
    parameters: {
      type: 'object',
      properties: {
        since_index: numberProperty(
          'Optional: only return the logs after this index (read_preview_logs returned them last time).'
        ),
        level: stringProperty(
          'Optional: only return this level (log, warn or error).'
        ),
      },
      required: [],
    },
  },
  {
    name: 'get_runtime_errors',
    description:
      'Read the errors and crashes of the running preview since the last call.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'inspect_runtime_state',
    description:
      'Read the live state of the running game: the instances of each scene (names and positions) and the scene/global variables. Read coordinates here, never guess them from pixels.',
    parameters: {
      type: 'object',
      properties: {
        scene_name: stringProperty(
          'Optional: only read this scene (all scenes are returned when omitted).'
        ),
        variable_paths: arrayProperty(
          'Optional: only read these variable paths.',
          stringProperty('A variable path.')
        ),
      },
      required: [],
    },
  },
  {
    name: 'run_gameplay_test',
    description:
      'Create (or update) and run one gameplay test in a live preview: assertions on the game state, with console logs, final state and screenshots returned — the strongest verify-and-self-correct loop. The executed source is returned on failure so it can be repaired.',
    parameters: {
      type: 'object',
      properties: {
        scope: objectProperty('Where the test lives.', {
          type: enumProperty('The kind of scope.', ['project', 'extension']),
          extension_name: stringProperty(
            'The extension name (required for the "extension" scope).'
          ),
        }),
        test_name: stringProperty('Name of the gameplay test.'),
        source: stringProperty(
          'The JavaScript source of the test (see the gameplay test API: stepFrames, simulateInput, assert...). When omitted, the stored test with this name is run.'
        ),
        persist: booleanProperty(
          'Save the source as the stored test (default true). Set false for a temporary probe — nothing is saved, no approval is needed.'
        ),
        timeout_ms: numberProperty(
          'Optional timeout in milliseconds (1000-120000).'
        ),
        screenshots: enumProperty('When to capture screenshots.', [
          'on-failure',
          'off',
        ]),
        description: stringProperty(
          'Optional description, saved with a persisted test.'
        ),
      },
      required: ['scope', 'test_name'],
    },
  },
  {
    name: 'change_gameplay_tests',
    description:
      'Delete, rename or reorder the gameplay tests of the project, or change their description (never their source — run_gameplay_test does that).',
    parameters: {
      type: 'object',
      properties: {
        scope: objectProperty('Where the tests live.', {
          type: enumProperty('The kind of scope.', ['project', 'extension']),
          extension_name: stringProperty(
            'The extension name (required for the "extension" scope).'
          ),
        }),
        changes: arrayProperty(
          'The changes to apply, in order.',
          objectProperty('One test change.', {
            test_name: stringProperty('Name of the test to change.'),
            delete_this_test: booleanProperty(
              'Set to true to delete the test.'
            ),
            changed_properties: arrayProperty(
              'The properties to change (name, description or index).',
              objectProperty('One property change.', {
                property_name: stringProperty(
                  'The property to change (name, description or index).'
                ),
                new_value: stringProperty(
                  'The new value, as a string (numbers are parsed).'
                ),
              })
            ),
          })
        ),
      },
      required: ['scope', 'changes'],
    },
  },
  {
    name: 'create_or_update_plan',
    description:
      'Create or update the plan of a multi-step task, shown to the user. Send the full list of tasks each time; update the status of the tasks as the work progresses.',
    parameters: {
      type: 'object',
      properties: {
        tasks: arrayProperty(
          'The tasks of the plan, in execution order. Send the complete plan each time.',
          objectProperty('One task of the plan.', {
            id: stringProperty('Short stable id of the task (e.g. "task-1").'),
            title: stringProperty('Short title of the task.'),
            description: stringProperty(
              'What exactly will be done in this task.'
            ),
            status: enumProperty('Status of the task.', [
              'pending',
              'in_progress',
              'done',
              'voided',
            ]),
            depends_on: arrayProperty(
              'Ids of the tasks that must be done before this one.',
              stringProperty('Id of a task.')
            ),
          })
        ),
      },
      required: ['tasks'],
    },
  },
  {
    name: 'initialize_project',
    description:
      'Create a new, empty GDevelop project (or one from a template) and open it in the editor — the entry point when no project is open. Only usable while no project is open.',
    parameters: {
      type: 'object',
      properties: {
        project_name: stringProperty('Name of the project to create.'),
        template_slug: stringProperty(
          'Slug of a template to start from (as in the "Games examples" library), or "" / "none" / "empty" for an empty project.'
        ),
        also_read_existing_events: booleanProperty(
          'Also return the existing events of the created project (e.g. of a template) as text.'
        ),
      },
      required: ['project_name', 'template_slug'],
    },
  },
  {
    name: 'search_reference',
    description:
      'Search the engine reference: every object, behavior, action, condition, expression and effect that exists in GDevelop, with their exact names and parameters. Use it instead of guessing an instruction or parameter name.',
    parameters: {
      type: 'object',
      properties: {
        query: stringProperty(
          'What to look for: a name or a topic (e.g. "lerp", "platformer jump", "gravity"). Empty lists everything of the requested kind.'
        ),
        kind: enumProperty('Restrict the search to one kind of entry.', [
          'object',
          'behavior',
          'action',
          'condition',
          'expression',
          'effect',
          'example',
        ]),
        owner: stringProperty(
          'Restrict the search to one extension (e.g. "Physics2", "Tween", "BuiltinAudio").'
        ),
      },
      required: ['query'],
    },
  },
  {
    name: 'load_skill',
    description:
      'Load the full playbook of one skill from the "Available skills" list: its instructions stay available for the rest of the conversation. Load a skill when its topic matters for the current task (a platformer to build, a save system to add…).',
    parameters: {
      type: 'object',
      properties: {
        name: stringProperty(
          'Name of the skill to load, exactly as listed in "Available skills".'
        ),
      },
      required: ['name'],
    },
  },
  {
    name: 'search_docs',
    description:
      'Search the official GDevelop documentation bundled with the app (events, expressions, object picking, JS code…): page titles and what matched. Follow up with read_doc to read a page.',
    parameters: {
      type: 'object',
      properties: {
        query: stringProperty(
          'What to look for (e.g. "object picking", "for each", "variables").'
        ),
      },
      required: ['query'],
    },
  },
  {
    name: 'read_doc',
    description:
      'Read one documentation page (a path returned by search_docs, e.g. "events/object-picking/index.md"). Returns its Markdown, capped; pass an anchor to read only one section.',
    parameters: {
      type: 'object',
      properties: {
        page: stringProperty('Path of the page to read (from search_docs).'),
        anchor: stringProperty(
          'Optional: read only the section whose heading contains this text.'
        ),
      },
      required: ['page'],
    },
  },
  {
    name: 'update_project_notes',
    description:
      'Update your persistent notes about this project (shown to you at the start of every chat about it): the project conventions to follow, what is currently in progress, and the design/technical decisions taken. Send only the fields you want to replace.',
    parameters: {
      type: 'object',
      properties: {
        conventions: stringProperty(
          'The conventions of the project (naming, structure, style). Replace the whole list.'
        ),
        inProgress: stringProperty(
          'What is currently in progress or left unfinished.'
        ),
        decisions: stringProperty(
          'The design and technical decisions taken, so they stay consistent.'
        ),
      },
      required: [],
    },
  },
  {
    name: 'run_explorer_agent',
    description:
      'Delegate a read-only exploration to a scout sub-agent with a fresh context: it inspects the project with the read tools and returns a summary. Use it for broad sweeps (inventory the scenes, find where X is used) that would flood this conversation.',
    parameters: {
      type: 'object',
      properties: {
        instructions: stringProperty(
          'What the scout must find out, as a self-contained briefing (it sees nothing of this conversation).'
        ),
        short_title: stringProperty(
          'Optional short title of the exploration, shown to the user.'
        ),
      },
      required: ['instructions'],
    },
  },
  {
    name: 'run_review_agent',
    description:
      'Delegate a final review to a fresh-context sub-agent: it checks the finished work against the original request using the read tools, and flags gaps (it never edits). Use it before claiming done on a multi-step build.',
    parameters: {
      type: 'object',
      properties: {
        instructions: stringProperty(
          'The review briefing: the original user request, what was built, and what to check (the reviewer sees nothing of this conversation).'
        ),
        short_title: stringProperty(
          'Optional short title of the review, shown to the user.'
        ),
      },
      required: ['instructions'],
    },
  },
  {
    name: 'create_extension_BYOK',
    description:
      'Create a new events-based extension in the project — the container for custom functions, custom objects and custom behaviors authored with events. Pass duplicated_extension_name to copy an existing extension instead of creating an empty one. Follow up with create_custom_function_BYOK / create_custom_object_BYOK / create_custom_behavior_BYOK.',
    parameters: {
      type: 'object',
      properties: {
        extension_name: stringProperty(
          'Name of the extension (its namespace: functions are called as "ExtensionName::FunctionName").'
        ),
        duplicated_extension_name: stringProperty(
          'Copy this existing extension instead of creating an empty one: the copy keeps its functions, objects and behaviors, and everything it contains is renamed after the new extension.'
        ),
        full_name: stringProperty('Optional full, human-readable name.'),
        short_description: stringProperty('Optional one-line description.'),
        description: stringProperty('Optional detailed description.'),
        version: stringProperty('Optional version string (e.g. "1.0.0").'),
        author: stringProperty('Optional author name.'),
        category: stringProperty('Optional category (e.g. "Game mechanic").'),
      },
      required: ['extension_name'],
    },
  },
  {
    name: 'change_extension_properties_BYOK',
    description:
      'Change the properties of an extension, rename it (updating every reference in the project), or delete it. Deletion is refused while the extension is still used, unless delete_even_if_used is true. Its dependencies (other extensions it requires) are managed with dependencies_to_add/dependencies_to_remove.',
    parameters: {
      type: 'object',
      properties: {
        extension_name: stringProperty('Name of the extension to change.'),
        new_name: stringProperty('New name of the extension.'),
        changed_properties: arrayProperty(
          'The properties to change.',
          objectProperty('One property change.', {
            property_name: stringProperty(
              'The property: full_name, short_description, description, version, author, category, icon_url, preview_icon_url or help_path.'
            ),
            new_value: stringProperty('The new value.'),
          })
        ),
        dependencies_to_add: arrayProperty(
          'The dependencies (other extensions this extension requires) to add.',
          objectProperty('One dependency.', {
            name: stringProperty('Name of the required extension.'),
            export_name: stringProperty(
              'Optional export name, if it differs from the name.'
            ),
            version: stringProperty(
              'Optional required version (e.g. "1.0.0").'
            ),
            dependency_type: enumProperty(
              'The kind of dependency (the default is cordova).',
              ['cordova', 'npm']
            ),
          })
        ),
        dependencies_to_remove: arrayProperty(
          'The names of the dependencies to remove.',
          stringProperty('Name of the dependency.')
        ),
        delete_this_extension: booleanProperty(
          'Set to true to delete the extension.'
        ),
        delete_even_if_used: booleanProperty(
          'Set to true to delete even while the extension is used (the usages will break).'
        ),
      },
      required: ['extension_name'],
    },
  },
  {
    name: 'create_custom_object_BYOK',
    description:
      'Create a custom (composed) object inside an extension: a reusable object with its own child objects, layers, properties and functions. Use it when a grouping of objects + logic repeats across the game. Pass duplicated_custom_object_name to copy an existing custom object instead of creating an empty one.',
    parameters: {
      type: 'object',
      properties: {
        extension_name: stringProperty('Name of the extension.'),
        custom_object_name: stringProperty('Name of the custom object.'),
        duplicated_custom_object_name: stringProperty(
          'Copy this existing custom object instead of creating an empty one: the copy keeps its children, properties and functions.'
        ),
        duplicated_from_extension_name: stringProperty(
          'The extension the custom object to copy comes from (when it is not the one being created).'
        ),
        full_name: stringProperty('Optional full, human-readable name.'),
        description: stringProperty('Optional description.'),
        default_name: stringProperty(
          'Optional default name given to instances in the scene.'
        ),
        is_3d: booleanProperty('Mark the object as rendered in 3D.'),
        is_animatable: booleanProperty('Mark the object as animatable.'),
        is_text_container: booleanProperty(
          'Mark the object as containing text (for text-related behaviors).'
        ),
      },
      required: ['extension_name', 'custom_object_name'],
    },
  },
  {
    name: 'change_custom_object_BYOK',
    description:
      'Change a custom object (rename it with project-wide reference updates, change its properties or metadata), or delete it. Deletion is refused while its object type is used. Its child objects are managed with children_to_add/children_to_remove, and its area can be fitted to them with fit_area_to_children.',
    parameters: {
      type: 'object',
      properties: {
        extension_name: stringProperty('Name of the extension.'),
        custom_object_name: stringProperty('Name of the custom object.'),
        new_name: stringProperty('New name of the custom object.'),
        full_name: stringProperty('New full name.'),
        description: stringProperty('New description.'),
        default_name: stringProperty('New default instance name.'),
        changed_properties: arrayProperty(
          'The object properties to create or change.',
          objectProperty('One property change.', {
            property_name: stringProperty('Name of the property.'),
            new_value: stringProperty(
              'New value of the property, as a string.'
            ),
          })
        ),
        children_to_add: arrayProperty(
          'The child objects to add to this custom object.',
          objectProperty('One child.', {
            name: stringProperty('Name of the child object.'),
            object_type: stringProperty(
              'Object type of the child (e.g. "Sprite", "Text", or an extension custom object type).'
            ),
            initial_properties: arrayProperty(
              'Optional initial values of the child object properties (only for types that expose properties, like custom objects).',
              objectProperty('One property value.', {
                name: stringProperty('Name of the property.'),
                value: stringProperty('Value of the property, as a string.'),
              })
            ),
          })
        ),
        children_to_remove: arrayProperty(
          'The names of the child objects to remove. Refused while the child is still used by the custom object functions.',
          stringProperty('Name of the child object.')
        ),
        fit_area_to_children: enumProperty(
          'Fit the area of the custom object to its children, moving them: "min_at_origin" puts their minimum corner at (0;0;0) and the area goes from 0 to the content size; "centered_on_origin" puts their center at (0;0;0) and the area is symmetric, which is what a turret or anything spinning around itself needs.',
          ['min_at_origin', 'centered_on_origin']
        ),
        delete_this_custom_object: booleanProperty(
          'Set to true to delete the custom object.'
        ),
        delete_even_if_used: booleanProperty(
          'Set to true to delete even while used (the usages will break).'
        ),
      },
      required: ['extension_name', 'custom_object_name'],
    },
  },
  {
    name: 'create_custom_behavior_BYOK',
    description:
      'Create a custom behavior inside an extension: reusable logic attached to objects, with its own properties and functions (doStepPreEvents, onCreated…). Use it when behavior-like state + per-frame logic is needed. Pass duplicated_custom_behavior_name to copy an existing custom behavior instead of creating an empty one.',
    parameters: {
      type: 'object',
      properties: {
        extension_name: stringProperty('Name of the extension.'),
        custom_behavior_name: stringProperty('Name of the custom behavior.'),
        duplicated_custom_behavior_name: stringProperty(
          'Copy this existing custom behavior instead of creating an empty one: the copy keeps its properties and functions.'
        ),
        duplicated_from_extension_name: stringProperty(
          'The extension the custom behavior to copy comes from (when it is not the one being created).'
        ),
        full_name: stringProperty('Optional full, human-readable name.'),
        description: stringProperty('Optional description.'),
        object_type: stringProperty(
          'Optional object type the behavior is restricted to (e.g. "Sprite").'
        ),
      },
      required: ['extension_name', 'custom_behavior_name'],
    },
  },
  {
    name: 'change_custom_behavior_BYOK',
    description:
      'Change a custom behavior (rename it with project-wide reference updates, change its properties or metadata), or delete it. Deletion is refused while objects still use the behavior.',
    parameters: {
      type: 'object',
      properties: {
        extension_name: stringProperty('Name of the extension.'),
        custom_behavior_name: stringProperty('Name of the custom behavior.'),
        new_name: stringProperty('New name of the custom behavior.'),
        full_name: stringProperty('New full name.'),
        description: stringProperty('New description.'),
        object_type: stringProperty('New object type restriction.'),
        changed_properties: arrayProperty(
          'The behavior properties to create or change.',
          objectProperty('One property change.', {
            property_name: stringProperty('Name of the property.'),
            new_value: stringProperty(
              'New value of the property, as a string.'
            ),
          })
        ),
        delete_this_custom_behavior: booleanProperty(
          'Set to true to delete the custom behavior.'
        ),
        delete_even_if_used: booleanProperty(
          'Set to true to delete even while used (the usages will break).'
        ),
      },
      required: ['extension_name', 'custom_behavior_name'],
    },
  },
  {
    name: 'create_custom_function_BYOK',
    description:
      'Create a function of an extension (a free action/condition/expression), or of a custom behavior or custom object (pass custom_behavior_name / custom_object_name). The function body is authored as EventScript (event_script) — the same syntax add_scene_events accepts.',
    parameters: {
      type: 'object',
      properties: {
        extension_name: stringProperty('Name of the extension.'),
        function_name: stringProperty('Name of the function.'),
        function_type: enumProperty('The kind of function.', [
          'Action',
          'Condition',
          'Expression',
          'ExpressionAndCondition',
          'ActionWithOperator',
        ]),
        duplicated_function_name: stringProperty(
          'Copy this existing function of the same scope instead of creating an empty one: the copy keeps the parameters and the events of its source (do not pass `parameters` with it).'
        ),
        expression_type: enumProperty(
          'What an "Expression" returns: "number" or "string". Only for an "Expression" or "ExpressionAndCondition".',
          ['number', 'string']
        ),
        getter_name: stringProperty(
          'For an "ActionWithOperator": the name of the "Expression" (or "ExpressionAndCondition") of the same scope whose value this action changes.'
        ),
        custom_behavior_name: stringProperty(
          'Create the function inside this custom behavior of the extension.'
        ),
        custom_object_name: stringProperty(
          'Create the function inside this custom object of the extension.'
        ),
        event_script: stringProperty(
          'The events of the function, as EventScript source (e.g. `if SomeCondition:\n  DoSomething`). Lifecycle names (onCreated, doStepPreEvents…) have special meanings for behaviors/objects.'
        ),
        parameters: arrayProperty(
          'The typed parameters of the function, in order.',
          objectProperty('One parameter.', {
            name: stringProperty('Parameter name.'),
            type: stringProperty(
              'Parameter type (expression, string, objectList, behavior, sceneName…).'
            ),
            description: stringProperty('Optional parameter description.'),
          })
        ),
        sentence: stringProperty(
          'The sentence shown in the events editor, with _PARAM0_ style placeholders.'
        ),
        full_name: stringProperty('Optional full, human-readable name.'),
        description: stringProperty('Optional description.'),
        group: stringProperty('Optional group in the events editor.'),
        is_private: booleanProperty('Hide the function from the editor.'),
        is_async: booleanProperty('Run the function asynchronously.'),
      },
      required: ['extension_name', 'function_name', 'function_type'],
    },
  },
  {
    name: 'change_custom_function_BYOK',
    description:
      'Change a function (rename it with project-wide reference updates, change its settings) or replace its events — or delete it. Its parameters are managed with parameters_to_add/parameters_to_remove/parameters_to_move.',
    parameters: {
      type: 'object',
      properties: {
        extension_name: stringProperty('Name of the extension.'),
        function_name: stringProperty('Name of the function.'),
        custom_behavior_name: stringProperty(
          'The function lives inside this custom behavior.'
        ),
        custom_object_name: stringProperty(
          'The function lives inside this custom object.'
        ),
        new_name: stringProperty('New name of the function.'),
        changed_settings: arrayProperty(
          'The settings to change.',
          objectProperty('One setting change.', {
            property_name: stringProperty(
              'The setting: full_name, description, sentence, group, is_private or is_async.'
            ),
            new_value: stringProperty(
              'The new value, as a string (booleans as "true"/"false").'
            ),
          })
        ),
        parameters_to_add: arrayProperty(
          'The parameters to add, after the existing ones. Naming an existing parameter and passing a type changes that parameter type (its usages in the project are refactored); without a type, an existing name is skipped.',
          objectProperty('One parameter.', {
            name: stringProperty('Parameter name.'),
            type: stringProperty(
              'Parameter type (expression, string, objectList, behavior, sceneName…).'
            ),
            description: stringProperty('Optional parameter description.'),
          })
        ),
        parameters_to_remove: arrayProperty(
          'The names of the parameters to remove.',
          stringProperty('Parameter name.')
        ),
        parameters_to_move: arrayProperty(
          'The parameter re-orderings.',
          objectProperty('One move.', {
            name: stringProperty('Parameter name.'),
            to_index: numberProperty('New (0-based) index of the parameter.'),
          })
        ),
        event_script: stringProperty(
          'Replaces the whole events of the function, as EventScript source.'
        ),
        delete_this_function: booleanProperty(
          'Set to true to delete the function.'
        ),
      },
      required: ['extension_name', 'function_name'],
    },
  },
  {
    name: 'restore_project_point',
    description:
      'Rewind the project to the state saved before one of the messages of this chat (the automatic pre-message restore points). Overwrites the current project — the conversation itself continues unchanged.',
    parameters: {
      type: 'object',
      properties: {
        message_id: stringProperty(
          'The message id of the restore point (from the restore arrows in the chat, or the ids listed on failure).'
        ),
      },
      required: ['message_id'],
    },
  },
  {
    name: 'find_extension_usages_BYOK',
    description:
      'List where an extension is used in the project: the extensions depending on it, and the object types using its custom objects or behaviors. Run it before deleting or renaming anything.',
    parameters: {
      type: 'object',
      properties: {
        extension_name: stringProperty('Name of the extension.'),
      },
      required: ['extension_name'],
    },
  },
  {
    name: 'read_external_events_source',
    description:
      'Read an external-events sheet (a reusable events group shared by scenes) as EventScript source — the same syntax add_external_events accepts back. Shows the associated scene and the object names in context.',
    parameters: {
      type: 'object',
      properties: {
        external_events_name: stringProperty(
          'Name of the external-events sheet to read.'
        ),
      },
      required: ['external_events_name'],
    },
  },
  {
    name: 'add_external_events',
    description:
      'Write an external-events sheet: create it if missing (create_if_missing + associated_scene), then either apply anchored event_batches (like add_scene_events) or write the whole sheet with event_script (mode replace/insert).',
    parameters: {
      type: 'object',
      properties: {
        external_events_name: stringProperty(
          'Name of the external-events sheet.'
        ),
        create_if_missing: booleanProperty(
          'Create the sheet when it does not exist (required when it is missing).'
        ),
        associated_scene: stringProperty(
          'The scene the sheet is associated with (its objects and layers provide the context).'
        ),
        event_batches: arrayProperty(
          'Anchored event changes, exactly like add_scene_events event_batches.',
          objectProperty('One event batch.', {
            event_script: stringProperty(
              'The events to write, as EventScript source (statements like `if Timer(2, "T") and once:` with indented actions). Not needed for delete_event.'
            ),
            placement_relation: enumProperty('How to place the batch.', [
              'insert_at_end',
              'insert_and_replace_event',
              'replace_entire_event_and_sub_events',
              'replace_event_but_keep_existing_sub_events',
              'insert_before_event',
              'insert_after_event',
              'insert_as_sub_event',
              'delete_event',
            ]),
            placement_target_event_id: stringProperty(
              'Target of the placement: an event id from read_external_events_source (e.g. "event-2.1") or a group name. Not needed for insert_at_end.'
            ),
            placement_expected_parent_event_id: stringProperty(
              'For insert_as_sub_event: the event that will own the new sub-events (defaults to the target).'
            ),
            expected_event_source: stringProperty(
              'Safety anchor for replace operations: the current source of the target event (as read). The edit is refused when it no longer matches.'
            ),
          })
        ),
        event_script: stringProperty(
          'The whole sheet content as EventScript source (alternative to event_batches — pass one of the two, not both).'
        ),
        mode: enumProperty(
          'How event_script is applied: "replace" (the DEFAULT when omitted — it overwrites the whole sheet) or "insert" (appends at the end).',
          ['replace', 'insert']
        ),
      },
      required: ['external_events_name'],
    },
  },
  {
    name: 'describe_external_layout',
    description:
      'List the instances placed in an external layout (a reusable set of instances, the spawn-point mechanic), like describe_instances does for a scene.',
    parameters: {
      type: 'object',
      properties: {
        external_layout_name: stringProperty(
          'Name of the external layout to read.'
        ),
      },
      required: ['external_layout_name'],
    },
  },
  {
    name: 'put_external_layout_instances',
    description:
      'Place, move, resize or erase instances in an external layout with the same brushes as put_2d_instances. Create the layout when missing (create_if_missing + associated_scene).',
    parameters: {
      type: 'object',
      properties: {
        external_layout_name: stringProperty('Name of the external layout.'),
        create_if_missing: booleanProperty(
          'Create the external layout when it does not exist (with associated_scene).'
        ),
        associated_scene: stringProperty(
          'The scene whose layers and objects the external layout uses.'
        ),
        layer_name: stringProperty('Target layer ("" for the base layer).'),
        brush_kind: enumProperty('The brush to apply.', [
          'point',
          'line',
          'grid',
          'random_in_circle',
          'erase',
          'none',
        ]),
        brush_position: stringProperty('Brush position as "x, y".'),
        brush_end_position: stringProperty(
          'End position, as "x,y" (required for the "line" and "grid" brushes).'
        ),
        brush_size: numberProperty(
          'Radius in pixels (used by the "erase" and "random_in_circle" brushes).'
        ),
        object_name: stringProperty('Object of the instances to place.'),
        new_instances_count: numberProperty(
          'Instances to create (default 1; omit to only move/transform existing ones).'
        ),
        row_count: numberProperty('Rows of the grid ("grid" brush).'),
        column_count: numberProperty('Columns of the grid ("grid" brush).'),
        existing_instance_ids: stringProperty(
          'Comma-separated ids from describe_external_layout to modify.'
        ),
        instances_z_order: numberProperty('Z-order of the instances.'),
        instances_size: stringProperty(
          'Custom size of the instances, as "width,height" in pixels.'
        ),
        instances_rotation: numberProperty(
          'Rotation angle of the instances, in degrees.'
        ),
        instances_opacity: numberProperty(
          'Opacity of the instances, from 0 (transparent) to 255 (opaque).'
        ),
        instances_hidden: booleanProperty('Set to true to hide the instances.'),
      },
      required: ['external_layout_name', 'layer_name', 'brush_kind'],
    },
  },
  {
    name: 'list_effects',
    description:
      'List the effect types available in this project, with their property names, types and defaults — the effect_type strings and changed_properties values that change_object_properties_effects and change_scene_properties_layers_effects_groups expect. Optional filter: 2d, 3d or object.',
    parameters: {
      type: 'object',
      properties: {
        filter: enumProperty('Only effects usable on that target.', [
          '2d',
          '3d',
          'object',
        ]),
      },
      required: [],
    },
  },
  {
    name: 'describe_sprite_frames',
    description:
      'Read the internals of a Sprite object: animations, directions, frames with their image names, origin/center, custom points and collision-mask modes. Read before change_sprite_frames.',
    parameters: {
      type: 'object',
      properties: {
        scene_name: stringProperty(
          'Scene of the object (or where it is used).'
        ),
        object_name: stringProperty('Name of the Sprite object.'),
      },
      required: ['scene_name', 'object_name'],
    },
  },
  {
    name: 'change_sprite_frames',
    description:
      'Edit the internals of a Sprite object with a typed operations list: animations (add/remove/move/rename, set_directions_count), frames (add/remove/move, set_frame_image), points (set_origin, set_center, set_default_center, add/move/remove point) and collision masks (set_full_image_mask, set_polygon_mask with vertices or a rectangle, per frame or all frames; set_adapt_collision_masks).',
    parameters: {
      type: 'object',
      properties: {
        scene_name: stringProperty('Scene of the object.'),
        object_name: stringProperty('Name of the Sprite object.'),
        operations: arrayProperty(
          'The operations to apply in order; failed operations are reported and skipped.',
          objectProperty(
            'One operation: set "op" to one of add_animation, remove_animation, move_animation, rename_animation, set_directions_count, add_frame, remove_frame, move_frame, set_frame_image, set_origin, set_center, set_default_center, add_point, move_point, remove_point, set_full_image_mask, set_polygon_mask, set_adapt_collision_masks — plus the fields that op reads.',
            {
              op: stringProperty('The operation name (see above).'),
              animation_index: numberProperty(
                'Target animation (indices as read from describe_sprite_frames).'
              ),
              direction_index: numberProperty('Target direction.'),
              frame_index: numberProperty('Target frame.'),
              to_index: numberProperty('Destination of a move op.'),
              count: numberProperty('Count of set_directions_count.'),
              name: stringProperty(
                'Name for add/rename animation, add/move/remove point.'
              ),
              new_name: stringProperty('New name for rename_animation.'),
              image_name: stringProperty('Image of add_frame/set_frame_image.'),
              all_frames: booleanProperty(
                'Apply to every frame (point and mask ops).'
              ),
              x: numberProperty(
                'X of set_origin/set_center/add_point/move_point.'
              ),
              y: numberProperty(
                'Y of set_origin/set_center/add_point/move_point.'
              ),
              enabled: booleanProperty('Set to false to disable a mask mode.'),
              full_image: booleanProperty('set_full_image_mask value.'),
              adapt: booleanProperty('set_adapt_collision_masks value.'),
              polygons: arrayProperty(
                'set_polygon_mask definitions (replaces the whole mask).',
                objectProperty('One polygon: vertices or a moved rectangle.', {
                  vertices: arrayProperty(
                    'The polygon corners.',
                    objectProperty('One corner.', {
                      x: numberProperty('Corner x.'),
                      y: numberProperty('Corner y.'),
                    })
                  ),
                  rectangle: objectProperty(
                    'A rectangle polygon (alternative to vertices).',
                    {
                      width: numberProperty('Rectangle width.'),
                      height: numberProperty('Rectangle height.'),
                      center_x: numberProperty('Rectangle center x.'),
                      center_y: numberProperty('Rectangle center y.'),
                    }
                  ),
                })
              ),
            }
          )
        ),
      },
      required: ['scene_name', 'object_name', 'operations'],
    },
  },
  {
    name: 'import_project_resources',
    description:
      'Import resource files into the project (images, audio, fonts, video, JSON): each entry downloads a URL, copies an absolute path into the project folder, or registers a project-relative path in place. replace_existing retargets an existing resource in place. Desktop app only.',
    parameters: {
      type: 'object',
      properties: {
        entries: arrayProperty(
          'The resources to import.',
          objectProperty('One resource to import.', {
            kind: stringProperty(
              'Resource kind (image, audio, font, video, json). Inferred from the extension when omitted.'
            ),
            source: stringProperty(
              'A URL, an absolute path, or a project-relative path.'
            ),
            name: stringProperty(
              'Optional resource name (defaults to the file name).'
            ),
          })
        ),
        replace_existing: booleanProperty(
          'Replace an existing resource of the same name in place (references follow).'
        ),
      },
      required: ['entries'],
    },
  },
  {
    name: 'get_game_starter_summary',
    description:
      'Browse the public GDevelop starter-template catalog: without a template_slug, list the templates as compact headers (optionally narrowed by search); with one, get its full summary (description, tags, difficulty, license). The chosen slug goes to initialize_project (template_slug). Needs the network.',
    parameters: {
      type: 'object',
      properties: {
        template_slug: stringProperty(
          'Optional: the slug of one template to summarize (from the list).'
        ),
        search: stringProperty(
          'Optional: only list the templates matching these terms (genre, mechanic…).'
        ),
      },
      required: [],
    },
  },
  {
    name: 'search_object_asset_store',
    description:
      'Search the public (free) GDevelop asset store for ready-made objects (characters, UI, effects…) ranked by pertinence. To add one to the game, call create_or_replace_object with search_terms — it installs the best match automatically.',
    parameters: {
      type: 'object',
      properties: {
        search_terms: stringProperty(
          'What to search for (e.g. "platformer character").'
        ),
        object_type: stringProperty(
          'Optional: only assets of this object type (e.g. "sprite").'
        ),
        tags: arrayProperty(
          'Optional: only assets carrying all these tags.',
          stringProperty('A tag.')
        ),
      },
      required: ['search_terms'],
    },
  },
  {
    name: 'search_resource_store',
    description:
      'Search the public (free) GDevelop resource store for audio and fonts. Each hit carries its direct url — install it with import_project_resources.',
    parameters: {
      type: 'object',
      properties: {
        search_terms: stringProperty('What to search for (e.g. "jump sound").'),
        resource_type: enumProperty('Optional: only this resource kind.', [
          'audio',
          'font',
        ]),
      },
      required: ['search_terms'],
    },
  },
  {
    name: 'read_project_notes',
    description:
      'Read the persistent notes of this project (conventions, work in progress, decisions) — the same memory update_project_notes writes.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'read_runtime_details',
    description:
      'Read live details of the preview this chat launched: the paused state and current scene (getStatus) plus the instances and variables (a targeted refresh). Never guesses from pixels, never touches the project.',
    parameters: {
      type: 'object',
      properties: {
        scene_name: {
          type: 'string',
          description:
            'Optional: read only this scene. Strongly recommended on a game with several scenes or many instances — the full dump is capped and cut mid-JSON.',
        },
        variable_paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional: read only these variables (e.g. ["score", "lives"]). Omit to get every variable of the scene(s).',
        },
      },
      required: [],
    },
  },
  {
    name: 'control_runtime',
    description:
      'Steer the preview this chat launched: pause, play/resume, or getStatus. The runtime refuses mutating commands while a gameplay test runs — such refusals come back as failures.',
    parameters: {
      type: 'object',
      properties: {
        action: enumProperty('What to do.', [
          'pause',
          'play',
          'resume',
          'getStatus',
        ]),
      },
      required: ['action'],
    },
  },
  {
    name: 'profile_runtime',
    description:
      'Profile the preview this chat launched for a short run: starts the profiler, lets the game run (duration_ms, default 2000), stops it, and returns the pushed per-subsystem timings (framesAverageMeasures, ms/frame) and stats — read the heaviest entries first.',
    parameters: {
      type: 'object',
      properties: {
        duration_ms: numberProperty(
          'How long to measure before stopping (default 2000, max 60000).'
        ),
      },
      required: [],
    },
  },
  {
    name: 'read_doc_page',
    description:
      'Read the FULL wiki page behind a docs-min chunk of the minified GDevelop wiki bundled offline with the app (the chunk text says `Full page: read_doc_page(...)` — this is that tool). Pass the exact path from the chunk.',
    parameters: {
      type: 'object',
      properties: {
        path: stringProperty(
          'The wiki path from a docs-min chunk, e.g. "gdevelop5/objects/sprite.md".'
        ),
      },
      required: ['path'],
    },
  },
  {
    name: 'search_tools',
    description:
      'Search the full tool catalog (the tools not listed in the system prompt are all usable — discover them here). Returns each matching tool with its complete parameter schema, so you can call it immediately.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Keywords matched against the tool names and descriptions, e.g. "external layout", "sprite animation", "asset store".',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_knowledge',
    description:
      'Grep-like search over the full on-device knowledge corpus: the engine reference (every action, condition, expression, object, behavior), the bundled documentation, the skills and runnable EventScript examples. Exact/tag search always works; semantic ranking when the local RAG index is built.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'What to look for, e.g. "collision variable increment", "play music", "timer spawn".',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional facets to filter by (e.g. ["action"], ["example", "timer"], ["skill"]).',
        },
        kind: {
          type: 'string',
          description:
            'Optional corpus filter: engine-reference, docs, docs-min (minified wiki pages), docs-min-map (per-category wiki maps), skill, example, user-docs. Read a docs-min hit fully with read_doc_page.',
        },
        chunk_id: {
          type: 'string',
          description:
            'Read the chunks AROUND a hit (its neighbors in the same document) instead of searching.',
        },
      },
      required: [],
    },
  },
  {
    name: 'list_game_code_files',
    description:
      "List the JavaScript files of the game code folder (<project>/<GameName>Code/), in their load order (folder root, then core/, then the other folders alphabetically), with each file's size and its GameCode.* runtime namespace. Folders are runtime namespaces; core/ only marks boot-order-critical files — it is NOT a namespace level.",
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'read_game_code_file',
    description:
      "Read one JavaScript file of the game code folder (<project>/<GameName>Code/). Paths are relative to that folder and confined to it. The answer carries the file's GameCode.* namespace and its defensive prologue.",
    parameters: {
      type: 'object',
      properties: {
        path: stringProperty(
          'The file path, relative to the game code folder (e.g. "character/spawn.js"). Must end with .js.'
        ),
      },
      required: ['path'],
    },
  },
  {
    name: 'write_game_code_file',
    description:
      'Create or update one JavaScript file of the game code folder (<project>/<GameName>Code/); it ships in previews and exports automatically. Files are classic scripts (no import/export): publish through the GameCode.<folder>.<name> namespace given in the answer, starting from its defensive prologue. Paths are relative to the folder and confined to it (no "..", no absolute paths); folders are runtime namespaces and core/ only marks boot order (not a namespace level). Each file is capped at 262144 bytes.',
    parameters: {
      type: 'object',
      properties: {
        path: stringProperty(
          'The file path, relative to the game code folder (e.g. "character/spawn.js"). Must end with .js.'
        ),
        content: stringProperty(
          'The full JavaScript source to write (it replaces the file).'
        ),
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'delete_game_code_file',
    description:
      'Delete one JavaScript file of the game code folder (<project>/<GameName>Code/) and drop it from the export carrier, so it stops shipping. A running preview must be reloaded to pick up a deletion. Paths are relative to the folder and confined to it.',
    parameters: {
      type: 'object',
      properties: {
        path: stringProperty(
          'The file path, relative to the game code folder. Must end with .js.'
        ),
      },
      required: ['path'],
    },
  },
  {
    name: 'reload_game_code',
    description:
      'Push the game code files that changed on disk into the running preview of this chat (it hard-reloads when files were deleted). Call it after write_game_code_file/delete_game_code_file while a preview runs.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'report_asset_optimization',
    description:
      "Estimate how much smaller the game's export would be with the build-time asset optimization on: every image and audio resource of the project is planned (PNG re-compressed losslessly, JPEG/WebP at the quality setting, lossy audio re-encoded) and the projected per-file and total savings are returned as a low-high range. Writes NOTHING — the compression only runs at export, on the export copy, and the project's original files are never touched.",
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'set_asset_optimization_settings',
    description:
      'Change the build-time asset optimization settings the exporter reads (the same ones as Preferences > Build). Only the knobs you pass are updated; the rest keep their value. The changes take effect at the next export.',
    parameters: {
      type: 'object',
      properties: {
        enabled: booleanProperty(
          'Turn the optimization on (true) or off (false) for exports.'
        ),
        png_level: numberProperty(
          'PNG zlib compression level, 0 (fast) to 9 (smallest, still lossless).'
        ),
        jpeg_quality: numberProperty(
          'JPEG quality, 1-100 (85 is visually lossless at game resolutions).'
        ),
        webp_quality: numberProperty(
          'WebP quality, 1-100 (its own knob, separate from JPEG).'
        ),
        optimize_manual_exports: booleanProperty(
          'Also optimize the "export to a folder" path, not only the one-click online build.'
        ),
        audio_enabled: booleanProperty(
          'Re-encode lossy audio (mp3, ogg, m4a, aac, opus) at a lower bitrate.'
        ),
        audio_bitrate_kbps: numberProperty(
          'The target audio bitrate in kbps, 32-320 (128 is the default).'
        ),
      },
      required: [],
    },
  },
  {
    name: 'list_assets',
    description:
      "List the project's assets (resources) with their tags: name, kind, file and the tag list of each. Filter with tag (only assets carrying that tag — the same grouping the Assets view uses) or untagged_only (only assets with no tag). Tags are cosmetic lowercase labels used to organise assets; they never change load order, resource names or export naming.",
    parameters: {
      type: 'object',
      properties: {
        tag: stringProperty(
          'Only list the assets carrying this tag (case-insensitive).'
        ),
        untagged_only: booleanProperty(
          'Only list the assets that carry no tag at all.'
        ),
      },
      required: [],
    },
  },
  {
    name: 'set_asset_tags',
    description:
      'Set the tags of one or more project assets (by resource name). Tags are free-form lowercase labels (no slashes, no control characters, max 64 chars) stored in the resource metadata and saved with the project. Modes: "set" replaces the tags, "merge" adds them (the default), "remove" removes the listed tags, "clear" removes all tags (tags argument ignored). The call is atomic: an invalid tag or an unknown asset name refuses the whole change.',
    parameters: {
      type: 'object',
      properties: {
        asset_names: arrayProperty(
          'The resource names of the assets to tag (see list_assets for the exact names).',
          stringProperty('One resource name.')
        ),
        tags: arrayProperty(
          'The tags to apply, interpreted per mode.',
          stringProperty('One tag (lowercase, no slashes).')
        ),
        mode: enumProperty('How to combine the tags with the existing ones.', [
          'set',
          'merge',
          'remove',
          'clear',
        ]),
      },
      required: ['asset_names'],
    },
  },
  {
    name: 'scan_scene_events',
    description:
      'Scan one scene (or every scene) for event-sheet guardrail traps and return the read-only diagnostics: rule id (G18-once-in-loop, G18-wait-in-loop, G18-action-without-picking, G18-duplicate-once), severity, message and event path. The events sheet shows the same findings as inline badges. Writes nothing — use add_scene_events to fix what it reports.',
    parameters: {
      type: 'object',
      properties: {
        scene_name: stringProperty(
          'Only scan this scene. Omit to scan every scene of the project.'
        ),
        rule_ids: arrayProperty(
          'Only run these guardrail rules (by id). Omit to run all four.',
          stringProperty('One rule id, e.g. G18-once-in-loop.')
        ),
      },
      required: [],
    },
  },
  {
    name: 'import_sprite_sheet',
    description:
      'Slice one local sprite-sheet image (a texture atlas) along an explicit grid into frame PNG files written into the project assets folder, register them, and append them as a new animation (or the frames of an existing animation name) of a Sprite object, in reading order (row-major). Desktop app only. The grid must divide the image: "rows-columns" derives the frame size so the cells tile exactly; "frame-size" derives the cell count. Nothing is written when the grid does not divide the image or the object does not exist.',
    parameters: {
      type: 'object',
      properties: {
        object_name: stringProperty(
          'Name of the Sprite object to import into (searched in the scenes, then in the global objects).'
        ),
        source_path: stringProperty(
          'The sprite sheet image to slice: an absolute path, or a path relative to the project folder.'
        ),
        grid: objectProperty(
          'The explicit grid to slice with. No automatic detection: count the rows and columns yourself (or the frame size).',
          {
            mode: enumProperty(
              'How the grid is stated: "rows-columns" gives the cell COUNT (the frame size is derived so the cells tile the image exactly); "frame-size" gives the frame SIZE (the cell count is derived by flooring).',
              ['rows-columns', 'frame-size']
            ),
            rows: {
              type: 'integer',
              description:
                'Number of rows ("rows-columns" mode; there is no default — pass rows and columns together).',
            },
            columns: {
              type: 'integer',
              description:
                'Number of columns ("rows-columns" mode; there is no default — pass rows and columns together).',
            },
            frame_width: {
              type: 'integer',
              description:
                'Frame width in pixels ("frame-size" mode; no default — pass frame_width and frame_height together).',
            },
            frame_height: {
              type: 'integer',
              description:
                'Frame height in pixels ("frame-size" mode; no default — pass frame_width and frame_height together).',
            },
            margin: {
              type: 'integer',
              description:
                'Outer border of the sheet on all four sides, in pixels (default 0).',
            },
            spacing: {
              type: 'integer',
              description:
                'Gap between frames, horizontally and vertically, in pixels (default 0).',
            },
          }
        ),
        animation_name: stringProperty(
          'Name of the animation to create or append to on the object (default "Imported").'
        ),
        fps: numberProperty('Frames per second of the animation (default 10).'),
        loop: booleanProperty('Whether the animation loops (default true).'),
      },
      required: ['object_name', 'source_path', 'grid'],
    },
  },
];

/**
 * The schemas of the tools exposed to the model in BYOK v3.
 */
export const getByokToolSchemas = (): Array<ByokToolSchema> => {
  return BYOK_TOOL_SCHEMAS;
};

/**
 * Search the whole tool catalog by keywords (the `search_tools` meta-tool of
 * Phase 13.5): every term that matches the name or the description scores,
 * name matches weigh more, exact name matches win outright. Pure and
 * deterministic, so the prompt's task catalog can be tested against it.
 */
export const searchByokToolSchemas = (
  query: string,
  resultLimit: number = 10
): Array<ByokToolSchema> => {
  const trimmedQuery = query.trim().toLowerCase();
  if (!trimmedQuery) return [];
  const terms = trimmedQuery.split(/\s+/).filter(term => !!term);

  const scored: Array<{| schema: ByokToolSchema, score: number |}> = [];
  for (const schema of BYOK_TOOL_SCHEMAS) {
    const name = schema.name.toLowerCase();
    const description = schema.description.toLowerCase();
    let score = 0;
    if (name === trimmedQuery) score += 1000;
    if (name.includes(trimmedQuery)) score += 100;
    let matchedTerms = 0;
    for (const term of terms) {
      if (name.includes(term) || description.includes(term)) matchedTerms++;
    }
    score += matchedTerms * 20;
    if (terms.length > 1 && matchedTerms === terms.length) score += 30;
    if (score > 0) scored.push({ schema, score });
  }

  scored.sort(
    (a, b) => b.score - a.score || (a.schema.name < b.schema.name ? -1 : 1)
  );
  return scored.slice(0, resultLimit).map(entry => entry.schema);
};

/**
 * The schemas of a subset of tools, by name — what the orchestrator sends
 * as the `tools` array of a turn (the advertised set, which can differ per
 * turn, e.g. without initialize_project while a project is open).
 */
export const getByokToolSchemasForNames = (
  names: Array<string>
): Array<ByokToolSchema> => {
  const knownNames = new Set(names);
  return BYOK_TOOL_SCHEMAS.filter(schema => knownNames.has(schema.name));
};

/**
 * Format the schemas as the `tools` array of the OpenAI chat-completions
 * API.
 */
export const toOpenAiToolsFormat = (
  schemas: Array<ByokToolSchema>
): Array<Object> => {
  return schemas.map(schema => ({
    type: 'function',
    function: {
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters,
    },
  }));
};

const collectPropertyTypeProblems = (
  properties: Object,
  problemPrefix: string,
  problems: Array<string>
): void => {
  for (const propertyName of Object.keys(properties)) {
    const property = properties[propertyName];
    if (!property || typeof property !== 'object') {
      problems.push(
        `${problemPrefix}.${propertyName} is not a property definition.`
      );
      continue;
    }
    if (!BYOK_PROPERTY_TYPES.includes(property.type)) {
      problems.push(
        `${problemPrefix}.${propertyName} has an unknown property type: ${String(
          property.type
        )}.`
      );
    }

    if (property.type === 'array' && property.items) {
      collectPropertyTypeProblems(
        // An array `items` is a single property definition: reuse the same
        // check by wrapping it under a synthetic name.
        { items: property.items },
        `${problemPrefix}.${propertyName}`,
        problems
      );
    }
    if (property.type === 'object' && property.properties) {
      collectPropertyTypeProblems(
        property.properties,
        `${problemPrefix}.${propertyName}`,
        problems
      );
    }
  }
};

/**
 * The tools implemented BY BYOK ITSELF (in ByokExtraTools/ByokRuntimeTools)
 * rather than by the editor registry — screenshots, preview control and
 * runtime reads have no upstream EditorFunction. The validator skips the
 * registry-membership check for them; a dedicated test asserts each is
 * actually intercepted (see ByokExtraTools.spec.js).
 */
export const BYOK_ONLY_TOOL_NAMES: Array<string> = [
  'read_doc_page',
  'capture_scene_screenshot',
  'capture_preview_screenshot',
  'start_preview',
  'stop_preview',
  'read_preview_logs',
  'get_runtime_errors',
  'inspect_runtime_state',
  'search_reference',
  'load_skill',
  'search_docs',
  'read_doc',
  'update_project_notes',
  // run_explorer_agent also exists in the registry (as a server stub), so
  // it is not "BYOK-only" for the validator; run_review_agent does not
  // exist upstream at all. The Phase 8.4 extension authoring tools have no
  // registry entry either (they are our port of the v18 surface).
  'run_review_agent',
  'create_extension_BYOK',
  'change_extension_properties_BYOK',
  'create_custom_object_BYOK',
  'change_custom_object_BYOK',
  'create_custom_behavior_BYOK',
  'change_custom_behavior_BYOK',
  'create_custom_function_BYOK',
  'change_custom_function_BYOK',
  'find_extension_usages_BYOK',
  'restore_project_point',
  // Phase 11 authoring-reach tools: no registry entry (Byok's own
  // implementations in ByokExternalSceneTools / ByokCatalogTools /
  // ByokSpriteTools / ByokResourceTools).
  'read_external_events_source',
  'add_external_events',
  'describe_external_layout',
  'put_external_layout_instances',
  'list_effects',
  'describe_sprite_frames',
  'change_sprite_frames',
  'import_project_resources',
  // Phase 12 BYOK-only tools: the notes read side and the runtime steering
  // (ByokExtraTools / ByokDebuggerTools). search_object_asset_store,
  // search_resource_store and get_game_starter_summary DO exist in the
  // registry (as permanent-failure stubs), so they are not here — the
  // interception wins before the registry lookup.
  'read_project_notes',
  'read_runtime_details',
  'control_runtime',
  'profile_runtime',
  // The tool-discovery meta-tool (13.5) and the knowledge search (13.7).
  'search_tools',
  'search_knowledge',
  // Phase 15.3 game-code tools: no registry entry (Byok's own
  // implementations in GameCode/ByokGameCodeTools, over the game code
  // folder and the carrier extension).
  'list_game_code_files',
  'read_game_code_file',
  'write_game_code_file',
  'delete_game_code_file',
  'reload_game_code',
  // Phase 16.5 asset-build tools: no registry entry either (the thin
  // adapters in ByokAssetTools over Fork/AssetBuild), and the Phase 17.7
  // asset-tag tools (the same file over Fork/AssetPipeline).
  'report_asset_optimization',
  'set_asset_optimization_settings',
  'list_assets',
  'set_asset_tags',
  // Phase 18.3 guardrail tool: no registry entry (the thin adapter in
  // ByokGuardrailTools over Fork/Guardrails).
  'scan_scene_events',
  // Phase 19.5 sprite-sheet tool: no registry entry (the thin adapter in
  // ByokSpriteSheetTools over Fork/SpriteSheet).
  'import_sprite_sheet',
];

const BYOK_ONLY_TOOL_NAMES_SET: Set<string> = new Set(BYOK_ONLY_TOOL_NAMES);

const collectSchemaProblems = (
  schema: ByokToolSchema,
  registry: Object,
  problems: Array<string>
): void => {
  if (!registry[schema.name] && !BYOK_ONLY_TOOL_NAMES_SET.has(schema.name)) {
    problems.push(
      `Tool "${schema.name}" is not in the editorFunctions registry.`
    );
  }
  if (!schema.description) {
    problems.push(`Tool "${schema.name}" has no description.`);
  }
  collectPropertyTypeProblems(
    schema.parameters.properties,
    `Tool "${schema.name}"`,
    problems
  );
};

/**
 * The full registry the schemas are checked against: the with-project
 * registry plus the without-project one (`initialize_project` only exists
 * there).
 */
// Merged through any: the two registries' launchFunction signatures are
// deliberately incompatible (with/without project), the lookup here only
// reads membership.
const FULL_EDITOR_FUNCTIONS_REGISTRY: any = {};
for (const toolName of Object.keys(editorFunctions)) {
  FULL_EDITOR_FUNCTIONS_REGISTRY[toolName] = (editorFunctions: any)[toolName];
}
for (const toolName of Object.keys(editorFunctionsWithoutProject)) {
  FULL_EDITOR_FUNCTIONS_REGISTRY[
    toolName
  ] = (editorFunctionsWithoutProject: any)[toolName];
}

/**
 * Check that the whitelist and its schemas stay in sync: every whitelisted
 * name (default set, no-project set) must exist in the editor registry and
 * have a schema with described, typed properties, and the default set must
 * stay within the tool-count cap (each advertised schema is billed as input
 * tokens on every turn). The test suite fails when this returns problems,
 * so an upstream tool rename is caught here instead of at runtime. The
 * registry and the schema list are injectable so the tests can exercise
 * the failure branches with synthetic inputs.
 */
export const validateByokToolSchemas = (
  registry: Object = FULL_EDITOR_FUNCTIONS_REGISTRY,
  schemas: Array<ByokToolSchema> = BYOK_TOOL_SCHEMAS
): Array<string> => {
  const problems: Array<string> = [];

  const schemaNames = schemas.map(schema => schema.name);
  const whitelistedNames = [...BYOK_TOOL_NAMES, ...BYOK_NO_PROJECT_TOOL_NAMES];
  if (schemaNames.length !== whitelistedNames.length) {
    problems.push(
      'Some tools of the whitelist have no schema (or the opposite).'
    );
  }
  for (const toolName of whitelistedNames) {
    if (!schemaNames.includes(toolName)) {
      problems.push(`Whitelisted tool "${toolName}" has no schema.`);
    }
  }
  // The dispatchable list grew phase by phase: 62 names at the end of
  // Phase 12, plus search_tools in Phase 13.5 (63), then 64; Phase 15.3
  // raised it to 69 with the five game-code tools, Phase 16.5 to 71 with
  // the two asset-optimization tools, and Phases 17.7 + 18.3 to 74 with the
  // two asset-tag tools and scan_scene_events — the cap moved to 75 in the
  // same owner-approved raise that covers Phase 19's sprite-sheet tool (the
  // usertasks §6 [P1719-cap] recommendation), which Phase 19.5 then used:
  // the list now sits AT the cap (75/75), so the NEXT dispatchable tool
  // needs a new raise. It guards the DISPATCH whitelist, not the wire
  // payload: the ADVERTISED set is the much smaller core list
  // (BYOK_CORE_TOOL_NAMES), which is what the 13.5 token budget guards;
  // this cap only stops the dispatchable whitelist from growing unnoticed.
  if (BYOK_TOOL_NAMES.length > 75) {
    problems.push(
      `The default tool set has ${
        BYOK_TOOL_NAMES.length
      } tools — the cap is 75.`
    );
  }

  // Every core (advertised) name must be a real whitelisted tool: a typo
  // here would silently drop a tool from the model's view.
  for (const coreName of BYOK_CORE_TOOL_NAMES) {
    if (
      !BYOK_TOOL_NAMES.includes(coreName) &&
      !BYOK_NO_PROJECT_TOOL_NAMES.includes(coreName)
    ) {
      problems.push(`Core tool "${coreName}" is not in the whitelist.`);
    }
  }

  for (const schema of schemas) {
    collectSchemaProblems(schema, registry, problems);
  }

  return problems;
};
