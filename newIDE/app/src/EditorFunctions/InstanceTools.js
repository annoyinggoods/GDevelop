// @flow
import { getInstancesInLayoutForLayer } from '../Utils/Layout';
import { mapFor } from '../Utils/MapFor';
import { SafeExtractor } from '../Utils/SafeExtractor';
import { serializeToJSObject } from '../Utils/Serializer';
import {
  getObjectSizeInfo,
  getObjectSizeInfoHints,
  type ObjectSizeInfo,
} from './Utils';
import { isNoOpConsideredSuccess } from './IsNoOpConsideredSuccess';
import type { EditorFunctionGenericOutput } from './index';

/**
 * The container-generic core of the instance tools (extracted in Phase 11
 * from `index.js`, behavior-preserving): the instance-walking and
 * brush-application logic of `describe_instances` and `put_2d_instances`,
 * taking the `gdInitialInstancesContainer` (and the objects/layers
 * containers around it) as parameters — so scene layouts AND external
 * layouts can be read and populated through the same code. The shared
 * helpers below moved here (rather than staying in `index.js`) so this
 * module is a leaf: `index.js` imports them back, never the opposite at
 * runtime (only the `EditorFunctionGenericOutput` type is imported, which
 * is erased at build time).
 */

const gd: libGDevelop = global.gd;

/**
 * Helper function to safely extract required string arguments.
 */
export const extractRequiredString = (
  args: any,
  propertyName: string
): string => {
  const value = SafeExtractor.extractStringProperty(args, propertyName);
  if (value === null) {
    throw new Error(
      `Missing or invalid required string argument: ${propertyName}`
    );
  }
  return value;
};

export const makeGenericFailure = (
  message: string
): EditorFunctionGenericOutput => ({
  success: false,
  message,
});

export const iterateOnInstances = (
  initialInstances: gdInitialInstancesContainer,
  callback: gdInitialInstance => void
) => {
  const instanceGetter = new gd.InitialInstanceJSFunctor();
  // $FlowFixMe[cannot-write]
  instanceGetter.invoke = instancePtr => {
    const instance: gdInitialInstance = gd.wrapPointer(
      // $FlowFixMe[incompatible-type]
      instancePtr,
      gd.InitialInstance
    );
    callback(instance);
  };
  // $FlowFixMe[incompatible-type]
  initialInstances.iterateOverInstances(instanceGetter);
  instanceGetter.delete();
};

// An instance collected by one iteration pass over a container, with the
// persistent uuid it must be searched by.
export type IteratedInstance = {|
  persistentUuid: string,
  instance: gdInitialInstance,
|};

/**
 * Collect the instances of a container (with their persistent uuids) in a
 * single iteration pass, so ids can be resolved against them without
 * re-walking the container for each id.
 */
export const collectIteratedInstances = (
  initialInstances: gdInitialInstancesContainer
): Array<IteratedInstance> => {
  const iteratedInstances: Array<IteratedInstance> = [];
  iterateOnInstances(initialInstances, instance => {
    iteratedInstances.push({
      persistentUuid: instance.getPersistentUuid(),
      instance,
    });
  });
  return iteratedInstances;
};

export type ExistingInstanceIdsResolution =
  | {|
      ok: true,
      matches: Map<string, gdInitialInstance>,
      notFound: Array<string>,
    |}
  | {| ok: false, error: string |};

/**
 * Resolve the ids given in `existing_instance_ids` against the collected
 * instances of the container. A requested id is either the full persistent
 * uuid of an instance, or an unambiguous prefix of one (ids are reported
 * truncated by `describe_instances`). An id that is a prefix of SEVERAL
 * instance uuids is a targeting mistake: the whole resolution fails so the
 * caller refuses to erase/modify all of them, instead of silently widening
 * the operation like a plain `uuid.startsWith(id)` match would.
 */
export const resolveExistingInstanceIds = (
  iteratedInstances: Array<IteratedInstance>,
  requestedIds: Array<string>
): ExistingInstanceIdsResolution => {
  const matches = new Map<string, gdInitialInstance>();
  const notFound: Array<string> = [];

  for (const requestedId of requestedIds) {
    // An exact full-uuid match always wins, even if the id is also a prefix
    // of other uuids.
    const exactMatch = iteratedInstances.find(
      entry => entry.persistentUuid === requestedId
    );
    if (exactMatch) {
      matches.set(requestedId, exactMatch.instance);
      continue;
    }

    // Otherwise the id must be the prefix of exactly one uuid.
    const prefixMatches = iteratedInstances.filter(entry =>
      entry.persistentUuid.startsWith(requestedId)
    );
    if (prefixMatches.length === 1) {
      matches.set(requestedId, prefixMatches[0].instance);
      continue;
    }
    if (prefixMatches.length > 1) {
      return {
        ok: false,
        error: `The instance id "${requestedId}" is ambiguous: it is a prefix of ${
          prefixMatches.length
        } instance ids (${prefixMatches
          .map(entry => entry.persistentUuid)
          .join(
            ', '
          )}). Nothing was changed. Pass the full id of a single instance (the \`id\` field from \`describe_instances\`).`,
      };
    }
    notFound.push(requestedId);
  }

  return { ok: true, matches, notFound };
};

