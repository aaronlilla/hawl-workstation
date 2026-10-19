// Smoke against the LOCAL relay (scripts/local-stack.mjs). Never production. Off unless asked:
//   HAWL_SMOKE_LOCAL=http://localhost:8080 node_modules/.bin/vitest run --config src/hawl/shared/client/vitest.config.ts local-relay
// The browser approval step is replaced by one UPDATE on the local test database (state=authorized,
// as POST /v1/join/:jrq/approve-device would set). Everything else is the real relay code.
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { HawlClient, startDeviceSignIn } from './index'

const relayUrl = process.env.HAWL_SMOKE_LOCAL
const requirePg = createRequire(`${process.env.HAWL_PLATFORM_E2E ?? 'E:/hawl-platform/.claude/worktrees/e2e'}/apps/relay/package.json`)

function until<T>(fn: () => T | undefined | false, ms = 8000): Promise<T> {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const v = fn()
      if (v) return resolve(v as T)
      if (Date.now() - t0 > ms) return reject(new Error('timed out'))
      setTimeout(tick, 20)
    }
    tick()
  })
}

describe.skipIf(!relayUrl)('local relay smoke', () => {
  it('sign in, read, socket, signed send, leave', async () => {
    const pg = requirePg('pg')
    const db = new pg.Client({
      host: 'localhost',
      port: Number(process.env.HAWL_SMOKE_PG_PORT ?? 5433),
      user: 'postgres',
      password: 'postgres',
      database: 'relay_local'
    })
    await db.connect()
    try {
      const owner = (
        await db.query(
          `SELECT s.slug, m.user_id FROM sites s JOIN members m ON m.town_id = s.id
            WHERE m.role = 'owner' AND m.status = 'active' AND s.status = 'active'
            ORDER BY s.slug LIMIT 1`
        )
      ).rows[0] as { slug: string; user_id: string }
      expect(owner, 'a local site with an owner').toBeTruthy()

      const s = await startDeviceSignIn({ site: owner.slug, relayUrl: relayUrl as string, machineName: 'smoke', folderLabel: 'client-smoke', pollMs: 100 })
      expect(s.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
      // The real relay verifies our claim signature: a pending answer (not a 404) proves it.
      expect(await s.claim()).toEqual({ state: 'pending' })
      const uuid = s.joinId.replace(/^jrq_/, '')
      const upd = await db.query(`UPDATE join_requests SET state = 'authorized', user_id = $2 WHERE id = $1 AND state = 'pending'`, [uuid, owner.user_id])
      expect(upd.rowCount).toBe(1)

      const cred = await s.wait()
      expect(cred.residentId).toMatch(/^res_/)
      const c = new HawlClient({ credentials: cred, version: '99.0.0-smoke' })
      let left = false
      try {

      const me = await c.me()
      expect(me).toMatchObject({ resident_id: cred.residentId, town_slug: owner.slug, platform: 'hawl_workstation' })

      const who = await c.workers.who()
      expect(Array.isArray(who.workers)).toBe(true)
      const dir = await c.workers.list()
      expect(dir.items.some((w) => w.resident_id === cred.residentId)).toBe(true)
      expect(Array.isArray((await c.handoffs.list({ mine: true })).handoffs)).toBe(true)
      expect(Array.isArray((await c.board.read()).pins)).toBe(true)
      const chans = await c.channels.list()
      expect(chans.items.some((x) => x.kind === 'square')).toBe(true)
      expect((await c.inbox.list(0, 10)).items).toBeDefined()

      const sock = c.socket({ reconnectMs: { min: 50, max: 200 } })
      const got: Record<string, unknown>[] = []
      sock.on('deliver', (e) => got.push(e))
      sock.start()
      try {
        await until(() => sock.state === 'connected')
        const viaSocket = (await sock.tool('who')) as { workers: unknown[] }
        expect(Array.isArray(viaSocket.workers)).toBe(true)
        expect(sock.setPresence('busy')).toBe(true)

        // Signed send to the site's Dispatcher: the relay verifies sender_sig and echoes back.
        const disp = (who.workers as { handle?: string; platform?: string }[]).find((w) => w.platform === 'system')
        expect(disp?.handle, 'the site has a Dispatcher').toBeTruthy()
        if (disp?.handle) {
          const out = (await c.send.dm(disp.handle, 'client smoke ping')) as { state?: string }
          expect(out.state).toBe('queued')
          await until(() => got.length >= 1)
          expect(JSON.stringify(got[0])).toContain('Round trip ok')
        }
        // A haul to another worker: signed create, read it back, then cancel it (sender may cancel).
        const peer = (who.workers as { handle?: string; platform?: string; resident_id?: string }[]).find(
          (w) => w.platform !== 'system' && w.resident_id !== cred.residentId
        )
        expect(peer?.handle, 'another worker in the site').toBeTruthy()
        const made = (await c.handoffs.create({
          to: (peer?.handle as string).replace(/^@/, ''),
          task_type: 'smoke',
          title: 'client smoke haul',
          spec: 'Created by the @hawl/client smoke test. Ignore.',
          criteria: [{ id: 'c1', text: 'nothing to do', check: 'manual' }]
        })) as { handoff_id?: string; state?: string }
        expect(made.handoff_id).toMatch(/^hnd_/)
        const got1 = await c.handoffs.get(made.handoff_id as string)
        expect(got1).toMatchObject({ title: 'client smoke haul', sender: cred.residentId })
        expect((await c.handoffs.list({ mine: true })).handoffs.some((h) => h.handoff_id === made.handoff_id)).toBe(true)
        const canceled = await c.handoffs.act(made.handoff_id as string, 'cancel', { reason: 'smoke done' })
        expect(JSON.stringify(canceled)).toMatch(/cancel/i)

        // Signed post to the Square.
        const post = (await c.send.square('@hawl/client smoke post')) as { state?: string }
        expect(['queued', 'delivered']).toContain(post.state)
      } finally {
        sock.stop()
      }

      // Leave through the API: this worker is suspended and its token stops working.
      expect(await c.leave()).toMatchObject({ state: 'left' })
      left = true
      await expect(c.me()).rejects.toMatchObject({ status: 401 })
      } finally {
        // A failed run must not leave test workers behind in the local site.
        if (!left) await c.leave().catch(() => {})
      }
    } finally {
      await db.end()
    }
  })
})
