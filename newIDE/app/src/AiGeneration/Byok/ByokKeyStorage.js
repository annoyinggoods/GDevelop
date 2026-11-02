// @flow
import optionalRequire from '../../Utils/OptionalRequire';

// The API key is stored in localStorage, but never in plaintext:
// - On the desktop app, it is encrypted by the operating system through the
//   main process (Electron safeStorage — DPAPI on Windows), which is the only
//   side able to decrypt it. Stored as `{ version: 3, value }`.
// - On the web build, it is only obfuscated: base64(xor(key, pepper)). This is
//   **obfuscation, not encryption** — a determined reader of localStorage
//   (with this file open in front of them) can recover the key. It only makes
//   casual reading of the storage impossible. Stored as `{ version: 2, value }`.
// The interface below is final: the storage internals changed in Phase 3
// without the UI or the interface ever changing.
// Since Phase 9.4 the keys are slotted per provider: the legacy slot
// (`keyRef: ''`) is provider #1 of the migration; every other provider gets
// its own item, so one key can never be read for another provider.
const BYOK_KEY_STORAGE_ITEM = 'gd-byok-key';

/** The storage item of a key slot ('' = the legacy Phase 2 slot). */
const storageItemForKeyRef = (keyRef: string): string =>
  keyRef ? `${BYOK_KEY_STORAGE_ITEM}-${keyRef}` : BYOK_KEY_STORAGE_ITEM;

// Renderer-safe Electron access: null on the web build (see Utils/Window.js
// and PreferencesProvider.js for the pattern).
const electron = optionalRequire('electron');
const ipcRenderer = electron ? electron.ipcRenderer : null;

// The result shape returned by the main-process safeStorage handlers
// (see electron-app/app/ByokSafeStorage.js): errors travel as values,
// never as IPC exceptions.
type ByokSafeStorageResult =
  | {| ok: true, data: string |}
  | {| ok: false, error: string |};

// Arbitrary constant bytes, fixed forever: values obfuscated by an older
// build of the app must stay readable by newer builds.
const PEPPER_BYTES: Array<number> = [
  0x37,
  0xd4,
  0x9a,
  0x51,
  0xc8,
  0x0f,
  0xe3,
  0x66,
  0xb2,
  0x19,
  0x7c,
  0xa5,
  0x40,
  0x8b,
  0xf1,
  0x2e,
];

/**
 * Turn a text into its list of UTF-8 bytes, without needing TextEncoder
 * (encodeURIComponent escapes every character outside the unreserved set as
 * UTF-8 percent-escapes, which we can read out).
 */
const textToUtf8Bytes = (text: string): Array<number> => {
  const escaped = encodeURIComponent(text);
  const bytes: Array<number> = [];
  for (let index = 0; index < escaped.length; index++) {
    const character = escaped[index];
    if (character !== '%') {
      bytes.push(escaped.charCodeAt(index));
      continue;
    }

    bytes.push(parseInt(escaped.substr(index + 1, 2), 16));
    index += 2;
  }
  return bytes;
};

/**
 * The inverse of `textToUtf8Bytes`. Returns null when the bytes are not
 * valid UTF-8.
 */
const utf8BytesToText = (bytes: Array<number>): ?string => {
  let escaped = '';
  for (const byte of bytes) {
    // `%` is itself an escape character for decodeURIComponent: a literal
    // 0x25 byte must be escaped as `%25`, or any key containing `%` is
    // silently corrupted (or rejected as an invalid escape) on read.
    if (byte === 0x25) {
      escaped += '%25';
      continue;
    }
    if (byte < 0x80) {
      escaped += String.fromCharCode(byte);
      continue;
    }
    escaped += `%${byte.toString(16)}`;
  }

  try {
    return decodeURIComponent(escaped);
  } catch (error) {
    return null;
  }
};

/**
 * Obfuscate a key: xor its UTF-8 bytes with the pepper, then encode in
 * base64 so everything stored in localStorage stays printable. Deterministic
 * on purpose (same input → same output), exported for tests.
 */
export const obfuscate = (text: string): string => {
  const bytes = textToUtf8Bytes(text);
  let binary = '';
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index] ^ PEPPER_BYTES[index % PEPPER_BYTES.length];
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

/**
 * The inverse of `obfuscate`. Returns null when the value was corrupted
 * (not valid base64, or not valid UTF-8 once de-xored). Exported for tests.
 */
export const deobfuscate = (obfuscated: string): ?string => {
  let binary;
  try {
    binary = atob(obfuscated);
  } catch (error) {
    return null;
  }

  const bytes: Array<number> = [];
  for (let index = 0; index < binary.length; index++) {
    bytes.push(
      binary.charCodeAt(index) ^ PEPPER_BYTES[index % PEPPER_BYTES.length]
    );
  }
  return utf8BytesToText(bytes);
};

