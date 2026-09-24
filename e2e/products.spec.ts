import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import {
  api,
  clickUntil,
  expectRejected,
  setupBusinessWithSub,
  signInViaUi,
} from './fixtures'
import {
  SAMPLE_PDF_SECTIONS,
  samplePdf,
  samplePdfHeading,
} from './fixtures/pdf'
import { solidPng } from './fixtures/png'
import type { Locator, Page, TestInfo } from '@playwright/test'
import type { Actor } from './fixtures'
import type { Id } from '../convex/_generated/dataModel'

/**
 * Products (Phase 7.1): the business's shelf of labels and safety data
 * sheets, reached from the burger on a phone, and the in-app PDF viewer that
 * opens them — never Safari, never a download just to read one.
 *
 * The viewer is judged on a real document (`samplePdf`): its page count, a
 * page actually drawn (`data-rendered` on the page's base layer, and ink on
 * paper in the canvas under it — see `expectDrawn`), and text that search can
 * find on one page and not another.
 */

/**
 * The first open of a PDF on a fresh page load fetches the viewer's chunk and
 * starts pdf.js's worker, which is a couple of megabytes of script to parse
 * before a page can be drawn. Generous, because that is a cold start under a
 * parallel run, and bounded, because a viewer that takes longer than this on
 * localhost is a bug.
 */
const PDF_TIMEOUT = 30_000

/** Uploading a photo and a PDF, then the list catching up with the write. */
const SAVE_TIMEOUT = 30_000

const NAME = 'Termidor Residual Termiticide'

/** What an upload URL answers, which is the only way to get a storage id. */
async function upload(
  actor: Actor,
  businessId: Id<'businesses'>,
  body: Buffer,
  contentType: string,
): Promise<Id<'_storage'>> {
  const uploadUrl = await actor.client.mutation(
    api.products.generateUploadUrl,
    { businessId },
  )
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    // A copy on a plain ArrayBuffer: fetch's types refuse a Buffer that may
    // sit on a SharedArrayBuffer, which is what `samplePdf`'s is typed as.
    body: new Uint8Array(body),
  })
  if (!res.ok) throw new Error(`upload failed: ${res.status}`)
  const { storageId } = (await res.json()) as { storageId: Id<'_storage'> }
  return storageId
}

/**
 * A product added through the API, for the tests whose subject is something
 * other than the form. The form itself is driven for real in the first test.
 */
async function addProduct(
  actor: Actor,
  businessId: Id<'businesses'>,
  product: {
    name: string
    description?: string
    url?: string
    pdf?: { pages: number; fileName: string }
    photo?: Buffer
  },
): Promise<Id<'products'>> {
  return actor.client.mutation(api.products.create, {
    businessId,
    name: product.name,
    description: product.description,
    url: product.url,
    photoStorageId: product.photo
      ? await upload(actor, businessId, product.photo, 'image/png')
      : undefined,
    pdf: product.pdf
      ? {
          storageId: await upload(
            actor,
            businessId,
            samplePdf({ pages: product.pdf.pages }),
            'application/pdf',
          ),
          fileName: product.pdf.fileName,
        }
      : undefined,
  })
}

async function listFor(actor: Actor, businessId: Id<'businesses'>) {
  return actor.client.query(api.products.list, { businessId })
}

/**
 * Products from the navigation, the way a technician gets there: the burger's
 * sheet on a phone — Products is not one of the dock's four — and the
 * sidebar's "More" group on a desktop, which shows the same sections open.
 */
async function reachProducts(page: Page, slug: string, testInfo: TestInfo) {
  await page.goto(`/${slug}/schedule`)
  await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible()

  if (testInfo.project.name === 'mobile') {
    const dock = page.getByRole('navigation', { name: 'Tabs' })
    await expect(dock.getByRole('link', { name: 'Products' })).toHaveCount(0)
    const more = page.getByRole('dialog', { name: 'More' })
    // The dock's button is named "More, 2 overdue" when jobs are overdue.
    await clickUntil(dock.getByRole('button', { name: /^More/ }), () =>
      expect(more).toBeVisible({ timeout: 2_000 }),
    )
    await more.getByRole('link', { name: 'Products' }).click()
  } else {
    const sidebar = page.getByRole('navigation', { name: 'Primary' })
    await clickUntil(sidebar.getByRole('link', { name: 'Products' }), () =>
      expect(page).toHaveURL(new RegExp(`/${slug}/products$`), {
        timeout: 2_000,
      }),
    )
  }

  await expect(page).toHaveURL(new RegExp(`/${slug}/products$`))
  await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible()
  // Disabled until the page hydrates: the readiness signal for everything
  // after it, including file inputs, which drop files set before then.
  await expect(page.getByRole('button', { name: 'New product' })).toBeEnabled()
}

