// Scenes for d3-drive.cjs. Each scene opens one surface in the real app and screenshots it.
module.exports = {
  async palette({ page, shot, sleep }) {
    await page.mouse.click(140, 60)
    await sleep(900)
    await shot('palette-empty')
    await page.keyboard.type('set')
    await sleep(900)
    await shot('palette-results')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await sleep(300)
    await shot('palette-cursor')
    await page.keyboard.press('Escape')
    await sleep(400)
  },
  async menu1({ page, shot, sleep }) {
    await page.mouse.click(204, 238)
    await sleep(800)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await sleep(300)
    await shot('menu-workspace-options')
  },
  async menu2({ page, shot, sleep }) {
    await page.mouse.click(48, 858)
    await sleep(800)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await sleep(300)
    await shot('menu-help')
  },
  async pop({ page, shot, sleep }) {
    await page.mouse.click(30, 888)
    await sleep(900)
    await shot('popover-usage')
  },
  async dialog({ page, shot, sleep }) {
    await page.getByText('Add project').first().click()
    await sleep(900)
    await shot('dialog-add')
    await page.keyboard.press('Escape')
    await sleep(400)
    await page.getByText('Create workspace').first().click()
    await sleep(900)
    await shot('dialog-create')
    await page.keyboard.press('Escape')
    await sleep(400)
  },
  async sheet({ page, shot, sleep }) {
    await page.mouse.click(260, 858)
    await sleep(1200)
    await shot('sheet-board')
    await page.keyboard.press('Escape')
    await sleep(500)
  },
  async tip({ page, shot, sleep }) {
    await page.mouse.move(75, 18)
    await sleep(1600)
    await shot('tooltip')
    await page.mouse.move(700, 700)
  },
  async toast({ page, shot, sleep }) {
    const ok = await page.evaluate(() => {
      const t = window.__d3toast
      if (!t) return false
      t.success('Passed inspection', { description: 'The Checker found no problems in the Q3 report.', duration: 60000 })
      t.info('Planner joined your site', { description: 'Ask it to do its first work order.', duration: 60000 })
      t.error('Could not send the work order', {
        description: 'The Planner did not answer in 30 seconds.',
        duration: 60000,
        action: { label: 'Retry', onClick: () => {} }
      })
      return true
    })
    console.log('toast hook', ok)
    await sleep(1400)
    await page.mouse.move(1200, 800)
    await sleep(900)
    await shot('toasts')
    await page.evaluate(() => window.__d3toast && window.__d3toast.dismiss())
  },
  async settings({ page, shot, sleep }) {
    await page.mouse.click(20, 858)
    await sleep(1500)
    await shot('settings')
  }
}
