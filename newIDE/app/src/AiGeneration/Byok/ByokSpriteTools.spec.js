// @flow
import {
  describeByokSpriteFrames,
  getByokSpriteTools,
  resolveByokSpriteConfiguration,
  runByokSpriteFrameOps,
} from './ByokSpriteTools';

const gd: libGDevelop = global.gd;

const makeSpriteProject = () => {
  const project = gd.ProjectHelper.createNewGDJSProject();
  const scene = project.insertNewLayout('TestScene', 0);
  scene.getObjects().insertNewObject(project, 'Sprite', 'Player', 0);
  scene.getObjects().insertNewObject(project, 'Text', 'Label', 0);
  return project;
};

const getAnimations = (project: gdProject, objectName: string) => {
  const object = project
    .getLayout('TestScene')
    .getObjects()
    .getObject(objectName);
  return gd.asSpriteConfiguration(object.getConfiguration()).getAnimations();
};

/** Give the object one animation with one direction and N image frames. */
const seedFrames = (animations: any, imageNames: Array<string>): void => {
  const animation = new gd.Animation();
  animation.setName('Idle');
  animation.setDirectionsCount(1);
  const direction = animation.getDirection(0);
  for (const imageName of imageNames) {
    const sprite = new gd.Sprite();
    sprite.setImageName(imageName);
    direction.addSprite(sprite);
    sprite.delete();
  }
  animations.addAnimation(animation);
  animation.delete();
};

const getTool = (name: string): any =>
  getByokSpriteTools().find(tool => tool.name === name);

