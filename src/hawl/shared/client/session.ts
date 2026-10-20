// WorkstationAccount: the whole sign-in as one object that survives a restart.
//
// Who signs in how (decided here, once):
//   - The WORKER (this app's agent identity) signs in with the device code: join/start, the person
//     types the code at hawl.ai/device, the claim hands the key over. That key is stored.
//   - The PERSON (approvals, board, site feed) signs in to the web app: emailed 6-digit code, or a
//     cookie taken from a browser window. The cookie is stored. The relay accepts no other way.
// Both pieces are kept encrypted on disk and loaded by `WorkstationAccount.open`, which also
// builds the HawlClient. The client is built once and stays valid across web sign-in and sign-out,
// because its user plane reads whatever web session the account holds at that moment.
import {
  assertSecureRelayUrl,
  type Credentials,
  type CredentialStore,
  type FetchLike,
  HawlApiError,
  type Sleep,
  type TokenSource
} from './core'
import { HawlClient, type ClientOptions } from './client'
import { type DeviceSignIn, type SignInOptions, startDeviceSignIn } from './signin'
import { type Cipher, EncryptedFile, FileCredentialStore } from './store'
import { WebSession } from './user-session'
import { join } from 'node:path'

/** One secret string (the web cookie). */
export type CookieStore = {
  load(): Promise<string | null>
  save(cookie: string): Promise<void>
  clear(): Promise<void>
}

export type SecretStores = { credentials: CredentialStore; cookie: CookieStore }

/** `credentials.enc` and `web-cookie.enc` in `dir`, both sealed with `cipher` (Electron safeStorage in the app). */
export function fileSecretStores(dir: string, cipher: Cipher): SecretStores {
  return {
    credentials: new FileCredentialStore(join(dir, 'credentials.enc'), cipher),
    cookie: new EncryptedFile(join(dir, 'web-cookie.enc'), cipher)
  }
}

export type AccountOptions = {
  stores: SecretStores
  /** Where the web app lives. Default https://hawl.ai. */
  webOrigin?: string
  fetch?: FetchLike
  sleep?: Sleep
  timeoutMs?: number
  version?: string
  trust?: ClientOptions['trust']
  /** Called when a secret could not be written or erased. The sign-in itself keeps working in memory. */
  onStorageError?: (what: 'credentials' | 'cookie', e: unknown) => void
}

export type AccountState = { worker: boolean; person: boolean }

export class WorkstationAccount {
  readonly #o: AccountOptions
  #creds: Credentials | null = null
  #client: HawlClient | null = null
  #web: WebSession | null = null
  readonly #listeners = new Set<(s: AccountState) => void>()
  /** Why the stored sign-in was not used at start (unreadable relay URL, for example), or null. */
  loadProblem: string | null = null
  /** The last storage failure, or null. A sign-in that could not be stored is gone after a restart. */
  storageProblem: unknown = null

  private constructor(o: AccountOptions) {
    this.#o = o
  }

  /** Load whatever was stored. Never throws for a missing or unreadable file: that is "signed out". */
  static async open(o: AccountOptions): Promise<WorkstationAccount> {
    const a = new WorkstationAccount(o)
    const [creds, cookie] = await Promise.all([o.stores.credentials.load(), o.stores.cookie.load()])
    if (creds) {
      try {
        a.#setCreds(creds)
      } catch (e) {
        a.loadProblem = String(e)
      }
    }
    if (cookie) {
      a.#web = a.#newWeb(cookie)
    }
    return a
  }