/** Straight to the page, for tests whose subject is not the navigation. */
async function gotoProducts(page: Page, slug: string) {
  await page.goto(`/${slug}/products`)
  await expect(page.getByRole('button', { name: 'New product' })).toBeEnabled()
}

/**
 * A product's card on the list. Its accessible name starts with the product's
 * name, then its description and its PDF chip.
 */
function card(page: Page, name: string): Locator {
  return page.getByRole('button', { name: new RegExp(`^${name}`) })
}

/**
 * The product sheet, named by its title — exact, because the viewer is named
 * "<product> PDF" and a name match is a substring match otherwise.
 */
function productSheet(page: Page, name: string): Locator {
  return page.getByRole('dialog', { name, exact: true })
}

/**
 * Opens a product from its card. Settled on the sheet itself, which appears
 * the moment the click lands: a retried click would land on the scrim.
 */
async function openProduct(page: Page, name: string): Promise<Locator> {
  const sheet = productSheet(page, name)
  await clickUntil(card(page, name), () =>
    expect(sheet).toBeVisible({ timeout: 2_000 }),
  )
  return sheet
}

function viewerOf(page: Page, name: string): Locator {
  return page.getByRole('dialog', { name: `${name} PDF` })
}

/** Page `n` of `of`'s base layer: the canvas pdf.js draws the page into. */
function pageBase(viewer: Locator, n: number, of: number): Locator {
  return viewer
    .getByRole('img', { name: `Page ${n} of ${of}` })
    .locator('[data-layer="base"]')
}

/**
 * What is on a page's base canvas, as shares of its pixels: ink (dark) and
 * paper (light). Read from the newest canvas in the layer — a redraw appends
 * its canvas before it releases the old one.
 */
async function inkAndPaper(
  base: Locator,
): Promise<{ ink: number; paper: number }> {
  return base
    .locator('canvas')
    .last()
    .evaluate((element) => {
      const canvas = element as HTMLCanvasElement
      const total = canvas.width * canvas.height
      const context = total > 0 ? canvas.getContext('2d') : null
      if (!context) return { ink: 0, paper: 0 }
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
      let ink = 0
      let paper = 0
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue // transparent: nothing drawn here
        const sum = data[i] + data[i + 1] + data[i + 2]
        if (sum < 3 * 96) ink++
        else if (sum > 3 * 224) paper++
      }
      return { ink: ink / total, paper: paper / total }
    })
}

/**
 * Page `n` of `of` drawn: the renderer's flag, and then the page itself.
 *
 * The flag alone is the renderer vouching for its own work — it is set when a
 * canvas is placed — so a render that is skipped still sets it, over a blank
 * page, and every other check in this file still passes (search reads the
 * text content, not the canvas). The pixels settle it. `samplePdf` is black
 * Helvetica on white, and pdf.js fills the page white before its first glyph:
 * a drawn page is about 99% paper and 0.4% ink, at either project's size. A
 * canvas nothing was drawn into reads as transparent, so it has neither; one
 * filled but never written on has no ink; one left black has no paper.
 */
async function expectDrawn(
  viewer: Locator,
  n: number,
  of: number,
): Promise<void> {
  const base = pageBase(viewer, n, of)
  await expect(base).toHaveAttribute('data-rendered', 'true', {
    timeout: PDF_TIMEOUT,
  })
  // Polled: a redraw at a new size can release the canvas just read.
  await expect
    .poll(
      async () => {
        const { ink, paper } = await inkAndPaper(base)
        return paper > 0.5 && ink > 0.001
      },
      { message: `page ${n} of ${of} has ink on paper` },
    )
    .toBe(true)
}

