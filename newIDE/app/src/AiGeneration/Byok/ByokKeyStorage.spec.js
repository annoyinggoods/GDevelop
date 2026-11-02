/**
 * @jest-environment jsdom
 */
// @flow

// The Electron module is mocked so the storage can be loaded in two modes:
// desktop (ipcRenderer present, talking to mocked IPC handlers) and web
// (optionalRequire returns null). The variables below are read lazily by the
// jest.mock factory when the module under test is loaded — hence the "mock"
// prefix, required by jest for out-of-scope references in the factory.
const mockIpcRendererInvoke = (jest.fn(): any);
let mockElectronModule: any = null;

jest.mock('../../Utils/OptionalRequire', () => ({
  __esModule: true,
  default: jest.fn(() => mockElectronModule),
}));

const BYOK_KEY_STORAGE_ITEM = 'gd-byok-key';

// A deliberately opaque fake ciphertext: nothing like the plaintext, so the
// "the key is not stored in plaintext" assertions are meaningful.
const FAKE_CIPHER_TEXT = 'ZmFrZS1jaXBoZXJ0ZXh0';

// The fake main-process state: what decrypting FAKE_CIPHER_TEXT returns.
let fakeDecryptedKey: string | null = null;

/**
 * Loads the module under test in the requested environment. The module reads
 * Electron at import time, so each load needs a fresh module registry.
 */
const loadKeyStorageModule = (isDesktop: boolean) => {
  mockElectronModule = isDesktop
    ? { ipcRenderer: { invoke: mockIpcRendererInvoke } }
    : null;
  jest.resetModules();
  return require('./ByokKeyStorage');
};

/**
 * The mocked IPC handlers of the main process: by default, encryption is
 * available and everything succeeds.
 */
const setSuccessfulIpcHandlers = () => {
  // Shared module state of the fake main process: reset so a test that set
  // it to null cannot leak into the next one.
  fakeDecryptedKey = null;
  mockIpcRendererInvoke.mockImplementation(
    async (channel: string, value: string) => {
      if (channel === 'byok-encryption-available') return true;
      if (channel === 'byok-encrypt') {
        fakeDecryptedKey = value;
        return { ok: true, data: FAKE_CIPHER_TEXT };
      }
      if (channel === 'byok-decrypt') {
        if (fakeDecryptedKey === null) {
          return { ok: false, error: 'Unknown ciphertext' };
        }
        return { ok: true, data: fakeDecryptedKey };
      }
      throw new Error(`Unexpected IPC channel: ${channel}`);
    }
  );
};

