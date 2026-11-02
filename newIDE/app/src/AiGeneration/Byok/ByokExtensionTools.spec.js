// @flow
import {
  flushByokExtensionRegeneration,
  findByokExtensionUsages,
  getByokExtensionTools,
  resetByokExtensionBatchForTests,
} from './ByokExtensionTools';
import { findByNameokExtraTool } from './ByokExtraTools';
import { getByokDispatchableToolNames } from './ByokToolSchema';

/**
 * The extension authoring tools (Phase 8.4) drive libGD directly — the
 * tests use the real WASM build (the established pattern, see
 * ByokLocalEventWriter.spec.js).
 */
const gd: libGDevelop = global.gd;

const makeCollaborators = (project: any, overrides: Object = {}) => ({
  getProject: () => project,
  onSceneEventsModifiedOutsideEditor: (jest.fn(): any),
  ...overrides,
});

const runTool = async (
  name: string,
  args: Object,
  collaborators: Object
): Promise<any> => {
  const tool = findByNameokExtraTool(name);
  if (!tool) throw new Error(`Tool "${name}" not intercepted.`);
  return tool.run(args, collaborators);
};

describe('ByokExtensionTools: registration and guards', () => {
  it('registers every tool in the interception registry', () => {
    const names = getByokExtensionTools().map(tool => tool.name);
    expect(names).toEqual([
      'create_extension_BYOK',
      'change_extension_properties_BYOK',
      'create_custom_object_BYOK',
      'change_custom_object_BYOK',
      'create_custom_behavior_BYOK',
      'change_custom_behavior_BYOK',
      'create_custom_function_BYOK',
      'change_custom_function_BYOK',
      'find_extension_usages_BYOK',
    ]);
    for (const name of names) {
      expect(findByNameokExtraTool(name)).toBeTruthy();
    }
    // Every tool is dispatchable through the standard whitelist.
    const dispatchable = new Set(getByokDispatchableToolNames());
    for (const name of names) {
      expect(dispatchable.has(name)).toBe(true);
    }
  });

  it('uses the _BYOK namespace, so no name can collide with upstream', () => {
    // Upstream ships its own extension authoring tools with the same names
    // but a different argument shape: the suffix keeps the two apart, so
    // the model always calls the implementation the schema describes.
    for (const name of getByokExtensionTools().map(tool => tool.name)) {
      expect(name.endsWith('_BYOK')).toBe(true);
    }
    // The upstream names are NOT advertised: they are the hosted agent's
    // tools, with another argument shape.
    const dispatchable = new Set(getByokDispatchableToolNames());
    expect(dispatchable.has('create_extension')).toBe(false);
    expect(dispatchable.has('create_extension_BYOK')).toBe(true);
  });
});

