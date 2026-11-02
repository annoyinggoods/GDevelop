// @flow
import { unserializeFromJSObject } from './Serializer';

const gd: libGDevelop = global.gd;

// The module under test reads `global.gd` at import time, so the wrapper
// lifecycle is observed with a fake gd — loaded through a fresh module
// registry (the pattern of ByokKeyStorage.spec.js). The real gd is kept for
// the tests above and restored after each fake load.
const realGd: any = global.gd;

/**
 * `unserializeFromJSObject` dispatches between the single-argument
 * `unserializeFrom` (in-place, for projects) and the two-argument form
 * (for elements inside a project). The dispatcher is observed with a fake
 * serializable so the call arity is what gets asserted.
 */
const makeFakeSerializable = () => ({
  unserializeFrom: (jest.fn(): any),
});

describe('unserializeFromJSObject', () => {
  it('uses the single-argument form without a project', () => {
    const serializable = makeFakeSerializable();
    unserializeFromJSObject((serializable: any), { name: 'object' });
    expect(serializable.unserializeFrom).toHaveBeenCalledTimes(1);
    expect(serializable.unserializeFrom.mock.calls[0].length).toBe(1);
  });

  it('uses the two-argument form for an element inside a project', () => {
    const serializable = makeFakeSerializable();
    const project = gd.ProjectHelper.createNewGDJSProject();
    unserializeFromJSObject(
      (serializable: any),
      { name: 'layout' },
      'unserializeFrom',
      project
    );
    expect(serializable.unserializeFrom).toHaveBeenCalledTimes(1);
    expect(serializable.unserializeFrom.mock.calls[0].length).toBe(2);
    project.delete();
  });

  it('never passes the project as both the serializable and the context', () => {
    // The corruption case found during Phase 8 (see ByokFork): the 2-call
    // form with the SAME object in both the serializable and the context
    // slots crashes the WASM, so the guard must route it to the
    // single-argument, in-place form. Identity is what triggers the guard,
    // so one fake plays both roles.
    const serializable = makeFakeSerializable();
    unserializeFromJSObject(
      (serializable: any),
      { name: 'project' },
      'unserializeFrom',
      (serializable: any)
    );
    expect(serializable.unserializeFrom).toHaveBeenCalledTimes(1);
    expect(serializable.unserializeFrom.mock.calls[0].length).toBe(1);
  });
});

/**
 * A SerializerElement (or VectorString) fake recording its `delete()` calls,
 * so a leaked wrapper is observable.
 */
const makeCountingWrapper = () => {
  const wrapper: any = {
    deleteCount: 0,
    delete: () => {
      wrapper.deleteCount += 1;
    },
  };
  return wrapper;
};

/**
 * A serializable fake whose serialize/unserialize methods optionally throw,
 * simulating a C++ side failure while the wrapper is alive.
 */
const makeSerializableThatThrows = (error: ?Error) => ({
  serializeTo: (element: any) => {
    if (error) throw error;
  },
  unserializeFrom: (firstArgument: any, secondArgument: any) => {
    if (error) throw error;
  },
});

type FakeGdOptions = {|
  // What gd.Serializer.toJSON returns (an invalid string makes JSON.parse
  // throw inside the module under test).
  json: string,
  // Errors thrown by the respective gd entry points, when set.
  cleanDefaultFlagsError?: ?Error,
  objectAssetSerializeError?: ?Error,
  resourceUnserializeError?: ?Error,
|};

/**
 * A fake gd exposing only what the Serializer module touches, recording every
 * wrapper it creates so the tests can assert they were all deleted.
 */