describe('ByokKeyStorage (web build: obfuscated storage)', () => {
  let saveByokKey;
  let loadByokKey;
  let clearByokKey;
  let isByokKeyEncryptionAvailable;
  let getByokKeyStorageInfo;

  beforeEach(() => {
    localStorage.clear();
    mockIpcRendererInvoke.mockReset();
    fakeDecryptedKey = null;
    const keyStorageModule = loadKeyStorageModule(false);
    saveByokKey = keyStorageModule.saveByokKey;
    loadByokKey = keyStorageModule.loadByokKey;
    clearByokKey = keyStorageModule.clearByokKey;
    isByokKeyEncryptionAvailable =
      keyStorageModule.isByokKeyEncryptionAvailable;
    getByokKeyStorageInfo = keyStorageModule.getByokKeyStorageInfo;
  });

  it('saves then loads the same key', async () => {
    await saveByokKey('sk-test-1234567890');
    expect(await loadByokKey()).toEqual({
      status: 'ok',
      key: 'sk-test-1234567890',
    });
  });

  it('round-trips keys containing percent signs without corrupting them', async () => {
    // A literal `%` in the stored bytes used to be read back as a
    // percent-escape: silently corrupted, or rejected as "no key stored".
    for (const key of ['a%b', '%', '%25', '%41', 'trailing%', 'key%2z']) {
      await saveByokKey(key);
      expect(await loadByokKey()).toEqual({ status: 'ok', key });
    }
  });

  it('loads and round-trips keys with non-ASCII characters', async () => {
    await saveByokKey('clé-privée-🔑');
    expect(await loadByokKey()).toEqual({
      status: 'ok',
      key: 'clé-privée-🔑',
    });
  });

  it('stores the key obfuscated: the stored value is not the plaintext key', async () => {
    await saveByokKey('sk-test-1234567890');

    const storedValue = localStorage.getItem(BYOK_KEY_STORAGE_ITEM) || '';
    expect(storedValue).not.toContain('sk-test-1234567890');
    expect(JSON.parse(storedValue).version).toBe(2);
    expect(typeof JSON.parse(storedValue).value).toBe('string');
    expect(JSON.parse(storedValue).value).not.toContain('sk-test');
  });

  it("loads a 'none' status when no key is stored", async () => {
    expect(await loadByokKey()).toEqual({ status: 'none' });
  });

  it('clears the entry, then loads none', async () => {
    await saveByokKey('sk-test-1234567890');
    await clearByokKey();
    expect(localStorage.getItem(BYOK_KEY_STORAGE_ITEM)).toBe(null);
    expect(await loadByokKey()).toEqual({ status: 'none' });
  });

  it('treats saving an empty string as clearing the entry', async () => {
    await saveByokKey('sk-test-1234567890');
    await saveByokKey('');
    expect(localStorage.getItem(BYOK_KEY_STORAGE_ITEM)).toBe(null);
    expect(await loadByokKey()).toEqual({ status: 'none' });
  });

  it('reads a version 1 (plaintext) entry and migrates it to version 2', async () => {
    localStorage.setItem(
      BYOK_KEY_STORAGE_ITEM,
      JSON.stringify({ key: 'sk-old-plaintext-key' })
    );

    expect(await loadByokKey()).toEqual({
      status: 'ok',
      key: 'sk-old-plaintext-key',
    });

    const storedValue = JSON.parse(
      localStorage.getItem(BYOK_KEY_STORAGE_ITEM) || 'null'
    );
    expect(storedValue.version).toBe(2);
    expect(JSON.stringify(storedValue)).not.toContain('sk-old-plaintext-key');
    expect(await loadByokKey()).toEqual({
      status: 'ok',
      key: 'sk-old-plaintext-key',
    });
  });

  it("loads an 'unreadable' status instead of throwing on a corrupted (non-JSON) stored value", async () => {
    localStorage.setItem(BYOK_KEY_STORAGE_ITEM, '{not json at all');
    expect(await loadByokKey()).toEqual({ status: 'unreadable' });
  });

  it("loads an 'unreadable' status on a stored value that is not the expected object", async () => {
    localStorage.setItem(BYOK_KEY_STORAGE_ITEM, JSON.stringify('a string'));
    expect(await loadByokKey()).toEqual({ status: 'unreadable' });
  });

  it("loads an 'unreadable' status on a corrupted v2 value (invalid base64)", async () => {
    localStorage.setItem(
      BYOK_KEY_STORAGE_ITEM,
      JSON.stringify({ version: 2, value: 'not base64!!!' })
    );
    expect(await loadByokKey()).toEqual({ status: 'unreadable' });
  });

  it("loads an 'unreadable' status on a v2 entry without a value", async () => {
    localStorage.setItem(BYOK_KEY_STORAGE_ITEM, JSON.stringify({ version: 2 }));
    expect(await loadByokKey()).toEqual({ status: 'unreadable' });
  });

  it("loads an 'unreadable' status on a v3 (OS-encrypted) entry: the web build cannot decrypt it", async () => {
    localStorage.setItem(
      BYOK_KEY_STORAGE_ITEM,
      JSON.stringify({ version: 3, value: FAKE_CIPHER_TEXT })
    );
    expect(await loadByokKey()).toEqual({ status: 'unreadable' });
  });

  it('resolves false when the storage write fails, instead of reporting success', async () => {
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    // jsdom defines the storage methods on Storage.prototype.
    const setItemSpy = jest
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });

    await expect(saveByokKey('sk-test-1234567890')).resolves.toBe(false);

    setItemSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    // Nothing was written.
    expect(localStorage.getItem(BYOK_KEY_STORAGE_ITEM)).toBe(null);
  });

  it('never touches Electron on the web build', async () => {
    await saveByokKey('sk-test-1234567890');
    await loadByokKey();
    await isByokKeyEncryptionAvailable();
    expect(mockIpcRendererInvoke).not.toHaveBeenCalled();
  });

  it('reports encryption as not available on the web build', async () => {
    expect(await isByokKeyEncryptionAvailable()).toBe(false);
  });

  it('reports nothing stored as neither encrypted nor obfuscated', async () => {
    expect(await getByokKeyStorageInfo()).toEqual({
      encrypted: false,
      obfuscated: false,
    });
  });

  it('reports a stored key as obfuscated and not encrypted', async () => {
    await saveByokKey('sk-test-1234567890');
    expect(await getByokKeyStorageInfo()).toEqual({
      encrypted: false,
      obfuscated: true,
    });
  });
});

