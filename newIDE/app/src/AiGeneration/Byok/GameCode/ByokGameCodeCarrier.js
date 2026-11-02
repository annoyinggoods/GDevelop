// @flow

/**
 * Phase 15.2 — the carrier extension that makes the game-code files ship.
 *
 * GDevelop already merges "extra source files" into the exported
 * `index.html`, in order, with one `<script src>` each:
 * `ExportIndexFile` reads every `SourceFileMetadata` of every USED
 * extension and appends the resource's file to the include list
 * (`GDJS/GDJS/IDE/ExporterHelper.cpp:739-784`), and `CompleteIndexFile`
 * emits the tags (`:1132-1165`). This module therefore writes NO bundler:
 * it registers each game-code file as a `javascript` project resource and
 * declares it on a dedicated extension via the same `addSourceFile()` API
 * the extension options dialog already uses
 * (`ExtensionDependenciesEditor.js:299-302`).
 *
 * ## Why the extension is made structurally used (D15-4)
 *
 * `UsedExtensionsFinder::ScanProject` only harvests the source files of an
 * extension it actually reaches (`UsedExtensionsFinder.cpp:18-33`), and it
 * reaches an extension only through an object, a behavior, an instruction
 * or a free-function call in the project. A carrier with only source files
 * would be invisible, and its files would never be exported.
 *
 * So the carrier declares ONE free action plus ONE free function whose
 * body calls it. `ProjectBrowserHelper::ExposeProjectEvents` scans every
 * extension's own events (`:141-154`), so the call is found, the carrier is
 * marked used, and its source files are harvested — with no event added to
 * any of the user's scenes and no object placed anywhere. The marker is
 * free-function code generation: a no-op call, a few bytes in the export.
 */

import { createNewResource } from '../../../ResourcesList/ResourceSource';
import { applyResourceDefaults } from '../../../ResourcesList/ResourceUtils';
import { unserializeFromJSObject } from '../../../Utils/Serializer';
import {
  BYOK_GAME_CODE_CARRIER_EXTENSION_NAME,
  computeByokGameCodeExportedScriptNames,
  getByokGameCodeProjectRelativeFilePath,
  getByokGameCodeResourceName,
  orderByokGameCodeRelativePaths,
} from './ByokGameCodeCore';

const gd: libGDevelop = global.gd;

/**
 * The action (and the free function that calls it) whose only job is to
 * make the carrier extension reachable from the project. Deliberately
 * private-free and argument-less: the events sheet shows it as an
 * ordinary action the game never needs to use.
 */
export const BYOK_GAME_CODE_MARKER_ACTION_NAME = 'markGameCodeAsUsed';
export const BYOK_GAME_CODE_MARKER_FUNCTION_NAME = 'loadGameCodeFiles';

const MARKER_ACTION_SENTENCE = 'Load the JavaScript game code files';
const MARKER_ACTION_DESCRIPTION =
  'This action does nothing. It exists so the GameCode extension is used by the project, ' +
  'which is what makes GDevelop ship the JavaScript files in the game code folder.';

export type ByokGameCodeCarrierResult = {|
  didModifyProject: boolean,
  createdExtension: boolean,
  addedResourceNames: Array<string>,
  removedResourceNames: Array<string>,
  /** The D15-3a load order, as it is now declared on the extension. */
  orderedRelativePaths: Array<string>,
  /** `relativePath` -> the `<script src>` it gets in the export, or null. */
  exportedScriptNames: { [string]: string | null },
  errors: Array<string>,
|};

/**
 * The events list of the marker function: one standard event with no
 * condition, whose single action is the carrier's own action.
 *
 * The shape is libGD's own serialization of an events list: the array's
 * elements are named `event` (`EventsListSerialization::ConsiderAsArrayOf
 * ("event")`, `Core/GDCore/Events/Serialization.cpp:206-249`), each event
 * carrying a `type`, and `StandardEvent::SerializeTo` at
 * `Builtin/StandardEvent.cpp:66-79` writing `conditions`/`actions` as
 * `instruction` arrays. It is built here rather than parsed out of
 * EventScript because the marker is a fixed, structural object rather than
 * authored code, and writing it out keeps the shape visible next to the
 * reason it exists.
 */
