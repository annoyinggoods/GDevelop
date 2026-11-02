// @flow
import {
  BYOK_CORE_TOOL_NAMES,
  BYOK_NO_PROJECT_TOOL_NAMES,
  BYOK_TOOL_NAMES,
  getByokAdvertisedToolNames,
  getByokDispatchableToolNames,
  getByokToolSchemas,
  getByokToolSchemasForNames,
  toOpenAiToolsFormat,
  validateByokToolSchemas,
} from './ByokToolSchema';
import {
  editorFunctions,
  editorFunctionsWithoutProject,
} from '../../EditorFunctions';

const FULL_REGISTRY: any = {};
for (const toolName of Object.keys(editorFunctions)) {
  FULL_REGISTRY[toolName] = (editorFunctions: any)[toolName];
}
for (const toolName of Object.keys(editorFunctionsWithoutProject)) {
  FULL_REGISTRY[toolName] = (editorFunctionsWithoutProject: any)[toolName];
}

describe('validateByokToolSchemas', () => {
  it('returns no problem: the whitelist and its schemas are in sync with the registry', () => {
    expect(validateByokToolSchemas()).toEqual([]);
  });

  it('catches a whitelisted name that disappears from the registry (upstream rename)', () => {
    const renamedRegistry = { ...FULL_REGISTRY };
    delete renamedRegistry['create_scene'];

    const problems = validateByokToolSchemas(renamedRegistry);
    expect(problems).toEqual([
      'Tool "create_scene" is not in the editorFunctions registry.',
    ]);
  });

  it('catches an unknown property type, including inside array items', () => {
    const schemaCopy = getByokToolSchemas().map(schema => ({ ...schema }));
    const planSchema = schemaCopy.find(
      schema => schema.name === 'create_or_update_plan'
    );
    if (!planSchema) throw new Error('plan schema not found');
    planSchema.parameters = JSON.parse(JSON.stringify(planSchema.parameters));
    planSchema.parameters.properties.tasks.items.properties.id.type = 'strng';

    const problems = validateByokToolSchemas(FULL_REGISTRY, schemaCopy);
    expect(problems).toEqual([
      expect.stringContaining('unknown property type: strng'),
    ]);
    expect(problems[0]).toContain('tasks.items.id');
  });

  it('catches a schema without a description', () => {
    const schemaCopy = getByokToolSchemas().map(schema => ({ ...schema }));
    const describeSchema = schemaCopy.find(
      schema => schema.name === 'describe_instances'
    );
    if (!describeSchema) throw new Error('describe_instances schema not found');
    describeSchema.description = '';

    const problems = validateByokToolSchemas(FULL_REGISTRY, schemaCopy);
    expect(problems).toEqual(['Tool "describe_instances" has no description.']);
  });

  it('catches a whitelisted tool whose schema is missing', () => {
    const schemaCopy = getByokToolSchemas().filter(
      schema => schema.name !== 'add_behavior'
    );

    const problems = validateByokToolSchemas(FULL_REGISTRY, schemaCopy);
    expect(problems).toContain(
      'Whitelisted tool "add_behavior" has no schema.'
    );
    expect(problems).toContain(
      'Some tools of the whitelist have no schema (or the opposite).'
    );
  });

  it('enforces the tool-count cap on the default set', () => {
    // The cap is the Phase 6 budget (22 Phase 5 tools + 9 Phase 6 tools)
    // grown by the two Phase 7 knowledge tools (search_reference,
    // load_skill): every advertised schema is billed as input tokens on
    // every turn, so the guard exists to force a conscious decision when
    // the surface grows again.
    // The cap moved to 48 (Phase 8), 56 (Phase 11), 62 (Phase 12), 64,
    // then 69 (Phase 15.3, the five game-code tools), then 71 (Phase 16.5,
    // the two asset-optimization tools), then 75 (Phases 17.7 + 18.3 took
    // the list to 74 with the two asset-tag tools and scan_scene_events; the
    // raise covers Phase 19's sprite-sheet tool too — owner-approved per the
    // usertasks §6 [P1719-cap] recommendation, like every raise: it guards
    // the dispatch whitelist, not the advertised wire payload) —
    // see the counting comment in ByokToolSchema.js.
    expect(BYOK_TOOL_NAMES.length).toBeLessThanOrEqual(75);
    expect(BYOK_TOOL_NAMES.length).toBeGreaterThanOrEqual(30);
    expect(validateByokToolSchemas()).toEqual([]);
  });
});

