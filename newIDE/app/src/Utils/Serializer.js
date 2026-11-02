// @flow
const gd: libGDevelop = global.gd;

/**
 * Options that affect how a project (or any serializable) is converted to JSON.
 */
export type SerializationOptions = {|
  /**
   * When true, the C++ serializer writes default values for properties that
   * would normally be omitted (e.g. `disabled: false`, `folded: false`,
   * empty `events`/`variables` arrays, etc.) and writes JSON object keys in
   * alphabetical order. This makes git diffs minimal and shift-free when
   * toggling flags or adding/removing sub-events.
   */
  canonicalEventSerialization?: boolean,
|};

/**
 * Helper to run a serialization callback with the canonical mode flag
 * temporarily enabled in the gd.Serializer. Always resets the flag,
 * even if `callback` throws.
 *
 * The flag is global to the gd.Serializer (and to the C++ side), so we must
 * be careful to reset it: leaving it on would silently change the format of
 * every subsequent serialization (including ones that don't expect it).
 */
function withSerializationOptions<T>(
  options: ?SerializationOptions,
  callback: () => T
): T {
  const useCanonical = !!(options && options.canonicalEventSerialization);
  if (!useCanonical) {
    return callback();
  }

  const previous = gd.Serializer.isCanonicalMode();
  gd.Serializer.setCanonicalMode(true);
  try {
    return callback();
  } finally {
    gd.Serializer.setCanonicalMode(previous);
  }
}

/**
 * Tool function to save a serializable object to a JS object.
 * Most gd.* objects are "serializable", meaning they have a serializeTo
 * and unserializeFrom method.
 *
 * @param {*} serializable
 * @param {*} methodName The name of the serialization method. "serializeTo" by default
 * @param {*} options Optional serialization options (e.g. canonical mode)
 */
/**
 * Parse the JSON string produced by gd.Serializer.toJSON, logging a precise
 * error before rethrowing (toJSON should always return valid JSON). Used by
 * the serializations owning a SerializerElement wrapper in a try/finally,
 * so a parse failure cannot leak the wrapper.
 */
const parseSerializedJSON = (json: string): any => {
  try {
    return JSON.parse(json);
  } catch (error) {
    console.error(
      'Invalid JSON when serializing to JS object. toJSON should always return a valid JSON string.',
      { json, error }
    );
    throw error;
  }
};

export function serializeToJSObject(
  serializable: gdSerializable,
  methodName: string = 'serializeTo',
  options: ?SerializationOptions = undefined
): any {
  return withSerializationOptions(options, () => {
    const serializedElement = new gd.SerializerElement();
    try {
      serializable[methodName](serializedElement);

      // JSON.parse + toJSON is 30% faster than gd.Serializer.toJSObject.
      const json = gd.Serializer.toJSON(serializedElement);

      return parseSerializedJSON(json);
    } finally {
      serializedElement.delete();
    }
  });
}

export function serializeObjectWithCleanDefaultBehaviorFlags(
  object: gdObject
): any {
  const serializedElement = new gd.SerializerElement();
  try {
    gd.BehaviorDefaultFlagClearer.serializeObjectWithCleanDefaultBehaviorFlags(
      object,
      serializedElement
    );

    // JSON.parse + toJSON is 30% faster than gd.Serializer.toJSObject.
    const json = gd.Serializer.toJSON(serializedElement);

    return parseSerializedJSON(json);
  } finally {
    serializedElement.delete();
  }
}

export function serializeToObjectAsset(
  project: gdProject,
  object: gdObject,
  objectFullName: string,
  usedResourceNames: Array<string>,
  extensionDependencyCache: gdExtensionDependencyCache
): any {
  const usedResourceNamesVector = new gd.VectorString();
  const serializedElement = new gd.SerializerElement();
  try {
    gd.ObjectAssetSerializer.serializeTo(
      project,
      object,
      objectFullName,
      serializedElement,
      usedResourceNamesVector,
      extensionDependencyCache
    );
    usedResourceNames.push(...usedResourceNamesVector.toJSArray());

    // JSON.parse + toJSON is 30% faster than gd.Serializer.toJSObject.
    const objectAsset = JSON.parse(gd.Serializer.toJSON(serializedElement));

    return objectAsset;
  } finally {
    serializedElement.delete();
    usedResourceNamesVector.delete();
  }
}

/**
 * Tool function to save a serializable object to a JSON.
 * Most gd.* objects are "serializable", meaning they have a serializeTo
 * and unserializeFrom method.
 *
 * @param {*} serializable
 * @param {*} methodName The name of the serialization method. "unserializeFrom" by default
 * @param {*} options Optional serialization options (e.g. canonical mode)
 */
export function serializeToJSON(
  serializable: gdSerializable,
  methodName: string = 'serializeTo',
  options: ?SerializationOptions = undefined
): string {
  return withSerializationOptions(options, () => {
    const serializedElement = new gd.SerializerElement();
    try {
      serializable[methodName](serializedElement);

      // toJSON is 20% faster than gd.Serializer.toJSObject + JSON.stringify.
      const json = gd.Serializer.toJSON(serializedElement);

      return json;
    } finally {
      serializedElement.delete();
    }
  });
}

/**
 * POSIX / editor convention: text files end with a newline. Use when persisting `.json`.
 */
export function addFinalNewline(json: string): string {
  return json.endsWith('\n') ? json : json + '\n';
}

/**
 * Tool function to restore a serializable object from a JS object.
 * Most gd.* objects are "serializable", meaning they have a serializeTo
 * and unserializeFrom method.
 * @param {*} serializable A gd.* object to restore
 * @param {*} object The JS object to be used to restore the serializable.
 * @param {*} methodName The name of the unserialization method. "unserializeFrom" by default
 * @param {*} optionalProject The project to pass as argument for unserialization
 */
export function unserializeFromJSObject(
  serializable: gdSerializable,
  object: Object,
  methodName: string = 'unserializeFrom',
  optionalProject: ?gdProject = undefined
) {
  const serializedElement = gd.Serializer.fromJSObject(object);
  try {
    if (!optionalProject || optionalProject === serializable) {
      // The two-argument form is for elements *inside* a project (a layout,
      // an object…). Passing the project as both the serializable and the
      // "context" argument corrupts the WASM memory (out-of-bounds access):
      // a project is unserialized in place, with the single-argument form
      // (see MainFrame's loadFromSerializedProject).
      serializable[methodName](serializedElement);
    } else {
      // It's not uncommon for unserializeFrom methods of gd.* classes
      // to require the project to be passed as first argument.
      serializable[methodName](optionalProject, serializedElement);
    }
  } finally {
    serializedElement.delete();
  }
}

export function unserializeResourceFromJSObject(
  resource: gdResource,
  object: Object
) {
  const serializedElement = gd.Serializer.fromJSObject(object);
  try {
    gd.ResourcesContainer.unserializeResourceFrom(resource, serializedElement);
  } finally {
    serializedElement.delete();
  }
}