describe('ByokExtensionTools: create → change → regenerate', () => {
  let project: any = null;

  beforeEach(() => {
    resetByokExtensionBatchForTests();
    project = gd.ProjectHelper.createNewGDJSProject();
  });

  afterEach(() => {
    project.delete();
    project = null;
  });

  it('creates an extension, a custom behavior, a custom object and a function', async () => {
    const collaborators = makeCollaborators(project);

    const created = await runTool(
      'create_extension_BYOK',
      {
        extension_name: 'CoinLogic',
        full_name: 'Coin logic',
        version: '1.0.0',
      },
      collaborators
    );
    expect(created.output.success).toBe(true);
    expect(project.hasEventsFunctionsExtensionNamed('CoinLogic')).toBe(true);
    expect(project.getEventsFunctionsExtension('CoinLogic').getVersion()).toBe(
      '1.0.0'
    );

    const behavior = await runTool(
      'create_custom_behavior_BYOK',
      {
        extension_name: 'CoinLogic',
        custom_behavior_name: 'Magnet',
        description: 'Attracts coins',
      },
      collaborators
    );
    expect(behavior.output.success).toBe(true);
    expect(behavior.output.behavior_type).toBe('CoinLogic::Magnet');

    const object = await runTool(
      'create_custom_object_BYOK',
      {
        extension_name: 'CoinLogic',
        custom_object_name: 'Coin',
        default_name: 'Coin',
      },
      collaborators
    );
    expect(object.output.success).toBe(true);
    expect(object.output.object_type).toBe('CoinLogic::Coin');

    // A function with an EventScript body, on the behavior.
    const behaviorFunction = await runTool(
      'create_custom_function_BYOK',
      {
        extension_name: 'CoinLogic',
        custom_behavior_name: 'Magnet',
        function_name: 'applyMagnetForce',
        function_type: 'Action',
        event_script: 'always:\n  Wait(0.1)',
      },
      collaborators
    );
    expect(behaviorFunction.output.success).toBe(true);

    // A free expression function with typed parameters.
    const expression = await runTool(
      'create_custom_function_BYOK',
      {
        extension_name: 'CoinLogic',
        function_name: 'CountCoins',
        function_type: 'Expression',
        parameters: [
          { name: 'Multiplier', type: 'expression', description: 'The factor' },
        ],
        event_script: 'always:\n  Wait(0.05)',
      },
      collaborators
    );
    expect(expression.output.success).toBe(true);
    const extension = project.getEventsFunctionsExtension('CoinLogic');
    const eventsFunction = extension
      .getEventsFunctions()
      .getEventsFunction('CountCoins');
    expect(eventsFunction.isExpression()).toBe(true);
    expect(eventsFunction.getParameters().getParametersCount()).toBe(1);

    // The behavior function really carries the parsed events.
    const magnetFunctions = extension
      .getEventsBasedBehaviors()
      .get('Magnet')
      .getEventsFunctions();
    expect(magnetFunctions.hasEventsFunctionNamed('applyMagnetForce')).toBe(
      true
    );
    expect(
      magnetFunctions
        .getEventsFunction('applyMagnetForce')
        .getEvents()
        .getEventsCount()
    ).toBeGreaterThan(0);
  });

  it('copies an extension instead of creating an empty one', async () => {
    const collaborators = makeCollaborators(project);
    // A source extension with a function in it.
    await runTool(
      'create_extension_BYOK',
      { extension_name: 'Source' },
      collaborators
    );
    await runTool(
      'create_custom_function_BYOK',
      {
        extension_name: 'Source',
        function_name: 'DoThing',
        function_type: 'Action',
        event_script: 'always:\n  Wait(0.1)',
      },
      collaborators
    );

    const copied = await runTool(
      'create_extension_BYOK',
      { extension_name: 'Copy', duplicated_extension_name: 'Source' },
      collaborators
    );
    expect(copied.output.success).toBe(true);
    expect(copied.output.extension_name).toBe('Copy');

    // The copy holds the function of the source...
    const copy = project.getEventsFunctionsExtension('Copy');
    expect(copy.getEventsFunctions().hasEventsFunctionNamed('DoThing')).toBe(
      true
    );
    // ...and the source is untouched.
    expect(
      project
        .getEventsFunctionsExtension('Source')
        .getEventsFunctions()
        .hasEventsFunctionNamed('DoThing')
    ).toBe(true);
    // The copy is the user's own: no store origin.
    expect(copy.getOriginName()).toBe('');

    // The explicit settings win over the copied ones.
    const renamed = await runTool(
      'create_extension_BYOK',
      {
        extension_name: 'Copy2',
        duplicated_extension_name: 'Source',
        full_name: 'My copy',
      },
      collaborators
    );
    expect(renamed.output.success).toBe(true);
    expect(project.getEventsFunctionsExtension('Copy2').getFullName()).toBe(
      'My copy'
    );

    // A source that does not exist is refused, with nothing created.
    const missing = await runTool(
      'create_extension_BYOK',
      { extension_name: 'Copy3', duplicated_extension_name: 'Nope' },
      collaborators
    );
    expect(missing.output.success).toBe(false);
    expect(missing.output.message).toContain('not found');
    expect(project.hasEventsFunctionsExtensionNamed('Copy3')).toBe(false);
  });

  it('copies a function with its parameters and events', async () => {
    const collaborators = makeCollaborators(project);
    await runTool(
      'create_extension_BYOK',
      { extension_name: 'Ext' },
      collaborators
    );
    await runTool(
      'create_custom_function_BYOK',
      {
        extension_name: 'Ext',
        function_name: 'Source',
        function_type: 'Action',
        parameters: [{ name: 'Speed', type: 'expression' }],
        event_script: 'always:\n  Wait(0.1)',
      },
      collaborators
    );

    const copied = await runTool(
      'create_custom_function_BYOK',
      {
        extension_name: 'Ext',
        function_name: 'Copy',
        function_type: 'Action',
        duplicated_function_name: 'Source',
      },
      collaborators
    );
    expect(copied.output.success).toBe(true);

    const functions = project
      .getEventsFunctionsExtension('Ext')
      .getEventsFunctions();
    const copy = functions.getEventsFunction('Copy');
    expect(copy).toBeTruthy();
    // The parameters of the source came with the copy.
    expect(copy.getParameters().getParametersCount()).toBeGreaterThan(0);
    // The events of the source came with the copy.
    expect(copy.getEvents().getEventsCount()).toBeGreaterThan(0);
    // The source is untouched.
    expect(functions.getEventsFunction('Source')).toBeTruthy();

    // Passing `parameters` with a copy is refused (the copy keeps them).
    const refused = await runTool(
      'create_custom_function_BYOK',
      {
        extension_name: 'Ext',
        function_name: 'Copy2',
        function_type: 'Action',
        duplicated_function_name: 'Source',
        parameters: [{ name: 'Speed', type: 'expression' }],
      },
      collaborators
    );
    expect(refused.output.success).toBe(false);
    expect(functions.hasEventsFunctionNamed('Copy2')).toBe(false);

    // A source that does not exist is refused.
    const missing = await runTool(
      'create_custom_function_BYOK',
      {
        extension_name: 'Ext',
        function_name: 'Copy3',
        function_type: 'Action',
        duplicated_function_name: 'Nope',
      },
      collaborators
    );
    expect(missing.output.success).toBe(false);
    expect(missing.output.message).toContain('not found');
    expect(functions.hasEventsFunctionNamed('Copy3')).toBe(false);
  });

  it('sets what an Expression returns, and the getter of an ActionWithOperator', async () => {
    const collaborators = makeCollaborators(project);
    await runTool(
      'create_extension_BYOK',
      { extension_name: 'Ext' },
      collaborators
    );

    const expression = await runTool(
      'create_custom_function_BYOK',
      {
        extension_name: 'Ext',
        function_name: 'GetScore',
        function_type: 'Expression',
        expression_type: 'string',
      },
      collaborators
    );
    expect(expression.output.success).toBe(true);
    const functions = project
      .getEventsFunctionsExtension('Ext')
      .getEventsFunctions();
    expect(
      functions
        .getEventsFunction('GetScore')
        .getExpressionType()
        .getName()
    ).toBe('string');

    // An `expression_type` on a non-expression is refused.
    const refused = await runTool(
      'create_custom_function_BYOK',
      {
        extension_name: 'Ext',
        function_name: 'DoThing',
        function_type: 'Action',
        expression_type: 'number',
      },
      collaborators
    );
    expect(refused.output.success).toBe(false);
    expect(functions.hasEventsFunctionNamed('DoThing')).toBe(false);

    // An ActionWithOperator points at the expression it changes.
    const action = await runTool(
      'create_custom_function_BYOK',
      {
        extension_name: 'Ext',
        function_name: 'SetScore',
        function_type: 'ActionWithOperator',
        getter_name: 'GetScore',
      },
      collaborators
    );
    expect(action.output.success).toBe(true);
    expect(functions.getEventsFunction('SetScore').getGetterName()).toBe(
      'GetScore'
    );

    // A getter that is not an Expression of the scope is refused.
    const badGetter = await runTool(
      'create_custom_function_BYOK',
      {
        extension_name: 'Ext',
        function_name: 'SetScore2',
        function_type: 'ActionWithOperator',
        getter_name: 'DoThing',
      },
      collaborators
    );
    expect(badGetter.output.success).toBe(false);
    expect(functions.hasEventsFunctionNamed('SetScore2')).toBe(false);
  });

  it('copies a custom object or a custom behavior, from this extension or another one', async () => {
    const collaborators = makeCollaborators(project);
    await runTool(
      'create_extension_BYOK',
      { extension_name: 'Source' },
      collaborators
    );
    await runTool(
      'create_custom_object_BYOK',
      {
        extension_name: 'Source',
        custom_object_name: 'Chest',
        full_name: 'The source chest',
      },
      collaborators
    );
    await runTool(
      'create_custom_behavior_BYOK',
      {
        extension_name: 'Source',
        custom_behavior_name: 'Magnet',
        description: 'The source magnet',
      },
      collaborators
    );
    await runTool(
      'create_extension_BYOK',
      { extension_name: 'Target' },
      collaborators
    );

    const object = await runTool(
      'create_custom_object_BYOK',
      {
        extension_name: 'Target',
        custom_object_name: 'ChestCopy',
        duplicated_custom_object_name: 'Chest',
        duplicated_from_extension_name: 'Source',
      },
      collaborators
    );
    expect(object.output.success).toBe(true);
    expect(object.output.object_type).toBe('Target::ChestCopy');
    const copiedObject = project
      .getEventsFunctionsExtension('Target')
      .getEventsBasedObjects()
      .get('ChestCopy');
    expect(copiedObject).toBeTruthy();
    // The copy brought the SETTINGS of the source (a fresh object would
    // have none).
    expect(copiedObject.getFullName()).toBe('The source chest');

    const behavior = await runTool(
      'create_custom_behavior_BYOK',
      {
        extension_name: 'Target',
        custom_behavior_name: 'MagnetCopy',
        duplicated_custom_behavior_name: 'Magnet',
        duplicated_from_extension_name: 'Source',
      },
      collaborators
    );
    expect(behavior.output.success).toBe(true);
    expect(behavior.output.behavior_type).toBe('Target::MagnetCopy');
    const copiedBehavior = project
      .getEventsFunctionsExtension('Target')
      .getEventsBasedBehaviors()
      .get('MagnetCopy');
    expect(copiedBehavior).toBeTruthy();
    // The copy brought the SETTINGS of the source (a fresh behavior would
    // have none).
    expect(copiedBehavior.getDescription()).toBe('The source magnet');

    // A source that does not exist is refused.
    const missing = await runTool(
      'create_custom_object_BYOK',
      {
        extension_name: 'Target',
        custom_object_name: 'ChestCopy2',
        duplicated_custom_object_name: 'Nope',
        duplicated_from_extension_name: 'Source',
      },
      collaborators
    );
    expect(missing.output.success).toBe(false);
    expect(
      project
        .getEventsFunctionsExtension('Target')
        .getEventsBasedObjects()
        .has('ChestCopy2')
    ).toBe(false);

    // The extension to copy from is needed when a copy is asked for.
    const alone = await runTool(
      'create_custom_object_BYOK',
      {
        extension_name: 'Target',
        custom_object_name: 'ChestCopy3',
        duplicated_from_extension_name: 'Source',
      },
      collaborators
    );
    expect(alone.output.success).toBe(false);
    expect(alone.output.message).toContain('duplicated_custom_object_name');
  });

  it('changes and renames with project-wide reference updates', async () => {
    const collaborators = makeCollaborators(project);
    await runTool(
      'create_extension_BYOK',
      { extension_name: 'OldName' },
      collaborators
    );
    await runTool(
      'create_custom_function_BYOK',
      {
        extension_name: 'OldName',
        function_name: 'DoThing',
        function_type: 'Action',
        event_script: 'always:\n  Wait(0.1)',
      },
      collaborators
    );

    const renamed = await runTool(
      'change_extension_properties_BYOK',
      { extension_name: 'OldName', new_name: 'New Name' },
      collaborators
    );
    expect(renamed.output.success).toBe(true);
    // The safe name is applied.
    expect(project.hasEventsFunctionsExtensionNamed('New_Name')).toBe(true);
    expect(project.hasEventsFunctionsExtensionNamed('OldName')).toBe(false);
    // The function survived the rename.
    expect(
      project
        .getEventsFunctionsExtension('New_Name')
        .getEventsFunctions()
        .hasEventsFunctionNamed('DoThing')
    ).toBe(true);

    // Function rename through change_custom_function_BYOK.
    const functionRenamed = await runTool(
      'change_custom_function_BYOK',
      {
        extension_name: 'New_Name',
        function_name: 'DoThing',
        new_name: 'DoBetterThing',
      },
      collaborators
    );
    expect(functionRenamed.output.success).toBe(true);
    expect(
      project
        .getEventsFunctionsExtension('New_Name')
        .getEventsFunctions()
        .hasEventsFunctionNamed('DoBetterThing')
    ).toBe(true);
  });

  it('regenerates once per batch, full after structural changes, metadata-only otherwise', async () => {
    const reloadAll = jest.fn(async () => {});
    const reloadMetadata = (jest.fn(): any);
    const collaborators = makeCollaborators(project, {
      reloadEventsFunctionsExtensions: reloadAll,
      reloadEventsFunctionsExtensionMetadata: reloadMetadata,
    });

    // Batch 1: a metadata-only change (create_extension_BYOK).
    await runTool(
      'create_extension_BYOK',
      { extension_name: 'MetaOnly' },
      collaborators
    );
    await flushByokExtensionRegeneration(project, collaborators);
    expect(reloadAll).not.toHaveBeenCalled();
    expect(reloadMetadata).toHaveBeenCalledTimes(1);

    // Batch 2: a structural change (a function).
    await runTool(
      'create_custom_function_BYOK',
      {
        extension_name: 'MetaOnly',
        function_name: 'DoThing',
        function_type: 'Action',
      },
      collaborators
    );
    // Several calls in the same batch flush once:
    await runTool(
      'change_custom_function_BYOK',
      {
        extension_name: 'MetaOnly',
        function_name: 'DoThing',
        changed_settings: [{ property_name: 'description', new_value: 'd' }],
      },
      collaborators
    );
    await flushByokExtensionRegeneration(project, collaborators);
    expect(reloadAll).toHaveBeenCalledTimes(1);
    expect(reloadMetadata).toHaveBeenCalledTimes(1);

    // The call order within a flush: the full reload replaces the
    // metadata reload (never both for the same batch).
    const reloadAllOrder: any = (reloadAll: any);
    const reloadMetadataOrder: any = (reloadMetadata: any);
    expect(reloadAllOrder.mock.invocationCallOrder[0]).toBeGreaterThan(
      reloadMetadataOrder.mock.invocationCallOrder[0]
    );
  });
});

