// Persistent storage for what a sign-in leaves behind: the worker credentials (private key) and the
// web session cookie. The bytes on disk are always encrypted. The cipher is a seam so the app can
// plug in Electron `safeStorage` (Windows DPAPI, macOS Keychain, Linux libsecret) without this
// package importing Electron; `aesGcmCipher` covers a key held in any OS keyring.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Credentials, CredentialStore } from './core'

export type Cipher = {
  encrypt(plain: string): Buffer
  decrypt(blob: Buffer): string
}

/** AES-256-GCM with a 32-byte key (kept in the OS keyring). Output: 12-byte iv | 16-byte tag | data. */
export function aesGcmCipher(key: Buffer): Cipher {
  if (key.length !== 32) {
    throw new Error('aesGcmCipher needs a 32-byte key')
  }
  return {
    encrypt(plain) {
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', key, iv)
      const data = Buffer.concat([c.update(plain, 'utf8'), c.final()])
      return Buffer.concat([iv, c.getAuthTag(), data])
    },
    decrypt(blob) {
      const d = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12))
      d.setAuthTag(blob.subarray(12, 28))
      return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString('utf8')
    }
  }
}

/** One encrypted string in one file. A file that will not decrypt reads as empty (the person signs in again). */
export class EncryptedFile {
  readonly #path: string
  readonly #cipher: Cipher

  constructor(path: string, cipher: Cipher) {
    this.#path = path
    this.#cipher = cipher
  }

  async load(): Promise<string | null> {
    let blob: Buffer
    try {
      blob = await readFile(this.#path)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw e
    }
    try {
      return this.#cipher.decrypt(blob)
    } catch {
      return null
    }
  }

  async save(text: string): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true })
    // Write beside, then rename: a crash never leaves half a key.
    const tmp = `${this.#path}.${process.pid}.tmp`
    await writeFile(tmp, this.#cipher.encrypt(text), { mode: 0o600 })
    await rename(tmp, this.#path)
  }

  async clear(): Promise<void> {
    await rm(this.#path, { force: true })
  }
}

export class FileCredentialStore implements CredentialStore {
  readonly #f: EncryptedFile

  constructor(path: string, cipher: Cipher) {
    this.#f = new EncryptedFile(path, cipher)
  }

  async load(): Promise<Credentials | null> {
    const text = await this.#f.load()
    if (!text) {
      return null
    }
    try {
      const c = JSON.parse(text) as Credentials
      return c.residentId && c.privateJwk?.d ? c : null
    } catch {
      return null
    }
  }

  save(c: Credentials): Promise<void> {
    return this.#f.save(JSON.stringify(c))
  }

  clear(): Promise<void> {
    return this.#f.clear()
  }
}