/** View PDF, and wait for the document to open and its first page to draw. */
async function openViewer(
  page: Page,
  sheet: Locator,
  name: string,
  pages: number,
): Promise<Locator> {
  const viewer = viewerOf(page, name)
  await sheet.getByRole('button', { name: 'View PDF' }).click()
  await expect(viewer).toBeVisible()
  await expect(viewer.getByText(`${pages} pages`, { exact: true })).toBeVisible(
    { timeout: PDF_TIMEOUT },
  )
  await expectDrawn(viewer, 1, pages)
  return viewer
}

test.describe('adding and reading a product', () => {
  // Copy is judged by what reaches the clipboard, not by the button's word.
  // Both projects are Chromium, so both can grant it.
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

  test('a technician adds a product with a photo, a link and a PDF, and reads the PDF in the app', async ({
    page,
  }, testInfo) => {
    const s = await setupBusinessWithSub('products-add')
    await signInViaUi(page, s.sub.email)
    await reachProducts(page, s.slug, testInfo)
    await expect(page.getByText('No products yet')).toBeVisible()

    // ── Added through the form ──────────────────────────────────────────
    const form = page.getByRole('dialog', { name: 'New product' })
    await clickUntil(page.getByRole('button', { name: 'New product' }), () =>
      expect(form).toBeVisible({ timeout: 2_000 }),
    )

    await form.locator('input[type="file"][accept="image/*"]').setInputFiles({
      name: 'termidor.png',
      mimeType: 'image/png',
      buffer: solidPng(160, 120, [196, 120, 40]),
    })
    // Shrunk and re-encoded on the phone before it is in the draft.
    await expect(
      form.getByRole('button', { name: 'Change photo' }),
    ).toBeVisible({ timeout: 20_000 })

    await form.getByLabel('Name', { exact: true }).fill(NAME)
    await form
      .getByLabel('Description', { exact: true })
      .fill('Fipronil soil barrier. Mix 60 mL per 10 L.')
    // A bare domain, the way it is read off a tin.
    await form.getByLabel('Website', { exact: true }).fill('termidor.com.au')

    const pdf = samplePdf({ pages: 3 })
    await form
      .locator('input[type="file"][accept="application/pdf,.pdf"]')
      .setInputFiles({
        name: 'Termidor SDS.pdf',
        mimeType: 'application/pdf',
        buffer: pdf,
      })
    // Checked on the phone (its first bytes), and held until Save.
    await expect(form.getByText('Termidor SDS.pdf')).toBeVisible()
    await expect(form.getByText(/uploads when you save/)).toBeVisible()

    await form.getByRole('button', { name: 'Add product' }).click()
    await expect(form).toBeHidden({ timeout: SAVE_TIMEOUT })

    // Saved, it opens straight away.
    const sheet = productSheet(page, NAME)
    await expect(sheet).toBeVisible({ timeout: SAVE_TIMEOUT })

    // Stored as a link that goes somewhere: https, whatever was typed.
    const [row] = await listFor(s.sub, s.businessId)
    expect(row).toMatchObject({
      name: NAME,
      url: 'https://termidor.com.au/',
      pdf: { fileName: 'Termidor SDS.pdf', size: pdf.length },
      canEdit: true,
    })
    expect(row.photoUrl).not.toBeNull()

    await sheet.getByRole('button', { name: 'Close' }).click()
    await expect(sheet).toBeHidden()

    // ── The card ────────────────────────────────────────────────────────
    const product = card(page, NAME)
    await expect(product).toBeVisible()
    await expect(product.getByText(/^PDF · /)).toBeVisible()
    await expect(product.locator('img')).toBeVisible()
    await expect(page.getByText('1 product', { exact: true })).toBeVisible()

    // ── The sheet: its photo and its web page ───────────────────────────
    await openProduct(page, NAME)
    await expect(
      sheet.getByRole('img', { name: `Photo of ${NAME}` }),
    ).toBeVisible()
    await expect(sheet.getByText('termidor.com.au')).toBeVisible()
    await expect(sheet.getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      'https://termidor.com.au/',
    )

    await sheet.getByRole('button', { name: 'Copy', exact: true }).click()
    await expect(sheet.getByRole('button', { name: 'Copied' })).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'https://termidor.com.au/',
    )

    // ── The viewer: in the app, from start to finish ────────────────────
    // Reading a PDF must never cost a tab or a download. Counted over every
    // open and close below.
    const popups: string[] = []
    const downloads: string[] = []
    page.on('popup', (popup) => popups.push(popup.url()))
    page.on('download', (download) => downloads.push(download.url()))
    page.context().on('page', (opened) => popups.push(opened.url()))
    // And nothing thrown along the way: pdf.js runs in a worker, and a page
    // that fails to draw can still leave the frame looking fine.
    const thrown: string[] = []
    page.on('pageerror', (error) => thrown.push(error.message))

    const viewer = await openViewer(page, sheet, NAME, 3)
    await expect(page).toHaveURL(/view=pdf/)
    // The sheet steps aside while the viewer is up: two modals are two
    // focus traps, and the back gesture would have two things to close.
    await expect(sheet).toBeHidden()

    // Search: the heading on page 2, em dash and all, which is on no other
    // page — so "1 of 1" is a count, not a coincidence.
    const heading = samplePdfHeading(2)
    expect(heading).toContain(SAMPLE_PDF_SECTIONS[1])
    await viewer.getByRole('button', { name: 'Search', exact: true }).click()
    await viewer.getByRole('textbox', { name: 'Search in PDF' }).fill(heading)
    const search = viewer.getByRole('search', { name: 'Search in PDF' })
    await expect(search.getByText('1 of 1')).toBeVisible({
      timeout: PDF_TIMEOUT,
    })
    await expect(
      viewer
        .getByRole('img', { name: 'Page 2 of 3' })
        .locator('[data-search-hit="current"]')
        .first(),
    ).toBeVisible()
    await viewer.getByRole('button', { name: 'Done searching' }).click()
    await expect(search).toHaveCount(0)

    // Done closes the viewer, back onto the product it was opened from.
    await viewer.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(viewer).toBeHidden()
    await expect(sheet).toBeVisible()
    await expect(page).not.toHaveURL(/view=pdf/)

    // And so does the phone's back gesture.
    await openViewer(page, sheet, NAME, 3)
    await page.goBack()
    await expect(viewer).toBeHidden()
    await expect(sheet).toBeVisible()
    await expect(page).not.toHaveURL(/view=pdf/)

    expect(popups).toEqual([])
    expect(downloads).toEqual([])
    expect(thrown).toEqual([])
  })
})

