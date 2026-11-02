// @flow
import { getByokGuardrailTools } from './ByokGuardrailTools';
import { findByNameokExtraTool } from './ByokExtraTools';
import {
  BYOK_CORE_TOOL_NAMES,
  getByokDispatchableToolNames,
  searchByokToolSchemas,
} from './ByokToolSchema';
import type { ByokExtraToolCollaborators } from './ByokExtraTools';

const gd: libGDevelop = global.gd;

const ONCE = 'BuiltinCommonInstructions::Once';
const FOR_EACH = 'BuiltinCommonInstructions::ForEach';

/** The IDE's project snapshot serialization (SerializerElement round-trip). */
const serialize = (project: any): string => {
  const element = new gd.SerializerElement();
  project.serializeTo(element);
  const json = gd.Serializer.toJSON(element);
  element.delete();
  return json;
};

/**
 * A fresh project with a trap scene ("Level1" — a Once under a For Each, a
 * duplicated Once) and a clean scene ("Level2"), the same fixture shape as
 * ForkGuardrailToolHandler.spec.js.
 */
const makeFixtureProject = (): any => {
  const project = gd.ProjectHelper.createNewGDJSProject();
  const trapLayout = project.insertNewLayout('Level1', 0);
  project.insertNewLayout('Level2', 1);

  // insertNewEvent (the events sheet's own pattern), because inserting a
  // raw `new gd.XxxEvent()` template loses the event type through the
  // WebIDL BaseEvent slicing.
  const trapEvents = trapLayout.getEvents();
  const forEachEvent = trapEvents.insertNewEvent(project, FOR_EACH, 0);
  const childEvent = forEachEvent
    .getSubEvents()
    .insertNewEvent(project, 'BuiltinCommonInstructions::Standard', 0);
  const duplicateOnceEvent = trapEvents.insertNewEvent(
    project,
    'BuiltinCommonInstructions::Standard',
    1
  );

  const onceInstruction = new gd.Instruction();
  onceInstruction.setType(ONCE);
  const childConditions = gd.asStandardEvent(childEvent).getConditions();
  childConditions.insert(onceInstruction, childConditions.size());
  const duplicateConditions = gd
    .asStandardEvent(duplicateOnceEvent)
    .getConditions();
  duplicateConditions.insert(onceInstruction, duplicateConditions.size());
  duplicateConditions.insert(onceInstruction, duplicateConditions.size());
  onceInstruction.delete();

  return project;
};

const makeCollaborators = (project: any): ByokExtraToolCollaborators => ({
  getProject: () => project,
  onSceneEventsModifiedOutsideEditor: (jest.fn(): any),
});

const findTool = () => {
  const tool = getByokGuardrailTools().find(
    candidate => candidate.name === 'scan_scene_events'
  );
  if (!tool) throw new Error('no scan_scene_events tool');
  return tool;
};

describe('the guardrail tool is registered and discoverable', () => {
  it('resolves the name through the interception registry', () => {
    const tool = findByNameokExtraTool('scan_scene_events');
    expect(tool).not.toBeNull();
    if (!tool) throw new Error('the tool is not registered');
    // A read-only diagnostics report (D18-6).
    expect(tool.modifiesProject).toBe(false);
  });

  it('is dispatchable but never in the advertised core set (D18-6)', () => {
    expect(getByokDispatchableToolNames()).toContain('scan_scene_events');
    // Advertising it inline would eat the 13.5 token budget: the model
    // finds it through search_tools instead.
    expect(BYOK_CORE_TOOL_NAMES).not.toContain('scan_scene_events');
  });

  it('is reachable through search_tools', () => {
    const names = searchByokToolSchemas('guardrail').map(schema => schema.name);
    expect(names).toContain('scan_scene_events');
  });
});

describe('scan_scene_events', () => {
  it('returns the engine diagnostics and writes nothing', async () => {
    const project = makeFixtureProject();
    try {
      const before = serialize(project);
      const result = await findTool().run({}, makeCollaborators(project));

      expect(result.didModifyProject).toBe(false);
      expect(result.output.success).toBe(true);
      expect(result.output.diagnostics).toHaveLength(2);
      expect(result.output.diagnostics[0]).toMatchObject({
        ruleId: 'G18-once-in-loop',
        severity: 'warning',
        sceneName: 'Level1',
      });
      expect(result.output.diagnostics[1]).toMatchObject({
        ruleId: 'G18-duplicate-once',
        sceneName: 'Level1',
      });
      expect(result.output.summary).toContain('2 warning(s)');
      // The message teaches the fix path and mirrors the sheet badges.
      expect(result.output.message).toContain('inline badges');
      expect(result.output.message).toContain('G18-once-in-loop');
      // Read-only: the serialized project is byte-identical.
      expect(serialize(project)).toBe(before);
    } finally {
      project.delete();
    }
  });

  it('passes scene_name and rule_ids through to the handler', async () => {
    const project = makeFixtureProject();
    try {
      const clean = await findTool().run(
        { scene_name: 'Level2' },
        makeCollaborators(project)
      );
      expect(clean.output.success).toBe(true);
      expect(clean.output.diagnostics).toEqual([]);

      const filtered = await findTool().run(
        { scene_name: 'Level1', rule_ids: ['G18-duplicate-once'] },
        makeCollaborators(project)
      );
      expect(filtered.output.success).toBe(true);
      expect(filtered.output.diagnostics.map(entry => entry.ruleId)).toEqual([
        'G18-duplicate-once',
      ]);
    } finally {
      project.delete();
    }
  });

  it('relays the handler refusals as failures', async () => {
    const project = makeFixtureProject();
    try {
      const unknownScene = await findTool().run(
        { scene_name: 'Nope' },
        makeCollaborators(project)
      );
      expect(unknownScene.output.success).toBe(false);
      expect(unknownScene.output.message).toContain('Level1');
      expect(unknownScene.didModifyProject).toBe(false);

      const unknownRule = await findTool().run(
        { rule_ids: ['not-a-rule'] },
        makeCollaborators(project)
      );
      expect(unknownRule.output.success).toBe(false);
      expect(unknownRule.output.message).toContain('G18-once-in-loop');
    } finally {
      project.delete();
    }
  });

  it('refuses cleanly without a project', async () => {
    const result = await findTool().run({}, makeCollaborators(null));
    expect(result.output.success).toBe(false);
    expect(result.output.message).toContain('No project is open');
    expect(result.didModifyProject).toBe(false);
  });
});
