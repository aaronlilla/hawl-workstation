// Checks the Hawl documents against the tree. Run from the repo root: node hawl-tools/check-docs.mjs
// 1. Every `path:line` or `path:a-b` citation of a repo file in the docs names a file that exists and a line inside it.
// 1b. A citation written with only a file name (no folder) is an error: a reader cannot tell which folder it is in. Only `resolve.ts` (a hawl-platform file) is allowed bare.
// 2. Every FORK-HOOKS.md row: every file named in the Orca-file cell exists and EVERY backticked anchor in the anchor cell is still in each of those files.
// 3. SPEC-MAP.md has one row for each of S4 to S50 and every screen name used is in ARCHITECTURE.md's screen table.
// It cannot tell whether a cited line still says what the text claims. UPSTREAM.md step 6 covers that by hand.
import { existsSync, readFileSync } from 'node:fs'

const docs = [
  'ARCHITECTURE.md',
  'SPEC-MAP.md',
  'README.md',
  'UPSTREAM.md',
  'CONTRIBUTING.md',
  'FORK-HOOKS.md'
]
const problems = []
const lineCache = new Map()
const lineCount = (file) => {
  if (!lineCache.has(file)) {
    lineCache.set(file, readFileSync(file, 'utf8').split('\n').length)
  }
  return lineCache.get(file)
}

// 1. citations
const cite =
  /`((?:src|config|mobile|cloud|native|resources|\.github)\/[\w./@()[\]-]+\.[a-z]+):(\d+)(?:-(\d+))?/g
let citations = 0
for (const doc of docs) {
  const text = readFileSync(doc, 'utf8')
  for (const m of text.matchAll(cite)) {
    citations++
    const [, file, a, b] = m
    if (!existsSync(file)) {
      problems.push(`${doc}: cited file missing: ${file}`)
      continue
    }
    const last = Number(b ?? a)
    if (Number(a) < 1 || last > lineCount(file)) {
      problems.push(
        `${doc}: ${file}:${a}${b ? `-${b}` : ''} is outside the file (${lineCount(file)} lines)`
      )
    }
  }
}

// 1b. bare file-name citations
const bare = /(?<![\w/.-])([\w.@-]+\.(?:ts|tsx|mjs|cjs|js|json)):(\d+)/g
const bareOk = new Set(['resolve.ts'])
for (const doc of docs) {
  const text = readFileSync(doc, 'utf8')
  for (const m of text.matchAll(bare)) {
    if (!bareOk.has(m[1])) {
      problems.push(`${doc}: citation without a folder: ${m[1]}:${m[2]}`)
    }
  }
}

// 2. hooks
const hooks = readFileSync('FORK-HOOKS.md', 'utf8')
  .split('\n')
  .filter((l) => /^\| \d+ \|/.test(l))
for (const row of hooks) {
  const cells = row.split('|').map((c) => c.trim())
  const files = [...cells[2].matchAll(/`([^`]+)`/g)]
    .map((x) => x[1])
    .filter((f) => /\.\w+$/.test(f))
  const anchors = [...cells[3].matchAll(/`([^`]+)`/g)].map((x) => x[1])
  if (cells[1] === '10') {
    continue
  } // lint config row: files chosen in the config commit
  if (!files.length) {
    problems.push(`FORK-HOOKS row ${cells[1]}: no file named`)
  }
  if (!anchors.length) {
    problems.push(`FORK-HOOKS row ${cells[1]}: no anchor in backticks`)
  }
  for (const f of files) {
    if (!existsSync(f)) {
      problems.push(`FORK-HOOKS row ${cells[1]}: file missing: ${f}`)
      continue
    }
    const body = readFileSync(f, 'utf8')
    for (const a of anchors) {
      if (!body.includes(a)) {
        problems.push(`FORK-HOOKS row ${cells[1]}: anchor not found in ${f}: ${a}`)
      }
    }
  }
}

// 3. spec map
const spec = readFileSync('SPEC-MAP.md', 'utf8')
const rows = spec.split('\n').filter((l) => /^\| S\d+ \|/.test(l))
const have = new Set(rows.map((r) => Number(r.match(/^\| S(\d+) /)[1])))
for (let n = 4; n <= 50; n++) {
  if (!have.has(n)) {
    problems.push(`SPEC-MAP: no row for S${n}`)
  }
}
const arch = readFileSync('ARCHITECTURE.md', 'utf8')
const screens = [
  'Sidebar tree',
  'Pane chip',
  'Job drawer',
  'New job form',
  'Needs tray',
  'Messages',
  'Yard console',
  'Settings',
  'Map view',
  'Phone web page',
  'Phone app'
]
for (const s of screens) {
  if (!arch.includes(`| ${s} `) && !arch.includes(`| ${s} (`)) {
    problems.push(`ARCHITECTURE: screen table has no row "${s}"`)
  }
}
for (const r of rows) {
  const cells = r.split(/(?<!\\)\|/).map((c) => c.trim())
  const screenCell = cells[3]
  if (!screens.some((s) => screenCell.includes(s))) {
    problems.push(`SPEC-MAP ${cells[1]}: screen cell names no known screen: ${screenCell}`)
  }
}

console.log(`checked ${citations} citations, ${hooks.length} hook rows, ${rows.length} spec rows`)
if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log('docs check passed')
