import { expect } from '@playwright/test'
import type { Download, Locator, Page } from '@playwright/test'

/**
 * A finalised report's PDF as a person reaches it: the action bar's PDF tab,
 * then View PDF, which opens the app's own full-screen viewer. The tab used to
 * hold a small viewer of its own and a Download PDF button; both are gone.
 */

/** DRAFT across every page, in the viewer's top bar — a preview, not the record. */
export const DRAFT_BADGE = 'Draft — not the finished document'

/**
 * Generous: the first look at a finalised report may draw its PDF on the
 * server before a byte is downloaded, and pdf.js then has to open it.
 */
export const REPORT_PDF_TIMEOUT = 60_000

/** The viewer, whatever the report is called: it is named "<title> PDF". */
export function reportViewer(page: Page): Locator {
  return page.getByRole('dialog', { name: / PDF$/ })
}

/**
 * Waits for the viewer to have the document open: the top bar counts the
 * pages only once pdf.js has read the file.
 */
export async function expectDocumentOpen(viewer: Locator): Promise<void> {
  await expect(viewer).toBeVisible()
  await expect(viewer.getByText(/^\d+ pages?$/)).toBeVisible({
    timeout: REPORT_PDF_TIMEOUT,
  })
}

/**
 * PDF tab, then View PDF, and wait for the document to open. Both stay
 * disabled until the page hydrates — a click on server-rendered markup before
 * then is swallowed — so each is waited on first.
 */
export async function openReportPdf(page: Page): Promise<Locator> {
  const tab = page.getByRole('tab', { name: 'PDF' })
  await expect(tab).toBeEnabled()
  await tab.click()
  const view = page.getByRole('button', { name: 'View PDF' })
  await expect(view).toBeEnabled()
  await view.click()
  const viewer = reportViewer(page)
  await expectDocumentOpen(viewer)
  return viewer
}

/**
 * Save from the viewer's More menu, as a desktop does it: a download. "Save
 * to Files" is the same item where an Apple phone takes files through the
 * share sheet; the report specs run on desktop Chromium, which has none.
 */
export async function downloadFromViewer(
  page: Page,
  viewer: Locator,
): Promise<Download> {
  await viewer.getByRole('button', { name: 'More' }).click()
  const downloaded = page.waitForEvent('download')
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: /^(Download|Save to Files)$/ })
    .click()
  return downloaded
}

/**
 * One stroke with the mouse across the visible middle of page `n`, in markup
 * mode. A mouse draws as one finger does (`markupInput.ts`); kept clear of
 * the top bar and the palette at the bottom, which sit over the pages.
 */
export async function drawOnPage(
  page: Page,
  viewer: Locator,
  n: number,
): Promise<void> {
  const slot = viewer.getByRole('img', {
    name: new RegExp(`^Page ${n} of \\d+$`),
  })
  await expect(slot).toBeVisible()
  const box = await slot.boundingBox()
  const size = page.viewportSize()
  if (!box || !size) throw new Error(`page ${n} has no box to draw in`)
  const top = Math.max(box.y, 120)
  const bottom = Math.min(box.y + box.height, size.height - 180)
  if (bottom - top < 40) throw new Error(`too little of page ${n} is on screen`)
  const y = top + (bottom - top) * 0.4
  await page.mouse.move(box.x + box.width * 0.3, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.5, y + 30, { steps: 8 })
  await page.mouse.move(box.x + box.width * 0.6, y + 10, { steps: 8 })
  await page.mouse.up()
}