describe('ByokExtensionTools: deletion safety', () => {
  let project: any = null;

  beforeEach(() => {
    resetByokExtensionBatchForTests();
    project = gd.ProjectHelper.createNewGDJSProject();
  });

  afterEach(() => {
    project.delete();
    project = null;
  });

  it('refuses to delete a used custom object, allows it with the override', async () => {
    const collaborators = makeCollaborators(project);
    await runTool(
      'create_extension_BYOK',
      { extension_name: 'Objects' },
      collaborators
    );
    await runTool(
      'create_custom_object_BYOK',
      { extension_name: 'Objects', custom_object_name: 'Crate' },
      collaborators
    );

    // Declare an instance of the custom object type in a scene: the type
    // becomes used.
    const layout = project.insertNewLayout('Scene', 0);
    layout.getObjects().insertNewObject(project, 'Objects::Crate', 'Crate', 0);

    const refused = await runTool(
      'change_custom_object_BYOK',
      {
        extension_name: 'Objects',
        custom_object_name: 'Crate',
        delete_this_custom_object: true,
      },
      collaborators
    );
    expect(refused.output.success).toBe(false);
    expect(refused.output.message).toContain('used in the project');

    const forced = await runTool(
      'change_custom_object_BYOK',
      {
        extension_name: 'Objects',
        custom_object_name: 'Crate',
        delete_this_custom_object: true,
        delete_even_if_used: true,
      },
      collaborators
    );
    expect(forced.output.success).toBe(true);
    expect(
      project
        .getEventsFunctionsExtension('Objects')
        .getEventsBasedObjects()
        .has('Crate')
    ).toBe(false);
  });

  it('lists the usages of an extension as plain text', async () => {
    const collaborators = makeCollaborators(project);
    await runTool(
      'create_extension_BYOK',
      { extension_name: 'Used' },
      collaborators
    );
    await runTool(
      'create_custom_object_BYOK',
      { extension_name: 'Used', custom_object_name: 'Barrel' },
      collaborators
    );

    // Unused for now.
    const empty = await runTool(
      'find_extension_usages_BYOK',
      { extension_name: 'Used' },
      collaborators
    );
    expect(empty.output.success).toBe(true);
    expect(empty.output.usages).toEqual([]);

    // Use the object type somewhere.
    const layout = project.insertNewLayout('Scene', 0);
    layout.getObjects().insertNewObject(project, 'Used::Barrel', 'Barrel', 0);
    const used = await runTool(
      'find_extension_usages_BYOK',
      { extension_name: 'Used' },
      collaborators
    );
    expect(used.output.usages.length).toBe(1);
    expect(used.output.usages[0]).toContain('Used::Barrel');

    // The usage list is what blocks the delete.
    const extension = project.getEventsFunctionsExtension('Used');
    expect(findByokExtensionUsages(project, extension).length).toBe(1);
    const refused = await runTool(
      'change_extension_properties_BYOK',
      { extension_name: 'Used', delete_this_extension: true },
      collaborators
    );
    expect(refused.output.success).toBe(false);
    expect(refused.output.message).toContain('delete_even_if_used');
  });

  it('refuses invalid input instead of crashing', async () => {
    const collaborators = makeCollaborators(project);
    const noName = await runTool('create_extension_BYOK', {}, collaborators);
    expect(noName.output.success).toBe(false);

    const missing = await runTool(
      'create_custom_function_BYOK',
      {
        extension_name: 'DoesNotExist',
        function_name: 'F',
        function_type: 'Action',
      },
      collaborators
    );
    expect(missing.output.success).toBe(false);
    expect(missing.output.message).toContain('DoesNotExist');

    await runTool(
      'create_extension_BYOK',
      { extension_name: 'X' },
      collaborators
    );
    const badType = await runTool(
      'create_custom_function_BYOK',
      { extension_name: 'X', function_name: 'F', function_type: 'Wrong' },
      collaborators
    );
    expect(badType.output.success).toBe(false);
    expect(badType.output.message).toContain('function_type');

    const badScript = await runTool(
      'create_custom_function_BYOK',
      {
        extension_name: 'X',
        function_name: 'F',
        function_type: 'Action',
        // An unparsable EventScript must fail the call, never crash it.
        event_script: 'if ??? not eventscript <<<',
      },
      collaborators
    );
    expect(badScript.output.success).toBe(false);
    expect(badScript.output.message).toContain('not valid');
  });
});