/**
 * Invert the requested-id → instance resolution into an instance →
 * requested-id attribution: when several requested ids resolve to the same
 * instance (e.g. an id and a longer id of that same instance), only the first
 * one is kept, so each instance is processed exactly once by the callers.
 */
export const makeRequestedIdByInstance = (
  matches: Map<string, gdInitialInstance>
): Map<gdInitialInstance, string> => {
  const requestedIdByInstance = new Map<gdInitialInstance, string>();
  matches.forEach((instance, requestedId) => {
    if (!requestedIdByInstance.has(instance)) {
      requestedIdByInstance.set(instance, requestedId);
    }
  });
  return requestedIdByInstance;
};

// An id pointing at another object's instance is always a targeting mistake:
// fail loudly instead of silently modifying or erasing the wrong object.
export const makeWrongObjectInstanceIdsFailure = (
  objectName: string,
  wrongObjectIdDescriptions: Array<string>
): EditorFunctionGenericOutput =>
  makeGenericFailure(
    `These \`existing_instance_ids\` do not belong to object "${objectName}": ${wrongObjectIdDescriptions.join(
      ', '
    )}. Nothing was changed. Pass ids of "${objectName}" instances (from \`describe_instances\`), fix \`object_name\`, or omit \`object_name\` to target these instances.`
  );

export const injectObjectSizeInfo = (
  output: EditorFunctionGenericOutput,
  objectSizeInfoByName: { [string]: ObjectSizeInfo | null }
): EditorFunctionGenericOutput => {
  output.objectSizeInfo = objectSizeInfoByName;
  const hints = getObjectSizeInfoHints(objectSizeInfoByName);
  if (hints.length > 0) {
    output.hints = output.hints ? [...output.hints, ...hints] : hints;
  }
  return output;
};

export const INSTANCE_POSITION_SEMANTICS_MESSAGE =
  'Each instance x;y;z is its origin, NOT its center. Unless `objectSizeInfo` indicates a custom origin, the origin is the minimum corner: an instance occupies x to x+width, y to y+height and (in 3D) z to z+depth, so its center is at position + size/2. To center an instance A on top of an instance B: A.x = B.x + (B.width - A.width)/2, A.y = B.y + (B.height - A.height)/2, A.z = B.z + B.depth.';

export const getOccupiedSpaceDescription = (
  position: $ReadOnlyArray<number>,
  size: $ReadOnlyArray<number>,
  objectSizeInfo: ObjectSizeInfo | null
): string => {
  const round = (value: number) => Math.round(value * 100) / 100;
  const axes = ['X', 'Y', 'Z'];
  const originOffsets = [0, 0, 0];
  if (objectSizeInfo) {
    const defaultSizes = [
      objectSizeInfo.width,
      objectSizeInfo.height,
      objectSizeInfo.depth,
    ];
    const origins = [
      objectSizeInfo.originX,
      objectSizeInfo.originY,
      objectSizeInfo.originZ,
    ];
    for (let i = 0; i < size.length; i++) {
      const defaultSize = defaultSizes[i];
      const origin = origins[i];
      // Origin offsets are given for the default size - scale them to the actual size.
      if (origin && defaultSize) {
        originOffsets[i] = origin * (size[i] / defaultSize);
      }
    }
  }
  return size
    .map((sizeOnAxis, i) => {
      const min = position[i] - originOffsets[i];
      return `${axes[i]} ${round(min)} to ${round(min + sizeOnAxis)}`;
    })
    .join(', ');
};

// The base layer's real name is the empty string: never display it as "base"
// in tool results, as this teaches the AI a layer name that does not exist.
export const getLayerNameForMessage = (layerName: string): string =>
  layerName === '' ? 'the base layer ("")' : `layer "${layerName}"`;

export type DescribeInstancesInContainerOptions = {|
  initialInstances: gdInitialInstancesContainer,
  // A layout-like object: the layers the instances can live on (an external
  // layout borrows the layers of its associated scene).
  layersContainer: gdLayout,
  // Where the instances' objects are looked up (a scene's own objects, an
  // external layout's children or the associated scene's objects).
  objectsContainer: gdObjectsContainer,
  globalObjects: gdObjectsContainer,
  project: gdProject,
  PixiResourcesLoader: any,
  objectNames: Set<string>,
|};

/**
 * Walk the instances of any container (a scene layout or an external
 * layout), serializing each one exactly like `describe_instances` does.
 * Returns the serialized instances and the per-object size info, leaving
 * the scene/external-layout-specific labeling to the caller.
 */
