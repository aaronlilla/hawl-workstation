import type React from 'react'
import { FolderPlus, GitBranchPlus } from 'lucide-react'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import type { ShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import wordmark from '../art/hawl-wordmark.webp'
import restingHelper from '../art/empty-quiet.webp'

export type HawlLandingShortcut = {
  id: string
  shortcut: ShortcutKeyComboDetails
  action: string
}

/** Empty home (G03): the page is the ground, the helper rests on it, one lit action. */
export function HawlLanding({
  hasProjects,
  createTargetLabel,
  shortcuts,
  banner,
  onAddProject,
  onCreate
}: {
  hasProjects: boolean
  createTargetLabel: string
  shortcuts: HawlLandingShortcut[]
  banner: React.ReactNode
  onAddProject: () => void
  onCreate: () => void
}): React.JSX.Element {
  return (
    <div className="hawl-home" data-hawl-home>
      <img className="hawl-home-art" src={restingHelper} alt="" aria-hidden draggable={false} />
      <div className="hawl-home-copy">
        <img className="hawl-home-mark" src={wordmark} alt="Hawl" draggable={false} />
        <h1 className="hawl-home-title">
          {hasProjects ? 'Pick a workspace' : 'Start your first project'}
        </h1>
        <p className="hawl-home-sub">
          {hasProjects
            ? 'Select a workspace from the sidebar to begin.'
            : 'Add a project to get started.'}
        </p>
        {banner}
        <div className="hawl-home-actions">
          <button type="button" className="hawl-btn hawl-btn-lit" onClick={onAddProject}>
            <FolderPlus aria-hidden />
            Add project
          </button>
          <button type="button" className="hawl-btn hawl-btn-acrylic" onClick={onCreate}>
            <GitBranchPlus aria-hidden />
            Create {createTargetLabel.toLowerCase()}
          </button>
        </div>
        <div className="hawl-home-keys">
          {shortcuts.map((item) => (
            <div key={item.id} className="hawl-home-key-row">
              <span>{item.action}</span>
              <ShortcutKeyCombo
                keys={item.shortcut.keys}
                doubleTap={item.shortcut.doubleTap}
                className="inline-flex gap-1"
                keyCapClassName="hawl-kcap"
                separatorClassName="hidden"
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