describe('BYOK_TOOL_NAMES (the v4 whitelist)', () => {
  it('contains the Phase 5 additions (parity surface + local event writing)', () => {
    const phase5Additions = [
      'put_3d_instances',
      'inspect_object_properties_effects',
      'change_object_properties_effects',
      'inspect_behavior_properties',
      'inspect_scene_properties_layers_effects',
      'change_scene_properties_layers_effects_groups',
      'inspect_project_properties_resources',
      'change_project_properties_resources',
      'read_events_source',
      'add_scene_events',
      'run_script',
    ];
    for (const toolName of phase5Additions) {
      expect(BYOK_TOOL_NAMES).toContain(toolName);
    }
  });

  it('contains the Phase 6 additions (perception + gameplay tests)', () => {
    const phase6Additions = [
      'capture_scene_screenshot',
      'capture_preview_screenshot',
      'start_preview',
      'stop_preview',
      'read_preview_logs',
      'get_runtime_errors',
      'inspect_runtime_state',
      'run_gameplay_test',
      'change_gameplay_tests',
    ];
    for (const toolName of phase6Additions) {
      expect(BYOK_TOOL_NAMES).toContain(toolName);
    }
  });

  it('keeps the no-project-only tools out of the default set', () => {
    expect(BYOK_TOOL_NAMES).not.toContain('initialize_project');
    // get_game_starter_summary joined in Phase 12 (D12-1): the starter
    // catalog is only useful before a project exists.
    expect(BYOK_TOOL_NAMES).not.toContain('get_game_starter_summary');
    expect(BYOK_NO_PROJECT_TOOL_NAMES).toEqual([
      'initialize_project',
      'get_game_starter_summary',
      // audit011026 B-PROMPT-1: the docs-min drill-down of the whole
      // minified wiki — useful with and without a project, advertised
      // without one (search_knowledge tags find it otherwise).
      'read_doc_page',
    ]);
  });

  it('does not expose the excluded tools (server stubs, legacy aliases, dupes)', () => {
    // run_explorer_agent left this list in Phase 8: it is intercepted
    // client-side (the scout sub-agent) before the registry stub. Only
    // run_edit_agent stays excluded (sequential edits belong to the main
    // context). The store searches and get_game_starter_summary left this
    // list in Phase 12 (local implementations over the public catalogs,
    // D12-1).
    const excludedTools = [
      'run_edit_agent',
      // Still excluded: the raw "read the whole docs" server tool — Phase 7
      // exposes search_docs + read_doc (the bundled subset) instead.
      'read_full_docs',
      'run_tests',
      'report_fulfilment_problem',
      // Legacy aliases (canonical names only in BYOK).
      'inspect_object_properties',
      'change_object_property',
      'remove_behavior',
      // Covered by create_or_replace_object.
      'create_object',
    ];
    for (const excludedTool of excludedTools) {
      expect(BYOK_TOOL_NAMES).not.toContain(excludedTool);
      expect(BYOK_NO_PROJECT_TOOL_NAMES).not.toContain(excludedTool);
    }
  });
});

