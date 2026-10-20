// Everything the foreman screen shows, fetched from the main process and refreshed whenever it says something changed.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { HawlForemanApi } from '../../preload/foreman'
import type { DeadEffect, ForemanRule, AgentInfo, JobView, OutboxItem } from '../../main/foreman/types'
import type { SettingsView } from '../../main/foreman/settings'
import type { ForemanStatus } from '../../main/foreman/start'

export type ForemanData = {
  status: ForemanStatus
  jobs: JobView[]
  agents: AgentInfo[]
  settings: SettingsView | null
  rules: ForemanRule[]
  outbox: { waiting: OutboxItem[]; dead: DeadEffect[] }
}

declare global {
  // Augmenting the global Window can only be done with an interface.
  // oxlint-disable-next-line typescript/consistent-type-definitions
  interface Window {
    hawl?: { foreman: HawlForemanApi }
  }
}

export function foremanApi(): HawlForemanApi | null {
  return window.hawl?.foreman ?? null
}

export function useForeman(): {
  data: ForemanData | null
  error: string | null
  act: (fn: (api: HawlForemanApi) => Promise<unknown>) => Promise<void>
} {
  const [data, setData] = useState<ForemanData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)

  const refresh = useCallback(async () => {
    const api = foremanApi()
    if (!api) {
      return
    }
    try {
      const status = (await api.status()) as ForemanStatus
      if (!status.configured) {
        setData({
          status,
          jobs: [],
          agents: [],
          settings: null,
          rules: [],
          outbox: { waiting: [], dead: [] }
        })
        return
      }
      const [jobs, agents, settings, rules, outbox] = await Promise.all([
        api.jobs(),
        api.agents(),
        api.settings(),
        api.rules(),
        api.outbox()
      ])
      setData({
        status,
        jobs: jobs as JobView[],
        agents: agents as AgentInfo[],
        settings: settings as SettingsView,
        rules: rules as ForemanRule[],
        outbox: outbox as ForemanData['outbox']
      })
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    const api = foremanApi()
    if (!api) {
      return undefined
    }
    void refresh()
    // A burst of changes makes one fetch.
    const off = api.onChanged(() => {
      if (pending.current) {
        return
      }
      pending.current = true
      setTimeout(() => {
        pending.current = false
        void refresh()
      }, 30)
    })
    // Times in a job's status text move on their own; look again now and then.
    const poll = setInterval(() => void refresh(), 15_000)
    return () => {
      off()
      clearInterval(poll)
    }
  }, [refresh])

  const act = useCallback(
    async (fn: (api: HawlForemanApi) => Promise<unknown>) => {
      const api = foremanApi()
      if (!api) {
        return
      }
      try {
        await fn(api)
        setError(null)
      } catch (err) {
        // Electron prefixes the message with the channel; the rest is the plain reason.
        setError((err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      }
      await refresh()
    },
    [refresh]
  )

  return { data, error, act }
}
