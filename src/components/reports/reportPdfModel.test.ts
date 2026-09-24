import { describe, expect, test, vi } from 'vitest'
import { ConvexError } from 'convex/values'
import { FileTransferError } from '#/lib/pdfFiles'
import {
  MAX_COORDINATE,
  MAX_MARKUP_PAGE,
  MAX_POINTS_PER_STROKE,
  MIN_COORDINATE,
} from '../../../convex/lib/reportMarkup'
import {
  PdfProblem,
  createInFlight,
  isSignalProblem,
  markupProblem,
  previewProblem,
  replacedBadge,
  reportPdfProblem,
  strokeToSave,
  strokesByPage,
} from './reportPdfModel'
import type { AnnotationRow } from './reportPdfModel'

let serial = 0
function row(fields: Partial<AnnotationRow> & { page: number }): AnnotationRow {
  serial += 1
  return {
    id: `stroke-${serial}`,
    points: [
      { x: 0.1, y: 0.1 },
      { x: 0.2, y: 0.2 },
    ],
    createdAt: serial,
    mine: true,
    authorColour: null,
    ...fields,
  }
}

describe('pages: stored from 1, shown from 0', () => {
  test('a stroke stored on page 1 is drawn in the first slot', () => {
    const first = row({ page: 1 })
    const third = row({ page: 3 })
    const byPage = strokesByPage([first, third])
    expect([...byPage.keys()]).toEqual([0, 2])
    expect(byPage.get(0)?.map((s) => s.id)).toEqual([first.id])
    expect(byPage.get(2)?.map((s) => s.id)).toEqual([third.id])
  })

  test('a stroke drawn in a slot is saved to the page that slot shows', () => {
    const saved = strokeToSave(0, [{ x: 0.5, y: 0.5 }])
    expect(saved?.page).toBe(1)
    // The round trip lands where it started — not one page on.
    const back = strokesByPage([row({ page: saved?.page ?? 0 })])
    expect([...back.keys()]).toEqual([0])
  })

  test('a row with no page a slot could hold is left out, not misplaced', () => {
    const byPage = strokesByPage([
      row({ page: 0 }),
      row({ page: -2 }),
      row({ page: 1.5 }),
    ])
    expect(byPage.size).toBe(0)
  })
})

describe('strokesByPage', () => {
  test('keeps the order they were drawn in, so later marks paint on top', () => {
    const a = row({ page: 2 })
    const b = row({ page: 2, mine: false })
    const c = row({ page: 2 })
    expect(
      strokesByPage([a, b, c])
        .get(1)
        ?.map((s) => s.id),
    ).toEqual([a.id, b.id, c.id])
  })

  test("your marks carry no colour; a colleague's carry theirs", () => {
    const mine = row({ page: 1, mine: true, authorColour: '#0A84FF' })
    const theirs = row({ page: 1, mine: false, authorColour: '#DC2626' })
    const departed = row({ page: 1, mine: false, authorColour: null })
    const [a, b, c] = strokesByPage([mine, theirs, departed]).get(0) ?? []
    expect(a).toEqual({
      id: mine.id,
      points: mine.points,
      mine: true,
      order: mine.createdAt,
    })
    expect(b.color).toBe('#DC2626')
    expect(b.mine).toBe(false)
    // No colour known: the viewer's one neutral colour, not a guess.
    expect(c).not.toHaveProperty('color')
  })

  /** Undo takes the mark of yours with the largest `order`: your newest,
   * wherever it is — so the order must be when it was made, not where it
   * sits in the list, which is by page. */
  test('each mark is ordered by when it was made, not by its page', () => {
    const late = row({ page: 1, createdAt: 900 })
    const early = row({ page: 4, createdAt: 100 })
    const byPage = strokesByPage([late, early])
    expect(byPage.get(0)?.[0].order).toBe(900)
    expect(byPage.get(3)?.[0].order).toBe(100)
  })
})