describe('advertisement and dispatchability', () => {
  it('advertises the core set (+ no-project tools without a project) since 13.5', () => {
    const withProject = getByokAdvertisedToolNames({ hasOpenedProject: true });
    const withoutProject = getByokAdvertisedToolNames({
      hasOpenedProject: false,
    });

    expect(withProject).toEqual(BYOK_CORE_TOOL_NAMES);
    // The union, deduped: a tool named by both sets (read_doc_page, which
    // is core now and still listed as project-independent) must not be
    // advertised twice — a duplicate `tools` entry is rejected by strict
    // endpoints (audit100226 TOOL-11).
    expect(withoutProject).toEqual(
      Array.from(
        new Set([...BYOK_CORE_TOOL_NAMES, ...BYOK_NO_PROJECT_TOOL_NAMES])
      )
    );
    expect(new Set(withoutProject).size).toBe(withoutProject.length);
    expect(withoutProject).toContain('initialize_project');
    // read_doc_page is advertised with a project open too: the retrieval
    // map, the search_knowledge description and every docs-min chunk teach
    // it, so the prompt must offer it in the common case.
    expect(withProject).toContain('read_doc_page');
    // The non-core catalog stays dispatchable, just not advertised.
    expect(withProject).not.toContain('list_effects');
    expect(getByokDispatchableToolNames()).toContain('list_effects');
  });

  it('dispatches the unadvertised generate_events alias too', () => {
    const dispatchable = getByokDispatchableToolNames();
    expect(dispatchable).toContain('generate_events');
    expect(
      getByokAdvertisedToolNames({ hasOpenedProject: true })
    ).not.toContain('generate_events');
  });
});

