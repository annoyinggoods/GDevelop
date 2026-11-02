// @flow
import type { AiRequest } from '../../Utils/GDevelopServices/Generation';
import { createByokAiRequestShell } from './ByokTranscript';
import { type ByokChatFileStore } from './ByokChatPersistence';
import { BYOK_CHAT_STORAGE_QUOTA_BYTES } from './ByokTypes';

/**
 * The store of the BYOK chats: `AiRequest`-shaped records with synthetic ids,
 * so the chat UI renders them with zero knowledge that no server exists.
 *
 * The records live in a module-level map — the same spirit as the record of
 * `AiRequestContext`, but strictly local: a BYOK chat must never enter
 * `AiRequestContext`, whose loading and polling effects target GDevelop's
 * servers.
 *
 * Since Phase 9.3 the store delegates the durable copies to a
 * `ByokChatFileStore` (Markdown files on desktop, IndexedDB entries on
 * web): the three save points of the owner design (after every user
 * message, when the AI finishes, on app closure) are covered by marking
 * chats dirty on every update — user messages and terminal statuses save
 * right away, anything else is flushed by a short debounce (which the
 * app-close `flushByokChatPersistence` also runs).
 */

// Phase 9.3: durable history is implemented and capped (200 MB quota,
// image sidecars evicted first) — the flag flips on.
export const BYOK_CHAT_PERSISTENCE_ENABLED = true;

const byokChats: Map<string, AiRequest> = new Map();
const listeners: Set<() => void> = new Set();

const notifyListeners = (): void => {
  listeners.forEach(listener => listener());
};

// ---- The persistence delegate (Phase 9.3) ----
// Set by the app once a platform backend exists (desktop IPC files, web
// IndexedDB); tests inject an in-memory one. Never throws into the store:
// a failed save is logged, the in-memory chat stays authoritative.
let chatFileStore: ?ByokChatFileStore = null;
const dirtyChatIds: Set<string> = new Set();
let flushTimerId: any = null;
const FLUSH_DEBOUNCE_MS = 1500;

/** Install (or remove, with null) the durable file store. */
export const setByokChatPersistence = (store: ?ByokChatFileStore): void => {
  chatFileStore = store;
};

/** The installed file store (tests and the history UI read it). */
export const getByokChatPersistence = (): ?ByokChatFileStore => chatFileStore;

const saveChatNow = async (chat: AiRequest): Promise<void> => {
  const store = chatFileStore;
  if (!store) return;
  // A chat deleted while this save was in flight must NOT be written back:
  // the save captured `chat` before deleteChat removed it from the store
  // and from disk, so its writeFile + index upsert landed afterwards and
  // resurrected the chat — file and full transcript — in the Recents rail
  // (audit100226 UI-2). Re-checked immediately before the write, which is
  // the last point before anything lands on disk.
  if (!byokChats.has(chat.id)) return;
  try {
    await store.saveChat(chat);
    await store.enforceQuota(BYOK_CHAT_STORAGE_QUOTA_BYTES);
  } catch (error) {
    console.error('BYOK chats: unable to save the chat file:', error);
  }
};

const scheduleSave = (chatId: string, immediate: boolean): void => {
  if (!chatFileStore) return;
  const chat = byokChats.get(chatId);
  if (!chat) return;

  dirtyChatIds.add(chatId);
  if (immediate) {
    dirtyChatIds.delete(chatId);
    // The order of saves follows the update order (the chain keeps the
    // writes from interleaving).
    void saveChatNow(chat);
    return;
  }
  if (flushTimerId !== null) return;
  flushTimerId = setTimeout(() => {
    flushTimerId = null;
    void flushByokChatPersistence();
  }, FLUSH_DEBOUNCE_MS);
};

/**
 * Write every chat marked dirty since the last flush. Called by the
 * debounce and by the best-effort app-closure flush.
 */
export const flushByokChatPersistence = async (): Promise<void> => {
  if (flushTimerId !== null) {
    clearTimeout(flushTimerId);
    flushTimerId = null;
  }
  if (!chatFileStore) return;
  const ids = Array.from(dirtyChatIds);
  dirtyChatIds.clear();
  for (const id of ids) {
    const chat = byokChats.get(id);
    if (chat) await saveChatNow(chat);
  }
};

