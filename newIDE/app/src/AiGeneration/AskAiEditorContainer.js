// @flow
import * as React from 'react';
import { type I18n as I18nType } from '@lingui/core';
import { type MessageDescriptor } from '../Utils/i18n/MessageDescriptor.flow';
import { exceptionallyGuardAgainstDeadObject } from '../Utils/IsNullPtr';
import { I18n } from '@lingui/react';
import { type RenderEditorContainerPropsWithRef } from '../MainFrame/EditorContainers/BaseEditor';
import {
  type SceneEventsOutsideEditorChanges,
  type InstancesOutsideEditorChanges,
  type ExternalLayoutOutsideEditorChanges,
  type ExternalEventsOutsideEditorChanges,
  type ObjectsOutsideEditorChanges,
  type ObjectGroupsOutsideEditorChanges,
  type ProjectItemRenamedOutsideEditorChanges,
  type WillDeleteSceneChanges,
  type WillDeleteGameplayTestChanges,
  type WillDeleteObjectChanges,
  type ExtensionsOutsideEditorChanges,
  type WillDeleteExtensionItemChanges,
} from '../EditorFunctions/OutsideEditorChanges';
import { type ObjectWithContext } from '../ObjectsList/EnumerateObjects';
import Paper from '../UI/Paper';
import { AiRequestChat, type AiRequestChatInterface } from './AiRequestChat';
import { canPayForAiRequest } from './AiRequestChat/Utils';
import { registerAskAiPrefillListener } from './AskAiPrefill';
import {
  getLatestInGameEditorExtensionErrors,
  addInGameEditorExtensionErrorsToFunctionCallOutputs,
} from '../InGameEditorExtensionErrors';
import {
  addMessageToAiRequest,
  createAiRequest,
  sendAiRequestFeedback,
  forkAiRequest,
  retryAiRequest,
  getAiRequest,
  type AiRequest,
  type AiRequestMessage,
  type AiRequestMessageAssistantFunctionCall,
} from '../Utils/GDevelopServices/Generation';
import {
  getCloudProjectFileMetadataIdentifier,
  type ExpandedCloudProjectVersion,
} from '../Utils/GDevelopServices/Project';
import { delay } from '../Utils/Delay';
import AuthenticatedUserContext from '../Profile/AuthenticatedUserContext';
import { Toolbar } from './Toolbar';
import { AskAiHistory, type AskAiHistoryLayout } from './AskAiHistory';
import { makeSimplifiedProjectBuilder } from '../EditorFunctions/SimplifiedProject/SimplifiedProject';
import {
  canUpgradeSubscription,
  hasValidSubscriptionPlan,
} from '../Utils/GDevelopServices/Usage';
import { retryIfFailed } from '../Utils/RetryIfFailed';
import { type EditorCallbacks } from '../EditorFunctions';
import {
  aiRequestHasWorkInProgress,
  getFunctionCallOutputsFromEditorFunctionCallResults,
  getFunctionCallsToProcess,
} from './AiRequestUtils';
import { type EditorFunctionCallResult } from '../EditorFunctions';
import { useStableUpToDateRef } from '../Utils/UseStableUpToDateCallback';
import {
  type NewProjectSetup,
  type ExampleProjectSetup,
} from '../ProjectCreation/NewProjectSetupDialog';
import {
  type FileMetadata,
  type StorageProvider,
  type SaveAsLocation,
} from '../ProjectsStorage';
import { type ResourceManagementProps } from '../ResourcesList/ResourceSource';
import {
  sendAiRequestMessageSent,
  sendAiRequestStarted,
} from '../Utils/Analytics/EventSender';
import { listAllExamples } from '../Utils/GDevelopServices/Example';
import UrlStorageProvider from '../ProjectsStorage/UrlStorageProvider';
import { prepareAiUserContent } from './PrepareAiUserContent';
import { AiRequestContext } from './AiRequestContext';
import { processEditorFunctionCalls } from '../EditorFunctions/EditorFunctionCallRunner';
import {
  editorFunctions,
  editorFunctionsWithoutProject,
} from '../EditorFunctions';
import { getByokImage } from './Byok/ByokImageContent';
import {
  buildByokChatProps,
  isByokAiRequestId,
  shouldUseByokForNewRequest,
} from './Byok/ByokSeam';
import { useByokChatSeam } from './Byok/useByokChatSeam';
import {
  forkByokChat,
  getByokProjectSnapshot,
  restoreByokProjectFromSnapshot,
} from './Byok/ByokFork';
import {
  consumePendingByokChatSelection,
  getByokChat,
  pickByokChatToSelectOnMount,
} from './Byok/ByokChatStore';
import { getProjectPreviewLauncher } from '../GameplayTests/GameplayTestRunner';
import { getAiConfigurationPresetsWithAvailability } from './AiConfiguration';
import {
  setEditorHotReloadNeeded,
  type HotReloadSteps,
} from '../EmbeddedGame/EmbeddedGameFrame';
import { type CreateProjectResult } from '../Utils/UseCreateProject';
import {
  useAiRequestState,
  type OpenAskAiOptions,
  type NewAiRequestOptions,
  useProcessFunctionCalls,
  useActivatePendingSubAgents,
  useLoadSubAgentRequests,
  useRefreshLimits,
  AI_ORCHESTRATOR_TOOLS_VERSION,
} from './Utils';
import PreferencesContext from '../MainFrame/Preferences/PreferencesContext';
import UnsavedChangesContext from '../MainFrame/UnsavedChangesContext';
import EventsFunctionsExtensionsContext from '../EventsFunctionsExtensionsLoader/EventsFunctionsExtensionsContext';
import useAlertDialog from '../UI/Alert/useAlertDialog';
import { useResponsiveWindowSize } from '../UI/Responsive/ResponsiveWindowMeasurer';
import { t } from '@lingui/macro';
import { extractGDevelopApiErrorStatusAndCode } from '../Utils/GDevelopServices/Errors';
import { SubscriptionContext } from '../Profile/Subscription/SubscriptionContext';

const gd: libGDevelop = global.gd;

const styles = {
  container: {
    flex: 1,
    display: 'flex',
    minWidth: 0,
    minHeight: 0,
  },
  paper: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    minWidth: 0,
    overflowY: 'scroll',
    overflowX: 'hidden',
  },
  chatContainer: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    width: 'min(100%, 800px)',
    marginLeft: 10,
    marginRight: 10,
    marginBottom: 10,
    minHeight: 0,
    minWidth: 0,
  },
};

// BYOK chats have no server-side messages to give feedback on. The render
// gates now hide the feedback buttons entirely on those chats (the callback
// is simply not passed), but this inert handler is kept: a future upstream
// change that wants the buttons on local chats can reuse it as-is.
export const onSendByokNoopFeedback = async (): Promise<void> => {};

type Props = {|
  isActive: boolean,
  paneIdentifier: string,
  project: ?gdProject,
  resourceManagementProps: ResourceManagementProps,
  fileMetadata: ?FileMetadata,
  storageProvider: ?StorageProvider,
  setToolbar: (?React.Node) => void,
  i18n: I18nType,
  onCreateProjectFromExample: (
    exampleProjectSetup: ExampleProjectSetup
  ) => Promise<CreateProjectResult>,
  onCreateEmptyProject: (
    newProjectSetup: NewProjectSetup
  ) => Promise<CreateProjectResult>,
  onOpenLayout: (
    sceneName: string,
    options: {|
      openEventsEditor: boolean,
      openSceneEditor: boolean,
      focusWhenOpened:
        | 'scene-or-events-otherwise'
        | 'scene'
        | 'events'
        | 'none',
    |}
  ) => void,
  onOpenExternalLayout: (externalLayoutName: string) => void,
  onSceneEventsModifiedOutsideEditor: (
    changes: SceneEventsOutsideEditorChanges
  ) => void,
  onInstancesModifiedOutsideEditor: (
    changes: InstancesOutsideEditorChanges
  ) => void,
  onExternalLayoutModifiedOutsideEditor: (
    changes: ExternalLayoutOutsideEditorChanges
  ) => void,
  onExternalEventsModifiedOutsideEditor: (
    changes: ExternalEventsOutsideEditorChanges
  ) => void,
  onObjectsModifiedOutsideEditor: (
    changes: ObjectsOutsideEditorChanges
  ) => void,
  onEffectsModifiedOutsideEditor: () => void,
  onObjectGroupsModifiedOutsideEditor: (
    changes: ObjectGroupsOutsideEditorChanges
  ) => void,
  onProjectItemRenamedOutsideEditor: (
    changes: ProjectItemRenamedOutsideEditorChanges
  ) => void,
  onWillDeleteScene: (changes: WillDeleteSceneChanges) => Promise<void>,
  onWillDeleteGameplayTest: (
    changes: WillDeleteGameplayTestChanges
  ) => Promise<void>,
  onWillDeleteObject: (changes: WillDeleteObjectChanges) => void,
  onExtensionsModifiedOutsideEditor: (
    changes: ExtensionsOutsideEditorChanges
  ) => void,
  onWillDeleteExtensionItem: (
    changes: WillDeleteExtensionItemChanges
  ) => Promise<void>,
  onOpenEventsFunctionsExtension: (
    extensionName: string,
    initiallyFocusedFunctionName?: ?string,
    initiallyFocusedBehaviorName?: ?string,
    initiallyFocusedObjectName?: ?string
  ) => void,
  onOpenCustomObjectEditor: (
    extensionName: string,
    objectName: string,
    variantName: string
  ) => void,
  onWillInstallExtension: (extensionNames: Array<string>) => void,
  onExtensionInstalled: (extensionNames: Array<string>) => void,
  gameEditorMode: 'embedded-game' | 'instances-editor',
  continueProcessingFunctionCallsOnMount?: boolean,
  onOpenAskAi: (?OpenAskAiOptions) => void,
  onCheckoutVersion: (
    version: ExpandedCloudProjectVersion,
    options?: {| dontSaveCheckedOutVersionStatus?: boolean |}
  ) => Promise<boolean>,
  getOrLoadProjectVersion: (
    versionId: string
  ) => Promise<?ExpandedCloudProjectVersion>,
  onSave: (options?: {|
    skipNewVersionWarning: boolean,
  |}) => Promise<?FileMetadata>,
  onSaveProjectAsWithStorageProvider: (
    options: ?{|
      requestedStorageProvider?: StorageProvider,
      forcedSavedAsLocation?: SaveAsLocation,
      createdProject?: gdProject,
    |}
  ) => Promise<?FileMetadata>,
|};