describe('getByokToolSchemas', () => {
  const schemas = getByokToolSchemas();

  it('has exactly one schema per whitelisted tool (default + no-project sets)', () => {
    expect(schemas.map(schema => schema.name).sort()).toEqual(
      [...BYOK_TOOL_NAMES, ...BYOK_NO_PROJECT_TOOL_NAMES].sort()
    );
  });

  it('gives every schema a name, a description and object parameters', () => {
    for (const schema of schemas) {
      expect(typeof schema.name).toBe('string');
      expect(schema.name.length).toBeGreaterThan(0);
      expect(typeof schema.description).toBe('string');
      expect(schema.description.length).toBeGreaterThan(10);
      expect(schema.parameters.type).toBe('object');
      expect(typeof schema.parameters.properties).toBe('object');
      expect(Array.isArray(schema.parameters.required)).toBe(true);
    }
  });

  it('only requires properties that are defined', () => {
    for (const schema of schemas) {
      for (const requiredProperty of schema.parameters.required) {
        expect(schema.parameters.properties[requiredProperty]).toBeDefined();
      }
    }
  });

  it('filters the schemas by the advertised names', () => {
    const advertised = getByokAdvertisedToolNames({ hasOpenedProject: true });
    const filtered = getByokToolSchemasForNames(advertised);
    expect(filtered.map(schema => schema.name).sort()).toEqual(
      advertised.slice().sort()
    );
  });

  it('requires exactly what create_scene extracts (spot check)', () => {
    const createSceneSchema = schemas.find(
      schema => schema.name === 'create_scene'
    );
    if (!createSceneSchema) throw new Error('create_scene schema not found');

    // The implementation reads scene_name (required), include_ui_layer,
    // background_color and is_first_scene (optional) — and nothing else.
    expect(createSceneSchema.parameters.required).toEqual(['scene_name']);
    expect(Object.keys(createSceneSchema.parameters.properties).sort()).toEqual(
      ['background_color', 'include_ui_layer', 'is_first_scene', 'scene_name']
    );
  });

  it('requires exactly what run_script reads', () => {
    const runScriptSchema = schemas.find(
      schema => schema.name === 'run_script'
    );
    if (!runScriptSchema) throw new Error('run_script schema not found');

    expect(runScriptSchema.parameters.required).toEqual(['js_code']);
    expect(Object.keys(runScriptSchema.parameters.properties).sort()).toEqual([
      'js_code',
      'title',
    ]);
  });

  it('requires exactly what initialize_project reads (template_slug is required upstream)', () => {
    const initializeSchema = schemas.find(
      schema => schema.name === 'initialize_project'
    );
    if (!initializeSchema) throw new Error('initialize_project not found');

    expect(initializeSchema.parameters.required).toEqual([
      'project_name',
      'template_slug',
    ]);
    expect(Object.keys(initializeSchema.parameters.properties).sort()).toEqual([
      'also_read_existing_events',
      'project_name',
      'template_slug',
    ]);
  });

  it('pins the add_scene_events batch contract the writer implements', () => {
    const addEventsSchema = schemas.find(
      schema => schema.name === 'add_scene_events'
    );
    if (!addEventsSchema) throw new Error('add_scene_events not found');

    expect(addEventsSchema.parameters.required).toEqual([
      'scene_name',
      'event_batches',
    ]);
    const batchProperties =
      addEventsSchema.parameters.properties.event_batches.items.properties;
    expect(Object.keys(batchProperties).sort()).toEqual([
      'event_script',
      'expected_event_source',
      'placement_expected_parent_event_id',
      'placement_relation',
      'placement_target_event_id',
    ]);
    expect(batchProperties.placement_relation.enum).toEqual([
      'insert_at_end',
      'insert_and_replace_event',
      'replace_entire_event_and_sub_events',
      'replace_event_but_keep_existing_sub_events',
      'insert_before_event',
      'insert_after_event',
      'insert_as_sub_event',
      'delete_event',
    ]);
  });

  it('pins the run_gameplay_test contract (approval distinguishes persist vs probe)', () => {
    const runTestSchema = schemas.find(
      schema => schema.name === 'run_gameplay_test'
    );
    if (!runTestSchema) throw new Error('run_gameplay_test not found');

    expect(runTestSchema.parameters.required).toEqual(['scope', 'test_name']);
    const properties = runTestSchema.parameters.properties;
    expect(Object.keys(properties).sort()).toEqual([
      'description',
      'persist',
      'scope',
      'screenshots',
      'source',
      'test_name',
      'timeout_ms',
    ]);
    expect(properties.screenshots.enum).toEqual(['on-failure', 'off']);
  });

  it('pins the put_2d_instances property set (16 properties, highest-risk schema)', () => {
    const put2dSchema = schemas.find(
      schema => schema.name === 'put_2d_instances'
    );
    if (!put2dSchema) throw new Error('put_2d_instances schema not found');

    expect(put2dSchema.parameters.required).toEqual([
      'scene_name',
      'layer_name',
      'brush_kind',
    ]);
    expect(Object.keys(put2dSchema.parameters.properties).sort()).toEqual(
      [
        'brush_end_position',
        'brush_kind',
        'brush_position',
        'brush_size',
        'column_count',
        'existing_instance_ids',
        'instances_hidden',
        'instances_opacity',
        'instances_rotation',
        'instances_size',
        'instances_z_order',
        'new_instances_count',
        'object_name',
        'row_count',
        'scene_name',
        'layer_name',
      ].sort()
    );
    // The description must not promise a default the implementation does
    // not have: omitting brush_position fails every placement brush.
    expect(
      put2dSchema.parameters.properties.brush_position.description
    ).not.toContain('scene center when omitted');
    expect(
      put2dSchema.parameters.properties.brush_position.description
    ).toContain('Required when creating instances');
  });

  it('pins the create_or_replace_object property set (11 properties)', () => {
    const createObjectSchema = schemas.find(
      schema => schema.name === 'create_or_replace_object'
    );
    if (!createObjectSchema) {
      throw new Error('create_or_replace_object not found');
    }

    expect(createObjectSchema.parameters.required).toEqual([
      'scene_name',
      'object_name',
    ]);
    expect(
      Object.keys(createObjectSchema.parameters.properties).sort()
    ).toEqual([
      'asset_id',
      'description',
      'duplicated_object_name',
      'duplicated_object_scene',
      'object_name',
      'object_type',
      'replace_existing_object',
      'scene_name',
      'search_terms',
      'target_object_scope',
      'two_dimensional_view_kind',
    ]);
  });

  it('pins the add_or_edit_variable nested operation keys', () => {
    const variablesSchema = schemas.find(
      schema => schema.name === 'add_or_edit_variable'
    );
    if (!variablesSchema) throw new Error('add_or_edit_variable not found');

    const operationItems =
      variablesSchema.parameters.properties.variables.items;
    expect(Object.keys(operationItems.properties).sort()).toEqual([
      'delete_this_variable',
      'value',
      'variable_name_or_path',
      'variable_type',
    ]);
  });

  it('pins the plan task contract the orchestrator parses', () => {
    const planSchema = schemas.find(
      schema => schema.name === 'create_or_update_plan'
    );
    if (!planSchema) throw new Error('plan schema not found');

    expect(planSchema.parameters.required).toEqual(['tasks']);
    const taskProperties =
      planSchema.parameters.properties.tasks.items.properties;
    expect(Object.keys(taskProperties).sort()).toEqual([
      'depends_on',
      'description',
      'id',
      'status',
      'title',
    ]);
    expect(taskProperties.status.enum).toEqual([
      'pending',
      'in_progress',
      'done',
      'voided',
    ]);
  });

  it('pins the Phase 11 extended-tool fields (the model discovers them here)', () => {
    const findSchema = (name: string) => {
      const schema = schemas.find(candidate => candidate.name === name);
      if (!schema) throw new Error(`${name} schema not found`);
      return schema;
    };

    // change_extension_properties_BYOK: dependency management.
    const extensionProperties = findSchema('change_extension_properties_BYOK')
      .parameters.properties;
    expect(
      Object.keys(extensionProperties.dependencies_to_add.items.properties)
    ).toEqual(['name', 'export_name', 'version', 'dependency_type']);
    expect(extensionProperties.dependencies_to_remove.items.type).toBe(
      'string'
    );

    // change_custom_object_BYOK: child management (with initial values).
    const objectProperties = findSchema('change_custom_object_BYOK').parameters
      .properties;
    const childItems = objectProperties.children_to_add.items.properties;
    expect(Object.keys(childItems)).toEqual([
      'name',
      'object_type',
      'initial_properties',
    ]);
    expect(Object.keys(childItems.initial_properties.items.properties)).toEqual(
      ['name', 'value']
    );
    expect(objectProperties.children_to_remove.items.type).toBe('string');

    // change_custom_function_BYOK: parameter management (incl. type changes).
    const functionProperties = findSchema('change_custom_function_BYOK')
      .parameters.properties;
    expect(
      Object.keys(functionProperties.parameters_to_add.items.properties)
    ).toEqual(['name', 'type', 'description']);
    expect(functionProperties.parameters_to_remove.items.type).toBe('string');
    expect(
      Object.keys(functionProperties.parameters_to_move.items.properties)
    ).toEqual(['name', 'to_index']);
  });
});

describe('toOpenAiToolsFormat', () => {
  it('wraps each schema in the OpenAI function tool format', () => {
    const schemas = getByokToolSchemas();
    const tools = toOpenAiToolsFormat(schemas);

    expect(tools).toHaveLength(schemas.length);
    for (let index = 0; index < tools.length; index++) {
      expect(tools[index].type).toBe('function');
      expect(tools[index].function.name).toBe(schemas[index].name);
      expect(tools[index].function.description).toBe(
        schemas[index].description
      );
      expect(tools[index].function.parameters).toEqual(
        schemas[index].parameters
      );
    }
  });

  it('produces a JSON-serializable tools array (the request body format)', () => {
    expect(
      JSON.parse(JSON.stringify(toOpenAiToolsFormat(getByokToolSchemas())))
    ).toEqual(toOpenAiToolsFormat(getByokToolSchemas()));
  });
});
