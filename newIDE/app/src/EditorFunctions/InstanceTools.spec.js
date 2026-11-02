// @flow
import {
  collectIteratedInstances,
  describeInstancesInContainer,
  extractRequiredString,
  getLayerNameForMessage,
  getOccupiedSpaceDescription,
  INSTANCE_POSITION_SEMANTICS_MESSAGE,
  injectObjectSizeInfo,
  iterateOnInstances,
  makeGenericFailure,
  makeRequestedIdByInstance,
  makeWrongObjectInstanceIdsFailure,
  putInstancesInContainer,
  resolveExistingInstanceIds,
} from './InstanceTools';
import { unserializeFromJSObject } from '../Utils/Serializer';
import { makeFakeLaunchFunctionOptionsWithProject } from './TestHelpers';
import type { ObjectSizeInfo } from './Utils';
import type { EditorFunctionGenericOutput } from './index';

const gd: libGDevelop = global.gd;

const makeProjectWithSceneAndExternalLayout = () => {
  const project = gd.ProjectHelper.createNewGDJSProject();
  const scene = project.insertNewLayout('TestScene', 0);
  const sceneObjects = scene.getObjects();
  sceneObjects.insertNewObject(project, 'Sprite', 'Player', 0);
  const externalLayout = project.insertNewExternalLayout('SpawnPoint', 0);
  externalLayout.setAssociatedLayout('TestScene');
  return { project, scene, externalLayout };
};

const insertInstance = (
  container: gdInitialInstancesContainer,
  objectName: string,
  x: number,
  y: number
) => {
  const instance = container.insertNewInitialInstance();
  instance.setObjectName(objectName);
  instance.setX(x);
  instance.setY(y);
  return instance;
};

const listInstances = (
  container: gdInitialInstancesContainer
): Array<{| objectName: string, x: number, y: number, id: string |}> => {
  const instances = [];
  iterateOnInstances(container, instance => {
    instances.push({
      objectName: instance.getObjectName(),
      x: instance.getX(),
      y: instance.getY(),
      id: instance.getPersistentUuid().slice(0, 10),
    });
  });
  return instances;
};

type UuidInstanceFixture = {|
  objectName: string,
  x: number,
  y: number,
  persistentUuid: string,
|};

const makeUuidInstance = (
  objectName: string,
  x: number,
  y: number,
  persistentUuid: string
): UuidInstanceFixture => ({ objectName, x, y, persistentUuid });

// Unserialize instances with chosen persistent uuids (clearing the container),
// so id-prefix matching can be exercised with controlled prefixes.
const unserializeInstancesWithUuids = (
  project: gdProject,
  container: gdInitialInstancesContainer,
  instances: Array<UuidInstanceFixture>
) => {
  unserializeFromJSObject(
    container,
    instances.map(({ objectName, x, y, persistentUuid }) => ({
      name: objectName,
      x,
      y,
      layer: '',
      persistentUuid,
    })),
    'unserializeFrom',
    project
  );
};

// Two instances whose uuids share their first 6 characters ("abcdef"): the
// id-matching must refuse such an ambiguous id instead of matching both.
const SHARED_PREFIX = 'abcdef';
const FIRST_UUID = 'abcdef-1111-4111-8111-111111111111';
const SECOND_UUID = 'abcdef-2222-4222-8222-222222222222';

const makeInstancesWithSharedUuidPrefix = (
  project: gdProject,
  container: gdInitialInstancesContainer
) => {
  unserializeInstancesWithUuids(project, container, [
    makeUuidInstance('Player', 0, 0, FIRST_UUID),
    makeUuidInstance('Player', 100, 200, SECOND_UUID),
  ]);
};

