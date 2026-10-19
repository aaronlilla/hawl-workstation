import type React from 'react'
import wordmark from '../art/hawl-wordmark.webp'

/** Brand block at the top of the Hawl sidebar (H01): the wordmark straight on the surface, no plate. */
export function HawlSidebarBrand(): React.JSX.Element {
  return (
    <div className="hawl-brand" data-hawl-brand>
      <img src={wordmark} alt="Hawl" draggable={false} />
    </div>
  )
}
