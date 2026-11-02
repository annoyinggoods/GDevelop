// @flow
import type { EditorFunctionCallResult } from '../../EditorFunctions';
import {
  byokSearchAndInstallAsset,
  byokSearchAndInstallResources,
} from './ByokCatalogTools';
import {
  type ByokSettings,
  getByokSettings,
  isByokFullyConfigured,
  BYOK_TOOLS_VERSION,
} from './ByokTypes';

/**
 * Pure decision helpers and bridges used by `AskAiEditorContainer` — kept
 * out of the React component so they are unit-testable, and out of the
 * orchestrator so it stays free of editor imports.
 */

const BYOK_CHAT_ID_PREFIX = 'byok-';

/**
 * Recognize a BYOK chat id (see ByokChatStore.generateByokChatId) without
 * knowing the store.
 */
export const isByokAiRequestId = (id: string | null | void): boolean =>
  !!id && id.startsWith(BYOK_CHAT_ID_PREFIX);

/**
 * Whether a new Ask AI chat should run through the BYOK orchestrator instead
 * of GDevelop's backend: the user enabled and fully configured BYOK.
 */
export const shouldUseByokForNewRequest = (values: {
  +byok: ?ByokSettings,
  ...
}): boolean => isByokFullyConfigured(getByokSettings(values));

/**
 * How many approved-edit call ids the blanket-approval memory of a chat may
 * hold before it is emptied. Bounded memory on purpose: the set only exists
 * so the user does not re-approve the same batch within one chat, and a
 * long-lived chat must not accumulate ids forever. Clearing it whole (rather
 * than evicting oldest-first) is fine: worst case, the user is asked to
 * approve an edit again.
 */
export const APPROVED_CALL_IDS_CAPACITY = 500;

/**
 * The prop bundle that makes the chat UI's credits machinery idle for a
 * BYOK chat: a null quota short-circuits `canPayForAiRequest` to `true` and
 * `AiUsageIndicator` to its context-bar-only rendering. Every prop is named
 * explicitly — readable over clever.
 */
export const buildByokChatProps = (): {|
  quota: null,
  price: null,
  availableCredits: 0,
  isRefreshingLimits: false,
  increaseQuotaOffering: 'none',
|} => ({
  quota: null,
  price: null,
  availableCredits: 0,
  isRefreshingLimits: false,
  increaseQuotaOffering: 'none',
});

/**
 * The shape of the editor-function metadata the approval decision reads.
 * (Structural — accepts both `EditorFunction` and the without-project
 * variant, without importing the editor registry here.)
 */
type ApprovableEditorFunction = {
  +modifiesProject?: ?boolean,
  +getModifiesProject?: ?(args: any) => boolean,
  ...
};

/**
 * Whether running an editor function call with these arguments should pause
 * for the user's approval. Mirrors `doesFunctionCallModifyProject` from
 * `AiGeneration/Utils.js` (not exported upstream), with one deliberate
 * difference: an unknown function returns true — the safe default — because
 * whether it modifies the project is unknown, not false.
 */
export const byokCallRequiresApproval = (
  editorFunction: ApprovableEditorFunction | null,
  args: any
): boolean => {
  if (!editorFunction) return true;
  if (editorFunction.getModifiesProject) {
    return editorFunction.getModifiesProject(args);
  }
  return !!editorFunction.modifiesProject;
};

/** A tool call as the runner and the OpenAI API exchange it. */
export type ByokEditorFunctionCall = {|
  name: string,
  arguments: string,
  call_id: string,
|};

type ByokExecutorContext = {|
  aiRequestId: string,
  getRelatedAiRequestLastMessages: () => any,
|};

/** The tool executor handed to the orchestrator (see ByokOrchestrator). */
export type ByokEditorFunctionCallExecutor = (
  functionCalls: Array<ByokEditorFunctionCall>,
  context: ByokExecutorContext
) => Promise<{|
  results: Array<EditorFunctionCallResult>,
  createdSceneNames: Array<string>,
  createdProject: any,
|}>;

type ByokExecutorDeps = {|
  // `processEditorFunctionCalls`, injected so this module stays testable
  // without the whole editor registry.
  processEditorFunctionCalls: (options: any) => Promise<any>,
  // The project, read **at call time** (not captured at construction): a
  // chat that creates its project mid-flight (initialize_project) must run
  // its next batch against the new project, before React re-renders.
  getProject: () => any,
  i18n: any,
  editorCallbacks: any,
  // Needed by the v1 whitelist: `add_behavior` and `create_or_replace_object`
  // install extensions for `::`-typed behaviors/objects.
  ensureExtensionInstalled: (options: any) => Promise<void>,
  onSceneEventsModifiedOutsideEditor: (changes: any) => void,
  onInstancesModifiedOutsideEditor: (changes: any) => void,
  onObjectsModifiedOutsideEditor: (changes: any) => void,
  onObjectGroupsModifiedOutsideEditor: (changes: any) => void,
  onProjectItemRenamedOutsideEditor: (changes: any) => void,
  onWillDeleteScene: (changes: any) => Promise<void>,
  onWillDeleteGameplayTest: (changes: any) => Promise<void>,
  onWillDeleteObject: (changes: any) => void,
  onWillInstallExtension: (extensionNames: Array<string>) => void,
  onExtensionInstalled: (extensionNames: Array<string>) => void,
  // When true, the `run_script` tool exposes only non-mutating functions —
  // the read-only script context of the scout sub-agent (the editor
  // runner's own flag, passed through).
  runScriptReadOnly?: boolean,
|};

