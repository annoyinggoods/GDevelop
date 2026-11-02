// @flow
import type { ByokExtraTool, ByokExtraToolResult } from './ByokExtraTools';

const gd: libGDevelop = global.gd;

/**
 * The sprite-internals tools (Phase 11, D11-2): one read
 * (`describe_sprite_frames`) and one write (`change_sprite_frames`) over
 * animations → directions → frames, covering frame images, origin/center,
 * custom points and collision masks. Every libGD caution the editor code
 * encodes is respected here: wrappers are re-resolved from indexes at EVERY
 * op (C++ vectors reallocate on add/remove — SpritesList's warning), and
 * every `new` wrapper is `delete()`d once the container copied it.
 */

/** How many frames describe_sprite_frames serializes before truncating. */
export const BYOK_SPRITE_DESCRIBE_MAX_FRAMES = 120;

const makeFailure = (message: string): ByokExtraToolResult => ({
  output: { success: false, message },
  didModifyProject: false,
});

/**
 * Resolve the sprite configuration of an object the way
 * `change_object_properties_effects` resolves its target: scene objects
 * first, then globals — and refuse anything that is not a Sprite object.
 */
export const resolveByokSpriteConfiguration = (
  project: any,
  sceneName: string,
  objectName: string
): {|
  configuration: any | null,
  layout: any | null,
  failure: ?ByokExtraToolResult,
|} => {
  if (!project.hasLayoutNamed(sceneName)) {
    return {
      configuration: null,
      layout: null,
      failure: makeFailure(`Scene not found: "${sceneName}".`),
    };
  }
  const layout = project.getLayout(sceneName);
  const layoutObjects = layout.getObjects();
  const globalObjects = project.getObjects();
  let object = null;
  if (layoutObjects.hasObjectNamed(objectName)) {
    object = layoutObjects.getObject(objectName);
  } else if (globalObjects.hasObjectNamed(objectName)) {
    object = globalObjects.getObject(objectName);
  }
  if (!object) {
    return {
      configuration: null,
      layout,
      failure: makeFailure(
        `Object not found: "${objectName}" in scene "${sceneName}" nor globally.`
      ),
    };
  }
  if (object.getType() !== 'Sprite') {
    return {
      configuration: null,
      layout,
      failure: makeFailure(
        `Object "${objectName}" is of type "${object.getType()}", not "Sprite" — the sprite frame tools only apply to Sprite objects.`
      ),
    };
  }
  return {
    configuration: gd.asSpriteConfiguration(object.getConfiguration()),
    layout,
    failure: null,
  };
};

const describePoint = (point: any) => ({
  name: point.getName(),
  x: point.getX(),
  y: point.getY(),
});

const describeFrame = (sprite: any) => {
  const points = sprite.getAllNonDefaultPoints();
  const customPoints = [];
  for (let index = 0; index < points.size(); index++) {
    customPoints.push(describePoint(points.at(index)));
  }
  const mask = sprite.getCustomCollisionMask();
  const polygons = [];
  for (let index = 0; index < mask.size(); index++) {
    polygons.push(
      mask
        .at(index)
        .getVertices()
        .size()
    );
  }
  return {
    image: sprite.getImageName(),
    origin: { x: sprite.getOrigin().getX(), y: sprite.getOrigin().getY() },
    center: {
      x: sprite.getCenter().getX(),
      y: sprite.getCenter().getY(),
      isDefault: sprite.isDefaultCenterPoint(),
    },
    points: customPoints,
    collisionMask: {
      fullImage: sprite.isFullImageCollisionMask(),
      polygonVertexCounts: polygons,
    },
  };
};

/**
 * Serialize a whole sprite object. Returns `{animations, truncated}` — the
 * frame cap keeps the output bounded (stated in the tool output).
 */
