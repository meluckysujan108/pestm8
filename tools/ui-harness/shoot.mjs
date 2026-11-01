// node .harness/shoot.mjs <outDir> [specimen...]  — light + dark at 390x844 (iPhone 13).
import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const [outDir = 'tools/ui-harness/shots', ...only] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })

// name -> { path?, before?: async (page) => void, full?: bool }
/**
 * A signature across the pad, as the person signing sees it. A pad turned for
 * a phone held upright reads with the phone on its side, so "across" is down
 * the screen there.
 */
async function signAcross(p) {
  await p.waitForTimeout(600)
  const canvas = p.locator('canvas').first()
  const b = await canvas.boundingBox()
  if (!b) return
  const turned = await canvas.evaluate(
    (c) => Math.abs(c.clientWidth - c.getBoundingClientRect().width) > 1,
  )
  // (u, v): across and down the pad as signed, 0 to 1.
  const at = (u, v) =>
    turned
      ? { x: b.x + b.width * (1 - v), y: b.y + b.height * u }
      : { x: b.x + b.width * u, y: b.y + b.height * v }
  const strokes = [
    (t) => [0.12 + t * 0.3, 0.62 - 0.32 * Math.sin(t * Math.PI)],
    (t) => [
      0.36 + t * 0.5,
      0.6 - 0.18 * Math.sin(t * Math.PI * 3) * (1 - t * 0.4),
    ],
  ]
  for (const stroke of strokes) {
    const [u0, v0] = stroke(0)
    let point = at(u0, v0)
    await p.mouse.move(point.x, point.y)
    await p.mouse.down()
    // At a person's pace, about a pixel a millisecond: the pen's width
    // follows its speed, and a robot's speed draws a hairline.
    for (let i = 1; i <= 50; i++) {
      const [u, v] = stroke(i / 50)
      point = at(u, v)
      await p.mouse.move(point.x, point.y)
      await p.waitForTimeout(16)
    }
    await p.mouse.up()
  }
  await p.waitForTimeout(200)
}

/** New Job's Property picker opened, and `query` typed into its search. */
async function searchProperty(p, query, settle = 900) {
  await p.waitForTimeout(settle)
  await p.getByRole('button', { name: 'Property' }).click()
  await p
    .getByRole('textbox', { name: 'Search by name, address, phone or email' })
    .fill(query)
  await p.waitForTimeout(500)
}

