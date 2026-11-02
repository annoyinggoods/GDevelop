// @flow
import { scanSceneEvents } from './ForkGuardrailToolHandler';
import { serializeToJSON } from '../../Utils/Serializer';

const gd: libGDevelop = global.gd;

const ONCE = 'BuiltinCommonInstructions::Once';
const FOR_EACH = 'BuiltinCommonInstructions::ForEach';

/** A fresh project with a trap scene ("Level1") and a clean scene ("Level2"). */
const makeFixtureProject = (): any => {
  const project = gd.ProjectHelper.createNewGDJSProject();
  const trapLayout = project.insertNewLayout('Level1', 0);
  project.insertNewLayout('Level2', 1);

  // Events are created with insertNewEvent — the events sheet's own pattern —
  // because inserting a raw `new gd.XxxEvent()` template loses the event type
  // through the WebIDL BaseEvent slicing.
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

describe('scanSceneEvents', () => {
  it('surfaces every rule through the handler on a two-scene fixture project', () => {
    const project = makeFixtureProject();
    try {
      const result = scanSceneEvents({ project });
      if (!result.ok) throw new Error(result.error);

      expect(result.diagnostics).toHaveLength(2);
      expect(result.diagnostics[0]).toMatchObject({
        ruleId: 'G18-once-in-loop',
        severity: 'warning',
        sceneName: 'Level1',
        nodePath: [0, 1],
      });
      expect(result.diagnostics[1]).toMatchObject({
        ruleId: 'G18-duplicate-once',
        severity: 'warning',
        sceneName: 'Level1',
        // Flattened walk: ForEach=0, its child=1, the duplicate-Once event=2.
        nodePath: [2],
      });
      expect(result.summary).toBe(
        '2 warning(s), 0 advisories across 2 scene(s) (4 rules checked)'
      );
    } finally {
      project.delete();
    }
  });

  it('scans only the requested scene', () => {
    const project = makeFixtureProject();
    try {
      const clean = scanSceneEvents({ project, sceneName: 'Level2' });
      if (!clean.ok) throw new Error(clean.error);
      expect(clean.diagnostics).toEqual([]);
      expect(clean.summary).toBe(
        '0 warning(s), 0 advisories across 1 scene(s) (4 rules checked)'
      );

      const trap = scanSceneEvents({ project, sceneName: 'Level1' });
      if (!trap.ok) throw new Error(trap.error);
      expect(trap.diagnostics).toHaveLength(2);
      expect(trap.diagnostics.every(d => d.sceneName === 'Level1')).toBe(true);
    } finally {
      project.delete();
    }
  });

  it('refuses an unknown scene name, listing the available scenes', () => {
    const project = makeFixtureProject();
    try {
      const result = scanSceneEvents({ project, sceneName: 'Nope' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Nope');
        expect(result.error).toContain('Level1');
        expect(result.error).toContain('Level2');
      }
    } finally {
      project.delete();
    }
  });

  it('refuses unknown rule ids, listing the valid ones', () => {
    const project = makeFixtureProject();
    try {
      const result = scanSceneEvents({
        project,
        ruleIds: ['G18-once-in-loop', 'not-a-rule'],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('not-a-rule');
        expect(result.error).toContain('G18-duplicate-once');
      }
    } finally {
      project.delete();
    }
  });

  it('filters the diagnostics to the requested rules', () => {
    const project = makeFixtureProject();
    try {
      const result = scanSceneEvents({
        project,
        ruleIds: ['G18-duplicate-once'],
      });
      if (!result.ok) throw new Error(result.error);
      expect(result.diagnostics.map(d => d.ruleId)).toEqual([
        'G18-duplicate-once',
      ]);
      expect(result.summary).toBe(
        '1 warning(s), 0 advisories across 2 scene(s) (1 rules checked)'
      );
    } finally {
      project.delete();
    }
  });

  it('writes nothing (the project serialization is identical before/after)', () => {
    const project = makeFixtureProject();
    try {
      const before = serializeToJSON(project);
      const result = scanSceneEvents({ project });
      expect(result.ok).toBe(true);
      const after = serializeToJSON(project);
      expect(after).toBe(before);
    } finally {
      project.delete();
    }
  });

  it('fails gracefully without a project and on an empty project', () => {
    expect(scanSceneEvents({ project: null })).toMatchObject({
      ok: false,
    });

    const emptyProject = gd.ProjectHelper.createNewGDJSProject();
    try {
      const result = scanSceneEvents({ project: emptyProject });
      if (!result.ok) throw new Error(result.error);
      expect(result.diagnostics).toEqual([]);
      expect(result.summary).toBe(
        '0 warning(s), 0 advisories across 0 scene(s) (4 rules checked)'
      );
    } finally {
      emptyProject.delete();
    }
  });
});
