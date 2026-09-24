import {
  PdfProblem,
  markupProblem,
  phoneIsOffline,
  storedPageOf,
  strokeToSave,
  undoTargetPage,
} from './reportPdfModel'
import type { MarkupPoint } from '#/components/pdf/types'
import type { AnnotationRow } from './reportPdfModel'

/**
 * What the queue asks of Convex. Pages are stored pages (from 1): the queue
 * turns the viewer's 0-based slots into them, so nothing else has to.
 */
export type MarkupServer = {
  /**
   * The marks as this client holds them now. Read at the moment an Undo runs,
   * which is after everything asked for before it has come back — and a
   * Convex mutation comes back only once this client's queries include it.
   */
  rows: () => ReadonlyArray<AnnotationRow>
  add: (page: number, points: Array<MarkupPoint>) => Promise<unknown>
  undoLast: (page: number) => Promise<unknown>
  clearMine: (page: number) => Promise<unknown>
}

export type MarkupQueue = {
  addStroke: (pageIndex: number, points: Array<MarkupPoint>) => Promise<void>
  undo: () => Promise<void>
  clearPage: (pageIndex: number) => Promise<void>
}

const ignore = () => {}

/**
 * The pen's saves, Undo and Clear for one report, reaching the server in the
 * order they were tapped. Everything rejects with words for the viewer to
 * show (`markupProblem`).
 *
 * ── Why a queue ───────────────────────────────────────────────────────────
 *
 * The server's undo works a page at a time: it takes your newest mark on the
 * page it is given. "Your newest mark anywhere" is decided here, from the
 * marks this client holds — and those are only up to date once whatever came
 * before has come back. Two Undo taps a moment apart on one bar of signal
 * both read the same list, and without a queue both name the same page: the
 * first takes the mark you meant, the second takes an older one on that page
 * (yesterday's, perhaps) instead of your next-newest on another, and there is
 * no redo. Clear then Undo was the same race — the Undo aimed at the page
 * being cleared, found nothing left there, and the tap was lost.
 *
 * So an Undo or a Clear waits its turn: for every stroke already saving and
 * every Undo or Clear before it, whichever way each went. And a stroke drawn
 * after an Undo or a Clear waits for that before it is sent, so that a mark
 * drawn straight after "Clear page 3" is not swept away by it, and a mark
 * drawn while an Undo waits is not the one the Undo takes. Strokes with
 * nothing ahead of them go at once, side by side — the pen is never slowed
 * by its own saves.
 *
 * Convex already delivers one client's mutations in the order they are sent;
 * this only makes "sent" happen in the order they were asked for, with each
 * Undo choosing its page after the one before it has landed.
 */
export function createMarkupQueue(
  server: MarkupServer,
  /** How many strokes are on their way: one still saving already offers Undo. */
  onSaving: (count: number) => void = ignore,
): MarkupQueue {
  const saving = new Set<Promise<unknown>>()
  // Settles, either way, once the last Undo or Clear asked for has.
  let barrier: Promise<void> = Promise.resolve()

  const addStroke = async (pageIndex: number, points: Array<MarkupPoint>) => {
    const stroke = strokeToSave(pageIndex, points)
    if (!stroke) {
      throw new Error(
        markupProblem(new PdfProblem('INVALID_STROKE'), false, 'add'),
      )
    }
    const run = barrier.then(() => server.add(stroke.page, stroke.points))
    saving.add(run)
    onSaving(saving.size)
    try {
      await run
    } catch (error) {
      throw new Error(markupProblem(error, phoneIsOffline(), 'add'), {
        cause: error,
      })
    } finally {
      saving.delete(run)
      onSaving(saving.size)
    }
  }

  /** Runs `act` once everything asked for before it has settled, and holds
   * back every stroke, Undo and Clear asked for after it until it has. */
  const inTurn = (
    act: () => Promise<unknown>,
    action: 'undo' | 'clear',
  ): Promise<void> => {
    const run = Promise.allSettled([barrier, ...saving]).then(act)
    barrier = run.then(ignore, ignore)
    return run.then(ignore, (error: unknown) => {
      throw new Error(markupProblem(error, phoneIsOffline(), action), {
        cause: error,
      })
    })
  }

  const undo = () =>
    inTurn(async () => {
      const page = undoTargetPage(server.rows())
      if (page !== null) await server.undoLast(page)
    }, 'undo')

  const clearPage = (pageIndex: number) =>
    inTurn(() => server.clearMine(storedPageOf(pageIndex)), 'clear')

  return { addStroke, undo, clearPage }
}
