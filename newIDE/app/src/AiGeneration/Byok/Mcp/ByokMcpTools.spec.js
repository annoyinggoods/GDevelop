// @flow
import {
  BYOK_MCP_GET_PROJECT_OVERVIEW_TOOL_NAME,
  BYOK_MCP_OUTPUT_CAP,
  BYOK_MCP_READ_ONLY_REJECTION_MESSAGE,
  buildByokMcpPlanToolResult,
  buildByokMcpProjectOverviewResult,
  byokMcpCallIsAllowed,
  capByokMcpOutput,
  makeByokMcpToolDescriptors,
  mapByokExtraToolResultToMcpContent,
  mapEditorFunctionCallResultToMcpContent,
  parseByokImageDataUrl,
  runByokMcpToolCall,
} from './ByokMcpTools';
import { getByokToolSchemasForNames } from '../ByokToolSchema';
import { restoreByokImage } from '../ByokImageContent';

const makeFakeHost = (overrides?: Object): any => ({
  id: 1,
  executeRegistryTool: jest.fn(),
  executeExtraTool: jest.fn(),
  getExtraTool: (jest.fn(): any).mockReturnValue(null),
  editorFunctions: {},
  editorFunctionsWithoutProject: {},
  getProject: (jest.fn(): any).mockReturnValue(null),
  getSettings: (jest.fn(): any).mockReturnValue({
    mcpServer: { enabled: true, accessMode: 'read-write' },
  }),
  ...overrides,
});

const parseText = (result: any): Object => JSON.parse(result.content[0].text);

describe('makeByokMcpToolDescriptors', () => {
  it('advertises initialize_project only while no project is open', () => {
    const withoutProject = makeByokMcpToolDescriptors({
      hasOpenedProject: false,
    }).map(descriptor => descriptor.name);
    expect(withoutProject).toContain('initialize_project');

    const withProject = makeByokMcpToolDescriptors({
      hasOpenedProject: true,
    }).map(descriptor => descriptor.name);
    expect(withProject).not.toContain('initialize_project');
  });

  it('advertises the BYOK-only intercepted tools too', () => {
    const names = makeByokMcpToolDescriptors({ hasOpenedProject: true }).map(
      descriptor => descriptor.name
    );
    expect(names).toContain('load_skill');
    expect(names).toContain('capture_scene_screenshot');
    expect(names).toContain('run_explorer_agent');
    expect(names).toContain('create_extension_BYOK');
    expect(names).toContain('run_script');
  });

  it('appends the MCP-native overview tool', () => {
    const descriptors = makeByokMcpToolDescriptors({ hasOpenedProject: true });
    const overview = descriptors.find(
      descriptor => descriptor.name === BYOK_MCP_GET_PROJECT_OVERVIEW_TOOL_NAME
    );
    expect(overview).toBeDefined();
    expect(overview && overview.inputSchema).toEqual({
      type: 'object',
      properties: {},
      required: [],
    });
  });

  it('passes the tool schemas through verbatim as inputSchema', () => {
    const descriptors = makeByokMcpToolDescriptors({ hasOpenedProject: true });
    const descriptor = descriptors.find(
      candidate => candidate.name === 'add_or_edit_variable'
    );
    const schema = getByokToolSchemasForNames(['add_or_edit_variable'])[0];
    expect(descriptor).toBeDefined();
    expect(descriptor && descriptor.inputSchema).toEqual(schema.parameters);
    expect(descriptor && descriptor.description).toBe(schema.description);
  });
});

describe('byokMcpCallIsAllowed', () => {
  it('allows everything in read-write mode', () => {
    expect(
      byokMcpCallIsAllowed({ modifiesProject: true }, {}, 'read-write')
    ).toBe(true);
  });

  it('gates modifying tools in read-only mode, from the same metadata the approval row reads', () => {
    expect(
      byokMcpCallIsAllowed({ modifiesProject: true }, {}, 'read-only')
    ).toBe(false);
    expect(
      byokMcpCallIsAllowed({ modifiesProject: false }, {}, 'read-only')
    ).toBe(true);
    expect(
      byokMcpCallIsAllowed(
        { getModifiesProject: args => args.destructive === true },
        { destructive: true },
        'read-only'
      )
    ).toBe(false);
    expect(
      byokMcpCallIsAllowed(
        { getModifiesProject: args => args.destructive === true },
        { destructive: false },
        'read-only'
      )
    ).toBe(true);
  });

  it('allows unknown metadata in read-only mode (it is refused as unknown earlier)', () => {
    expect(byokMcpCallIsAllowed(null, {}, 'read-only')).toBe(true);
  });
});