const makeFakeGd = (options: FakeGdOptions) => {
  const state = {
    serializerElements: [],
    fromJSObjectElements: [],
    vectorStrings: [],
  };

  const gd: any = {
    SerializerElement: function() {
      const element = makeCountingWrapper();
      state.serializerElements.push(element);
      return element;
    },
    VectorString: function() {
      const vector = makeCountingWrapper();
      vector.toJSArray = () => ['some-resource.png'];
      state.vectorStrings.push(vector);
      return vector;
    },
    Serializer: {
      toJSON: () => options.json,
      fromJSObject: () => {
        const element = makeCountingWrapper();
        state.fromJSObjectElements.push(element);
        return element;
      },
    },
    BehaviorDefaultFlagClearer: {
      serializeObjectWithCleanDefaultBehaviorFlags: (
        object: any,
        element: any
      ) => {
        if (options.cleanDefaultFlagsError)
          throw options.cleanDefaultFlagsError;
      },
    },
    ObjectAssetSerializer: {
      serializeTo: (
        project: any,
        object: any,
        objectFullName: any,
        element: any,
        usedResourceNamesVector: any,
        extensionDependencyCache: any
      ) => {
        if (options.objectAssetSerializeError)
          throw options.objectAssetSerializeError;
      },
    },
    ResourcesContainer: {
      unserializeResourceFrom: (resource: any, element: any) => {
        if (options.resourceUnserializeError)
          throw options.resourceUnserializeError;
      },
    },
  };

  return { gd, state };
};

/**
 * Loads the Serializer module with the given fake gd on `global.gd`: the
 * module captures `global.gd` at import time, so each load needs a fresh
 * module registry. The real gd is restored right after the require.
 */
const loadSerializerModuleWithFakeGd = (fakeGd: any) => {
  global.gd = fakeGd;
  try {
    jest.resetModules();
    return require('./Serializer');
  } finally {
    global.gd = realGd;
  }
};