/**
 * Encrypt a key for storage: on desktop, by the operating system through the
 * main process (version 3); on the web build, with the Phase 2 obfuscation
 * (version 2). Returns null when the desktop encryption fails.
 */
const encryptSecret = async (
  plainText: string
): Promise<?{| version: number, value: string |}> => {
  if (!ipcRenderer) {
    return { version: 2, value: obfuscate(plainText) };
  }

  try {
    const result: ByokSafeStorageResult = await ipcRenderer.invoke(
      'byok-encrypt',
      plainText
    );
    if (result && result.ok) {
      return { version: 3, value: result.data };
    }
    console.error('Unable to encrypt the BYOK API key:', result);
  } catch (error) {
    console.error('Unable to encrypt the BYOK API key:', error);
  }
  return null;
};

/**
 * Decrypt a stored key payload according to the version that produced it.
 * Returns null when the value cannot be recovered (the caller then reports
 * "no key stored"). Version 1 (Phase 1 plaintext) is handled by the caller,
 * which migrates it on read. The payload comes from localStorage: it is
 * untrusted, so every field is narrowed before use.
 */
const decryptSecret = async (payload: mixed): Promise<?string> => {
  if (!payload || typeof payload !== 'object') return null;
  const record: Object = payload;
  // Version 3: OS-encrypted ciphertext, only the main process can decrypt.
  if (record.version === 3 && typeof record.value === 'string') {
    if (!ipcRenderer) return null;
    try {
      const result: ByokSafeStorageResult = await ipcRenderer.invoke(
        'byok-decrypt',
        record.value
      );
      if (result && result.ok) {
        return result.data;
      }
      console.error('Unable to decrypt the BYOK API key:', result);
      return null;
    } catch (error) {
      console.error('Unable to decrypt the BYOK API key:', error);
      return null;
    }
  }

  // Version 2: the web-build obfuscation, undone renderer-side.
  if (record.version === 2 && typeof record.value === 'string') {
    return deobfuscate(record.value);
  }

  return null;
};

/**
 * All writes (and the migrations triggered by reads) go through this chain,
 * so they apply in the order they were started — a migration that read an
 * old value cannot land after a newer user save and resurrect the old key.
 */
let storageWriteChain: Promise<void> = Promise.resolve();

const enqueueStorageWrite = <T>(write: () => Promise<T>): Promise<T> => {
  const chained = storageWriteChain.then(write);
  storageWriteChain = chained.then(() => {}, () => {});
  return chained;
};

/**
 * Save the BYOK API key (encrypted on desktop, obfuscated on web) into the
 * slot of a provider (`keyRef: ''` = the legacy slot). An empty key clears
 * the entry rather than storing an empty string. Resolves to false when
 * nothing could be written (storage unavailable, quota exceeded), so
 * callers can tell the user instead of silently losing the key.
 */
const performSaveByokKey = async (
  key: string,
  keyRef: string = ''
): Promise<boolean> => {
  const storageItem = storageItemForKeyRef(keyRef);
  if (!key) {
    return await performClearByokKey(keyRef);
  }

  try {
    const secret = await encryptSecret(key);
    if (!secret) {
      // Desktop: the OS encryption failed (already logged). Keep the key in
      // the obfuscated form rather than losing it — the settings tab's
      // status row keeps telling the user which storage is in use.
      localStorage.setItem(
        storageItem,
        JSON.stringify({ version: 2, value: obfuscate(key) })
      );
      return true;
    }

    localStorage.setItem(storageItem, JSON.stringify(secret));
    return true;
  } catch (error) {
    console.error('Unable to store the BYOK API key:', error);
    return false;
  }
};

export const saveByokKey = (
  key: string,
  keyRef: string = ''
): Promise<boolean> =>
  enqueueStorageWrite(() => performSaveByokKey(key, keyRef));

/** The raw stored entry of a slot, or null when the storage cannot be read. */
const getStoredSerializedKey = (keyRef: string = ''): ?string => {
  try {
    return localStorage.getItem(storageItemForKeyRef(keyRef));
  } catch (error) {
    console.error('Unable to read the BYOK API key storage:', error);
    return null;
  }
};

/**
 * The outcome of reading the stored key. The three cases need different
 * guidance: 'none' means "add a key", 'unreadable' means "the stored entry
 * could not be decrypted (or is corrupted) — clear it and add the key
 * again", 'ok' carries the key. Before this shape, an OS-decryption failure
 * (e.g. DPAPI after a Windows user-account change) was reported as "no key
 * stored", sending the user looking for a setting they never touched.
 */
