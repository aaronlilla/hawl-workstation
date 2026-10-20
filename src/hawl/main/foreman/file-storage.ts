// One snapshot file on disk, written all-or-nothing: temp file, flush, rename over the old one.
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
  mkdirSync
} from 'node:fs'
import { dirname } from 'node:path'
import type { SnapshotStorage } from './runtime'

export function fileStorage(path: string, now: () => number = Date.now): SnapshotStorage {
  return {
    read() {
      try {
        return readFileSync(path, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return null
        }
        throw err
      }
    },
    write(text) {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      const fd = openSync(tmp, 'w')
      try {
        writeSync(fd, text)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, path)
    },
    quarantine(text) {
      const aside = `${path}.corrupt-${now()}`
      mkdirSync(dirname(path), { recursive: true })
      const fd = openSync(aside, 'w')
      try {
        writeSync(fd, text)
      } finally {
        closeSync(fd)
      }
    }
  }
}
