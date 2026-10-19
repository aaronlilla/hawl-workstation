// A small "Foreman" button in the corner of the window. It shows whether the foreman needs the owner,
// and opens the foreman screen. The one line that mounts it is listed in FORK-HOOKS.md.
import { useState } from 'react'
import { ForemanPanel } from './ForemanPanel'
import { foremanApi, useForeman } from './useForeman'

export function ForemanDock(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const { data, error, act } = useForeman()
  if (!foremanApi() || !data) {
    return null
  }
  const needsYou = data.jobs.filter((j) => j.exec === 'held' || j.needsHuman).length
  const live = data.status.configured && !data.settings?.paused
  const label = !data.status.configured
    ? 'Foreman: not set up'
    : needsYou > 0
      ? `Foreman: ${needsYou} need${needsYou === 1 ? 's' : ''} you`
      : data.settings?.paused
        ? 'Foreman: paused'
        : 'Foreman'
  return (
    <div className="pointer-events-none fixed bottom-10 right-3 z-50 flex flex-col items-end gap-2" data-hawl="foreman-dock">
      {open ? (
        <div
          role="dialog"
          aria-label="Foreman"
          className="pointer-events-auto w-[26rem] max-w-[calc(100vw-1.5rem)] rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
        >
          <ForemanPanel data={data} error={error} act={act} />
        </div>
      ) : null}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="pointer-events-auto flex items-center gap-2 rounded-full border border-border bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-md hover:bg-accent"
      >
        <span aria-hidden className={`size-2 rounded-full ${needsYou > 0 ? 'bg-amber-500' : live ? 'bg-green-500' : 'bg-muted-foreground/50'}`} />
        {label}
      </button>
    </div>
  )
}