describe('ByokExtensionTools: Phase 11 internals (parameters, children, dependencies)', () => {
  let project: any = null;

  beforeEach(() => {
    resetByokExtensionBatchForTests();
    project = gd.ProjectHelper.createNewGDJSProject();
  });

  afterEach(() => {
    project.delete();
    project = null;
  });

  const makeExtensionWithFunction = async (collaborators: Object) => {
    await runTool(
      'create_extension_BYOK',
      { extension_name: 'Internals' },
      collaborators
    );
    await runTool(
      'create_custom_function_BYOK',
      {
        extension_name: 'Internals',
        function_name: 'DoThing',
        function_type: 'Action',
        parameters: [{ name: 'Speed', type: 'expression' }],
      },
      collaborators
    );
  };

  it('adds, moves and removes function parameters', async () => {
    const collaborators = makeCollaborators(project);
    await makeExtensionWithFunction(collaborators);

    const added = await runTool(
      'change_custom_function_BYOK',
      {
        extension_name: 'Internals',
        function_name: 'DoThing',
        parameters_to_add: [
          { name: 'Label', type: 'string', description: 'A label.' },
          { name: 'Speed', type: 'expression' }, // duplicate: skipped
        ],
      },
      collaborators
    );
    expect(added.output.success).toBe(true);
    expect(added.output.message).toContain('parameters');
    expect(added.output.message).toContain('already exists (skipped)');

    const eventsFunction = project
      .getEventsFunctionsExtension('Internals')
      .getEventsFunctions()
      .getEventsFunction('DoThing');
    const parameters = eventsFunction.getParameters();
    expect(parameters.getParametersCount()).toBe(2);
    expect(parameters.hasParameterNamed('Label')).toBe(true);
    expect(parameters.getParameter('Label').getType()).toBe('string');
    expect(parameters.getParameter('Label').getDescription()).toBe('A label.');

    const moved = await runTool(
      'change_custom_function_BYOK',
      {
        extension_name: 'Internals',
        function_name: 'DoThing',
        parameters_to_move: [{ name: 'Label', to_index: 0 }],
      },
      collaborators
    );
    expect(moved.output.success).toBe(true);
    expect(parameters.getParameterAt(0).getName()).toBe('Label');

    const removed = await runTool(
      'change_custom_function_BYOK',
      {
        extension_name: 'Internals',
        function_name: 'DoThing',
        parameters_to_remove: ['Label'],
      },
      collaborators
    );
    expect(removed.output.success).toBe(true);
    expect(parameters.hasParameterNamed('Label')).toBe(false);
    expect(parameters.getParametersCount()).toBe(1);
  });

  it('changes an existing parameter type through the usage refactor', async () => {
    const collaborators = makeCollaborators(project);
    await makeExtensionWithFunction(collaborators);

    // The same hook the extension editor triggers on a type change: the
    // spy proves it is called with the function and the parameter, and
    // that the temporary scoped containers are released afterwards.
    const changeParameterType = jest.spyOn(
      gd.WholeProjectRefactorer,
      'changeParameterType'
    );
    // Count delete() on the wrappers this op creates (the established
    // constructor-replacement pattern, see ByokSpriteTools.spec.js).
    const originalObjectsContainer = gd.ObjectsContainer;
    const containerFunction = originalObjectsContainer.Function;
    let containerDeletes = 0;
    const CountedObjectsContainer = function(): any {
      const instance = new (originalObjectsContainer: any)(containerFunction);
      const originalDelete = instance.delete.bind(instance);
      instance.delete = () => {
        containerDeletes += 1;
        originalDelete();
      };
      return instance;
    };
    (gd: any).ObjectsContainer = CountedObjectsContainer;
    const changed = await runTool(
      'change_custom_function_BYOK',
      {
        extension_name: 'Internals',
        function_name: 'DoThing',
        parameters_to_add: [{ name: 'Speed', type: 'sceneName' }],
      },
      collaborators
    );
    (gd: any).ObjectsContainer = originalObjectsContainer;
    expect(changed.output.success).toBe(true);
    expect(changed.output.message).toContain(
      'changed the type of "Speed" to sceneName'
    );
    expect(changeParameterType).toHaveBeenCalledTimes(1);
    const calledWith = changeParameterType.mock.calls[0];
    expect(calledWith[0]).toBe(project);
    expect(calledWith[4]).toBe('Speed');
    // The parameter objects container passed to the refactorer is one of
    // the temporary wrappers: it must have been deleted (freed).
    expect(containerDeletes).toBe(1);
    changeParameterType.mockRestore();

    const parameters = project
      .getEventsFunctionsExtension('Internals')
      .getEventsFunctions()
      .getEventsFunction('DoThing')
      .getParameters();
    expect(parameters.getParameter('Speed').getType()).toBe('sceneName');
  });

  it('changes a parameter type inside a custom behavior function', async () => {
    const collaborators = makeCollaborators(project);
    await runTool(
      'create_extension_BYOK',
      { extension_name: 'Internals' },
      collaborators
    );
    await runTool(
      'create_custom_behavior_BYOK',
      { extension_name: 'Internals', custom_behavior_name: 'Magnet' },
      collaborators
    );
    await runTool(
      'create_custom_function_BYOK',
      {
        extension_name: 'Internals',
        custom_behavior_name: 'Magnet',
        function_name: 'DoThing',
        function_type: 'Action',
        parameters: [{ name: 'Force', type: 'expression' }],
      },
      collaborators
    );

    const changed = await runTool(
      'change_custom_function_BYOK',
      {
        extension_name: 'Internals',
        custom_behavior_name: 'Magnet',
        function_name: 'DoThing',
        parameters_to_add: [{ name: 'Force', type: 'string' }],
      },
      collaborators
    );
    expect(changed.output.success).toBe(true);
    const parameters = project
      .getEventsFunctionsExtension('Internals')
      .getEventsBasedBehaviors()
      .get('Magnet')
      .getEventsFunctions()
      .getEventsFunction('DoThing')
      .getParameters();
    expect(parameters.getParameter('Force').getType()).toBe('string');
  });

  it('adds and removes custom-object children, with the usage guard', async () => {
    const collaborators = makeCollaborators(project);
    await runTool(
      'create_extension_BYOK',
      { extension_name: 'Internals' },
      collaborators
    );
    await runTool(
      'create_custom_object_BYOK',
      {
        extension_name: 'Internals',
        custom_object_name: 'Button',
      },
      collaborators
    );

    const added = await runTool(
      'change_custom_object_BYOK',
      {
        extension_name: 'Internals',
        custom_object_name: 'Button',
        children_to_add: [
          { name: 'Icon', object_type: 'Sprite' },
          { name: 'Icon', object_type: 'Sprite' }, // duplicate: skipped
        ],
      },
      collaborators
    );
    expect(added.output.success).toBe(true);
    const eventsBasedObject = project
      .getEventsFunctionsExtension('Internals')
      .getEventsBasedObjects()
      .get('Button');
    expect(eventsBasedObject.getObjects().hasObjectNamed('Icon')).toBe(true);

    // The usage guard: an event referencing the child blocks the removal.
    const guarded = await runTool(
      'change_custom_object_BYOK',
      {
        extension_name: 'Internals',
        custom_object_name: 'Button',
        children_to_remove: ['Icon'],
      },
      collaborators
    );
    // The child is not referenced yet: the removal succeeds.
    expect(guarded.output.success).toBe(true);
    expect(eventsBasedObject.getObjects().hasObjectNamed('Icon')).toBe(false);
  });

  it('fits the area of a custom object to its children', async () => {
    const collaborators = makeCollaborators(project);
    await runTool(
      'create_extension_BYOK',
      { extension_name: 'Ext' },
      collaborators
    );
    await runTool(
      'create_custom_object_BYOK',
      { extension_name: 'Ext', custom_object_name: 'Box' },
      collaborators
    );
    const eventsBasedObject = project
      .getEventsFunctionsExtension('Ext')
      .getEventsBasedObjects()
      .get('Box');

    // A child with an instance of a known size.
    eventsBasedObject
      .getObjects()
      .insertNewObject(project, 'Sprite', 'Body', 0);
    const instance = eventsBasedObject
      .getInitialInstances()
      .insertNewInitialInstance();
    instance.setObjectName('Body');
    instance.setLayer('');
    instance.setX(10);
    instance.setY(10);
    instance.setHasCustomSize(true);
    instance.setCustomWidth(40);
    instance.setCustomHeight(40);

    const fitted = await runTool(
      'change_custom_object_BYOK',
      {
        extension_name: 'Ext',
        custom_object_name: 'Box',
        fit_area_to_children: 'min_at_origin',
      },
      collaborators
    );
    expect(fitted.output.success).toBe(true);

    const variant = eventsBasedObject.getDefaultVariant();
    // The area now covers the children, whose minimum corner is at the
    // origin.
    expect(variant.getAreaMinX()).toBe(0);
    expect(variant.getAreaMinY()).toBe(0);
    expect(variant.getAreaMaxX()).toBe(40);
    expect(variant.getAreaMaxY()).toBe(40);
    // The child was moved with the area: a sprite's origin is its
    // top-left corner, so the instance that was at 10;10 (its box going
    // from 10;10 to 50;50) is now at the origin.
    expect(instance.getX()).toBe(0);
    expect(instance.getY()).toBe(0);

    // An unknown mode is refused, and nothing is moved.
    const refused = await runTool(
      'change_custom_object_BYOK',
      {
        extension_name: 'Ext',
        custom_object_name: 'Box',
        fit_area_to_children: 'nope',
      },
      collaborators
    );
    expect(refused.output.success).toBe(false);
    expect(refused.output.message).toContain('fit_area_to_children');
    expect(eventsBasedObject.getDefaultVariant().getAreaMinX()).toBe(0);
  });

  it('refuses to remove a child used by the object events', async () => {
    const collaborators = makeCollaborators(project);
    await runTool(
      'create_extension_BYOK',
      { extension_name: 'Internals' },
      collaborators
    );
    await runTool(
      'create_custom_object_BYOK',
      { extension_name: 'Internals', custom_object_name: 'Button' },
      collaborators
    );
    await runTool(
      'change_custom_object_BYOK',
      {
        extension_name: 'Internals',
        custom_object_name: 'Button',
        children_to_add: [{ name: 'Icon', object_type: 'Sprite' }],
      },
      collaborators
    );
    // Reference the child from one of the object's functions (a custom
    // object's logic IS its functions' events), written through the
    // established event_script path.
    const eventsBasedObject = project
      .getEventsFunctionsExtension('Internals')
      .getEventsBasedObjects()
      .get('Button');
    const referenced = await runTool(
      'create_custom_function_BYOK',
      {
        extension_name: 'Internals',
        custom_object_name: 'Button',
        function_name: 'DoStepPreEvents',
        function_type: 'Action',
        event_script: 'always:\n  Delete(Icon)',
      },
      collaborators
    );
    expect(referenced.output.success).toBe(true);

    const guarded = await runTool(
      'change_custom_object_BYOK',
      {
        extension_name: 'Internals',
        custom_object_name: 'Button',
        children_to_remove: ['Icon'],
      },
      collaborators
    );
    expect(guarded.output.success).toBe(false);
    expect(guarded.output.message).toContain(
      "used by the custom object's events"
    );
    expect(eventsBasedObject.getObjects().hasObjectNamed('Icon')).toBe(true);
  });

  it('adds a child with initial property values, reporting unknown ones', async () => {
    const collaborators = makeCollaborators(project);
    await runTool(
      'create_extension_BYOK',
      { extension_name: 'Internals' },
      collaborators
    );
    await runTool(
      'create_custom_object_BYOK',
      { extension_name: 'Internals', custom_object_name: 'Scoreboard' },
      collaborators
    );
    // Declare a property on the custom object type: children of this type
    // can then receive initial values for it.
    await runTool(
      'change_custom_object_BYOK',
      {
        extension_name: 'Internals',
        custom_object_name: 'Scoreboard',
        changed_properties: [{ property_name: 'Level', new_value: '1' }],
      },
      collaborators
    );

    const added = await runTool(
      'change_custom_object_BYOK',
      {
        extension_name: 'Internals',
        custom_object_name: 'Scoreboard',
        children_to_add: [
          {
            name: 'Board',
            object_type: 'Internals::Scoreboard',
            initial_properties: [
              { name: 'Level', value: '3' },
              { name: 'not_a_property', value: 'x' },
            ],
          },
        ],
      },
      collaborators
    );
    expect(added.output.success).toBe(true);
    expect(added.output.message).toContain('added child "Board"');
    // The known property applies; the unknown one is reported, not fatal.
    expect(added.output.message).toContain('not_a_property');

    const eventsBasedObject = project
      .getEventsFunctionsExtension('Internals')
      .getEventsBasedObjects()
      .get('Scoreboard');
    const board = eventsBasedObject.getObjects().getObject('Board');
    const properties = board.getConfiguration().getProperties();
    expect(properties.get('Level').getValue()).toBe('3');
  });

  it('adds and removes extension dependencies, always listing them', async () => {
    const collaborators = makeCollaborators(project);
    await runTool(
      'create_extension_BYOK',
      { extension_name: 'Internals' },
      collaborators
    );

    const added = await runTool(
      'change_extension_properties_BYOK',
      {
        extension_name: 'Internals',
        dependencies_to_add: [
          { name: 'cordova-plugin-admob', dependency_type: 'npm' },
        ],
      },
      collaborators
    );
    expect(added.output.success).toBe(true);
    expect(added.output.dependencies).toEqual(['cordova-plugin-admob']);
    const extension = project.getEventsFunctionsExtension('Internals');
    expect(extension.getAllDependencies().size()).toBe(1);
    expect(
      extension
        .getAllDependencies()
        .at(0)
        .getDependencyType()
    ).toBe('npm');

    const removed = await runTool(
      'change_extension_properties_BYOK',
      {
        extension_name: 'Internals',
        dependencies_to_remove: ['cordova-plugin-admob'],
      },
      collaborators
    );
    expect(removed.output.success).toBe(true);
    expect(removed.output.dependencies).toEqual([]);
    expect(extension.getAllDependencies().size()).toBe(0);
  });
});

