import type { ChangelogData } from '../shared/update-status-types'

/** Hawl Workstation: the hosted "what's new" feed is removed; release notes are on the GitHub releases page. */
export async function fetchChangelog(
  _incomingVersion: string,
  _localVersion: string
): Promise<ChangelogData | null> {
  return null
}