export const describeInstancesInContainer = (
  options: DescribeInstancesInContainerOptions
): {|
  instances: Array<Object>,
  objectSizeInfoByName: { [string]: ObjectSizeInfo | null },
|} => {
  const {
    initialInstances,
    layersContainer,
    objectsContainer,
    globalObjects,
    project,
    PixiResourcesLoader,
    objectNames,
  } = options;

  const instances = [];
  const objectSizeInfoByName: { [string]: ObjectSizeInfo | null } = {};

  // For each layer
  mapFor(0, layersContainer.getLayersCount(), i => {
    const layer = layersContainer.getLayerAt(i);
    const layerName = layer.getName();

    getInstancesInLayoutForLayer(initialInstances, layerName).forEach(
      instance => {
        if (
          objectNames.size > 0 &&
          !objectNames.has(instance.getObjectName().toLowerCase())
        ) {
          return;
        }

        const objectName = instance.getObjectName();
        let object = null;
        if (objectsContainer.hasObjectNamed(objectName)) {
          object = objectsContainer.getObject(objectName);
        } else if (globalObjects.hasObjectNamed(objectName)) {
          object = globalObjects.getObject(objectName);
        }

        const sizeInfo = object
          ? getObjectSizeInfo(object, project, PixiResourcesLoader)
          : null;
        if (object && !(objectName in objectSizeInfoByName)) {
          objectSizeInfoByName[objectName] = sizeInfo;
        }

        const defaultSize = object
          ? sizeInfo
          : { width: 0, height: 0, depth: 0 };

        const width = instance.hasCustomSize()
          ? instance.getCustomWidth()
          : defaultSize
          ? defaultSize.width
          : null;
        const height = instance.hasCustomSize()
          ? instance.getCustomHeight()
          : defaultSize
          ? defaultSize.height
          : null;
        const depth = instance.hasCustomDepth()
          ? instance.getCustomDepth()
          : defaultSize
          ? defaultSize.depth
          : null;

        const serializedInstance = serializeToJSObject(instance);
        instances.push({
          ...serializedInstance,
          // Replace persistentUuid by id:
          persistentUuid: undefined,
          id: instance.getPersistentUuid().slice(0, 10),
          // The serializer omits z when it's 0 - always expose it for 3D objects:
          z: depth !== null ? instance.getZ() : undefined,
          // Actual computed dimensions (accounting for default size when no custom size is set):
          width,
          height,
          depth,
          // Expose the per-instance variables (overrides of the object
          // variables), but only when there are some, to keep the output
          // compact. Absence means the instance uses the object variables.
          initialVariables:
            serializedInstance.initialVariables &&
            serializedInstance.initialVariables.length > 0
              ? serializedInstance.initialVariables
              : undefined,
          // For now, don't expose these:
          numberProperties: undefined,
          stringProperties: undefined,
        });
      }
    );
  });

  return { instances, objectSizeInfoByName };
};

export type PutInstancesInContainerOptions = {|
  args: Object,
  project: gdProject,
  +toolsVersion: ?string,
  initialInstances: gdInitialInstancesContainer,
  // A layout-like object carrying the layers (see DescribeInstancesInContainerOptions).
  layersContainer: gdLayout,
  objectsContainer: gdObjectsContainer,
  globalObjects: gdObjectsContainer,
  // How the container is named in messages, e.g. `scene "My scene"`.
  containerLabel: string,
  // Fired once after the container was mutated, so the caller refreshes the
  // right editor (a scene or an external layout).
  onInstancesModified: () => void,
  PixiResourcesLoader: any,
|};

/**
 * Apply a `put_2d_instances`-shaped call (brush kinds, id targeting, resize
 * /rotate/opacity/z-order changes) to any `gdInitialInstancesContainer` —
 * a scene layout or an external layout. Everything scene-specific (the
 * scene lookup, the failure that lists the project's scenes, the editor
 * notification payload) stays with the caller.
 */
