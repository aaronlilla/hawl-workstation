// Cipher for EncryptedFile / FileCredentialStore backed by Electron `safeStorage` (Windows DPAPI,
// macOS Keychain, Linux libsecret). Takes the object structurally so this package never imports
// Electron: the main process passes `safeStorage` in.
import type { Cipher } from './store'

export type SafeStorageLike = {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(blob: Buffer): string
}

/**
 * Throws when the OS cannot encrypt (Linux without a keyring would otherwise fall back to a
 * hard-coded key and write the private key in the clear). Call after `app.whenReady()`.
 */
export function safeStorageCipher(s: SafeStorageLike): Cipher {
  if (!s.isEncryptionAvailable()) {
    throw new Error('The OS keyring is not available, so a sign-in cannot be stored safely.')
  }
  return {
    encrypt: (plain) => s.encryptString(plain),
    decrypt: (blob) => s.decryptString(blob)
  }
}
