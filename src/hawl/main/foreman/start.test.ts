// The foreman brought up the way the app brings it up: identity file, saved state, agent door, owner IPC, relay link.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseIdentity } from './identity'
import type { HawlIdentity } from './identity'
import { FOREMAN_CHANNELS } from './ipc'
import type { IpcLike } from './ipc'
import type { RelayHttpLike } from './relay-transport'
import { DEV_OFFER_CHANNEL, startHawlForeman, STATUS_CHANNEL } from './start'
import type { ForemanHandle, StartOptions } from './start'

const ID: HawlIdentity = {
  yard: 'acme-dev',
  owner: 'usr_aaron',
  displayName: "Aaron's yard",
  yardId: 'vil_yard1',
  siteId: 'twn_site1'
}

const dirs: string[] = []
const live: ForemanHandle[] = []
afterEach(async () => {
  for (const h of live.splice(0)) {
    await h.stop()
  }
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true })
  }
})

function rig(over: Partial<StartOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hawl-start-'))
  dirs.push(dir)
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  const ipc: IpcLike = {
    handle: (ch, fn) => handlers.set(ch, fn),
    removeHandler: (ch) => handlers.delete(ch)
  }
  const emitted: { channel: string; payload?: unknown }[] = []
  const calls: { method: string; path: string; body?: unknown }[] = []
  let relayUp: RelayHttpLike | null = null
  const relay: RelayHttpLike = {
    request: async (method, path, opts) => {
      calls.push({ method, path, body: opts?.body })
      return method === 'PUT' ? { revision: 1 } : {}
    }
  }
  const opts: StartOptions = {
    userDataDir: dir,
    ipc,
    trusted: (e) => (e as { ok?: boolean } | null)?.ok === true,
    emit: (channel, payload) => emitted.push({ channel, payload }),
    relay: () => relayUp,
    identity: ID,
    ...over
  }
  const call = (ch: string, ...args: unknown[]) => handlers.get(ch)?.({ ok: true }, ...args)
  return {
    dir,
    handlers,
    emitted,
    calls,
    opts,
    call,
    signIn: () => {
      relayUp = relay
    },
    start: async () => {
      const h = await startHawlForeman(opts)
      live.push(h)
      return h
    }
  }
}