export const makeByokGameCodeMarkerEventsListObject = (
  markerActionFullName: string
): Object => ({
  event: [
    {
      type: 'BuiltinCommonInstructions::Standard',
      conditions: { instruction: [] },
      actions: {
        instruction: [
          {
            type: { value: markerActionFullName },
            parameters: { parameter: [] },
          },
        ],
      },
    },
  ],
});

/**
 * The full action name the engine resolves.
 *
 * It is `<extension>::<action>` with TWO colons — the code generator builds
 * the instruction type itself from the two names
 * (`MetadataDeclarationHelper::DeclareActionMetadata` →
 * `PlatformExtension::GetActionFullType`), and a one-colon spelling is
 * simply an unknown instruction, which would leave the carrier unused
 * without any error. The carrier spec pins the real declared name by
 * reading it back off JsPlatform.
 */
export const getByokGameCodeMarkerActionFullName = (): string =>
  BYOK_GAME_CODE_CARRIER_EXTENSION_NAME +
  '::' +
  BYOK_GAME_CODE_MARKER_ACTION_NAME;

/** Every resource name of a project, through the documented container API. */
const listResourceNames = (resourcesManager: any): Array<string> =>
  resourcesManager
    .getAllResourceNames()
    .toJSArray()
    .map(String);

const findEventsFunctionByName = (extension: any, name: string): any | null => {
  const functions = extension.getEventsFunctions();
  return functions.hasEventsFunctionNamed(name)
    ? functions.getEventsFunction(name)
    : null;
};

/**
 * Make sure the carrier extension exists, declaring the marker action and
 * the free function that calls it. Returns whether the extension was
 * created.
 */
const ensureCarrierExtension = (project: any): boolean => {
  const hadExtension = project.hasEventsFunctionsExtensionNamed(
    BYOK_GAME_CODE_CARRIER_EXTENSION_NAME
  );
  const extension = hadExtension
    ? project.getEventsFunctionsExtension(BYOK_GAME_CODE_CARRIER_EXTENSION_NAME)
    : project.insertNewEventsFunctionsExtension(
        BYOK_GAME_CODE_CARRIER_EXTENSION_NAME,
        project.getEventsFunctionsExtensionsCount()
      );

  let didModifyProject = false;
  if (!hadExtension) {
    extension.setName(BYOK_GAME_CODE_CARRIER_EXTENSION_NAME);
    extension.setFullName(BYOK_GAME_CODE_CARRIER_EXTENSION_NAME);
    extension.setShortDescription('Carries the JavaScript game code files.');
    extension.setDescription(
      'Created by the AI assistant to ship the JavaScript files of the game code folder. Do not delete it: the game code files stop being exported without it.'
    );
    extension.setCategory('Game code');
    extension.setVersion('1.0.0');
    // A project extension is authored here: no store origin.
    extension.setOrigin('', '');
    didModifyProject = true;
  }

  const markerActionFullName = getByokGameCodeMarkerActionFullName();
  let markerAction = findEventsFunctionByName(
    extension,
    BYOK_GAME_CODE_MARKER_ACTION_NAME
  );
  if (!markerAction) {
    markerAction = extension
      .getEventsFunctions()
      .insertNewEventsFunction(
        BYOK_GAME_CODE_MARKER_ACTION_NAME,
        extension.getEventsFunctions().getEventsFunctionsCount()
      );
    markerAction.setName(BYOK_GAME_CODE_MARKER_ACTION_NAME);
    markerAction.setFullName(markerActionFullName);
    markerAction.setSentence(MARKER_ACTION_SENTENCE);
    markerAction.setDescription(MARKER_ACTION_DESCRIPTION);
    markerAction.setFunctionType('Action');
    didModifyProject = true;
  }

  // The free function is what makes the extension reachable: its body is
  // scanned by UsedExtensionsFinder, so the carrier's source files are
  // harvested even though no scene event references the extension.
  const eventsList = new gd.EventsList();
  try {
    unserializeFromJSObject(
      eventsList,
      makeByokGameCodeMarkerEventsListObject(markerActionFullName),
      'unserializeFrom',
      project
    );
    let markerFunction = findEventsFunctionByName(
      extension,
      BYOK_GAME_CODE_MARKER_FUNCTION_NAME
    );
    if (!markerFunction) {
      markerFunction = extension
        .getEventsFunctions()
        .insertNewEventsFunction(
          BYOK_GAME_CODE_MARKER_FUNCTION_NAME,
          extension.getEventsFunctions().getEventsFunctionsCount()
        );
      markerFunction.setName(BYOK_GAME_CODE_MARKER_FUNCTION_NAME);
      markerFunction.setFunctionType('Action');
      markerFunction.setDescription(
        'Internal: makes the GameCode extension used by the project so its JavaScript files are exported. Calling it is not needed.'
      );
      didModifyProject = true;
    }
    // Rewriting the body is idempotent and repairs a function a user emptied.
    markerFunction.getEvents().clear();
    markerFunction
      .getEvents()
      .insertEvents(eventsList, 0, eventsList.getEventsCount(), 0);
  } finally {
    eventsList.delete();
  }

  return didModifyProject;
};

