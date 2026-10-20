// Prints every non-Hawl, non-test file that differs from the upstream base, grouped by folder.
// Usage: node src/hawl/tools/list-fork-hooks.mjs [baseRef]   (default 20fc7af55 = Orca base)
// The output is pasted into FORK-HOOKS.md under "Complete list". Re-run after each upstream merge.
import { execFileSync } from 'node:child_process'

const base = process.argv[2] ?? '20fc7af55'
const out = execFileSync('git', ['diff', '--name-only', base, 'HEAD'], { encoding: 'utf8' })
const files = out
  .split('\n')
  .filter(Boolean)
  .filter((f) => !f.startsWith('src/hawl/') && !f.startsWith('_progress/'))
  .filter((f) => !/\.(test|spec)\./.test(f))
const groups = new Map()
for (const f of files) {
  const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.'
  if (!groups.has(dir)) {
    groups.set(dir, [])
  }
  groups.get(dir).push(f.slice(f.lastIndexOf('/') + 1))
}
const lines = []
for (const [dir, names] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
  lines.push(`- \`${dir}/\`: ${names.map((n) => `\`${n}\``).join(', ')}`)
}
console.log(`${files.length} files (tests excluded; test files changed alongside are not listed)\n`)
console.log(lines.join('\n'))