describe('ByokExtensionTools: reserved lifecycle names (audit100226 UP-12)', () => {
  let project: any;
  let collaborators: any;
  const runTool = async (name: string, args: Object) => {
    const tool = getByokExtensionTools().find(entry => entry.name === name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.run(args, collaborators);
  };

  beforeEach(() => {
    project = gd.ProjectHelper.createNewGDJSProject();
    collaborators = {
      getProject: () => project,
      reloadEventsFunctionsExtensions: jest.fn(),
      reloadEventsFunctionsExtensionMetadata: jest.fn(),
    };
  });

  it('refuses a BEHAVIOR lifecycle name (the engine creates it at runtime)', async () => {
    const created = await runTool('create_extension_BYOK', {
      extension_name: 'MagnetLogic',
    });
    expect(created.output.success).toBe(true);
    // The scope must exist before the reserved-name check is reached.
    await runTool('create_custom_behavior_BYOK', {
      extension_name: 'MagnetLogic',
      custom_behavior_name: 'Magnet',
    });
    const refusal = await runTool('create_custom_function_BYOK', {
      extension_name: 'MagnetLogic',
      custom_behavior_name: 'Magnet',
      function_name: 'doStepPreEvents',
      function_type: 'Action',
    });
    expect(refusal.output.success).toBe(false);
    expect(refusal.didModifyProject).toBe(false);
    expect(JSON.stringify(refusal.output)).toContain('reserved');
  });

  it('refuses an EXTENSION lifecycle name for a free function', async () => {
    await runTool('create_extension_BYOK', { extension_name: 'Helpers' });
    const refusal = await runTool('create_custom_function_BYOK', {
      extension_name: 'Helpers',
      function_name: 'onSceneLoaded',
      function_type: 'Action',
    });
    expect(refusal.output.success).toBe(false);
    expect(JSON.stringify(refusal.output)).toContain('reserved');
  });

  it('still accepts an ordinary function name', async () => {
    await runTool('create_extension_BYOK', { extension_name: 'Helpers2' });
    const created = await runTool('create_custom_function_BYOK', {
      extension_name: 'Helpers2',
      function_name: 'spawnEnemies',
      function_type: 'Action',
    });
    expect(created.output.success).toBe(true);
  });

  it('sanitizes a name with invalid characters before inserting', async () => {
    const created = await runTool('create_extension_BYOK', {
      extension_name: 'My Extension!',
    });
    expect(created.output.success).toBe(true);
    // The stored name is the sanitized one, so the object types derived
    // from it stay in the shape the editor can produce.
    const storedName = project.getEventsFunctionsExtensionAt(0).getName();
    expect(storedName).not.toBe('My Extension!');
    expect(storedName).toBe(gd.Project.getSafeName('My Extension!'));
  });
});