export const describeByokSpriteFrames = (
  animations: any,
  maxFrames: number
): {| animations: Array<Object>, truncated: boolean |} => {
  const described: Array<Object> = [];
  let frameCount = 0;
  let truncated = false;
  for (let index = 0; index < animations.getAnimationsCount(); index++) {
    if (truncated) break;
    const animation = animations.getAnimation(index);
    const directions = [];
    for (
      let directionIndex = 0;
      directionIndex < animation.getDirectionsCount();
      directionIndex++
    ) {
      if (truncated) break;
      const direction = animation.getDirection(directionIndex);
      const frames = [];
      for (
        let frameIndex = 0;
        frameIndex < direction.getSpritesCount();
        frameIndex++
      ) {
        if (frameCount >= maxFrames) {
          truncated = true;
          break;
        }
        frames.push(describeFrame(direction.getSprite(frameIndex)));
        frameCount++;
      }
      directions.push({
        timeBetweenFrames: direction.getTimeBetweenFrames(),
        isLooping: direction.isLooping(),
        frames,
      });
    }
    described.push({
      name: animation.getName(),
      useMultipleDirections: animation.useMultipleDirections(),
      directions,
    });
  }
  return { animations: described, truncated };
};

// ---------------------------------------------------------------------------
// change_sprite_frames: the typed ops list. Every handler re-resolves its
// wrappers from the indexes (never cached across ops) and deletes anything
// it `new`ed once the container copied it.
// ---------------------------------------------------------------------------

type SpriteFrameOpResult = {| applied: string | null, error: string | null |};

const makeOpError = (message: string): SpriteFrameOpResult => ({
  applied: null,
  error: message,
});

/**
 * Locate the animation an op targets (index re-resolved from the CURRENT
 * state, with the precise out-of-range message).
 */
const locateSpriteAnimation = (
  animations: any,
  op: Object
): {| animation: any | null, error: string | null |} => {
  const animationIndex = op.animation_index;
  if (typeof animationIndex !== 'number' || animationIndex < 0) {
    return {
      animation: null,
      error: 'animation_index is required (a number).',
    };
  }
  if (animationIndex >= animations.getAnimationsCount()) {
    return {
      animation: null,
      error: `animation_index ${animationIndex} does not exist (${animations.getAnimationsCount()} animation(s)).`,
    };
  }
  return { animation: animations.getAnimation(animationIndex), error: null };
};

/**
 * Locate the animation/direction/frame an op targets, re-resolved from the
 * CURRENT indexes (never cached across ops), with a precise message for a
 * missing or out-of-range index — the model needs to know which one.
 */
const locateSpriteFrameLocation = (
  animations: any,
  op: Object,
  needFrame: boolean
): {|
  animation: any | null,
  direction: any | null,
  frame: any | null,
  error: string | null,
|} => {
  const { animation, error } = locateSpriteAnimation(animations, op);
  if (!animation) {
    return { animation: null, direction: null, frame: null, error };
  }

  const directionIndex = op.direction_index;
  if (typeof directionIndex !== 'number' || directionIndex < 0) {
    return {
      animation,
      direction: null,
      frame: null,
      error: 'direction_index is required (a number).',
    };
  }
  if (directionIndex >= animation.getDirectionsCount()) {
    return {
      animation,
      direction: null,
      frame: null,
      error: `direction_index ${directionIndex} does not exist (${animation.getDirectionsCount()} direction(s) in animation ${
        op.animation_index
      }).`,
    };
  }
  const direction = animation.getDirection(directionIndex);

  if (!needFrame) {
    return { animation, direction, frame: null, error: null };
  }
  const frameIndex = op.frame_index;
  if (typeof frameIndex !== 'number' || frameIndex < 0) {
    return {
      animation,
      direction,
      frame: null,
      error: 'frame_index is required (a number).',
    };
  }
  if (frameIndex >= direction.getSpritesCount()) {
    return {
      animation,
      direction,
      frame: null,
      error: `frame_index ${frameIndex} does not exist (${direction.getSpritesCount()} frame(s) in animation ${
        op.animation_index
      }, direction ${directionIndex}).`,
    };
  }
  return {
    animation,
    direction,
    frame: direction.getSprite(frameIndex),
    error: null,
  };
};

