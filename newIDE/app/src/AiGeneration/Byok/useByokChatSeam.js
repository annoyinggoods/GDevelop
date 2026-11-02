// @flow
import * as React from 'react';
import { type I18n as I18nType } from '@lingui/core';
import { t } from '@lingui/macro';
import {
  type AiRequest,
  getAiRequestSummary,
} from '../../Utils/GDevelopServices/Generation';
import {
  archiveByokChat,
  createByokChat,
  deleteByokChat,
  deleteByokOrchestrator,
  deleteByokUsageTracker,
  flushByokChatPersistence,
  getByokChat,
  getByokChatPersistence,
  getByokUsageTracker,
  getByokOrchestrator,
  listAllByokChats,
  listByokChats,
  restoreByokChat,
  setByokChatPersistence,
  setByokOrchestrator,
  byokReattachChat,
  setByokUsageTracker,
  subscribeByokChats,
  updateByokChat,
} from './ByokChatStore';
import {
  createByokOrchestrator,
  type ByokOrchestrator,
} from './ByokOrchestrator';
import { createByokUsageTracker } from './ByokUsageTracker';
import { createByokSubAgentRunner } from './ByokSubAgents';
import { dropByokChatSnapshots } from './ByokFork';
import { loadByokKey, type ByokKeyLoadResult } from './ByokKeyStorage';
import { getByokImage } from './ByokImageContent';
import { createByokChatFileStore } from './ByokChatPersistence';
import { createByokChatFilesBackendForPlatform } from './ByokChatStorageBackends';
import {
  loadByokProjectNotes,
  makeByokProjectNotesIdentifierFromProjectName,
} from './ByokProjectNotes';
import { getByokSkills } from './ByokSkills';
import {
  BYOK_GLOBAL_TURN_BUDGET,
  getByokSettings,
  type ByokSettings,
  type ByokSharedTurnBudget,
} from './ByokTypes';
import {
  patchByokCapabilityRecord,
  makeByokCapabilityTargetKey,
} from './ByokCapabilities';
import {
  getByokChatModelSelection,
  getByokEffortOptions,
  listByokModelChoices,
  resolveByokModelTarget,
  setByokChatModelSelection,
  type ByokModelChoice,
} from './ByokModelRouter';
import {
  attachByokSuggestions,
  fetchByokSuggestions,
  recordByokFeedback,
} from './ByokSuggestions';
import { sendByokChatCompletionWithRetries } from './ByokClient';
import { getCachedByokModels, refreshByokModels } from './ByokModelsCache';
import { setByokRagSettingsProvider } from './Rag/ByokRagSearch';
import { getByokRagSettings } from './Rag/ByokRagTypes';
import {
  APPROVED_CALL_IDS_CAPACITY,
  byokCallRequiresApproval,
  createByokEditorFunctionCallExecutor,
  isByokAiRequestId,
  shouldUseByokForNewRequest,
} from './ByokSeam';
import {
  findByNameokExtraTool,
  type ByokExtraToolCollaborators,
} from './ByokExtraTools';
import { flushByokExtensionRegeneration } from './ByokExtensionTools';
import { runExclusiveByokProjectMutation } from './ByokMutationLock';
import { makeDefaultByokImageStore } from './ByokImageContent';
import {
  getByokMcpToolHost,
  makeByokMcpToolHost,
  setByokMcpToolHost,
} from './Mcp/ByokMcpToolHost';
import {
  findLargestVisibleSceneCanvas,
  invokeByokPreviewCapture,
} from './ByokRuntimeTools';
import { useEnsureExtensionInstalled } from '../UseEnsureExtensionInstalled';
import { makeSimplifiedProjectBuilder } from '../../EditorFunctions/SimplifiedProject/SimplifiedProject';
import { useStableUpToDateRef } from '../../Utils/UseStableUpToDateCallback';
import EventsFunctionsExtensionsContext from '../../EventsFunctionsExtensionsLoader/EventsFunctionsExtensionsContext';
import optionalRequire from '../../Utils/OptionalRequire';
import { openFilePicker } from '../../Utils/FileSystem';
import {
  readByokImageAttachment,
  readByokTextAttachment,
  type ByokAttachmentReadResult,
} from './ByokAttachments';

const fs = optionalRequire('fs');

/**
 * The container's BYOK seam (the D8 refactor, scheduled by `Phase8.md` step
 * 8.0): everything a host component needs to run BYOK chats — selection,
 * history summaries, the executor, the orchestrators and their lifecycle —
 * extracted verbatim from `AskAiEditorContainer`, which now keeps a single
 * hook call. `AskAiStandAloneForm` reuses the same hook (Phase 8 step 8.5),
 * which is what makes the homepage "make me a game" flow a BYOK chat.
 *
 * The hook owns no rendering. Everything host-specific (the chat input ref,
 * the edit-approval row, unsaved-changes, scene opening) arrives as options.
 */

const gd: libGDevelop = global.gd;

/** The key of a provider slot, for the orchestrator's key resolution. */
const getByokApiKeyForProvider = async (keyRef: string): Promise<string> => {
  const storedKey = await loadByokKey(keyRef);
  return storedKey.status === 'ok' ? storedKey.key : '';
};

// Reducer of the "BYOK chats changed" force-update signal: its state is
// never read, the dispatch only exists to re-render the host when the BYOK
// chat store notifies (the explicit `void` action pins the reducer's action
// type for Flow).
const byokChatsForceUpdateReducer = (count: number, action: void): number =>
  count + 1;

export type ByokChatSeamOptions = {|
  preferencesValues: { +byok?: ?ByokSettings, ... },
  project: ?any,
  fileMetadata: ?{ +fileIdentifier?: ?string, ... },
  i18n: I18nType,
  editorCallbacks: any,
  // The tool runner and the registries, injected (not imported) so the hook
  // stays testable without pulling the whole editor registry.
  processEditorFunctionCalls: (options: any) => Promise<any>,
  editorFunctions: {|
    +[string]: ?{
      +modifiesProject?: ?boolean,
      +getModifiesProject?: ?(args: any) => boolean,
      ...
    },
  |},
  editorFunctionsWithoutProject: {|
    +[string]: ?{
      +modifiesProject?: ?boolean,
      +getModifiesProject?: ?(args: any) => boolean,
      ...
    },
  |},
  // Host callbacks (the same ones useProcessFunctionCalls and the render
  // layer already receive in the container).
  onSceneEventsModifiedOutsideEditor: (changes: any) => void,
  onInstancesModifiedOutsideEditor: (changes: any) => void,
  onExternalLayoutModifiedOutsideEditor: (changes: any) => void,
  onExternalEventsModifiedOutsideEditor: (changes: any) => void,
  onObjectsModifiedOutsideEditor: (changes: any) => void,
  onObjectGroupsModifiedOutsideEditor: (changes: any) => void,
  onProjectItemRenamedOutsideEditor: (changes: any) => void,
  onWillDeleteScene: (changes: any) => Promise<void>,
  onWillDeleteGameplayTest: (changes: any) => Promise<void>,
  onWillDeleteObject: (changes: any) => void,
  onWillInstallExtension: (extensionNames: Array<string>) => void,
  onExtensionInstalled: (extensionNames: Array<string>) => void,
  getIsAutoEditEnabled: () => boolean,
  // The label is a React.Node: it renders the same way the hosted flow's
  // edit-approval row does (see EditApprovalRequest in AiGeneration/Utils).
  requestEditApproval: (options: {|
    aiRequestId: string,
    callIds: Array<string>,
    label: React.Node,
  |}) => Promise<boolean>,
  triggerUnsavedChanges: () => void,
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
  setSelectedAiRequestId: (aiRequestId: string | null) => void,
  // The host's chat-input ref, wrapped: both chat-start and user-message
  // send reset the input (the same dual resetUserInput('' | chatId) calls
  // the container used to make).
  resetChatUserInputs: (chatId: string) => void,
  // The preview launcher MainFrame registered (perception tools). Absent in
  // hosts without previews (the tools answer with actionable failures).
  getProjectPreviewLauncher: () => ?any,
  // Writes the whole BYOK settings blob (capability records, per-chat
  // routing defaults read back live). Wired by the container to
  // setMultipleValues.
  updateByokPreferences: (byokSettings: ByokSettings) => void,
|};