describe('InstanceTools', () => {
  let project: gdProject;
  let scene: gdLayout;
  let externalLayout: gdExternalLayout;

  beforeEach(() => {
    const fixtures = makeProjectWithSceneAndExternalLayout();
    project = fixtures.project;
    scene = fixtures.scene;
    externalLayout = fixtures.externalLayout;
  });

  afterEach(() => {
    project.delete();
  });

  describe('extractRequiredString', () => {
    it('returns the string when present', () => {
      expect(extractRequiredString({ name: 'Player' }, 'name')).toBe('Player');
    });

    it('throws on a missing or non-string value', () => {
      expect(() => extractRequiredString({}, 'name')).toThrow(
        'Missing or invalid required string argument: name'
      );
      expect(() => extractRequiredString({ name: 3 }, 'name')).toThrow();
    });
  });

  describe('makeGenericFailure', () => {
    it('builds a failure output', () => {
      expect(makeGenericFailure('Broken.')).toEqual({
        success: false,
        message: 'Broken.',
      });
    });
  });

  describe('getLayerNameForMessage', () => {
    it('names the base layer by its real (empty) name', () => {
      expect(getLayerNameForMessage('')).toBe('the base layer ("")');
      expect(getLayerNameForMessage('UI')).toBe('layer "UI"');
    });
  });

  describe('getOccupiedSpaceDescription', () => {
    it('describes the space from the position and size (origin at the min corner)', () => {
      expect(getOccupiedSpaceDescription([10, 20], [32, 32], null)).toBe(
        'X 10 to 42, Y 20 to 52'
      );
    });

    it('shifts the min corner by the origin, scaled to the actual size', () => {
      const objectSizeInfo: ObjectSizeInfo = {
        width: 64,
        height: 64,
        depth: null,
        originX: 16,
        originY: 32,
        originZ: null,
        centerX: null,
        centerY: null,
        centerZ: null,
      };
      // The origin (16;32 at the default 64x64 size) scales to 8;16 for a
      // 32x32 instance, so the occupied space starts before the position.
      expect(
        getOccupiedSpaceDescription([10, 20], [32, 32], objectSizeInfo)
      ).toBe('X 2 to 34, Y 4 to 36');
    });
  });

  describe('injectObjectSizeInfo', () => {
    const makeSizeInfo = (width: number | null): ObjectSizeInfo => ({
      width,
      height: width,
      depth: null,
      originX: 0,
      originY: 0,
      originZ: null,
      centerX: null,
      centerY: null,
      centerZ: null,
    });

    it('attaches the size info and hints about objects without a known size', () => {
      const output: EditorFunctionGenericOutput = {
        success: true,
        message: 'Done.',
      };
      const knownSize = makeSizeInfo(32);
      const unknownSize = makeSizeInfo(null);

      // The enriched output carries the optional fields the injection set.
      const result: any = injectObjectSizeInfo(output, {
        Player: knownSize,
        Score: unknownSize,
      });
      expect(result.objectSizeInfo.Player).toBe(knownSize);
      expect(result.hints).toHaveLength(1);
      expect(result.hints[0].code).toBe('no-intrinsic-size');
      expect(result.hints[0].objectNames).toEqual(['Score']);
    });

    it('keeps hints a previous injection added', () => {
      const unknownSize = makeSizeInfo(null);
      const emptyOutput: EditorFunctionGenericOutput = {
        success: true,
        message: '',
      };
      const result: any = injectObjectSizeInfo(
        injectObjectSizeInfo(emptyOutput, { Score: unknownSize }),
        { Timer: unknownSize }
      );
      expect(result.hints).toHaveLength(2);
      expect(result.hints[1].objectNames).toEqual(['Timer']);
    });
  });

  describe('INSTANCE_POSITION_SEMANTICS_MESSAGE', () => {
    it('explains the origin-based positioning', () => {
      expect(INSTANCE_POSITION_SEMANTICS_MESSAGE).toContain(
        'origin, NOT its center'
      );
      expect(INSTANCE_POSITION_SEMANTICS_MESSAGE).toContain(
        'center an instance'
      );
    });
  });

  describe('makeWrongObjectInstanceIdsFailure', () => {
    it('lists the offending ids and leaves everything unchanged', () => {
      const output = makeWrongObjectInstanceIdsFailure('Player', [
        '"abc" (instance of "Enemy")',
      ]);
      expect(output.success).toBe(false);
      expect(output.message).toContain('do not belong to object "Player"');
      expect(output.message).toContain('Nothing was changed');
    });
  });

  describe('collectIteratedInstances', () => {
    it('collects the instances of a container with their persistent uuids', () => {
      makeInstancesWithSharedUuidPrefix(project, scene.getInitialInstances());

      const entries = collectIteratedInstances(scene.getInitialInstances());
      expect(entries.map(entry => entry.persistentUuid)).toEqual([
        FIRST_UUID,
        SECOND_UUID,
      ]);
      // The collected entries carry live instances, not detached copies.
      expect(entries[0].instance.getX()).toBe(0);
      expect(entries[1].instance.getX()).toBe(100);
    });
  });

  describe('resolveExistingInstanceIds', () => {
    it('resolves an exact full uuid', () => {
      makeInstancesWithSharedUuidPrefix(project, scene.getInitialInstances());
      const entries = collectIteratedInstances(scene.getInitialInstances());

      const resolution = resolveExistingInstanceIds(entries, [FIRST_UUID]);
      expect(resolution.ok).toBe(true);
      if (!resolution.ok) return;
      expect(resolution.matches.size).toBe(1);
      expect(resolution.matches.get(FIRST_UUID)).toBe(entries[0].instance);
      expect(resolution.notFound).toEqual([]);
    });

    it('resolves an unambiguous uuid prefix', () => {
      makeInstancesWithSharedUuidPrefix(project, scene.getInitialInstances());
      const entries = collectIteratedInstances(scene.getInitialInstances());

      // Only the second uuid starts with "abcdef-2".
      const resolution = resolveExistingInstanceIds(entries, ['abcdef-2']);
      expect(resolution.ok).toBe(true);
      if (!resolution.ok) return;
      expect(resolution.matches.size).toBe(1);
      expect(resolution.matches.get('abcdef-2')).toBe(entries[1].instance);
      expect(resolution.notFound).toEqual([]);
    });

    it('fails, listing the candidates, when the id is a prefix of several uuids', () => {
      makeInstancesWithSharedUuidPrefix(project, scene.getInitialInstances());
      const entries = collectIteratedInstances(scene.getInitialInstances());

      const resolution = resolveExistingInstanceIds(entries, [SHARED_PREFIX]);
      expect(resolution.ok).toBe(false);
      if (resolution.ok) return;
      expect(resolution.error).toContain(`"${SHARED_PREFIX}"`);
      expect(resolution.error).toContain(FIRST_UUID);
      expect(resolution.error).toContain(SECOND_UUID);
      expect(resolution.error).toContain('Nothing was changed');
    });

    it('prefers an exact uuid match over a longer uuid starting with it', () => {
      const first = insertInstance(scene.getInitialInstances(), 'Player', 0, 0);
      const second = insertInstance(
        scene.getInitialInstances(),
        'Player',
        100,
        200
      );
      // The second uuid starts with the whole first uuid: the exact match
      // must win instead of failing as ambiguous.
      const entries = [
        { persistentUuid: 'exact-uuid', instance: first },
        { persistentUuid: 'exact-uuid-tail', instance: second },
      ];

      const resolution = resolveExistingInstanceIds(entries, ['exact-uuid']);
      expect(resolution.ok).toBe(true);
      if (!resolution.ok) return;
      expect(resolution.matches.get('exact-uuid')).toBe(first);
      expect(resolution.notFound).toEqual([]);
    });

    it('reports ids matching no uuid as not found', () => {
      makeInstancesWithSharedUuidPrefix(project, scene.getInitialInstances());
      const entries = collectIteratedInstances(scene.getInitialInstances());

      const resolution = resolveExistingInstanceIds(entries, [
        'zzzzzz-unknown',
        FIRST_UUID,
      ]);
      expect(resolution.ok).toBe(true);
      if (!resolution.ok) return;
      expect(resolution.matches.size).toBe(1);
      expect(resolution.notFound).toEqual(['zzzzzz-unknown']);
    });
  });

  describe('makeRequestedIdByInstance', () => {
    it('attributes each instance to the first requested id that resolved to it', () => {
      const first = insertInstance(scene.getInitialInstances(), 'Player', 0, 0);
      const second = insertInstance(
        scene.getInitialInstances(),
        'Player',
        100,
        200
      );
      // "short-id" and "longer-id..." both resolve to the same instance.
      const matches = new Map<string, gdInitialInstance>([
        ['short-id', first],
        ['longer-id-of-the-same-instance', first],
        ['other-id', second],
      ]);

      const requestedIdByInstance = makeRequestedIdByInstance(matches);
      expect(requestedIdByInstance.size).toBe(2);
      expect(requestedIdByInstance.get(first)).toBe('short-id');
      expect(requestedIdByInstance.get(second)).toBe('other-id');
    });
  });

  describe('describeInstancesInContainer', () => {
    it('serializes the instances of a scene layout', () => {
      insertInstance(scene.getInitialInstances(), 'Player', 10, 20);

      const { instances, objectSizeInfoByName } = describeInstancesInContainer({
        initialInstances: scene.getInitialInstances(),
        layersContainer: scene,
        objectsContainer: scene.getObjects(),
        globalObjects: project.getObjects(),
        project,
        PixiResourcesLoader: makeFakeLaunchFunctionOptionsWithProject(project)
          .PixiResourcesLoader,
        objectNames: new Set(),
      });

      expect(instances).toHaveLength(1);
      expect(instances[0].name).toBe('Player');
      expect(instances[0].x).toBe(10);
      expect(instances[0].y).toBe(20);
      expect(typeof instances[0].id).toBe('string');
      expect(Object.keys(objectSizeInfoByName)).toContain('Player');
    });

    it('describes an external layout container through the associated scene layers', () => {
      insertInstance(externalLayout.getInitialInstances(), 'Player', 5, 6);

      const { instances } = describeInstancesInContainer({
        initialInstances: externalLayout.getInitialInstances(),
        layersContainer: scene,
        objectsContainer: scene.getObjects(),
        globalObjects: project.getObjects(),
        project,
        PixiResourcesLoader: makeFakeLaunchFunctionOptionsWithProject(project)
          .PixiResourcesLoader,
        objectNames: new Set(),
      });

      expect(instances).toHaveLength(1);
      expect(instances[0].name).toBe('Player');
    });

    it('filters by object name (case-insensitive)', () => {
      insertInstance(scene.getInitialInstances(), 'Player', 0, 0);
      insertInstance(scene.getInitialInstances(), 'NonMatching', 1, 1);

      const { instances } = describeInstancesInContainer({
        initialInstances: scene.getInitialInstances(),
        layersContainer: scene,
        objectsContainer: scene.getObjects(),
        globalObjects: project.getObjects(),
        project,
        PixiResourcesLoader: makeFakeLaunchFunctionOptionsWithProject(project)
          .PixiResourcesLoader,
        objectNames: new Set(['player']),
      });

      expect(instances).toHaveLength(1);
      expect(instances[0].name).toBe('Player');
    });
  });

  describe('putInstancesInContainer', () => {
    const makePutOptions = (
      project: gdProject,
      container: gdInitialInstancesContainer,
      layersContainer: gdLayout,
      args: Object,
      onInstancesModified: () => void
    ) => ({
      args,
      project,
      toolsVersion: undefined,
      initialInstances: container,
      layersContainer,
      objectsContainer: layersContainer.getObjects(),
      globalObjects: project.getObjects(),
      containerLabel: 'scene "TestScene"',
      onInstancesModified,
      PixiResourcesLoader: makeFakeLaunchFunctionOptionsWithProject(project)
        .PixiResourcesLoader,
    });

    it('creates an instance with the point brush', async () => {
      let notified = 0;
      const output = await putInstancesInContainer(
        makePutOptions(
          project,
          scene.getInitialInstances(),
          scene,
          {
            layer_name: '',
            brush_kind: 'point',
            brush_position: '100, 150',
            object_name: 'Player',
            new_instances_count: 1,
          },
          () => {
            notified++;
          }
        )
      );

      expect(output.success).toBe(true);
      expect(notified).toBe(1);
      const instances = listInstances(scene.getInitialInstances());
      expect(instances).toHaveLength(1);
      expect(instances[0].objectName).toBe('Player');
      expect(instances[0].x).toBe(100);
      expect(instances[0].y).toBe(150);
    });

    it('erases instances by id', async () => {
      const instance = insertInstance(
        scene.getInitialInstances(),
        'Player',
        0,
        0
      );
      const id = instance.getPersistentUuid().slice(0, 10);

      const output = await putInstancesInContainer(
        makePutOptions(
          project,
          scene.getInitialInstances(),
          scene,
          {
            layer_name: '',
            brush_kind: 'erase',
            object_name: 'Player',
            existing_instance_ids: id,
          },
          () => {}
        )
      );

      expect(output.success).toBe(true);
      expect(listInstances(scene.getInitialInstances())).toHaveLength(0);
    });

    it('fails and modifies nothing when an id matches several instances', async () => {
      makeInstancesWithSharedUuidPrefix(project, scene.getInitialInstances());

      const output = await putInstancesInContainer(
        makePutOptions(
          project,
          scene.getInitialInstances(),
          scene,
          {
            layer_name: '',
            brush_kind: 'point',
            brush_position: '500, 500',
            existing_instance_ids: SHARED_PREFIX,
          },
          () => {}
        )
      );

      expect(output.success).toBe(false);
      expect(output.message).toContain('ambiguous');
      expect(output.message).toContain(FIRST_UUID);
      expect(output.message).toContain(SECOND_UUID);
      // Neither instance was moved.
      const positions = listInstances(scene.getInitialInstances()).map(
        ({ x, y }) => ({ x, y })
      );
      expect(positions).toEqual([{ x: 0, y: 0 }, { x: 100, y: 200 }]);
    });

    it('fails and erases nothing when an id matches several instances', async () => {
      makeInstancesWithSharedUuidPrefix(project, scene.getInitialInstances());

      const output = await putInstancesInContainer(
        makePutOptions(
          project,
          scene.getInitialInstances(),
          scene,
          {
            layer_name: '',
            brush_kind: 'erase',
            existing_instance_ids: SHARED_PREFIX,
          },
          () => {}
        )
      );

      expect(output.success).toBe(false);
      expect(output.message).toContain('ambiguous');
      expect(listInstances(scene.getInitialInstances())).toHaveLength(2);
    });

    it('resolves a full uuid to its single instance', async () => {
      makeInstancesWithSharedUuidPrefix(project, scene.getInitialInstances());

      const output = await putInstancesInContainer(
        makePutOptions(
          project,
          scene.getInitialInstances(),
          scene,
          {
            layer_name: '',
            brush_kind: 'point',
            brush_position: '500, 500',
            existing_instance_ids: FIRST_UUID,
          },
          () => {}
        )
      );

      expect(output.success).toBe(true);
      expect(output.message).toContain('Repositioned 1 instance');
      // Only the first instance was moved, the second one is untouched.
      const positions = listInstances(scene.getInitialInstances()).map(
        ({ x, y }) => ({ x, y })
      );
      expect(positions).toEqual([{ x: 500, y: 500 }, { x: 100, y: 200 }]);
    });

    it('still resolves a unique id prefix, as reported by describe_instances', async () => {
      makeInstancesWithSharedUuidPrefix(project, scene.getInitialInstances());

      const output = await putInstancesInContainer(
        makePutOptions(
          project,
          scene.getInitialInstances(),
          scene,
          {
            layer_name: '',
            brush_kind: 'point',
            brush_position: '500, 500',
            existing_instance_ids: 'abcdef-2',
          },
          () => {}
        )
      );

      expect(output.success).toBe(true);
      // Only the second instance (whose uuid starts with "abcdef-2") moved.
      const positions = listInstances(scene.getInitialInstances()).map(
        ({ x, y }) => ({ x, y })
      );
      expect(positions).toEqual([{ x: 0, y: 0 }, { x: 500, y: 500 }]);
    });

    it('still reports the not-found failure for an unknown id', async () => {
      insertInstance(scene.getInitialInstances(), 'Player', 0, 0);

      const output = await putInstancesInContainer(
        makePutOptions(
          project,
          scene.getInitialInstances(),
          scene,
          {
            layer_name: '',
            brush_kind: 'none',
            existing_instance_ids: 'zzzzzz-unknown',
            instances_z_order: 42,
          },
          () => {}
        )
      );

      expect(output.success).toBe(false);
      expect(output.message).toContain(
        'None of the specified instance ids were found: zzzzzz-unknown'
      );
      // The unmatched instance is untouched.
      const instances = listInstances(scene.getInitialInstances());
      expect(instances).toHaveLength(1);
      expect(instances[0].x).toBe(0);
    });

    it('fails with the container label when the layer does not exist', async () => {
      const output = await putInstancesInContainer(
        makePutOptions(
          project,
          scene.getInitialInstances(),
          scene,
          {
            layer_name: 'NoSuchLayer',
            brush_kind: 'point',
            brush_position: '0, 0',
            object_name: 'Player',
            new_instances_count: 1,
          },
          () => {}
        )
      );

      expect(output.success).toBe(false);
      expect(output.message).toContain('Layer not found: NoSuchLayer');
      expect(output.message).toContain('in scene "TestScene"');
    });

    it('populates an external layout container without touching the scene', async () => {
      const output = await putInstancesInContainer(
        makePutOptions(
          project,
          externalLayout.getInitialInstances(),
          scene,
          {
            layer_name: '',
            brush_kind: 'point',
            brush_position: '7, 8',
            object_name: 'Player',
            new_instances_count: 2,
          },
          () => {}
        )
      );

      expect(output.success).toBe(true);
      expect(listInstances(externalLayout.getInitialInstances())).toHaveLength(
        2
      );
      expect(listInstances(scene.getInitialInstances())).toHaveLength(0);
    });
  });
});
