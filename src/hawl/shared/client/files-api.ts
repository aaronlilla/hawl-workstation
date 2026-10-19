// Files: the two-step upload shared by the agent plane and the person plane, plus reads.
import { createHash } from 'node:crypto'
import type { Http, Plane } from './http'
import type { FileMeta } from './types'

export type UploadResult = { upl_id: string; put_url: string; result: Record<string, unknown> }

/**
 * Declare the file (name, type, size, SHA-256 as 43 base64url characters), then PUT the bytes to
 * the URL the relay returned. The relay scans afterwards.
 */
export async function twoStepUpload(
  http: Http,
  plane: Plane,
  declarePath: string,
  name: string,
  bytes: Uint8Array,
  mime: string,
  extra: Record<string, unknown> = {}
): Promise<UploadResult> {
  const sha256 = createHash('sha256').update(bytes).digest('base64url')
  const up = await http.post<{ upl_id: string; put_url: string; expires_in: number }>(
    declarePath,
    { name, mime, bytes: bytes.length, sha256, ...extra },
    { plane }
  )
  const path = new URL(up.put_url, http.baseUrl).pathname
  const result = await http.put<Record<string, unknown>>(path, {
    plane,
    rawBody: bytes,
    headers: { 'content-type': 'application/octet-stream' }
  })
  return { ...up, result }
}

export class FilesApi {
  readonly #http: Http

  constructor(http: Http) {
    this.#http = http
  }

  meta = (filId: string): Promise<FileMeta> => this.#http.get(`/v1/files/${filId}`)

  /**
   * Bytes of a clean file that reached this worker on a message. A held, flagged, or own-upload
   * only file (release_state "self") is a 404.
   */
  download = (filId: string): Promise<Uint8Array> =>
    this.#http.get(`/v1/files/${filId}/content`, { asBytes: true })

  /** Short-lived signed link (user plane). */
  link = (filId: string): Promise<{ url: string; expires_in: number }> =>
    this.#http.post(`/v1/files/${filId}/link`, {}, { plane: 'user' })

  /** Upload as this worker. The returned file id may report `gate_check` until the scan finishes. */
  upload = (name: string, bytes: Uint8Array, mime: string): Promise<UploadResult> =>
    twoStepUpload(this.#http, 'agent', '/v1/files/uploads', name, bytes, mime)
}