/**
 * The bottom-bar controls of a BYOK chat (Phase 13.1): the effort pill and
 * the model picker data (D13-2), the token/turns row shown under the header
 * toggle, and the "+" attach handlers (D13-5). Null outside BYOK chats.
 */
export type ByokChatControlsState = {|
  chatId: string,
  providerModelLabel: string,
  usageTotals: ?{|
    promptTokens: number,
    completionTokens: number,
    totalTokens: number,
    turns: number,
  |},
  modelChoices: Array<ByokModelChoice>,
  selectedModelChoiceKey: string | null,
  effortOptions: Array<'low' | 'medium' | 'high'>,
  selectedEffort: string,
  onSelectModel: (choice: ByokModelChoice | null) => void,
  onSelectEffort: (effort: 'low' | 'medium' | 'high' | 'default') => void,
  // The "+" attach button (13.3): present only where a local file system
  // exists (the desktop app); the image entry additionally requires vision.
  canAttachFiles: boolean,
  canAttachImages: boolean,
  pickTextFile: () => Promise<ByokAttachmentReadResult>,
  pickImageFile: () => Promise<ByokAttachmentReadResult>,
|};

/**
 * The header's BYOK toggle (Phase 13.1, D13-4): green when routing is on,
 * red when off — flipping the same `enabled` setting the Preferences
 * checkbox drives (it routes new chats; an in-flight chat continues as
 * started).
 */
export type ByokToggleState = {|
  isEnabled: boolean,
  onToggle: (enabled: boolean) => void,
|};

export type ByokChatSeam = {|
  selectedByokChatId: string | null,
  setSelectedByokChatId: (chatId: string | null) => void,
  selectedByokChat: AiRequest | null,
  byokChatSummaries: Array<any>,
  onArchiveByokChat: (aiRequestId: string) => void,
  startByokChat: (
    userRequest: string,
    options?: {| onChatCreated?: (chatId: string) => void |}
  ) => Promise<void>,
  attachByokOrchestrator: (chat: AiRequest) => Promise<?ByokOrchestrator>,
  sendByokUserMessage: (
    aiRequestId: string,
    userMessage: string,
    byokImageIds?: Array<string>
  ) => Promise<void>,
  suspendByokChat: (aiRequestId: string) => void,
  suspendAiRequestWithByokSupport: (aiRequestId: string) => Promise<void>,
  clearApprovedByokEditCallIds: () => void,
  onRetryByokChat: () => Promise<void>,
  getByokLiveProject: () => ?any,
  // ---- Phase 13 ----
  // The header toggle (13.1): flips the global enabled setting, synced both
  // ways with the Preferences checkbox.
  byokToggleState: ByokToggleState,
  // The bottom-bar controls of the selected BYOK chat (13.1): effort pill +
  // model picker + token row + attach handlers. Null outside BYOK chats.
  byokChatControls: ByokChatControlsState | null,
  // The merged BYOK history for the Recents rail (13.1): the durable
  // persisted chats plus the in-session ones, with the rail's actions.
  byokHistoryChats: Array<any>,
  refreshByokHistoryChats: () => Promise<void>,
  setByokHistoryChatArchived: (
    aiRequestId: string,
    archived: boolean
  ) => Promise<void>,
  deleteByokHistoryChat: (aiRequestId: string) => Promise<void>,
  renameByokHistoryChat: (aiRequestId: string, title: string) => Promise<void>,
  // Local thumbs (9.6): stored in localStorage only.
  onSendByokFeedback: (
    aiRequestId: string,
    messageIndex: number,
    feedback: 'like' | 'dislike'
  ) => Promise<void>,
  // The history rail's "open" (13.1): load a saved chat into the session.
  openSavedByokChat: (chatId: string) => Promise<boolean>,
|};

/**
 * Run every BYOK chat of one host component (AskAiEditorContainer, and the
 * standalone form since Phase 8.5).
 */