  get state(): AccountState {
    return { worker: this.#client !== null, person: this.#web !== null && this.#web.cookie !== '' }
  }
  get credentials(): Credentials | null {
    return this.#creds
  }
  /** The relay client, or null until the worker has signed in. Stays the same object after web sign-in/out. */
  get client(): HawlClient | null {
    return this.#client
  }
  get webSession(): WebSession | null {
    return this.#web
  }

  onChange(fn: (s: AccountState) => void): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  // ---- the worker -----------------------------------------------------------------------------

  /**
   * Device-code sign-in. `onCode` gets the code and page to show; this resolves once the person has
   * approved it, the key is stored and the client exists. `signal` cancels; nothing is stored then.
   */
  async signInWorker(
    o: Omit<SignInOptions, 'fetch' | 'sleep' | 'timeoutMs'>,
    h: { onCode: (s: DeviceSignIn) => void; signal?: AbortSignal; onTick?: () => void }
  ): Promise<HawlClient> {
    const started = await startDeviceSignIn({
      ...o,
      ...(this.#o.fetch ? { fetch: this.#o.fetch } : {}),
      ...(this.#o.sleep ? { sleep: this.#o.sleep } : {}),
      ...(this.#o.timeoutMs !== undefined ? { timeoutMs: this.#o.timeoutMs } : {})
    })
    h.onCode(started)
    const creds = await started.wait({
      ...(h.signal ? { signal: h.signal } : {}),
      ...(h.onTick ? { onTick: h.onTick } : {})
    })
    // The relay has handed the key over and will not do it twice, so keep the sign-in alive in
    // memory even if the disk refuses it.
    try {
      await this.#o.stores.credentials.save(creds)
      this.storageProblem = null
    } catch (e) {
      this.#storageFailed('credentials', e)
    }
    this.loadProblem = null
    this.#setCreds(creds)
    this.#emit()
    return this.#client as HawlClient
  }

  // ---- the person -----------------------------------------------------------------------------

  sendWebCode(email: string): Promise<void> {
    return WebSession.sendCode(email, this.#webOptions())
  }

  /** The 6 digits from the email. Stores the cookie. */
  async verifyWebCode(email: string, otp: string): Promise<void> {
    const s = await WebSession.verifyCode(email, otp, this.#webOptions())
    this.#adopt(s)
  }

  /** A cookie header taken from a browser window (passkey or OAuth sign-in). */
  async useBrowserCookie(cookie: string): Promise<void> {
    this.#adopt(WebSession.fromCookie(cookie, this.#webOptions()))
    await this.#persistCookie(cookie)
  }

  /** Leave the person's session; the worker stays signed in. */
  async signOutPerson(): Promise<void> {
    const s = this.#web
    this.#web = null
    if (s) {
      await s.signOut().catch(() => undefined)
    }
    await this.#persistCookie('')
    this.#emit()
  }

  /**
   * Forget everything on this computer. With `leave`, first tell the relay to suspend this worker
   * and revoke its keys; a relay that cannot be reached leaves `left: false` (the keys are still
   * erased here, and can be revoked from the dashboard).
   */
  async signOutAll(o: { leave?: boolean } = {}): Promise<{ left: boolean }> {
    let left = false
    if (o.leave && this.#client) {
      try {
        await this.#client.leave()
        left = true
      } catch {
        left = false
      }
    }
    this.#creds = null
    this.#client = null
    try {
      await this.#o.stores.credentials.clear()
    } catch (e) {
      this.#storageFailed('credentials', e)
    }
    await this.signOutPerson()
    return { left }
  }

  // ---- internals ------------------------------------------------------------------------------

  #setCreds(c: Credentials): void {
    assertSecureRelayUrl(c.relayUrl)
    this.#creds = c
    this.#client = new HawlClient({
      credentials: c,
      user: this.#userSource,
      ...(this.#o.fetch ? { fetch: this.#o.fetch } : {}),
      ...(this.#o.sleep ? { sleep: this.#o.sleep } : {}),
      ...(this.#o.timeoutMs !== undefined ? { timeoutMs: this.#o.timeoutMs } : {}),
      ...(this.#o.version ? { version: this.#o.version } : {}),
      ...(this.#o.trust ? { trust: this.#o.trust } : {}),
      webOrigin: this.#o.webOrigin ?? 'https://hawl.ai'
    })
  }

  /** The client's user plane: whichever web session is current, or a clear "sign in" error. */
  readonly #userSource: TokenSource = {
    token: () => {
      if (!this.#web) {
        return Promise.reject(
          new HawlApiError(401, 'signed_out', 'Sign in to Hawl to see approvals and the site feed.')
        )
      }
      return this.#web.token()
    },
    invalidate: () => this.#web?.invalidate()
  }

  #webOptions() {
    return {
      ...(this.#o.webOrigin ? { webOrigin: this.#o.webOrigin } : {}),
      ...(this.#o.fetch ? { fetch: this.#o.fetch } : {}),
      ...(this.#o.sleep ? { sleep: this.#o.sleep } : {}),
      ...(this.#o.timeoutMs !== undefined ? { timeoutMs: this.#o.timeoutMs } : {}),
      onCookie: (c: string) => {
        // Rotation and "the site ended your session" both arrive here; keep the disk in step.
        void this.#persistCookie(c).then(() => this.#emit())
      }
    }
  }

  #newWeb(cookie: string): WebSession {
    return WebSession.fromCookie(cookie, this.#webOptions())
  }

  #adopt(s: WebSession): void {
    this.#web = s
    this.#emit()
  }

  async #persistCookie(cookie: string): Promise<void> {
    try {
      await (cookie ? this.#o.stores.cookie.save(cookie) : this.#o.stores.cookie.clear())
    } catch (e) {
      this.#storageFailed('cookie', e)
    }
  }

  #storageFailed(what: 'credentials' | 'cookie', e: unknown): void {
    this.storageProblem = e
    this.#o.onStorageError?.(what, e)
  }

  #emit(): void {
    for (const fn of this.#listeners) {
      fn(this.state)
    }
  }
}
