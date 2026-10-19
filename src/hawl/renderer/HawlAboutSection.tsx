import type React from 'react'
import { Separator } from '@/components/ui/separator'
import { HawlAboutRow } from './shell/HawlAbout'

// Settings > General keeps one row that opens the About screen (shell/HawlAbout.tsx), so About is a
// screen of its own, also reachable from the Help menu, not a block at the bottom of a settings pane.
export function HawlAboutSection({
  hasPrecedingSections
}: {
  hasPrecedingSections: boolean
}): React.JSX.Element {
  return (
    <>
      {hasPrecedingSections ? <Separator /> : null}
      <HawlAboutRow />
    </>
  )
}