export const putInstancesInContainer = async (
  options: PutInstancesInContainerOptions
): Promise<EditorFunctionGenericOutput> => {
  const {
    args,
    project,
    toolsVersion,
    initialInstances,
    layersContainer,
    objectsContainer,
    globalObjects,
    containerLabel,
    onInstancesModified,
    PixiResourcesLoader,
  } = options;

  const object_name = SafeExtractor.extractStringProperty(args, 'object_name');
  const layer_name = extractRequiredString(args, 'layer_name');
  const requested_brush_kind = extractRequiredString(args, 'brush_kind');
  const brush_position = SafeExtractor.extractStringProperty(
    args,
    'brush_position'
  );
  const existing_instance_ids = SafeExtractor.extractStringProperty(
    args,
    'existing_instance_ids'
  );
  // A "none" brush with both a `brush_position` and `existing_instance_ids`
  // is contradictory ("none" never positions anything) but unambiguous: move
  // THOSE instances there. Read it as the "point" brush, which is what the
  // failure this replaces told the caller to do — every such call observed in
  // production meant exactly that. Without `existing_instance_ids` the intent
  // is genuinely unclear (create one? move all?), so that still fails.
  const brush_kind =
    requested_brush_kind === 'none' && brush_position && existing_instance_ids
      ? 'point'
      : requested_brush_kind;
  const brush_size = SafeExtractor.extractNumberProperty(args, 'brush_size');
  const brush_end_position = SafeExtractor.extractStringProperty(
    args,
    'brush_end_position'
  );
  const new_instances_count = SafeExtractor.extractNumberProperty(
    args,
    'new_instances_count'
  );
  const instances_z_order = SafeExtractor.extractNumberProperty(
    args,
    'instances_z_order'
  );
  const instances_size = SafeExtractor.extractStringProperty(
    args,
    'instances_size'
  );

  let namedObject: gdObject | null = null;
  if (object_name) {
    if (objectsContainer.hasObjectNamed(object_name)) {
      namedObject = objectsContainer.getObject(object_name);
    } else if (globalObjects.hasObjectNamed(object_name)) {
      namedObject = globalObjects.getObject(object_name);
    }
  }
  const objectSizeInfo = namedObject
    ? getObjectSizeInfo(namedObject, project, PixiResourcesLoader)
    : null;

  // Accept the frequent mistake of calling the base layer "base" (its real
  // name is the empty string) when no layer with that literal name exists.
  const layerName =
    layer_name !== '' &&
    layer_name.trim().toLowerCase() === 'base' &&
    !layersContainer.hasLayerNamed(layer_name)
      ? ''
      : layer_name;

  // Check if layer exists (empty string is allowed for base layer)
  if (layerName !== '' && !layersContainer.hasLayerNamed(layerName)) {
    return makeGenericFailure(
      `Layer not found: ${layerName} in ${containerLabel}.`
    );
  }

  // An empty id would match every instance (`uuid.startsWith('')` is always
  // true), so a trailing comma or a blank entry must never survive parsing.
  const existingInstanceIds = existing_instance_ids
    ? existing_instance_ids
        .split(',')
        .map(id => id.trim())
        .filter(Boolean)
    : [];

  if (brush_kind === 'erase') {
    const brushPosition = SafeExtractor.parseCommaSeparatedTwoFiniteNumbers(
      brush_position
    );
    const brushSize = brush_size || 0;

    // Resolve the requested ids against the existing instances before
    // touching anything: an id matching several instances must fail the call
    // instead of erasing all of them.
    const iteratedInstances = collectIteratedInstances(initialInstances);
    const resolution = resolveExistingInstanceIds(
      iteratedInstances,
      existingInstanceIds
    );
    if (!resolution.ok) {
      return makeGenericFailure(resolution.error);
    }
    const requestedIdByInstance = makeRequestedIdByInstance(resolution.matches);

    // Iterate on existing instances and remove them, and/or those inside the brush radius.
    const instancesToDelete = new Set<gdInitialInstance>();
    const notFoundExistingInstanceIds = new Set<string>(resolution.notFound);
    const wrongObjectIdDescriptions = [];

    iteratedInstances.forEach(({ instance }) => {
      const foundExistingInstanceId = requestedIdByInstance.get(instance);
      if (foundExistingInstanceId) {
        if (object_name && instance.getObjectName() !== object_name) {
          wrongObjectIdDescriptions.push(
            `"${foundExistingInstanceId}" (instance of "${instance.getObjectName()}")`
          );
          return;
        }
        instancesToDelete.add(instance);
        return;
      }

      // Explicit ids are authoritative: the brush must not widen the erase
      // to other instances (e.g. a co-located duplicate the ids single out).
      if (existingInstanceIds.length > 0) return;

      if (instance.getObjectName() !== object_name) return;

      if (!brushPosition) return;
      if (instance.getLayer() !== layerName) return; // Layer must be the same as specified when deleting instances with a brush.

      if (brushSize === 0) {
        if (
          instance.getX() === brushPosition[0] &&
          instance.getY() === brushPosition[1]
        ) {
          instancesToDelete.add(instance);
          return;
        }
      } else {
        const distance = Math.sqrt(
          Math.pow(instance.getX() - brushPosition[0], 2) +
            Math.pow(instance.getY() - brushPosition[1], 2)
        );
        if (distance <= brushSize) {
          instancesToDelete.add(instance);
          return;
        }
      }
    });

    if (object_name && wrongObjectIdDescriptions.length > 0) {
      return makeWrongObjectInstanceIdsFailure(
        object_name,
        wrongObjectIdDescriptions
      );
    }

    // An erase call that removed nothing is a failure: return a real error
    // signal instead of a misleading "Erased 0 instances." success that
    // could make the agent retry the same call in a loop, or believe the
    // instances are gone.
    if (instancesToDelete.size === 0) {
      return makeGenericFailure(
        [
          'No instance was erased.',
          notFoundExistingInstanceIds.size > 0
            ? `None of the specified instance ids were found: ${Array.from(
                notFoundExistingInstanceIds
              ).join(', ')}.`
            : 'No instance matched the brush (check `object_name`, the layer and the brush position/size).',
          'Call `describe_instances` to get valid ids (the `id` field of each instance), and check the scene and layer names.',
        ].join(' ')
      );
    }

    const erasedInstanceIds = [];
    instancesToDelete.forEach(instance => {
      erasedInstanceIds.push(instance.getPersistentUuid().slice(0, 10));
      initialInstances.removeInstance(instance);
    });

    // /!\ Tell the editor that some instances have potentially been modified (and even removed).
    // This will force the instances editor to destroy and mount again the
    // renderers to avoid keeping any references to existing instances, and also drop any selection.
    onInstancesModified();
    const eraseResult: EditorFunctionGenericOutput = {
      success: true,
      message: [
        `Erased ${instancesToDelete.size} instance${
          instancesToDelete.size > 1 ? 's' : ''
        } (id${
          erasedInstanceIds.length > 1 ? 's' : ''
        }: ${erasedInstanceIds.join(', ')}).`,
        notFoundExistingInstanceIds.size > 0
          ? `Instance ids not found: ${Array.from(
              notFoundExistingInstanceIds
            ).join(', ')}. Verify ids and layer names.`
          : '',
      ]
        .filter(Boolean)
        .join(' '),
    };
    if (object_name && objectSizeInfo)
      injectObjectSizeInfo(eraseResult, { [object_name]: objectSizeInfo });
    return eraseResult;
  } else {
    // An explicit `new_instances_count: 0` with no instances to modify means
    // the call has nothing to do. Fail instead of silently creating one
    // instance, which would end up as an unwanted duplicate.
    if (new_instances_count === 0 && existingInstanceIds.length === 0) {
      return makeGenericFailure(
        'Nothing to do: `new_instances_count` is 0 and no `existing_instance_ids` were given. Pass `new_instances_count` greater than 0 to create instances, or `existing_instance_ids` (from `describe_instances`) to modify existing ones.'
      );
    }

    const parsedBrushPosition = brush_position
      ? SafeExtractor.parseCommaSeparatedTwoFiniteNumbers(brush_position)
      : null;
    const brushSize = brush_size || 0;
    const brushEndPosition = SafeExtractor.parseCommaSeparatedTwoFiniteNumbers(
      brush_end_position
    );

    // The `line` and `grid` brushes need an end position to spread instances.
    // Fail early (before creating any instance) so the caller retries with a
    // valid request, instead of silently leaving every instance at the origin.
    if ((brush_kind === 'line' || brush_kind === 'grid') && !brushEndPosition) {
      return makeGenericFailure(
        `The "${brush_kind}" brush requires brush_end_position (the end of the ${brush_kind}). Provide it, or use the "point" brush to place instances at a single position.`
      );
    }

    // Compute the number of instances to create.
    const rowCount = SafeExtractor.extractNumberProperty(args, 'row_count');
    const columnCount = SafeExtractor.extractNumberProperty(
      args,
      'column_count'
    );

    // A fractional count would create one instance more than reported (the
    // creation loop runs `Math.ceil` times), and a negative one is always a
    // mistake: normalize to a whole number, and reject negatives.
    if (new_instances_count !== null && new_instances_count < 0) {
      return makeGenericFailure(
        `\`new_instances_count\` must be 0 or a positive integer (got ${new_instances_count}).`
      );
    }
    let newInstancesCount =
      new_instances_count !== null ? Math.round(new_instances_count) : 0;
    if (newInstancesCount === 0 && existingInstanceIds.length === 0) {
      newInstancesCount = rowCount && columnCount ? rowCount * columnCount : 1;
    }

    // Only brushes that give a position to instances can create new ones:
    // the "none" brush (or an unknown one) would silently pile up new
    // instances at a default position.
    const isPlacementBrush =
      brush_kind === 'point' ||
      brush_kind === 'line' ||
      brush_kind === 'grid' ||
      brush_kind === 'random_in_circle';

    // Without a positive radius, the "random" brush would silently stack
    // every instance at the exact brush position.
    if (brush_kind === 'random_in_circle' && brushSize <= 0) {
      return makeGenericFailure(
        'The "random_in_circle" brush requires a positive `brush_size` (the radius of the circle). Provide it, or use the "point" brush to place instances at a single position.'
      );
    }
    if (newInstancesCount > 0 && !isPlacementBrush) {
      return makeGenericFailure(
        `The "${brush_kind}" brush only modifies existing instances and cannot create new ones. To create instances, use the "point" brush (or "line"/"grid") with \`brush_position\`. To modify existing instances without moving them, use the "none" brush with \`existing_instance_ids\` (from \`describe_instances\`).`
      );
    }

    // As stated in the tool description, `brush_position` can only be
    // omitted when modifying existing instances with the "none" brush. Fail
    // instead of silently using a default position (like the scene center):
    // a call without a position is usually a modification that forgot
    // `existing_instance_ids`, or would drop every new instance at a
    // meaningless position.
    if (
      !parsedBrushPosition &&
      !(brush_kind === 'none' && newInstancesCount === 0)
    ) {
      return makeGenericFailure(
        newInstancesCount > 0
          ? `A valid \`brush_position\` is required to create ${newInstancesCount} new instance(s) (or pass \`existing_instance_ids\` from \`describe_instances\` if you meant to modify existing instances).`
          : `A valid \`brush_position\` is required for the "${brush_kind}" brush (or use the "none" brush to modify existing instances without moving them).`
      );
    }
    // After the guard, a missing position can only happen when nothing is
    // created nor moved ("none" brush only): the fallback is never used.
    const brushPosition: [number, number] = parsedBrushPosition || [0, 0];

    // Track changes for detailed success message
    const changes = [];

    // Creating instances without an object is impossible: an instance whose
    // object name is empty would be a corrupted, invisible orphan.
    if (newInstancesCount > 0 && !object_name) {
      return makeGenericFailure(
        `Cannot create ${newInstancesCount} new instance(s) without \`object_name\`. Nothing was changed. Pass \`object_name\` (an existing object of the scene), or only \`existing_instance_ids\` (with \`new_instances_count\` set to 0) to modify existing instances.`
      );
    }

    if (
      object_name &&
      !objectsContainer.hasObjectNamed(object_name) &&
      !globalObjects.hasObjectNamed(object_name)
    ) {
      return makeGenericFailure(
        `Object "${object_name}" not in ${containerLabel}. Use only existing objects (create them first if needed).`
      );
    }

    // Resolve the requested ids against the existing instances before
    // touching anything: an id matching several instances must fail the call
    // instead of modifying all of them.
    const resolution = resolveExistingInstanceIds(
      collectIteratedInstances(initialInstances),
      existingInstanceIds
    );
    if (!resolution.ok) {
      return makeGenericFailure(resolution.error);
    }
    const requestedIdByInstance = makeRequestedIdByInstance(resolution.matches);

    // Store original states of existing instances for comparison
    // $FlowFixMe[underconstrained-implicit-instantiation]
    const existingInstanceStates = new Map();
    const notFoundExistingInstanceIds = new Set<string>(resolution.notFound);
    const wrongObjectIdDescriptions = [];

    // Create the array of existing instances to move/modify, and new instances to create.
    const modifiedAndCreatedInstances: Array<gdInitialInstance> = [];
    requestedIdByInstance.forEach((foundExistingInstanceId, instance) => {
      if (object_name && instance.getObjectName() !== object_name) {
        wrongObjectIdDescriptions.push(
          `"${foundExistingInstanceId}" (instance of "${instance.getObjectName()}")`
        );
        return;
      }

      // Store original state before modifications
      existingInstanceStates.set(instance, {
        originalLayer: instance.getLayer(),
        originalX: instance.getX(),
        originalY: instance.getY(),
        originalZOrder: instance.getZOrder(),
        originalRotation: instance.getAngle(),
        originalOpacity: instance.getOpacity(),
        originalHidden: instance.isHidden(),
        originalCustomWidth: instance.hasCustomSize()
          ? instance.getCustomWidth()
          : null,
        originalCustomHeight: instance.hasCustomSize()
          ? instance.getCustomHeight()
          : null,
      });

      modifiedAndCreatedInstances.push(instance);
    });

    if (object_name && wrongObjectIdDescriptions.length > 0) {
      return makeWrongObjectInstanceIdsFailure(
        object_name,
        wrongObjectIdDescriptions
      );
    }

    // Move existing instances to the target layer only after the wrong-ids
    // guard: a failed call must leave every instance untouched.
    modifiedAndCreatedInstances.forEach(instance => {
      if (instance.getLayer() !== layerName) {
        instance.setLayer(layerName);
      }
    });

    for (let i = 0; i < newInstancesCount; i++) {
      const instance = initialInstances.insertNewInitialInstance();
      instance.setObjectName(object_name || '');
      instance.setLayer(layerName);
      modifiedAndCreatedInstances.push(instance);
    }

    // Paint the new/modified instances with the brush.
    if (brush_kind === 'line') {
      const instancesCount = modifiedAndCreatedInstances.length;

      if (brushPosition && brushEndPosition) {
        const deltaX =
          instancesCount > 1
            ? (brushEndPosition[0] - brushPosition[0]) / (instancesCount - 1)
            : 0;
        const deltaY =
          instancesCount > 1
            ? (brushEndPosition[1] - brushPosition[1]) / (instancesCount - 1)
            : 0;

        modifiedAndCreatedInstances.forEach((instance, i) => {
          instance.setX(brushPosition[0] + i * deltaX);
          instance.setY(brushPosition[1] + i * deltaY);
        });
      }
    } else if (brush_kind === 'grid') {
      const instancesCount = modifiedAndCreatedInstances.length;

      if (brushPosition && brushEndPosition) {
        const brushWidth = brushEndPosition[0] - brushPosition[0];
        const brushHeight = brushEndPosition[1] - brushPosition[1];

        // Auto-compute the column and row count from the aspect ratio of the
        // brush rectangle so a wide area gets more columns and a flat line
        // (zero width or height) gets a single row/column. A naive sqrt split
        // would stack instances on top of each other for a thin rectangle.
        const absWidth = Math.abs(brushWidth);
        const absHeight = Math.abs(brushHeight);
        let gridColumnCount: number;
        let gridRowCount: number;
        if (columnCount && rowCount) {
          gridColumnCount = columnCount;
          gridRowCount = rowCount;
        } else if (absHeight === 0) {
          gridColumnCount = columnCount || instancesCount;
          gridRowCount = rowCount || 1;
        } else if (absWidth === 0) {
          gridRowCount = rowCount || instancesCount;
          gridColumnCount = columnCount || 1;
        } else {
          gridColumnCount =
            columnCount ||
            Math.max(
              1,
              Math.round(Math.sqrt((instancesCount * absWidth) / absHeight))
            );
          gridRowCount =
            rowCount || Math.ceil(instancesCount / gridColumnCount);
        }

        // Spread columns along X and rows along Y. Divide by (count - 1) so
        // the last column/row reaches brush_end_position, like the line brush.
        const gridColumnSize =
          gridColumnCount > 1 ? brushWidth / (gridColumnCount - 1) : 0;
        const gridRowSize =
          gridRowCount > 1 ? brushHeight / (gridRowCount - 1) : 0;

        modifiedAndCreatedInstances.forEach((instance, i) => {
          const row = Math.floor(i / gridColumnCount);
          const column = i % gridColumnCount;

          instance.setX(brushPosition[0] + column * gridColumnSize);
          instance.setY(brushPosition[1] + row * gridRowSize);
        });
      }
    } else if (brush_kind === 'random_in_circle') {
      modifiedAndCreatedInstances.forEach(instance => {
        const randomRadius = Math.random() * brushSize;
        const randomAngle = Math.random() * 2 * Math.PI;

        instance.setX(brushPosition[0] + randomRadius * Math.cos(randomAngle));
        instance.setY(brushPosition[1] + randomRadius * Math.sin(randomAngle));
      });
    } else if (brush_kind === 'point') {
      modifiedAndCreatedInstances.forEach(instance => {
        instance.setX(brushPosition[0]);
        instance.setY(brushPosition[1]);
      });
    } else {
      if (brush_kind !== 'none') {
        console.warn(
          `Unknown brush kind: ${brush_kind} - assuming it's "none" instead.`
        );
        changes.push(
          'The brush kind is unknown and was considered to be "none" instead.'
        );
      }
      // The "none" brush keeps existing instances in place.
    }

    const instancesSize = SafeExtractor.parseCommaSeparatedTwoFiniteNumbers(
      instances_size
    );
    const instancesRotation = SafeExtractor.extractNumberProperty(
      args,
      'instances_rotation'
    );
    const instancesOpacity = SafeExtractor.extractNumberProperty(
      args,
      'instances_opacity'
    );
    const instancesHidden = SafeExtractor.extractBooleanProperty(
      args,
      'instances_hidden'
    );

    modifiedAndCreatedInstances.forEach(instance => {
      if (instancesSize) {
        instance.setHasCustomSize(true);
        instance.setCustomWidth(instancesSize[0]);
        instance.setCustomHeight(instancesSize[1]);
      }
      if (instances_z_order !== null) {
        instance.setZOrder(instances_z_order);
      }
      if (instancesRotation !== null) {
        instance.setAngle(instancesRotation);
      }
      if (instancesOpacity !== null) {
        instance.setOpacity(instancesOpacity);
      }
      if (instancesHidden !== null) {
        instance.setHidden(instancesHidden);
      }
    });

    // Track specific changes that were made
    if (newInstancesCount > 0) {
      const attrs = [];
      if (instancesSize)
        attrs.push(`size ${instancesSize[0]}x${instancesSize[1]}`);
      if (instancesRotation !== null)
        attrs.push(`rotation ${instancesRotation}°`);
      if (instancesOpacity !== null)
        attrs.push(`opacity ${instancesOpacity}/255`);
      if (instancesHidden !== null)
        attrs.push(instancesHidden ? 'hidden at start' : 'visible at start');
      if (instances_z_order !== null)
        attrs.push(`z-order ${instances_z_order}`);
      const effectiveSize = instancesSize
        ? instancesSize
        : objectSizeInfo &&
          objectSizeInfo.width !== null &&
          objectSizeInfo.height !== null
        ? [objectSizeInfo.width, objectSizeInfo.height]
        : null;
      if ((brush_kind === 'point' || brush_kind === 'none') && effectiveSize) {
        attrs.push(
          `origin at this position, each occupies ${getOccupiedSpaceDescription(
            brushPosition,
            effectiveSize,
            objectSizeInfo
          )}`
        );
      }
      const createdInstanceIds = modifiedAndCreatedInstances
        .filter(instance => !existingInstanceStates.has(instance))
        .map(instance => instance.getPersistentUuid().slice(0, 10));
      changes.push(
        `Created ${newInstancesCount} new instance${
          newInstancesCount > 1 ? 's' : ''
        } of object "${object_name || ''}" (id${
          createdInstanceIds.length > 1 ? 's' : ''
        }: ${createdInstanceIds.join(
          ', '
        )}) using ${brush_kind} brush at ${brushPosition.join(
          ', '
        )} on ${getLayerNameForMessage(layerName)}${
          attrs.length > 0 ? ` (${attrs.join(', ')})` : ''
        }.`
      );
    }

    // Check what changed for existing instances
    let movedToLayerCount = 0;
    let movedPositionCount = 0;
    let resizedCount = 0;
    let rotatedCount = 0;
    let opacityChangedCount = 0;
    let hiddenChangedCount = 0;
    let zOrderChangedCount = 0;

    existingInstanceStates.forEach((originalState, instance) => {
      if (originalState.originalLayer !== instance.getLayer()) {
        movedToLayerCount++;
      }
      if (
        originalState.originalX !== instance.getX() ||
        originalState.originalY !== instance.getY()
      ) {
        movedPositionCount++;
      }
      if (
        instancesSize &&
        (originalState.originalCustomWidth !== instance.getCustomWidth() ||
          originalState.originalCustomHeight !== instance.getCustomHeight())
      ) {
        resizedCount++;
      }
      if (
        instancesRotation !== null &&
        originalState.originalRotation !== instance.getAngle()
      ) {
        rotatedCount++;
      }
      if (
        instancesOpacity !== null &&
        originalState.originalOpacity !== instance.getOpacity()
      ) {
        opacityChangedCount++;
      }
      if (
        instancesHidden !== null &&
        originalState.originalHidden !== instance.isHidden()
      ) {
        hiddenChangedCount++;
      }
      if (
        instances_z_order !== null &&
        originalState.originalZOrder !== instance.getZOrder()
      ) {
        zOrderChangedCount++;
      }
    });

    // Name the modified object(s) in messages so a wrongly targeted call is
    // visible in the result.
    const modifiedObjectNames = new Set<string>();
    existingInstanceStates.forEach((originalState, instance) => {
      modifiedObjectNames.add(instance.getObjectName());
    });
    const ofObjectsSuffix =
      modifiedObjectNames.size > 0
        ? ` of ${Array.from(modifiedObjectNames)
            .map(name => `"${name}"`)
            .join(', ')}`
        : '';

    if (movedToLayerCount > 0) {
      changes.push(
        `Moved ${movedToLayerCount} instance${
          movedToLayerCount > 1 ? 's' : ''
        }${ofObjectsSuffix} to ${getLayerNameForMessage(layerName)}.`
      );
    }

    if (movedPositionCount > 0) {
      changes.push(
        `Repositioned ${movedPositionCount} instance${
          movedPositionCount > 1 ? 's' : ''
        }${ofObjectsSuffix} using ${brush_kind} brush.`
      );
    }

    if (resizedCount > 0 && instancesSize) {
      changes.push(
        `Resized ${resizedCount} instance${
          resizedCount > 1 ? 's' : ''
        }${ofObjectsSuffix} to ${instancesSize[0]}x${instancesSize[1]}.`
      );
    }

    if (rotatedCount > 0 && instancesRotation !== null) {
      changes.push(
        `Rotated ${rotatedCount} instance${
          rotatedCount > 1 ? 's' : ''
        }${ofObjectsSuffix} to ${instancesRotation}°.`
      );
    }

    if (opacityChangedCount > 0 && instancesOpacity !== null) {
      changes.push(
        `Changed opacity of ${opacityChangedCount} instance${
          opacityChangedCount > 1 ? 's' : ''
        }${ofObjectsSuffix} to ${instancesOpacity}/255.`
      );
    }

    if (hiddenChangedCount > 0 && instancesHidden !== null) {
      changes.push(
        instancesHidden
          ? `Marked ${hiddenChangedCount} instance${
              hiddenChangedCount > 1 ? 's' : ''
            }${ofObjectsSuffix} as hidden at start (they can be displayed with the "Show" action).`
          : `Marked ${hiddenChangedCount} instance${
              hiddenChangedCount > 1 ? 's' : ''
            }${ofObjectsSuffix} as visible at start.`
      );
    }

    if (zOrderChangedCount > 0 && instances_z_order !== null) {
      changes.push(
        `Changed Z-order of ${zOrderChangedCount} instance${
          zOrderChangedCount > 1 ? 's' : ''
        }${ofObjectsSuffix} to ${instances_z_order}.`
      );
    }

    if (notFoundExistingInstanceIds.size > 0) {
      // If NONE of the requested instances were found and nothing new was
      // created, the call did nothing. Return a failure so the agent gets a
      // real error signal instead of a misleading success — a success here
      // can make the agent retry the same (often malformed) call in a loop.
      if (existingInstanceStates.size === 0 && newInstancesCount === 0) {
        return makeGenericFailure(
          `None of the specified instance ids were found: ${Array.from(
            notFoundExistingInstanceIds
          ).join(
            ', '
          )}. Nothing was changed. Call \`describe_instances\` to get valid ids (the \`id\` field of each instance), and check the scene and layer names.`
        );
      }

      changes.push(
        `Instance ids not found: ${Array.from(notFoundExistingInstanceIds).join(
          ', '
        )}. Verify ids and layer names.`
      );
    }

    if (changes.length === 0) {
      const matchedCount = existingInstanceStates.size;
      const hasMutationParams =
        !!instancesSize ||
        instancesRotation !== null ||
        instancesOpacity !== null ||
        instancesHidden !== null ||
        instances_z_order !== null;
      const hasPositionBrush =
        brush_kind === 'point' ||
        brush_kind === 'line' ||
        brush_kind === 'grid' ||
        brush_kind === 'random_in_circle';

      if (existingInstanceIds.length === 0) {
        return makeGenericFailure(
          'No instance changes. To edit existing instances, pass `existing_instance_ids` (from `describe_instances`); to create, pass `object_name` and `new_instances_count`. See the tool parameters for how to move/resize/rotate.'
        );
      }

      if (!hasMutationParams && !hasPositionBrush) {
        const noRequestMessage = `Matched ${matchedCount} existing instance${
          matchedCount > 1 ? 's' : ''
        } but no change was requested — provide a value to modify, or use the "point" brush with \`brush_position\` to move.`;
        if (isNoOpConsideredSuccess(toolsVersion)) {
          return {
            success: true,
            message: noRequestMessage,
            nothingChanged: true,
          };
        }
        return makeGenericFailure(noRequestMessage);
      }

      const noOpMessage = `Matched ${matchedCount} existing instance${
        matchedCount > 1 ? 's' : ''
      } but the requested values are identical to their current ones, so nothing changed.${
        hasPositionBrush
          ? ''
          : ' To move instances, use the "point" brush with `brush_position` (the "none" brush never changes position).'
      }`;
      // A no-op (requested state == current state) is a SUCCESS from v12: a
      // script stops at the first failure, so re-running an idempotent call
      // must not kill it. Pre-v12 keeps the failure (useful tool-call
      // feedback; shipped behavior unchanged). See isNoOpConsideredSuccess.
      if (isNoOpConsideredSuccess(toolsVersion)) {
        return {
          success: true,
          message: noOpMessage,
          nothingChanged: true,
        };
      }
      return makeGenericFailure(noOpMessage);
    }

    // /!\ Tell the editor that some instances have potentially been modified (and even removed).
    // This will force the instances editor to destroy and mount again the
    // renderers to avoid keeping any references to existing instances, and also drop any selection.
    onInstancesModified();
    const put2dResult: EditorFunctionGenericOutput = {
      success: true,
      message: changes.join(' '),
    };
    if (object_name && objectSizeInfo)
      injectObjectSizeInfo(put2dResult, { [object_name]: objectSizeInfo });
    return put2dResult;
  }
};