describe('S48 the foreman starts as a yard when it has an identity', () => {
  it('S48: a configured foreman reports itself, hands out the terminal environment, and registers every IPC channel', async () => {
    const r = rig()
    const h = await r.start()
    expect(r.call(STATUS_CHANNEL)).toMatchObject({ configured: true, yard: 'acme-dev' })
    const env = h.terminalEnv('term_1')
    expect(env.HAWL_FOREMAN_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(env.HAWL_AGENT_ID).toBe('term_1')
    expect(env.HAWL_FOREMAN_TOKEN.length).toBeGreaterThan(20)
    for (const ch of FOREMAN_CHANNELS) {
      expect(r.handlers.has(ch), ch).toBe(true)
    }
    // The renderer never sees the token.
    expect(JSON.stringify(r.call(STATUS_CHANNEL))).not.toContain(env.HAWL_FOREMAN_TOKEN)
    // Not the app window: refused.
    expect(() => r.handlers.get(STATUS_CHANNEL)?.({ ok: false })).toThrow(/app window only/)
    expect(() => r.handlers.get('hawl:foreman:jobs')?.({ ok: false })).toThrow(/app window only/)
  })

  it('S48: with no identity file only the status channel exists and it says why', async () => {
    const r = rig({ identity: undefined })
    const h = await r.start()
    expect(h.runtime).toBeNull()
    expect(r.call(STATUS_CHANNEL)).toEqual({ configured: false, reason: null })
    expect([...r.handlers.keys()]).toEqual([STATUS_CHANNEL])
    await h.stop()
    expect(r.handlers.size).toBe(0)
  })

  it('S48: an identity file that cannot be used is named, not guessed at', async () => {
    const r = rig({ identity: undefined })
    mkdirSync(join(r.dir, 'hawl'), { recursive: true })
    writeFileSync(join(r.dir, 'hawl', 'foreman-identity.json'), JSON.stringify({ yard: 'Acme Dev' }))
    await r.start()
    expect(r.call(STATUS_CHANNEL)).toMatchObject({ configured: false, reason: expect.stringMatching(/slug/) })
  })

  it('S48: the identity file is read from the user-data folder', async () => {
    const r = rig({ identity: undefined })
    mkdirSync(join(r.dir, 'hawl'), { recursive: true })
    writeFileSync(join(r.dir, 'hawl', 'foreman-identity.json'), JSON.stringify(ID))
    await r.start()
    expect(r.call(STATUS_CHANNEL)).toMatchObject({ configured: true, yard: 'acme-dev' })
  })

  it('S48: identity values are checked', () => {
    expect(parseIdentity(ID)).toEqual(ID)
    expect(parseIdentity({ ...ID, yardId: 'x' })).toMatch(/vil_/)
    expect(parseIdentity({ ...ID, visibility: 'loud' })).toMatch(/visibility/)
    expect(parseIdentity({ ...ID, directLines: 'sometimes' })).toMatch(/directLines/)
    expect(parseIdentity({ ...ID, owner: '' })).toMatch(/required/)
    expect(parseIdentity([])).toMatch(/object/)
  })
})

describe('S9/S15 a job travels from the Dispatcher to an agent in a terminal and back', () => {
  it('S9: offer from the Dispatcher, agent through the door, done to the relay; the app is told at each step', async () => {
    const r = rig()
    r.signIn()
    const h = await r.start()
    r.call('hawl:foreman:set-menu', [{ id: 'fix-bug', description: 'Fix a bug' }])
    r.call('hawl:foreman:publish-menu')
    const env = h.terminalEnv('term_1')
    const door = async (path: string, body: unknown) => {
      const res = await fetch(env.HAWL_FOREMAN_URL + path, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.HAWL_FOREMAN_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
      return { status: res.status, json: (await res.json()) as Record<string, unknown> }
    }
    expect((await door('/v1/up', { agentId: 'term_1', label: 'Terminal 1' })).status).toBe(200)
    h.fromDispatcher({
      yard: 'acme-dev',
      task_id: 'hnd_1',
      event: 'offer',
      at: new Date().toISOString(),
      capability: 'fix-bug'
    })
    expect(r.emitted.some((e) => e.channel === 'hawl:foreman:agent-event')).toBe(true)
    expect((await door('/v1/accept', { agentId: 'term_1', taskId: 'hnd_1', epoch: 1 })).status).toBe(200)
    const sha = 'b'.repeat(40)
    expect(
      (await door('/v1/done', { agentId: 'term_1', taskId: 'hnd_1', epoch: 1, revisionSha: sha, evidence: [{ kind: 'sha', ref: sha }] })).status
    ).toBe(200)
    await new Promise((res) => setTimeout(res, 20))
    expect(r.call('hawl:foreman:job', 'hnd_1')).toMatchObject({ state: 'done', exec: null })
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual(
      expect.arrayContaining([
        'PUT /v1/yards/vil_yard1/sites/twn_site1/menu',
        'POST /v1/handoffs/hnd_1/foreman',
        'POST /v1/handoffs/hnd_1/act'
      ])
    )
    expect(r.emitted.some((e) => e.channel === 'hawl:foreman:changed')).toBe(true)
    // Then the Dispatcher verifies it.
    h.fromDispatcher({ yard: 'acme-dev', task_id: 'hnd_1', event: 'verify', at: new Date().toISOString(), revision_sha: sha, result: 'pass' })
    expect(r.call('hawl:foreman:job', 'hnd_1')).toMatchObject({ state: 'verified' })
  })

  it('S21: signed out, the accept waits in the outbox, the owner sees it waiting, and it goes once the sign-in is there', async () => {
    const r = rig()
    const h = await r.start()
    r.call('hawl:foreman:set-menu', [{ id: 'fix-bug', description: 'Fix a bug' }])
    r.call('hawl:foreman:publish-menu')
    h.fromDispatcher({ yard: 'acme-dev', task_id: 'hnd_2', event: 'offer', at: new Date().toISOString(), capability: 'fix-bug' })
    await new Promise((res) => setTimeout(res, 20))
    const box = r.call('hawl:foreman:outbox') as { waiting: { effect: { kind: string }; lastError: string }[] }
    expect(box.waiting.map((w) => w.effect.kind)).toEqual(['menu', 'lifecycle'])
    expect(box.waiting[0].lastError).toMatch(/not signed in/)
    expect(r.call('hawl:foreman:job', 'hnd_2')).toMatchObject({ state: 'accepted' })
    r.signIn()
    // The runtime's own timer retries after the first back-off second.
    await new Promise((res) => setTimeout(res, 1300))
    expect((r.call('hawl:foreman:outbox') as { waiting: unknown[] }).waiting).toEqual([])
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toContain('POST /v1/handoffs/hnd_2/foreman')
  })

  it('S21: the saved state comes back on the next start: the job, the rule and the unsent update', async () => {
    const r = rig()
    const h1 = await r.start()
    r.call('hawl:foreman:set-menu', [{ id: 'fix-bug', description: 'Fix a bug' }])
    r.call('hawl:foreman:publish-menu')
    r.call('hawl:foreman:add-rule', { capability: 'fix-bug' }, 'term_9')
    h1.fromDispatcher({ yard: 'acme-dev', task_id: 'hnd_3', event: 'offer', at: new Date().toISOString(), capability: 'fix-bug' })
    await h1.stop()
    live.length = 0
    const r2 = { ...r, handlers: new Map() }
    r2.opts.ipc = {
      handle: (ch, fn) => r2.handlers.set(ch, fn),
      removeHandler: (ch) => r2.handlers.delete(ch)
    }
    const h2 = await startHawlForeman(r2.opts)
    live.push(h2)
    const c2 = (ch: string, ...a: unknown[]) => r2.handlers.get(ch)?.({ ok: true }, ...a)
    expect(c2('hawl:foreman:job', 'hnd_3')).toMatchObject({ state: 'accepted' })
    expect(c2('hawl:foreman:rules')).toMatchObject([{ action: { agentId: 'term_9' } }])
    expect((c2('hawl:foreman:outbox') as { waiting: unknown[] }).waiting.length).toBeGreaterThan(0)
  })
})

describe('S9 the stand-in Dispatcher channel exists only on request', () => {
  it('S9: off by default; on with dev, it makes a job the owner can see', async () => {
    const off = rig()
    await off.start()
    expect(off.handlers.has(DEV_OFFER_CHANNEL)).toBe(false)
    const on = rig({ dev: true })
    await on.start()
    on.call('hawl:foreman:set-menu', [{ id: 'fix-bug', description: 'Fix a bug' }])
    on.call('hawl:foreman:publish-menu')
    on.call(DEV_OFFER_CHANNEL, 'hnd_dev', 'fix-bug')
    expect(on.call('hawl:foreman:jobs')).toMatchObject([{ taskId: 'hnd_dev', state: 'accepted' }])
    expect(() => on.handlers.get(DEV_OFFER_CHANNEL)?.({ ok: false }, 'x')).toThrow(/app window only/)
  })
})
