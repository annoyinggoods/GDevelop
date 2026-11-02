// @flow
import { mapFor } from '../../Utils/MapFor';
import { unserializeFromJSObject } from '../../Utils/Serializer';
import { buildEventScriptSourceView } from '../../EventsSheet/EventsTree/TextRenderer/EventScriptSourceView';
import {
  byokApplyEventBatchesToEventsList,
  type ByokEventBatch,
} from './ByokLocalEventWriter';
import { parseByokEventScript } from './ByokEventScriptParser';
import { validateByokEventScript } from './ByokLocalEventWriter';
import {
  describeInstancesInContainer,
  INSTANCE_POSITION_SEMANTICS_MESSAGE,
  putInstancesInContainer,
} from '../../EditorFunctions/InstanceTools';
import { BYOK_TOOLS_VERSION } from './ByokTypes';
import type {
  ByokExtraTool,
  ByokExtraToolCollaborators,
  ByokExtraToolResult,
} from './ByokExtraTools';

const gd: libGDevelop = global.gd;

/**
 * The external events & external layout tools (Phase 11, D11-1: dedicated
 * names rather than overloads of the scene tools). Everything reuses the
 * exact pipelines the scene tools run: EventScript rendering
 * (read_events_source's builder), the local event writer (add_scene_events)
 * and the container-generic instance cores extracted in step 11.1 — so an
 * external sheet behaves like a small scene the agent can read, populate
 * and then load from events it writes (the classic spawn-point mechanic).
 */

const EXTERNAL_EVENTS_MAX_CHARS = 30000;

const makeFailure = (message: string): ByokExtraToolResult => ({
  output: { success: false, message },
  didModifyProject: false,
});

const makeNoProjectFailure = (): ByokExtraToolResult =>
  makeFailure('No project is open — open or create one first.');

const listExternalEventsNames = (project: any): Array<string> =>
  mapFor(0, project.getExternalEventsCount(), index =>
    project.getExternalEventsAt(index).getName()
  );

const listExternalLayoutNames = (project: any): Array<string> =>
  mapFor(0, project.getExternalLayoutsCount(), index =>
    project.getExternalLayoutAt(index).getName()
  );

const makeItemsSuffix = (names: Array<string>, kind: string): string =>
  names.length > 0
    ? `Existing ${kind}: ${names.map(name => `"${name}"`).join(', ')}.`
    : `The project has no ${kind}.`;

const listObjectNames = (objectsContainer: any): Array<string> =>
  mapFor(0, objectsContainer.getObjectsCount(), index =>
    objectsContainer.getObjectAt(index).getName()
  );

/**
 * Refresh an already-open editor of the item (Main Frame fans the payload
 * out to every tab; the matching container redraws). No-op in hosts without
 * the fan-out channel — the changes are applied either way.
 */
const notifyExternalLayoutModified = (
  collaborators: ByokExtraToolCollaborators,
  externalLayoutName: string
): void => {
  if (!collaborators.onExternalLayoutModifiedOutsideEditor) return;
  collaborators.onExternalLayoutModifiedOutsideEditor({ externalLayoutName });
};

const notifyExternalEventsModified = (
  collaborators: ByokExtraToolCollaborators,
  externalEventsName: string,
  newOrChangedAiGeneratedEventIds: Set<string>
): void => {
  if (!collaborators.onExternalEventsModifiedOutsideEditor) return;
  collaborators.onExternalEventsModifiedOutsideEditor({
    externalEventsName,
    newOrChangedAiGeneratedEventIds,
  });
};

/**
 * External-layout tools borrow the layers and objects of the associated
 * scene (the editor does the same — ExternalLayoutEditorContainer). An
 * external layout without an associated scene cannot be described or
 * populated meaningfully: fail with the actionable reason.
 */
const getAssociatedLayoutOrFailure = (
  project: any,
  externalLayout: any
): {| layout: any | null, failure: ?ByokExtraToolResult |} => {
  const associatedSceneName = externalLayout.getAssociatedLayout();
  if (!associatedSceneName || !project.hasLayoutNamed(associatedSceneName)) {
    return {
      layout: null,
      failure: makeFailure(
        `The external layout has no associated scene (or it does not exist anymore). Pass associated_scene to put_external_layout_instances to set one, then retry.`
      ),
    };
  }
  return { layout: project.getLayout(associatedSceneName), failure: null };
};

