import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''))
http
  .createServer((q, r) => {
    const f = q.url.startsWith('/status.json')
      ? 'status.json'
      : q.url.startsWith('/shots/')
        ? q.url.slice(1).split('?')[0]
        : 'index.html'
    try {
      const b = fs.readFileSync(path.join(root, f))
      r.writeHead(200, {
        'content-type': f.endsWith('.json')
          ? 'application/json'
          : f.endsWith('.png')
            ? 'image/png'
            : 'text/html',
        'cache-control': 'no-store'
      })
      r.end(b)
    } catch {
      r.writeHead(404)
      r.end()
    }
  })
  .listen(4790, '127.0.0.1')