describe('strokeToSave', () => {
  test('drops points that are not real numbers', () => {
    const saved = strokeToSave(0, [
      { x: 0.1, y: 0.1 },
      { x: Number.NaN, y: 0.2 },
      { x: 0.3, y: Number.POSITIVE_INFINITY },
      { x: 0.4, y: 0.4 },
    ])
    expect(saved?.points).toEqual([
      { x: 0.1, y: 0.1 },
      { x: 0.4, y: 0.4 },
    ])
  })

  test('brings a stroke that ran off the page back inside what the server takes', () => {
    const saved = strokeToSave(0, [
      { x: -3, y: 0.5 },
      { x: 0.5, y: 9 },
    ])
    expect(saved?.points).toEqual([
      { x: MIN_COORDINATE, y: 0.5 },
      { x: 0.5, y: MAX_COORDINATE },
    ])
  })

  test('thins a very long stroke evenly, keeping where it began and ended', () => {
    const count = MAX_POINTS_PER_STROKE * 3 + 7
    const points = Array.from({ length: count }, (_, i) => ({
      x: i / count,
      y: 0.5,
    }))
    const saved = strokeToSave(0, points)
    expect(saved?.points).toHaveLength(MAX_POINTS_PER_STROKE)
    expect(saved?.points[0]).toEqual(points[0])
    expect(saved?.points.at(-1)).toEqual(points.at(-1))
  })

  test('a dot is a mark', () => {
    expect(strokeToSave(2, [{ x: 0.5, y: 0.5 }])).toEqual({
      page: 3,
      points: [{ x: 0.5, y: 0.5 }],
    })
  })

  test('nothing to save: no drawable point, or no such page', () => {
    expect(strokeToSave(0, [])).toBeNull()
    expect(strokeToSave(0, [{ x: Number.NaN, y: 0 }])).toBeNull()
    expect(strokeToSave(-1, [{ x: 0.5, y: 0.5 }])).toBeNull()
    expect(strokeToSave(MAX_MARKUP_PAGE, [{ x: 0.5, y: 0.5 }])).toBeNull()
    expect(strokeToSave(0.5, [{ x: 0.5, y: 0.5 }])).toBeNull()
  })
})

describe('createInFlight', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  test('a second caller joins the run the first one started', async () => {
    const share = createInFlight<string>()
    const run = deferred<string>()
    const start = vi.fn(() => run.promise)
    const first = share('report-1', start)
    const second = share('report-1', start)
    expect(start).toHaveBeenCalledTimes(1)
    run.resolve('https://files.example/a.pdf')
    await expect(first).resolves.toBe('https://files.example/a.pdf')
    await expect(second).resolves.toBe('https://files.example/a.pdf')
  })

  test('a caller after it settles starts afresh — after a failure too', async () => {
    const share = createInFlight<string>()
    const start = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('PDF_UNAVAILABLE'))
      .mockResolvedValueOnce('https://files.example/b.pdf')
    await expect(share('report-1', start)).rejects.toThrow('PDF_UNAVAILABLE')
    await expect(share('report-1', start)).resolves.toBe(
      'https://files.example/b.pdf',
    )
    expect(start).toHaveBeenCalledTimes(2)
  })

  test('other keys are other runs', () => {
    const share = createInFlight<string>()
    const start = vi.fn(() => new Promise<string>(() => {}))
    void share('report-1', start)
    void share('report-2', start)
    expect(start).toHaveBeenCalledTimes(2)
  })

  test('a start that throws is a rejection, and is not held', async () => {
    const share = createInFlight<string>()
    const start = vi.fn((): Promise<string> => {
      throw new Error('boom')
    })
    await expect(share('report-1', start)).rejects.toThrow('boom')
    await expect(share('report-1', start)).rejects.toThrow('boom')
    expect(start).toHaveBeenCalledTimes(2)
  })
})

describe('replacedBadge', () => {
  test('names the version that replaced it', () => {
    expect(replacedBadge(1)).toBe('Replaced by version 2')
    expect(replacedBadge(2)).toBe('Replaced by version 3')
    // Reports from before versions were numbered are version 1.
    expect(replacedBadge(undefined)).toBe('Replaced by version 2')
  })
})

