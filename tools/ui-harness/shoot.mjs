// node .harness/shoot.mjs <outDir> [specimen...]  — light + dark at 390x844 (iPhone 13).
import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const [outDir = 'tools/ui-harness/shots', ...only] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })

// name -> { path?, before?: async (page) => void, full?: bool }
const PLAN = {
  dock: { path: '/demo/job' },
  'dock-more': {
    spec: 'dock',
    path: '/demo/job',
    before: async (p) => {
      await p.getByRole('button', { name: /^More/ }).click()
      await p.waitForTimeout(700)
    },
  },
  jobcards: { full: true },
  jobdetail: { before: async (p) => p.waitForTimeout(900) },
  'jobdetail-loading': {
    spec: 'jobdetail-loading',
    before: async (p) => p.waitForTimeout(700),
  },
  client: { before: async (p) => p.waitForTimeout(900) },
  'client-scrolled': {
    spec: 'client',
    before: async (p) => {
      await p.waitForTimeout(900)
      await p.evaluate(() => {
        const el = [
          ...document.querySelectorAll('[data-vaul-drawer] div'),
        ].find(
          (d) =>
            d.scrollHeight > d.clientHeight + 20 &&
            getComputedStyle(d).overflowY === 'auto',
        )
        if (el) el.scrollTop = el.scrollHeight
      })
      await p.waitForTimeout(300)
    },
  },
  'client-property-edit': {
    spec: 'client',
    before: async (p) => {
      await p.waitForTimeout(900)
      await p.getByRole('button', { name: 'Edit 9 Rokeby Rd' }).click()
      await p.waitForTimeout(400)
      await p
        .getByRole('button', { name: 'Delete this property' })
        .scrollIntoViewIfNeeded()
      await p.waitForTimeout(300)
    },
  },
  'client-contact-remove': {
    spec: 'client',
    before: async (p) => {
      await p.waitForTimeout(900)
      await p.getByRole('button', { name: 'Remove Tom Hale' }).click()
      await p.waitForTimeout(500)
    },
  },
  'client-delete-confirm': {
    spec: 'client',
    before: async (p) => {
      await p.waitForTimeout(900)
      await p.getByRole('button', { name: 'Delete client' }).click()
      await p.waitForTimeout(500)
    },
  },
  bin: { full: true, before: async (p) => p.waitForTimeout(600) },
  'bin-delete-confirm': {
    spec: 'bin',
    before: async (p) => {
      await p.waitForTimeout(600)
      await p.getByRole('button', { name: 'Delete now' }).first().click()
      await p.waitForTimeout(500)
    },
  },
  'bin-empty-confirm': {
    spec: 'bin',
    before: async (p) => {
      await p.waitForTimeout(600)
      await p.getByRole('button', { name: 'Empty Recycle bin' }).click()
      await p.waitForTimeout(500)
    },
  },
  schedule: { full: false },
  'jobdetail-scrolled': {
    spec: 'jobdetail',
    before: async (p) => {
      await p.waitForTimeout(900)
      await p.evaluate(() => {
        const el = [
          ...document.querySelectorAll('[data-vaul-drawer] div'),
        ].find(
          (d) =>
            d.scrollHeight > d.clientHeight + 20 &&
            getComputedStyle(d).overflowY === 'auto',
        )
        if (el) el.scrollTop = el.scrollHeight
      })
      await p.waitForTimeout(300)
    },
  },
  sign: {
    before: async (p) => {
      await p.waitForTimeout(600)
      const c = p.locator('canvas').first()
      const b = await c.boundingBox()
      if (!b) return
      await p.mouse.move(b.x + 40, b.y + b.height * 0.6)
      await p.mouse.down()
      for (let i = 0; i <= 30; i++) {
        const t = i / 30
        await p.mouse.move(
          b.x + 40 + t * (b.width - 80),
          b.y + b.height * (0.6 - 0.25 * Math.sin(t * Math.PI * 3)),
        )
      }
      await p.mouse.up()
      await p.waitForTimeout(200)
    },
  },
  sheet: { before: async (p) => p.waitForTimeout(600) },
  warnings: {},
  filters: {},
  'filters-focus': {
    spec: 'filters',
    before: async (p) => {
      await p.keyboard.press('Tab')
      await p.keyboard.press('Tab')
    },
  },
  settings: { full: true },
  error: {},
  guide: { before: async (p) => p.waitForTimeout(500) },
  confirm: { before: async (p) => p.waitForTimeout(500) },
  inputs: { before: async (p) => p.waitForTimeout(600) },
  empty: {},
  nomatch: {},
  lock: { before: async (p) => p.waitForTimeout(700) },
  'lock-off': {
    spec: 'lock',
    before: async (p) => {
      await p.waitForTimeout(700)
      await p.getByRole('button', { name: /Email the client/ }).click()
      await p.waitForTimeout(300)
    },
  },
  'lock-new': { before: async (p) => p.waitForTimeout(700) },
  'lock-noemail': { before: async (p) => p.waitForTimeout(700) },
  delivered: {},
  'report-settings': { full: true },
  history: {},
  logs: {},
  send: { before: async (p) => p.waitForTimeout(700) },
  // Someone the client's record does not have: marked new, and sent like
  // anyone else.
  'send-new': {
    spec: 'send',
    before: async (p) => {
      await p.waitForTimeout(700)
      await p.getByRole('button', { name: 'Send to someone else' }).click()
      await p.getByLabel('Email address').fill('strata@harbourside.com.au')
      await p.getByRole('button', { name: 'Add', exact: true }).click()
      await p.waitForTimeout(300)
    },
  },
  'form-settings': { before: async (p) => p.waitForTimeout(700) },
  'send-off': {
    spec: 'send',
    before: async (p) => {
      await p.waitForTimeout(700)
      await p.getByRole('button', { name: /jane@gmail\.com/ }).click()
      await p.waitForTimeout(300)
    },
  },
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
})
const names = only.length ? only : Object.keys(PLAN)
for (const theme of ['light', 'dark']) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    colorScheme: theme,
    hasTouch: false,
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  for (const name of names) {
    const plan = PLAN[name]
    if (!plan) continue
    errors.length = 0
    const spec = plan.spec ?? name
    const url = `http://localhost:${process.env.PORT || 5200}/?s=${spec}&theme=${theme}${process.env.DEBUG ? '&debug=1' : ''}${plan.path ? `&path=${encodeURIComponent(plan.path)}` : ''}`
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.waitForTimeout(400)
    if (plan.before) await plan.before(page)
    const file = path.join(outDir, `${name}-${theme}.png`)
    await page.screenshot({ path: file, fullPage: !!plan.full })
    const errs = errors.filter(
      (e) =>
        !/harness\.invalid|Failed to load resource|get-session|ERR_/.test(e),
    )
    console.log(
      file,
      errs.length ? `ERRORS: ${errs.slice(0, 3).join(' | ')}` : '',
    )
  }
  await ctx.close()
}
await browser.close()