/**
 * Size info needs the Pixi texture loader, which BYOK tool hosts do not
 * carry (it is a heavy, renderer-only module): without it, sprite default
 * sizes read as 0 — the same degradation as textures never loaded. Custom
 * sizes, positions, layers and ids are unaffected.
 */
const TEXTURELESS_PIXI_RESOURCES_LOADER = {
  getPIXITexture: (): null => null,
};

const getPixiResourcesLoader = (collaborators: any): any =>
  collaborators.getPixiResourcesLoader
    ? collaborators.getPixiResourcesLoader()
    : TEXTURELESS_PIXI_RESOURCES_LOADER;

const makeReadExternalEventsSourceTool = (): ByokExtraTool => ({
  name: 'read_external_events_source',
  modifiesProject: false,
  run: async (args, collaborators): Promise<ByokExtraToolResult> => {
    const project = collaborators.getProject();
    if (!project) return makeNoProjectFailure();
    const name =
      typeof args.external_events_name === 'string'
        ? args.external_events_name
        : '';
    if (!name) {
      return makeFailure('The "external_events_name" to read is required.');
    }
    if (!project.hasExternalEventsNamed(name)) {
      return makeFailure(
        `No external events named "${name}". ${makeItemsSuffix(
          listExternalEventsNames(project),
          'external events'
        )}`
      );
    }

    const externalEvents = project.getExternalEvents(name);
    const associatedSceneName = externalEvents.getAssociatedLayout();
    const view = buildEventScriptSourceView({
      eventsList: externalEvents.getEvents(),
      maxChars: EXTERNAL_EVENTS_MAX_CHARS,
    });

    const associatedObjects =
      associatedSceneName && project.hasLayoutNamed(associatedSceneName)
        ? listObjectNames(project.getLayout(associatedSceneName).getObjects())
        : [];

    return {
      output: {
        success: true,
        externalEventsNamed: name,
        associatedSceneName,
        eventScript: view.text,
        truncated: view.truncated,
        sceneObjectNames: associatedObjects,
        globalObjectNames: listObjectNames(project.getObjects()),
      },
      didModifyProject: false,
    };
  },
});

/**
 * Read the batches argument defensively (model-provided JSON: a wrong shape
 * degrades into a failure, never a crash) — same rule as ByokExtraTools.
 */
const readEventBatches = (args: Object): Array<ByokEventBatch> => {
  if (!Array.isArray(args.event_batches)) return [];
  return args.event_batches.map(batch =>
    batch && typeof batch === 'object' ? batch : {}
  );
};

/**
 * Whole-sheet replacement (the `event_script` form): parse → gd round-trip
 * → clear + insert (the writeFunctionEventsFromScript pattern) or append.
 * Returns null on success, the failure otherwise.
 */
