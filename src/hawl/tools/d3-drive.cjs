// D3 surfaces driver: launches the built app with its own user-data-dir, connects over CDP,
// optionally injects the live theme CSS, runs a named scene and saves screenshots.
// usage: node d3-drive.cjs <outDir> [scene...]   env: D3_PORT, D3_THEME=light|dark, D3_W, D3_H
const { spawn, execSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const root = path.resolve(__dirname, '../../..')
const { chromium } = require('C:/Users/Administrator/AppData/Local/pnpm/store/v11/links/@/playwright-core/1.64.0/635d7c03ef0319ed7e222eae35e0441c529ef9374783508b672144a683227672/node_modules/playwright-core')

const outDir = process.argv[2] || path.join(root, '_d3shots')
const scenes = process.argv.slice(3)
const port = Number(process.env.D3_PORT || 9344)
const W = Number(process.env.D3_W || 1440)
const H = Number(process.env.D3_H || 900)
const theme = process.env.D3_THEME || 'light'
const ud = path.join(process.env.TEMP || 'C:/Windows/Temp', 'd3-userdata-' + theme)
fs.mkdirSync(outDir, { recursive: true })
try {
  fs.rmSync(ud, { recursive: true, force: true })
} catch {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const exe = path.join(root, 'node_modules/electron/dist/electron.exe')
  const child = spawn(exe, ['.', `--user-data-dir=${ud}`, `--remote-debugging-port=${port}`], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, ORCA_E2E: '', ORCA_DEV_USER_DATA_PATH: ud, ELECTRON_ENABLE_LOGGING: '0' }
  })
  let browser
  for (let i = 0; i < 60; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
      break
    } catch {
      await sleep(1000)
    }
  }
  if (!browser) throw new Error('no cdp')
  try {
    const ctx = browser.contexts()[0]
    let page = ctx.pages().find((p) => /index\.html/.test(p.url())) || ctx.pages()[0]
    for (let i = 0; i < 30 && !page; i++) {
      await sleep(500)
      page = ctx.pages()[0]
    }
    await page.setViewportSize({ width: W, height: H })
    await page.waitForLoadState('domcontentloaded')
    await sleep(6000)
    if (process.env.D3_CSS) {
      const css = fs.readFileSync(process.env.D3_CSS, 'utf8')
      await page.addStyleTag({ content: css })
    }
    await page.evaluate((t) => {
      document.documentElement.classList.toggle('dark', t === 'dark')
    }, theme)
    await sleep(500)
    const shot = async (name) => {
      await page.screenshot({ path: path.join(outDir, `${name}-${theme}.png`) })
      console.log('shot', name)
    }
    const sceneFile = process.env.D3_SCENES
    const fns = sceneFile ? require(path.resolve(sceneFile)) : {}
    await shot('00-first')
    for (const s of scenes) {
      if (fns[s]) await fns[s]({ page, shot, sleep })
    }
  } finally {
    try {
      await browser.close()
    } catch {}
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
    } catch {}
  }
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
