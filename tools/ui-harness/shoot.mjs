// node .harness/shoot.mjs <outDir> [specimen...]  — light + dark at 390x844 (iPhone 13).
import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const [outDir = 'tools/ui-harness/shots', ...only] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })

// name -> { path?, before?: async (page) => void, full?: bool }
const PLAN = {
  // Settings → Job types: the list, then what was typed into jobs.
  jobtypes: { full: true, before: async (p) => p.waitForTimeout(500) },
  // A service opened and renamed: the sheet says what the rename touches.
  'jobtypes-edit': {
    spec: 'jobtypes',
    before: async (p) => {
      await p.waitForTimeout(500)
      await p
        .getByRole('button', { name: /^General Pest Control Pest/ })
        .click()
      await p.waitForTimeout(600)
      await p.getByLabel('Name').fill('General Pest Treatment')
      await p.waitForTimeout(200)
    },
  },
  'jobtypes-new': {
    spec: 'jobtypes',
    before: async (p) => {
      await p.waitForTimeout(500)
      await p.getByRole('button', { name: 'Add a job type' }).click()
      await p.waitForTimeout(600)
      await p.getByLabel('Name').fill('Termite Barrier Top-Up')
      await p.waitForTimeout(200)
    },
  },
  'jobtypes-delete': {
    spec: 'jobtypes',
    before: async (p) => {
      await p.waitForTimeout(500)
      await p.getByRole('button', { name: /^Cockroaches/ }).click()
      await p.waitForTimeout(600)
      await p.getByRole('button', { name: 'Delete job type' }).click()
      await p.waitForTimeout(500)
    },
  },
  'jobtypes-merge': {
    spec: 'jobtypes',
    before: async (p) => {
      await p.waitForTimeout(500)
      await p.getByRole('button', { name: /^Spiders/ }).click()
      await p.waitForTimeout(600)
      await p.getByLabel('Name').fill('ants')
      await p.getByRole('button', { name: 'Save' }).click()
      await p.waitForTimeout(500)
    },
  },
  'jobtypes-typed': {
    spec: 'jobtypes',
    before: async (p) => {
      await p.waitForTimeout(500)
      await p.getByRole('button', { name: /^Gpc & Tpi/ }).click()
      await p.waitForTimeout(600)
      await p.getByRole('checkbox', { name: 'General Pest Control' }).click()
      await p.getByRole('checkbox', { name: 'Termite Inspection' }).click()
      await p.waitForTimeout(200)
    },
  },
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
  // Three services and a note: the title, the Notes section, and a report
  // shortcut for each form the job produces.
  'jobdetail-services': { before: async (p) => p.waitForTimeout(900) },
  'jobdetail-services-reports': {
    spec: 'jobdetail-services',
    before: async (p) => {
      await p.waitForTimeout(900)
      await p
        .getByRole('heading', { name: 'Report & photos' })
        .scrollIntoViewIfNeeded()
      await p.waitForTimeout(300)
    },
  },
  // The one Notes card: the site's notes, then this visit's.
  'jobdetail-notes': {
    spec: 'jobdetailbusy',
    before: async (p) => {
      await p.waitForTimeout(1200)
      await p
        .getByRole('heading', { name: 'Notes', exact: true })
        .scrollIntoViewIfNeeded()
      await p.waitForTimeout(300)
    },
  },
  // Details in rows, then the property's history: past visits only, each
  // with its report, the last one for this service first.
  'jobdetail-history': {
    spec: 'jobdetailbusy',
    before: async (p) => {
      await p.waitForTimeout(1200)
      await p
        .getByRole('heading', { name: 'Details', exact: true })
        .scrollIntoViewIfNeeded()
      await p.waitForTimeout(300)
    },
  },
  // Every earlier visit, by year, from "See all".
  'jobdetail-history-all': {
    spec: 'jobdetailbusy',
    before: async (p) => {
      await p.waitForTimeout(1200)
      await p.getByRole('button', { name: /^See all/ }).click()
      await p.waitForTimeout(700)
    },
  },
  // The edit form, and its pickers — each a sheet of its own over it.
  'jobdetail-edit': {
    spec: 'jobdetail',
    before: async (p) => {
      await p.waitForTimeout(900)
      await p.getByRole('button', { name: 'Edit job details' }).click()
      await p.waitForTimeout(500)
    },
  },
  'jobtype-picker': {
    spec: 'jobdetail',
    before: async (p) => {
      await p.waitForTimeout(900)
      await p.getByRole('button', { name: 'Edit job details' }).click()
      await p.getByRole('button', { name: 'Job type' }).click()
      await p.getByRole('checkbox', { name: 'Rodents' }).click()
      await p.waitForTimeout(700)
    },
  },
  'property-picker': {
    spec: 'jobdetail',
    before: async (p) => {
      await p.waitForTimeout(900)
      await p.getByRole('button', { name: 'Edit job details' }).click()
      await p.getByRole('button', { name: 'Property' }).click()
      await p.waitForTimeout(700)
    },
  },
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
  // The Recurring Job page by service, the weekly service opened.
  recurringservices: {
    before: async (p) => {
      await p.waitForTimeout(600)
      await p.getByRole('button', { name: /General Pest Control/ }).click()
      await p.waitForTimeout(300)
    },
  },
  // The busy client: a summary under the name, then Jobs, Notes, Details.
  clientbusy: { before: async (p) => p.waitForTimeout(1200) },
  'clientbusy-jobs': {
    spec: 'clientbusy',
    before: async (p) => {
      await p.waitForTimeout(1200)
      await p.getByRole('button', { name: /^General Pest Control/ }).click()
      await p.waitForTimeout(300)
      await p
        .getByRole('heading', { name: /^Recurring services/ })
        .scrollIntoViewIfNeeded()
      await p.waitForTimeout(300)
    },
  },
  'clientbusy-notes': {
    spec: 'clientbusy',
    before: async (p) => {
      await p.waitForTimeout(1200)
      await p.getByRole('tab', { name: 'Notes' }).click()
      await p.waitForTimeout(400)
      await p
        .getByRole('heading', { name: 'Before you arrive' })
        .scrollIntoViewIfNeeded()
      await p.waitForTimeout(300)
    },
  },
  'clientbusy-details': {
    spec: 'clientbusy',
    before: async (p) => {
      await p.waitForTimeout(1200)
      await p.getByRole('tab', { name: 'Details' }).click()
      await p.waitForTimeout(400)
      await p
        .getByRole('heading', { name: 'Details', exact: true })
        .scrollIntoViewIfNeeded()
      await p.waitForTimeout(300)
    },
  },
  'client-property-edit': {
    spec: 'client',
    before: async (p) => {
      await p.waitForTimeout(900)
      await p.getByRole('tab', { name: 'Details' }).click()
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
      await p.getByRole('tab', { name: 'Details' }).click()
      await p.getByRole('button', { name: 'Remove Tom Hale' }).click()
      await p.waitForTimeout(500)
    },
  },
  'client-delete-confirm': {
    spec: 'client',
    before: async (p) => {
      await p.waitForTimeout(900)
      await p.getByRole('tab', { name: 'Details' }).click()
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
  licenceadd: { full: true },
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
  // More photos than an email carries: said before the lock sends it.
  'lock-big': { before: async (p) => p.waitForTimeout(700) },
  'send-big': { before: async (p) => p.waitForTimeout(700) },
  'history-big': { full: true },
  delivered: {},
  'report-settings': { full: true },
  // Whole page: the Letterhead card sits below the Business one.
  letterhead: { full: true },
  'letterhead-nodark': { full: true },
  'letterhead-nologo': { full: true },
  'report-preview': {},
  history: {},
  logs: {},
  legacy: { full: true },
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
  install: { full: true },
  'install-settings': { full: true },
  'install-card': {},
  'install-sheet': { before: async (p) => p.waitForTimeout(600) },
  'install-link': {},
  reports: { before: async (p) => p.waitForTimeout(600) },
  // A signed report's bin: the owner's, with what goes and what stays sent.
  'reports-delete-confirm': {
    spec: 'reports',
    before: async (p) => {
      await p.waitForTimeout(600)
      await p.getByRole('button', { name: /^Delete report #4/ }).click()
      await p.waitForTimeout(500)
    },
  },
  'reports-deleted': { before: async (p) => p.waitForTimeout(600) },
  'reports-deleted-purge': {
    spec: 'reports-deleted',
    before: async (p) => {
      await p.waitForTimeout(600)
      await p.getByRole('button', { name: 'Delete now' }).first().click()
      await p.waitForTimeout(500)
    },
  },
  // A technician: their deleted draft is theirs, a signed report the owner's.
  'reports-deleted-tech': { before: async (p) => p.waitForTimeout(600) },
  'report-foot': {},
  'report-foot-confirm': {
    spec: 'report-foot',
    before: async (p) => {
      await p.getByRole('button', { name: 'Delete report' }).click()
      await p.waitForTimeout(500)
    },
  },
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