// Synthetic ids, prefixed so any code can recognize a BYOK chat without
// knowing the store (see isByokAiRequestId in ByokSeam.js).
const generateByokChatId = (): string =>
  'byok-' +
  Date.now().toString(36) +
  '-' +
  Math.random()
    .toString(36)
    .slice(2, 10);

/**
 * Create an empty BYOK chat record (status "working", empty output) and
 * notify the subscribers.
 */
export const createByokChat = (): AiRequest => {
  const chat = createByokAiRequestShell(generateByokChatId());
  byokChats.set(chat.id, chat);
  notifyListeners();
  return chat;
};

/**
 * Get a BYOK chat by id, or null when it does not exist in this session.
 * Archived chats are returned (they are restorable, and the history UI can
 * open them); the default list excludes them.
 */
export const getByokChat = (id: string): AiRequest | null =>
  byokChats.get(id) || null;

/**
 * Store a new version of a BYOK chat (bumping `updatedAt` — the copy of the
 * output array keeps records independent from the orchestrator's mutations)
 * and notify the subscribers. The durable copy follows the save points: a
 * terminal status (ready/error/suspended — "the AI finished") saves right
 * away, everything else (including the user message, which is persisted
 * with status 'working' as its turn starts) goes through the debounce.
 */
export const updateByokChat = (aiRequest: AiRequest): void => {
  if (!byokChats.has(aiRequest.id)) return;

  // An update from the orchestrator (whose record carries no archive
  // marker) must not un-archive the chat: only an explicit `archivedAt`
  // (null included — the restore path) replaces the stored one.
  const existingChat = byokChats.get(aiRequest.id);
  const archivedAt =
    aiRequest.archivedAt !== undefined
      ? aiRequest.archivedAt
      : existingChat
      ? existingChat.archivedAt
      : undefined;
  // The per-chat model/effort selection (Phase 13.1) is preserved the same
  // way (audit011026 B-UI-1): the orchestrator's record diverges from the
  // store copy after the first message, and re-spreading it here used to
  // wipe the selection the bottom-bar dropdown had just written. (The
  // field is a BYOK-local extension of the upstream AiRequest — hence the
  // any-casts, like everywhere else it is read or written.)
  const incomingSelection = (aiRequest: any).byokModelSelection;
  const byokModelSelection =
    incomingSelection !== undefined
      ? incomingSelection
      : existingChat
      ? (existingChat: any).byokModelSelection
      : undefined;

  byokChats.set(
    aiRequest.id,
    (({
      ...aiRequest,
      archivedAt,
      byokModelSelection,
      output: [...(aiRequest.output || [])],
      updatedAt: new Date().toISOString(),
    }: any): AiRequest)
  );
  notifyListeners();
  // A terminal status is one of the save points ("after the AI finishes"):
  // ready, error and suspended save right away; the in-flight updates save
  // through the debounce (which also covers "after every user message",
  // persisted as 'working', and the app closure via the flush hook).
  const isTerminalStatus =
    aiRequest.status === 'ready' ||
    aiRequest.status === 'error' ||
    aiRequest.status === 'suspended';
  scheduleSave(aiRequest.id, isTerminalStatus);
};

/**
 * The non-archived BYOK chats, oldest first.
 */
export const listByokChats = (): Array<AiRequest> =>
  Array.from(byokChats.values()).filter(chat => !chat.archivedAt);

/**
 * Every in-session BYOK chat, archived included (the Recents rail's archived
 * filter of Phase 13.1 lists them alongside the persisted metas).
 */
export const listAllByokChats = (): Array<AiRequest> =>
  Array.from(byokChats.values());

/**
 * Archive a BYOK chat: it disappears from the default list, but stays
 * restorable (the real archive of Phase 9.3 — the durable file keeps the
 * `archivedAt` marker; delete is explicit and separate).
 */
export const archiveByokChat = (id: string): void => {
  const chat = byokChats.get(id);
  if (!chat) return;

  byokChats.set(id, { ...chat, archivedAt: new Date().toISOString() });
  notifyListeners();
  const archivedChat = byokChats.get(id);
  if (archivedChat) scheduleSave(id, true);
  if (archivedChat && archivedChat.archivedAt && chatFileStore) {
    void chatFileStore.setArchived(id, archivedChat.archivedAt).catch(error => {
      console.error('BYOK chats: unable to archive the chat file:', error);
    });
  }
};