test('only the person who added a product, or the owner, can change it', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('products-perm')
  const ownersId = await addProduct(s.owner, s.businessId, {
    name: 'Biflex Aqua',
    pdf: { pages: 2, fileName: 'Biflex label.pdf' },
  })
  const subsId = await addProduct(s.sub, s.businessId, {
    name: 'Advion Cockroach Gel',
    pdf: { pages: 2, fileName: 'Advion SDS.pdf' },
  })

  await signInViaUi(page, s.sub.email)
  await gotoProducts(page, s.slug)

  // Theirs first, so the missing controls below are missing for a reason,
  // not because the sheet never draws them.
  let sheet = await openProduct(page, 'Advion Cockroach Gel')
  await expect(sheet.getByRole('button', { name: 'Edit' })).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Replace' })).toBeVisible()
  await sheet.getByRole('button', { name: 'Close' }).click()
  await expect(sheet).toBeHidden()

  // The owner's: readable, not changeable.
  sheet = await openProduct(page, 'Biflex Aqua')
  await expect(sheet.getByRole('button', { name: 'View PDF' })).toBeEnabled()
  await expect(sheet.getByRole('button', { name: 'Edit' })).toHaveCount(0)
  await expect(sheet.getByRole('button', { name: 'Replace' })).toHaveCount(0)
  await expect(sheet.getByRole('button', { name: 'Add photo' })).toHaveCount(0)
  await expect(
    sheet.getByRole('button', { name: 'Delete product' }),
  ).toHaveCount(0)

  // Nor from inside the viewer, which has a Replace of its own.
  const viewer = await openViewer(page, sheet, 'Biflex Aqua', 2)
  await viewer.getByRole('button', { name: 'More' }).click()
  const menu = page.getByRole('menu')
  // Save is still there for everyone. "Save to Files" where the share sheet
  // takes files on an Apple phone; this emulated one has no share sheet.
  await expect(
    menu.getByRole('menuitem', { name: /^(Download|Save to Files)$/ }),
  ).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /Replace PDF/ })).toHaveCount(
    0,
  )
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()

  // A hidden button is not access control: the server refuses too.
  await expectRejected(
    () =>
      s.sub.client.mutation(api.products.update, {
        businessId: s.businessId,
        productId: ownersId,
        description: 'Changed by someone who may not',
      }),
    'NO_ACCESS',
  )
  await expectRejected(
    () =>
      s.sub.client.mutation(api.products.remove, {
        businessId: s.businessId,
        productId: ownersId,
      }),
    'NO_ACCESS',
  )
  const asSub = await listFor(s.sub, s.businessId)
  expect(asSub.find((p) => p.id === ownersId)?.canEdit).toBe(false)

  // The owner may change anyone's.
  const asOwner = await listFor(s.owner, s.businessId)
  expect(asOwner.find((p) => p.id === subsId)?.canEdit).toBe(true)
  await s.owner.client.mutation(api.products.update, {
    businessId: s.businessId,
    productId: subsId,
    description: 'Checked by the owner',
  })
  const after = await listFor(s.sub, s.businessId)
  expect(after.find((p) => p.id === subsId)?.description).toBe(
    'Checked by the owner',
  )
})