describe('ByokKeyStorage (desktop app: OS-encrypted storage)', () => {
  let saveByokKey;
  let loadByokKey;
  let clearByokKey;
  let isByokKeyEncryptionAvailable;
  let getByokKeyStorageInfo;
  let obfuscate;

  beforeEach(() => {
    localStorage.clear();
    mockIpcRendererInvoke.mockReset();
    setSuccessfulIpcHandlers();
    const keyStorageModule = loadKeyStorageModule(true);
    saveByokKey = keyStorageModule.saveByokKey;
    loadByokKey = keyStorageModule.loadByokKey;
    clearByokKey = keyStorageModule.clearByokKey;
    isByokKeyEncryptionAvailable =
      keyStorageModule.isByokKeyEncryptionAvailable;
    getByokKeyStorageInfo = keyStorageModule.getByokKeyStorageInfo;
    obfuscate = keyStorageModule.obfuscate;
  });

  it('checks encryption availability through the main process', async () => {
    expect(await isByokKeyEncryptionAvailable()).toBe(true);
    expect(mockIpcRendererInvoke).toHaveBeenCalledWith(
      'byok-encryption-available'
    );
  });

  it('reports the storage info as encrypted once a v3 key is stored', async () => {
    await saveByokKey('sk-test-1234567890');
    expect(await getByokKeyStorageInfo()).toEqual({
      encrypted: true,
      obfuscated: false,
    });
  });

  it('reports nothing stored as neither encrypted nor obfuscated', async () => {
    expect(await getByokKeyStorageInfo()).toEqual({
      encrypted: false,
      obfuscated: false,
    });
  });

  it('saves through byok-encrypt: the stored value is v3 ciphertext, not the key', async () => {
    await saveByokKey('sk-test-1234567890');

    expect(mockIpcRendererInvoke).toHaveBeenCalledWith(
      'byok-encrypt',
      'sk-test-1234567890'
    );

    const storedValue = localStorage.getItem(BYOK_KEY_STORAGE_ITEM) || '';
    expect(JSON.parse(storedValue)).toEqual({
      version: 3,
      value: FAKE_CIPHER_TEXT,
    });
    expect(storedValue).not.toContain('sk-test-1234567890');
  });

  it('loads through byok-decrypt and round-trips the key', async () => {
    await saveByokKey('clé-privée-🔑');
    expect(await loadByokKey()).toEqual({
      status: 'ok',
      key: 'clé-privée-🔑',
    });
    expect(mockIpcRendererInvoke).toHaveBeenCalledWith(
      'byok-decrypt',
      FAKE_CIPHER_TEXT
    );
  });

  it("loads an 'unreadable' status when the main process cannot decrypt (ok: false), without throwing — distinct from 'none'", async () => {
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    await saveByokKey('sk-test-1234567890');

    // Corrupt the fake main-process state: decryption no longer knows the key.
    fakeDecryptedKey = null;
    await expect(loadByokKey()).resolves.toEqual({ status: 'unreadable' });
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('falls back to the obfuscated v2 form when encryption fails (ok: false)', async () => {
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    mockIpcRendererInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'byok-encryption-available') return true;
      if (channel === 'byok-encrypt') {
        return { ok: false, error: 'safeStorage refused' };
      }
      return { ok: true, data: 'never-used' };
    });

    await saveByokKey('sk-test-1234567890');

    const storedValue = localStorage.getItem(BYOK_KEY_STORAGE_ITEM) || '';
    expect(JSON.parse(storedValue).version).toBe(2);
    expect(storedValue).not.toContain('sk-test-1234567890');
    // The key is still readable through the renderer-side deobfuscation.
    expect(await loadByokKey()).toEqual({
      status: 'ok',
      key: 'sk-test-1234567890',
    });
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('reports the storage honestly as obfuscated after a failed encryption', async () => {
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    mockIpcRendererInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'byok-encryption-available') return true;
      if (channel === 'byok-encrypt') {
        return { ok: false, error: 'safeStorage refused' };
      }
      return { ok: true, data: 'never-used' };
    });

    await saveByokKey('sk-test-1234567890');

    // Encryption is still "available" (platform capability), but what is
    // stored is the v2 obfuscated form: the status row must say so.
    expect(await isByokKeyEncryptionAvailable()).toBe(true);
    expect(await getByokKeyStorageInfo()).toEqual({
      encrypted: false,
      obfuscated: true,
    });

    consoleErrorSpy.mockRestore();
  });

  it('falls back to the obfuscated v2 form when the byok-encrypt IPC call rejects', async () => {
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    mockIpcRendererInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'byok-encryption-available') return true;
      if (channel === 'byok-encrypt') {
        throw new Error('IPC exploded');
      }
      return { ok: true, data: 'never-used' };
    });

    await expect(saveByokKey('sk-test-1234567890')).resolves.toBe(true);
    expect(
      JSON.parse(localStorage.getItem(BYOK_KEY_STORAGE_ITEM) || 'null').version
    ).toBe(2);
    expect(await loadByokKey()).toEqual({
      status: 'ok',
      key: 'sk-test-1234567890',
    });

    consoleErrorSpy.mockRestore();
  });

  it('loads null when the byok-decrypt IPC call rejects, without throwing', async () => {
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    await saveByokKey('sk-test-1234567890');
    mockIpcRendererInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'byok-decrypt') {
        throw new Error('IPC exploded');
      }
      if (channel === 'byok-encryption-available') return true;
      return { ok: true, data: 'never-used' };
    });

    await expect(loadByokKey()).resolves.toEqual({ status: 'unreadable' });

    consoleErrorSpy.mockRestore();
  });

  it('resolves false when checking availability on a rejected IPC call', async () => {
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    mockIpcRendererInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'byok-encryption-available') {
        throw new Error('IPC exploded');
      }
      return { ok: true, data: 'never-used' };
    });

    await expect(isByokKeyEncryptionAvailable()).resolves.toBe(false);

    consoleErrorSpy.mockRestore();
  });

  it('migrates a v2 (obfuscated) entry to v3 on read', async () => {
    localStorage.setItem(
      BYOK_KEY_STORAGE_ITEM,
      JSON.stringify({ version: 2, value: obfuscate('sk-older-key') })
    );

    expect(await loadByokKey()).toEqual({ status: 'ok', key: 'sk-older-key' });

    const storedValue = JSON.parse(
      localStorage.getItem(BYOK_KEY_STORAGE_ITEM) || 'null'
    );
    expect(storedValue).toEqual({ version: 3, value: FAKE_CIPHER_TEXT });
    expect(mockIpcRendererInvoke).toHaveBeenCalledWith(
      'byok-encrypt',
      'sk-older-key'
    );
  });

  it('migrates a v1 (plaintext) entry straight to v3 on read', async () => {
    localStorage.setItem(
      BYOK_KEY_STORAGE_ITEM,
      JSON.stringify({ key: 'sk-old-plaintext-key' })
    );

    expect(await loadByokKey()).toEqual({
      status: 'ok',
      key: 'sk-old-plaintext-key',
    });

    const storedValue = localStorage.getItem(BYOK_KEY_STORAGE_ITEM) || '';
    expect(JSON.parse(storedValue)).toEqual({
      version: 3,
      value: FAKE_CIPHER_TEXT,
    });
    expect(storedValue).not.toContain('sk-old-plaintext-key');
  });

  it('keeps the plaintext entry when the migration write fails, and migrates it on a later load', async () => {
    localStorage.setItem(
      BYOK_KEY_STORAGE_ITEM,
      JSON.stringify({ key: 'sk-old-plaintext-key' })
    );
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    // Fail the write that would replace the plaintext entry (quota exceeded,
    // private mode…): the migration must not drop the entry before the
    // replacement is confirmed written.
    const setItemSpy = jest
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });

    // The key is still handed back (it was readable), but the entry stays.
    await expect(loadByokKey()).resolves.toEqual({
      status: 'ok',
      key: 'sk-old-plaintext-key',
    });
    expect(
      JSON.parse(localStorage.getItem(BYOK_KEY_STORAGE_ITEM) || 'null').key
    ).toBe('sk-old-plaintext-key');
    expect(consoleErrorSpy).toHaveBeenCalled();

    // The write works again: the next load retries the migration, and the
    // plaintext disappears only now that the new entry is confirmed.
    setItemSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    await expect(loadByokKey()).resolves.toEqual({
      status: 'ok',
      key: 'sk-old-plaintext-key',
    });
    const storedValue = JSON.parse(
      localStorage.getItem(BYOK_KEY_STORAGE_ITEM) || 'null'
    );
    expect(storedValue).toEqual({ version: 3, value: FAKE_CIPHER_TEXT });
    expect(JSON.stringify(storedValue)).not.toContain('sk-old-plaintext-key');
  });

  it('does not let a concurrent user save be overwritten by the v2→v3 migration', async () => {
    localStorage.setItem(
      BYOK_KEY_STORAGE_ITEM,
      JSON.stringify({ version: 2, value: obfuscate('sk-old-key') })
    );

    // The migration read starts first, the user saves a new key while it is
    // in flight: the stored key must end up being the new one.
    const loadPromise = loadByokKey();
    await saveByokKey('sk-new-key');
    await loadPromise;

    expect(await loadByokKey()).toEqual({ status: 'ok', key: 'sk-new-key' });
  });

  it('clears the entry without calling the main process', async () => {
    await saveByokKey('sk-test-1234567890');
    mockIpcRendererInvoke.mockClear();

    await clearByokKey();

    expect(localStorage.getItem(BYOK_KEY_STORAGE_ITEM)).toBe(null);
    expect(mockIpcRendererInvoke).not.toHaveBeenCalled();
  });
});