/** Build one polygon from an op definition (vertices or a moved rectangle). */
const buildPolygonFromDefinition = (definition: Object): any | null => {
  if (!definition || typeof definition !== 'object') return null;
  if (definition.rectangle) {
    const rectangle = definition.rectangle;
    // Every numeric reaches embind unvalidated otherwise — a string or a
    // missing width is a type error or a NaN polygon accepted as valid
    // (audit011026 B-TOOL-6).
    const isFiniteNumber = (value: any): boolean =>
      typeof value === 'number' && Number.isFinite(value);
    if (
      !isFiniteNumber(rectangle.width) ||
      !isFiniteNumber(rectangle.height) ||
      !isFiniteNumber(rectangle.center_x || 0) ||
      !isFiniteNumber(rectangle.center_y || 0)
    ) {
      return null;
    }
    const polygon = gd.Polygon2d.createRectangle(
      rectangle.width,
      rectangle.height
    );
    polygon.move(rectangle.center_x || 0, rectangle.center_y || 0);
    return polygon;
  }
  if (Array.isArray(definition.vertices)) {
    const polygon = new gd.Polygon2d();
    const vertices = polygon.getVertices();
    for (const vertex of definition.vertices) {
      if (
        !vertex ||
        typeof vertex.x !== 'number' ||
        typeof vertex.y !== 'number'
      ) {
        polygon.delete();
        return null;
      }
      const vector = new gd.Vector2f();
      vector.x = vertex.x;
      vector.y = vertex.y;
      vertices.push_back(vector);
      vector.delete();
    }
    return polygon;
  }
  return null;
};

/** Write the polygon definitions onto one frame's live mask vector. */
const applyPolygonMaskToFrame = (
  sprite: any,
  polygons: Array<Object>
): boolean => {
  // Build and validate every polygon BEFORE touching the frame: a bad
  // definition must leave the previous mask in place (no partial apply).
  const built: Array<any> = [];
  for (const definition of polygons) {
    const polygon = buildPolygonFromDefinition(definition);
    if (!polygon) {
      // Orphans were never pushed into the mask, so deleting them is safe
      // (the same lifecycle as the invalid-vertex path above).
      for (const orphan of built) orphan.delete();
      return false;
    }
    built.push(polygon);
  }
  sprite.setFullImageCollisionMask(false);
  const mask = sprite.getCustomCollisionMask();
  mask.clear();
  for (const polygon of built) {
    // The editor's own lifecycle (PolygonsList.addCollisionMask): a polygon
    // pushed into the mask vector is NOT delete()d afterwards — unlike
    // Sprite/Point/Vector2f wrappers. Deleting it corrupts the wasm heap.
    mask.push_back(polygon);
  }
  return true;
};

/** Iterate every frame of the configuration (the all_frames targets). */
const forEachFrame = (
  animations: any,
  visitor: (
    sprite: any,
    animationIndex: number,
    directionIndex: number,
    frameIndex: number
  ) => void
): void => {
  for (
    let animationIndex = 0;
    animationIndex < animations.getAnimationsCount();
    animationIndex++
  ) {
    const animation = animations.getAnimation(animationIndex);
    for (
      let directionIndex = 0;
      directionIndex < animation.getDirectionsCount();
      directionIndex++
    ) {
      const direction = animation.getDirection(directionIndex);
      for (
        let frameIndex = 0;
        frameIndex < direction.getSpritesCount();
        frameIndex++
      ) {
        visitor(
          direction.getSprite(frameIndex),
          animationIndex,
          directionIndex,
          frameIndex
        );
      }
    }
  }
};

/** Point coordinates of an op: absent fields are 0, non-numbers are refused. */
const readPointCoordinates = (op: Object): ?{| x: number, y: number |} => {
  const readAxis = (value: any): number | null => {
    if (value === undefined || value === null) return 0;
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return value;
  };
  const x = readAxis(op.x);
  const y = readAxis(op.y);
  if (x === null || y === null) return null;
  return { x, y };
};

