import { afterEach, describe, expect, test, vi } from 'vitest'
import { asPdfFile, savePdf, sharePdf } from '#/lib/pdfFiles'
import { handOver } from './handOver'
import type { HandOverResult } from './types'

/**
 * The viewer's Share and Save, as a report with marks uses them: the note
 * that the marks were left out ("Sent without the marks") is said once the
 * file has gone — and not when the person closes the share sheet without
 * choosing anything, when nothing went. On an iPhone, Save to Files is that
 * same share sheet, closed the same way.
 *
 * It was said either way: `sharePdf` swallowed the sheet's AbortError and
 * resolved exactly as it did for a real send, and the viewer took any
 * resolution for "sent".
 */

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

function stubShareSheet(share: (data: ShareData) => Promise<void>) {
  vi.stubGlobal('navigator', {
    userAgent: IPHONE_UA,
    platform: 'iPhone',
    maxTouchPoints: 5,
    share: vi.fn(share),
    canShare: vi.fn(() => true),
  })
}

const closedWithoutChoosing = async () => {
  throw new DOMException('Share canceled', 'AbortError')
}

/** Lets every promise callback already queued run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const SENT = 'Sent without the marks — they stay in the app for your team.'
const FAILED = "Couldn't share this PDF"

/** A tap on Share with marks on the pages: every toast it gives, in order. */
async function tap(
  action: () => Promise<HandOverResult> | HandOverResult,
): Promise<Array<string>> {
  const toasts: Array<string> = []
  const toast = (message: string) => toasts.push(message)
  handOver(action, FAILED, toast, () => toast(SENT))
  await settle()
  return toasts
}

const file = () => asPdfFile(new Blob(['%PDF-']), 'report.pdf')

describe('"Sent without the marks" is said only when the file went', () => {
  test('a share sheet closed without choosing says nothing at all', async () => {
    stubShareSheet(closedWithoutChoosing)
    expect(await tap(() => sharePdf(file(), { title: 'Report' }))).toEqual([])
  })

  test('Save to Files on an iPhone, closed without choosing, says nothing', async () => {
    stubShareSheet(closedWithoutChoosing)
    expect(await tap(() => savePdf(file()))).toEqual([])
  })

  test('a share that went says so, once', async () => {
    stubShareSheet(async () => {})
    expect(await tap(() => sharePdf(file(), { title: 'Report' }))).toEqual([
      SENT,
    ])
  })

  test('Save to Files that saved says so', async () => {
    stubShareSheet(async () => {})
    expect(await tap(() => savePdf(file()))).toEqual([SENT])
  })

  test('a download, or a caller that reports no outcome, counts as gone', async () => {
    expect(await tap(() => 'saved')).toEqual([SENT])
    expect(await tap(async () => {})).toEqual([SENT])
    expect(await tap(() => undefined)).toEqual([SENT])
  })

  test('the browser’s own AbortError, reaching the viewer, is a cancel too', async () => {
    expect(
      await tap(() => Promise.reject(new DOMException('', 'AbortError'))),
    ).toEqual([])
  })

  test('a share that failed says that, and not that it went', async () => {
    stubShareSheet(async () => {
      throw new DOMException('no gesture', 'NotAllowedError')
    })
    expect(await tap(() => sharePdf(file(), { title: 'Report' }))).toEqual([
      FAILED,
    ])
  })

  test('an action that throws before it starts says so', async () => {
    expect(
      await tap(() => {
        throw new Error('no sheet')
      }),
    ).toEqual([FAILED])
  })

  test('the share sheet is asked for inside the tap, before anything is awaited', () => {
    stubShareSheet(async () => {})
    handOver(
      () => sharePdf(file(), { title: 'Report' }),
      FAILED,
      () => {},
    )
    expect(navigator.share).toHaveBeenCalledTimes(1)
  })
})
