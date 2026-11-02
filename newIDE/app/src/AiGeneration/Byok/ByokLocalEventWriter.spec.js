// @flow
import { renderEventsAsEventScript } from '../../EventsSheet/EventsTree/TextRenderer/EventScriptRenderer';
import {
  byokApplySceneEventBatches,
  byokParsedEventsToGeneratedEventsJson,
  type ByokEventBatch,
} from './ByokLocalEventWriter';
import { parseByokEventScript } from './ByokEventScriptParser';

const gd: libGDevelop = global.gd;

const makeProjectWithScene = (): any => {
  const project = gd.ProjectHelper.createNewGDJSProject();
  project.insertNewLayout('TestScene', 0);
  return project;
};

const makeBatch = (batch: ByokEventBatch): ByokEventBatch => batch;

const getSceneSource = (project: any): string => {
  const scene = project.getLayout('TestScene');
  const { text } = renderEventsAsEventScript({ eventsList: scene.getEvents() });
  return text;
};

describe('byokApplySceneEventBatches', () => {
  let project: any;
  let onSceneEventsModifiedOutsideEditor: () => void;

  beforeEach(() => {
    project = makeProjectWithScene();
    onSceneEventsModifiedOutsideEditor = jest.fn();
  });

  afterEach(() => {
    project.delete();
  });

  const apply = (batches: Array<ByokEventBatch>) =>
    byokApplySceneEventBatches({
      project,
      sceneName: 'TestScene',
      eventBatches: batches,
      onSceneEventsModifiedOutsideEditor,
    });

  it('inserts events at the end of the scene', () => {
    const output = apply([
      makeBatch({
        event_script: 'if Timer(2, "SpawnTimer") and once:\n  Wait(1)',
        placement_relation: 'insert_at_end',
      }),
    ]);

    expect(output.success).toBe(true);
    expect(output.appliedCount).toBe(1);
    expect(getSceneSource(project)).toContain(
      'if Timer(2, "SpawnTimer") and once:'
    );
    expect(getSceneSource(project)).toContain('Wait(1)');
    expect(onSceneEventsModifiedOutsideEditor).toHaveBeenCalledTimes(1);
  });

  it('replaces an event by path with a matching expected_event_source anchor', () => {
    apply([
      makeBatch({
        event_script: 'always:\n  Wait(1)',
        placement_relation: 'insert_at_end',
      }),
    ]);
    const sourceBefore = getSceneSource(project);

    const output = apply([
      makeBatch({
        event_script: 'always:\n  Wait(2)',
        placement_relation: 'replace_entire_event_and_sub_events',
        placement_target_event_id: 'event-0',
        expected_event_source: sourceBefore,
      }),
    ]);

    expect(output.success).toBe(true);
    expect(getSceneSource(project)).toContain('Wait(2)');
    expect(getSceneSource(project)).not.toContain('Wait(1)');
  });

  it('refuses a replace whose anchor no longer matches (the surgical-edit guarantee)', () => {
    apply([
      makeBatch({
        event_script: 'always:\n  Wait(1)',
        placement_relation: 'insert_at_end',
      }),
    ]);

    const output = apply([
      makeBatch({
        event_script: 'always:\n  Wait(2)',
        placement_relation: 'replace_event_but_keep_existing_sub_events',
        placement_target_event_id: 'event-0',
        expected_event_source: 'always:\n  Wait(999)',
      }),
    ]);

    expect(output.success).toBe(false);
    expect(output.message).toContain('changed since expected_event_source');
    // The scene is untouched.
    expect(getSceneSource(project)).toContain('Wait(1)');
    expect(onSceneEventsModifiedOutsideEditor).toHaveBeenCalledTimes(1);
  });

  it('deletes an event by path (and maps the hosted "delete" relation name)', () => {
    apply([
      makeBatch({
        event_script: 'always:\n  Wait(1)',
        placement_relation: 'insert_at_end',
      }),
    ]);

    const output = apply([
      makeBatch({
        placement_relation: 'delete',
        placement_target_event_id: 'event-0',
      }),
    ]);

    expect(output.success).toBe(true);
    expect(getSceneSource(project)).not.toContain('Wait(1)');
  });

  it('fails on an unknown scene', () => {
    const output = byokApplySceneEventBatches({
      project,
      sceneName: 'NopeScene',
      eventBatches: [
        makeBatch({
          event_script: 'always:',
          placement_relation: 'insert_at_end',
        }),
      ],
      onSceneEventsModifiedOutsideEditor,
    });
    expect(output.success).toBe(false);
    expect(output.message).toContain('No scene named "NopeScene"');
  });

  it('fails on empty batches', () => {
    const output = apply([]);
    expect(output.success).toBe(false);
    expect(output.message).toContain('at least one batch');
  });

  it('reports a parse error with its line number (model-fixable)', () => {
    const output = apply([
      makeBatch({
        event_script: 'always:\n  Wait(1',
        placement_relation: 'insert_at_end',
      }),
    ]);
    expect(output.success).toBe(false);
    expect(output.message).toContain('line 2');
    expect(output.message).toContain('unclosed');
  });

  it('fails on an unknown placement relation', () => {
    const output = apply([
      makeBatch({
        event_script: 'always:',
        placement_relation: 'teleport_event',
      }),
    ]);
    expect(output.success).toBe(false);
    expect(output.message).toContain('unknown placement_relation');
  });

  it('fails when a targeted placement has no target id', () => {
    const output = apply([
      makeBatch({
        event_script: 'always:',
        placement_relation: 'insert_before_event',
      }),
    ]);
    expect(output.success).toBe(false);
    expect(output.message).toContain('needs a placement_target_event_id');
  });

  it('notifies the editor with the aiGeneratedEventId it stamped', () => {
    apply([
      makeBatch({
        event_script: 'always:\n  Wait(1)',
        placement_relation: 'insert_at_end',
      }),
    ]);
    const changes = (onSceneEventsModifiedOutsideEditor: any).mock.calls[0][0];
    expect(changes.scene.getName()).toBe('TestScene');
    expect(changes.newOrChangedAiGeneratedEventIds.size).toBe(1);
    for (const id of changes.newOrChangedAiGeneratedEventIds) {
      expect(id).toContain('byok-event-');
    }
  });
});