describe('Serializer wrapper lifecycle (fake gd)', () => {
  it('serializeToJSObject deletes the element on success', () => {
    const { gd, state } = makeFakeGd({ json: '{"ok":true}' });
    const { serializeToJSObject } = loadSerializerModuleWithFakeGd(gd);

    expect(serializeToJSObject(makeSerializableThatThrows(null))).toEqual({
      ok: true,
    });
    expect(state.serializerElements).toHaveLength(1);
    expect(state.serializerElements[0].deleteCount).toBe(1);
  });

  it('serializeToJSObject deletes the element when serializeTo throws', () => {
    const { gd, state } = makeFakeGd({ json: '{"ok":true}' });
    const { serializeToJSObject } = loadSerializerModuleWithFakeGd(gd);
    const serializable = makeSerializableThatThrows(
      new Error('serializeTo failed')
    );

    expect(() => serializeToJSObject(serializable)).toThrow(
      'serializeTo failed'
    );
    expect(state.serializerElements).toHaveLength(1);
    expect(state.serializerElements[0].deleteCount).toBe(1);
  });

  it('serializeToJSObject deletes the element when the JSON cannot be parsed', () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const { gd, state } = makeFakeGd({ json: 'not valid json {' });
    const { serializeToJSObject } = loadSerializerModuleWithFakeGd(gd);

    expect(() =>
      serializeToJSObject(makeSerializableThatThrows(null))
    ).toThrow();
    expect(consoleError).toHaveBeenCalled();
    expect(state.serializerElements).toHaveLength(1);
    expect(state.serializerElements[0].deleteCount).toBe(1);

    consoleError.mockRestore();
  });

  it('serializeObjectWithCleanDefaultBehaviorFlags deletes the element on success', () => {
    const { gd, state } = makeFakeGd({ json: '{"ok":true}' });
    const {
      serializeObjectWithCleanDefaultBehaviorFlags,
    } = loadSerializerModuleWithFakeGd(gd);

    expect(serializeObjectWithCleanDefaultBehaviorFlags(({}: any))).toEqual({
      ok: true,
    });
    expect(state.serializerElements).toHaveLength(1);
    expect(state.serializerElements[0].deleteCount).toBe(1);
  });

  it('serializeObjectWithCleanDefaultBehaviorFlags deletes the element when the flag cleaner throws', () => {
    const { gd, state } = makeFakeGd({
      json: '{"ok":true}',
      cleanDefaultFlagsError: new Error('flag cleaner failed'),
    });
    const {
      serializeObjectWithCleanDefaultBehaviorFlags,
    } = loadSerializerModuleWithFakeGd(gd);

    expect(() =>
      serializeObjectWithCleanDefaultBehaviorFlags(({}: any))
    ).toThrow('flag cleaner failed');
    expect(state.serializerElements).toHaveLength(1);
    expect(state.serializerElements[0].deleteCount).toBe(1);
  });

  it('serializeObjectWithCleanDefaultBehaviorFlags deletes the element when the JSON cannot be parsed', () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const { gd, state } = makeFakeGd({ json: 'not valid json {' });
    const {
      serializeObjectWithCleanDefaultBehaviorFlags,
    } = loadSerializerModuleWithFakeGd(gd);

    expect(() =>
      serializeObjectWithCleanDefaultBehaviorFlags(({}: any))
    ).toThrow();
    expect(consoleError).toHaveBeenCalled();
    expect(state.serializerElements).toHaveLength(1);
    expect(state.serializerElements[0].deleteCount).toBe(1);

    consoleError.mockRestore();
  });

  it('serializeToObjectAsset deletes the element and the resource names vector on success', () => {
    const { gd, state } = makeFakeGd({ json: '{"kind":"objectAsset"}' });
    const { serializeToObjectAsset } = loadSerializerModuleWithFakeGd(gd);
    const usedResourceNames: Array<string> = [];

    expect(
      serializeToObjectAsset(
        ({}: any),
        ({}: any),
        'My object',
        usedResourceNames,
        ({}: any)
      )
    ).toEqual({ kind: 'objectAsset' });
    expect(usedResourceNames).toEqual(['some-resource.png']);
    expect(state.serializerElements).toHaveLength(1);
    expect(state.serializerElements[0].deleteCount).toBe(1);
    expect(state.vectorStrings).toHaveLength(1);
    expect(state.vectorStrings[0].deleteCount).toBe(1);
  });

  it('serializeToObjectAsset deletes the element and the resource names vector when the serializer throws', () => {
    const { gd, state } = makeFakeGd({
      json: '{"kind":"objectAsset"}',
      objectAssetSerializeError: new Error('ObjectAssetSerializer failed'),
    });
    const { serializeToObjectAsset } = loadSerializerModuleWithFakeGd(gd);

    expect(() =>
      serializeToObjectAsset(({}: any), ({}: any), 'My object', [], ({}: any))
    ).toThrow('ObjectAssetSerializer failed');
    expect(state.serializerElements).toHaveLength(1);
    expect(state.serializerElements[0].deleteCount).toBe(1);
    expect(state.vectorStrings).toHaveLength(1);
    expect(state.vectorStrings[0].deleteCount).toBe(1);
  });

  it('serializeToJSON deletes the element on success', () => {
    const { gd, state } = makeFakeGd({ json: '{"ok":true}' });
    const { serializeToJSON } = loadSerializerModuleWithFakeGd(gd);

    expect(serializeToJSON(makeSerializableThatThrows(null))).toBe(
      '{"ok":true}'
    );
    expect(state.serializerElements).toHaveLength(1);
    expect(state.serializerElements[0].deleteCount).toBe(1);
  });

  it('serializeToJSON deletes the element when serializeTo throws', () => {
    const { gd, state } = makeFakeGd({ json: '{"ok":true}' });
    const { serializeToJSON } = loadSerializerModuleWithFakeGd(gd);
    const serializable = makeSerializableThatThrows(
      new Error('serializeTo failed')
    );

    expect(() => serializeToJSON(serializable)).toThrow('serializeTo failed');
    expect(state.serializerElements).toHaveLength(1);
    expect(state.serializerElements[0].deleteCount).toBe(1);
  });

  it('unserializeFromJSObject deletes the element on success', () => {
    const { gd, state } = makeFakeGd({ json: '{"ok":true}' });
    const {
      unserializeFromJSObject: unserialize,
    } = loadSerializerModuleWithFakeGd(gd);

    unserialize(makeSerializableThatThrows(null), { name: 'object' });
    expect(state.fromJSObjectElements).toHaveLength(1);
    expect(state.fromJSObjectElements[0].deleteCount).toBe(1);
  });

  it('unserializeFromJSObject deletes the element when unserializeFrom throws (two-argument form)', () => {
    const { gd, state } = makeFakeGd({ json: '{"ok":true}' });
    const {
      unserializeFromJSObject: unserialize,
    } = loadSerializerModuleWithFakeGd(gd);
    const serializable = makeSerializableThatThrows(
      new Error('unserializeFrom failed')
    );

    expect(() =>
      unserialize(
        serializable,
        { name: 'layout' },
        'unserializeFrom',
        ({
          name: 'project',
        }: any)
      )
    ).toThrow('unserializeFrom failed');
    expect(state.fromJSObjectElements).toHaveLength(1);
    expect(state.fromJSObjectElements[0].deleteCount).toBe(1);
  });

  it('unserializeResourceFromJSObject deletes the element on success', () => {
    const { gd, state } = makeFakeGd({ json: '{"ok":true}' });
    const {
      unserializeResourceFromJSObject: unserializeResource,
    } = loadSerializerModuleWithFakeGd(gd);

    unserializeResource(({}: any), { name: 'resource' });
    expect(state.fromJSObjectElements).toHaveLength(1);
    expect(state.fromJSObjectElements[0].deleteCount).toBe(1);
  });

  it('unserializeResourceFromJSObject deletes the element when the unserializer throws', () => {
    const { gd, state } = makeFakeGd({
      json: '{"ok":true}',
      resourceUnserializeError: new Error('unserializeResourceFrom failed'),
    });
    const {
      unserializeResourceFromJSObject: unserializeResource,
    } = loadSerializerModuleWithFakeGd(gd);

    expect(() => unserializeResource(({}: any), { name: 'resource' })).toThrow(
      'unserializeResourceFrom failed'
    );
    expect(state.fromJSObjectElements).toHaveLength(1);
    expect(state.fromJSObjectElements[0].deleteCount).toBe(1);
  });
});