const PLAN = {
  // Settings → Xero and My Xero (Release 1: connect), one state each.
  xero: { full: true, before: async (p) => p.waitForTimeout(500) },
  'xero-connected': { before: async (p) => p.waitForTimeout(500) },
  'xero-reconnect': { full: true, before: async (p) => p.waitForTimeout(500) },
  'xero-leftover': { full: true, before: async (p) => p.waitForTimeout(500) },
  'xero-unconfigured': { before: async (p) => p.waitForTimeout(500) },
  'xero-demo': { before: async (p) => p.waitForTimeout(500) },
  'xero-two-step': { before: async (p) => p.waitForTimeout(500) },
  'xero-two-step-suggested': { before: async (p) => p.waitForTimeout(500) },
  'my-xero-two-step-suggested': {
    before: async (p) => p.waitForTimeout(500),
  },
  'xero-loading': { before: async (p) => p.waitForTimeout(500) },
  'xero-finishing': { before: async (p) => p.waitForTimeout(700) },
  'xero-returned': { full: true, before: async (p) => p.waitForTimeout(500) },
  'xero-owners-only': { before: async (p) => p.waitForTimeout(500) },
  // The harness's actions answer nothing, so Connect fails: its alert.
  'xero-connect-failed': {
    spec: 'xero',
    full: true,
    before: async (p) => {
      await p.waitForTimeout(500)
      await p.getByRole('button', { name: 'Connect Xero' }).click()
      await p.waitForTimeout(400)
    },
  },
  'xero-disconnect': {
    spec: 'xero-connected',
    before: async (p) => {
      await p.waitForTimeout(500)
      await p.getByRole('button', { name: 'Disconnect Xero' }).click()
      await p.waitForTimeout(500)
    },
  },
  'my-xero': { full: true, before: async (p) => p.waitForTimeout(500) },
  'my-xero-connected': { before: async (p) => p.waitForTimeout(500) },
  'my-xero-reconnect': {
    full: true,
    before: async (p) => p.waitForTimeout(500),
  },
  'my-xero-returned': {
    full: true,
    before: async (p) => p.waitForTimeout(500),
  },
  'my-xero-owner': { before: async (p) => p.waitForTimeout(500) },
  'my-xero-switched': { before: async (p) => p.waitForTimeout(500) },
  // Team → a member: their Xero line, and the remove confirm that says it
  // goes with them.
  'team-member': { full: true, before: async (p) => p.waitForTimeout(700) },
  'team-member-remove': {
    spec: 'team-member',
    full: true,
    before: async (p) => {
      await p.waitForTimeout(700)
      await p.getByRole('button', { name: 'Remove from team' }).click()
      await p.waitForTimeout(500)
    },
  },
  'team-member-xero': { before: async (p) => p.waitForTimeout(500) },
  // Release 3: syncing. The Xero page as it sends — under way, all in, the
  // kill switch, Xero's daily limit — and a problem opened.
  'xero-syncing': { full: true, before: async (p) => p.waitForTimeout(500) },
  'xero-synced': { full: true, before: async (p) => p.waitForTimeout(500) },
  'xero-sync-paused': {
    full: true,
    before: async (p) => p.waitForTimeout(500),
  },
  'xero-sync-day-limit': {
    full: true,
    before: async (p) => p.waitForTimeout(500),
  },
  'my-xero-syncing': { full: true, before: async (p) => p.waitForTimeout(500) },
  'my-xero-sync-day-limit': {
    full: true,
    before: async (p) => p.waitForTimeout(500),
  },
  'my-xero-sync-server': {
    full: true,
    before: async (p) => p.waitForTimeout(500),
  },
  // A refused client, tapped: its sheet over the page, on Details.
  'xero-sync-problem-open': {
    spec: 'xero-syncing',
    before: async (p) => {
      await p.waitForTimeout(500)
      await p
        .getByRole('button', { name: /Could not add Subi Café Group/ })
        .click()
      await p.waitForTimeout(1200)
      await p.getByRole('tab', { name: 'Details' }).click()
      await p.waitForTimeout(500)
    },
  },
  // The match page's Start syncing: its confirm, a week-old match that
  // must be read again first, and the page once syncing.
  'xero-match-start-confirm': {
    spec: 'xero-match',
    before: async (p) => {
      await p.waitForTimeout(700)
      await p.getByRole('button', { name: 'Start syncing' }).click()
      await p.waitForTimeout(500)
    },
  },
  'xero-match-stale': { before: async (p) => p.waitForTimeout(700) },
  'xero-match-syncing': { before: async (p) => p.waitForTimeout(700) },
  'my-xero-match-syncing': { before: async (p) => p.waitForTimeout(700) },
  // A client's Xero row in every state, Send PestM8's details asked, and
  // the sample client's sheet on Details.
  'client-xero-lines': {
    full: true,
    before: async (p) => p.waitForTimeout(500),
  },
  'client-xero-overwrite': {
    spec: 'client-xero-lines',
    before: async (p) => {
      await p.waitForTimeout(500)
      await p
        .getByRole('button', { name: 'Send PestM8’s details' })
        .first()
        .click()
      await p.waitForTimeout(500)
    },
  },
  'client-xero-details': {
    spec: 'client',
    full: true,
    before: async (p) => {
      await p.waitForTimeout(700)
      await p.getByRole('tab', { name: 'Details' }).click()
      await p.waitForTimeout(500)
    },
  },
  'xero-hub-badges': { before: async (p) => p.waitForTimeout(500) },
  'import-undo-xero': { before: async (p) => p.waitForTimeout(700) },
  // Release 2: matching. The Xero page's group in each state, then the match
  // page's lists, an answered card and the Unlink confirm.
  'xero-match-reading': { before: async (p) => p.waitForTimeout(500) },
  'xero-match-ready': {
    full: true,
    before: async (p) => p.waitForTimeout(500),
  },
  'xero-match-failed': {
    full: true,
    before: async (p) => p.waitForTimeout(500),
  },
  'my-xero-match-reading': { before: async (p) => p.waitForTimeout(500) },
  'my-xero-match-ready': {
    full: true,
    before: async (p) => p.waitForTimeout(500),
  },
  'my-xero-match-failed': {
    full: true,
    before: async (p) => p.waitForTimeout(500),
  },
  'xero-match': { full: true, before: async (p) => p.waitForTimeout(700) },
  'xero-match-matched': { before: async (p) => p.waitForTimeout(700) },
  'xero-match-new': { before: async (p) => p.waitForTimeout(700) },
  'xero-match-different': { before: async (p) => p.waitForTimeout(700) },
  'xero-match-clean': { before: async (p) => p.waitForTimeout(700) },
  'xero-match-page-reading': { before: async (p) => p.waitForTimeout(500) },
  'xero-match-page-failed': { before: async (p) => p.waitForTimeout(500) },
  'xero-match-loading': { before: async (p) => p.waitForTimeout(500) },
  'xero-match-not-connected': { before: async (p) => p.waitForTimeout(500) },
  'xero-match-owners-only': { before: async (p) => p.waitForTimeout(500) },
  'my-xero-match': { before: async (p) => p.waitForTimeout(700) },
  // The harness's mutations answer nothing, so a choice saves: the card
  // stays where it was, answered.
  'xero-match-answered': {
    spec: 'xero-match',
    before: async (p) => {
      await p.waitForTimeout(700)
      await p.getByRole('radio', { name: 'Same client' }).first().click()
      await p.waitForTimeout(400)
    },
  },
  'xero-match-unlink': {
    spec: 'xero-match-matched',
    before: async (p) => {
      await p.waitForTimeout(700)
      await p.getByRole('button', { name: 'Unlink Harbour Café' }).click()
      await p.waitForTimeout(500)
    },
  },
  'xero-match-stopped': {
    full: true,
    before: async (p) => p.waitForTimeout(500),
  },
  'my-xero-match-not-read': {
    full: true,
    before: async (p) => p.waitForTimeout(500),
  },
  'xero-match-paused': {
    full: true,
    before: async (p) => p.waitForTimeout(500),
  },
  'my-xero-match-rate-limited': {
    full: true,
    before: async (p) => p.waitForTimeout(500),
  },
  'xero-match-page-reconnect': { before: async (p) => p.waitForTimeout(500) },
  'my-xero-match-page-reconnect': {
    before: async (p) => p.waitForTimeout(700),
  },
  'xero-match-paged': {
    full: true,
    before: async (p) => p.waitForTimeout(700),
  },
  // "Show 100 more", pressed: the second page under the first.
  'xero-match-paged-more': {
    spec: 'xero-match-paged',
    full: true,
    before: async (p) => {
      await p.waitForTimeout(700)
      await p.getByRole('button', { name: /Show .* more/ }).click()
      await p.waitForTimeout(500)
    },
  },
  'xero-match-load-failed': { before: async (p) => p.waitForTimeout(700) },
  // The same customer (2026-10-16): a card whose contact another client
  // has, its Same customer sheet, each of its confirms and what each saves,
  // its refusals, Edit, the Shared contact list and its Unlink, and a
  // subcontractor's sheet with no Merge.
  'xero-match-same-customer': {
    spec: 'xero-match',
    before: async (p) => {
      await p.waitForTimeout(700)
      await p.getByRole('button', { name: 'Same customer…' }).first().click()
      await p.waitForTimeout(700)
    },
  },
  'xero-match-merge-confirm': {
    spec: 'xero-match',
    before: async (p) => {
      await p.waitForTimeout(700)
      await p.getByRole('button', { name: 'Same customer…' }).first().click()
      await p.waitForTimeout(700)
      await p.getByRole('button', { name: /^Merge Coastal/ }).click()
      await p.waitForTimeout(500)
    },
  },
  'xero-match-give-confirm': {
    spec: 'xero-match',
    before: async (p) => {
      await p.waitForTimeout(700)
      await p.getByRole('button', { name: 'Same customer…' }).first().click()
      await p.waitForTimeout(700)
      await p.getByRole('button', { name: /is the wrong match/ }).click()
      await p.waitForTimeout(500)
    },
  },
  'xero-match-merged': {
    spec: 'xero-match',
    full: true,
    before: async (p) => {
      await p.waitForTimeout(700)
      await p.getByRole('button', { name: 'Same customer…' }).first().click()
      await p.waitForTimeout(700)
      await p.getByRole('button', { name: /^Merge Coastal/ }).click()
      await p.waitForTimeout(500)
      await p.getByRole('button', { name: 'Merge', exact: true }).click()
      await p.waitForTimeout(900)
    },
  },
  'xero-match-kept-both': {
    spec: 'xero-match',
    full: true,
    before: async (p) => {
      await p.waitForTimeout(700)
      await p.getByRole('button', { name: 'Same customer…' }).first().click()
      await p.waitForTimeout(700)
      await p.getByRole('button', { name: /^Keep both/ }).click()
      await p.waitForTimeout(900)
    },
  },
  'xero-match-given': {
    spec: 'xero-match',
    full: true,
    before: async (p) => {
      await p.waitForTimeout(700)
      await p.getByRole('button', { name: 'Same customer…' }).first().click()
      await p.waitForTimeout(700)
      await p.getByRole('button', { name: /is the wrong match/ }).click()
      await p.waitForTimeout(500)
      await p.getByRole('button', { name: 'Give it', exact: true }).click()
      await p.waitForTimeout(900)
    },
  },
  'xero-match-held-different': {
    spec: 'xero-match',
    full: true,
    before: async (p) => {
      await p.waitForTimeout(700)
      await p
        .getByRole('button', { name: 'Different customers' })
        .first()
        .click()
      await p.waitForTimeout(500)
    },
  },
  // The long-named card, whose holder has just let its contact go: Keep
  // both refused in the sheet, a merge too big refused in its confirm.
  'xero-match-share-failed': {
    spec: 'xero-match',
    before: async (p) => {
      await p.waitForTimeout(700)
      await p.getByRole('button', { name: 'Same customer…' }).nth(1).click()
      await p.waitForTimeout(700)
      await p.getByRole('button', { name: /^Keep both/ }).click()
      await p.waitForTimeout(600)
    },
  },
  'xero-match-merge-failed': {
    spec: 'xero-match',
    before: async (p) => {
      await p.waitForTimeout(700)
      await p.getByRole('button', { name: 'Same customer…' }).nth(1).click()
      await p.waitForTimeout(700)
      await p.getByRole('button', { name: /^Merge Leederville/ }).click()
      await p.waitForTimeout(500)
      await p.getByRole('button', { name: 'Merge', exact: true }).click()
      await p.waitForTimeout(600)
    },
  },
  'xero-match-held-edit': {
    spec: 'xero-match',
    before: async (p) => {
      await p.waitForTimeout(700)
      await p
        .getByRole('button', { name: 'Open Coastal Property Group' })
        .click()
      await p.waitForTimeout(1200)
    },
  },
  'xero-match-shared': { before: async (p) => p.waitForTimeout(700) },
  'xero-match-shared-unlink': {
    spec: 'xero-match-shared',
    before: async (p) => {
      await p.waitForTimeout(700)
      await p.getByRole('button', { name: 'Unlink Harbour Café Bar' }).click()
      await p.waitForTimeout(500)
    },
  },
  'my-xero-match-no-merge': {
    before: async (p) => {
      await p.waitForTimeout(700)
      await p.getByRole('button', { name: 'Same customer…' }).first().click()
      await p.waitForTimeout(700)
    },
  },
  'xero-match-unconfigured': { before: async (p) => p.waitForTimeout(500) },
  'xero-match-demo': { before: async (p) => p.waitForTimeout(500) },
  'my-xero-match-owner': { before: async (p) => p.waitForTimeout(500) },
  'my-xero-match-switched': { before: async (p) => p.waitForTimeout(500) },
  // Same on Bayview Strata, whose contact another client has: refused.
  'xero-match-taken': {
    spec: 'xero-match',
    full: true,
    before: async (p) => {
      await p.waitForTimeout(700)
      await p
        .getByRole('radiogroup', { name: /^Is Bayview Strata/ })
        .getByRole('radio', { name: 'Same client' })
        .click()
      await p.waitForTimeout(500)
    },
  },
  // The arrow keys move between the answers without choosing one.
  'xero-match-arrows': {
    spec: 'xero-match',
    before: async (p) => {
      await p.waitForTimeout(700)
      await p
        .getByRole('radiogroup', { name: /^Is Jan Morris/ })
        .getByRole('radio', { name: 'Same client' })
        .focus()
      await p.keyboard.press('ArrowRight')
      await p.waitForTimeout(300)
    },
  },
  // Unlink confirmed on a client matched to nothing by then: refused, in
  // the dialog.
  'xero-match-unlink-failed': {
    spec: 'xero-match-matched',
    before: async (p) => {
      await p.waitForTimeout(700)
      await p
        .getByRole('button', { name: 'Unlink St John’s Primary School' })
        .click()
      await p.waitForTimeout(400)
      await p
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Unlink' })
        .click()
      await p.waitForTimeout(500)
    },
  },
  // Match again on a Different client: back under To check.
  'xero-match-again': {
    spec: 'xero-match-different',
    before: async (p) => {
      await p.waitForTimeout(700)
      await p.getByRole('button', { name: 'Match Rob Kelly again' }).click()
      await p.waitForTimeout(500)
    },
  },
  // A shared job: the edit form's "Also going", and its picker.
  'shared-edit': {
    spec: 'jobdetail-services',
    before: async (p) => {
      await p.waitForTimeout(900)
      await p.getByRole('button', { name: 'Edit job details' }).click()
      await p.waitForTimeout(500)
      await p
        .getByRole('button', { name: 'Also going' })
        .scrollIntoViewIfNeeded()
      await p.waitForTimeout(300)
    },
  },
  'shared-picker': {
    spec: 'jobdetail-services',
    before: async (p) => {
      await p.waitForTimeout(900)
      await p.getByRole('button', { name: 'Edit job details' }).click()
      await p.waitForTimeout(500)
      await p.getByRole('button', { name: 'Also going' }).click()
      await p.waitForTimeout(700)
    },
  },
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
  // A card's forecast on its way and landed: each the same height.
  'jobcard-weather': { full: true },
  jobdetail: { before: async (p) => p.waitForTimeout(900) },
  // Three services and a note: the title, the Notes section, and a report
  // shortcut for each form the job produces.
  'jobdetail-services': { before: async (p) => p.waitForTimeout(900) },
  'jobdetail-contact': { before: async (p) => p.waitForTimeout(900) },
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
  // Its date, start and end, and the length said back under them.
  'jobdetail-edit-times': {
    spec: 'jobdetail',
    before: async (p) => {
      await p.waitForTimeout(900)
      await p.getByRole('button', { name: 'Edit job details' }).click()
      await p.waitForTimeout(500)
      await p.getByLabel('End', { exact: true }).fill('13:30')
      await p.getByLabel('Date', { exact: true }).scrollIntoViewIfNeeded()
      await p.waitForTimeout(300)
    },
  },
  // New Job's start and end (25 Oct 2026: they were Start and Minutes).
  newjob: {
    before: async (p) => {
      await p.waitForTimeout(900)
      await p.getByLabel('Start', { exact: true }).scrollIntoViewIfNeeded()
      await p.waitForTimeout(300)
    },
  },
  'newjob-long': {
    spec: 'newjob',
    before: async (p) => {
      await p.waitForTimeout(900)
      await p.getByLabel('Start', { exact: true }).fill('08:00')
      await p.getByLabel('End', { exact: true }).fill('12:30')
      await p.getByLabel('Start', { exact: true }).scrollIntoViewIfNeeded()
      await p.waitForTimeout(300)
    },
  },
  'newjob-end-before-start': {
    spec: 'newjob',
    before: async (p) => {
      await p.waitForTimeout(900)
      await p.getByLabel('End', { exact: true }).fill('08:30')
      await p.getByLabel('End', { exact: true }).blur()
      await p.getByLabel('Start', { exact: true }).scrollIntoViewIfNeeded()
      await p.waitForTimeout(300)
    },
  },
  // The top of New Job: the Client choice under its caption, and New client's
  // Client type. Found by their own words (27 Oct 2026: the <label> around
  // the choice had named "Existing client" "Client Client").
  'newjob-client': {
    spec: 'newjob',
    before: async (p) => {
      await p.waitForTimeout(900)
      await p
        .getByRole('radio', { name: 'Existing client', exact: true })
        .waitFor()
    },
  },
  'newjob-new-client': {
    spec: 'newjob',
    before: async (p) => {
      await p.waitForTimeout(900)
      await p.getByRole('radio', { name: 'New client', exact: true }).click()
      await p.getByRole('radio', { name: 'Residential', exact: true }).waitFor()
      await p.waitForTimeout(300)
    },
  },
  // The client's edit form: Client type over its name.
  'client-edit': {
    spec: 'client',
    before: async (p) => {
      await p.waitForTimeout(900)
      await p.getByRole('button', { name: 'Edit client details' }).click()
      await p.getByRole('radio', { name: 'Commercial', exact: true }).waitFor()
      await p.waitForTimeout(400)
    },
  },
  // The foot of the form: the caption above Book job.
  'newjob-no-signal': {
    before: async (p) => {
      await p.waitForTimeout(900)
      await p.getByRole('button', { name: 'Book job' }).scrollIntoViewIfNeeded()
      await p.waitForTimeout(300)
    },
  },
  // Where the booking would be kept on the phone (lib/outbox/): its own
  // words above Book job, with no signal and with PestM8 not answering.
  'newjob-kept-no-signal': {
    before: async (p) => {
      await p.waitForTimeout(900)
      await p.getByRole('button', { name: 'Book job' }).scrollIntoViewIfNeeded()
      await p.waitForTimeout(300)
    },
  },
  'newjob-kept-unreachable': {
    before: async (p) => {
      await p.waitForTimeout(900)
      await p.getByRole('button', { name: 'Book job' }).scrollIntoViewIfNeeded()
      await p.waitForTimeout(300)
    },
  },
  // Nothing of New Job on the phone, with the line down.
  'newjob-not-on-phone': { before: async (p) => p.waitForTimeout(600) },
  // Search first (the matching plan's M2, 28 Oct 2026): the caller's email
  // finds her site, the list ending with New site for her.
  'newjob-picker-email-match': {
    before: (p) => searchProperty(p, 'jane.nguyen@example.com'),
  },
  // A contact person's mobile finds the agency's every site.
  'newjob-picker-contact-mobile': {
    spec: 'newjob-picker-email-match',
    before: (p) => searchProperty(p, '0491 570 110'),
  },
  // A number saved without its area code, found with it.
  'newjob-picker-landline-key': {
    spec: 'newjob-picker-email-match',
    before: (p) => searchProperty(p, '08 7010 1234'),
  },
  // Nothing matches: the way in to a new client, naming what it fills.
  'newjob-picker-no-match-add-phone': {
    spec: 'newjob-picker-no-match-add',
    before: (p) => searchProperty(p, '0491 570 158'),
  },
  'newjob-picker-no-match-add-email': {
    spec: 'newjob-picker-no-match-add',
    before: (p) => searchProperty(p, 'new.caller@example.com'),
  },
  'newjob-picker-no-match-add-address': {
    spec: 'newjob-picker-no-match-add',
    before: (p) => searchProperty(p, '9 Banksia Rd'),
  },
  'newjob-picker-no-match-add-name': {
    spec: 'newjob-picker-no-match-add',
    before: (p) => searchProperty(p, 'Kim Pham'),
  },
  'newjob-picker-no-match-add-other': {
    spec: 'newjob-picker-no-match-add',
    before: (p) => searchProperty(p, '6014'),
  },
  // A client with no site yet, found by name: a new site for him, not a
  // second Sam Wu.
  'newjob-picker-siteless-name': {
    spec: 'newjob-picker-no-match-add',
    before: (p) => searchProperty(p, 'Sam Wu'),
  },
  // …and tapped: the New client tab, the number in Phone, focus on it.
  'newjob-picker-no-match-added': {
    spec: 'newjob-picker-no-match-add',
    before: async (p) => {
      await searchProperty(p, '0491 570 158')
      await p
        .getByRole('button', { name: 'New client, phone “0491 570 158”' })
        .click()
      await p.waitForTimeout(700)
    },
  },
  'newjob-picker-no-match-offline': {
    before: (p) => searchProperty(p, '0491 570 158'),
  },
  'newjob-picker-detail-two': {
    before: async (p) => {
      await p.waitForTimeout(700)
      await p.getByRole('button', { name: 'Property' }).click()
      await p.waitForTimeout(700)
    },
  },
  'clients-search-phone': { before: async (p) => p.waitForTimeout(500) },
  // Timing only: the picker over 10,000 clients, searched by a number. The
  // console has each commit's time (`TenKTimings`).
  'newjob-picker-10k': {
    before: (p) => searchProperty(p, '0491 005 000', 1500),
  },
  'business-switch-no-signal': {
    before: async (p) => {
      await p.waitForTimeout(500)
      await p.getByRole('button', { name: /Swan River Pest Co/ }).click()
      await p.getByRole('link', { name: /Hills Pest & Termite/ }).click()
      await p.waitForTimeout(300)
    },
  },
  jobtimes: { before: async (p) => p.waitForTimeout(500) },
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
  sign: { before: async (p) => signAcross(p) },
  // A client's pad: upright, asking their name.
  'sign-client': { before: async (p) => signAcross(p) },
  // The form's own slot with a saved signature, and a drawing kept on the
  // phone because it could not be saved.
  'sign-row-saved': { before: async (p) => p.waitForTimeout(500) },
  'sign-row-waiting': { before: async (p) => p.waitForTimeout(800) },
  'my-signature': { before: async (p) => p.waitForTimeout(500) },
  // A phone already on its side: laid out as it is, not turned.
  'sign-landscape': {
    spec: 'sign',
    viewport: { width: 844, height: 390 },
    before: async (p) => signAcross(p),
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
  reach: {},
  'reach-reload': {},
  'reach-offline': {},
  'reach-confirm': {},
  'reach-sheet': {},
  'connection-notice-updated': {},
  // The copy kept on the phone (lib/offline): the note under the strip, a
  // day and a week drawn from it, a day it doesn't keep, and none at all.
  'schedule-kept-day': { full: true },
  'schedule-kept-week': {
    full: true,
    before: async (p) => p.waitForTimeout(500),
  },
  'schedule-not-kept-day': {},
  // A day's bookings on the phone, not sent yet: one waiting and one
  // sending under the cards; one sent and drawn as its job in its slot; a
  // day with nothing but them; and a desktop's agenda, drawn from the
  // outbox itself. Check the chips and the heading don't wrap.
  'schedule-outbox-day': { full: true },
  'schedule-outbox-latched': { full: true },
  'schedule-outbox-only': { full: true },
  'agenda-outbox': {
    full: true,
    viewport: { width: 760, height: 900 },
    before: async (p) => p.waitForTimeout(900),
  },
  'schedule-not-kept-page': { before: async (p) => p.waitForTimeout(300) },
  // A job opened with no signal, from its day, and one no day lists; the
  // Clients page from the copy, with the note under the search box; and a
  // client opened from it, and one the phone's client list doesn't have.
  // Each `-notice` adds the no-signal notice as a phone shows it once the
  // line has been down a while with a change waiting to save: the band over
  // the Clients page's note, and the copy at the top of each sheet. Each
  // `-notice-held` has only reads waiting, so the notice gives way to the
  // kept line and the shot matches the one without it; scrolled until the
  // note is out of sight (`-scrolled`), the band is back a moment later.
  'jobsheet-kept': { before: async (p) => p.waitForTimeout(900) },
  'jobsheet-kept-notice': { before: async (p) => p.waitForTimeout(900) },
  'jobsheet-kept-notice-held': { before: async (p) => p.waitForTimeout(900) },
  'jobsheet-not-kept': { before: async (p) => p.waitForTimeout(900) },
  'clients-kept': { full: true, before: async (p) => p.waitForTimeout(600) },
  'clients-kept-notice': { before: async (p) => p.waitForTimeout(600) },
  'clients-kept-notice-held': { before: async (p) => p.waitForTimeout(600) },
  'clients-kept-notice-held-scrolled': {
    spec: 'clients-kept-notice-held',
    before: async (p) => {
      await p.waitForTimeout(600)
      await p.evaluate(() => window.scrollTo(0, 600))
      // Past the 1.5 s a note that has gone still counts for.
      await p.waitForTimeout(2_000)
    },
  },
  'clientsheet-kept': { before: async (p) => p.waitForTimeout(900) },
  'clientsheet-kept-notice': { before: async (p) => p.waitForTimeout(900) },
  'clientsheet-kept-scrolled': {
    spec: 'clientsheet-kept',
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
  'clientsheet-not-kept': { before: async (p) => p.waitForTimeout(900) },
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
  // A finished report: the page, and each state of its Email list.
  finished: { full: true, before: async (p) => p.waitForTimeout(600) },
  'finished-menu': {
    spec: 'finished',
    before: async (p) => {
      await p.waitForTimeout(600)
      await p
        .getByRole('button', { name: 'More actions for this report' })
        .click()
      await p.waitForTimeout(400)
    },
  },
  'finished-sending': {
    full: true,
    before: async (p) => p.waitForTimeout(600),
  },
  'finished-noemail': {
    full: true,
    before: async (p) => p.waitForTimeout(900),
  },
  'finished-legacy': { full: true, before: async (p) => p.waitForTimeout(600) },
  'finished-big': { full: true, before: async (p) => p.waitForTimeout(600) },
  'finished-replaced': {
    full: true,
    before: async (p) => p.waitForTimeout(600),
  },
  'finished-answers': {
    full: true,
    before: async (p) => p.waitForTimeout(600),
  },
  // A replaced version's answers still say it was replaced.
  'finished-answers-replaced': {
    before: async (p) => p.waitForTimeout(600),
  },
  emails: { full: true, before: async (p) => p.waitForTimeout(600) },
  // Nobody on file: the field is there, and an address typed into it can be
  // kept on the client's record.
  'finished-notsent': { before: async (p) => p.waitForTimeout(600) },
  'send-noclientmail': {
    before: async (p) => {
      await p.waitForTimeout(700)
      await p.getByLabel('Email address').fill('jane.nguyen@outlook.com')
      await p.getByRole('button', { name: 'Add', exact: true }).click()
      await p.waitForTimeout(300)
    },
  },
  // A send's whole story, from its row.
  'finished-email-detail': {
    spec: 'finished',
    before: async (p) => {
      await p.waitForTimeout(600)
      await p.getByRole('button', { name: /^acounts@ridgeline/ }).click()
      await p.waitForTimeout(700)
    },
  },
  // "Send again" on the failed send: the sheet opens with it ticked.
  'finished-again': {
    spec: 'finished',
    before: async (p) => {
      await p.waitForTimeout(600)
      await p.getByRole('button', { name: 'Send again' }).click()
      await p.waitForTimeout(700)
    },
  },
  'report-settings': { full: true },
  // Whole page: the Letterhead card sits below the Business one.
  letterhead: { full: true },
  'letterhead-nodark': { full: true },
  'letterhead-nologo': { full: true },
  'report-preview': {},
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
  // Typed and not added: Send counts it, and the box says what its chip
  // would.
  'send-typed': {
    spec: 'send',
    before: async (p) => {
      await p.waitForTimeout(700)
      await p.getByRole('button', { name: 'Send to someone else' }).click()
      await p.getByLabel('Email address').fill('strata@harbourside.com.au')
      await p.waitForTimeout(300)
    },
  },
  // A near miss, held by Send: the box says why, and Send now says "anyway".
  'send-held': {
    spec: 'send',
    before: async (p) => {
      await p.waitForTimeout(700)
      await p.getByRole('button', { name: 'Send to someone else' }).click()
      await p.getByLabel('Email address').fill('bob@gmial.com')
      await p.getByRole('button', { name: /^Send to/ }).click()
      await p.waitForTimeout(300)
    },
  },
  // Nobody on file: what is typed is offered for the record before Send.
  'send-save-offer': {
    spec: 'send-noclientmail',
    before: async (p) => {
      await p.waitForTimeout(700)
      await p.getByLabel('Email address').fill('jane@harbourside.com.au')
      await p.waitForTimeout(300)
    },
  },
  'form-settings': { before: async (p) => p.waitForTimeout(700) },
  install: { full: true },
  'install-settings': { full: true },
  'install-card': {},
  'install-sheet': { before: async (p) => p.waitForTimeout(600) },
  'install-link': {},
  // The Clients page's first page: "50+ properties", no site yet, Show more.
  clients: { full: true, before: async (p) => p.waitForTimeout(600) },
  loadmore: { full: true, before: async (p) => p.waitForTimeout(600) },
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
  // The owner's Delete report, from the header's "⋯".
  'finished-delete': {
    spec: 'finished',
    before: async (p) => {
      await p.waitForTimeout(600)
      await p
        .getByRole('button', { name: 'More actions for this report' })
        .click()
      await p.waitForTimeout(300)
      await p.getByRole('menuitem', { name: 'Delete report' }).click()
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
    await page.setViewportSize(plan.viewport ?? { width: 390, height: 844 })
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