describe('capByokMcpOutput', () => {
  it('passes short outputs through unchanged', () => {
    expect(capByokMcpOutput('{"success":true}')).toBe('{"success":true}');
  });

  it('cuts long outputs with an explicit marker', () => {
    const long = 'x'.repeat(BYOK_MCP_OUTPUT_CAP + 100);
    const capped = capByokMcpOutput(long);
    expect(capped.length).toBeLessThan(long.length);
    expect(capped.endsWith('[truncated by the GDevelop MCP server]')).toBe(
      true
    );
  });
});

describe('mapEditorFunctionCallResultToMcpContent', () => {
  it('serializes a finished success as { success, ...output } with no error flag', () => {
    const result = mapEditorFunctionCallResultToMcpContent({
      status: 'finished',
      call_id: 'c1',
      success: true,
      output: { message: 'Scene created.' },
    });
    expect(result.isError).toBeUndefined();
    expect(parseText(result)).toEqual({
      success: true,
      message: 'Scene created.',
    });
  });

  it('flags a finished failure with isError', () => {
    const result = mapEditorFunctionCallResultToMcpContent({
      status: 'finished',
      call_id: 'c2',
      success: false,
      output: { message: 'The scene does not exist.' },
    });
    expect(result.isError).toBe(true);
    expect(parseText(result).success).toBe(false);
  });

  it('gives aborted or unfinished calls the same synthetic failure the chat loop appends', () => {
    const result = mapEditorFunctionCallResultToMcpContent({
      status: 'aborted',
      call_id: 'c3',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('aborted');
  });
});

describe('mapByokExtraToolResultToMcpContent', () => {
  it('serializes the extra-tool output verbatim and flags failures', () => {
    const success = mapByokExtraToolResultToMcpContent({
      output: { success: true, skill: 'loaded' },
      didModifyProject: false,
    });
    expect(success.isError).toBeUndefined();
    expect(parseText(success)).toEqual({ success: true, skill: 'loaded' });

    const failure = mapByokExtraToolResultToMcpContent({
      output: { success: false, message: 'No such skill.' },
      didModifyProject: false,
    });
    expect(failure.isError).toBe(true);
  });

  it('materializes referenced image ids into MCP image content parts', () => {
    restoreByokImage({
      id: 'mcp-spec-img',
      dataUrl: 'data:image/png;base64,QUJD',
      width: 10,
      height: 10,
    });
    const result = mapByokExtraToolResultToMcpContent({
      output: { success: true },
      didModifyProject: false,
      images: ['mcp-spec-img', 'mcp-spec-missing'],
    });
    expect(result.content.length).toBe(2);
    expect(result.content[1]).toEqual({
      type: 'image',
      data: 'QUJD',
      mimeType: 'image/png',
    });
  });
});

describe('parseByokImageDataUrl', () => {
  it('splits a data URL into mime type and base64 payload', () => {
    expect(parseByokImageDataUrl('data:image/jpeg;base64,QUJD')).toEqual({
      mimeType: 'image/jpeg',
      data: 'QUJD',
    });
  });

  it('rejects non-base64 data URLs', () => {
    expect(parseByokImageDataUrl('data:text/plain,hello')).toBeNull();
    expect(parseByokImageDataUrl('not a data url')).toBeNull();
  });
});

describe('buildByokMcpPlanToolResult', () => {
  it('echoes the tasks back with depends_on normalized to dependsOn', () => {
    const result = buildByokMcpPlanToolResult({
      tasks: [
        { id: 'a', label: 'Create scene', depends_on: ['b'] },
        { id: 'b', label: 'Add events' },
      ],
    });
    expect(result.isError).toBeUndefined();
    const parsed = parseText(result);
    expect(parsed.success).toBe(true);
    expect(parsed.plan.tasks[0].dependsOn).toEqual(['b']);
    expect(parsed.plan.tasks[1].dependsOn).toEqual([]);
  });

  it('refuses a call without a tasks array', () => {
    const result = buildByokMcpPlanToolResult({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('tasks');
  });
});

describe('buildByokMcpProjectOverviewResult', () => {
  const makeBuilderMaker = (snapshot: any) => () => ({
    getSimplifiedProject: (jest.fn(): any).mockReturnValue(snapshot),
  });

  it('answers explicitly when no project is open', () => {
    const result = buildByokMcpProjectOverviewResult(null);
    expect(result.content).toEqual([
      { type: 'text', text: '{"hasOpenProject": false}' },
    ]);
  });

  it('wraps the snapshot (object or JSON string) in the overview envelope', () => {
    const objectResult = buildByokMcpProjectOverviewResult(
      { fake: 'project' },
      makeBuilderMaker({ name: 'My game' })
    );
    expect(parseText(objectResult)).toEqual({
      hasOpenProject: true,
      simplifiedProject: { name: 'My game' },
    });

    const stringResult = buildByokMcpProjectOverviewResult(
      { fake: 'project' },
      makeBuilderMaker('{"name":"My game"}')
    );
    expect(parseText(stringResult).simplifiedProject).toEqual({
      name: 'My game',
    });
  });

  it('reports an unbuildable snapshot as an error', () => {
    const result = buildByokMcpProjectOverviewResult(
      { fake: 'project' },
      makeBuilderMaker(42)
    );
    expect(result.isError).toBe(true);
  });
});

describe('runByokMcpToolCall', () => {
  it('dispatches the overview and plan tools without touching the executors', async () => {
    const host = makeFakeHost();
    const overview = await runByokMcpToolCall(
      { name: BYOK_MCP_GET_PROJECT_OVERVIEW_TOOL_NAME, args: {} },
      'call-1',
      host
    );
    expect(overview.outcome).toBe('completed');
    expect(overview.didModifyProject).toBe(false);
    expect(parseText(overview.result)).toEqual({ hasOpenProject: false });

    const plan = await runByokMcpToolCall(
      { name: 'create_or_update_plan', args: { tasks: [{ id: 'a' }] } },
      'call-2',
      host
    );
    expect(plan.outcome).toBe('completed');
    expect(host.executeRegistryTool).not.toHaveBeenCalled();
    expect(host.executeExtraTool).not.toHaveBeenCalled();
  });

  it('routes extra tools to executeExtraTool', async () => {
    const host = makeFakeHost({
      getExtraTool: (jest.fn(): any).mockReturnValue({
        name: 'load_skill',
        modifiesProject: false,
      }),
      executeExtraTool: (jest.fn(): any).mockResolvedValue({
        output: { success: true, body: '...' },
        didModifyProject: false,
      }),
    });
    const detailed = await runByokMcpToolCall(
      { name: 'load_skill', args: { skill: 'byok-build-workflow' } },
      'call-3',
      host
    );
    expect(host.executeExtraTool).toHaveBeenCalledWith('load_skill', {
      skill: 'byok-build-workflow',
    });
    expect(detailed.outcome).toBe('completed');
  });

  it('routes an extra tool to executeExtraTool and a plain registry tool to executeRegistryTool', async () => {
    // An intercepted tool is ours BY NAME (the extension tools carry a
    // `_BYOK` suffix), so a name that resolves to an extra tool always runs
    // the extra tool — even when the editor registry has an entry with the
    // same name (the fork deliberately bypasses it).
    const extra = makeFakeHost({
      getExtraTool: (jest.fn(): any).mockReturnValue({
        name: 'add_scene_events',
        modifiesProject: true,
      }),
      editorFunctions: { add_scene_events: { modifiesProject: true } },
      executeExtraTool: (jest.fn(): any).mockResolvedValue({
        output: { success: true, message: 'done' },
        didModifyProject: true,
      }),
    });
    const detailed = await runByokMcpToolCall(
      { name: 'add_scene_events', args: { sceneName: 'Menu' } },
      'call-4',
      extra
    );
    expect(extra.executeExtraTool).toHaveBeenCalledWith('add_scene_events', {
      sceneName: 'Menu',
    });
    expect(extra.executeRegistryTool).not.toHaveBeenCalled();
    expect(detailed.result.isError).toBeUndefined();

    // A name that is not intercepted goes to the editor registry.
    const registry = makeFakeHost({
      getExtraTool: (jest.fn(): any).mockReturnValue(null),
      editorFunctions: { describe_instances: { modifiesProject: false } },
      executeRegistryTool: (jest.fn(): any).mockResolvedValue({
        status: 'finished',
        call_id: 'call-5',
        success: true,
        output: { ok: 1 },
      }),
    });
    await runByokMcpToolCall(
      { name: 'describe_instances', args: { sceneName: 'Menu' } },
      'call-5',
      registry
    );
    expect(registry.executeRegistryTool).toHaveBeenCalledWith(
      'describe_instances',
      JSON.stringify({ sceneName: 'Menu' }),
      'call-5'
    );
  });

  it('rejects modifying calls in read-only mode with the unlocking instructions', async () => {
    const host = makeFakeHost({
      getSettings: (jest.fn(): any).mockReturnValue({
        mcpServer: { enabled: true, accessMode: 'read-only' },
      }),
      editorFunctions: { create_scene: { modifiesProject: true } },
    });
    const detailed = await runByokMcpToolCall(
      { name: 'create_scene', args: { sceneName: 'Menu' } },
      'call-5',
      host
    );
    expect(detailed.outcome).toBe('rejected');
    expect(detailed.didModifyProject).toBe(false);
    expect(detailed.result.isError).toBe(true);
    expect(detailed.result.content[0].text).toBe(
      BYOK_MCP_READ_ONLY_REJECTION_MESSAGE
    );
  });

  it('refuses unknown tools as failed', async () => {
    const detailed = await runByokMcpToolCall(
      { name: 'not_a_tool', args: {} },
      'call-6',
      makeFakeHost()
    );
    expect(detailed.outcome).toBe('failed');
    expect(detailed.result.isError).toBe(true);
  });

  it('reports a crashed executor as failed, never as a thrown error', async () => {
    const host = makeFakeHost({
      editorFunctions: { create_scene: { modifiesProject: true } },
      executeRegistryTool: (jest.fn(): any).mockRejectedValue(
        new Error('project closed')
      ),
    });
    const detailed = await runByokMcpToolCall(
      { name: 'create_scene', args: {} },
      'call-7',
      host
    );
    expect(detailed.outcome).toBe('failed');
    expect(detailed.result.isError).toBe(true);
    expect(detailed.result.content[0].text).toContain('project closed');
  });
});

describe('ByokMcpTools: read-only refuses durable agent-state writes (MCP-7)', () => {
  it('blocks update_project_notes in read-only mode', () => {
    // It is modifiesProject:false (no gd object changes), so the chat's
    // approval row correctly ignores it — but a read-only MCP server
    // promises "no changes", and the notes are injected into the system
    // prompt of every future BYOK chat.
    expect(
      byokMcpCallIsAllowed(
        { modifiesProject: false },
        { conventions: 'x' },
        'read-only',
        'update_project_notes'
      )
    ).toBe(false);
  });

  it('allows it in read-write mode', () => {
    expect(
      byokMcpCallIsAllowed(
        { modifiesProject: false },
        { conventions: 'x' },
        'read-write',
        'update_project_notes'
      )
    ).toBe(true);
  });

  it('blocks set_asset_optimization_settings in read-only mode (Phase 16.5)', () => {
    // Also modifiesProject:false — it writes app preferences, not the
    // project — but it durably changes what every later export writes to
    // disk, so a read-only external agent must not persist it either.
    expect(
      byokMcpCallIsAllowed(
        { modifiesProject: false },
        { enabled: true },
        'read-only',
        'set_asset_optimization_settings'
      )
    ).toBe(false);
    // Its read-only sibling stays allowed.
    expect(
      byokMcpCallIsAllowed(
        { modifiesProject: false },
        {},
        'read-only',
        'report_asset_optimization'
      )
    ).toBe(true);
  });

  it('allows it in read-write mode', () => {
    expect(
      byokMcpCallIsAllowed(
        { modifiesProject: false },
        { enabled: true },
        'read-write',
        'set_asset_optimization_settings'
      )
    ).toBe(true);
  });

  it('leaves genuinely read-only tools allowed in read-only mode', () => {
    expect(
      byokMcpCallIsAllowed(
        { modifiesProject: false },
        {},
        'read-only',
        'read_project_notes'
      )
    ).toBe(true);
  });
});
