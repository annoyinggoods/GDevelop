// @flow
import {
  type AiRequest,
  type AiRequestMessage,
} from '../../Utils/GDevelopServices/Generation';
import { restoreByokImage } from './ByokImageContent';

/**
 * The durable chat history (Phase 9.3, owner decision #1 — the contract):
 * chats are saved to human-readable files (Markdown with a YAML front
 * matter block — chosen over pure YAML because the file then renders
 * nicely for a future "open chat file" UX, while the front matter keeps
 * the list data lossless), after every user message, when the AI finishes
 * and on app closure (the store's flush). Transcript images stay
 * id-referenced; their payloads live in per-chat `.images.json` sidecar
 * entries, never inline in the text file.
 *
 * The module owns the file format, the naming convention (first 5 words of
 * the first prompt + the date of the last interaction), the corruption
 * quarantine (a file that fails shape validation moves aside, never blocks
 * the list) and the storage quota (image sidecars of the oldest chats are
 * evicted before any transcript text). The platform backends — Electron
 * files through IPC on desktop, IndexedDB on the web build — are injected.
 *
 * Since audit011026 B-UI-13 the store keeps an id→fileName index (a small
 * reserved `index.json` written through the same backend): steady-state
 * listings and per-chat operations resolve through it instead of
 * re-reading and re-parsing every chat file — toward the 200 MB quota that
 * made each save and each rail action O(total-bytes). The chat files stay
 * the source of truth: a missing, stale or corrupt index is healed by
 * reconciliation (parse the unindexed files once, drop the stale entries).
 */

export const BYOK_CHAT_FILE_SCHEMA = 1;

// The index of the saved chats (audit011026 B-UI-13), versioned like the
// chat files themselves.
export const BYOK_CHAT_INDEX_SCHEMA = 1;

// Reserved name — naturally excluded from the chat listing (not a `.md`
// file), from the quarantined files (no `corrupt-` prefix) and from the
// image sidecars (not a `.images.json` file).
export const BYOK_CHAT_INDEX_FILE_NAME = 'index.json';

export type ByokChatFileMeta = {|
  id: string,
  fileName: string,
  name: string,
  createdAt: string,
  updatedAt: string,
  archivedAt: string | null,
  messageCount: number,
|};

/** One file of the storage, as the backends report it. */
export type ByokChatStorageFile = {|
  fileName: string,
  sizeBytes: number,
|};

/**
 * The platform file storage, kept deliberately dumb: named text entries,
 * no structure knowledge. The desktop backend maps it to a folder under
 * the user-data dir (through IPC), the web backend to IndexedDB.
 */
export type ByokChatFilesBackend = {|
  listFiles: () => Promise<Array<ByokChatStorageFile>>,
  readFile: (fileName: string) => Promise<string | null>,
  writeFile: (fileName: string, content: string) => Promise<void>,
  deleteFile: (fileName: string) => Promise<void>,
  moveFile: (fromFileName: string, toFileName: string) => Promise<void>,
  getTotalBytes: () => Promise<number>,
|};

const CHAT_FILE_EXTENSION = '.md';
const IMAGES_FILE_SUFFIX = '.images.json';
const QUARANTINE_PREFIX = 'corrupt-';

// ----------------------------------------------------------------------
// The Markdown codec (pure functions — the heart of the round-trip).
// ----------------------------------------------------------------------

const FRONT_MATTER_FIELDS = [
  'schema',
  'id',
  'name',
  'createdAt',
  'updatedAt',
  'archivedAt',
  'messageCount',
];

const stringifyFrontMatterValue = (value: string | number | null): string =>
  JSON.stringify(value === null ? null : String(value));

/**
 * The chat's display name: the first 5 words of the chat's first prompt +
 * the date of the last interaction (the owner's convention, decision #1).
 */
export const makeByokChatName = (chat: AiRequest): string => {
  const output = chat.output || [];
  let firstPrompt = chat.title || '';
  if (!firstPrompt) {
    for (const message of output) {
      if (message.type !== 'message' || message.role !== 'user') continue;
      const item = message.content.find(
        contentItem => contentItem.type === 'user_request'
      );
      if (item && item.text) {
        firstPrompt = item.text;
        break;
      }
    }
  }
  const firstFiveWords = firstPrompt
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
  const lastInteractionDate = (chat.updatedAt || chat.createdAt || '').slice(
    0,
    10
  );
  const name =
    (firstFiveWords || 'chat') +
    (lastInteractionDate ? `_${lastInteractionDate}` : '');
  return name;
};