test('whoever added a product can replace its PDF from the viewer, and the viewer opens the new one', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('products-replace')
  await addProduct(s.sub, s.businessId, {
    name: NAME,
    pdf: { pages: 3, fileName: 'Termidor SDS.pdf' },
  })

  await signInViaUi(page, s.sub.email)
  await gotoProducts(page, s.slug)
  const sheet = await openProduct(page, NAME)
  await expect(sheet.getByText('Termidor SDS.pdf')).toBeVisible()

  const viewer = await openViewer(page, sheet, NAME, 3)
  await viewer.getByRole('button', { name: 'More' }).click()
  // The picker opens from the menu item's own tap — a browser opens one for
  // nothing else — so the chooser is the event to wait on.
  const chooser = page.waitForEvent('filechooser')
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: 'Replace PDF…' })
    .click()
  await (
    await chooser
  ).setFiles({
    name: 'Termidor label v2.pdf',
    mimeType: 'application/pdf',
    buffer: samplePdf({ pages: 2 }),
  })

  // Saved — said over the viewer, which stays open — and the viewer follows
  // the product to its new file without being closed and reopened.
  await expect(page.getByText('New PDF saved')).toBeVisible({
    timeout: SAVE_TIMEOUT,
  })
  await expect(viewer.getByText('2 pages', { exact: true })).toBeVisible({
    timeout: SAVE_TIMEOUT,
  })
  await expectDrawn(viewer, 1, 2)
  await expect(viewer.getByRole('img', { name: /of 3$/ })).toHaveCount(0)

  await viewer.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText('Termidor label v2.pdf')).toBeVisible()
  await expect(sheet.getByText('Termidor SDS.pdf')).toHaveCount(0)

  const [row] = await listFor(s.sub, s.businessId)
  expect(row.pdf).toMatchObject({
    fileName: 'Termidor label v2.pdf',
    size: samplePdf({ pages: 2 }).length,
  })
})