export type AskAiEditorInterface = {|
  getProject: () => void,
  updateToolbar: () => void,
  forceUpdateEditor: () => void,
  onEventsBasedObjectChildrenEdited: (
    eventsBasedObject: gdEventsBasedObject,
    options?: {| editedObject?: ?gdObject, hasResourceChanged?: boolean |}
  ) => void,
  onSceneObjectEdited: (
    scene: gdLayout,
    objectWithContext: ObjectWithContext,
    hasResourceChanged?: boolean
  ) => void,
  onSceneObjectsDeleted: (scene: gdLayout) => void,
  onSceneEventsModifiedOutsideEditor: (
    changes: SceneEventsOutsideEditorChanges
  ) => void,
  onInstancesModifiedOutsideEditor: (
    changes: InstancesOutsideEditorChanges
  ) => void,
  onObjectsModifiedOutsideEditor: (
    changes: ObjectsOutsideEditorChanges
  ) => void,
  onEffectsModifiedOutsideEditor: () => void,
  onObjectGroupsModifiedOutsideEditor: (
    changes: ObjectGroupsOutsideEditorChanges
  ) => void,
  onWillDeleteObject: (changes: WillDeleteObjectChanges) => void,
  onExtensionsModifiedOutsideEditor: (
    changes: ExtensionsOutsideEditorChanges
  ) => void,
  selectAllInsideEditor: () => void,
  startOrOpenChat: (
    ?{|
      aiRequestId: string | null,
    |}
  ) => void,
  notifyChangesToInGameEditor: (hotReloadSteps: HotReloadSteps) => void,
  switchInGameEditorIfNoHotReloadIsNeeded: () => void,
  /**
   * Call whenever the AI editor is about to be closed (tab cross, pane close,
   * mobile drawer close, "close all/other tabs", project close...). If an AI
   * request is currently working, the user is asked to confirm — closing stops
   * the AI — and the request is suspended on confirmation. Returns true if the
   * close should proceed, false if the user cancelled (keep the editor open).
   *
   * This is the single place where a running AI request is suspended on close.
   * Suspending is therefore only ever triggered by explicit, known user actions
   * (this method or the "Stop" button), never as a side effect of unmounting —
   * so repositioning the tab or switching between the mobile/desktop layouts
   * never stops the AI.
   */
  requestClose: () => Promise<boolean>,
|};

const noop = () => {};