const runSpriteFrameOp = (animations: any, op: Object): SpriteFrameOpResult => {
  const kind = typeof op.op === 'string' ? op.op : '';
  switch (kind) {
    case 'add_animation': {
      const animation = new gd.Animation();
      animation.setDirectionsCount(1);
      if (typeof op.name === 'string' && op.name) animation.setName(op.name);
      animations.addAnimation(animation);
      animation.delete();
      return { applied: 'Added an animation.', error: null };
    }
    case 'remove_animation': {
      const { animation, error } = locateSpriteAnimation(animations, op);
      if (!animation) return makeOpError(error || 'remove_animation failed.');
      animations.removeAnimation(op.animation_index);
      return {
        applied: `Removed animation ${op.animation_index}.`,
        error: null,
      };
    }
    case 'move_animation': {
      const { animation, error } = locateSpriteAnimation(animations, op);
      if (!animation || typeof op.to_index !== 'number') {
        return makeOpError(
          error || 'move_animation needs a to_index (a number).'
        );
      }
      animations.moveAnimation(op.animation_index, op.to_index);
      return {
        applied: `Moved animation ${op.animation_index} to ${op.to_index}.`,
        error: null,
      };
    }
    case 'rename_animation': {
      const { animation, error } = locateSpriteAnimation(animations, op);
      if (!animation || typeof op.new_name !== 'string') {
        return makeOpError(error || 'rename_animation needs a new_name.');
      }
      animation.setName(op.new_name);
      return {
        applied: `Renamed animation ${op.animation_index} to "${op.new_name}".`,
        error: null,
      };
    }
    case 'set_directions_count': {
      const { animation, error } = locateSpriteAnimation(animations, op);
      if (!animation || typeof op.count !== 'number' || op.count < 0) {
        return makeOpError(
          error || 'set_directions_count needs a count (a number >= 0).'
        );
      }
      animation.setDirectionsCount(op.count);
      return {
        applied: `Set directions count of animation ${op.animation_index} to ${
          op.count
        }.`,
        error: null,
      };
    }
    case 'add_frame': {
      const location = locateSpriteFrameLocation(animations, op, false);
      const direction = location.direction;
      if (!direction || typeof op.image_name !== 'string') {
        return makeOpError(location.error || 'add_frame needs an image_name.');
      }
      const sprite = new gd.Sprite();
      sprite.setImageName(op.image_name);
      direction.addSprite(sprite);
      sprite.delete();
      return {
        applied: `Added a frame with image "${op.image_name}".`,
        error: null,
      };
    }
    case 'remove_frame':
    case 'move_frame':
    case 'set_frame_image': {
      const location = locateSpriteFrameLocation(animations, op, true);
      const { direction, frame } = location;
      if (!direction || !frame) {
        return makeOpError(location.error || 'Locating the frame failed.');
      }
      if (kind === 'remove_frame') {
        direction.removeSprite(op.frame_index);
        return { applied: `Removed frame ${op.frame_index}.`, error: null };
      }
      if (kind === 'move_frame') {
        if (typeof op.to_index !== 'number') {
          return makeOpError('move_frame needs a to_index (a number).');
        }
        direction.moveSprite(op.frame_index, op.to_index);
        return {
          applied: `Moved frame ${op.frame_index} to ${op.to_index}.`,
          error: null,
        };
      }
      if (typeof op.image_name !== 'string') {
        return makeOpError('set_frame_image needs an image_name.');
      }
      frame.setImageName(op.image_name);
      return {
        applied: `Set frame ${op.frame_index} image to "${op.image_name}".`,
        error: null,
      };
    }
    case 'set_origin':
    case 'set_center': {
      const location = locateSpriteFrameLocation(animations, op, true);
      const frame = location.frame;
      if (!frame || typeof op.x !== 'number' || typeof op.y !== 'number') {
        return makeOpError(location.error || `${kind} needs numeric x and y.`);
      }
      if (kind === 'set_origin') {
        frame.getOrigin().setXY(op.x, op.y);
      } else {
        frame.getCenter().setXY(op.x, op.y);
        frame.setDefaultCenterPoint(false);
      }
      return { applied: `${kind} set to ${op.x},${op.y}.`, error: null };
    }
    case 'set_default_center': {
      const location = locateSpriteFrameLocation(animations, op, true);
      const frame = location.frame;
      if (!frame) {
        return makeOpError(location.error || 'Locating the frame failed.');
      }
      frame.setDefaultCenterPoint(true);
      return { applied: 'Center reset to the default.', error: null };
    }
    case 'add_point': {
      const location = locateSpriteFrameLocation(animations, op, true);
      const frame = location.frame;
      if (!frame || typeof op.name !== 'string' || !op.name) {
        return makeOpError(location.error || 'add_point needs a name.');
      }
      const pointCoordinates = readPointCoordinates(op);
      if (!pointCoordinates) {
        return makeOpError(
          'add_point needs numeric x/y (missing values default to 0).'
        );
      }
      const point = new gd.Point(op.name);
      point.setXY(pointCoordinates.x, pointCoordinates.y);
      frame.addPoint(point);
      point.delete();
      return { applied: `Added point "${op.name}".`, error: null };
    }
    case 'move_point': {
      const location = locateSpriteFrameLocation(animations, op, true);
      const frame = location.frame;
      if (!frame || typeof op.name !== 'string' || !frame.hasPoint(op.name)) {
        return makeOpError(
          location.error ||
            `move_point: no point named "${String(op.name)}" on that frame.`
        );
      }
      const moveCoordinates = readPointCoordinates(op);
      if (!moveCoordinates) {
        return makeOpError(
          'move_point needs numeric x/y (missing values default to 0).'
        );
      }
      frame.getPoint(op.name).setXY(moveCoordinates.x, moveCoordinates.y);
      return { applied: `Moved point "${op.name}".`, error: null };
    }
    case 'remove_point': {
      const location = locateSpriteFrameLocation(animations, op, true);
      const frame = location.frame;
      if (!frame || typeof op.name !== 'string' || !frame.hasPoint(op.name)) {
        return makeOpError(
          location.error ||
            `remove_point: no point named "${String(op.name)}" on that frame.`
        );
      }
      frame.delPoint(op.name);
      return { applied: `Removed point "${op.name}".`, error: null };
    }
    case 'set_full_image_mask': {
      const fullImage = op.full_image !== false;
      if (op.all_frames === true) {
        forEachFrame(animations, sprite => {
          if (fullImage) animations.setAdaptCollisionMaskAutomatically(false);
          sprite.setFullImageCollisionMask(fullImage);
        });
        return {
          applied: `Set full-image collision mask to ${String(
            fullImage
          )} on ALL frames.`,
          error: null,
        };
      }
      const location = locateSpriteFrameLocation(animations, op, true);
      const frame = location.frame;
      if (!frame) {
        return makeOpError(location.error || 'Locating the frame failed.');
      }
      if (fullImage) animations.setAdaptCollisionMaskAutomatically(false);
      frame.setFullImageCollisionMask(fullImage);
      return {
        applied: `Set full-image collision mask to ${String(
          fullImage
        )} on the frame.`,
        error: null,
      };
    }
    case 'set_polygon_mask': {
      const polygons = Array.isArray(op.polygons) ? op.polygons : [];
      if (polygons.length === 0) {
        return makeOpError(
          'set_polygon_mask needs a non-empty polygons array.'
        );
      }
      if (op.all_frames === true) {
        let allApplied = true;
        forEachFrame(animations, sprite => {
          if (!applyPolygonMaskToFrame(sprite, polygons)) allApplied = false;
        });
        if (!allApplied) {
          return makeOpError(
            'A polygon definition is invalid (each needs vertices [{x,y}] or a rectangle).'
          );
        }
        return {
          applied: 'Set the polygon collision mask on ALL frames.',
          error: null,
        };
      }
      const location = locateSpriteFrameLocation(animations, op, true);
      const frame = location.frame;
      if (!frame) {
        return makeOpError(location.error || 'Locating the frame failed.');
      }
      if (!applyPolygonMaskToFrame(frame, polygons)) {
        return makeOpError(
          'A polygon definition is invalid (each needs vertices [{x,y}] or a rectangle).'
        );
      }
      return {
        applied: 'Set the polygon collision mask on the frame.',
        error: null,
      };
    }
    case 'set_adapt_collision_masks': {
      animations.setAdaptCollisionMaskAutomatically(op.enabled === true);
      return {
        applied: `Automatic collision-mask adaptation ${
          op.enabled === true ? 'enabled' : 'disabled'
        }.`,
        error: null,
      };
    }
    default:
      return makeOpError(`Unknown op "${kind}".`);
  }
};