test.describe('a PDF kept on this phone', () => {
  // The storage requests are answered by `page.route`, and must not be taken
  // by the service worker first.
  test.use({ serviceWorkers: 'block' })

  test('opens with the file server out of reach', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'chromium',
      'one engine is enough for Cache Storage',
    )

    const s = await setupBusinessWithSub('products-keep')
    await addProduct(s.sub, s.businessId, {
      name: NAME,
      pdf: { pages: 3, fileName: 'Termidor SDS.pdf' },
    })
    const [row] = await listFor(s.sub, s.businessId)
    const pdfUrl = row.pdf?.url
    expect(pdfUrl).toBeTruthy()

    await signInViaUi(page, s.sub.email)
    await gotoProducts(page, s.slug)
    let sheet = await openProduct(page, NAME)

    const keep = sheet.getByRole('button', { name: 'Keep on this phone' })
    await expect(keep).toBeEnabled()
    await keep.click()
    const forget = sheet.getByRole('button', { name: 'Remove from phone' })
    await expect(forget).toBeVisible({ timeout: SAVE_TIMEOUT })
    await expect(forget).toHaveAttribute('aria-pressed', 'true')
    await expect(sheet.getByText('On this phone')).toBeVisible()

    // The file server goes away — every signed URL Convex hands out for a
    // stored file is under /api/storage/ — while the list itself, which
    // comes over Convex's websocket, stays up: signal enough for the query,
    // not for a download, which is what one bar in a roof void looks like.
    await page.route('**/api/storage/**', (route) =>
      route.abort('internetdisconnected'),
    )

    // A fresh load, not a reload: the address still names the open product,
    // and a new document holds none of the bytes the keep fetched earlier.
    await gotoProducts(page, s.slug)
    await expect(card(page, NAME).getByText('On this phone')).toBeVisible()

    // Through the sheet, which reads the kept copy into memory as it opens —
    // Share must have the bytes on the first tap — so the viewer finds them
    // there.
    sheet = await openProduct(page, NAME)
    await openViewer(page, sheet, NAME, 3)

    // And straight onto the viewer, with no sheet on the way: the address an
    // installed app reopens on after the phone has closed it in the
    // background. Nothing in this document has read the kept copy, so a page
    // drawn here is the viewer's own loader going to Cache Storage for it —
    // the path the sheet above stands in front of.
    await page.goto(`/${s.slug}/products?product=${row.id}&view=pdf`)
    const reopened = viewerOf(page, NAME)
    await expect(reopened).toBeVisible()
    await expect(productSheet(page, NAME)).toHaveCount(0)
    await expect(reopened.getByText('3 pages', { exact: true })).toBeVisible({
      timeout: PDF_TIMEOUT,
    })
    await expectDrawn(reopened, 1, 3)

    // And the block held throughout: the PDF's own URL does not answer, so
    // the pages just drawn came from the copy on the phone.
    expect(
      await page.evaluate(
        (url) =>
          fetch(url).then(
            () => 'answered',
            () => 'refused',
          ),
        pdfUrl!,
      ),
    ).toBe('refused')
  })
})

test('Download in the viewer saves the PDF itself on a desktop', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium',
    'a phone saves through the share sheet, not a download',
  )

  const s = await setupBusinessWithSub('products-download')
  await addProduct(s.sub, s.businessId, {
    name: NAME,
    pdf: { pages: 3, fileName: 'Termidor SDS.pdf' },
  })

  await signInViaUi(page, s.sub.email)
  await gotoProducts(page, s.slug)
  const sheet = await openProduct(page, NAME)
  const viewer = await openViewer(page, sheet, NAME, 3)

  // Saving IS a download — an explicit Save, not reading — so here one is
  // expected, of the very bytes that were uploaded.
  await viewer.getByRole('button', { name: 'More' }).click()
  const downloaded = page.waitForEvent('download')
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: 'Download' })
    .click()
  const download = await downloaded
  expect(download.suggestedFilename()).toBe('Termidor SDS.pdf')
  expect(download.suggestedFilename()).toMatch(/\.pdf$/)
  const bytes = await readFile(await download.path())
  expect(bytes.equals(samplePdf({ pages: 3 }))).toBe(true)

  // And the viewer is still open: saving a copy does not close the document.
  await expect(viewer).toBeVisible()
})

test('whoever added a product can delete it, after saying so', async ({
  page,
}) => {
  const s = await setupBusinessWithSub('products-delete')
  await addProduct(s.sub, s.businessId, {
    name: NAME,
    description: 'Fipronil soil barrier.',
    pdf: { pages: 2, fileName: 'Termidor SDS.pdf' },
  })

  await signInViaUi(page, s.sub.email)
  await gotoProducts(page, s.slug)
  const sheet = await openProduct(page, NAME)
  await sheet.getByRole('button', { name: 'Edit' }).click()

  const edit = page.getByRole('dialog', { name: 'Edit product' })
  await expect(edit.getByLabel('Name', { exact: true })).toHaveValue(NAME)
  await edit.getByRole('button', { name: 'Delete product' }).click()

  const confirm = page.getByRole('alertdialog', { name: `Delete ${NAME}?` })
  await expect(confirm).toBeVisible()
  // "Keep it" is the way out, and it leaves everything as it was.
  await confirm.getByRole('button', { name: 'Keep it' }).click()
  await expect(confirm).toBeHidden()
  await expect(edit).toBeVisible()

  await edit.getByRole('button', { name: 'Delete product' }).click()
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(confirm).toBeHidden()
  await expect(edit).toBeHidden()
  await expect(card(page, NAME)).toHaveCount(0)
  await expect(page.getByText('No products yet')).toBeVisible()
  expect(await listFor(s.sub, s.businessId)).toEqual([])
})