describe('obfuscate / deobfuscate', () => {
  let obfuscate;
  let deobfuscate;

  beforeEach(() => {
    mockIpcRendererInvoke.mockReset();
    const keyStorageModule = loadKeyStorageModule(false);
    obfuscate = keyStorageModule.obfuscate;
    deobfuscate = keyStorageModule.deobfuscate;
  });

  it('round-trips a key', () => {
    expect(deobfuscate(obfuscate('sk-test-1234567890'))).toBe(
      'sk-test-1234567890'
    );
    expect(deobfuscate(obfuscate(''))).toBe('');
    expect(deobfuscate(obfuscate('clé-privée-🔑'))).toBe('clé-privée-🔑');
  });

  it('round-trips keys containing percent signs', () => {
    // A literal `%` byte must be escaped on decode, or the value is read as
    // a percent-escape ('%41' → 'A', '%2z' → not valid UTF-8 → null).
    expect(deobfuscate(obfuscate('a%b'))).toBe('a%b');
    expect(deobfuscate(obfuscate('%'))).toBe('%');
    expect(deobfuscate(obfuscate('%25'))).toBe('%25');
    expect(deobfuscate(obfuscate('%41'))).toBe('%41');
    expect(deobfuscate(obfuscate('trailing%'))).toBe('trailing%');
    expect(deobfuscate(obfuscate('key%2z'))).toBe('key%2z');
  });

  it('is deterministic: the same input gives the same output', () => {
    expect(obfuscate('sk-test-1234567890')).toBe(
      obfuscate('sk-test-1234567890')
    );
  });

  it('produces an output different from the input', () => {
    expect(obfuscate('sk-test-1234567890')).not.toBe('sk-test-1234567890');
  });

  it('returns null when deobfuscating a value that was never obfuscated', () => {
    expect(deobfuscate('sk-test-1234567890')).toBe(null);
  });

  // ---- Phase 9.4: per-provider key slots ----
  describe('per-provider key slots', () => {
    const keyStorage = require('./ByokKeyStorage');
    it('store and load keys per provider without cross-talk', async () => {
      expect(await keyStorage.saveByokKey('sk-legacy', '')).toBe(true);
      expect(
        await keyStorage.saveByokKey('sk-provider-two', 'provider-two')
      ).toBe(true);

      const legacy = await keyStorage.loadByokKey('');
      const two = await keyStorage.loadByokKey('provider-two');
      expect(legacy).toEqual({ status: 'ok', key: 'sk-legacy' });
      expect(two).toEqual({ status: 'ok', key: 'sk-provider-two' });
    });

    it('clears only the targeted slot', async () => {
      await keyStorage.saveByokKey('sk-a', 'prov-a');
      await keyStorage.saveByokKey('sk-b', 'prov-b');

      await keyStorage.clearByokKey('prov-a');

      expect(await keyStorage.loadByokKey('prov-a')).toEqual({
        status: 'none',
      });
      expect(await keyStorage.loadByokKey('prov-b')).toEqual({
        status: 'ok',
        key: 'sk-b',
      });
    });

    it('reports no key for an untouched slot', async () => {
      expect(await keyStorage.loadByokKey('never-used')).toEqual({
        status: 'none',
      });
    });
  });
});
