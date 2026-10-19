// The foreman screen: what is waiting for the owner, every job and who has it, the agents, and the few controls
// the plan puts in the yard console (paused, auto-accept, hold and release times).
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import type { HawlForemanApi } from '../../preload/foreman'
import { JobCard } from './JobCard'
import type { ForemanData } from './useForeman'

type Act = (fn: (api: HawlForemanApi) => Promise<unknown>) => Promise<void>

const HOUR = 60 * 60 * 1000

function Times({
  holdMs,
  releaseMs,
  act
}: {
  holdMs: number
  releaseMs: number
  act: Act
}): React.JSX.Element {
  const [hold, setHold] = useState(String(holdMs / HOUR))
  const [release, setRelease] = useState(String(releaseMs / HOUR))
  const field = 'h-7 w-16 rounded-md border border-border bg-background px-2 text-sm'
  return (
    <form
      className="flex flex-wrap items-center gap-2 text-sm"
      onSubmit={(e) => {
        e.preventDefault()
        void act((api) => api.setTimes(Math.round(Number(hold) * HOUR), Math.round(Number(release) * HOUR)))
      }}
    >
      <label className="flex items-center gap-1">
        Tell me after
        <input aria-label="Hold hours" className={field} value={hold} onChange={(e) => setHold(e.target.value)} />h
      </label>
      <label className="flex items-center gap-1">
        give back after
        <input aria-label="Release hours" className={field} value={release} onChange={(e) => setRelease(e.target.value)} />h
      </label>
      <Button type="submit" size="xs" variant="outline">
        Save
      </Button>
    </form>
  )
}

export function ForemanPanel({
  data,
  error,
  act
}: {
  data: ForemanData
  error: string | null
  act: Act
}): React.JSX.Element {
  if (!data.status.configured) {
    return (
      <div className="space-y-2 p-4 text-sm">
        <div className="font-medium">The foreman is not set up yet</div>
        <p className="text-muted-foreground">
          {data.status.reason ?? 'Sign in to Hawl and register this workstation as a yard to start taking work.'}
        </p>
      </div>
    )
  }
  const { jobs, agents, settings, outbox } = data
  const waiting = jobs.filter((j) => j.exec === 'held')
  const rest = jobs.filter((j) => j.exec !== 'held')
  return (
    <div className="max-h-[70vh] space-y-4 overflow-y-auto p-4">
      <header className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">{data.status.displayName}</div>
          <div className="text-xs text-muted-foreground">
            {settings?.paused ? 'Paused: new jobs are turned away' : 'Taking work'}
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void act((api) => (settings?.paused ? api.resume() : api.pause()))}
        >
          {settings?.paused ? 'Resume' : 'Pause'}
        </Button>
      </header>

      <label className="flex items-center justify-between gap-2 text-sm">
        Accept new jobs without asking me
        <Switch
          aria-label="Accept new jobs without asking me"
          checked={settings?.autoAccept ?? true}
          onCheckedChange={(v) => void act((api) => api.setAutoAccept(v))}
        />
      </label>

      {settings ? <Times key={`${settings.holdMs}-${settings.releaseMs}`} holdMs={settings.holdMs} releaseMs={settings.releaseMs} act={act} /> : null}

      {error ? <div role="alert" className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">{error}</div> : null}
      {outbox.waiting.length > 0 ? (
        <div className="rounded-md bg-muted p-2 text-xs">
          {outbox.waiting.length} update{outbox.waiting.length === 1 ? '' : 's'} waiting to reach Hawl
          {outbox.waiting[0].lastError ? ` (${outbox.waiting[0].lastError})` : ''}. They will go as soon as the connection is back.
        </div>
      ) : null}
      {outbox.dead.length > 0 ? (
        <div className="rounded-md bg-muted p-2 text-xs">
          {outbox.dead.length} update{outbox.dead.length === 1 ? ' was' : 's were'} refused by Hawl: {outbox.dead.at(-1)?.reason}
        </div>
      ) : null}

      {waiting.length > 0 ? (
        <section aria-label="Waiting for you">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Waiting for you</h3>
          <ul className="space-y-2">
            {waiting.map((j) => (
              <JobCard key={j.taskId} job={j} agents={agents} act={act} />
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="Jobs">
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Jobs</h3>
        {rest.length === 0 ? (
          <p className="text-sm text-muted-foreground">No jobs yet. Work sent to your yard shows up here.</p>
        ) : (
          <ul className="space-y-2">
            {rest.map((j) => (
              <JobCard key={j.taskId} job={j} agents={agents} act={act} />
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Agents">
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Agents in your yard</h3>
        {agents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No agent is connected. A terminal joins when its agent says hello to the foreman.
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {agents.map((a) => (
              <li key={a.id} className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={`size-2 rounded-full ${a.online && !a.away ? 'bg-green-500' : 'bg-muted-foreground/40'}`}
                />
                {a.label}
                <span className="text-xs text-muted-foreground">{!a.online ? 'offline' : a.away ? 'away' : 'online'}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
