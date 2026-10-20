import type { IncomingMessage, ServerResponse } from 'node:http'
import type { KeyObject } from 'node:crypto'
import type { Jwk } from './core'
import type { FakeRelay } from './fake-relay'

export type WorkerRec = { id: string; kid: string; pub: KeyObject; jwk: Jwk; slug: string }
export type JoinRec = {
  id: string
  pub: KeyObject
  jwk: Jwk
  slug: string
  polls: number
  code: string
}

/** What a route handler gets. A handler answers by calling `json` or `r.err`; the dispatcher checks `res.writableEnded`. */
export type Ctx = {
  r: FakeRelay
  req: IncomingMessage
  res: ServerResponse
  url: URL
  path: string
  m: string
  body: unknown
  raw: Buffer
  bearer: string | undefined
  json: (status: number, v: unknown) => void
  agent: () => WorkerRec | null
  user: () => boolean
}
