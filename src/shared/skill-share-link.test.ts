import { describe, expect, it } from 'vitest'
import { parseSkillShareId, skillShareIdFromArguments } from './skill-share-link'

describe('skill share deep links', () => {
  it('parses hawl:// and orca:// skill share links', () => {
    expect(parseSkillShareId('hawl://skills/share/abc123')).toBe('abc123')
    expect(parseSkillShareId('orca://skills/share/abc123')).toBe('abc123')
    expect(parseSkillShareId('hawl://other/abc123')).toBeNull()
  })

  it('finds a hawl:// link in launch arguments', () => {
    expect(skillShareIdFromArguments(['app.exe', 'hawl://skills/share/zz9'])).toBe('zz9')
  })
})
