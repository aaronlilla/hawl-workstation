const list = await (await fetch('http://127.0.0.1:9777/json')).json()
const page = list.find(p => p.type === 'page'); console.log('page:', page?.title, page?.url?.slice(0,60))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise(r => ws.onopen = r)
ws.send(JSON.stringify({id:1, method:'Page.captureScreenshot', params:{format:'png'}}))
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id===1) { import('node:fs').then(fs=>{fs.writeFileSync('hidden-shot.png', Buffer.from(m.result.data,'base64')); console.log('screenshot bytes', Buffer.from(m.result.data,'base64').length); process.exit(0)}) } }