/**
 * [P16-serializer-trap-guard] — keep the `gd.Serializer.toJSON(<project>)`
 * WASM-heap trap CLOSED. The one-argument form is only safe on a freshly
 * created `SerializerElement` (see `serializeToJSON` above for the correct
 * pattern); called on a project or any other serializable it corrupts the
 * libGD heap AND poisons the module for the rest of the Jest file, so the
 * failure cascades into unrelated tests with a misleading error (hit while
 * writing Phase 16; no production code does it today — this guard keeps it
 * that way).
 *
 * The rule enforced: every `Serializer.toJSON(` call in production source
 * must pass a SECOND argument (the two-argument form) or, when it has a
 * single argument, be on the documented allowlist below (e.g. a call on a
 * variable literally named like a SerializerElement).
 */
// $FlowFixMe[cannot-resolve-module] - a Node builtin, used by this spec only.
const guardFs = require('fs');
// $FlowFixMe[cannot-resolve-module] - a Node builtin, used by this spec only.
const guardPathModule = require('path');

/**
 * One-argument calls whose argument is VERIFIED to be a SerializerElement
 * created for the call (the safe form), keyed as `<file>|<call text>`.
 */
const SINGLE_ARGUMENT_ALLOWLIST: Set<string> = new Set([
  // serializeToJSON and friends: `serializedElement` is a fresh
  // `new gd.SerializerElement()` deleted in the same function.
  'Utils/Serializer.js|Serializer.toJSON(serializedElement)',
  // The background saver: `element` is the SerializerElement returned by
  // `deserializeBinarySnapshot` and deleted right after the call.
  'Utils/BackgroundSerializer.worker.js|Serializer.toJSON(element)',
  // The game-code hot reload's exporter-element helper: `element` is a
  // fresh `new gd.SerializerElement()` deleted in the finally block.
  'AiGeneration/Byok/GameCode/ByokGameCodeHotReload.js|Serializer.toJSON(element)',
  // The preview launchers (local + service-worker): both elements are fresh
  // `new gd.SerializerElement()` deleted right after the call.
  'ExportAndShare/LocalExporters/LocalPreviewLauncher/index.js|Serializer.toJSON(projectDataElement)',
  'ExportAndShare/LocalExporters/LocalPreviewLauncher/index.js|Serializer.toJSON(runtimeGameOptionsElement)',
  'ExportAndShare/BrowserExporters/BrowserSWPreviewLauncher/index.js|Serializer.toJSON(projectDataElement)',
  'ExportAndShare/BrowserExporters/BrowserSWPreviewLauncher/index.js|Serializer.toJSON(runtimeGameOptionsElement)',
  // A COMMENT documenting the historical trap (the audit's O1 finding), not
  // a call — the scanner reads text, not syntax.
  'AiGeneration/Byok/ByokSettingsTab.js|Serializer.toJSON(scene.getEvents())',
]);

