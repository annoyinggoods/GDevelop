// @flow
import type { AiRequest } from '../../Utils/GDevelopServices/Generation';
import { createByokChat, getByokChat, updateByokChat } from './ByokChatStore';

/**
 * The fork / restore points of BYOK chats (Phase 8.6): the safety nets the
 * cloud flow has and a local BYOK chat lacked.
 *
 * - **Fork**: copying a chat's transcript up to a message (inclusive) into
 *   a new, locally-created chat titled "Fork of …" — the local equivalent
 *   of the server's forkAiRequest.
 * - **Restore points**: automatic pre-message project snapshots. Before
 *   every user message that precedes edits, the serialized project is
 *   captured; it is only KEPT when the turn actually edited something
 *   (lazy), capped to the last 5 per chat (size-guarded), and dropped when
 *   the chat closes (no disk growth — persistence is deliberately not
 *   promised here; older points are undo-history's job, not ours).
 *
 * The store is module-level and session-only, like ByokChatStore itself.
 */

/** How many snapshots per chat are kept (the 6th evicts the 1st). */
export const BYOK_PROJECT_SNAPSHOT_CAPACITY = 5;

export type ByokProjectSnapshot = {|
  messageId: string,
  serializedProject: string,
  takenAt: string,
|};

const snapshotsByChatId: Map<string, Array<ByokProjectSnapshot>> = new Map();

/** All the snapshots of a chat, oldest first (empty for an unknown chat). */
export const listByokProjectSnapshots = (
  chatId: string
): Array<ByokProjectSnapshot> => snapshotsByChatId.get(chatId) || [];

/**
 * Store the pre-message snapshot of a chat, evicting the oldest beyond the
 * capacity.
 */
export const takeByokProjectSnapshot = (
  chatId: string,
  messageId: string,
  serializedProject: string
): ByokProjectSnapshot => {
  const snapshots = snapshotsByChatId.get(chatId) || [];
  const snapshot: ByokProjectSnapshot = {
    messageId,
    serializedProject,
    takenAt: new Date().toISOString(),
  };
  snapshots.push(snapshot);
  while (snapshots.length > BYOK_PROJECT_SNAPSHOT_CAPACITY) {
    snapshots.shift();
  }
  snapshotsByChatId.set(chatId, snapshots);
  return snapshot;
};

/** The snapshot taken before this message, or null when there is none. */
export const getByokProjectSnapshot = (
  chatId: string,
  messageId: string
): ByokProjectSnapshot | null =>
  listByokProjectSnapshots(chatId).find(
    snapshot => snapshot.messageId === messageId
  ) || null;

/** Drop every snapshot of a chat (called when the chat closes/is archived). */
export const dropByokChatSnapshots = (chatId: string): void => {
  snapshotsByChatId.delete(chatId);
};

/** Test-only: wipe the whole snapshot store. */
export const resetByokSnapshotsForTests = (): void => {
  snapshotsByChatId.clear();
};

/** The WASM binding — aliased so the single-argument call is explicit. */
const gd: libGDevelop = global.gd;

/**
 * Overwrite the project in place with a snapshot's content — the same
 * single-argument unserializeFrom the IDE's own project loader uses
 * (MainFrame's loadFromSerializedProject). The two-argument form is for
 * other serializables and corrupts a project unserializing itself.
 */
export const restoreByokProjectFromSnapshot = (
  project: any,
  snapshot: ByokProjectSnapshot
): void => {
  const serializedProject = gd.Serializer.fromJSON(snapshot.serializedProject);
  project.unserializeFrom(serializedProject);
  serializedProject.delete();
};

/**
 * Fork a BYOK chat: copy its output up to (and including) the message with
 * this id into a new BYOK chat titled "Fork of …". Returns null when the
 * chat or the message does not exist.
 */
export const forkByokChat = (
  chatId: string,
  upToMessageId: string
): AiRequest | null => {
  const chat = getByokChat(chatId);
  if (!chat) return null;

  const output = chat.output || [];
  const upToIndex = output.findIndex(
    message => message.messageId === upToMessageId
  );
  if (upToIndex === -1) return null;

  const fork = createByokChat();
  fork.title = `Fork of ${chat.title || describeChatFirstMessage(chat)}`;
  fork.forkedFromAiRequestId = chat.id;
  fork.forkedAfterOriginalMessageId = upToMessageId;
  // The copied items keep their original message ids (the fork UI and a
  // later fork of the fork target them); new messages get the fork's own
  // ids from its orchestrator.
  fork.output = output.slice(0, upToIndex + 1).map(message => ({
    ...message,
  }));
  fork.status = 'ready';
  fork.error = null;
  fork.gameId = chat.gameId || null;
  // A fork never inherits the live working state of its parent. Store the
  // shaped record (and notify the subscribers — the history list).
  updateByokChat(fork);
  return fork;
};

/** The first user message text, for titling (the summary's fallback rule). */
const describeChatFirstMessage = (chat: AiRequest): string => {
  const output = chat.output || [];
  const firstMessage = output.length > 0 ? output[0] : null;
  if (
    firstMessage &&
    firstMessage.type === 'message' &&
    firstMessage.role === 'user'
  ) {
    const text = firstMessage.content
      .filter(item => item.type === 'user_request')
      .map(item => item.text)
      .join(' ');
    if (text) {
      return text.length > 40 ? `${text.slice(0, 40)}…` : text;
    }
  }
  return 'a chat';
};