describe('plain words', () => {
  test("the server's refusals, by code", () => {
    expect(reportPdfProblem(new ConvexError('PDF_UNAVAILABLE'), false)).toBe(
      'The PDF didn’t finish drawing. Try again in a moment.',
    )
    expect(reportPdfProblem(new ConvexError('NO_ACCESS'), false)).toMatch(
      /access/,
    )
    expect(
      reportPdfProblem(new ConvexError({ code: 'NOT_FOUND' }), false),
    ).toMatch(/deleted/)
    // As a plain error whose message names it.
    expect(
      reportPdfProblem(
        new Error(
          '[Request ID: x] Server Error Uncaught ConvexError: PDF_UNAVAILABLE',
        ),
        false,
      ),
    ).toMatch(/didn’t finish drawing/)
    expect(reportPdfProblem(new PdfProblem('NO_URL'), false)).toMatch(
      /didn’t finish drawing/,
    )
  })

  test('a failed download says why itself', () => {
    const error = new FileTransferError(
      'http',
      'The file is no longer there.',
      404,
    )
    expect(reportPdfProblem(error, false)).toBe('The file is no longer there.')
  })

  test('no signal, said as such', () => {
    expect(reportPdfProblem(new Error('whatever'), true)).toBe(
      'No signal. Try again when you have some.',
    )
    expect(reportPdfProblem(new TypeError('Failed to fetch'), false)).toBe(
      'No signal. Try again when you have some.',
    )
  })

  test('signed out, and anything else', () => {
    expect(reportPdfProblem(new ConvexError('UNAUTHENTICATED'), false)).toMatch(
      /signed out/,
    )
    expect(reportPdfProblem(new Error('something odd'), false)).toBe(
      'Something went wrong preparing it. Try again.',
    )
    expect(reportPdfProblem('not even an error', false)).toBe(
      'Something went wrong preparing it. Try again.',
    )
  })

  test("a preview's own reasons", () => {
    expect(previewProblem(new PdfProblem('SAVE_FAILED'), false)).toMatch(
      /haven’t saved/,
    )
    expect(previewProblem(new ConvexError('REPORT_FINALISED'), false)).toMatch(
      /locked/,
    )
    expect(previewProblem(new Error('odd'), false)).toBe(
      'Couldn’t draw the preview. Try again.',
    )
  })

  test('what the viewer’s own screen would tell truly — and what it would call signal wrongly', () => {
    // Signal: the one line the viewer shows for any failure is right.
    expect(isSignalProblem(new TypeError('Failed to fetch'), false)).toBe(true)
    expect(
      isSignalProblem(
        new Error('Connection lost while action was in flight'),
        false,
      ),
    ).toBe(true)
    expect(isSignalProblem(new Error('whatever'), true)).toBe(true)
    expect(
      isSignalProblem(
        new FileTransferError('network', 'The download stopped arriving.'),
        false,
      ),
    ).toBe(true)

    // Not signal, whatever the phone says about its connection: the server
    // answered, or the file is gone.
    for (const offline of [false, true]) {
      expect(isSignalProblem(new PdfProblem('SAVE_FAILED'), offline)).toBe(
        false,
      )
      expect(
        isSignalProblem(new ConvexError('REPORT_FINALISED'), offline),
      ).toBe(false)
      expect(
        isSignalProblem(new ConvexError({ code: 'NO_ACCESS' }), offline),
      ).toBe(false)
      expect(
        isSignalProblem(
          new Error(
            '[Request ID: x] Server Error Uncaught ConvexError: NOT_FOUND',
          ),
          offline,
        ),
      ).toBe(false)
      expect(
        isSignalProblem(new Error('[Request ID: y] Server Error'), offline),
      ).toBe(false)
      expect(
        isSignalProblem(
          new FileTransferError('http', 'The file is no longer there.', 404),
          offline,
        ),
      ).toBe(false)
    }
    expect(isSignalProblem(new Error('something odd'), false)).toBe(false)
  })

  test('answers that would not save are not blamed on the signal', () => {
    expect(previewProblem(new PdfProblem('SAVE_FAILED'), false)).not.toMatch(
      /signal/,
    )
  })

  test("a mark's, with words for what was being done", () => {
    expect(
      markupProblem(new ConvexError('TOO_MANY_STROKES'), false, 'add'),
    ).toMatch(/full of marks/)
    expect(markupProblem(new Error('odd'), false, 'add')).toBe(
      'Your mark didn’t save. Try again.',
    )
    expect(markupProblem(new Error('odd'), false, 'undo')).toBe(
      'Couldn’t undo your last mark. Try again.',
    )
    expect(markupProblem(new Error('odd'), false, 'clear')).toBe(
      'Couldn’t clear your marks. Try again.',
    )
  })
})
