// One job on the foreman screen: where it is, who has it, why, and what the owner can do about it.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { HawlForemanApi } from '../../preload/foreman'
import type { AgentInfo, JobView } from '../../main/foreman/types'

type Act = (fn: (api: HawlForemanApi) => Promise<unknown>) => Promise<void>

const short = (id: string): string => (id.length > 14 ? `${id.slice(0, 6)}...${id.slice(-5)}` : id)

function holderText(job: JobView, agents: AgentInfo[]): string {
  if (job.holder === 'foreman') {
    return 'with the foreman'
  }
  return `with ${agents.find((a) => a.id === job.holder)?.label ?? job.holder}`
}

export function JobCard({
  job,
  agents,
  act
}: {
  job: JobView
  agents: AgentInfo[]
  act: Act
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const route = job.routing.at(-1)
  const last = job.history.at(-1)
  const waitingOwner = job.exec === 'held'
  const live = job.state === 'asked' || job.state === 'accepted'
  const others = agents.filter((a) => a.id !== job.holder)

  return (
    <li className="rounded-md border border-border bg-card p-3 text-sm" data-job={job.taskId}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium">
            {job.capability ?? 'Free-form job'} <span className="text-muted-foreground">{short(job.taskId)}</span>
          </div>
          <div className="text-xs text-muted-foreground">{job.statusText}</div>
        </div>
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs">{job.state}</span>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {job.state === 'accepted' && job.exec !== 'queued' ? holderText(job, agents) : null}
        {route ? ` · why: ${route.via}` : ''}
      </div>
      {job.needsHuman ? (
        <div className="mt-2 rounded bg-muted p-2 text-xs">
          This job stopped and needs a person.
          <Button
            size="xs"
            variant="outline"
            className="ml-2"
            onClick={() => void act((api) => api.resumeJob(job.taskId))}
          >
            Try again
          </Button>
        </div>
      ) : null}
      {waitingOwner ? (
        <div className="mt-2 flex gap-2">
          <Button size="xs" onClick={() => void act((api) => api.ownerDecision(job.taskId, 'accept'))}>
            Accept
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() => void act((api) => api.ownerDecision(job.taskId, 'decline', 'declined by owner'))}
          >
            Decline
          </Button>
        </div>
      ) : null}
      {job.state === 'accepted' ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            onClick={() => void act((api) => api.decline(job.taskId, 'handed back by owner'))}
          >
            Hand back
          </Button>
          {others.length > 0 ? (
            <select
              aria-label="Send to another agent"
              className="h-6 rounded-md border border-border bg-background px-1 text-xs"
              value=""
              onChange={(e) => {
                if (e.target.value) {
                  void act((api) => api.reroute(job.taskId, e.target.value, 'moved by owner', false))
                }
              }}
            >
              <option value="">Send to...</option>
              {others.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      ) : null}
      {job.history.length > 0 || job.routing.length > 0 ? (
        <button
          type="button"
          className="mt-2 text-xs text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setOpen(!open)}
        >
          {open ? 'Hide trail' : 'Trail'}
        </button>
      ) : null}
      {open ? (
        <ol className="mt-1 space-y-0.5 text-xs text-muted-foreground">
          {job.routing.map((r) => (
            <li key={`r${r.epoch}`}>
              offered to {r.agentId}: {r.via}
              {r.skipped.length > 0
                ? ` (passed over: ${r.skipped.map((s) => `${s.agentId} ${s.why}`).join(', ')})`
                : ''}
            </li>
          ))}
          {job.history.map((h) => (
            <li key={`${h.at}-${h.kind}`}>
              {h.kind} by {h.by}
              {h.reason ? `: ${h.reason}` : ''}
            </li>
          ))}
        </ol>
      ) : last && !live ? (
        <div className="mt-1 text-xs text-muted-foreground">
          {last.kind}
          {last.reason ? `: ${last.reason}` : ''}
        </div>
      ) : null}
    </li>
  )
}
