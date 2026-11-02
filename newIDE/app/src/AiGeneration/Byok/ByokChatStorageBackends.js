// @flow
import optionalRequire from '../../Utils/OptionalRequire';
import type { ByokChatFilesBackend } from './ByokChatPersistence';

/**
 * The platform backends of the durable chat history (Phase 9.3): the
 * desktop app stores the chat files in a folder of the user-data dir
 * (through thin IPC handlers — see electron-app/app/ByokChatFiles.js), the
 * web build stores the same records in IndexedDB (a raw wrapper — no new
 * dependency). Both implement the same dumb named-text-entries contract.
 */

const electron = optionalRequire('electron');
const ipcRenderer = electron ? electron.ipcRenderer : null;

/** The desktop backend: the user-data chats folder through IPC. */
export const createByokIpcChatFilesBackend = (): ByokChatFilesBackend => {
  if (!ipcRenderer) {
    throw new Error('The chat files IPC is only available in the desktop app.');
  }
  const invoke = (channel: string, ...args: Array<any>): Promise<any> =>
    // Errors travel as values (the ByokSafeStorage pattern); a missing
    // handler or a crashed main process rejects — the callers degrade.
    // $FlowFixMe[incompatible-type]
    ipcRenderer.invoke(channel, ...args);

  return {
    listFiles: async () => {
      const result = await invoke('byok-chats-list');
      if (!result || !result.ok) {
        // A FAILED listing must not read as "the folder is empty": the
        // quota sweep deletes every sidecar that looks orphaned, so an
        // empty array on failure wiped every chat's images on any
        // transient userData enumeration error (audit100226 UI-3). Reject,
        // exactly like writeFile/deleteFile.
        throw new Error(result ? result.error : 'The chat file list failed.');
      }
      return result.data;
    },
    readFile: async fileName => {
      const result = await invoke('byok-chats-read', fileName);
      return result && result.ok ? result.data : null;
    },
    writeFile: async (fileName, content) => {
      const result = await invoke('byok-chats-write', fileName, content);
      if (!result || !result.ok) {
        throw new Error(result ? result.error : 'The chat file write failed.');
      }
    },
    deleteFile: async fileName => {
      const result = await invoke('byok-chats-delete', fileName);
      if (!result || !result.ok) {
        throw new Error(result ? result.error : 'The chat file delete failed.');
      }
    },
    moveFile: async (fromFileName, toFileName) => {
      const result = await invoke('byok-chats-move', fromFileName, toFileName);
      if (!result || !result.ok) {
        throw new Error(result ? result.error : 'The chat file move failed.');
      }
    },
    getTotalBytes: async () => {
      const result = await invoke('byok-chats-total-bytes');
      return result && result.ok ? result.data : 0;
    },
  };
};

const IDB_NAME = 'gd-byok-chat-files';
const IDB_STORE_NAME = 'files';
const IDB_VERSION = 1;

type IdbDatabase = {
  transaction(
    storeName: string,
    mode?: 'readonly' | 'readwrite'
  ): {
    objectStore(
      storeName: string
    ): {
      get: (key: string) => any,
      put: (value: any, key: string) => any,
      delete: (key: string) => any,
      getAll: () => any,
    },
  },
  close(): void,
  ...
};

const openIdbDatabase = (idbFactory: any): Promise<IdbDatabase> =>
  new Promise((resolve, reject) => {
    const request = idbFactory.open(IDB_NAME, IDB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(IDB_STORE_NAME)) {
        database.createObjectStore(IDB_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error('IndexedDB open failed.'));
  });

const runIdbRequest = (request: any): Promise<any> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error('IndexedDB request failed.'));
  });

/**
 * The web-build backend: the same records in IndexedDB. Values carry their
 * size and update time, so the quota logic needs no extra storage.
 */
export const createByokIdbChatFilesBackend = ({
  idbFactory,
}: {|
  idbFactory?: any,
|} = {}): ByokChatFilesBackend => {
  const factory = idbFactory || global.indexedDB;
  if (!factory) {
    throw new Error('IndexedDB is not available.');
  }
  let databasePromise: ?Promise<IdbDatabase> = null;
  const getDatabase = (): Promise<IdbDatabase> => {
    if (!databasePromise) databasePromise = openIdbDatabase(factory);
    return databasePromise;
  };

  return {
    listFiles: async () => {
      const database = await getDatabase();
      const values = await runIdbRequest(
        database
          .transaction(IDB_STORE_NAME, 'readonly')
          .objectStore(IDB_STORE_NAME)
          .getAll()
      );
      return (values || []).map(value => ({
        fileName: value.fileName,
        sizeBytes: typeof value.content === 'string' ? value.content.length : 0,
      }));
    },
    readFile: async fileName => {
      const database = await getDatabase();
      const value = await runIdbRequest(
        database
          .transaction(IDB_STORE_NAME, 'readonly')
          .objectStore(IDB_STORE_NAME)
          .get(fileName)
      );
      return value ? value.content : null;
    },
    writeFile: async (fileName, content) => {
      const database = await getDatabase();
      await runIdbRequest(
        database
          .transaction(IDB_STORE_NAME, 'readwrite')
          .objectStore(IDB_STORE_NAME)
          .put({ fileName, content, updatedAt: Date.now() }, fileName)
      );
    },
    deleteFile: async fileName => {
      const database = await getDatabase();
      await runIdbRequest(
        database
          .transaction(IDB_STORE_NAME, 'readwrite')
          .objectStore(IDB_STORE_NAME)
          .delete(fileName)
      );
    },
    moveFile: async (fromFileName, toFileName) => {
      const database = await getDatabase();
      const store = database
        .transaction(IDB_STORE_NAME, 'readwrite')
        .objectStore(IDB_STORE_NAME);
      const value = await runIdbRequest(store.get(fromFileName));
      if (!value) return;
      await runIdbRequest(
        store.put(
          {
            fileName: toFileName,
            content: value.content,
            updatedAt: Date.now(),
          },
          toFileName
        )
      );
      await runIdbRequest(store.delete(fromFileName));
    },
    getTotalBytes: async () => {
      const database = await getDatabase();
      const values = await runIdbRequest(
        database
          .transaction(IDB_STORE_NAME, 'readonly')
          .objectStore(IDB_STORE_NAME)
          .getAll()
      );
      return (values || []).reduce(
        (total, value) =>
          total +
          (typeof value.content === 'string' ? value.content.length : 0),
        0
      );
    },
  };
};

/**
 * The backend for this platform: IPC files on the desktop app, IndexedDB on
 * the web build. Null when neither is available (tests, exotic embedders) —
 * the caller then keeps the session-only store.
 */
export const createByokChatFilesBackendForPlatform = (): ?ByokChatFilesBackend => {
  if (ipcRenderer) {
    try {
      return createByokIpcChatFilesBackend();
    } catch (error) {
      return null;
    }
  }
  try {
    return createByokIdbChatFilesBackend();
  } catch (error) {
    return null;
  }
};
