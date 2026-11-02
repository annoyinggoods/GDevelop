// @flow
import { getByokExternalSceneTools } from './ByokExternalSceneTools';

const gd: libGDevelop = global.gd;

/** Type-loose accessor: the specs only exercise registered tools. */
const getTool = (name: string): any =>
  getByokExternalSceneTools().find(tool => tool.name === name) || null;

const makeProject = () => {
  const project = gd.ProjectHelper.createNewGDJSProject();
  const scene = project.insertNewLayout('TestScene', 0);
  scene.getObjects().insertNewObject(project, 'Sprite', 'Player', 0);
  project.insertNewExternalEvents('UiSheet', 0);
  project.getExternalEvents('UiSheet').setAssociatedLayout('TestScene');
  const spawn = project.insertNewExternalLayout('SpawnPoint', 0);
  spawn.setAssociatedLayout('TestScene');
  const bare = project.insertNewExternalLayout('Bare', 0);
  return { project, scene, spawn, bare };
};

const makeCollaborators = (project: gdProject): any => ({
  getProject: () => project,
});

describe('ByokExternalSceneTools', () => {
  let project: gdProject;

  beforeEach(() => {
    const fixtures = makeProject();
    project = fixtures.project;
  });

  afterEach(() => {
    project.delete();
  });

  it('registers the four tools with the right modification flags', () => {
    expect(getTool('read_external_events_source')?.modifiesProject).toBe(false);
    expect(getTool('add_external_events')?.modifiesProject).toBe(true);
    expect(getTool('describe_external_layout')?.modifiesProject).toBe(false);
    expect(getTool('put_external_layout_instances')?.modifiesProject).toBe(
      true
    );
  });

  describe('read_external_events_source', () => {
    it('reads an existing sheet with its associated scene and object names', async () => {
      const result = await getTool('read_external_events_source').run(
        { external_events_name: 'UiSheet' },
        makeCollaborators(project)
      );

      expect(result.output.success).toBe(true);
      expect(result.output.externalEventsNamed).toBe('UiSheet');
      expect(result.output.associatedSceneName).toBe('TestScene');
      expect(typeof result.output.eventScript).toBe('string');
      expect(result.output.sceneObjectNames).toContain('Player');
      expect(result.didModifyProject).toBe(false);
    });

    it('round-trips what add_external_events wrote (event_script form)', async () => {
      const writeResult = await getTool('add_external_events').run(
        {
          external_events_name: 'UiSheet',
          event_script: 'always:\n  Wait(1)',
        },
        makeCollaborators(project)
      );
      const result = await getTool('read_external_events_source').run(
        { external_events_name: 'UiSheet' },
        makeCollaborators(project)
      );

      expect(writeResult.output.success).toBe(true);
      expect(result.output.success).toBe(true);
      expect(result.output.eventScript).toContain('Wait');
    });

    it('fails and lists the existing sheets when the name is unknown', async () => {
      const result = await getTool('read_external_events_source').run(
        { external_events_name: 'Nope' },
        makeCollaborators(project)
      );

      expect(result.output.success).toBe(false);
      expect(result.output.message).toContain(
        'No external events named "Nope"'
      );
      expect(result.output.message).toContain('"UiSheet"');
    });

    it('requires a project', async () => {
      const result = await getTool('read_external_events_source').run(
        { external_events_name: 'UiSheet' },
        { getProject: () => null }
      );

      expect(result.output.success).toBe(false);
      expect(result.output.message).toContain('No project is open');
    });
  });

  describe('add_external_events', () => {
    it('creates the sheet when missing and writes event_script (replace)', async () => {
      const result = await getTool('add_external_events').run(
        {
          external_events_name: 'NewSheet',
          create_if_missing: true,
          associated_scene: 'TestScene',
          event_script: 'always:\n  Wait(2)',
        },
        makeCollaborators(project)
      );

      expect(result.output.success).toBe(true);
      expect(result.didModifyProject).toBe(true);
      expect(project.hasExternalEventsNamed('NewSheet')).toBe(true);
      expect(project.getExternalEvents('NewSheet').getAssociatedLayout()).toBe(
        'TestScene'
      );
      expect(
        project
          .getExternalEvents('NewSheet')
          .getEvents()
          .getEventsCount()
      ).toBe(1);
    });

    it('refuses to create without create_if_missing, listing existing sheets', async () => {
      const result = await getTool('add_external_events').run(
        { external_events_name: 'NewSheet', event_script: ' anything' },
        makeCollaborators(project)
      );

      expect(result.output.success).toBe(false);
      expect(result.output.message).toContain('create_if_missing');
      expect(result.output.message).toContain('"UiSheet"');
    });

    it('applies anchored event_batches through the local event writer', async () => {
      const result = await getTool('add_external_events').run(
        {
          external_events_name: 'UiSheet',
          event_batches: [
            {
              placement_relation: 'insert_at_end',
              event_script: 'always:\n  Wait(3)',
            },
          ],
        },
        makeCollaborators(project)
      );

      expect(result.output.success).toBe(true);
      expect(result.didModifyProject).toBe(true);
      expect(
        project
          .getExternalEvents('UiSheet')
          .getEvents()
          .getEventsCount()
      ).toBe(1);
    });

    it('writes into the external sheet without touching the scene events', async () => {
      const sceneEventsCount = project
        .getLayout('TestScene')
        .getEvents()
        .getEventsCount();
      const result = await getTool('add_external_events').run(
        {
          external_events_name: 'UiSheet',
          event_script: 'always:\n  Wait(1)',
        },
        makeCollaborators(project)
      );

      expect(result.output.success).toBe(true);
      expect(
        project
          .getExternalEvents('UiSheet')
          .getEvents()
          .getEventsCount()
      ).toBe(1);
      // The external sheet is the ONLY target: the scene sheet is intact.
      expect(
        project
          .getLayout('TestScene')
          .getEvents()
          .getEventsCount()
      ).toBe(sceneEventsCount);
    });

    it('notifies the external events editor with the new event ids', async () => {
      const notifications: Array<any> = [];
      const result = await getTool('add_external_events').run(
        {
          external_events_name: 'UiSheet',
          event_batches: [
            {
              placement_relation: 'insert_at_end',
              event_script: 'always:\n  Wait(3)',
            },
            {
              placement_relation: 'insert_at_end',
              event_script: 'always:\n  Wait(4)',
            },
          ],
        },
        {
          ...makeCollaborators(project),
          onExternalEventsModifiedOutsideEditor: (changes: any) =>
            notifications.push(changes),
        }
      );

      expect(result.output.success).toBe(true);
      expect(notifications).toHaveLength(1);
      expect(notifications[0].externalEventsName).toBe('UiSheet');
      // The writer tags the whole applied group with ONE id per call —
      // that's the id the editor highlights.
      expect(notifications[0].newOrChangedAiGeneratedEventIds.size).toBe(1);
    });

    it('refuses an associated scene that does not exist', async () => {
      const result = await getTool('add_external_events').run(
        {
          external_events_name: 'UiSheet',
          associated_scene: 'NotAScene',
          event_script: 'always:\n  Wait(4)',
        },
        makeCollaborators(project)
      );

      expect(result.output.success).toBe(false);
      expect(result.output.message).toContain('Scene not found');
    });

    it('fails when neither event_batches nor event_script is given', async () => {
      const result = await getTool('add_external_events').run(
        { external_events_name: 'UiSheet' },
        makeCollaborators(project)
      );

      expect(result.output.success).toBe(false);
      expect(result.output.message).toContain('Provide event_batches');
    });
  });

  describe('describe_external_layout', () => {
    it('describes the instances of an external layout', async () => {
      const container = project.getExternalLayout('SpawnPoint');
      const instance = container
        .getInitialInstances()
        .insertNewInitialInstance();
      instance.setObjectName('Player');
      instance.setX(42);

      const result = await getTool('describe_external_layout').run(
        { external_layout_name: 'SpawnPoint' },
        makeCollaborators(project)
      );

      expect(result.output.success).toBe(true);
      expect(result.output.associatedSceneName).toBe('TestScene');
      expect(result.output.instances).toHaveLength(1);
      expect(result.output.instances[0].name).toBe('Player');
      expect(result.output.instances[0].x).toBe(42);
    });

    it('fails with the actionable reason when there is no associated scene', async () => {
      const result = await getTool('describe_external_layout').run(
        { external_layout_name: 'Bare' },
        makeCollaborators(project)
      );

      expect(result.output.success).toBe(false);
      expect(result.output.message).toContain('associated scene');
    });

    it('lists existing external layouts on an unknown name', async () => {
      const result = await getTool('describe_external_layout').run(
        { external_layout_name: 'Nope' },
        makeCollaborators(project)
      );

      expect(result.output.success).toBe(false);
      expect(result.output.message).toContain('"SpawnPoint"');
    });
  });

  describe('put_external_layout_instances', () => {
    it('creates the external layout and places instances in it', async () => {
      const notifications: Array<any> = [];
      const result = await getTool('put_external_layout_instances').run(
        {
          external_layout_name: 'EnemySpawn',
          create_if_missing: true,
          associated_scene: 'TestScene',
          layer_name: '',
          brush_kind: 'point',
          brush_position: '10, 20',
          object_name: 'Player',
          new_instances_count: 2,
        },
        {
          ...makeCollaborators(project),
          onExternalLayoutModifiedOutsideEditor: (changes: any) =>
            notifications.push(changes),
        }
      );

      expect(result.output.success).toBe(true);
      expect(result.didModifyProject).toBe(true);
      expect(notifications).toEqual([{ externalLayoutName: 'EnemySpawn' }]);
      const container = project.getExternalLayout('EnemySpawn');
      expect(container.getInitialInstances().getInstancesCount()).toBe(2);
    });

    it('does not touch the associated scene instances', async () => {
      await getTool('put_external_layout_instances').run(
        {
          external_layout_name: 'SpawnPoint',
          layer_name: '',
          brush_kind: 'point',
          brush_position: '0, 0',
          object_name: 'Player',
          new_instances_count: 1,
        },
        makeCollaborators(project)
      );

      const scene = project.getLayout('TestScene');
      expect(scene.getInitialInstances().getInstancesCount()).toBe(0);
    });

    it('requires associated_scene at creation', async () => {
      const result = await getTool('put_external_layout_instances').run(
        {
          external_layout_name: 'EnemySpawn',
          create_if_missing: true,
          layer_name: '',
          brush_kind: 'point',
          brush_position: '0, 0',
          object_name: 'Player',
          new_instances_count: 1,
        },
        makeCollaborators(project)
      );

      expect(result.output.success).toBe(false);
      expect(result.output.message).toContain('associated_scene');
    });

    it('fails on an unknown layer of the associated scene', async () => {
      const result = await getTool('put_external_layout_instances').run(
        {
          external_layout_name: 'SpawnPoint',
          layer_name: 'NoSuchLayer',
          brush_kind: 'point',
          brush_position: '0, 0',
          object_name: 'Player',
          new_instances_count: 1,
        },
        makeCollaborators(project)
      );

      expect(result.output.success).toBe(false);
      expect(result.output.message).toContain('Layer not found');
    });

    it('reports an already-satisfied put as a success (script-style no-op)', async () => {
      const notifications: Array<any> = [];
      const collaborators = {
        ...makeCollaborators(project),
        onExternalLayoutModifiedOutsideEditor: (changes: any) =>
          notifications.push(changes),
      };
      const first = await getTool('put_external_layout_instances').run(
        {
          external_layout_name: 'SpawnPoint',
          layer_name: '',
          brush_kind: 'point',
          brush_position: '0, 0',
          object_name: 'Player',
          new_instances_count: 1,
        },
        collaborators
      );
      expect(first.output.success).toBe(true);
      expect(first.didModifyProject).toBe(true);
      expect(notifications).toHaveLength(1);

      const described = await getTool('describe_external_layout').run(
        { external_layout_name: 'SpawnPoint' },
        collaborators
      );
      const instanceId = described.output.instances[0].id;

      // Re-asserting the current state of an existing instance is a no-op,
      // which is a SUCCESS for the script-style BYOK agent (toolsVersion
      // v12+, like the hosted orchestrator) and modifies nothing — so no
      // editor refresh either.
      const second = await getTool('put_external_layout_instances').run(
        {
          external_layout_name: 'SpawnPoint',
          layer_name: '',
          brush_kind: 'none',
          existing_instance_ids: instanceId,
        },
        collaborators
      );
      expect(second.output.success).toBe(true);
      expect(second.didModifyProject).toBe(false);
      expect(notifications).toHaveLength(1);
      expect(
        project
          .getExternalLayout('SpawnPoint')
          .getInitialInstances()
          .getInstancesCount()
      ).toBe(1);
    });
  });
});
