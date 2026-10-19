// Polls TCP connections of every process started from this checkout's Electron binary and prints
// each distinct remote endpoint, plus the OS DNS cache entries seen afterwards.
// Usage: node src/hawl/tools/net-capture.mjs <seconds> <out.json>
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

const seconds = Number(process.argv[2] ?? 120)
const out = process.argv[3] ?? 'net-capture.json'
const exe = process.env.HAWL_EXE ?? path.resolve('node_modules/electron/dist/electron.exe')

function ps(cmd) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' })
  } catch (error) {
    // A process can exit between listing and querying; keep whatever stdout the query produced.
    return String(error.stdout ?? '')
  }
}
function ourPids() {
  const j = ps(
    `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.ExecutablePath -eq '${exe}' } | Select-Object -ExpandProperty ProcessId | ConvertTo-Json`
  ).trim()
  if (!j) {
    return []
  }
  const v = JSON.parse(j)
  return Array.isArray(v) ? v : [v]
}
const seen = new Map()
const started = Date.now()
let samples = 0
while (Date.now() - started < seconds * 1000) {
  const pids = ourPids()
  if (pids.length) {
    const rows = ps(
      `Get-NetTCPConnection -OwningProcess ${pids.join(',')} -ErrorAction SilentlyContinue | Where-Object { $_.RemoteAddress -notin '127.0.0.1','::1','0.0.0.0','::' } | Select-Object RemoteAddress,RemotePort,State,OwningProcess | ConvertTo-Json -Compress`
    ).trim()
    if (rows) {
      const arr = JSON.parse(rows)
      for (const r of Array.isArray(arr) ? arr : [arr]) {
        const key = `${r.RemoteAddress}:${r.RemotePort} pid=${r.OwningProcess}`
        seen.set(key, (seen.get(key) ?? 0) + 1)
      }
    }
  }
  samples++
  await new Promise((r) => setTimeout(r, 2000))
}
const dns = ps('Get-DnsClientCache | Select-Object -ExpandProperty Entry | Sort-Object -Unique')
  .split(/\r?\n/)
  .filter(Boolean)
const result = { seconds, samples, remotes: Object.fromEntries(seen), dnsCacheEntries: dns }
writeFileSync(out, JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