// The tool capabilities excluded from the BYOK v1 whitelist (event
// generation, asset/resource stores) resolve to failures if a model
// hallucinates a call to them — the runner turns the thrown error into a
// `success: false` tool output the model can recover from.
const makeUnavailableDependency = (name: string) => async (): Promise<any> => {
  throw new Error(`${name} is not available in BYOK chats.`);
};

/**
 * Build the tool executor injected into the orchestrator: a thin wrapper
 * around `processEditorFunctionCalls` that provides the (excluded) store and
 * generation dependencies as failures, and coalesces the outside-editor
 * notifications of a whole batch — the same accumulation the server-backed
 * flow does in `useProcessFunctionCalls`, so a batch of 20 edits refreshes
 * the editor once, not 20 times.
 */
export const createByokEditorFunctionCallExecutor = (
  deps: ByokExecutorDeps
): ByokEditorFunctionCallExecutor => {
  return async (
    functionCalls: Array<ByokEditorFunctionCall>,
    context: ByokExecutorContext
  ): Promise<{|
    results: Array<EditorFunctionCallResult>,
    createdSceneNames: Array<string>,
    createdProject: any,
  |}> => {
    const accumulatedSceneEventsChanges: Map<any, Set<string>> = new Map();
    const accumulatedInstancesScenes: Set<any> = new Set();
    const accumulatedObjectsChanges: Map<any, boolean> = new Map();
    const accumulatedObjectGroupsScenes: Set<any> = new Set();
    const flushAccumulatedOutsideEditorChanges = () => {
      accumulatedSceneEventsChanges.forEach((eventIds, scene) =>
        deps.onSceneEventsModifiedOutsideEditor({
          scene,
          newOrChangedAiGeneratedEventIds: eventIds,
        })
      );
      accumulatedInstancesScenes.forEach(scene =>
        deps.onInstancesModifiedOutsideEditor({ scene })
      );
      accumulatedObjectsChanges.forEach((isNewObjectTypeUsed, scene) =>
        deps.onObjectsModifiedOutsideEditor({ scene, isNewObjectTypeUsed })
      );
      accumulatedObjectGroupsScenes.forEach(scene =>
        deps.onObjectGroupsModifiedOutsideEditor({ scene })
      );
    };

    try {
      return await deps.processEditorFunctionCalls({
        project: deps.getProject(),
        i18n: deps.i18n,
        editorCallbacks: deps.editorCallbacks,
        toolOptions: null,
        // The BYOK agent runs script batches (run_script), like the hosted
        // v15 orchestrator: an idempotent no-op is a success (it must not
        // kill the rest of a script). Null would mean pre-v12 semantics.
        toolsVersion: BYOK_TOOLS_VERSION,
        functionCalls,
        relatedAiRequestId: context.aiRequestId,
        getRelatedAiRequestLastMessages:
          context.getRelatedAiRequestLastMessages,
        runScriptReadOnly: deps.runScriptReadOnly === true,
        generateEvents: makeUnavailableDependency('generate_events'),
        ensureExtensionInstalled: deps.ensureExtensionInstalled,
        onSceneEventsModifiedOutsideEditor: changes => {
          const existingEventIds = accumulatedSceneEventsChanges.get(
            changes.scene
          );
          if (existingEventIds) {
            changes.newOrChangedAiGeneratedEventIds.forEach((eventId: string) =>
              existingEventIds.add(eventId)
            );
          } else {
            accumulatedSceneEventsChanges.set(
              changes.scene,
              new Set(changes.newOrChangedAiGeneratedEventIds)
            );
          }
        },
        onInstancesModifiedOutsideEditor: changes => {
          accumulatedInstancesScenes.add(changes.scene);
        },
        onObjectsModifiedOutsideEditor: changes => {
          // OR-accumulate like the server-backed flow: once any call of the
          // batch used a new object type in a scene, the flush must say so
          // even if a later call reported false for the same scene.
          const alreadyAccumulatedNewObjectType = accumulatedObjectsChanges.get(
            changes.scene
          );
          accumulatedObjectsChanges.set(
            changes.scene,
            !!alreadyAccumulatedNewObjectType || !!changes.isNewObjectTypeUsed
          );
        },
        onObjectGroupsModifiedOutsideEditor: changes => {
          accumulatedObjectGroupsScenes.add(changes.scene);
        },
        onProjectItemRenamedOutsideEditor:
          deps.onProjectItemRenamedOutsideEditor,
        onWillDeleteScene: deps.onWillDeleteScene,
        onWillDeleteGameplayTest: deps.onWillDeleteGameplayTest,
        onWillDeleteObject: deps.onWillDeleteObject,
        onWillInstallExtension: deps.onWillInstallExtension,
        onExtensionInstalled: deps.onExtensionInstalled,
        searchAndInstallAsset: options =>
          byokSearchAndInstallAsset(options, {
            project: deps.getProject(),
            ensureExtensionInstalled: deps.ensureExtensionInstalled,
          }),
        searchAndInstallResources: options =>
          byokSearchAndInstallResources(options, {
            project: deps.getProject(),
          }),
        getAssetStoreTagForNewObject: () => null,
      });
    } finally {
      flushAccumulatedOutsideEditorChanges();
    }
  };
};