const applyWholeSheetEventScript = (
  project: any,
  eventsList: any,
  eventScript: string,
  mode: string
): ByokExtraToolResult | null => {
  const parseResult = parseByokEventScript(eventScript);
  if (parseResult.error) {
    return makeFailure(
      `The EventScript is not valid (line ${
        parseResult.error.lineNumber
      }, column ${parseResult.error.columnNumber}): ${
        parseResult.error.message
      }`
    );
  }
  const parsedEventsList = new gd.EventsList();
  try {
    // Round-trip through a real EventsList: unserialize validates against
    // the project (a wrong shape throws, nothing is applied silently).
    unserializeFromJSObject(
      parsedEventsList,
      parseResult.events,
      'unserializeFrom',
      project
    );
    if (mode === 'replace') eventsList.clear();
    eventsList.insertEvents(parsedEventsList, 0, true);
    return null;
  } catch (error) {
    return makeFailure(
      `The events could not be applied: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  } finally {
    parsedEventsList.delete();
  }
};

const makeAddExternalEventsTool = (): ByokExtraTool => ({
  name: 'add_external_events',
  modifiesProject: true,
  run: async (args, collaborators): Promise<ByokExtraToolResult> => {
    const project = collaborators.getProject();
    if (!project) return makeNoProjectFailure();
    const name =
      typeof args.external_events_name === 'string'
        ? args.external_events_name
        : '';
    if (!name) {
      return makeFailure('The "external_events_name" to write is required.');
    }

    const associatedScene =
      typeof args.associated_scene === 'string' && args.associated_scene
        ? args.associated_scene
        : null;
    if (associatedScene && !project.hasLayoutNamed(associatedScene)) {
      return makeFailure(
        `Scene not found: "${associatedScene}". ${makeItemsSuffix(
          mapFor(0, project.getLayoutsCount(), index =>
            project.getLayoutAt(index).getName()
          ),
          'scenes'
        )}`
      );
    }

    const createIfMissing = args.create_if_missing === true;
    if (!project.hasExternalEventsNamed(name) && !createIfMissing) {
      return makeFailure(
        `No external events named "${name}" — pass create_if_missing: true to create it. ${makeItemsSuffix(
          listExternalEventsNames(project),
          'external events'
        )}`
      );
    }

    const eventBatches = readEventBatches(args);
    const eventScript =
      typeof args.event_script === 'string' ? args.event_script : '';
    if (eventBatches.length > 0 && eventScript) {
      return makeFailure(
        'Pass either event_batches or event_script, not both — the batches are anchored changes, the script rewrites the whole sheet.'
      );
    }
    // Everything that can fail is checked BEFORE the sheet is created or
    // associated: a failure after the insert left an empty sheet (and a new
    // scene association) behind while reporting didModifyProject:false,
    // which breaks the approval/dirty gating and makes the model's retry
    // find the sheet already created (audit011026 B-TOOL-3; the ordering
    // was still wrong after that fix — audit 2026-10-02 REG-2).
    // NOTE: a missing mode defaults to "replace" (destructive) — the
    // schema description says so explicitly (audit011026 B-TOOL-8).
    const mode = args.mode === 'insert' ? 'insert' : 'replace';
    if (eventScript) {
      const invalidScript = validateByokEventScript(project, eventScript);
      if (invalidScript) return makeFailure(invalidScript);
    }

    if (!project.hasExternalEventsNamed(name)) {
      project.insertNewExternalEvents(name, project.getExternalEventsCount());
    }

    const externalEvents = project.getExternalEvents(name);
    if (associatedScene) {
      externalEvents.setAssociatedLayout(associatedScene);
    }
    const newOrChangedAiGeneratedEventIds: Set<string> = new Set();
    if (eventBatches.length > 0) {
      const output = byokApplyEventBatchesToEventsList({
        project,
        eventsList: externalEvents.getEvents(),
        eventBatches,
        onApplied: aiGeneratedEventId => {
          newOrChangedAiGeneratedEventIds.add(aiGeneratedEventId);
        },
      });
      if (output.success === true) {
        notifyExternalEventsModified(
          collaborators,
          name,
          newOrChangedAiGeneratedEventIds
        );
      }
      return {
        output: {
          ...output,
          externalEventsNamed: name,
          associatedSceneName: externalEvents.getAssociatedLayout(),
        },
        didModifyProject: output.success === true,
      };
    }
    if (eventScript) {
      const failure = applyWholeSheetEventScript(
        project,
        externalEvents.getEvents(),
        eventScript,
        mode
      );
      if (failure) return failure;
      notifyExternalEventsModified(collaborators, name, new Set());
      return {
        output: {
          success: true,
          message: `Replaced the events of external events "${name}" (mode: ${mode}).`,
          externalEventsNamed: name,
          associatedSceneName: externalEvents.getAssociatedLayout(),
        },
        didModifyProject: true,
      };
    }
    return makeFailure(
      'Provide event_batches (anchored changes, like add_scene_events) or event_script (the whole sheet).'
    );
  },
});

const makeDescribeExternalLayoutTool = (): ByokExtraTool => ({
  name: 'describe_external_layout',
  modifiesProject: false,
  run: async (args, collaborators): Promise<ByokExtraToolResult> => {
    const project = collaborators.getProject();
    if (!project) return makeNoProjectFailure();
    const name =
      typeof args.external_layout_name === 'string'
        ? args.external_layout_name
        : '';
    if (!name) {
      return makeFailure('The "external_layout_name" to read is required.');
    }
    if (!project.hasExternalLayoutNamed(name)) {
      return makeFailure(
        `No external layout named "${name}". ${makeItemsSuffix(
          listExternalLayoutNames(project),
          'external layouts'
        )}`
      );
    }

    const externalLayout = project.getExternalLayout(name);
    const { layout, failure } = getAssociatedLayoutOrFailure(
      project,
      externalLayout
    );
    if (failure) return failure;
    if (!layout)
      return makeFailure('The external layout has no associated scene.');

    const { instances } = describeInstancesInContainer({
      initialInstances: externalLayout.getInitialInstances(),
      layersContainer: layout,
      objectsContainer: layout.getObjects(),
      globalObjects: project.getObjects(),
      project,
      PixiResourcesLoader: getPixiResourcesLoader(collaborators),
      objectNames: new Set(),
    });

    return {
      output: {
        success: true,
        instances,
        externalLayoutNamed: name,
        associatedSceneName: externalLayout.getAssociatedLayout(),
        positionSemantics: INSTANCE_POSITION_SEMANTICS_MESSAGE,
        note:
          'Sprite default sizes read as 0 here (custom sizes are exact). Instances of this layout are spawned with the "Create objects from external layout" action.',
      },
      didModifyProject: false,
    };
  },
});

const makePutExternalLayoutInstancesTool = (): ByokExtraTool => ({
  name: 'put_external_layout_instances',
  modifiesProject: true,
  run: async (args, collaborators): Promise<ByokExtraToolResult> => {
    const project = collaborators.getProject();
    if (!project) return makeNoProjectFailure();
    const name =
      typeof args.external_layout_name === 'string'
        ? args.external_layout_name
        : '';
    if (!name) {
      return makeFailure('The "external_layout_name" to populate is required.');
    }

    const createIfMissing = args.create_if_missing === true;
    if (!project.hasExternalLayoutNamed(name) && !createIfMissing) {
      return makeFailure(
        `No external layout named "${name}" — pass create_if_missing: true (with associated_scene) to create it. ${makeItemsSuffix(
          listExternalLayoutNames(project),
          'external layouts'
        )}`
      );
    }

    if (!project.hasExternalLayoutNamed(name)) {
      const associatedScene =
        typeof args.associated_scene === 'string' && args.associated_scene
          ? args.associated_scene
          : '';
      if (!associatedScene) {
        return makeFailure(
          'Creating an external layout requires associated_scene (the scene whose layers and objects it uses).'
        );
      }
      if (!project.hasLayoutNamed(associatedScene)) {
        return makeFailure(`Scene not found: "${associatedScene}".`);
      }
      const created = project.insertNewExternalLayout(
        name,
        project.getExternalLayoutsCount()
      );
      created.setAssociatedLayout(associatedScene);
    }

    const externalLayout = project.getExternalLayout(name);
    const associatedSceneArg =
      typeof args.associated_scene === 'string' && args.associated_scene
        ? args.associated_scene
        : null;
    if (associatedSceneArg) {
      if (!project.hasLayoutNamed(associatedSceneArg)) {
        return makeFailure(`Scene not found: "${associatedSceneArg}".`);
      }
      externalLayout.setAssociatedLayout(associatedSceneArg);
    }

    const { layout, failure } = getAssociatedLayoutOrFailure(
      project,
      externalLayout
    );
    if (failure) return failure;
    if (!layout)
      return makeFailure('The external layout has no associated scene.');

    const output = await putInstancesInContainer({
      args,
      project,
      // The BYOK agent is a script-style agent (it writes run_script
      // batches): an idempotent no-op is a success for it, like for the
      // hosted v15 tools — never pass null here (that would report an
      // already-satisfied put as a failure and kill the script).
      toolsVersion: BYOK_TOOLS_VERSION,
      initialInstances: externalLayout.getInitialInstances(),
      layersContainer: layout,
      objectsContainer: layout.getObjects(),
      globalObjects: project.getObjects(),
      containerLabel: `external layout "${name}"`,
      onInstancesModified: () => {},
      PixiResourcesLoader: getPixiResourcesLoader(collaborators),
    });
    const didChange = output.success === true && !output.nothingChanged;
    if (didChange) {
      notifyExternalLayoutModified(collaborators, name);
    }
    return {
      output: {
        ...output,
        externalLayoutNamed: name,
      },
      // A no-op success (nothingChanged) did not touch the project.
      didModifyProject: didChange,
    };
  },
});

/** The external events & layout tools (a fresh read, like ByokExtraTools). */
export const getByokExternalSceneTools = (): Array<ByokExtraTool> => [
  makeReadExternalEventsSourceTool(),
  makeAddExternalEventsTool(),
  makeDescribeExternalLayoutTool(),
  makePutExternalLayoutInstancesTool(),
];
