// IPC: who may call, and that every owner control from the plan (paused, auto-accept, hold times, menu editor,
// rules, cards, heartbeat, queue handover) is reachable and checked.
import { describe, expect, it } from 'vitest'
import { FOREMAN_CHANNELS, registerForemanIpc, topFrameOf } from './ipc'
import type { IpcLike } from './ipc'
import { HOUR_MS, MINUTE_MS } from './rig.test-support'
import { setup } from './runtime.test-support'

function ipcRig(trusted: (e: unknown) => boolean = () => true) {
  const s = setup()
  s.rt.start()
  s.rt.run((f) => f.publishMenu())
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  const ipc: IpcLike = {
    handle: (ch, fn) => handlers.set(ch, fn),
    removeHandler: (ch) => handlers.delete(ch)
  }
  registerForemanIpc(ipc, s.rt, { trusted })
  const call = (ch: string, ...args: unknown[]) => handlers.get(ch)?.({ marker: 'ok' }, ...args)
  const fail = (ch: string, ...args: unknown[]): string => {
    try {
      call(ch, ...args)
      return 'no error'
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }
  return { ...s, handlers, call, fail }
}

describe('S9 only the app window may call the foreman', () => {
  it('S9: every channel refuses a sender that is not trusted, and changes nothing', () => {
    const { handlers, rig } = ipcRig(() => false)
    expect(handlers.size).toBe(FOREMAN_CHANNELS.length)
    for (const ch of FOREMAN_CHANNELS) {
      let code = ''
      try {
        handlers.get(ch)?.({}, 'j1', 'accept')
      } catch (e) {
        code = (e as { code?: string }).code ?? String(e)
      }
      expect(code, ch).toBe('untrusted_sender')
    }
    expect(rig.foreman.paused).toBe(false)
    expect(rig.handBacks).toEqual([])
  })

  it('S9: the top frame of the window at an app address is trusted; an iframe, a stranger and a missing sender are not', () => {
    const main = {}
    const ok = (url: string) => url.startsWith('file:///app/') || url === 'http://localhost:5173/'
    const trusted = topFrameOf(ok)
    const ev = (frame: unknown, mainFrame: unknown = main) => ({
      senderFrame: frame,
      sender: { mainFrame }
    })
    expect(trusted(ev(Object.assign(main, { url: 'file:///app/index.html', parent: null })))).toBe(true)
    expect(trusted(ev(Object.assign(main, { url: 'http://localhost:5173/', parent: null })))).toBe(true)
    // Same address, but an embedded frame (a plugin panel).
    const iframe = { url: 'file:///app/panel.html', parent: main }
    expect(trusted(ev(iframe))).toBe(false)
    // A top frame at a page that is not the app.
    const other = { url: 'https://example.com/', parent: null }
    expect(trusted(ev(other, other))).toBe(false)
    // A frame that is not that window's top frame.
    expect(trusted(ev({ url: 'file:///app/index.html', parent: null }, main))).toBe(false)
    expect(trusted(null)).toBe(false)
    expect(trusted({})).toBe(false)
    expect(trusted({ senderFrame: null, sender: { mainFrame: main } })).toBe(false)
  })
})

describe('S15/S18 the console controls from the plan', () => {
  it('S15: auto-accept off makes the next job wait for the owner; on again accepts', () => {
    const { rig, call } = ipcRig()
    call('hawl:foreman:set-auto-accept', false)
    expect(call('hawl:foreman:settings')).toMatchObject({ autoAccept: false })
    expect(rig.send('j1').outcome).toBe('held')
    call('hawl:foreman:set-auto-accept', true)
    expect(rig.send('j2').outcome).toBe('accepted')
  })

  it('S18: hold and release times are read, changed, refused when out of range, and shown in the next menu', () => {
    const { rig, call, fail } = ipcRig()
    expect(call('hawl:foreman:settings')).toMatchObject({ holdMs: 4 * HOUR_MS, releaseMs: 24 * HOUR_MS })
    call('hawl:foreman:set-times', HOUR_MS, 3 * HOUR_MS)
    expect(call('hawl:foreman:settings')).toMatchObject({ holdMs: HOUR_MS, releaseMs: 3 * HOUR_MS })
    expect(fail('hawl:foreman:set-times', 10, 3 * HOUR_MS)).toMatch(/1 minute/)
    expect(fail('hawl:foreman:set-times', 'x', 1)).toMatch(/whole number/)
    expect(fail('hawl:foreman:set-times', -5, null)).toMatch(/whole number/)
    expect(call('hawl:foreman:settings')).toMatchObject({ holdMs: HOUR_MS })
    call('hawl:foreman:publish-menu')
    expect(rig.menus.at(-1)?.extended).toMatchObject({ hold_minutes: 60, release_minutes: 180 })
    rig.send('j1')
    rig.adv(HOUR_MS + MINUTE_MS)
    expect(rig.notices).toEqual([{ kind: 'job_held_offline', taskId: 'j1' }])
  })

  it('S12: the menu editor reads the draft and the published menu, and edits are checked', () => {
    const { call, fail } = ipcRig()
    call('hawl:foreman:set-menu', [{ id: 'fix-bug', description: 'Fix a bug' }])
    expect(call('hawl:foreman:menu')).toMatchObject({
      draft: [{ id: 'fix-bug' }],
      published: [{ id: 'fix-bug' }, { id: 'review-pr' }, { id: 'audit' }, { id: 'night-shift' }, { id: 'closed-cap' }],
      revision: 1
    })
    expect(fail('hawl:foreman:set-menu', [null])).toMatch(/capability must be an object/)
    expect(fail('hawl:foreman:set-menu', [{ id: 'x' }])).toMatch(/description/)
    expect(fail('hawl:foreman:set-menu', Array.from({ length: 201 }, () => ({ id: 'a', description: 'b' })))).toMatch(/200/)
  })

  it('S19/S20: rules are added, listed and removed; a rule with nothing to match is refused', () => {
    const { rig, call, fail } = ipcRig()
    call('hawl:foreman:add-rule', { capability: 'fix-bug' }, 'a2')
    expect(call('hawl:foreman:rules')).toMatchObject([
      { match: { capability: 'fix-bug' }, action: { agentId: 'a2' }, source: 'owner' }
    ])
    rig.foreman.agentUp('a1')
    rig.foreman.agentUp('a2')
    rig.send('j1')
    expect(rig.offers[0].agentId).toBe('a2')
    const id = (call('hawl:foreman:rules') as { id: string }[])[0].id
    call('hawl:foreman:remove-rule', id)
    expect(call('hawl:foreman:rules')).toEqual([])
    expect(fail('hawl:foreman:remove-rule', id)).toMatch(/no rule/)
    expect(fail('hawl:foreman:add-rule', {}, 'a1')).toMatch(/needs a capability/)
    expect(fail('hawl:foreman:add-rule', 'x', 'a1')).toMatch(/object/)
  })

  it('S23/S24/S25: the owner sees every card and busy-untitled rows, and chooses what a site may see', () => {
    const { rig, call, fail } = ipcRig()
    rig.foreman.agentUp('a1')
    rig.foreman.agentUp('a2')
    rig.send('j1')
    rig.claim('j1', 'a1')
    rig.foreman.cards.start('a2', { title: 'Reading the logs' })
    const rows = call('hawl:foreman:cards') as { agentId: string; label: string }[]
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: 'a2', label: 'Reading the logs' }),
        expect.objectContaining({ agentId: 'a1', label: 'busy, untitled' })
      ])
    )
    call('hawl:foreman:publish-cards', 'twn_1', ['state'])
    expect(rig.foreman.cards.publishedFields('twn_1')).toEqual(['state'])
    expect(fail('hawl:foreman:publish-cards', 'twn_1', ['state', 'secret'])).toMatch(/fields/)
  })

  it('S48: the heartbeat is readable; the outbox shows what has not reached the relay', () => {
    const { rig, call } = ipcRig()
    expect(call('hawl:foreman:heartbeat')).toMatchObject({ yard: 'acme-dev', state: 'offline' })
    rig.faults.sendLifecycle = 5
    rig.send('j1')
    const box = call('hawl:foreman:outbox') as { waiting: { effect: { kind: string }; attempts: number }[]; dead: unknown[] }
    expect(box.waiting).toMatchObject([{ effect: { kind: 'lifecycle' }, attempts: 1 }])
    expect(box.dead).toEqual([])
  })

  it('S15: the queue is exported and adopted through the screen, and bad entries are refused', () => {
    const { rig, call, fail } = ipcRig()
    rig.send('j1')
    const out = call('hawl:foreman:export-queue') as unknown[]
    expect(out).toHaveLength(1)
    expect(call('hawl:foreman:adopt-queue', out)).toEqual({ adopted: ['j1'], skipped: [] })
    expect(fail('hawl:foreman:adopt-queue', 'x')).toMatch(/list/)
    expect(fail('hawl:foreman:adopt-queue', [{ offer: {} }])).toMatch(/requester/)
    expect(fail('hawl:foreman:adopt-queue', [{ offer: {}, requester: 'site', acceptedAt: 'now' }])).toMatch(/acceptedAt/)
  })
})