/**
 * Restore an archived BYOK chat to the active list.
 */
export const restoreByokChat = (id: string): void => {
  const chat = byokChats.get(id);
  if (!chat) return;

  byokChats.set(id, { ...chat, archivedAt: null });
  notifyListeners();
  if (chatFileStore) {
    void chatFileStore.setArchived(id, null).catch(error => {
      console.error('BYOK chats: unable to restore the chat file:', error);
    });
  }
};

/**
 * Explicitly delete a BYOK chat (its durable file and image sidecar go
 * with it). Archive is not delete: this is the only destructive path.
 */
export const deleteByokChat = async (id: string): Promise<void> => {
  byokChats.delete(id);
  deleteByokOrchestrator(id);
  notifyListeners();
  if (chatFileStore) {
    try {
      await chatFileStore.deleteChat(id);
    } catch (error) {
      console.error('BYOK chats: unable to delete the chat file:', error);
    }
  }
};

/**
 * Put a chat loaded from the durable history back into the session store
 * (the history button's "open"): no status rewrite, no orchestrator — the
 * chat is 'ready' until the user sends a message (which re-attaches one).
 */
export const byokReattachChat = (chat: AiRequest): void => {
  byokChats.set(chat.id, chat);
  notifyListeners();
};

/**
 * Subscribe to any BYOK chat change; returns the unsubscribe function
 * (usable as the cleanup of React.useEffect / useSyncExternalStore).
 */
export const subscribeByokChats = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

// ----------------------------------------------------------------------
// The orchestrators of the BYOK chats, kept at module level (Phase 8.5):
// a chat started from the homepage standalone form must keep running when
// the form's dialog unmounts and the conversation continues in the Ask AI
// tab — whose own seam finds the live orchestrator here.
// ----------------------------------------------------------------------
const byokOrchestrators: Map<string, Object> = new Map();

export const getByokOrchestrator = (chatId: string): ?Object =>
  byokOrchestrators.get(chatId) || null;

export const setByokOrchestrator = (
  chatId: string,
  orchestrator: Object
): void => {
  byokOrchestrators.set(chatId, orchestrator);
};

export const deleteByokOrchestrator = (chatId: string): void => {
  byokOrchestrators.delete(chatId);
};

// The usage trackers of the chats (Phase 9.4/D5): the chat header reads the
// exact token totals beside the BYOK badge. Keyed by chat id, like the
// orchestrators.
const byokUsageTrackers: Map<string, Object> = new Map();

export const setByokUsageTracker = (chatId: string, tracker: Object): void => {
  byokUsageTrackers.set(chatId, tracker);
};

export const getByokUsageTracker = (chatId: string): ?Object =>
  byokUsageTrackers.get(chatId) || null;

export const deleteByokUsageTracker = (chatId: string): void => {
  byokUsageTrackers.delete(chatId);
};

// The chat another surface (the homepage form) asked the Ask AI editor to
// select when it mounts — consumed once.
let pendingByokChatSelectionId: string | null = null;

export const setPendingByokChatSelection = (chatId: string): void => {
  pendingByokChatSelectionId = chatId;
};

export const consumePendingByokChatSelection = (): string | null => {
  const chatId = pendingByokChatSelectionId;
  pendingByokChatSelectionId = null;
  return chatId;
};

/**
 * The chat id the Ask AI editor should select on mount (Phase 13.2): the
 * pending selection another surface asked for (the homepage form's chat) —
 * or, when the editor remounts around a project opening (the tab re-opens
 * in its new pane), the single still-working chat, so a form-started chat's
 * live transcript stays selected and in view. The loop itself never
 * restarts: it lives in the orchestrator registry above.
 */
export const pickByokChatToSelectOnMount = (
  pendingChatId: string | null
): string | null => {
  if (pendingChatId && getByokChat(pendingChatId)) return pendingChatId;
  const workingChats = listByokChats().filter(
    chat => chat.status === 'working'
  );
  if (workingChats.length === 1 && getByokOrchestrator(workingChats[0].id)) {
    return workingChats[0].id;
  }
  return null;
};