const SERIALIZER_TO_JSON_PATTERN = /Serializer\s*\.\s*toJSON\s*\(/g;

/**
 * Split a call's argument list on TOP-LEVEL commas only, so nested calls
 * (`toJSON(makeElement(a, b))`) are not split mid-argument.
 */
const countTopLevelArguments = (argumentList: string): number => {
  let depth = 0;
  let count = 1;
  for (let index = 0; index < argumentList.length; index++) {
    const character = argumentList[index];
    if (character === '(' || character === '[' || character === '{') {
      depth += 1;
      continue;
    }
    if (character === ')' || character === ']' || character === '}') {
      depth -= 1;
      continue;
    }
    if (character === ',' && depth === 0) count += 1;
  }
  return count;
};

const findOneArgumentToJSONCalls = (content: string): Array<string> => {
  const findings: Array<string> = [];
  let match = SERIALIZER_TO_JSON_PATTERN.exec(content);
  while (match) {
    const afterParenthesis = content.slice(match.index + match[0].length);
    let depth = 1;
    let end = 0;
    while (end < afterParenthesis.length && depth > 0) {
      const character = afterParenthesis[end];
      if (character === '(') depth += 1;
      if (character === ')') depth -= 1;
      end += 1;
    }
    const argumentList = afterParenthesis.slice(0, Math.max(end - 1, 0));
    if (countTopLevelArguments(argumentList) === 1) {
      findings.push(`Serializer.toJSON(${argumentList})`);
    }
    match = SERIALIZER_TO_JSON_PATTERN.exec(content);
  }
  return findings;
};

const listSourceFiles = (directory: string): Array<string> => {
  const files: Array<string> = [];
  for (const entry of guardFs.readdirSync(directory)) {
    if (entry === 'locales' || entry === '__snapshots__') continue;
    const absolute = guardPathModule.join(directory, entry);
    const stat = guardFs.statSync(absolute);
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(absolute));
      continue;
    }
    if (entry.endsWith('.js') && !entry.endsWith('.spec.js')) {
      files.push(absolute);
    }
  }
  return files;
};

describe('the one-argument Serializer.toJSON guard', () => {
  it('has no production call that is not the two-argument safe form', () => {
    // Root the walk at src/ so the allowlist keys read like import paths.
    // $FlowFixMe[cannot-resolve-name] - used by this spec only.
    const srcRoot = guardPathModule.join(__dirname, '..');
    const offenders: Set<string> = new Set();
    for (const file of listSourceFiles(srcRoot)) {
      const relative = guardPathModule
        .relative(srcRoot, file)
        .replace(/\\/g, '/');
      const content = guardFs.readFileSync(file, 'utf8');
      for (const finding of findOneArgumentToJSONCalls(content)) {
        if (SINGLE_ARGUMENT_ALLOWLIST.has(`${relative}|${finding}`)) continue;
        offenders.add(`${relative}: ${finding}`);
      }
    }
    expect(Array.from(offenders).sort()).toEqual([]);
  });

  it('would catch the trap (the guard is not vacuous)', () => {
    expect(
      findOneArgumentToJSONCalls('gd.Serializer.toJSON(project);')
    ).toEqual(['Serializer.toJSON(project)']);
    expect(
      findOneArgumentToJSONCalls('gd.Serializer.toJSON(element, project);')
    ).toEqual([]);
    expect(
      findOneArgumentToJSONCalls(
        'gd.Serializer.toJSON(makeElement(a, b), project);'
      )
    ).toEqual([]);
  });
});
