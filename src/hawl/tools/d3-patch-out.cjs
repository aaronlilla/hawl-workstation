// Proof harness only: exposes sonner's toast on window in the BUILT renderer (out/), never in source.
const fs = require('fs'), path = require('path')
const dir = path.resolve(__dirname, '../../../out/renderer/assets')
for (const f of fs.readdirSync(dir).filter((f) => /^client-.*\.js$/.test(f))) {
  const p = path.join(dir, f)
  let s = fs.readFileSync(p, 'utf8')
  const m = s.match(/(\w+)=Object\.assign\(\w+,\{success:\w+\.success,info:\w+\.info[^}]*\},\{getHistory:\(\)=>\w+\.toasts,getToasts:\(\)=>\w+\.getActiveToasts\(\)\}\);/)
  if (m && !s.includes('__d3toast')) {
    s = s.replace(m[0], m[0] + `window.__d3toast=${m[1]};`)
    fs.writeFileSync(p, s)
    console.log('patched', f)
  }
}