/**
 * Screenshots for a person to look at — not assertions. Written only when
 * PRODUCTS_SHOTS is set: to a directory, or to test-results/products-shots
 * when it is just "1". Phone only, since the phone is the layout that matters.
 *
 *   PRODUCTS_SHOTS=1 E2E_BASE_URL=… npx playwright test products --project=mobile
 */
test('screenshots of Products on a phone', async ({ page }, testInfo) => {
  const target = process.env.PRODUCTS_SHOTS
  test.skip(!target, 'set PRODUCTS_SHOTS to write them')
  test.skip(testInfo.project.name !== 'mobile', 'phone screenshots only')
  test.setTimeout(120_000)

  const dir =
    target === '1' ? path.join('test-results', 'products-shots') : target!
  mkdirSync(dir, { recursive: true })
  const shot = (file: string) => page.screenshot({ path: path.join(dir, file) })

  const s = await setupBusinessWithSub('products-shots')
  await signInViaUi(page, s.sub.email)
  await gotoProducts(page, s.slug)
  await expect(page.getByText('No products yet')).toBeVisible()
  await shot('01-empty.png')

  await addProduct(s.sub, s.businessId, {
    name: NAME,
    description:
      'Fipronil soil barrier and termite treatment. Mix 60 mL per 10 L of water for a trench and rod.',
    url: 'termidor.com.au/professional/residual-termiticide',
    photo: solidPng(400, 300, [196, 120, 40]),
    pdf: { pages: 8, fileName: 'Termidor SDS 2024.pdf' },
  })
  await addProduct(s.sub, s.businessId, {
    name: 'Advion Cockroach Gel',
    description: 'Indoxacarb bait for German cockroaches.',
    pdf: { pages: 2, fileName: 'Advion label.pdf' },
  })
  await expect(card(page, 'Advion Cockroach Gel')).toBeVisible()
  await expect(card(page, NAME).locator('img')).toBeVisible()
  await shot('02-list.png')

  const sheet = await openProduct(page, NAME)
  await expect(
    sheet.getByRole('img', { name: `Photo of ${NAME}` }),
  ).toBeVisible()
  // The sheet slides up; let it land.
  await page.waitForTimeout(600)
  await shot('03-sheet.png')

  await sheet.getByRole('button', { name: 'Edit' }).click()
  const edit = page.getByRole('dialog', { name: 'Edit product' })
  await expect(edit.getByLabel('Name', { exact: true })).toHaveValue(NAME)
  await shot('04-form.png')
  await edit.getByRole('button', { name: 'Cancel' }).click()
  await expect(sheet).toBeVisible()
  await page.waitForTimeout(600)

  const viewer = await openViewer(page, sheet, NAME, 8)
  await shot('05-viewer.png')

  await viewer.getByRole('button', { name: 'Search', exact: true }).click()
  await viewer.getByRole('textbox', { name: 'Search in PDF' }).fill('measures')
  await expect(viewer.getByRole('search').getByText(/^1 of \d+$/)).toBeVisible({
    timeout: PDF_TIMEOUT,
  })
  await expect(
    viewer.locator('[data-search-hit="current"]').first(),
  ).toBeVisible()
  await shot('06-search.png')
  await viewer.getByRole('button', { name: 'Done searching' }).click()

  await viewer.getByRole('button', { name: 'Pages', exact: true }).click()
  const grid = viewer.getByRole('list', { name: 'Pages' })
  await expect(grid.getByRole('button', { name: 'Page 8' })).toBeAttached()
  await expect(grid.locator('[data-thumb="0"] canvas')).toBeAttached({
    timeout: PDF_TIMEOUT,
  })
  await page.waitForTimeout(500)
  await shot('07-grid.png')
  await viewer.getByRole('button', { name: 'Pages', exact: true }).click()
  await expect(grid).toHaveCount(0)

  await viewer.getByRole('button', { name: 'More' }).click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.waitForTimeout(300)
  await shot('08-menu.png')
})
