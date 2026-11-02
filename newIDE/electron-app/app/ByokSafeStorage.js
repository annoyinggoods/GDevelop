const { safeStorage } = require('electron');

// This module sees the BYOK API key in plaintext: never log it, never write
// it anywhere but the encrypted result returned to the renderer.

/** @returns {boolean} */
const isByokEncryptionAvailable = () => {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch (error) {
    // Some Linux builds have no keyring backend; Windows (DPAPI)
    // always has one.
    return false;
  }
};

/**
 * Encrypt a secret with the OS-level key store (DPAPI on Windows).
 * @param {string} plainText
 * @returns {{ ok: true, data: string } | { ok: false, error: string }} the
 * base64 ciphertext — errors come back as values, never as exceptions.
 */
const encryptByokSecret = plainText => {
  try {
    const encryptedBuffer = safeStorage.encryptString(plainText);
    return { ok: true, data: encryptedBuffer.toString('base64') };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
};

/**
 * Decrypt a base64 ciphertext produced by `encryptByokSecret`.
 * @param {string} base64CipherText
 * @returns {{ ok: true, data: string } | { ok: false, error: string }}
 */
const decryptByokSecret = base64CipherText => {
  try {
    const plainText = safeStorage.decryptString(
      Buffer.from(base64CipherText, 'base64')
    );
    return { ok: true, data: plainText };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
};

module.exports = {
  isByokEncryptionAvailable,
  encryptByokSecret,
  decryptByokSecret,
};