/**
 * The file names every OTHER project resource will take in the export.
 *
 * The exporter copies every resource flat into the export folder and
 * renames on collision, so a foreign resource named `spawn.js` is what
 * makes our own `spawn.js` name unknowable (see
 * `computeByokGameCodeExportedScriptNames`).
 */
export const listByokGameCodeForeignResourceFileNames = (
  project: any,
  gameCodeResourceNames: Array<string>
): Array<string> => {
  const resourcesManager = project.getResourcesManager();
  const gameCodeNames = new Set(gameCodeResourceNames);
  const foreignNames = [];
  for (const name of listResourceNames(resourcesManager)) {
    if (gameCodeNames.has(name)) continue;
    const file = resourcesManager.getResource(name).getFile();
    if (typeof file !== 'string' || !file) continue;
    const lastSeparator = Math.max(
      file.lastIndexOf('/'),
      file.lastIndexOf('\\')
    );
    foreignNames.push(
      lastSeparator === -1 ? file : file.slice(lastSeparator + 1)
    );
  }
  return foreignNames;
};

/**
 * Register (or retarget) the `javascript` resource of one game-code file,
 * and drop the resources of the files that are gone.
 *
 * The resource is registered under a name derived from its path
 * (`MyGameCode/character/spawn.js`) so the carrier's source-file
 * declarations are readable in the extension options dialog, and so a
 * delete can find the exact resource to remove.
 */
const reconcileResources = (
  project: any,
  gameCodeFolderName: string,
  orderedRelativePaths: Array<string>
): {|
  didModifyProject: boolean,
  added: Array<string>,
  removed: Array<string>,
|} => {
  const resourcesManager = project.getResourcesManager();
  const wantedResourceNames = orderedRelativePaths.map(relativePath =>
    getByokGameCodeResourceName(relativePath, gameCodeFolderName)
  );
  let didModifyProject = false;
  const added = [];
  const removed = [];

  for (const relativePath of orderedRelativePaths) {
    const resourceName = getByokGameCodeResourceName(
      relativePath,
      gameCodeFolderName
    );
    const projectRelativeFile = getByokGameCodeProjectRelativeFilePath(
      relativePath,
      gameCodeFolderName
    );
    if (resourcesManager.hasResource(resourceName)) {
      const existing = resourcesManager.getResource(resourceName);
      const existingKind =
        typeof existing.getKind === 'function' ? existing.getKind() : '';
      if (existingKind && existingKind !== 'javascript') {
        // Silently retargeting an image resource at a .js file would break
        // every object that references it, so this is refused loudly by
        // returning the unchanged registry.
        continue;
      }
      if (existing.getFile() !== projectRelativeFile) {
        existing.setFile(projectRelativeFile);
        didModifyProject = true;
      }
      continue;
    }
    const resource = createNewResource('javascript');
    if (!resource) continue;
    resource.setName(resourceName);
    resource.setFile(projectRelativeFile);
    resource.setOrigin('byok-game-code', relativePath);
    applyResourceDefaults(project, resource);
    resourcesManager.addResource(resource);
    // addResource stored a copy: free the wrapper (the ResourceSelector's
    // rule — an un-deleted wrapper leaks WASM memory).
    resource.delete();
    added.push(resourceName);
    didModifyProject = true;
  }

  // Drop the resources of the files that no longer exist. Scoped to the
  // game-code folder by NAME, so a user's own resource is never removed.
  for (const name of listResourceNames(resourcesManager)) {
    const belongsToGameCode =
      name.startsWith(gameCodeFolderName + '/') && name.endsWith('.js');
    if (!belongsToGameCode) continue;
    if (wantedResourceNames.includes(name)) continue;
    resourcesManager.removeResource(name);
    removed.push(name);
    didModifyProject = true;
  }

  return { didModifyProject, added, removed };
};