/**
 * Apply the ops list sequentially. Ops are independent edits: each one is
 * validated against the CURRENT state (wrappers never cached across ops),
 * applied ones are reported, a failed op is reported and SKIPPED — the
 * following ops still run (the model retries the failed one from the
 * describe output).
 */
export const runByokSpriteFrameOps = (
  animations: any,
  ops: Array<Object>
): {| applied: Array<string>, failures: Array<string> |} => {
  const applied: Array<string> = [];
  const failures: Array<string> = [];
  for (const op of ops) {
    if (!op || typeof op !== 'object') {
      failures.push('An op entry is not an object.');
      continue;
    }
    // Per-op containment (audit011026 B-TOOL-6): one embind throw used to
    // unwind the whole tool call after a partial apply — the documented
    // contract is "failed operations are reported and skipped".
    try {
      const result = runSpriteFrameOp(animations, op);
      if (result.applied) applied.push(result.applied);
      if (result.error) failures.push(result.error);
    } catch (error) {
      failures.push(
        `The op "${String(op.op)}" failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  return { applied, failures };
};

const makeDescribeSpriteFramesTool = (): ByokExtraTool => ({
  name: 'describe_sprite_frames',
  modifiesProject: false,
  run: async (args, collaborators): Promise<ByokExtraToolResult> => {
    const project = collaborators.getProject();
    if (!project) {
      return makeFailure('No project is open — open or create one first.');
    }
    const sceneName =
      typeof args.scene_name === 'string' ? args.scene_name : '';
    const objectName =
      typeof args.object_name === 'string' ? args.object_name : '';
    if (!sceneName || !objectName) {
      return makeFailure('Both scene_name and object_name are required.');
    }
    const { configuration, failure } = resolveByokSpriteConfiguration(
      project,
      sceneName,
      objectName
    );
    if (failure) return failure;
    if (!configuration) {
      return makeFailure('The object could not be resolved.');
    }

    const animations = configuration.getAnimations();
    const described = describeByokSpriteFrames(
      animations,
      BYOK_SPRITE_DESCRIBE_MAX_FRAMES
    );
    return {
      output: {
        success: true,
        objectName,
        animations: described.animations,
        adaptCollisionMaskAutomatically: animations.adaptCollisionMaskAutomatically(),
        truncated: described.truncated,
        note: described.truncated
          ? `Only the first ${BYOK_SPRITE_DESCRIBE_MAX_FRAMES} frames are shown.`
          : undefined,
      },
      didModifyProject: false,
    };
  },
});

const makeChangeSpriteFramesTool = (): ByokExtraTool => ({
  name: 'change_sprite_frames',
  modifiesProject: true,
  run: async (args, collaborators): Promise<ByokExtraToolResult> => {
    const project = collaborators.getProject();
    if (!project) {
      return makeFailure('No project is open — open or create one first.');
    }
    const sceneName =
      typeof args.scene_name === 'string' ? args.scene_name : '';
    const objectName =
      typeof args.object_name === 'string' ? args.object_name : '';
    const operations = Array.isArray(args.operations) ? args.operations : [];
    if (!sceneName || !objectName) {
      return makeFailure('Both scene_name and object_name are required.');
    }
    if (operations.length === 0) {
      return makeFailure('The "operations" list is required.');
    }
    const { configuration, layout, failure } = resolveByokSpriteConfiguration(
      project,
      sceneName,
      objectName
    );
    if (failure) return failure;
    if (!configuration) {
      return makeFailure('The object could not be resolved.');
    }

    const { applied, failures } = runByokSpriteFrameOps(
      configuration.getAnimations(),
      operations
    );
    if (applied.length === 0) {
      return {
        output: {
          success: false,
          message: `No operation could be applied: ${failures.join(' ')}`,
          failures,
        },
        didModifyProject: false,
      };
    }
    if (collaborators.onObjectsModifiedOutsideEditor && layout) {
      collaborators.onObjectsModifiedOutsideEditor({
        scene: layout,
        isNewObjectTypeUsed: false,
      });
    }
    return {
      output: {
        success: true,
        message: `Applied ${applied.length} operation(s)${
          failures.length > 0 ? `, ${failures.length} skipped` : ''
        }.`,
        applied,
        failures: failures.length > 0 ? failures : undefined,
      },
      didModifyProject: true,
    };
  },
});

/** The sprite-internals tools (a fresh read, like ByokExtraTools). */
export const getByokSpriteTools = (): Array<ByokExtraTool> => [
  makeDescribeSpriteFramesTool(),
  makeChangeSpriteFramesTool(),
];
