import {
  PdfProblem,
  markupProblem,
  phoneIsOffline,
  storedPageOf,
  strokeToSave,
} from './reportPdfModel'
import type { MarkupPoint, ViewerMarkup } from '#/components/pdf/types'

/**
 * What the queue asks of Convex. Pages are stored pages (from 1): the queue
 * turns the viewer's 0-based slots into them, so nothing else has to.
 */
export type MarkupServer = {
  /** Resolves with the new mark's id (`reportAnnotations.addStroke`). */
  add: (page: number, points: Array<MarkupPoint>) => Promise<string>
  /** One of your marks, by id (`reportAnnotations.removeStroke`). */
  remove: (strokeId: string) => Promise<unknown>
  clearMine: (page: number) => Promise<unknown>
}

export type MarkupQueue = Pick<
  ViewerMarkup,
  'addStroke' | 'removeStroke' | 'clearPage'
>

const ignore = () => {}

/**
 * The pen's saves, Undo's removals and Clear for one report, as the viewer
 * hands them over. Everything rejects with words for the viewer to show
 * (`markupProblem`).
 *
 * ── Undo needs no ordering ────────────────────────────────────────────────
 *
 * The viewer chooses the mark when Undo is tapped and names it by id, and it
 * names a stroke only once that stroke's save has come back — so the add has
 * always landed before its removal is sent, and nothing sent around the
 * removal can change which mark it takes. It goes straight out. (It once
 * asked the server for "my newest mark on page 3", which a stroke drawn
 * while the Undo waited could answer: that stroke was the one removed.)
 *
 * ── Clear does ────────────────────────────────────────────────────────────
 *
 * The server's clear takes all of your marks on the page, whenever they
 * arrived — and the viewer hands Clear over at the tap, strokes still saving
 * or not (`ViewerMarkup.clearPage`), trusting this queue to keep the order
 * the person saw:
 *
 * - A stroke drawn before the tap is cleared by it: the clear waits for every
 *   save already asked for, whichever way each goes. Sent at once instead, it
 *   could land first and leave the mark behind, stored, after the page
 *   emptied on screen.
 * - A stroke drawn after the tap survives it: its save waits for the clear to
 *   settle before it is sent. Sent at once, it could land first and be swept
 *   away with the page.
 *
 * Strokes with no clear ahead of them go at once, side by side — the pen is
 * never slowed by its own saves. Convex already delivers one client's
 * mutations in the order they are sent; this only makes "sent" happen in the
 * order they were asked for.
 */
export function createMarkupQueue(server: MarkupServer): MarkupQueue {
  const saving = new Set<Promise<unknown>>()
  // Settles, either way, once the last Clear asked for has.
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
    try {
      return await run
    } catch (error) {
      throw new Error(markupProblem(error, phoneIsOffline(), 'add'), {
        cause: error,
      })
    } finally {
      saving.delete(run)
    }
  }

  const removeStroke = async (strokeId: string) => {
    try {
      await server.remove(strokeId)
    } catch (error) {
      throw new Error(markupProblem(error, phoneIsOffline(), 'undo'), {
        cause: error,
      })
    }
  }

  const clearPage = (pageIndex: number): Promise<void> => {
    // Read now, at the call: the saves asked for before it, and any clear.
    const ahead = Promise.allSettled([barrier, ...saving])
    const run = ahead.then(() => server.clearMine(storedPageOf(pageIndex)))
    barrier = run.then(ignore, ignore)
    return run.then(ignore, (error: unknown) => {
      throw new Error(markupProblem(error, phoneIsOffline(), 'clear'), {
        cause: error,
      })
    })
  }

  return { addStroke, removeStroke, clearPage }
}