export const AskAiEditor: React.ComponentType<Props> = React.memo<Props>(
  React.forwardRef<Props, AskAiEditorInterface>(
    (
      {
        isActive,
        paneIdentifier,
        setToolbar,
        project: nullableProject,
        resourceManagementProps,
        fileMetadata,
        storageProvider,
        i18n,
        onCreateProjectFromExample,
        onCreateEmptyProject,
        onOpenLayout,
        onOpenExternalLayout,
        onSceneEventsModifiedOutsideEditor,
        onInstancesModifiedOutsideEditor,
        onExternalLayoutModifiedOutsideEditor,
        onExternalEventsModifiedOutsideEditor,
        onObjectsModifiedOutsideEditor,
        onEffectsModifiedOutsideEditor,
        onObjectGroupsModifiedOutsideEditor,
        onProjectItemRenamedOutsideEditor,
        onWillDeleteScene,
        onWillDeleteGameplayTest,
        onWillDeleteObject,
        onExtensionsModifiedOutsideEditor,
        onWillDeleteExtensionItem,
        onOpenEventsFunctionsExtension,
        onOpenCustomObjectEditor,
        onWillInstallExtension,
        onExtensionInstalled,
        onOpenAskAi,
        gameEditorMode,
        continueProcessingFunctionCallsOnMount,
        onCheckoutVersion,
        getOrLoadProjectVersion,
        onSave,
        onSaveProjectAsWithStorageProvider,
      }: Props,
      ref
    ) => {
      const project = exceptionallyGuardAgainstDeadObject(nullableProject);

      const onCreateProject = React.useCallback(
        async ({
          name,
          exampleSlug,
          projectFileUrl,
        }: {|
          name: string,
          exampleSlug: string | null,
          projectFileUrl?: string | null,
        |}) => {
          const newProjectSetup: NewProjectSetup = {
            projectName: name,
            storageProvider: UrlStorageProvider,
            saveAsLocation: null,
            creationSource: 'ai-agent-request',
            projectFileUrl,
          };

          if (exampleSlug) {
            const { exampleShortHeaders } = await listAllExamples();
            const exampleShortHeader = exampleShortHeaders.find(
              header => header.slug === exampleSlug
            );
            if (exampleShortHeader) {
              const { createdProject } = await onCreateProjectFromExample({
                exampleShortHeader,
                newProjectSetup,
                i18n,
              });
              return { exampleSlug, createdProject };
            }

            // The example was not found - still create an empty project.
          }

          const { createdProject } = await onCreateEmptyProject(
            newProjectSetup
          );

          return { exampleSlug: null, createdProject };
        },
        [onCreateProjectFromExample, onCreateEmptyProject, i18n]
      );

      // `EditorCallbacks` names the item to focus with an options object,
      // while the editor opens an extension with positional arguments.
      const onOpenEventsFunctionsExtensionItem = React.useCallback(
        (
          extensionName: string,
          {
            functionName,
            behaviorName,
            objectName,
          }: {|
            functionName?: string,
            behaviorName?: string,
            objectName?: string,
          |}
        ) => {
          onOpenEventsFunctionsExtension(
            extensionName,
            functionName,
            behaviorName,
            objectName
          );
        },
        [onOpenEventsFunctionsExtension]
      );

      const editorCallbacks: EditorCallbacks = React.useMemo(
        () => ({
          onOpenLayout,
          onOpenExternalLayout,
          onCreateProject,
          onOpenEventsFunctionsExtension: onOpenEventsFunctionsExtensionItem,
          onOpenCustomObjectEditor,
        }),
        [
          onOpenLayout,
          onOpenExternalLayout,
          onCreateProject,
          onOpenEventsFunctionsExtensionItem,
          onOpenCustomObjectEditor,
        ]
      );

      const { triggerUnsavedChanges } = React.useContext(UnsavedChangesContext);
      const givenInGameEditorExtensionErrorIds = React.useRef<Set<number>>(
        new Set()
      );
      const eventsFunctionsExtensionsState = React.useContext(
        EventsFunctionsExtensionsContext
      );
      const storageProviderName = storageProvider
        ? storageProvider.internalName
        : null;
      const {
        aiRequestStorage: {
          fetchAiRequestSummaries,
          setAiRequestSummariesGameId,
          aiRequests,
          aiRequestSummaries,
          aiRequestLoadingStates,
          loadAiRequest,
          forkingState,
          setForkingState,
        },
        selectedAiRequestId,
        selectedAiRequest,
        setSelectedAiRequestId,
        activeSubAgents,
      } = React.useContext(AiRequestContext);
      const {
        isFetchingSuggestions,
        savingProjectForMessageId,
      } = useAiRequestState({
        project,
        fileMetadata,
        storageProviderName,
        onSave,
        onSaveProjectAsWithStorageProvider,
      });
      const upToDateSelectedAiRequestId = useStableUpToDateRef(
        selectedAiRequestId
      );

      const [
        newAiRequestOptions,
        startNewAiRequest,
      ] = React.useState<NewAiRequestOptions | null>(null);

      // "Auto edit" is a frontend-only toggle owned by the chat UI. We keep its
      // live value in a ref here so function-call processing can gate
      // project-modifying tools behind a confirmation when it is off, without
      // re-rendering the whole container on every toggle.
      const isAutoEditEnabledRef = React.useRef<boolean>(true);
      const getIsAutoEditEnabled = React.useCallback(
        () => isAutoEditEnabledRef.current,
        []
      );

      const { isMobile, isMediumScreen } = useResponsiveWindowSize();
      // The history is a list on the side of the chat when there is room for
      // it: not on small or medium screens (the window size is the one of the
      // pane), and not in the right pane, where it comes from the right.
      const historyLayout: AskAiHistoryLayout =
        paneIdentifier === 'right'
          ? 'right-drawer'
          : isMobile || isMediumScreen
          ? 'left-drawer'
          : 'side-panel';
      const [isHistoryOpen, setIsHistoryOpen] = React.useState<boolean>(
        historyLayout === 'side-panel'
      );
      React.useEffect(
        () => {
          // The side list is shown by default, a drawer is not.
          setIsHistoryOpen(historyLayout === 'side-panel');
        },
        [historyLayout]
      );

      const { openSubscriptionDialog } = React.useContext(SubscriptionContext);

      // Clear forking state when viewing a different request
      React.useEffect(
        () => {
          if (
            forkingState &&
            selectedAiRequest &&
            forkingState.aiRequestId !== selectedAiRequest.id
          ) {
            setForkingState(null);
          }
        },
        [forkingState, selectedAiRequest, setForkingState]
      );

      const { showAlert, showConfirmation, showYesNoCancel } = useAlertDialog();

      const [
        isReadyToProcessFunctionCalls,
        setIsReadyToProcessFunctionCalls,
      ] = React.useState<boolean>(!!continueProcessingFunctionCallsOnMount);

      React.useEffect(
        () => {
          if (isActive && Object.keys(aiRequestSummaries).length === 0) {
            fetchAiRequestSummaries();
          }
        },
        // Fetch when the editor becomes active, but only if the history is
        // empty (as we provide a way to refresh in the history).
        // fetchAiRequestSummaries is also a dependency so that if the profile
        // was not yet loaded when the editor first became active, the fetch is
        // retried once it becomes available.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [isActive, fetchAiRequestSummaries]
      );

      // The chats of the opened project are listed first in the history.
      const projectGameId = project ? project.getProjectUuid() : null;
      React.useEffect(
        () => {
          setAiRequestSummariesGameId(projectGameId);
        },
        [projectGameId, setAiRequestSummariesGameId]
      );

      const onToggleHistory = React.useCallback(() => {
        setIsHistoryOpen(isHistoryOpen => !isHistoryOpen);
      }, []);

      const onCloseHistory = React.useCallback(() => {
        setIsHistoryOpen(false);
      }, []);

      const {
        aiRequestStorage,
        editorFunctionCallResultsStorage,
        getAiSettings,
        suspendAiRequest,
        pendingEditApproval,
        requestEditApproval,
        resolveEditApproval,
        setIsFetchingSuggestions,
      } = React.useContext(AiRequestContext);
      const {
        getEditorFunctionCallResults,
        addEditorFunctionCallResults,
        clearEditorFunctionCallResults,
      } = editorFunctionCallResultsStorage;
      const {
        updateAiRequest,
        isSendingAiRequest,
        getLastSendError,
        setSendingAiRequest,
        setLastSendError,
      } = aiRequestStorage;

      const aiRequestChatRef = React.useRef<AiRequestChatInterface | null>(
        null
      );

      const {
        values: preferencesValues,
        setMultipleValues: setPreferencesMultipleValues,
      } = React.useContext(PreferencesContext);
      const { automaticallyUseCreditsForAiRequests } = preferencesValues;

      // ---- BYOK (Bring Your Own Key) chats --------------------------------
      // A BYOK chat runs a client-side agent loop (ByokOrchestrator) and lives
      // in its own store (ByokChatStore). It must never enter
      // AiRequestContext: that would make it be loaded and polled on
      // GDevelop's servers. The whole wiring lives in the extracted seam hook
      // (the D8 refactor, Phase 8 step 8.0) — also reused by the standalone
      // homepage form (step 8.5).
      const resetByokChatUserInputs = React.useCallback((chatId: string) => {
        const aiRequestChatRefCurrent = aiRequestChatRef.current;
        if (aiRequestChatRefCurrent) {
          aiRequestChatRefCurrent.resetUserInput('');
          aiRequestChatRefCurrent.resetUserInput(chatId);
        }
      }, []);
      const byokChatSeam = useByokChatSeam({
        preferencesValues,
        project,
        fileMetadata,
        i18n,
        editorCallbacks,
        processEditorFunctionCalls,
        editorFunctions,
        editorFunctionsWithoutProject,
        onSceneEventsModifiedOutsideEditor,
        onInstancesModifiedOutsideEditor,
        onExternalLayoutModifiedOutsideEditor,
        onExternalEventsModifiedOutsideEditor,
        onObjectsModifiedOutsideEditor,
        onObjectGroupsModifiedOutsideEditor,
        onProjectItemRenamedOutsideEditor,
        onWillDeleteScene,
        onWillDeleteGameplayTest,
        onWillDeleteObject,
        onWillInstallExtension,
        onExtensionInstalled,
        getIsAutoEditEnabled,
        requestEditApproval,
        triggerUnsavedChanges,
        onOpenLayout,
        setSelectedAiRequestId,
        resetChatUserInputs: resetByokChatUserInputs,
        getProjectPreviewLauncher,
        updateByokPreferences: byokSettings =>
          setPreferencesMultipleValues({ byok: byokSettings }),
      });
      // A STABLE identity on purpose: this function is a prop of the memoized
      // ChatMessages, and an inline arrow gave it a new identity on every
      // render. Since the seam re-renders on every chat-store notification,
      // that defeated the memo and rebuilt the whole transcript — bubbles,
      // images, tool results — on every streaming step, for a chat whose
      // messages had not changed (audit100226 UI-9). getByokImage is a
      // module-level function, so an empty dependency list is correct.
      const getByokToolResultImage = React.useCallback((imageId: string) => {
        const image = getByokImage(imageId);
        return image ? { dataUrl: image.dataUrl } : null;
      }, []);
      const {
        selectedByokChatId,
        setSelectedByokChatId,
        selectedByokChat,
        onArchiveByokChat,
        startByokChat,
        sendByokUserMessage,
        suspendByokChat,
        clearApprovedByokEditCallIds,
        onRetryByokChat,
      } = byokChatSeam;

      // The single suspend entry of the container: BYOK chats are suspended
      // locally (no server request exists for them), server chats through
      // the provider.
      // A BYOK chat started by the homepage form (Phase 8.5) asks this
      // editor to select it when the tab opens: consume the request once.
      // Phase 13.2: when the editor remounts with no pending selection —
      // the exact moment a form-started chat's project opens and the tab
      // re-opens in its new pane — a chat that is still working re-selects
      // itself, so the live transcript stays in view (the loop never
      // restarted: it lives in the module-level orchestrator registry).
      React.useEffect(
        () => {
          const chatIdToSelect = pickByokChatToSelectOnMount(
            consumePendingByokChatSelection()
          );
          if (chatIdToSelect) {
            setSelectedAiRequestId(null);
            setSelectedByokChatId(chatIdToSelect);
          }
        },
        // Once on mount.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        []
      );

      const suspendAiRequestWithByokSupport = React.useCallback(
        async (aiRequestId: string) => {
          if (!isByokAiRequestId(aiRequestId)) {
            await suspendAiRequest(aiRequestId);
            return;
          }
          suspendByokChat(aiRequestId);
        },
        [suspendAiRequest, suspendByokChat]
      );
      // ---- end of BYOK chats ---------------------------------------------

      // A new chat can be started as soon as one is selected (server or BYOK).
      const canStartNewChat = !!selectedAiRequestId || !!selectedByokChatId;

      const authenticatedUser = React.useContext(AuthenticatedUserContext);
      const {
        profile,
        getAuthorizationHeader,
        onOpenCreateAccountDialog,
        limits,
        onRefreshLimits,
        subscription,
      } = authenticatedUser;

      const { isRefreshingLimits, refreshLimits } = useRefreshLimits(
        onRefreshLimits
      );
      const [isSendingUserMessage, setIsSendingUserMessage] = React.useState(
        false
      );

      const availableCredits = limits ? limits.credits.userBalance.amount : 0;
      const quota =
        (limits && limits.quotas && limits.quotas['consumed-ai-credits']) ||
        null;
      const aiRequestPrice =
        (limits && limits.credits && limits.credits.prices['ai-request']) ||
        null;
      const aiRequestPriceInCredits = aiRequestPrice
        ? aiRequestPrice.priceInCredits
        : null;

      // Refresh limits when navigating ot this tab, as we want to be sure
      // we display the proper quota and credits information for the user.
      React.useEffect(
        () => {
          if (isActive && profile) {
            refreshLimits();
          }
        },
        [isActive, profile, refreshLimits]
      );

      // Trigger the start of the new AI request if the user has requested it
      // (or if triggered automatically by setting `newAiRequestOptions`, for example
      // after waiting for the project to be created for an AI agent request).
      React.useEffect(
        () => {
          (async () => {
            if (!newAiRequestOptions) return;
            console.info('Starting a new AI request...');

            // BYOK chats run entirely client-side — no GDevelop account (and
            // no credits) involved.
            if (shouldUseByokForNewRequest(preferencesValues)) {
              const { userRequest } = newAiRequestOptions;
              startNewAiRequest(null);
              await startByokChat(userRequest);
              return;
            }

            if (!profile) {
              onOpenCreateAccountDialog();
              startNewAiRequest(null);
              return;
            }

            // Read the options and reset them (to avoid launching the same request twice).
            const {
              mode,
              userRequest,
              attachmentIds,
              aiConfigurationPresetId,
            } = newAiRequestOptions;
            startNewAiRequest(null);

            // Ensure the user has enough credits to pay for the request, or ask them
            // to buy some more.
            let payWithCredits = false;
            if (quota && quota.limitReached && aiRequestPriceInCredits) {
              payWithCredits = true;
            }
            // The same rule as the one enabling the send button, so the button
            // can't offer to send a request this would silently drop.
            if (
              !canPayForAiRequest({
                quota,
                price: aiRequestPrice,
                availableCredits,
                automaticallyUseCreditsForAiRequests,
              })
            ) {
              return;
            }

            // Request is now ready to be started.
            try {
              const simplifiedProjectBuilder = makeSimplifiedProjectBuilder(gd);
              const simplifiedProjectJson = project
                ? JSON.stringify(
                    simplifiedProjectBuilder.getSimplifiedProject(project, {})
                  )
                : null;
              const projectSpecificExtensionsSummaryJson = project
                ? JSON.stringify(
                    simplifiedProjectBuilder.getProjectSpecificExtensionsSummary(
                      project
                    )
                  )
                : null;

              setSendingAiRequest(null, true);
              setIsSendingUserMessage(true);

              const preparedAiUserContent = await prepareAiUserContent({
                getAuthorizationHeader,
                userId: profile.id,
                simplifiedProjectJson,
                projectSpecificExtensionsSummaryJson,
                eventsJson: null,
              });

              const aiRequest = await createAiRequest(getAuthorizationHeader, {
                userRequest: userRequest,
                attachmentIds,
                userId: profile.id,
                gameProjectJsonUserRelativeKey:
                  preparedAiUserContent.gameProjectJsonUserRelativeKey,
                gameProjectJson: preparedAiUserContent.gameProjectJson,
                projectSpecificExtensionsSummaryJsonUserRelativeKey:
                  preparedAiUserContent.projectSpecificExtensionsSummaryJsonUserRelativeKey,
                projectSpecificExtensionsSummaryJson:
                  preparedAiUserContent.projectSpecificExtensionsSummaryJson,
                payWithCredits,
                gameId: project ? project.getProjectUuid() : null,
                // $FlowFixMe[incompatible-type]
                fileMetadata,
                storageProviderName,
                mode,
                toolsVersion: AI_ORCHESTRATOR_TOOLS_VERSION,
                aiConfiguration: {
                  presetId: aiConfigurationPresetId,
                },
              });

              console.info('Successfully created a new AI request:', aiRequest);
              setSendingAiRequest(null, false);
              setIsSendingUserMessage(false);
              updateAiRequest(aiRequest.id, () => aiRequest);

              // Select the new AI request just created - unless the user switched to another one
              // in the meantime.
              if (!upToDateSelectedAiRequestId.current) {
                setSelectedAiRequestId(aiRequest.id);
              }

              const aiRequestChatRefCurrent = aiRequestChatRef.current;
              if (aiRequestChatRefCurrent) {
                aiRequestChatRefCurrent.resetUserInput('');
                aiRequestChatRefCurrent.resetUserInput(selectedAiRequestId);
              }

              sendAiRequestStarted({
                simplifiedProjectJsonLength: simplifiedProjectJson
                  ? simplifiedProjectJson.length
                  : 0,
                projectSpecificExtensionsSummaryJsonLength: projectSpecificExtensionsSummaryJson
                  ? projectSpecificExtensionsSummaryJson.length
                  : 0,
                payWithCredits,
                storageProviderName,
                mode,
                aiRequestId: aiRequest.id,
              });
            } catch (error) {
              console.error('Error starting a new AI request:', error);
              setLastSendError(null, error);
              setIsSendingUserMessage(false);
            }

            // Refresh the user limits, to ensure quota and credits information
            // is up-to-date after an AI request.
            await delay(500);
            await refreshLimits({ withRetry: true });
          })();
        },
        [
          aiRequestPrice,
          aiRequestPriceInCredits,
          availableCredits,
          getAuthorizationHeader,
          onOpenCreateAccountDialog,
          refreshLimits,
          profile,
          project,
          fileMetadata,
          storageProvider,
          quota,
          selectedAiRequestId,
          setLastSendError,
          setSelectedAiRequestId,
          setSendingAiRequest,
          setIsSendingUserMessage,
          upToDateSelectedAiRequestId,
          updateAiRequest,
          newAiRequestOptions,
          automaticallyUseCreditsForAiRequests,
          storageProviderName,
          preferencesValues,
          startByokChat,
        ]
      );

      // Send the results of the function call outputs, if any, and the user message (if any).
      const onSendMessage = React.useCallback(
        async ({
          aiRequestId,
          userMessage,
          byokImageIds,
          attachmentIds,
          createdSceneNames,
          createdExternalLayoutNames,
          createdProject,
          editorFunctionCallResults,
        }: {|
          aiRequestId: string,
          userMessage: string,
          byokImageIds?: Array<string>,
          attachmentIds?: Array<string>,
          createdSceneNames?: Array<string>,
          createdExternalLayoutNames?: Array<string>,
          createdProject?: ?gdProject,
          editorFunctionCallResults: Array<EditorFunctionCallResult>,
        |}) => {
          // BYOK chats continue through their local orchestrator — never the
          // backend (and no GDevelop account is needed).
          if (isByokAiRequestId(aiRequestId)) {
            await sendByokUserMessage(aiRequestId, userMessage, byokImageIds);
            return;
          }

          if (!profile) return;
          // Files can be sent without any text.
          const hasUserMessage =
            !!userMessage || !!(attachmentIds && attachmentIds.length);

          const aiRequestForMessage = aiRequests[aiRequestId];
          if (!aiRequestForMessage) return;

          if (isSendingAiRequest(aiRequestId)) {
            console.info(
              'Skipping send for AI request: another send is already in progress.'
            );
            return;
          }

          // Read the results from the editor that applied the function calls.
          // and transform them into the output that will be stored on the AI request.
          const {
            hasUnfinishedResult,
            functionCallOutputs,
          } = getFunctionCallOutputsFromEditorFunctionCallResults(
            editorFunctionCallResults
          );

          const hasFunctionsCallsToProcess =
            getFunctionCallsToProcess({
              aiRequest: aiRequestForMessage,
              editorFunctionCallResults,
            }).length > 0;

          // If anything is not finished yet, stop there (we only send all
          // results at once, AI do not support partial results).
          if (hasUnfinishedResult) {
            console.info(
              'Skipping send for AI request: some function call results are not finished yet.'
            );
            return;
          }
          if (hasFunctionsCallsToProcess) {
            console.info(
              'Skipping send for AI request: there are still function calls to process.'
            );
            return;
          }

          // If nothing to send, stop there.
          if (functionCallOutputs.length === 0 && !hasUserMessage) return;

          // Paying with credits is only when a user message is sent (and quota is exhausted).
          let payWithCredits = false;
          if (
            hasUserMessage &&
            quota &&
            quota.limitReached &&
            aiRequestPriceInCredits
          ) {
            payWithCredits = true;
            // The same rule as the one enabling the send button, so the button
            // can't offer to send a message this would silently drop.
            if (
              !canPayForAiRequest({
                quota,
                price: aiRequestPrice,
                availableCredits,
                automaticallyUseCreditsForAiRequests,
              })
            ) {
              return;
            }
          }

          try {
            setSendingAiRequest(aiRequestId, true);
            // Sending takes over the UI: drop any in-flight best-effort
            // suggestions fetch so its "working" state can't keep the input
            // enabled while the real request runs.
            setIsFetchingSuggestions(false);
            if (hasUserMessage) setIsSendingUserMessage(true);

            const upToDateProject = createdProject || project;

            const simplifiedProjectBuilder = makeSimplifiedProjectBuilder(gd);
            const simplifiedProjectJson = upToDateProject
              ? JSON.stringify(
                  simplifiedProjectBuilder.getSimplifiedProject(
                    upToDateProject,
                    {}
                  )
                )
              : null;
            const projectSpecificExtensionsSummaryJson = upToDateProject
              ? JSON.stringify(
                  simplifiedProjectBuilder.getProjectSpecificExtensionsSummary(
                    upToDateProject
                  )
                )
              : null;

            const preparedAiUserContent = await prepareAiUserContent({
              getAuthorizationHeader,
              userId: profile.id,
              simplifiedProjectJson,
              projectSpecificExtensionsSummaryJson,
              eventsJson: null,
            });

            if (
              editorFunctionCallResults &&
              editorFunctionCallResults.some(
                result =>
                  result.status === 'finished' && result.didModifyProject
              )
            ) {
              triggerUnsavedChanges();
            }

            // The errors of the code of extensions in the in-game editor are
            // given to the orchestrator, which changes the project with the
            // user.
            const {
              functionCallOutputs: functionCallOutputsToSend,
              newlyGivenErrorIds,
            } =
              aiRequestForMessage.mode === 'orchestrator'
                ? addInGameEditorExtensionErrorsToFunctionCallOutputs({
                    functionCallOutputs,
                    errors: getLatestInGameEditorExtensionErrors(),
                    givenErrorIds: givenInGameEditorExtensionErrorIds.current,
                    project: upToDateProject,
                  })
                : { functionCallOutputs, newlyGivenErrorIds: [] };

            const aiRequest: AiRequest = await retryIfFailed({ times: 2 }, () =>
              addMessageToAiRequest(getAuthorizationHeader, {
                userId: profile.id,
                aiRequestId,
                functionCallOutputs: functionCallOutputsToSend,
                gameProjectJsonUserRelativeKey:
                  preparedAiUserContent.gameProjectJsonUserRelativeKey,
                gameProjectJson: preparedAiUserContent.gameProjectJson,
                projectSpecificExtensionsSummaryJsonUserRelativeKey:
                  preparedAiUserContent.projectSpecificExtensionsSummaryJsonUserRelativeKey,
                projectSpecificExtensionsSummaryJson:
                  preparedAiUserContent.projectSpecificExtensionsSummaryJson,
                gameId: upToDateProject
                  ? upToDateProject.getProjectUuid()
                  : undefined,
                payWithCredits,
                userMessage,
                attachmentIds,
                // All requests made by the user are in orchestrator mode: set
                // it (and the tools version) when a user message is sent, in
                // case an older request made with another mode is being
                // continued. Don't set it otherwise, as this can be a message
                // sent to a sub-agent request (explorer or edit agent).
                mode: hasUserMessage ? 'orchestrator' : undefined,
                toolsVersion: hasUserMessage
                  ? AI_ORCHESTRATOR_TOOLS_VERSION
                  : undefined,
              })
            );
            updateAiRequest(aiRequest.id, () => aiRequest);
            newlyGivenErrorIds.forEach(errorId =>
              givenInGameEditorExtensionErrorIds.current.add(errorId)
            );
            setSendingAiRequest(aiRequest.id, false);
            setIsSendingUserMessage(false);
            clearEditorFunctionCallResults(aiRequest.id);

            if (hasUserMessage) {
              sendAiRequestMessageSent({
                simplifiedProjectJsonLength: simplifiedProjectJson
                  ? simplifiedProjectJson.length
                  : 0,
                projectSpecificExtensionsSummaryJsonLength: projectSpecificExtensionsSummaryJson
                  ? projectSpecificExtensionsSummaryJson.length
                  : 0,
                payWithCredits,
                mode: 'orchestrator',
                aiRequestId: aiRequest.id,
                outputLength: aiRequest.output ? aiRequest.output.length : 0,
              });
            }

            // Only once sent: the text and the files stay to send them again
            // after an error.
            if (hasUserMessage && aiRequestId === selectedAiRequestId) {
              const aiRequestChatRefCurrent = aiRequestChatRef.current;
              if (aiRequestChatRefCurrent) {
                aiRequestChatRefCurrent.resetUserInput('');
                aiRequestChatRefCurrent.resetUserInput(aiRequestId);
              }
            }
          } catch (error) {
            console.error('Error while sending AI request message:', error);
            // TODO: update the label of the button to send again.
            setLastSendError(aiRequestId, error);
            setIsSendingUserMessage(false);
          }

          // Refresh the user limits, to ensure quota and credits information
          // is up-to-date after an AI request.
          await delay(500);
          await refreshLimits({ withRetry: true });

          if (createdSceneNames && createdSceneNames.length > 0) {
            createdSceneNames.forEach(sceneName => {
              onOpenLayout(sceneName, {
                openEventsEditor: true,
                openSceneEditor: true,
                focusWhenOpened: 'scene',
              });
            });
          }
          if (
            createdExternalLayoutNames &&
            createdExternalLayoutNames.length > 0
          ) {
            createdExternalLayoutNames.forEach(externalLayoutName => {
              onOpenExternalLayout(externalLayoutName);
            });
          }
        },
        [
          profile,
          selectedAiRequestId,
          sendByokUserMessage,
          aiRequests,
          isSendingAiRequest,
          quota,
          aiRequestPrice,
          aiRequestPriceInCredits,
          availableCredits,
          setSendingAiRequest,
          setIsFetchingSuggestions,
          setIsSendingUserMessage,
          updateAiRequest,
          clearEditorFunctionCallResults,
          getAuthorizationHeader,
          setLastSendError,
          refreshLimits,
          project,
          onOpenLayout,
          onOpenExternalLayout,
          automaticallyUseCreditsForAiRequests,
          triggerUnsavedChanges,
        ]
      );

      // Ask the AI to continue a request that stopped on an error: nothing is
      // added to the conversation, so this is not charged again (the API only
      // charges back the usage it refunded when the request failed).
      const onRetryAfterError = React.useCallback(
        async () => {
          if (!selectedAiRequestId || !profile) return;
          try {
            const aiRequest = await retryAiRequest(getAuthorizationHeader, {
              userId: profile.id,
              aiRequestId: selectedAiRequestId,
            });
            updateAiRequest(aiRequest.id, () => aiRequest);
          } catch (error) {
            console.error('Error while retrying the AI request:', error);
            setLastSendError(selectedAiRequestId, error);
          }
        },
        [
          selectedAiRequestId,
          profile,
          getAuthorizationHeader,
          updateAiRequest,
          setLastSendError,
        ]
      );

      useActivatePendingSubAgents({ selectedAiRequest });
      useLoadSubAgentRequests({ selectedAiRequest });

      const onSendEditorFunctionCallResults = React.useCallback(
        async (
          aiRequestId: string,
          editorFunctionCallResults: Array<EditorFunctionCallResult>,
          options: {|
            createdSceneNames?: Array<string>,
            createdExternalLayoutNames?: Array<string>,
            createdProject?: ?gdProject,
          |}
        ) => {
          await onSendMessage({
            aiRequestId,
            userMessage: '',
            createdProject: options.createdProject,
            createdSceneNames: options.createdSceneNames,
            createdExternalLayoutNames: options.createdExternalLayoutNames,
            editorFunctionCallResults,
          });
        },
        [onSendMessage]
      );

      /**
       * Collect all AI requests to process: the selected request, and all sub-agent requests.
       */
      const aiRequestsToProcess = React.useMemo(
        () => {
          const result = [];
          if (selectedAiRequest) {
            result.push(selectedAiRequest);
          }
          const subAgentIds = Object.keys(activeSubAgents);
          for (const subAgentId of subAgentIds) {
            const subAgentRequest = aiRequests[subAgentId];
            if (subAgentRequest) {
              result.push(subAgentRequest);
            }
          }
          return result;
        },
        [selectedAiRequest, activeSubAgents, aiRequests]
      );

      const {
        onProcessFunctionCalls,
        clearApprovedEditBatches,
      } = useProcessFunctionCalls({
        project,
        fileMetadata,
        resourceManagementProps,
        editorCallbacks,
        aiRequestsToProcess,
        onSendEditorFunctionCallResults,
        getEditorFunctionCallResults,
        addEditorFunctionCallResults,
        onSceneEventsModifiedOutsideEditor,
        onInstancesModifiedOutsideEditor,
        onObjectsModifiedOutsideEditor,
        onEffectsModifiedOutsideEditor,
        onObjectGroupsModifiedOutsideEditor,
        onProjectItemRenamedOutsideEditor,
        onWillDeleteScene,
        onWillDeleteGameplayTest,
        onWillDeleteObject,
        eventsFunctionsExtensionsState,
        onExtensionsModifiedOutsideEditor,
        onWillDeleteExtensionItem,
        i18n,
        onWillInstallExtension,
        onExtensionInstalled,
        isReadyToProcessFunctionCalls,
        getIsAutoEditEnabled,
        suspendAiRequest,
        requestEditApproval,
        onSaveProjectAsWithStorageProvider,
      });

      // Wrap onProcessFunctionCalls to bind the selected AI request for the chat UI.
      const onProcessSelectedAiRequestFunctionCalls = React.useCallback(
        async (functionCalls: Array<AiRequestMessageAssistantFunctionCall>) => {
          if (!selectedAiRequest) return;
          await onProcessFunctionCalls(selectedAiRequest, functionCalls);
        },
        [selectedAiRequest, onProcessFunctionCalls]
      );

      React.useEffect(() => {
        setIsReadyToProcessFunctionCalls(true);
      }, []);

      const onStartOrOpenChat = React.useCallback(
        (
          options: ?{|
            aiRequestId: string | null,
          |}
        ) => {
          if (!options) return;
          const { aiRequestId } = options;
          const selectAiRequest = () => {
            // A BYOK chat id selects the BYOK chat (its record lives in the
            // local store, not in AiRequestContext). A persisted-but-not-
            // yet-loaded chat (opened from the Recents rail, Phase 13.1) is
            // loaded from the durable store first — the selection happens
            // when the load finishes (openSavedByokChat reattaches and
            // selects it).
            if (isByokAiRequestId(aiRequestId)) {
              setSelectedAiRequestId(null);
              if (aiRequestId && getByokChat(aiRequestId)) {
                setSelectedByokChatId(aiRequestId);
                return;
              }
              if (aiRequestId) {
                void byokChatSeam.openSavedByokChat(aiRequestId);
              }
              return;
            }
            setSelectedByokChatId(null);
            setSelectedAiRequestId(aiRequestId);
          };
          // When navigating away from a working request, ask the user to confirm
          // stopping it (or to cancel). Unlike closing the editor, we do NOT
          // offer to keep it running in the background here: a request you have
          // navigated away from while opening another chat would be confusing.
          // (BYOK chats are covered too: they report work in progress the same
          // way, and suspending them is a local operation.)
          const currentlySelectedRequest =
            selectedByokChat || selectedAiRequest;
          if (
            currentlySelectedRequest &&
            aiRequestId !== currentlySelectedRequest.id
          ) {
            // upToDateConfirmStopping is declared below this callback, but it is
            // only ever called at event-handler time (post-render), so it is
            // always initialised by the time this runs.
            // eslint-disable-next-line no-use-before-define
            upToDateConfirmStopping
              .current({
                title: t`Open another chat?`,
                message: t`The AI is currently working on your project. Opening another chat will stop it. Do you want to continue?`,
              })
              .then(shouldProceed => {
                if (shouldProceed) selectAiRequest();
              });
            return;
          }
          selectAiRequest();
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [setSelectedAiRequestId, selectedAiRequest, selectedByokChat]
      );
      // Start a new chat with a pre-filled user request, when asked from
      // elsewhere in the editor ("Edit with AI" buttons...).
      React.useEffect(
        () =>
          registerAskAiPrefillListener(({ userRequestText, inCurrentChat }) => {
            const aiRequestId =
              inCurrentChat && selectedAiRequest ? selectedAiRequest.id : null;
            if (!aiRequestId) onStartOrOpenChat({ aiRequestId: null });
            if (aiRequestChatRef.current) {
              aiRequestChatRef.current.setUserInput(
                aiRequestId,
                userRequestText
              );
            }
          }),
        [onStartOrOpenChat, selectedAiRequest]
      );

      const onStartNewChat = React.useCallback(
        () => {
          onStartOrOpenChat({
            aiRequestId: null,
          });
        },
        [onStartOrOpenChat]
      );

      const updateToolbar = React.useCallback(
        () => {
          // $FlowFixMe[constant-condition]
          if (setToolbar) {
            setToolbar(
              <Toolbar
                isHistoryOpen={isHistoryOpen}
                onToggleHistory={onToggleHistory}
                onStartNewChat={onStartNewChat}
                canStartNewChat={canStartNewChat}
                showNewChatButton={
                  !(historyLayout === 'side-panel' && isHistoryOpen)
                }
              />
            );
          }
        },
        [
          setToolbar,
          isHistoryOpen,
          onToggleHistory,
          onStartNewChat,
          canStartNewChat,
          historyLayout,
        ]
      );

      React.useEffect(updateToolbar, [updateToolbar]);

      // $FlowFixMe[incompatible-type]
      React.useImperativeHandle(ref, () => ({
        getProject: noop,
        updateToolbar,
        forceUpdateEditor: noop,
        onEventsBasedObjectChildrenEdited: noop,
        onSceneObjectEdited: noop,
        onSceneObjectsDeleted: noop,
        onSceneEventsModifiedOutsideEditor: noop,
        onInstancesModifiedOutsideEditor: noop,
        onObjectsModifiedOutsideEditor: noop,
        onEffectsModifiedOutsideEditor: noop,
        onObjectGroupsModifiedOutsideEditor: noop,
        onWillDeleteObject: noop,
        onExtensionsModifiedOutsideEditor: noop,
        selectAllInsideEditor: noop,
        startOrOpenChat: onStartOrOpenChat,
        notifyChangesToInGameEditor: setEditorHotReloadNeeded,
        switchInGameEditorIfNoHotReloadIsNeeded: noop,
        requestClose,
      }));

      const onSendFeedback = React.useCallback(
        async (
          // $FlowFixMe[missing-local-annot]
          aiRequestId,
          // $FlowFixMe[missing-local-annot]
          messageIndex,
          // $FlowFixMe[missing-local-annot]
          feedback,
          // $FlowFixMe[missing-local-annot]
          reason,
          // $FlowFixMe[missing-local-annot]
          freeFormDetails
        ) => {
          if (!profile) return;
          try {
            await retryIfFailed({ times: 2 }, () =>
              sendAiRequestFeedback(getAuthorizationHeader, {
                userId: profile.id,
                aiRequestId,
                messageIndex,
                feedback,
                reason,
                freeFormDetails,
              })
            );
          } catch (error) {
            console.error('Error sending feedback: ', error);
          }
        },
        [getAuthorizationHeader, profile]
      );

      // (The exported module-scope `onSendByokNoopFeedback` replaces the
      // old per-render no-op handler: BYOK chats no longer receive a
      // feedback callback at all — the buttons are hidden instead.)

      const getHasWorkInProgress = React.useCallback(
        () => {
          // BYOK chats are checked like server ones (their "work in progress"
          // lives in the local store record).
          const requestToCheck = selectedByokChat || selectedAiRequest;
          if (!requestToCheck) return false;
          const editorFunctionCallResultsForRequest =
            getEditorFunctionCallResults(requestToCheck.id) || [];
          return aiRequestHasWorkInProgress(
            requestToCheck,
            editorFunctionCallResultsForRequest
          );
        },
        [selectedAiRequest, selectedByokChat, getEditorFunctionCallResults]
      );

      const onStop = React.useCallback(
        async () => {
          const requestToStop = selectedByokChat || selectedAiRequest;
          if (!requestToStop) return;
          if (!getHasWorkInProgress()) return;
          // Delegates to the container-level suspend, which routes BYOK chats
          // to their orchestrator and server chats to the provider.
          await suspendAiRequestWithByokSupport(requestToStop.id);
        },
        [
          selectedAiRequest,
          selectedByokChat,
          getHasWorkInProgress,
          suspendAiRequestWithByokSupport,
        ]
      );

      const upToDateOnStop = useStableUpToDateRef(onStop);

      // Shared confirmation used whenever the user leaves a working AI request —
      // either by closing the editor or by opening another chat. Asks whether
      // the AI should keep working in the background, be stopped, or whether the
      // action should be cancelled. Returns true if the caller should proceed
      // (and suspends the request when the user chose "Stop working"). This is
      // the only place, besides the "Stop" button, that suspends a request.
      const confirmLeavingWorkingRequest = React.useCallback(
        async ({
          title,
          message,
        }: {|
          title: MessageDescriptor,
          message: MessageDescriptor,
        |}): Promise<boolean> => {
          if (pendingEditApproval) {
            // Paused on an inline edit approval (not actively working): leaving
            // refuses the pending change, which suspends the request. Don't show
            // the "is working" prompt.
            resolveEditApproval(false);
            return true;
          }
          if (!getHasWorkInProgress()) return true;
          const answer = await showYesNoCancel({
            title,
            message,
            // Primary action (right): keep the request running. Shorter labels
            // on mobile so the three buttons don't wrap onto two lines.
            yesButtonLabel: isMobile ? t`Continue` : t`Continue working`,
            // Secondary action (right): stop the request, then proceed.
            noButtonLabel: isMobile ? t`Stop` : t`Stop working`,
            // Left action: do not proceed.
            cancelButtonLabel: t`Cancel`,
          });
          // showYesNoCancel resolves with 0 (yes), 1 (no) or 2 (cancel).
          // $FlowFixMe[invalid-compare] - resolves to a number, not a boolean.
          if (answer === 2) {
            // Cancel: do nothing, keep the request and the editor as-is.
            return false;
          }
          // $FlowFixMe[invalid-compare] - resolves to a number, not a boolean.
          if (answer === 1) {
            // Stop working: suspend the request, then allow the action.
            await upToDateOnStop.current();
          }
          // Continue working (0): proceed without suspending — the request keeps
          // running in the background.
          return true;
        },
        [
          pendingEditApproval,
          resolveEditApproval,
          getHasWorkInProgress,
          showYesNoCancel,
          upToDateOnStop,
          isMobile,
        ]
      );

      // Called when the AI editor is about to be closed by an explicit user
      // action (see AskAiEditorInterface.requestClose).
      const requestClose = React.useCallback(
        (): Promise<boolean> =>
          confirmLeavingWorkingRequest({
            title: t`Close the AI chat?`,
            message: t`The AI is currently working on your project. Should it continue working while the tab is closed?`,
          }),
        [confirmLeavingWorkingRequest]
      );

      // Used when leaving a working request in a context where keeping it
      // running in the background would be confusing (opening another chat, or
      // closing the project that the AI is working on). Only offers to stop the
      // request or cancel. Returns true if the action should proceed.
      const confirmStoppingWorkingRequest = React.useCallback(
        async ({
          title,
          message,
        }: {|
          title: MessageDescriptor,
          message: MessageDescriptor,
        |}): Promise<boolean> => {
          if (pendingEditApproval) {
            // Paused on an inline edit approval (not actively working): leaving
            // refuses the pending change, which suspends the request. Don't show
            // the "is working" prompt.
            resolveEditApproval(false);
            return true;
          }
          if (!getHasWorkInProgress()) return true;
          const shouldStop = await showConfirmation({
            title,
            message,
            confirmButtonLabel: t`Stop working`,
            dismissButtonLabel: t`Cancel`,
          });
          if (!shouldStop) return false;
          await upToDateOnStop.current();
          return true;
        },
        [
          pendingEditApproval,
          resolveEditApproval,
          getHasWorkInProgress,
          showConfirmation,
          upToDateOnStop,
        ]
      );
      const upToDateConfirmStopping = useStableUpToDateRef(
        confirmStoppingWorkingRequest
      );

      // Do a full fetch when the tab is opened to ensure the UI starts with
      // up-to-date server state (e.g. request may have been suspended while
      // the tab was closed).
      React.useEffect(
        () => {
          if (!selectedAiRequest || !profile) return;
          retryIfFailed({ times: 2 }, () =>
            getAiRequest(getAuthorizationHeader, {
              userId: profile.id,
              aiRequestId: selectedAiRequest.id,
            })
          )
            .then(aiRequest => {
              updateAiRequest(aiRequest.id, () => aiRequest);
            })
            .catch(error => {
              console.warn('Error fetching AI request on tab open:', error);
            });
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        []
      );

      // NB: the AI request is intentionally NOT suspended on unmount. Suspending
      // only happens through explicit user actions — the "Stop" button or
      // requestClose() (tab/pane/drawer/project close) — so unmounting for any
      // other reason (repositioning the tab, switching between the mobile and
      // desktop layouts, re-rendering...) never stops a running request.

      // Restore a BYOK chat to one of its local pre-message snapshots:
      // confirm, overwrite the project in place, then fork the transcript
      // up to (excluding) the restored message — the mirror of the server
      // flow's restore + fork, with the snapshot store instead of the
      // cloud versions.
      const onRestoreByokChat = React.useCallback(
        async ({
          message,
          aiRequest,
        }: {|
          message: AiRequestMessage,
          aiRequest: AiRequest,
        |}) => {
          if (message.type !== 'message' || message.role !== 'user') {
            await showAlert({
              title: t`No project save available`,
              message: t`No project save is available for this request message.`,
            });
            return;
          }
          // Never restore under a live loop (audit011026 B-UI-7): the
          // in-place unserializeFrom would rewrite the project under the
          // running orchestrator's feet (stale wrappers, edits landing on
          // the wrong state) — the same suspend-first rule as archiving.
          if (aiRequest.status === 'working') {
            await showAlert({
              title: t`Chat is still working`,
              message: t`Stop or wait for the current AI turn to finish before restoring an earlier save.`,
            });
            return;
          }
          const messageId = ((message: any).messageId: ?string);
          const snapshot = messageId
            ? getByokProjectSnapshot(aiRequest.id, messageId)
            : null;
          if (!snapshot) {
            await showAlert({
              title: t`No project save available`,
              message: t`No project save is available for this request message.`,
            });
            return;
          }
          const liveProject = byokChatSeam.getByokLiveProject();
          if (!liveProject) {
            await showAlert({
              title: t`Cannot restore project`,
              message: t`Open the project associated with this AI request to restore to this state.`,
            });
            return;
          }

          const result = await showConfirmation({
            title: t`Restore project to this state?`,
            message: t`Are you sure you want to restore the project to the state saved at this point in the AI conversation? This will overwrite the current project state.`,
            confirmButtonLabel: t`Restore`,
            dismissButtonLabel: t`Cancel`,
            level: 'warning',
          });
          if (!result) return;

          try {
            restoreByokProjectFromSnapshot(liveProject, snapshot);
          } catch (error) {
            console.error('Error while restoring a BYOK snapshot:', error);
            await showAlert({
              title: t`Error`,
              message: t`An error occurred while restoring the project version: ${
                error.message
              }`,
            });
            return;
          }
          triggerUnsavedChanges();

          // Continue the conversation from before the restored message:
          // fork the transcript up to the message preceding it.
          const output = aiRequest.output || [];
          const messageIndex = output.findIndex(
            item => item.messageId === messageId
          );
          const previousMessage =
            messageIndex > 0 ? output[messageIndex - 1] : null;
          if (previousMessage && previousMessage.messageId) {
            const fork = forkByokChat(
              aiRequest.id,
              ((previousMessage.messageId: any): string)
            );
            if (fork) {
              onStartOrOpenChat({ aiRequestId: fork.id });
              return;
            }
          }
          onStartOrOpenChat({ aiRequestId: null });
        },
        [
          showAlert,
          showConfirmation,
          triggerUnsavedChanges,
          byokChatSeam,
          onStartOrOpenChat,
        ]
      );

      const onRestore = React.useCallback(
        async ({
          message,
          aiRequest,
        }: {|
          message: AiRequestMessage,
          aiRequest: AiRequest,
        |}) => {
          // BYOK chats restore from the LOCAL pre-message snapshots
          // (Phase 8.6) — no cloud version, no server fork.
          if (isByokAiRequestId(aiRequest.id)) {
            await onRestoreByokChat({ message, aiRequest });
            return;
          }
          if (!profile) return;
          const cloudProjectId = storageProvider
            ? getCloudProjectFileMetadataIdentifier(
                storageProvider.internalName,
                fileMetadata
              )
            : null;

          if (!project || !cloudProjectId) {
            await showAlert({
              title: t`Cannot restore project`,
              message: t`Open the project associated with this AI request to restore to this state.`,
            });
            return;
          }
          if (project.getProjectUuid() !== aiRequest.gameId) {
            await showAlert({
              title: t`Project mismatch`,
              message: t`The project associated with this AI request does not match the current project. Open the correct project to restore to this state.`,
            });
            return;
          }

          let projectVersionId: ?string;
          let forkToMessageId: ?string;
          if (message.type === 'message' && message.role === 'user') {
            projectVersionId = message.projectVersionIdBeforeMessage;
            // For user messages, we fork up to the previous message.
            const messages = aiRequest.output || [];
            const messageIndex = messages.findIndex(
              msg => msg.messageId === message.messageId
            );
            if (messageIndex > 0) {
              const previousMessage = messages[messageIndex - 1];
              forkToMessageId = previousMessage.messageId;
            }
          }
          if (
            message.type === 'function_call_output' ||
            message.role === 'assistant'
          ) {
            // For assistant messages, we fork up to this message.
            projectVersionId = message.projectVersionIdAfterMessage;
            forkToMessageId = message.messageId;
          }

          if (!projectVersionId) {
            await showAlert({
              title: t`No project save available`,
              message: t`No project save is available for this request message.`,
            });
            return;
          }

          let projectSave;
          try {
            projectSave = await getOrLoadProjectVersion(projectVersionId);
          } catch (error) {
            const extractedStatusAndCode = extractGDevelopApiErrorStatusAndCode(
              error
            );
            let title = t`Project save cannot be opened`;
            let message = t`An error occurred while fetching the project version, try again later.`;
            let type = 'alert';
            if (
              extractedStatusAndCode &&
              extractedStatusAndCode.status === 404
            ) {
              title = t`Project save not found`;
              message = t`The project save associated with this AI request message was not found. It may have been deleted.`;
            }
            if (
              extractedStatusAndCode &&
              extractedStatusAndCode.status === 403 &&
              extractedStatusAndCode.code ===
                'project-version/cannot-access-project'
            ) {
              title = t`Cannot access project save`;
              message = t`You do not have permission to access the project save associated with this AI request message.`;
            }
            if (
              extractedStatusAndCode &&
              extractedStatusAndCode.status === 403 &&
              extractedStatusAndCode.code ===
                'project-version/no-history-access'
            ) {
              title = t`No access to project save`;
              message = t`You do not have access to project saves with your current subscription plan. Please upgrade your plan to access this feature.`;
              type = 'confirmation';
            }
            if (
              extractedStatusAndCode &&
              extractedStatusAndCode.status === 403 &&
              extractedStatusAndCode.code ===
                'project-version/version-outside-retention'
            ) {
              title = t`Project save not available`;
              message = t`The project save associated with this AI request message is no longer available due to your current plan's limit. Upgrade your subscription to access older project saves.`;
              type = 'confirmation';
            }

            if (type === 'alert') {
              await showAlert({
                title,
                message,
              });
              return;
            }

            if (type === 'confirmation') {
              const answer = await showConfirmation({
                title,
                message,
                confirmButtonLabel: t`See plans`,
                dismissButtonLabel: t`Cancel`,
              });
              if (answer) {
                openSubscriptionDialog({
                  analyticsMetadata: {
                    reason: 'AI requests history',
                    recommendedPlanId: hasValidSubscriptionPlan()
                      ? 'gdevelop_startup'
                      : 'gdevelop_gold',
                    placementId: 'ai-requests',
                  },
                });
              }
              return;
            }
          }

          if (!projectSave) {
            await showAlert({
              title: t`No project save available`,
              message: t`No project save is available for this request message.`,
            });
            return;
          }

          const result = await showConfirmation({
            title: t`Restore project to this state?`,
            message: t`Are you sure you want to restore the project to the state saved at this point in the AI conversation? This will overwrite the current project state.`,
            confirmButtonLabel: t`Restore`,
            dismissButtonLabel: t`Cancel`,
            level: 'warning',
          });
          if (!result) return;

          // Check if this is the last message with a save in the conversation
          // Find the last message that has a projectVersionIdAfterMessage
          let lastMessageWithSave = null;
          const outputMessages = aiRequest.output || [];
          for (let i = outputMessages.length - 1; i >= 0; i--) {
            const msg = outputMessages[i];
            if (
              (msg.type === 'function_call_output' ||
                (msg.type === 'message' && msg.role === 'assistant')) &&
              msg.projectVersionIdAfterMessage
            ) {
              lastMessageWithSave = msg;
              break;
            }
          }

          const isLastMessage =
            lastMessageWithSave &&
            lastMessageWithSave.messageId === forkToMessageId;

          if (forkToMessageId) {
            setForkingState({
              aiRequestId: aiRequest.id,
              messageId: forkToMessageId,
            });
          }

          try {
            const hasLoadSucceeded = await onCheckoutVersion(projectSave, {
              dontSaveCheckedOutVersionStatus: true,
            });

            if (hasLoadSucceeded && profile) {
              if (isLastMessage) {
                // This is the last message, no need to fork, just stay on the current request.
                setForkingState(null);
              } else if (!forkToMessageId) {
                // No message to fork to, we probably restored at the beginning of the conversation,
                // so let's just open a new chat.
                setForkingState(null);
                onStartOrOpenChat({ aiRequestId: null });
              } else {
                // Fork the AI request to create a new conversation
                try {
                  const forkedAiRequest: AiRequest = await retryIfFailed(
                    { times: 2 },
                    () =>
                      forkAiRequest(getAuthorizationHeader, {
                        userId: profile.id,
                        aiRequestId: aiRequest.id,
                        upToMessageId: forkToMessageId || undefined,
                      })
                  );
                  updateAiRequest(forkedAiRequest.id, () => forkedAiRequest);

                  // Open the new forked AI request
                  onStartOrOpenChat({ aiRequestId: forkedAiRequest.id });
                } catch (forkError) {
                  console.error(
                    'An error occurred while forking AI request:',
                    forkError
                  );
                  setForkingState(null);
                  // Don't show an error to the user since the restore succeeded
                  // The fork is a nice-to-have feature
                }
              }
            } else {
              setForkingState(null);
            }
          } catch (error) {
            console.error(
              'An error occurred while restoring project version:',
              error
            );
            setForkingState(null);
            await showAlert({
              title: t`Error`,
              message: t`An error occurred while restoring the project version: ${
                error.message
              }`,
            });
          }
        },
        [
          project,
          showAlert,
          showConfirmation,
          onRestoreByokChat,
          onCheckoutVersion,
          getOrLoadProjectVersion,
          profile,
          getAuthorizationHeader,
          updateAiRequest,
          onStartOrOpenChat,
          setForkingState,
          storageProvider,
          fileMetadata,
          openSubscriptionDialog,
        ]
      );

      return (
        <div style={styles.container}>
          <AskAiHistory
            layout={historyLayout}
            open={isHistoryOpen}
            onClose={onCloseHistory}
            onOpenAiRequest={aiRequestId => {
              onStartOrOpenChat({ aiRequestId });
            }}
            onStartNewChat={onStartNewChat}
            canStartNewChat={canStartNewChat}
            // A selected BYOK chat highlights its own entry (the server id
            // is null then).
            selectedAiRequestId={selectedByokChatId || selectedAiRequestId}
            // The Recents rail's BYOK section (Phase 13.1): the durable
            // chats with their inline actions, above the hosted list — only
            // while BYOK routing is on.
            {...(byokChatSeam.byokToggleState.isEnabled
              ? {
                  byokChatSummaries: byokChatSeam.byokHistoryChats,
                  onArchiveByokChat: onArchiveByokChat,
                  onSetByokChatArchived:
                    byokChatSeam.setByokHistoryChatArchived,
                  onDeleteByokChat: byokChatSeam.deleteByokHistoryChat,
                  onRenameByokChat: byokChatSeam.renameByokHistoryChat,
                }
              : {})}
          />
          <Paper square background="dark" style={styles.paper}>
            <div style={styles.chatContainer}>
              <AiRequestChat
                aiConfigurationPresetsWithAvailability={getAiConfigurationPresetsWithAvailability(
                  { limits, getAiSettings }
                )}
                project={project}
                fileMetadata={fileMetadata}
                ref={aiRequestChatRef}
                aiRequest={selectedByokChat || selectedAiRequest}
                // The selected chat was opened from the history, which only
                // has its summary: its conversation is being loaded.
                aiRequestLoadingState={
                  selectedAiRequestId && !selectedAiRequest
                    ? aiRequestLoadingStates[selectedAiRequestId] || {
                        isLoading: true,
                        error: null,
                      }
                    : null
                }
                onRetryLoadingAiRequest={() => {
                  if (selectedAiRequestId) loadAiRequest(selectedAiRequestId);
                }}
                onStartNewAiRequest={startNewAiRequest}
                onSendUserMessage={async ({
                  userMessage,
                  byokImageIds,
                  attachmentIds,
                }: {|
                  userMessage: string,
                  byokImageIds?: Array<string>,
                  attachmentIds: Array<string>,
                |}) => {
                  const chatAiRequestId =
                    selectedByokChatId || selectedAiRequestId;
                  if (!chatAiRequestId) return;
                  await onSendMessage({
                    aiRequestId: chatAiRequestId,
                    userMessage,
                    byokImageIds,
                    attachmentIds,
                    editorFunctionCallResults:
                      getEditorFunctionCallResults(chatAiRequestId) || [],
                  });
                }}
                onRetryAfterError={
                  selectedByokChat ? onRetryByokChat : onRetryAfterError
                }
                onIsAutoEditEnabledChange={enabled => {
                  isAutoEditEnabledRef.current = enabled;
                  // Toggling auto-edit revokes any blanket approvals already
                  // granted in the current sub-agent batch, so turning it on
                  // then off again re-prompts for the upcoming edits.
                  clearApprovedEditBatches();
                  clearApprovedByokEditCallIds();
                }}
                pendingEditApproval={pendingEditApproval}
                onResolveEditApproval={resolveEditApproval}
                isSending={isSendingAiRequest(
                  selectedByokChatId || selectedAiRequestId
                )}
                isSendingUserMessage={isSendingUserMessage}
                lastSendError={getLastSendError(
                  selectedByokChatId || selectedAiRequestId
                )}
                quota={quota}
                increaseQuotaOffering={
                  !hasValidSubscriptionPlan(subscription)
                    ? 'subscribe'
                    : canUpgradeSubscription(subscription)
                    ? 'upgrade'
                    : 'none'
                }
                editorFunctionCallResults={
                  selectedByokChat
                    ? // BYOK tool executions are driven by the orchestrator;
                      // there are no per-request execution records to show.
                      null
                    : (selectedAiRequest &&
                        getEditorFunctionCallResults(selectedAiRequest.id)) ||
                      null
                }
                price={aiRequestPrice}
                availableCredits={availableCredits}
                isRefreshingLimits={isRefreshingLimits}
                {...(selectedByokChat
                  ? {
                      ...buildByokChatProps(),
                      // Tool outputs reference their captured screenshots by
                      // id: the chat renders them inline, so the user sees
                      // what the model was shown.
                      getToolResultImage: getByokToolResultImage,
                      // Phase 13.1: the header toggle and the bottom-bar
                      // controls (effort pill, model picker, attachments).
                      byokToggle: byokChatSeam.byokToggleState,
                      byokChatControls: byokChatSeam.byokChatControls,
                      // Phase 9.6: the thumbs are stored locally only.
                      onSendFeedback: byokChatSeam.onSendByokFeedback,
                    }
                  : {
                      // The header toggle is rendered on hosted chats too —
                      // it is how a user flips BYOK on from the chat panel.
                      byokToggle: byokChatSeam.byokToggleState,
                      // Feedback needs a server-side message to attach to,
                      // and manual tool-call processing is a no-op when the
                      // chat drives its own tools: both props are only
                      // passed for hosted chats, and the chat UI hides the
                      // corresponding affordances when they are absent.
                      onSendFeedback,
                      onProcessFunctionCalls: onProcessSelectedAiRequestFunctionCalls,
                    })}
                hasOpenedProject={!!project}
                onStop={onStop}
                i18n={i18n}
                editorCallbacks={editorCallbacks}
                onStartOrOpenChat={onStartOrOpenChat}
                isFetchingSuggestions={isFetchingSuggestions}
                savingProjectForMessageId={savingProjectForMessageId}
                forkingState={forkingState}
                onRestore={onRestore}
              />
            </div>
          </Paper>
        </div>
      );
    }
  ),
  // Prevent any update to the editor if the editor is not active,
  // and so not visible to the user.
  (prevProps, nextProps) => prevProps.isActive || nextProps.isActive
);

export const renderAskAiEditorContainer = (
  props: RenderEditorContainerPropsWithRef
): React.Node => (
  <I18n>
    {({ i18n }) => (
      // $FlowFixMe[incompatible-type]
      <AskAiEditor
        ref={props.ref}
        i18n={i18n}
        project={props.project}
        resourceManagementProps={props.resourceManagementProps}
        fileMetadata={props.fileMetadata}
        storageProvider={props.storageProvider}
        setToolbar={props.setToolbar}
        isActive={props.isActive}
        paneIdentifier={props.paneIdentifier}
        onCreateProjectFromExample={props.onCreateProjectFromExample}
        onCreateEmptyProject={props.onCreateEmptyProject}
        onOpenLayout={props.onOpenLayout}
        onOpenExternalLayout={props.onOpenExternalLayout}
        onSceneEventsModifiedOutsideEditor={
          props.onSceneEventsModifiedOutsideEditor
        }
        onInstancesModifiedOutsideEditor={
          props.onInstancesModifiedOutsideEditor
        }
        onObjectsModifiedOutsideEditor={props.onObjectsModifiedOutsideEditor}
        onEffectsModifiedOutsideEditor={props.onEffectAdded}
        onObjectGroupsModifiedOutsideEditor={
          props.onObjectGroupsModifiedOutsideEditor
        }
        onProjectItemRenamedOutsideEditor={
          props.onProjectItemRenamedOutsideEditor
        }
        onWillDeleteScene={props.onWillDeleteScene}
        onWillDeleteGameplayTest={props.onWillDeleteGameplayTest}
        onWillDeleteObject={props.onWillDeleteObject}
        onExtensionsModifiedOutsideEditor={
          props.onExtensionsModifiedOutsideEditor
        }
        onWillDeleteExtensionItem={props.onWillDeleteExtensionItem}
        onOpenEventsFunctionsExtension={props.onOpenEventsFunctionsExtension}
        // The variant editor opener also reloads the extensions before opening,
        // which is what a link to a just-created custom object needs.
        onOpenCustomObjectEditor={props.onOpenEventBasedObjectVariantEditor}
        onWillInstallExtension={props.onWillInstallExtension}
        onExtensionInstalled={props.onExtensionInstalled}
        onOpenAskAi={props.onOpenAskAi}
        gameEditorMode={props.gameEditorMode}
        continueProcessingFunctionCallsOnMount={
          props.extraEditorProps
            ? props.extraEditorProps.continueProcessingFunctionCallsOnMount
            : false
        }
        onCheckoutVersion={props.onCheckoutVersion}
        getOrLoadProjectVersion={props.getOrLoadProjectVersion}
        onSave={props.onSave}
        onSaveProjectAsWithStorageProvider={
          props.onSaveProjectAsWithStorageProvider
        }
      />
    )}
  </I18n>
);