describe('byokParsedEventsToGeneratedEventsJson', () => {
  it('round-trips parsed events through a real gd events list', () => {
    const project = makeProjectWithScene();
    try {
      const parseResult = parseByokEventScript('always:\n  Wait(1)');
      if (!parseResult.events) throw new Error('expected events');
      const json = byokParsedEventsToGeneratedEventsJson(
        parseResult.events,
        project
      );
      const parsed = JSON.parse(json);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].actions[0].type.value).toBe('Wait');
    } finally {
      project.delete();
    }
  });
});

describe('the EventScript example bank round-trip (Phase 13.6)', () => {
  let project: any;
  beforeEach(() => {
    project = makeProjectWithScene();
  });
  afterEach(() => {
    project.delete();
  });
  const apply = (batches: Array<ByokEventBatch>) =>
    byokApplySceneEventBatches({
      project,
      sceneName: 'TestScene',
      eventBatches: batches,
      onSceneEventsModifiedOutsideEditor: () => {},
    });

  it('accepts every shipped example through the real writer', () => {
    const { getByokEventScriptExamples } = require('./ByokEventScriptExamples');
    const examples = getByokEventScriptExamples();
    expect(examples.length).toBeGreaterThanOrEqual(10);
    for (const example of examples) {
      const output = apply([
        makeBatch({
          event_script: example.source,
          placement_relation: 'insert_at_end',
        }),
      ]);
      expect(output.success).toBe(true);
    }
  });

  it('attaches a targeted retryHint whose example parses', () => {
    const output: any = apply([
      makeBatch({
        event_script: 'if Timer(2, "SpawnTimer") an once:\n  Wait(1)',
        placement_relation: 'insert_at_end',
      }),
    ]);
    expect(output.success).toBe(false);
    expect(output.retryHint).toBeTruthy();
    expect(output.retryHint.exampleId).toBe('timer-spawn');

    // The hinted example itself must be valid writer input.
    const hintOutput = apply([
      makeBatch({
        event_script: output.retryHint.source,
        placement_relation: 'insert_at_end',
      }),
    ]);
    expect(hintOutput.success).toBe(true);
  });
});