export type ByokKeyLoadResult =
  | {| status: 'none' |}
  | {| status: 'unreadable' |}
  | {| status: 'ok', key: string |};

/**
 * Load the BYOK API key of a provider slot as a `ByokKeyLoadResult` (see
 * above). A corrupted value is reported as 'unreadable', never thrown to
 * the caller. Older formats are migrated on read, so they disappear as soon
 * as the key is read once.
 */
export const loadByokKey = async (
  keyRef: string = ''
): Promise<ByokKeyLoadResult> => {
  try {
    const serializedKey = localStorage.getItem(storageItemForKeyRef(keyRef));
    if (!serializedKey) return { status: 'none' };

    const parsedKey = JSON.parse(serializedKey);
    if (!parsedKey || typeof parsedKey !== 'object') {
      return { status: 'unreadable' };
    }

    // Version 1 (Phase 1): the key was stored in plaintext under `key`.
    // Migrate it to the current format right away, replacing the plaintext —
    // but only if the entry has not been replaced by a newer save while the
    // (async) read was in flight, or the migration would resurrect the old
    // key over the new one.
    if (typeof parsedKey.key === 'string' && parsedKey.key) {
      let isMigrationWritten = false;
      await enqueueStorageWrite(async () => {
        if (getStoredSerializedKey(keyRef) !== serializedKey) {
          // A newer save replaced the entry while the read was in flight:
          // there is nothing left to migrate.
          isMigrationWritten = true;
          return;
        }
        // The plaintext entry is replaced by the write itself, so it only
        // disappears once the write is confirmed. On a failed write the
        // entry is kept (the key is not lost) and the migration is simply
        // retried by the next load.
        isMigrationWritten = await performSaveByokKey(parsedKey.key, keyRef);
      });
      if (!isMigrationWritten) {
        console.error(
          'The migration of the plaintext API key to the safer storage failed; the entry is kept as-is and the migration will be retried on the next load.'
        );
      }
      return { status: 'ok', key: parsedKey.key };
    }

    const key = await decryptSecret(parsedKey);
    if (!key) return { status: 'unreadable' };

    // A version 2 (obfuscated) entry read on the desktop app is re-saved as
    // version 3, so the OS encryption replaces the weaker form; on the web
    // build this branch is never taken. Same concurrency guard as above.
    if (parsedKey.version === 2 && ipcRenderer) {
      await enqueueStorageWrite(async () => {
        if (getStoredSerializedKey(keyRef) !== serializedKey) return;
        await performSaveByokKey(key, keyRef);
      });
    }

    return { status: 'ok', key };
  } catch (error) {
    console.error('Unable to read the BYOK API key:', error);
    return { status: 'unreadable' };
  }
};

/**
 * Remove the stored BYOK API key, if any. Resolves to false when the entry
 * could not be removed.
 */
const performClearByokKey = async (keyRef: string = ''): Promise<boolean> => {
  try {
    localStorage.removeItem(storageItemForKeyRef(keyRef));
    return true;
  } catch (error) {
    console.error('Unable to remove the BYOK API key:', error);
    return false;
  }
};

export const clearByokKey = (keyRef: string = ''): Promise<boolean> =>
  enqueueStorageWrite(() => performClearByokKey(keyRef));

/**
 * True when the key can be stored encrypted by the platform: the desktop app
 * delegates to the main process (Electron safeStorage); the web build has no
 * such facility and keeps returning false.
 */
export const isByokKeyEncryptionAvailable = async (): Promise<boolean> => {
  if (!ipcRenderer) return false;

  try {
    return await ipcRenderer.invoke('byok-encryption-available');
  } catch (error) {
    console.error('Unable to check BYOK key encryption availability:', error);
    return false;
  }
};

/**
 * The status of the key storage, displayed in the BYOK settings tab. Reports
 * the format the key is *actually* stored in — not just what the platform
 * could do — so a desktop fallback to obfuscation (a failed encryption) is
 * shown for what it is.
 */
export const getByokKeyStorageInfo = async (
  keyRef: string = ''
): Promise<{|
  encrypted: boolean,
  obfuscated: boolean,
|}> => {
  let storedVersion = 0;
  const serializedKey = getStoredSerializedKey(keyRef);
  if (serializedKey) {
    try {
      const parsedKey = JSON.parse(serializedKey);
      if (
        parsedKey &&
        typeof parsedKey === 'object' &&
        typeof parsedKey.version === 'number'
      ) {
        storedVersion = parsedKey.version;
      }
    } catch (error) {
      // A corrupted entry counts as "nothing readable stored".
    }
  }

  const canEncrypt = await isByokKeyEncryptionAvailable();
  const encrypted = canEncrypt && storedVersion === 3;
  return { encrypted, obfuscated: storedVersion > 0 && !encrypted };
};
