import React from 'react'

/** F09 shows every combo as separate key caps (Ctrl + K). Orca prints a combo as one string, so split it here.
 *  Non-string children and strings with no `+` pass through unchanged. */
export function splitShortcutKeys(children: React.ReactNode): {
  keys: React.ReactNode
  split: boolean
} {
  if (typeof children !== 'string' || children.length < 3 || !children.includes('+')) {
    return { keys: children, split: false }
  }
  const parts = children.split('+').filter((part) => part.length > 0)
  if (parts.length < 2) {
    return { keys: children, split: false }
  }
  return {
    split: true,
    keys: parts.map((part, index) => (
      <React.Fragment key={`${part}-${index}`}>
        {index > 0 ? <span className="hawl-key-plus">+</span> : null}
        <kbd className="hawl-key">{part}</kbd>
      </React.Fragment>
    ))
  }
}