export const useByokChatSeam = (options: ByokChatSeamOptions): ByokChatSeam => {
  const {
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
    resetChatUserInputs,
    getProjectPreviewLauncher,
    updateByokPreferences,
  } = options;

  // Selection is tracked locally: a BYOK chat must never enter
  // AiRequestContext, whose loading and polling effects target GDevelop's
  // servers.
  const [selectedByokChatId, setSelectedByokChatId] = React.useState<
    string | null
  >(null);
  // The extension reload hooks of the editor (Phase 8.4 regeneration).
  const eventsFunctionsExtensionsState = React.useContext(
    EventsFunctionsExtensionsContext
  );
  // The count is only read as the dependency of the BYOK history summaries
  // below: the dispatch exists to force a re-render when the BYOK store
  // changes.
  const [byokChatsUpdateCount, forceByokChatsUpdate] = React.useReducer(
    byokChatsForceUpdateReducer,
    0
  );
  React.useEffect(() => subscribeByokChats(forceByokChatsUpdate), [
    forceByokChatsUpdate,
  ]);
  // Live preferences for the getters pattern (routing, capabilities,
  // watchdog settings are read at turn time, never frozen at creation).
  const preferencesValuesRef = useStableUpToDateRef(preferencesValues);

  // ---- Durable history (Phase 9.3): install the platform file store once
  // per session and flush on app closure (best-effort). ----
  React.useEffect(() => {
    if (!getByokChatPersistence()) {
      const backend = createByokChatFilesBackendForPlatform();
      if (backend) {
        setByokChatPersistence(createByokChatFileStore(backend, getByokImage));
      }
    }
  }, []);

  // The RAG settings provider of the search runtime (audit011026 B-RAG-1):
  // after an app restart the persisted index is recovered lazily on the
  // first search_knowledge call — it needs the live RAG preferences, which
  // ride the same values object as the BYOK settings.
  React.useEffect(
    () => {
      setByokRagSettingsProvider(() =>
        getByokRagSettings((preferencesValuesRef.current: any))
      );
      return () => setByokRagSettingsProvider(null);
    },
    [preferencesValuesRef]
  );
  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onWindowHide = () => {
      void flushByokChatPersistence();
    };
    window.addEventListener('beforeunload', onWindowHide);
    window.addEventListener('pagehide', onWindowHide);
    return () => {
      window.removeEventListener('beforeunload', onWindowHide);
      window.removeEventListener('pagehide', onWindowHide);
      // A host unmounting is the last chance to flush in tests and in the
      // standalone form.
      void flushByokChatPersistence();
    };
  }, []);
  // The orchestrators live in the module-level registry (ByokChatStore):
  // a chat started by the homepage form keeps running when that form
  // unmounts and the Ask AI tab takes over (Phase 8.5).
  // BYOK counterpart of the server flow's approvedEditBatchKeys: once the
  // user approves a modifying call, a retry of the same batch does not
  // re-ask. Cleared when auto-edit is toggled (like the server's).
  const approvedByokEditCallIdsRef = React.useRef<Set<string>>(new Set());
  const clearApprovedByokEditCallIds = React.useCallback(() => {
    approvedByokEditCallIdsRef.current.clear();
  }, []);
  const selectedByokChat = selectedByokChatId
    ? getByokChat(selectedByokChatId)
    : null;

  // ---- Phase 9.4: the chat header's model/effort dropdowns ----
  // The model choices come from each provider's /models (fetched once per
  // provider set, cached), listed as `provider name/model name`.
  const [byokModelChoices, setByokModelChoices] = React.useState<
    Array<ByokModelChoice>
  >([]);
  const providersKey = (getByokSettings(preferencesValues).providers || [])
    .map(provider => provider.id)
    .join(',');
  React.useEffect(
    () => {
      let isSubscribed = true;
      const loadChoices = async (): Promise<void> => {
        const settings = getByokSettings(preferencesValues);
        const modelsByProviderId: { [providerId: string]: Array<string> } = {};
        // The legacy/global endpoint's cached models feed the fallback entry.
        const globalModels = getCachedByokModels(settings.endpointUrl);
        modelsByProviderId[''] = globalModels
          ? globalModels.map(model => model.id)
          : settings.modelName
          ? [settings.modelName]
          : [];
        for (const provider of settings.providers) {
          try {
            // Scoped by provider id: two providers can share one endpoint
            // URL with different keys and see different model lists
            // (audit100226 CACHE-4).
            const models = getCachedByokModels(
              provider.endpointUrl,
              provider.id
            );
            if (models) {
              modelsByProviderId[provider.id] = models.map(model => model.id);
              continue;
            }
            const storedKey = await loadByokKey(provider.keyRef);
            if (storedKey.status !== 'ok') continue;
            const fetched = await refreshByokModels(
              {
                baseUrl: provider.endpointUrl,
                apiKey: storedKey.key,
              },
              provider.id
            );
            modelsByProviderId[provider.id] = fetched.map(model => model.id);
          } catch (error) {
            // A provider that cannot be reached right now just contributes no
            // models; the next mount retries.
          }
        }
        if (isSubscribed) {
          setByokModelChoices(
            listByokModelChoices({ settings, modelsByProviderId })
          );
        }
      };
      loadChoices();
      return () => {
        isSubscribed = false;
      };
      // Reload when the provider set (or the endpoint) changes.
    },
    [providersKey, preferencesValues]
  );

  // The header's BYOK toggle (13.1): the same enabled setting the
  // Preferences checkbox drives, read live so both stay in sync.
  const byokToggleState = React.useMemo(
    (): ByokToggleState => ({
      isEnabled: shouldUseByokForNewRequest(preferencesValues),
      onToggle: (enabled: boolean) => {
        updateByokPreferences({
          ...getByokSettings(preferencesValuesRef.current || {}),
          enabled,
        });
      },
    }),
    [preferencesValues, preferencesValuesRef, updateByokPreferences]
  );

  // The bottom-bar controls of the selected BYOK chat (effort pill + model
  // picker + token row + attach handlers), or null outside BYOK chats.
  const byokChatControls = React.useMemo(
    (): ByokChatControlsState | null => {
      // byokChatsUpdateCount is the change signal (see the deps): the usage
      // totals move with every turn without being a data input.
      void byokChatsUpdateCount;
      const settings = getByokSettings(preferencesValues);
      const chat = selectedByokChat;
      if (!chat || !isByokAiRequestId(chat.id)) return null;

      const chatSelection = getByokChatModelSelection(chat);
      const target = resolveByokModelTarget({
        settings,
        chatSelection,
        callKind: 'main',
      });
      const provider = settings.providers.find(
        entry => entry.id === target.providerId
      );
      const providerName = provider ? provider.name : 'Default';
      const usageTracker = getByokUsageTracker(chat.id);
      const selectedProvider = settings.providers.find(
        entry => entry.id === (chatSelection ? chatSelection.providerId : '')
      );
      const endpointUrl = selectedProvider
        ? selectedProvider.endpointUrl
        : settings.endpointUrl;
      const modelName = target.modelName || settings.modelName;
      const capabilityRecord =
        (settings.capabilitiesByTargetKey || {})[
          makeByokCapabilityTargetKey(endpointUrl, modelName)
        ] || null;

      const pickTextFile = async (): Promise<ByokAttachmentReadResult> => {
        if (!fs) {
          return {
            ok: false,
            error: 'Attachments need the desktop app.',
          };
        }
        const filePath = await openFilePicker({
          title: 'Attach a text file',
          properties: ['openFile'],
          message: 'Pick a text file to attach to the message',
          filters: [
            {
              name: 'Text files',
              extensions: [
                'txt',
                'md',
                'json',
                'js',
                'ts',
                'csv',
                'log',
                'py',
                'xml',
                'yaml',
                'yml',
              ],
            },
          ],
        });
        if (!filePath || typeof filePath !== 'string') {
          return { ok: false, error: '' };
        }
        return readByokTextAttachment(fs, filePath);
      };
      const pickImageFile = async (): Promise<ByokAttachmentReadResult> => {
        if (!fs) {
          return {
            ok: false,
            error: 'Attachments need the desktop app.',
          };
        }
        const filePath = await openFilePicker({
          title: 'Attach an image',
          properties: ['openFile'],
          message: 'Pick a png, jpg or webp image to attach to the message',
          filters: [
            { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
          ],
        });
        if (!filePath || typeof filePath !== 'string') {
          return { ok: false, error: '' };
        }
        return readByokImageAttachment(
          fs,
          filePath,
          makeDefaultByokImageStore()
        );
      };

      return {
        chatId: chat.id,
        providerModelLabel: `${providerName}/${target.modelName ||
          settings.modelName}`,
        usageTotals: usageTracker ? usageTracker.getTotals() : null,
        modelChoices: byokModelChoices,
        selectedModelChoiceKey:
          chatSelection && chatSelection.modelName
            ? `${chatSelection.providerId}\u0000${chatSelection.modelName}`
            : null,
        effortOptions: getByokEffortOptions(capabilityRecord),
        selectedEffort: chatSelection
          ? chatSelection.reasoningEffort
          : settings.reasoningEffort,
        onSelectModel: (choice: ByokModelChoice | null) => {
          const currentChat = getByokChat(chat.id);
          if (!currentChat) return;
          setByokChatModelSelection(
            currentChat,
            choice
              ? {
                  providerId: choice.providerId,
                  modelName: choice.modelName,
                  reasoningEffort:
                    (chatSelection && chatSelection.reasoningEffort) ||
                    settings.reasoningEffort,
                }
              : null
          );
          updateByokChat(currentChat);
        },
        onSelectEffort: (effort: 'low' | 'medium' | 'high' | 'default') => {
          const currentChat = getByokChat(chat.id);
          if (!currentChat) return;
          const selection = getByokChatModelSelection(currentChat) || {
            // The RESOLVED target's provider, not '' (the global endpoint):
            // picking an effort on a chat that had no model selection
            // pinned the empty provider id, silently re-routing every
            // later call of that chat to the global endpoint with this
            // profile's model (audit 2026-10-02 UI-1).
            providerId: target.providerId,
            modelName: target.modelName || settings.modelName,
            reasoningEffort: 'default',
          };
          setByokChatModelSelection(currentChat, {
            providerId: selection.providerId,
            modelName: selection.modelName,
            reasoningEffort: effort,
          });
          updateByokChat(currentChat);
        },
        canAttachFiles: !!fs,
        canAttachImages:
          settings.imageSupport !== 'no' &&
          !(capabilityRecord && capabilityRecord.images === false),
        pickTextFile,
        pickImageFile,
      };
      // The chat store notifications (updateByokChat) re-render through
      // byokChatsUpdateCount; the trackers update with every turn.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [
      selectedByokChat,
      byokModelChoices,
      byokChatsUpdateCount,
      preferencesValues,
    ]
  );

  // ---- Phase 9.6: local thumbs (nothing is sent anywhere) ----
  const onSendByokFeedback = React.useCallback(
    async (
      aiRequestId: string,
      messageIndex: number,
      feedback: 'like' | 'dislike'
    ): Promise<void> => {
      const chat = getByokChat(aiRequestId);
      const message = chat && chat.output ? chat.output[messageIndex] : null;
      recordByokFeedback({
        chatId: aiRequestId,
        messageId: (message && message.messageId) || `index-${messageIndex}`,
        rating: feedback,
      });
    },
    []
  );

  // ---- Phase 9.3: open a saved chat from the history button ----
  const openSavedByokChat = React.useCallback(
    async (chatId: string): Promise<boolean> => {
      const store = getByokChatPersistence();
      if (!store) return false;
      const existing = getByokChat(chatId);
      if (existing) {
        setSelectedByokChatId(chatId);
        return true;
      }
      const chat = await store.loadChat(chatId);
      if (!chat) return false;
      // A reloaded chat rejoins the session store (marked with its own
      // updatedAt — never re-marked 'working' by a phantom loop).
      byokReattachChat(chat);
      setSelectedByokChatId(chat.id);
      return true;
    },
    []
  );

  // The live values the BYOK orchestrators read through getters, so a chat
  // created before a project existed (or before the current one was opened)
  // still sees the current state on every turn: the project prop of the
  // render that created the orchestrator must never be frozen into it.
  const byokProjectRef = useStableUpToDateRef<?any>(project);
  // The file identifier is read live too (the Phase 7 follow-up): a project
  // "Save as…" mid-chat changes the identifier, and the notes must follow
  // without waiting for the chat to be reopened.
  const byokFileMetadataRef = useStableUpToDateRef<?{
    +fileIdentifier?: ?string,
    ...
  }>(fileMetadata);
  const byokCreatedProjectRef = React.useRef<?any>(null);
  const byokSawProjectPropRef = React.useRef<boolean>(false);
  /**
   * The project the BYOK chats work on: the opened one, or — until the
   * editor re-renders with it — the one a chat just created with
   * initialize_project. Once a project prop existed and then disappeared,
   * the project was closed: the chats are back to "no project".
   */
  const getByokLiveProject = React.useCallback((): ?any => {
    const openedProject = byokProjectRef.current;
    if (openedProject) {
      byokSawProjectPropRef.current = true;
      return openedProject;
    }
    if (byokSawProjectPropRef.current) {
      byokCreatedProjectRef.current = null;
      return null;
    }
    return byokCreatedProjectRef.current;
    // The ref objects are stable (they only carry a changing `current`), so
    // the empty dependency array keeps this callback identity-stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { ensureExtensionInstalled } = useEnsureExtensionInstalled({
    project,
    // The O3 fix: read the project through the live getter, so an extension
    // install right after initialize_project (before React re-renders with
    // the new project prop) already sees the fresh project.
    getProject: getByokLiveProject,
    i18n,
  });

  const executeByokFunctionCalls = React.useMemo(
    () =>
      createByokEditorFunctionCallExecutor({
        processEditorFunctionCalls,
        getProject: getByokLiveProject,
        i18n,
        editorCallbacks,
        ensureExtensionInstalled,
        onSceneEventsModifiedOutsideEditor,
        onInstancesModifiedOutsideEditor,
        onObjectsModifiedOutsideEditor,
        onObjectGroupsModifiedOutsideEditor,
        onProjectItemRenamedOutsideEditor,
        onWillDeleteScene,
        onWillDeleteGameplayTest,
        onWillDeleteObject,
        onWillInstallExtension,
        onExtensionInstalled,
      }),
    [
      getByokLiveProject,
      i18n,
      editorCallbacks,
      ensureExtensionInstalled,
      processEditorFunctionCalls,
      onSceneEventsModifiedOutsideEditor,
      onInstancesModifiedOutsideEditor,
      onObjectsModifiedOutsideEditor,
      onObjectGroupsModifiedOutsideEditor,
      onProjectItemRenamedOutsideEditor,
      onWillDeleteScene,
      onWillDeleteGameplayTest,
      onWillDeleteObject,
      onWillInstallExtension,
      onExtensionInstalled,
    ]
  );

  // ---- Phase 10: the GDevelop MCP tool host ----
  // The loopback MCP server executes its tool calls through THIS seam's
  // executor and collaborators, so an external agent works on exactly what
  // a BYOK chat would — with the sub-agent runner deliberately absent (the
  // external agent orchestrates itself; the extra tools refuse nesting) and
  // with no chat id (nothing keys restore points or transcripts on it).
  // Registered while a seam host is mounted: the practical rule for the
  // user is "open the Ask AI panel once in the project window"
  // (Phase10.md step 10.6).
  React.useEffect(
    () => {
      let internalCallCounter = 0;
      // The MCP host mutates the project OUTSIDE any chat, so nothing
      // else marks it dirty: without this the editor keeps saying "no
      // unsaved changes" and every edit an external agent makes is lost
      // when the project is closed (audit 2026-10-02 UP-9). The chat path
      // marks it in onFunctionCallsExecuted; the MCP path has to do it
      // itself, for both result kinds (registry + intercepted tools).
      const markUnsavedIfModified = (
        results: $ReadOnlyArray<{ +didModifyProject?: boolean, ... }>
      ): void => {
        const didModify = results.some(result => !!result.didModifyProject);
        if (didModify) triggerUnsavedChanges();
      };
      const executeRegistryTool = async (
        name: string,
        argsJson: string,
        callId: string
      ) => {
        // Mutation door: the chat orchestrator takes the same lock around
        // its tool batches, so an MCP call and a chat round can never
        // interleave gd.* changes on the project (audit100226 UP-11).
        const execution = await runExclusiveByokProjectMutation(() =>
          executeByokFunctionCalls(
            [{ name, arguments: argsJson, call_id: callId }],
            {
              aiRequestId: 'byok-mcp',
              getRelatedAiRequestLastMessages: () => null,
            }
          )
        );
        markUnsavedIfModified(execution.results);
        return (
          execution.results[0] || {
            status: 'finished',
            call_id: callId,
            success: false,
            output: { message: 'The tool did not return a result.' },
          }
        );
      };
      const makeExtraToolCollaborators = (): ByokExtraToolCollaborators => {
        const currentSettings = getByokSettings(
          preferencesValuesRef.current || {}
        );
        return {
          getProject: getByokLiveProject,
          onSceneEventsModifiedOutsideEditor,
          // The MCP host runs the same extra tools as a chat: an external
          // agent's writes refresh the open editors too (and sprite-frame
          // writes redraw scene editors, which was missing here).
          onObjectsModifiedOutsideEditor,
          onExternalLayoutModifiedOutsideEditor,
          onExternalEventsModifiedOutsideEditor,
          runtimeDeps: {
            getProject: getByokLiveProject,
            captureSceneCanvas: () => {
              const canvas = findLargestVisibleSceneCanvas(
                typeof document !== 'undefined' ? document : null
              );
              if (!canvas) return null;
              return canvas.toDataURL('image/jpeg', 0.7);
            },
            invokePreviewCapture: invokeByokPreviewCapture,
            getPreviewLauncher: getProjectPreviewLauncher,
            storeImage: makeDefaultByokImageStore(),
            executeSingleToolCall: async (name, args) => {
              internalCallCounter += 1;
              const execution = await executeByokFunctionCalls(
                [
                  {
                    name,
                    arguments: JSON.stringify(args),
                    call_id: `mcp-internal-${internalCallCounter}`,
                  },
                ],
                {
                  aiRequestId: 'byok-mcp',
                  getRelatedAiRequestLastMessages: () => null,
                }
              );
              return execution.results[0];
            },
          },
          // No runSubAgent: the structural nesting guard makes the sub-agent
          // tools refuse over MCP, which is the designed behavior.
          onlineDocsEnabled: currentSettings.onlineDocsEnabled,
          getProjectNotesIdentifier: () => {
            const liveProject = getByokLiveProject();
            if (!liveProject) return null;
            const liveFileMetadata = byokFileMetadataRef.current;
            if (liveFileMetadata && liveFileMetadata.fileIdentifier) {
              return liveFileMetadata.fileIdentifier;
            }
            return makeByokProjectNotesIdentifierFromProjectName(
              liveProject.getName()
            );
          },
          reloadEventsFunctionsExtensions: project =>
            eventsFunctionsExtensionsState.reloadProjectEventsFunctionsExtensions(
              project
            ),
          reloadEventsFunctionsExtensionMetadata: (project, extension) =>
            eventsFunctionsExtensionsState.reloadProjectEventsFunctionsExtensionMetadata(
              project,
              extension
            ),
        };
      };
      const host = makeByokMcpToolHost({
        executeRegistryTool,
        executeExtraTool: async (name, args) => {
          const extraTool = findByNameokExtraTool(name);
          if (!extraTool) throw new Error(`Unknown tool: ${name}`);
          const collaborators = makeExtraToolCollaborators();
          // Mutation door (UP-11): the chat orchestrator takes the same lock
          // around its tool batches, so an MCP call and a chat round can
          // never interleave gd.* changes on the project.
          const result = await runExclusiveByokProjectMutation(async () => {
            const toolResult = await extraTool.run(args, collaborators);
            // The extension-authoring tools only mark a module-level
            // accumulator; the chat orchestrator flushes it once per batch.
            // Over MCP nothing did, so functions/behaviors created by an
            // external agent stayed unusable in events until some unrelated
            // chat batch happened to flush (audit100226 UP-10). The reload
            // mutates the editor's view too, so it belongs inside the lock.
            // A failing reload is an editor side effect, not a tool failure:
            // it must not turn a successful tool result into an error.
            try {
              await flushByokExtensionRegeneration(getByokLiveProject(), {
                reloadEventsFunctionsExtensions:
                  collaborators.reloadEventsFunctionsExtensions,
                reloadEventsFunctionsExtensionMetadata:
                  collaborators.reloadEventsFunctionsExtensionMetadata,
              });
            } catch (error) {
              console.error(
                'BYOK MCP host: the extensions reload after the tool failed:',
                error
              );
            }
            return toolResult;
          });
          markUnsavedIfModified([result]);
          return result;
        },
        getExtraTool: name => findByNameokExtraTool(name),
        editorFunctions,
        editorFunctionsWithoutProject,
        getProject: getByokLiveProject,
        getSettings: () => getByokSettings(preferencesValuesRef.current || {}),
        // The prompts/resources data sources (Phase 12): the skill library
        // as MCP prompts, the project notes as an MCP resource.
        listSkillPrompts: async () => {
          const skills = await getByokSkills();
          return skills.map(skill => ({
            name: skill.name,
            description: skill.description,
            body: skill.body,
          }));
        },
        readProjectNotes: async () => {
          const liveProject = getByokLiveProject();
          if (!liveProject) return null;
          const liveFileMetadata = byokFileMetadataRef.current;
          const identifier =
            liveFileMetadata && liveFileMetadata.fileIdentifier
              ? liveFileMetadata.fileIdentifier
              : makeByokProjectNotesIdentifierFromProjectName(
                  liveProject.getName()
                );
          const notes = await loadByokProjectNotes(identifier);
          return [
            notes.conventions ? `Conventions:\n${notes.conventions}` : '',
            notes.inProgress ? `In progress:\n${notes.inProgress}` : '',
            notes.decisions ? `Decisions:\n${notes.decisions}` : '',
          ]
            .filter(Boolean)
            .join('\n\n');
        },
      });
      setByokMcpToolHost(host);
      return () => {
        // Unregister only while still the current host: a newer mount (another
        // window, or a remount) must not be torn down by an older cleanup.
        if (getByokMcpToolHost() === host) {
          setByokMcpToolHost(null);
        }
      };
    },
    [
      executeByokFunctionCalls,
      getByokLiveProject,
      onSceneEventsModifiedOutsideEditor,
      onExternalLayoutModifiedOutsideEditor,
      onExternalEventsModifiedOutsideEditor,
      onObjectsModifiedOutsideEditor,
      preferencesValuesRef,
      editorFunctions,
      editorFunctionsWithoutProject,
      fileMetadata,
      byokFileMetadataRef,
      getProjectPreviewLauncher,
      eventsFunctionsExtensionsState,
      triggerUnsavedChanges,
    ]
  );

  const suspendByokChat = React.useCallback((aiRequestId: string) => {
    const orchestrator = getByokOrchestrator(aiRequestId);
    if (orchestrator) orchestrator.suspend();
  }, []);

  // The BYOK chats of the session, as history entries — without them, a chat
  // told to "continue working" in the background would keep calling the
  // user's paid endpoint with no way left to watch or stop it.
  const byokChatSummaries = React.useMemo(
    () => listByokChats().map(chat => getAiRequestSummary(chat)),
    // Re-derived whenever the BYOK store notifies (the count is the change
    // signal, not an input of the computation).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byokChatsUpdateCount]
  );
  const onArchiveByokChat = React.useCallback((aiRequestId: string) => {
    const orchestrator = getByokOrchestrator(aiRequestId);
    if (orchestrator) orchestrator.suspend();
    deleteByokOrchestrator(aiRequestId);
    deleteByokUsageTracker(aiRequestId);
    // The chat closes: its restore-point snapshots go with it (no disk
    // growth — Phase 8.6's cap discipline).
    dropByokChatSnapshots(aiRequestId);
    archiveByokChat(aiRequestId);
  }, []);

  // ---- Phase 13.1: the Recents rail's BYOK section ----
  // The merged history: every chat of the durable store (persisted metas)
  // plus any in-session chat (its live summary wins — the status dot and the
  // "working" state come from the live record). Refreshed on mount, after
  // the rail's actions, and (debounced) whenever the session store changes.
  const [byokHistoryChats, setByokHistoryChats] = React.useState<Array<any>>(
    []
  );
  const refreshByokHistoryChats = React.useCallback(async (): Promise<void> => {
    const store = getByokChatPersistence();
    let metas: Array<any> = [];
    if (store) {
      try {
        metas = await store.listChatMetas();
      } catch (error) {
        // A failing listing keeps the previous entries: the rail stays
        // usable with the in-session chats.
      }
    }
    const metaById: Map<string, any> = new Map(
      metas.map(meta => [meta.id, meta])
    );
    const entries: Array<any> = [];
    const seenIds: Set<string> = new Set();
    for (const chat of listAllByokChats()) {
      seenIds.add(chat.id);
      const meta = metaById.get(chat.id);
      const summary = getAiRequestSummary(chat);
      entries.push({
        ...summary,
        archivedAt: chat.archivedAt !== undefined ? chat.archivedAt : null,
        title: summary.title || (meta ? meta.name : ''),
      });
    }
    for (const meta of metas) {
      if (seenIds.has(meta.id)) continue;
      entries.push({
        id: meta.id,
        title: meta.name,
        archivedAt: meta.archivedAt,
        gameId: null,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        userId: '',
        status: 'ready',
        mode: 'orchestrator',
        error: null,
        firstUserMessage: '',
        lastMessage: '',
        outputMessagesCount: meta.messageCount,
      });
    }
    entries.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
    setByokHistoryChats(entries);
  }, []);
  React.useEffect(
    () => {
      void refreshByokHistoryChats();
    },
    [refreshByokHistoryChats]
  );
  // Debounced refresh on session changes: the durable store saves with a
  // 1.5 s debounce itself, so re-parsing every file on every notification
  // would be wasted work — one trailing refresh per quiet period is enough.
  React.useEffect(
    () => {
      if (byokChatsUpdateCount === 0) return undefined;
      const timer = setTimeout(() => {
        void refreshByokHistoryChats();
      }, 2000);
      return () => clearTimeout(timer);
    },
    [byokChatsUpdateCount, refreshByokHistoryChats]
  );

  const setByokHistoryChatArchived = React.useCallback(
    async (aiRequestId: string, archived: boolean): Promise<void> => {
      const chat = getByokChat(aiRequestId);
      if (chat) {
        // In session: the full paths (suspend + snapshots on archive).
        if (archived) {
          onArchiveByokChat(aiRequestId);
        } else {
          restoreByokChat(aiRequestId);
        }
        await refreshByokHistoryChats();
        return;
      }
      const store = getByokChatPersistence();
      if (!store) return;
      try {
        await store.setArchived(
          aiRequestId,
          archived ? new Date().toISOString() : null
        );
      } catch (error) {
        console.error('BYOK history: unable to (un)archive the chat:', error);
      }
      await refreshByokHistoryChats();
    },
    [onArchiveByokChat, refreshByokHistoryChats]
  );

  // The Recents rail's BYOK rename (audit011026 O6): the session record's
  // title plus the durable file's renameChat (which moves the file to the
  // new name-derived file name, id-suffixed since B-UI-3).
  const renameByokHistoryChat = React.useCallback(
    async (aiRequestId: string, title: string): Promise<void> => {
      const trimmedTitle = (title || '').trim();
      if (!trimmedTitle) return;
      const chat = getByokChat(aiRequestId);
      if (chat) {
        (chat: any).title = trimmedTitle;
        updateByokChat(chat);
      }
      const persistence = getByokChatPersistence();
      if (persistence) {
        await persistence.renameChat(aiRequestId, trimmedTitle).catch(error => {
          console.error('BYOK chats: unable to rename the chat file:', error);
        });
      }
      await refreshByokHistoryChats();
    },
    [refreshByokHistoryChats]
  );

  const deleteByokHistoryChat = React.useCallback(
    async (aiRequestId: string): Promise<void> => {
      // Mirror the archive path's suspend-first sequence (audit011026
      // B-UI-5): deleting a working chat without suspending its loop left
      // a zombie orchestrator spending the user's key with updates that
      // silently no-opped on the deleted store entry.
      const orchestrator = getByokOrchestrator(aiRequestId);
      if (orchestrator) orchestrator.suspend();
      deleteByokOrchestrator(aiRequestId);
      deleteByokUsageTracker(aiRequestId);
      dropByokChatSnapshots(aiRequestId);
      await deleteByokChat(aiRequestId);
      await refreshByokHistoryChats();
    },
    [refreshByokHistoryChats]
  );

  // The chat-facing guidance for a chat that cannot find its API key. The
  // two storage statuses need different lines: 'none' means the user never
  // saved a key, 'unreadable' means one is stored but this computer can no
  // longer decrypt it (e.g. DPAPI after a Windows account change) — telling
  // them to "add a key" would be misleading.
  const getByokMissingKeyError = React.useCallback(
    (storedKey: ByokKeyLoadResult) => {
      if (storedKey.status === 'unreadable') {
        return {
          code: 'byok-unreadable-key',
          message: i18n._(
            t`A BYOK API key is stored, but it cannot be decrypted on this computer anymore. Open Preferences > BYOK, clear the stored key and enter it again, then send your message again.`
          ),
        };
      }
      return {
        code: 'byok-missing-key',
        message: i18n._(
          t`No API key is stored for BYOK. Add one in Preferences > BYOK, then send your message again.`
        ),
      };
    },
    [i18n]
  );

  const createByokOrchestratorForChat = React.useCallback(
    (chat: AiRequest, byokSettings: ByokSettings, apiKey: string) => {
      const usageTracker = createByokUsageTracker();
      setByokUsageTracker(chat.id, usageTracker);
      // The live settings (routing/capabilities/watchdog), read per turn.
      const getLiveSettings = (): ByokSettings =>
        getByokSettings(preferencesValuesRef.current || {});
      // The capability write-back (remembered degradations, 9.5).
      const writeCapabilityPatch = (
        baseUrl: string,
        modelName: string,
        patch: Object
      ) => {
        const currentSettings = getLiveSettings();
        updateByokPreferences({
          ...currentSettings,
          ...patchByokCapabilityRecord(
            currentSettings,
            baseUrl,
            modelName,
            patch
          ),
        });
      };
      // The opt-in follow-up chips (9.6): one extra fast-profile call after
      // the chat goes ready — outside the loop, best-effort.
      const maybeFetchSuggestions = async (): Promise<void> => {
        const currentSettings = getLiveSettings();
        if (!currentSettings.suggestionsEnabled) return;
        const chatSelection = getByokChatModelSelection(chat);
        const target = resolveByokModelTarget({
          settings: currentSettings,
          chatSelection,
          callKind: 'suggestions',
        });
        const provider = currentSettings.providers.find(
          entry => entry.id === target.providerId
        );
        const storedKey = await loadByokKey(provider ? provider.keyRef : '');
        if (storedKey.status !== 'ok') return;
        const suggestions = await fetchByokSuggestions({
          enabled: true,
          transcript: chat.output || [],
          callModel: async ({ messages }) =>
            await sendByokChatCompletionWithRetries({
              baseUrl: target.endpointUrl,
              apiKey: storedKey.key,
              options: {
                model: target.modelName || currentSettings.modelName,
                messages,
                temperature:
                  target.temperature === null ? undefined : target.temperature,
                maxTokens:
                  target.maxTokens === null ? undefined : target.maxTokens,
              },
            }),
        });
        if (!suggestions) return;
        if (attachByokSuggestions(chat.output || [], suggestions)) {
          updateByokChat(chat);
        }
      };
      // The sub-agents of this chat (Phase 8.1): they share the chat's
      // connection, its usage tracker, and one global model-turn budget
      // with the parent loop, and they build their own read-only executor
      // (the scout's run_script must not be able to modify anything).
      // The budget object is created ONCE here and handed to BOTH the
      // sub-agent runner and the parent orchestrator below: passing a
      // fresh literal to the children made the pool independent, so a
      // parent plus its children could spend 2 × the documented budget
      // (audit 2026-10-02 LOOP-3).
      const sharedTurnBudget: ByokSharedTurnBudget = {
        remaining: BYOK_GLOBAL_TURN_BUDGET,
      };
      const subAgentRunner = createByokSubAgentRunner({
        connection: {
          baseUrl: byokSettings.endpointUrl,
          apiKey,
        },
        settings: byokSettings,
        hasOpenedProject: () => !!getByokLiveProject(),
        getProject: () => getByokLiveProject(),
        getProjectUserContent: async () => {
          const liveProject = getByokLiveProject();
          if (!liveProject) return null;
          const simplifiedProjectBuilder = makeSimplifiedProjectBuilder(gd);
          return JSON.stringify(
            simplifiedProjectBuilder.getSimplifiedProject(liveProject, {})
          );
        },
        createExecutor: ({ runScriptReadOnly }) =>
          createByokEditorFunctionCallExecutor({
            processEditorFunctionCalls,
            getProject: getByokLiveProject,
            i18n,
            editorCallbacks,
            ensureExtensionInstalled,
            onSceneEventsModifiedOutsideEditor,
            onInstancesModifiedOutsideEditor,
            onObjectsModifiedOutsideEditor,
            onObjectGroupsModifiedOutsideEditor,
            onProjectItemRenamedOutsideEditor,
            onWillDeleteScene,
            onWillDeleteGameplayTest,
            onWillDeleteObject,
            onWillInstallExtension,
            onExtensionInstalled,
            runScriptReadOnly,
          }),
        usageTracker,
        sharedTurnBudget: sharedTurnBudget,
        getSettings: getLiveSettings,
        getApiKeyForProvider: getByokApiKeyForProvider,
        onCapabilityUpdate: writeCapabilityPatch,
      });
      const orchestrator = createByokOrchestrator({
        connection: {
          baseUrl: byokSettings.endpointUrl,
          apiKey,
        },
        settings: byokSettings,
        aiRequest: chat,
        // Everything below is a getter read per turn: the chat must never be
        // frozen on the project (or executor) of the render that created it —
        // a chat that starts without a project and creates one with
        // initialize_project edits it right away.
        hasOpenedProject: () => !!getByokLiveProject(),
        getProject: () => getByokLiveProject(),
        getExecutor: () => executeByokFunctionCalls,
        getProjectUserContent: async () => {
          const liveProject = getByokLiveProject();
          if (!liveProject) return null;
          const simplifiedProjectBuilder = makeSimplifiedProjectBuilder(gd);
          return JSON.stringify(
            simplifiedProjectBuilder.getSimplifiedProject(liveProject, {})
          );
        },
        onAiRequestUpdated: updatedChat => updateByokChat(updatedChat),
        // The live store record (audit011026 B-UI-1): the bottom-bar's
        // model/effort selection is written there and must reach the next
        // turn even after this closure's record diverged.
        getLiveAiRequest: () => getByokChat(chat.id) || chat,
        // Passed through to the sprite-internals tools so open scene editors
        // redraw after a change_sprite_frames batch.
        onObjectsModifiedOutsideEditor,
        // Passed through to the external-items tools so an already-open
        // external layout / external events editor redraws after a write.
        onExternalLayoutModifiedOutsideEditor,
        onExternalEventsModifiedOutsideEditor,
        // The extension regeneration hooks (Phase 8.4): the editor
        // context's reload functions, flushed once per batch of extension
        // tool calls so new functions/behaviors/objects become usable.
        reloadEventsFunctionsExtensions: project =>
          eventsFunctionsExtensionsState.reloadProjectEventsFunctionsExtensions(
            project
          ),
        reloadEventsFunctionsExtensionMetadata: (project, extension) =>
          eventsFunctionsExtensionsState.reloadProjectEventsFunctionsExtensionMetadata(
            project,
            extension
          ),
        // The per-project notes (Phase 7) are keyed on the project's file
        // identifier, with a project-name hash as the fallback for projects
        // not saved yet. Read live: a "Save as…" mid-chat must move the
        // notes to the new identifier.
        getProjectNotesIdentifier: () => {
          const liveProject = getByokLiveProject();
          if (!liveProject) return null;
          const liveFileMetadata = byokFileMetadataRef.current;
          if (liveFileMetadata && liveFileMetadata.fileIdentifier) {
            return liveFileMetadata.fileIdentifier;
          }
          return makeByokProjectNotesIdentifierFromProjectName(
            liveProject.getName()
          );
        },
        doesCallRequireApproval: functionCall => {
          // The BYOK-intercepted tools that do NOT live in the editor
          // registry carry their own modification flag (read-only tools like
          // load_skill must not open the approval row); the ones that also
          // exist in the registry keep their registry-side, sometimes
          // per-arguments decision.
          const extraTool = findByNameokExtraTool(functionCall.name);
          const inRegistry =
            editorFunctions[functionCall.name] ||
            editorFunctionsWithoutProject[functionCall.name];
          if (extraTool && !inRegistry) return extraTool.modifiesProject;
          const editorFunction =
            editorFunctions[functionCall.name] ||
            editorFunctionsWithoutProject[functionCall.name] ||
            null;
          try {
            return byokCallRequiresApproval(
              editorFunction,
              JSON.parse(functionCall.arguments)
            );
          } catch (error) {
            // Unparsable arguments: require approval (safe default).
            return true;
          }
        },
        onRequestEditApproval: async modifyingCalls => {
          if (getIsAutoEditEnabled()) return true;
          const unapprovedCalls = modifyingCalls.filter(
            call => !approvedByokEditCallIdsRef.current.has(call.call_id)
          );
          if (unapprovedCalls.length === 0) return true;
          const accepted = await requestEditApproval({
            aiRequestId: chat.id,
            callIds: unapprovedCalls.map(call => call.call_id),
            label: unapprovedCalls.map(call => call.name).join(', '),
          });
          if (accepted) {
            if (
              approvedByokEditCallIdsRef.current.size >=
              APPROVED_CALL_IDS_CAPACITY
            ) {
              approvedByokEditCallIdsRef.current.clear();
            }
            unapprovedCalls.forEach(call =>
              approvedByokEditCallIdsRef.current.add(call.call_id)
            );
          }
          return accepted;
        },
        usageTracker,
        subAgentRunner,
        // The SAME budget object the sub-agents draw from (see above).
        sharedTurnBudget,
        onSceneEventsModifiedOutsideEditor,
        // ---- Phase 9: routing, capabilities, watchdog, suggestions ----
        getSettings: getLiveSettings,
        getApiKeyForProvider: getByokApiKeyForProvider,
        onCapabilityUpdate: writeCapabilityPatch,
        onChatReady: () => {
          void maybeFetchSuggestions();
        },
        // The perception tools' environment hooks (Phase 6): the scene editor
        // canvas of this window, the Electron preview-capture IPC, and the
        // preview launcher MainFrame registered.
        runtimeDeps: {
          captureSceneCanvas: () => {
            const canvas = findLargestVisibleSceneCanvas(
              typeof document !== 'undefined' ? document : null
            );
            if (!canvas) return null;
            return canvas.toDataURL('image/jpeg', 0.7);
          },
          invokePreviewCapture: invokeByokPreviewCapture,
          getPreviewLauncher: getProjectPreviewLauncher,
        },
        onFunctionCallsExecuted: (
          results,
          { createdSceneNames, createdProject }
        ) => {
          // The project a chat just created (initialize_project) is
          // remembered synchronously — the very next round's snapshot and
          // executor must see it, before React re-renders.
          if (createdProject) {
            byokCreatedProjectRef.current = createdProject;
          }
          if (
            results.some(
              result => result.status === 'finished' && result.didModifyProject
            )
          ) {
            triggerUnsavedChanges();
          }
          createdSceneNames.forEach(sceneName => {
            onOpenLayout(sceneName, {
              openEventsEditor: true,
              openSceneEditor: true,
              focusWhenOpened: 'scene',
            });
          });
        },
      });
      setByokOrchestrator(chat.id, orchestrator);
      return orchestrator;
    },
    [
      getByokLiveProject,
      executeByokFunctionCalls,
      getIsAutoEditEnabled,
      requestEditApproval,
      preferencesValuesRef,
      updateByokPreferences,
      triggerUnsavedChanges,
      onOpenLayout,
      onSceneEventsModifiedOutsideEditor,
      byokFileMetadataRef,
      getProjectPreviewLauncher,
      editorFunctions,
      editorFunctionsWithoutProject,
      i18n,
      editorCallbacks,
      ensureExtensionInstalled,
      processEditorFunctionCalls,
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
      eventsFunctionsExtensionsState,
    ]
  );

  /**
   * The key of the call's ACTUAL target (audit011026 B-UI-2): a
   * providers-only configuration keeps its keys in per-provider slots, and
   * the historical gate on the legacy slot ('') blocked every chat start
   * for it. The target is resolved exactly like the orchestrator's first
   * main call resolves it; the legacy slot stays the fallback of the
   * migrated provider #1 (which shares it).
   */
  const resolveByokStartKey = React.useCallback(
    async (byokSettings: ByokSettings): Promise<ByokKeyLoadResult> => {
      const target = resolveByokModelTarget({
        settings: byokSettings,
        chatSelection: null,
        callKind: 'main',
      });
      const provider = (byokSettings.providers || []).find(
        entry => entry.id === target.providerId
      );
      const keyRef = provider ? provider.keyRef : '';
      const storedKey = await loadByokKey(keyRef);
      if (storedKey.status !== 'ok' && keyRef !== '') {
        const legacyKey = await loadByokKey('');
        if (legacyKey.status === 'ok') return legacyKey;
      }
      return storedKey;
    },
    []
  );

  /**
   * Get (or lazily create) the orchestrator of an existing BYOK chat — this
   * is what makes a chat recoverable after the missing-key error (the user
   * saved a key, then retries or sends a message again) and after the host
   * was remounted. Returns null when the chat is still working (a live loop
   * must not get a second orchestrator on the same transcript) or when no
   * key is stored (the chat is then re-marked with the missing-key error).
   */
  // One attach per chat at a time (audit011026 B-UI-6): the status guard
  // runs before the key-loading await, so a double-Enter during that IPC
  // round-trip created two orchestrators on the same transcript.
  const byokAttachPromisesRef = React.useRef<
    Map<string, Promise<?ByokOrchestrator>>
  >(new Map());
  const attachByokOrchestrator = React.useCallback(
    async (chat: AiRequest): Promise<?ByokOrchestrator> => {
      const inFlightAttach = byokAttachPromisesRef.current.get(chat.id);
      if (inFlightAttach) return inFlightAttach;
      const attachPromise = (async (): Promise<?ByokOrchestrator> => {
        const existingOrchestrator = getByokOrchestrator(chat.id);
        if (existingOrchestrator) return existingOrchestrator;
        if (chat.status === 'working') return null;

        const byokSettings = getByokSettings(preferencesValues);
        const storedKey = await resolveByokStartKey(byokSettings);
        if (storedKey.status !== 'ok') {
          chat.status = 'error';
          chat.error = getByokMissingKeyError(storedKey);
          updateByokChat(chat);
          return null;
        }

        return createByokOrchestratorForChat(chat, byokSettings, storedKey.key);
      })();
      byokAttachPromisesRef.current.set(chat.id, attachPromise);
      try {
        return await attachPromise;
      } finally {
        byokAttachPromisesRef.current.delete(chat.id);
      }
    },
    [
      preferencesValues,
      getByokMissingKeyError,
      createByokOrchestratorForChat,
      resolveByokStartKey,
    ]
  );

  const startByokChat = React.useCallback(
    async (
      userRequest: string,
      chatOptions?: {| onChatCreated?: (chatId: string) => void |}
    ) => {
      const byokSettings = getByokSettings(preferencesValues);
      const chat = createByokChat();
      setSelectedAiRequestId(null);
      setSelectedByokChatId(chat.id);
      resetChatUserInputs(chat.id);
      if (chatOptions && chatOptions.onChatCreated) {
        chatOptions.onChatCreated(chat.id);
      }

      const storedKey = await resolveByokStartKey(byokSettings);
      if (storedKey.status !== 'ok') {
        chat.status = 'error';
        chat.error = getByokMissingKeyError(storedKey);
        updateByokChat(chat);
        return;
      }

      const orchestrator = createByokOrchestratorForChat(
        chat,
        byokSettings,
        storedKey.key
      );
      await orchestrator.startNewChat(userRequest);
    },
    [
      preferencesValues,
      getByokMissingKeyError,
      createByokOrchestratorForChat,
      resolveByokStartKey,
      setSelectedAiRequestId,
      resetChatUserInputs,
    ]
  );

  /**
   * Continue a BYOK chat with a user message — the BYOK branch of the
   * host's onSendMessage. The optional image ids are the attachments picked
   * with the "+" button (13.3): they ride on the user message record, like
   * the tool outputs' screenshots do. The orchestrator can be missing
   * (missing-key error, or the host was remounted): re-attach instead of
   * dropping the message — attach re-marks the chat with the missing-key
   * error when there is still no key, so the user is never left without
   * feedback.
   */
  const sendByokUserMessage = React.useCallback(
    async (
      aiRequestId: string,
      userMessage: string,
      byokImageIds?: Array<string>
    ) => {
      if (!userMessage) return;

      const chat = getByokChat(aiRequestId);
      if (!chat) return;

      const orchestrator = await attachByokOrchestrator(chat);
      if (!orchestrator) return;

      const sendPromise = orchestrator.sendUserMessage(
        userMessage,
        byokImageIds
      );
      // Clear the sent message right away — the loop it starts can run for
      // a while (the server path resets after its single request; ours must
      // not wait for the whole conversation).
      if (aiRequestId === selectedByokChatId) {
        resetChatUserInputs(aiRequestId);
      }
      await sendPromise;
    },
    [attachByokOrchestrator, selectedByokChatId, resetChatUserInputs]
  );

  // Re-run a failed BYOK chat's loop without adding anything to the
  // conversation (the transcript replay is exactly a retry). The
  // orchestrator is re-attached when missing (missing-key error the user
  // just fixed by saving a key, or a host remount) — this is what makes the
  // Retry row work instead of silently no-op'ing.
  const onRetryByokChat = React.useCallback(
    async () => {
      if (!selectedByokChatId) return;
      const chat = getByokChat(selectedByokChatId);
      if (!chat) return;
      const orchestrator = await attachByokOrchestrator(chat);
      if (orchestrator) await orchestrator.retryAfterError();
    },
    [selectedByokChatId, attachByokOrchestrator]
  );

  return {
    selectedByokChatId,
    setSelectedByokChatId,
    selectedByokChat,
    byokChatSummaries,
    onArchiveByokChat,
    startByokChat,
    attachByokOrchestrator,
    sendByokUserMessage,
    suspendByokChat,
    suspendAiRequestWithByokSupport: async (aiRequestId: string) => {
      // BYOK chats are suspended locally (no server request exists for
      // them); server chats are the host's own concern.
      if (!isByokAiRequestId(aiRequestId)) return;
      suspendByokChat(aiRequestId);
    },
    clearApprovedByokEditCallIds,
    onRetryByokChat,
    getByokLiveProject,
    byokToggleState,
    byokChatControls,
    byokHistoryChats,
    refreshByokHistoryChats,
    setByokHistoryChatArchived,
    deleteByokHistoryChat,
    renameByokHistoryChat,
    onSendByokFeedback,
    openSavedByokChat,
  };
};
