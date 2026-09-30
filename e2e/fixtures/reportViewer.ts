import { expect } from '@playwright/test'
import type { Download, Locator, Page } from '@playwright/test'

/**
 * A finalised report as a person reaches it: one page, whose View PDF opens
 * the app's own full-screen viewer and whose Answers opens the form as it was
 * recorded. It was four tabs until 30 Sept 2026 (Form, PDF, Email, Logs).
 */

/** Said on a finalised report's page (its Details), and only there. */
export const LOCKED = 'Locked: it can’t be edited'

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
 * View PDF, and wait for the document to open. It stays disabled until the
 * page hydrates — a click on server-rendered markup before then is swallowed
 * — so it is waited on first.
 */
export async function openReportPdf(page: Page): Promise<Locator> {
  const view = page.getByRole('button', { name: 'View PDF' })
  await expect(view).toBeEnabled()
  await view.click()
  const viewer = reportViewer(page)
  await expectDocumentOpen(viewer)
  return viewer
}

/**
 * The finalised report's Answers — the form as it was recorded, photos and
 * all — from its page, and back. Disabled until the page hydrates, so waited
 * on first.
 */
export async function openAnswers(page: Page): Promise<void> {
  const answers = page.getByRole('button', { name: /^Answers/ })
  await expect(answers).toBeEnabled()
  await answers.click()
  await expect(
    page.getByRole('heading', { level: 1, name: 'Answers' }),
  ).toBeVisible()
}

export async function closeAnswers(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Report', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Answers/ })).toBeVisible()
}

/**
 * Save from the viewer's top bar, as a desktop does it: a download. "Save to
 * Files" is the same button where an Apple phone takes files through the
 * share sheet; the report specs run on desktop Chromium, which has none. It
 * was the only item of a More menu until 30 Sept 2026.
 */
export async function downloadFromViewer(
  page: Page,
  viewer: Locator,
): Promise<Download> {
  const downloaded = page.waitForEvent('download')
  await viewer
    .getByRole('button', { name: /^(Download|Save to Files)$/ })
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
