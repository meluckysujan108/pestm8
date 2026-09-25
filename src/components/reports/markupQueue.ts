import {
  PdfProblem,
  markupProblem,
  phoneIsOffline,
  storedPageOf,
  strokeToSave,
} from './reportPdfModel'
import type {
  ClearUnderway,
  MarkupPoint,
  ViewerMarkup,
} from '#/components/pdf/types'

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

export type MarkupQueue = Required<
  Pick<
    ViewerMarkup,
    'addStroke' | 'removeStroke' | 'clearPage' | 'clearsUnderway'
  >
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
 *
 * A Clear stays on `clearsUnderway` until it settles, for a viewer opened
 * while it is out to take over (`reportMarkupQueue`, below).
 */
export function createMarkupQueue(
  server: MarkupServer,
  /**
   * Told when the queue first has something out — a save or a Clear asked
   * for and not yet settled — and when it has nothing out again.
   */
  watch: { busy?: () => void; idle?: () => void } = {},
): MarkupQueue {
  const saving = new Set<Promise<unknown>>()
  // Settles, either way, once the last Clear asked for has.
  let barrier: Promise<void> = Promise.resolve()
  const underway = new Set<ClearUnderway>()
  // Saves and Clears asked for and not yet settled.
  let out = 0
  const started = () => {
    out += 1
    if (out === 1) watch.busy?.()
  }
  const settled = () => {
    out -= 1
    if (out === 0) watch.idle?.()
  }

  const addStroke = async (pageIndex: number, points: Array<MarkupPoint>) => {
    const stroke = strokeToSave(pageIndex, points)
    if (!stroke) {
      throw new Error(
        markupProblem(new PdfProblem('INVALID_STROKE'), false, 'add'),
      )
    }
    started()
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
      settled()
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
    started()
    const run = ahead.then(() => server.clearMine(storedPageOf(pageIndex)))
    barrier = run.then(ignore, ignore)
    const done = run.then(ignore, (error: unknown) => {
      throw new Error(markupProblem(error, phoneIsOffline(), 'clear'), {
        cause: error,
      })
    })
    const clear: ClearUnderway = { pageIndex, done }
    underway.add(clear)
    // Off the list as the clear settles, before anyone waiting on `done`
    // hears how it went: whoever looks again then finds it gone, so a viewer
    // never takes over a Clear that has already landed.
    const release = () => {
      underway.delete(clear)
      settled()
    }
    void run.then(release, release)
    return done
  }

  const clearsUnderway = () => [...underway]

  return { addStroke, removeStroke, clearPage, clearsUnderway }
}

/**
 * Each report's queue while it has anything out — a save not yet back, a
 * Clear not yet landed — kept here, for as long as the app is open, rather
 * than in the viewer.
 *
 * The viewer is made again each time the PDF is opened (Done, then View
 * PDF), and a queue made with it was new with it. Closed and opened again
 * while a Clear still waited on a save, on one bar of signal, the new queue
 * knew nothing of that Clear: a stroke drawn in the reopened viewer went
 * straight out, landed first, and was swept away with the page when the
 * Clear did — no toast, since nothing had failed. And the reopened viewer
 * showed the marks the Clear was taking, as if it had never been tapped.
 *
 * Held here, the reopened viewer's strokes wait behind that Clear as they
 * would have in the viewer that asked for it, and the viewer takes the
 * Clear over as it opens (`clearsUnderway`), keeping the page's marks
 * hidden until it lands. Let go once nothing is out, when a new queue
 * would be no different: an idle one holds no order to keep.
 */
type HeldQueue = { queue: MarkupQueue; server: MarkupServer }
const held = new Map<string, HeldQueue>()

/**
 * The queue for one report, shared by every viewer opened on it: `key` names
 * the report (business and report ids), and `server` is this viewer's way
 * to Convex.
 *
 * What comes back finds the report's queue at each call rather than holding
 * one, so the queue can be let go when idle and made again when next used.
 * Whatever is sent next is sent through the latest viewer's `server`.
 */
export function reportMarkupQueue(
  key: string,
  server: MarkupServer,
): MarkupQueue {
  const current = (): MarkupQueue => {
    const kept = held.get(key)
    if (kept) {
      kept.server = server
      return kept.queue
    }
    // Held only once it has something out (`busy`) — an Undo, which keeps
    // no order, or a stroke refused before it is sent, never holds it.
    const fresh: HeldQueue = {
      server,
      queue: createMarkupQueue(
        {
          add: (page, points) => fresh.server.add(page, points),
          remove: (strokeId) => fresh.server.remove(strokeId),
          clearMine: (page) => fresh.server.clearMine(page),
        },
        {
          busy: () => held.set(key, fresh),
          idle: () => {
            if (held.get(key) === fresh) held.delete(key)
          },
        },
      ),
    }
    return fresh.queue
  }
  return {
    addStroke: (pageIndex, points) => current().addStroke(pageIndex, points),
    removeStroke: (strokeId) => current().removeStroke(strokeId),
    clearPage: (pageIndex) => current().clearPage(pageIndex),
    clearsUnderway: () => held.get(key)?.queue.clearsUnderway() ?? [],
  }
}

/** How many reports' queues are held: for tests that they are let go. */
export function heldMarkupQueues(): number {
  return held.size
}