/**
 * Rebuild the extension's source-file declarations from scratch, in D15-3a
 * order. Rebuilding (rather than reconciling in place) is what guarantees
 * the order is EXACTLY the taxonomy: `ExportIndexFile` appends the source
 * files in declaration order (`InsertUnique` for `includePosition:
 * "last"`), so the declaration order IS the load order.
 */
const declareSourceFilesInOrder = (
  project: any,
  orderedRelativePaths: Array<string>,
  gameCodeFolderName: string
): boolean => {
  const extension = project.getEventsFunctionsExtension(
    BYOK_GAME_CODE_CARRIER_EXTENSION_NAME
  );
  const previousSourceFiles = extension.getAllSourceFiles();
  const previousResourceNames = [];
  for (let index = 0; index < previousSourceFiles.size(); index++) {
    previousResourceNames.push(previousSourceFiles.at(index).getResourceName());
  }

  const wantedResourceNames = orderedRelativePaths.map(relativePath =>
    getByokGameCodeResourceName(relativePath, gameCodeFolderName)
  );
  const isAlreadyInOrder =
    previousResourceNames.length === wantedResourceNames.length &&
    previousResourceNames.every(
      (name, index) => name === wantedResourceNames[index]
    );
  if (isAlreadyInOrder) return false;

  for (let index = previousSourceFiles.size() - 1; index >= 0; index--) {
    extension.removeSourceFileAt(index);
  }
  for (const relativePath of orderedRelativePaths) {
    const sourceFile = extension.addSourceFile();
    sourceFile.setResourceName(
      getByokGameCodeResourceName(relativePath, gameCodeFolderName)
    );
    // "last": the game code runs after the engine, which is what D15-12
    // assumes (it assigns into the `gdjs` global the engine defines).
    sourceFile.setIncludePosition('last');
  }
  return true;
};

/**
 * Bring the project's game-code registry in line with what is on disk.
 *
 * `orderedRelativePaths` is the listing the store produced, already in
 * D15-3a order; this function registers the resources, declares the source
 * files in that same order, and reports what it changed. It is the only
 * writer of the project-model side of the game code — the pane, the tools
 * and the auto-reload all go through it.
 */
export const ensureByokGameCodeCarrier = (options: {|
  project: any,
  gameCodeFolderName: string,
  relativePaths: Array<string>,
|}): ByokGameCodeCarrierResult => {
  const { project, gameCodeFolderName } = options;
  const orderedRelativePaths = orderByokGameCodeRelativePaths(
    options.relativePaths.filter(
      relativePath => typeof relativePath === 'string' && relativePath
    )
  );

  const errors: Array<string> = [];
  const extensionDidModify = ensureCarrierExtension(project);
  const resources = reconcileResources(
    project,
    gameCodeFolderName,
    orderedRelativePaths
  );
  const sourceFilesDidModify = declareSourceFilesInOrder(
    project,
    orderedRelativePaths,
    gameCodeFolderName
  );

  const gameCodeResourceNames = orderedRelativePaths.map(relativePath =>
    getByokGameCodeResourceName(relativePath, gameCodeFolderName)
  );
  const foreignNames = listByokGameCodeForeignResourceFileNames(
    project,
    gameCodeResourceNames
  );
  const exportedScriptNames: { [string]: string | null } = {};
  for (const entry of computeByokGameCodeExportedScriptNames(
    orderedRelativePaths,
    foreignNames
  )) {
    exportedScriptNames[entry.relativePath] = entry.scriptName;
  }

  return {
    didModifyProject:
      extensionDidModify || resources.didModifyProject || sourceFilesDidModify,
    createdExtension: extensionDidModify,
    addedResourceNames: resources.added,
    removedResourceNames: resources.removed,
    orderedRelativePaths,
    exportedScriptNames,
    errors,
  };
};