/**
 * Make a file-system-safe file name out of a chat name AND its chat id
 * (audit011026 B-UI-3): two same-day chats sharing their first five words
 * ("make me a platformer…") used to derive the same file name and silently
 * overwrote each other's history — the id makes every chat's file unique,
 * the readable name stays the prefix.
 */
export const makeByokChatFileName = (
  chatName: string,
  chatId: string
): string => {
  const safeName = chatName
    .replace(/[\\/:*?"<>|#%&{}$!'@+`=\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const safeChatId = chatId.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 40);
  return `${safeName || 'chat'}-${safeChatId ||
    'unnamed'}${CHAT_FILE_EXTENSION}`;
};

/**
 * Serialize a chat to its Markdown file: YAML front matter for the list
 * data, then one JSON block per transcript message, each preceded by a
 * readable header line (role + a one-line preview) so the file can be read
 * like a transcript.
 */
export const serializeByokChatToMarkdown = (chat: AiRequest): string => {
  const name = makeByokChatName(chat);
  const messages = chat.output || [];
  const frontMatterLines = [
    '---',
    `schema: ${stringifyFrontMatterValue(BYOK_CHAT_FILE_SCHEMA)}`,
    `id: ${stringifyFrontMatterValue(chat.id)}`,
    `name: ${stringifyFrontMatterValue(name)}`,
    `createdAt: ${stringifyFrontMatterValue(chat.createdAt)}`,
    `updatedAt: ${stringifyFrontMatterValue(chat.updatedAt)}`,
    `archivedAt: ${stringifyFrontMatterValue(chat.archivedAt || null)}`,
    `messageCount: ${stringifyFrontMatterValue(messages.length)}`,
    '---',
    '',
    `# BYOK chat: ${name}`,
    '',
  ];

  const bodyLines: Array<string> = [];
  messages.forEach((message, index) => {
    const role = message.type === 'message' ? message.role : 'tool';
    const preview =
      message.type === 'function_call_output'
        ? message.output.slice(0, 100)
        : message.type === 'message'
        ? message.content
            .map(contentItem => ('text' in contentItem ? contentItem.text : ''))
            .join(' ')
            .slice(0, 100)
        : '';
    bodyLines.push(
      `## message ${index} — ${role}${
        preview ? ` — ${preview.replace(/\n/g, ' ').replace(/`/g, "'")}` : ''
      }`,
      '',
      '```json',
      // Backticks are escaped so a message that QUOTES markdown (e.g. an
      // assistant answer containing a ```json fence) can never break the
      // envelope: JSON.parse turns \u0060 back into a backtick losslessly.
      JSON.stringify(message).replace(/`/g, '\\u0060'),
      '```',
      ''
    );
  });

  return [...frontMatterLines, ...bodyLines].join('\n');
};

/**
 * Parse a Markdown chat file back into an `AiRequest` record, or null when
 * the file is not a well-shaped BYOK chat file (the caller quarantines it).
 * Every transcript message is re-validated minimally: it must be an object
 * with a `type` the transcript knows.
 */
export const parseByokChatFromMarkdown = (content: string): ?AiRequest => {
  if (!content.startsWith('---')) return null;

  const frontMatterEnd = content.indexOf('\n---', 3);
  if (frontMatterEnd === -1) return null;

  const frontMatterText = content.slice(3, frontMatterEnd);
  const body = content.slice(frontMatterEnd + 4);

  const fields: Map<string, string> = new Map();
  for (const line of frontMatterText.split('\n')) {
    const match = /^(\w+): (.*)$/.exec(line.trim());
    if (!match) continue;
    try {
      const parsedValue = JSON.parse(match[2]);
      if (parsedValue === null || typeof parsedValue === 'string') {
        fields.set(match[1], parsedValue);
      }
    } catch (error) {
      return null;
    }
  }

  for (const field of FRONT_MATTER_FIELDS) {
    if (!fields.has(field) && field !== 'archivedAt') return null;
  }

  const id = fields.get('id');
  if (!id) return null;

  const chat: AiRequest = {
    id,
    title: fields.get('name') || null,
    createdAt: fields.get('createdAt') || new Date().toISOString(),
    updatedAt: fields.get('updatedAt') || new Date().toISOString(),
    userId: '',
    status: 'ready',
    mode: 'orchestrator',
    error: null,
    output: [],
    contextStats: null,
    archivedAt: fields.get('archivedAt') || null,
  };

  const messageBlocks = body.split('```json');
  // Every segment after the first starts right after a ```json opener:
  // each of them holds one message followed by its closing fence.
  for (let index = 1; index < messageBlocks.length; index++) {
    const jsonText = messageBlocks[index];
    const closingFence = jsonText.indexOf('```');
    if (closingFence === -1) return null;
    let message: mixed = null;
    try {
      message = JSON.parse(jsonText.slice(0, closingFence));
    } catch (error) {
      return null;
    }
    if (!message || typeof message !== 'object') return null;
    const record: Object = message;
    if (
      record.type !== 'message' &&
      record.type !== 'function_call_output' &&
      record.type !== 'byok_notice'
    ) {
      return null;
    }
    ((chat.output: any): Array<AiRequestMessage>).push(record);
  }

  const declaredMessageCount = Number(fields.get('messageCount'));
  if (
    Number.isFinite(declaredMessageCount) &&
    chat.output &&
    chat.output.length !== declaredMessageCount
  ) {
    return null;
  }

  return chat;
};

// ----------------------------------------------------------------------
// Naming and lookup helpers.
// ----------------------------------------------------------------------

const imagesFileNameForChatId = (chatId: string): string =>
  `${chatId}${IMAGES_FILE_SUFFIX}`;

export const makeByokImagesFileName = imagesFileNameForChatId;

/**
 * Serialize the image sidecar entries of a chat: the payloads the
 * transcript's `images` ids point to. Sidecars are per chat, never inline
 * in the Markdown file.
 */
export const collectByokChatImageEntries = (
  chat: AiRequest,
  // Inexact on purpose: the real store hands back richer image infos.
  getImageById: (
    id: string
  ) => ?{
    dataUrl: string,
    width: number,
    height: number,
    approxTokens: number,
    ...
  }
): {
  [imageId: string]: {|
    dataUrl: string,
    width: number,
    height: number,
    approxTokens: number,
  |},
} => {
  // Built through any: the values come from the image store (any-typed).
  const entries: { [imageId: string]: any } = {};
  const output = chat.output || [];
  for (const message of output) {
    // Both referencing kinds count (tool outputs and the user messages'
    // attached images, Phase 13.3) — anything the transcript points at must
    // survive a reload.
    const images = (message: any).images;
    if (!Array.isArray(images)) continue;
    for (const imageId of images) {
      if (typeof imageId !== 'string' || entries[imageId]) continue;
      const image = getImageById(imageId);
      if (image) entries[imageId] = image;
    }
  }
  return entries;
};

/**
 * Persist a chat's image sidecar, or DELETE it when the chat has no image
 * left. A chat whose images were all evicted (by the quota sweep, or by a
 * compaction dropping the references) kept a stale sidecar forever: the
 * orphan sweep spares sidecars of chats that still exist, and the eviction
 * only runs while over quota, so nothing else ever removed it — and its
 * bytes counted against the quota (audit100226 UI-8).
 */
const writeOrDeleteChatImageSidecar = async (
  chatId: string,
  imageEntries: { [imageId: string]: any },
  backend: ByokChatFilesBackend
): Promise<void> => {
  const sidecarFileName = imagesFileNameForChatId(chatId);
  const hasImages = Object.keys(imageEntries).length > 0;
  if (hasImages) {
    await backend.writeFile(
      sidecarFileName,
      JSON.stringify({ images: imageEntries })
    );
    return;
  }
  await backend.deleteFile(sidecarFileName).catch(() => {});
};

/**
 * Move a chat file to a new name, and report the name the chat actually
 * ended up under. The old file must NOT survive a failed move: the index
 * entry then points at the new name while the old one sits on disk, and
 * reconciliation adopts that leftover as a second entry for the same chat —
 * the chat appears twice in the Recents rail and one copy is orphaned
 * forever (audit100226 UI-6). So a failed move keeps the current name.
 */
const moveChatFileTo = async (
  entry: ?ByokChatFileMeta,
  desiredFileName: string,
  backend: ByokChatFilesBackend
): Promise<string> => {
  if (!entry || entry.fileName === desiredFileName) return desiredFileName;
  try {
    await backend.moveFile(entry.fileName, desiredFileName);
  } catch (error) {
    // Locked by another process, or the folder moved under us: the chat is
    // saved under the name it already had rather than duplicated.
    return entry.fileName;
  }
  // The backend reports a failed move as a rejection, but a backend that
  // resolves `false` (a custom one) must not silently duplicate either.
  const oldFileStillThere = await backend.readFile(entry.fileName);
  if (oldFileStillThere !== null) return entry.fileName;
  return desiredFileName;
};

// ----------------------------------------------------------------------
// The chat index (audit011026 B-UI-13).
// ----------------------------------------------------------------------

const isChatFileName = (fileName: string): boolean =>
  fileName.endsWith(CHAT_FILE_EXTENSION) &&
  !fileName.startsWith(QUARANTINE_PREFIX);

/**
 * The index entry of a chat: exactly the metas `listChatMetas` returns
 * (computed once at save/reconciliation time instead of on every listing).
 */
export const makeByokChatIndexEntryFromChat = (
  fileName: string,
  chat: AiRequest
): ByokChatFileMeta => ({
  id: chat.id,
  fileName,
  name: chat.title || makeByokChatName(chat),
  createdAt: chat.createdAt,
  updatedAt: chat.updatedAt,
  archivedAt: chat.archivedAt || null,
  messageCount: chat.output ? chat.output.length : 0,
});

/** Newest-updated first — exactly the order the listing always had. */
export const sortChatIndexEntries = (
  entries: Array<ByokChatFileMeta>
): Array<ByokChatFileMeta> =>
  [...entries].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

const isByokChatIndexEntryShape = (value: mixed): boolean => {
  if (!value || typeof value !== 'object') return false;
  // Built through any: the values come from JSON.parse of the index file.
  const record: any = value;
  if (typeof record.id !== 'string' || !record.id) return false;
  if (typeof record.fileName !== 'string' || !record.fileName) return false;
  if (typeof record.name !== 'string') return false;
  if (typeof record.createdAt !== 'string') return false;
  if (typeof record.updatedAt !== 'string') return false;
  if (record.archivedAt !== null && typeof record.archivedAt !== 'string') {
    return false;
  }
  return typeof record.messageCount === 'number';
};

/**
 * Parse the persisted index, or null when it is missing, unparseable or
 * foreign-shaped — the caller then rebuilds it from the chat files (the
 * index is a cache; the files stay the source of truth). One malformed
 * entry invalidates the whole index: the rebuild is cheap and total.
 */
export const parseByokChatIndex = (
  content: string | null
): Array<ByokChatFileMeta> | null => {
  if (!content) return null;
  let parsed: mixed = null;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record: any = parsed;
  if (record.schema !== BYOK_CHAT_INDEX_SCHEMA) return null;
  if (!Array.isArray(record.entries)) return null;
  const entries: Array<ByokChatFileMeta> = [];
  for (const entry of record.entries) {
    if (!isByokChatIndexEntryShape(entry)) return null;
    entries.push(entry);
  }
  return entries;
};

export const serializeByokChatIndex = (
  entries: Array<ByokChatFileMeta>
): string => JSON.stringify({ schema: BYOK_CHAT_INDEX_SCHEMA, entries });

// ----------------------------------------------------------------------
// The file store over a backend.
// ----------------------------------------------------------------------

export type ByokStorageUsage = {|
  totalBytes: number,
  imageBytes: number,
|};

export type ByokQuotaOutcome = {|
  evictedImageChatCount: number,
  evictedChatCount: number,
|};

export type ByokChatFileStore = {|
  /** The saved chats, most recently updated first (metadata only). */
  listChatMetas: () => Promise<Array<ByokChatFileMeta>>,
  /** Load a full chat (and re-register its images). Null when unknown. */
  loadChat: (chatId: string) => Promise<AiRequest | null>,
  /** Write a chat's file + image sidecar; returns the file name used. */
  saveChat: (chat: AiRequest) => Promise<string>,
  /** Archive or unarchive a saved chat. */
  setArchived: (chatId: string, archivedAt: string | null) => Promise<boolean>,
  /** Rename a saved chat (the file moves to the new name). */
  renameChat: (chatId: string, title: string) => Promise<boolean>,
  /** Explicit delete (archive is not delete). */
  deleteChat: (chatId: string) => Promise<boolean>,
  /** Total bytes used, split between transcripts and image sidecars. */
  getStorageUsage: () => Promise<ByokStorageUsage>,
  /**
   * Make the storage fit the cap: image sidecars of the oldest chats are
   * evicted first; whole chats only as the last resort.
   */
  enforceQuota: (capBytes: number) => Promise<ByokQuotaOutcome>,
|};

export const createByokChatFileStore = (
  backend: ByokChatFilesBackend,
  // Inexact on purpose: the real store hands back richer image infos.
  getImageById: (
    id: string
  ) => ?{
    dataUrl: string,
    width: number,
    height: number,
    approxTokens: number,
    ...
  }
): ByokChatFileStore => {
  // The chat index (B-UI-13): loaded once per store, kept in memory as the
  // working copy, persisted through the backend like any other file. The
  // chat files stay the source of truth — a lost or stale index is healed
  // by reconciliation, so a crash between a chat write and the index write
  // never loses a chat (the file is simply re-parsed on the next pass).
  let chatIndexEntries: Array<ByokChatFileMeta> | null = null;
  let chatIndexExistsOnDisk = false;
  let chatIndexLoadPromise: Promise<void> | null = null;

  const writeChatIndexToDisk = async (): Promise<void> => {
    if (!chatIndexEntries) return;
    await backend.writeFile(
      BYOK_CHAT_INDEX_FILE_NAME,
      serializeByokChatIndex(chatIndexEntries)
    );
    chatIndexExistsOnDisk = true;
  };

  /**
   * Parse one chat file into an index entry; a file that fails shape
   * validation is quarantined (moved aside, never blocking the list) —
   * exactly the pre-index policy.
   */
  const parseChatFileForIndex = async (
    fileName: string
  ): Promise<ByokChatFileMeta | null> => {
    const content = await backend.readFile(fileName);
    if (content === null) return null;
    const chat = parseByokChatFromMarkdown(content);
    if (chat) return makeByokChatIndexEntryFromChat(fileName, chat);
    // Quarantine: move aside, never block the list.
    await backend
      .moveFile(fileName, `${QUARANTINE_PREFIX}${fileName}`)
      .catch(() => {});
    return null;
  };

  /**
   * Reconcile the in-memory index with the disk over a STAT-ONLY listing:
   * entries whose chat file is gone are dropped, chat files the index
   * never saw (first run after the upgrade, a crash between the chat write
   * and the index write, legacy files whose names predate the id
   * embedding) are parsed just once and adopted. Returns the listing for
   * the callers that need the file sizes. The reconciled index is
   * persisted only when reconciliation actually changed it — and only for
   * the callers that pass persistChanges: quota enforcement adopts the
   * entries in memory but never writes, so it cannot add bytes to the
   * very storage it is trimming.
   */
  const reconcileChatIndex = async (
    persistChanges: boolean
  ): Promise<Array<ByokChatStorageFile>> => {
    const files = await backend.listFiles();
    const fileNamesOnDisk = new Set(files.map(file => file.fileName));
    const previousEntries = chatIndexEntries || [];
    const keptEntries = previousEntries.filter(entry =>
      fileNamesOnDisk.has(entry.fileName)
    );
    const indexedFileNames = new Set(keptEntries.map(entry => entry.fileName));
    const freshEntries: Array<ByokChatFileMeta> = [];
    for (const file of files) {
      if (!isChatFileName(file.fileName)) continue;
      if (indexedFileNames.has(file.fileName)) continue;
      const entry = await parseChatFileForIndex(file.fileName);
      if (entry) freshEntries.push(entry);
    }
    const anythingChanged =
      keptEntries.length !== previousEntries.length || freshEntries.length > 0;
    if (anythingChanged) {
      chatIndexEntries = sortChatIndexEntries([
        ...keptEntries,
        ...freshEntries,
      ]);
      if (persistChanges) await writeChatIndexToDisk().catch(() => {});
    }
    return files;
  };

  const loadChatIndexOnce = async (): Promise<void> => {
    if (chatIndexEntries) return;
    if (chatIndexLoadPromise) {
      await chatIndexLoadPromise;
      return;
    }
    const loadPromise = (async () => {
      const content = await backend.readFile(BYOK_CHAT_INDEX_FILE_NAME);
      chatIndexExistsOnDisk = content !== null;
      const entries = parseByokChatIndex(content);
      if (entries) {
        chatIndexEntries = entries;
        return;
      }
      // Missing or corrupt index: silent full rebuild from the chat files.
      chatIndexEntries = [];
      await reconcileChatIndex(true);
    })();
    chatIndexLoadPromise = loadPromise;
    try {
      await loadPromise;
    } finally {
      // Also on rejection: a failed load must not poison later calls.
      chatIndexLoadPromise = null;
    }
  };

  /**
   * Resolve a chat id through the index. A miss triggers one stat-only
   * reconciliation first — an id that exists on disk but not in the index
   * (legacy file, crash window) is found and adopted that way, exactly as
   * the old parse-everything lookup would have found it.
   */
  const findChatIndexEntry = async (
    chatId: string
  ): Promise<ByokChatFileMeta | null> => {
    await loadChatIndexOnce();
    const directEntry =
      (chatIndexEntries || []).find(entry => entry.id === chatId) || null;
    if (directEntry) return directEntry;
    await reconcileChatIndex(true);
    return (chatIndexEntries || []).find(entry => entry.id === chatId) || null;
  };

  const removeChatIndexEntry = async (fileName: string): Promise<void> => {
    // A local const: Flow invalidates the null-narrowing of the captured
    // `chatIndexEntries` at the first call below.
    const entries = chatIndexEntries;
    if (!entries) return;
    const remainingEntries = entries.filter(
      entry => entry.fileName !== fileName
    );
    if (remainingEntries.length === entries.length) return;
    chatIndexEntries = remainingEntries;
    if (chatIndexExistsOnDisk) await writeChatIndexToDisk().catch(() => {});
  };

  /**
   * Read one indexed chat file back. A file that no longer parses (or is
   * gone) is quarantined/dropped from the index and reported as absent —
   * the callers then behave exactly like the old code, whose listing
   * quarantined the file before the lookup returned null.
   */
  const readIndexedChatFile = async (
    entry: ByokChatFileMeta
  ): Promise<{| fileName: string, chat: AiRequest |} | null> => {
    const content = await backend.readFile(entry.fileName);
    if (content === null) {
      await removeChatIndexEntry(entry.fileName);
      return null;
    }
    const chat = parseByokChatFromMarkdown(content);
    if (chat) return { fileName: entry.fileName, chat };
    // Quarantine: move aside, never block the store.
    await backend
      .moveFile(entry.fileName, `${QUARANTINE_PREFIX}${entry.fileName}`)
      .catch(() => {});
    await removeChatIndexEntry(entry.fileName);
    return null;
  };

  /**
   * Record a chat's current metas in the index (replacing the first entry
   * of the same id, appending when new). Mutations keep an EXISTING index
   * file up to date but never create one — creation is reconciliation's
   * job (a store that only saves never pays an index write, and a crash
   * before a rewrite is healed by the next reconciliation).
   */
  const upsertChatIndexEntry = async (
    entry: ByokChatFileMeta
  ): Promise<void> => {
    const entries = chatIndexEntries || [];
    const existingPosition = entries.findIndex(
      candidate => candidate.id === entry.id
    );
    const nextEntries =
      existingPosition === -1
        ? [...entries, entry]
        : entries.map((candidate, position) =>
            position === existingPosition ? entry : candidate
          );
    chatIndexEntries = sortChatIndexEntries(nextEntries);
    if (chatIndexExistsOnDisk) await writeChatIndexToDisk().catch(() => {});
  };

  return {
    listChatMetas: async (): Promise<Array<ByokChatFileMeta>> => {
      await loadChatIndexOnce();
      await reconcileChatIndex(true);
      return (chatIndexEntries || []).map(entry => ({ ...entry }));
    },

    loadChat: async (chatId: string): Promise<AiRequest | null> => {
      const entry = await findChatIndexEntry(chatId);
      if (!entry) return null;
      const chatFile = await readIndexedChatFile(entry);
      if (!chatFile) return null;

      // The image sidecar (best-effort): restore the payloads under their
      // original ids so the transcript references resolve again.
      try {
        const imagesContent = await backend.readFile(
          imagesFileNameForChatId(chatId)
        );
        if (imagesContent) {
          const parsed = JSON.parse(imagesContent);
          if (parsed && typeof parsed === 'object' && parsed.images) {
            for (const imageId of Object.keys(parsed.images)) {
              restoreByokImage(parsed.images[imageId]);
            }
          }
        }
      } catch (error) {
        // Images stay unresolved (placeholder notes at replay); the
        // transcript itself is intact.
      }

      return chatFile.chat;
    },

    saveChat: async (chat: AiRequest): Promise<string> => {
      const entry = await findChatIndexEntry(chat.id);
      const chatName = makeByokChatName(chat);
      const desiredFileName = makeByokChatFileName(chatName, chat.id);

      // The name carries the last-interaction date: a saved chat whose
      // name changed moves to the new file name. The move is verified: a
      // FAILED move used to be swallowed, the new file was written next to
      // the old one, and reconciliation then adopted the leftover as a
      // SECOND entry for the same chat — the chat showed up twice in the
      // rail (audit100226 UI-6). When the move cannot happen, the chat stays
      // under its current file name instead.
      const effectiveFileName = await moveChatFileTo(
        entry,
        desiredFileName,
        backend
      );

      const content = serializeByokChatToMarkdown(chat);
      const imageEntries = collectByokChatImageEntries(chat, getImageById);
      await backend.writeFile(effectiveFileName, content);
      await writeOrDeleteChatImageSidecar(chat.id, imageEntries, backend);
      // The chat file is written FIRST, the index after — a crash in
      // between is covered by reconciliation (B-UI-13).
      await upsertChatIndexEntry(
        makeByokChatIndexEntryFromChat(effectiveFileName, chat)
      );
      return effectiveFileName;
    },

    setArchived: async (
      chatId: string,
      archivedAt: string | null
    ): Promise<boolean> => {
      const entry = await findChatIndexEntry(chatId);
      if (!entry) return false;
      const chatFile = await readIndexedChatFile(entry);
      if (!chatFile) return false;
      const chat = chatFile.chat;
      chat.archivedAt = archivedAt;
      await backend.writeFile(
        entry.fileName,
        serializeByokChatToMarkdown(chat)
      );
      await upsertChatIndexEntry(
        makeByokChatIndexEntryFromChat(entry.fileName, chat)
      );
      return true;
    },

    renameChat: async (chatId: string, title: string): Promise<boolean> => {
      const entry = await findChatIndexEntry(chatId);
      if (!entry) return false;
      const chatFile = await readIndexedChatFile(entry);
      if (!chatFile) return false;
      const chat = chatFile.chat;
      chat.title = title;
      // The display name drives the file name: after retitling, the chat
      // moves (the first prompt is overridden by the explicit title).
      const desiredFileName = makeByokChatFileName(title, chatId);
      const effectiveFileName = await moveChatFileTo(
        entry,
        desiredFileName,
        backend
      );
      await backend.writeFile(
        effectiveFileName,
        serializeByokChatToMarkdown(chat)
      );
      await upsertChatIndexEntry(
        makeByokChatIndexEntryFromChat(effectiveFileName, chat)
      );
      return true;
    },

    deleteChat: async (chatId: string): Promise<boolean> => {
      const entry = await findChatIndexEntry(chatId);
      if (!entry) return false;
      await backend.deleteFile(entry.fileName);
      await backend.deleteFile(imagesFileNameForChatId(chatId)).catch(() => {});
      await removeChatIndexEntry(entry.fileName);
      return true;
    },

    getStorageUsage: async () => {
      const files = await backend.listFiles();
      let totalBytes = 0;
      let imageBytes = 0;
      for (const file of files) {
        totalBytes += file.sizeBytes;
        if (file.fileName.endsWith(IMAGES_FILE_SUFFIX)) {
          imageBytes += file.sizeBytes;
        }
      }
      return { totalBytes, imageBytes };
    },

    enforceQuota: async (capBytes: number) => {
      let evictedImageChatCount = 0;
      let evictedChatCount = 0;

      // Orphaned image sidecars are swept FIRST (audit011026 B-UI-4): a
      // sidecar whose .md is gone (a crash between the two deletes of
      // deleteChat, or a lost name collision) was never enumerated by the
      // chat-based loops below, yet counted against the quota forever.
      // The chat enumeration is index-driven (B-UI-13): no chat content
      // is read here.
      await loadChatIndexOnce();
      const files = await reconcileChatIndex(false);
      const chatEntries = chatIndexEntries || [];
      const listedChatIds = new Set(chatEntries.map(entry => entry.id));
      // Belt and braces with the backend fix: an index that HAD entries and
      // reconciled to zero means the listing failed (or vanished), not that
      // every sidecar is suddenly orphaned. Deleting them there wiped every
      // chat's images on a transient enumeration error (audit100226 UI-3).
      const listingIsTrustworthy = listedChatIds.size > 0;
      if (listingIsTrustworthy) {
        for (const file of files) {
          if (!file.fileName.endsWith(IMAGES_FILE_SUFFIX)) continue;
          const chatIdOfSidecar = file.fileName.slice(
            0,
            -IMAGES_FILE_SUFFIX.length
          );
          if (listedChatIds.has(chatIdOfSidecar)) continue;
          await backend.deleteFile(file.fileName).catch(() => {});
          evictedImageChatCount++;
        }
      }

      let totalBytes = await backend.getTotalBytes();
      if (totalBytes <= capBytes) {
        return { evictedImageChatCount, evictedChatCount };
      }

      // Oldest chats first (the index is newest first). Sidecar sizes come
      // from the stat-only listing — no content read (B-UI-13).
      const sizeByFileName = new Map(
        files.map(file => [file.fileName, file.sizeBytes])
      );
      const oldestFirstEntries = [...chatEntries].reverse();
      for (const entry of oldestFirstEntries) {
        if (totalBytes <= capBytes) break;
        const imagesFile = imagesFileNameForChatId(entry.id);
        const imagesBytes = sizeByFileName.get(imagesFile);
        if (imagesBytes === undefined) continue;
        await backend.deleteFile(imagesFile);
        totalBytes -= imagesBytes;
        evictedImageChatCount++;
      }

      // Still over with no image left: the oldest whole chats go (the
      // last resort — transcript text is lost only here).
      for (const entry of oldestFirstEntries) {
        totalBytes = await backend.getTotalBytes();
        if (totalBytes <= capBytes) break;
        await backend.deleteFile(entry.fileName);
        await backend
          .deleteFile(imagesFileNameForChatId(entry.id))
          .catch(() => {});
        evictedChatCount++;
      }

      // Last resort: files that are NOT chats — quarantined (unparseable)
      // Markdown and the index itself. They counted against the quota from
      // the first check but neither loop above can ever select them, so a
      // folder holding only those stayed over quota forever while every save
      // re-ran a futile sweep (audit100226 UI-7). The index is a rebuildable
      // cache (reconciliation recreates it), so it goes last.
      const evictableNonChatFiles = files.filter(
        file =>
          !isChatFileName(file.fileName) &&
          !file.fileName.endsWith(IMAGES_FILE_SUFFIX)
      );
      for (const file of evictableNonChatFiles) {
        if (file.fileName === BYOK_CHAT_INDEX_FILE_NAME) continue;
        if (totalBytes <= capBytes) break;
        await backend.deleteFile(file.fileName).catch(() => {});
        totalBytes -= file.sizeBytes;
      }
      if (
        totalBytes > capBytes &&
        files.some(file => file.fileName === BYOK_CHAT_INDEX_FILE_NAME)
      ) {
        await backend.deleteFile(BYOK_CHAT_INDEX_FILE_NAME).catch(() => {});
      }

      totalBytes = await backend.getTotalBytes();

      return { evictedImageChatCount, evictedChatCount };
    },
  };
};