describe('ByokSpriteTools', () => {
  let project: gdProject;

  beforeEach(() => {
    project = makeSpriteProject();
  });

  afterEach(() => {
    project.delete();
  });

  describe('resolveByokSpriteConfiguration', () => {
    it('resolves a scene Sprite object', () => {
      const { configuration, failure } = resolveByokSpriteConfiguration(
        project,
        'TestScene',
        'Player'
      );
      expect(failure).toBeNull();
      expect(configuration).toBeTruthy();
    });

    it('refuses a non-Sprite object with a typed failure', () => {
      const { configuration, failure } = resolveByokSpriteConfiguration(
        project,
        'TestScene',
        'Label'
      );
      expect(configuration).toBeNull();
      expect(failure?.output.message).toContain('not "Sprite"');
    });

    it('fails on an unknown object or scene', () => {
      expect(
        resolveByokSpriteConfiguration(project, 'TestScene', 'Ghost').failure
          ?.output.message
      ).toContain('Object not found');
      expect(
        resolveByokSpriteConfiguration(project, 'NoScene', 'Player').failure
          ?.output.message
      ).toContain('Scene not found');
    });
  });

  describe('describeByokSpriteFrames', () => {
    it('serializes animations, frames, points and mask modes', () => {
      const animations = getAnimations(project, 'Player');
      seedFrames(animations, ['stand.png', 'walk.png']);

      const { animations: described, truncated } = describeByokSpriteFrames(
        animations,
        120
      );
      expect(truncated).toBe(false);
      expect(described).toHaveLength(1);
      expect(described[0].name).toBe('Idle');
      expect(described[0].directions).toHaveLength(1);
      expect(described[0].directions[0].frames).toHaveLength(2);
      expect(described[0].directions[0].frames[0].image).toBe('stand.png');
      // The stored flag is false on fresh frames (the engine's default).
      expect(described[0].directions[0].frames[0].collisionMask.fullImage).toBe(
        false
      );
    });

    it('truncates at the frame cap and says so', () => {
      const animations = getAnimations(project, 'Player');
      seedFrames(
        animations,
        Array.from({ length: 5 }, (_, index) => `frame${index}.png`)
      );

      const { animations: described, truncated } = describeByokSpriteFrames(
        animations,
        3
      );
      expect(truncated).toBe(true);
      expect(described[0].directions[0].frames).toHaveLength(3);
    });
  });

  describe('runByokSpriteFrameOps (round-trips per op family)', () => {
    it('adds and reorders animations, sets directions count', () => {
      const animations = getAnimations(project, 'Player');
      const { applied, failures } = runByokSpriteFrameOps(animations, [
        { op: 'add_animation', name: 'Idle' },
        { op: 'add_animation', name: 'Run' },
        { op: 'rename_animation', animation_index: 0, new_name: 'IdleRenamed' },
        { op: 'set_directions_count', animation_index: 0, count: 2 },
        { op: 'move_animation', animation_index: 1, to_index: 0 },
      ]);

      expect(failures).toEqual([]);
      expect(applied).toHaveLength(5);
      expect(animations.getAnimationsCount()).toBe(2);
      expect(animations.getAnimation(0).getName()).toBe('Run');
      expect(animations.getAnimation(1).getName()).toBe('IdleRenamed');
      expect(animations.getAnimation(1).getDirectionsCount()).toBe(2);
    });

    it('adds, reorders, retargets and removes frames', () => {
      const animations = getAnimations(project, 'Player');
      seedFrames(animations, ['a.png']);
      const { failures } = runByokSpriteFrameOps(animations, [
        {
          op: 'add_frame',
          animation_index: 0,
          direction_index: 0,
          image_name: 'b.png',
        },
        {
          op: 'set_frame_image',
          animation_index: 0,
          direction_index: 0,
          frame_index: 1,
          image_name: 'c.png',
        },
        {
          op: 'move_frame',
          animation_index: 0,
          direction_index: 0,
          frame_index: 1,
          to_index: 0,
        },
        {
          op: 'remove_frame',
          animation_index: 0,
          direction_index: 0,
          frame_index: 1,
        },
      ]);

      expect(failures).toEqual([]);
      const direction = animations.getAnimation(0).getDirection(0);
      expect(direction.getSpritesCount()).toBe(1);
      expect(direction.getSprite(0).getImageName()).toBe('c.png');
    });

    it('manages origin, center and points', () => {
      const animations = getAnimations(project, 'Player');
      seedFrames(animations, ['a.png']);
      const { failures } = runByokSpriteFrameOps(animations, [
        {
          op: 'set_origin',
          animation_index: 0,
          direction_index: 0,
          frame_index: 0,
          x: 4,
          y: 6,
        },
        {
          op: 'set_center',
          animation_index: 0,
          direction_index: 0,
          frame_index: 0,
          x: 10,
          y: 12,
        },
        {
          op: 'add_point',
          animation_index: 0,
          direction_index: 0,
          frame_index: 0,
          name: 'Gun',
          x: 1,
          y: 2,
        },
        {
          op: 'move_point',
          animation_index: 0,
          direction_index: 0,
          frame_index: 0,
          name: 'Gun',
          x: 3,
          y: 4,
        },
      ]);

      expect(failures).toEqual([]);
      const frame = animations
        .getAnimation(0)
        .getDirection(0)
        .getSprite(0);
      expect(frame.getOrigin().getX()).toBe(4);
      expect(frame.getCenter().getX()).toBe(10);
      expect(frame.isDefaultCenterPoint()).toBe(false);
      expect(frame.getPoint('Gun').getX()).toBe(3);

      const removal = runByokSpriteFrameOps(animations, [
        {
          op: 'remove_point',
          animation_index: 0,
          direction_index: 0,
          frame_index: 0,
          name: 'Gun',
        },
        {
          op: 'set_default_center',
          animation_index: 0,
          direction_index: 0,
          frame_index: 0,
        },
      ]);
      expect(removal.failures).toEqual([]);
      expect(frame.hasPoint('Gun')).toBe(false);
      expect(frame.isDefaultCenterPoint()).toBe(true);
    });

    it('sets polygon and full-image masks, per frame and on all frames', () => {
      const animations = getAnimations(project, 'Player');
      seedFrames(animations, ['a.png', 'b.png']);
      const { failures } = runByokSpriteFrameOps(animations, [
        {
          op: 'set_polygon_mask',
          animation_index: 0,
          direction_index: 0,
          frame_index: 0,
          polygons: [
            {
              vertices: [
                { x: 0, y: 0 },
                { x: 10, y: 0 },
                { x: 10, y: 10 },
                { x: 0, y: 10 },
              ],
            },
          ],
        },
        { op: 'set_full_image_mask', all_frames: true, full_image: true },
        {
          op: 'set_polygon_mask',
          all_frames: true,
          polygons: [
            { rectangle: { width: 8, height: 8, center_x: 4, center_y: 4 } },
          ],
        },
        { op: 'set_adapt_collision_masks', enabled: false },
      ]);

      expect(failures).toEqual([]);
      const direction = animations.getAnimation(0).getDirection(0);
      const firstFrame = direction.getSprite(0);
      expect(firstFrame.isFullImageCollisionMask()).toBe(false);
      expect(firstFrame.getCustomCollisionMask().size()).toBe(1);
      expect(
        firstFrame
          .getCustomCollisionMask()
          .at(0)
          .getVertices()
          .size()
      ).toBe(4);
      const secondFrame = direction.getSprite(1);
      expect(secondFrame.getCustomCollisionMask().size()).toBe(1);
      expect(animations.adaptCollisionMaskAutomatically()).toBe(false);
    });

    it('reports failed ops without stopping the batch', () => {
      const animations = getAnimations(project, 'Player');
      seedFrames(animations, ['a.png']);
      const { applied, failures } = runByokSpriteFrameOps(animations, [
        {
          op: 'remove_frame',
          animation_index: 0,
          direction_index: 0,
          frame_index: 9,
        },
        {
          op: 'add_point',
          animation_index: 0,
          direction_index: 0,
          frame_index: 0,
          name: 'Head',
        },
        { op: 'no_such_op' },
      ]);

      expect(applied).toHaveLength(1);
      expect(failures).toHaveLength(2);
      expect(failures[0]).toContain('does not exist');
      expect(failures[1]).toContain('Unknown op');
    });

    it('deletes every wrapper it news (add_frame)', () => {
      const animations = getAnimations(project, 'Player');
      const originalSpriteConstructor = gd.Sprite;
      const deleteCount = { value: 0 };
      // Count delete() calls on the wrappers this op creates.
      const CountedSprite = function(): any {
        const instance = new (originalSpriteConstructor: any)();
        const originalDelete = instance.delete.bind(instance);
        instance.delete = () => {
          deleteCount.value += 1;
          originalDelete();
        };
        return instance;
      };
      (gd: any).Sprite = CountedSprite;
      try {
        runByokSpriteFrameOps(animations, [
          { op: 'add_animation' },
          {
            op: 'add_frame',
            animation_index: 0,
            direction_index: 0,
            image_name: 'x.png',
          },
        ]);
      } finally {
        (gd: any).Sprite = originalSpriteConstructor;
      }

      expect(deleteCount.value).toBe(1);
    });

    it('refuses an invalid polygon and leaves the previous mask in place', () => {
      const animations = getAnimations(project, 'Player');
      seedFrames(animations, ['a.png']);
      // A valid rectangle mask first.
      runByokSpriteFrameOps(animations, [
        {
          op: 'set_polygon_mask',
          animation_index: 0,
          direction_index: 0,
          frame_index: 0,
          polygons: [{ rectangle: { width: 8, height: 8 } }],
        },
      ]);

      // A later op with a bad second polygon must fail without touching
      // the frame (no partial apply: the rectangle survives).
      const { failures } = runByokSpriteFrameOps(animations, [
        {
          op: 'set_polygon_mask',
          animation_index: 0,
          direction_index: 0,
          frame_index: 0,
          polygons: [
            { vertices: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
            { vertices: [{ x: 'way', y: 0 }] },
          ],
        },
      ]);

      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('invalid');
      const frame = animations
        .getAnimation(0)
        .getDirection(0)
        .getSprite(0);
      expect(frame.isFullImageCollisionMask()).toBe(false);
      expect(frame.getCustomCollisionMask().size()).toBe(1);
      expect(
        frame
          .getCustomCollisionMask()
          .at(0)
          .getVertices()
          .size()
      ).toBe(4);
    });

    it('deletes the Animation, Point and Vector2f wrappers, but not a pushed polygon', () => {
      const animations = getAnimations(project, 'Player');
      seedFrames(animations, ['a.png']);
      const counts = {
        animation: 0,
        point: 0,
        vector: 0,
        polygon: 0,
      };
      const countConstructorDeletes = (
        className: string,
        key: $Keys<typeof counts>
      ) => {
        const Original: any = (gd: any)[className];
        const Counted = function(): any {
          const instance = new Original();
          const originalDelete = instance.delete.bind(instance);
          instance.delete = () => {
            counts[key] += 1;
            originalDelete();
          };
          return instance;
        };
        // The Polygon2d.createRectangle static factory must survive the
        // replacement (the vertex path uses `new`, the rectangle path
        // uses it). Only writable function properties can be copied.
        if (typeof Original.createRectangle === 'function') {
          (Counted: any).createRectangle = Original.createRectangle;
        }
        (gd: any)[className] = Counted;
        return () => {
          (gd: any)[className] = Original;
        };
      };
      const restores = [
        countConstructorDeletes('Animation', 'animation'),
        countConstructorDeletes('Point', 'point'),
        countConstructorDeletes('Vector2f', 'vector'),
        countConstructorDeletes('Polygon2d', 'polygon'),
      ];
      try {
        runByokSpriteFrameOps(animations, [
          { op: 'add_animation' },
          {
            op: 'add_point',
            animation_index: 0,
            direction_index: 0,
            frame_index: 0,
            name: 'Tail',
            x: 1,
            y: 2,
          },
          {
            op: 'set_polygon_mask',
            animation_index: 0,
            direction_index: 0,
            frame_index: 0,
            polygons: [
              {
                vertices: [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 6 }],
              },
            ],
          },
        ]);
      } finally {
        for (const restore of restores) restore();
      }

      expect(counts.animation).toBe(1);
      expect(counts.point).toBe(1);
      expect(counts.vector).toBe(3);
      // The polygon was pushed into the live mask: it must NOT be deleted
      // (deleting a pushed polygon corrupts the wasm heap — the editor's
      // own lifecycle asymmetry, encoded in applyPolygonMaskToFrame).
      expect(counts.polygon).toBe(0);
    });
  });

  describe('the tools', () => {
    it('describe_sprite_frames reads through the tool', async () => {
      seedFrames(getAnimations(project, 'Player'), ['a.png']);
      const result = await getTool('describe_sprite_frames').run(
        { scene_name: 'TestScene', object_name: 'Player' },
        ({ getProject: () => project }: any)
      );

      expect(result.output.success).toBe(true);
      expect(result.didModifyProject).toBe(false);
      expect(result.output.animations[0].directions[0].frames[0].image).toBe(
        'a.png'
      );
    });

    it('change_sprite_frames applies and notifies about object changes', async () => {
      seedFrames(getAnimations(project, 'Player'), ['a.png']);
      const notifications: Array<any> = [];
      const result = await getTool('change_sprite_frames').run(
        {
          scene_name: 'TestScene',
          object_name: 'Player',
          operations: [
            {
              op: 'add_frame',
              animation_index: 0,
              direction_index: 0,
              image_name: 'b.png',
            },
          ],
        },
        {
          getProject: () => project,
          onObjectsModifiedOutsideEditor: changes =>
            notifications.push(changes),
        }
      );

      expect(result.output.success).toBe(true);
      expect(result.didModifyProject).toBe(true);
      expect(notifications).toHaveLength(1);
      expect(notifications[0].isNewObjectTypeUsed).toBe(false);
      expect(
        getAnimations(project, 'Player')
          .getAnimation(0)
          .getDirection(0)
          .getSpritesCount()
      ).toBe(2);
    });

    it('refuses non-sprite objects through the tool', async () => {
      const result = await getTool('describe_sprite_frames').run(
        { scene_name: 'TestScene', object_name: 'Label' },
        ({ getProject: () => project }: any)
      );

      expect(result.output.success).toBe(false);
      expect(result.output.message).toContain('not "Sprite"');
    });
  });
});
