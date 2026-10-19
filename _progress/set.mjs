// usage: node set.mjs <id> <state> "<note>" [round] [verdict]   state: todo|building|critic|looping|passed|blocked
import fs from 'node:fs'
const p = new URL('./status.json', import.meta.url)
const s = JSON.parse(fs.readFileSync(p, 'utf8'))
const [id, state, note, round, verdict] = process.argv.slice(2)
let x = s.pieces.find((a) => a.id === id)
if (!x) {
  x = { id, title: id }
  s.pieces.push(x)
}
Object.assign(x, {
  state,
  note: note || x.note,
  round: round ?? x.round,
  verdict: verdict ?? x.verdict,
  at: new Date().toLocaleTimeString('en-US')
})
s.updated = new Date().toLocaleString('en-US')
fs.writeFileSync(p, JSON.stringify(s, null, 1))
