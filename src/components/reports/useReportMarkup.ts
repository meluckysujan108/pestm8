import { useLayoutEffect, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { strokesByPage } from './reportPdfModel'
import { reportMarkupQueue } from './markupQueue'
import type { MarkupStroke, ViewerMarkup } from '#/components/pdf/types'
import type { MarkupServer } from './markupQueue'
import type { Id } from '../../../convex/_generated/dataModel'

/** The user's words (2026-09-24), said in the markup palette. */
export const MARKUP_NOTE =
  'Marks are for your team. Share sends the report without them.'
/** Said once when a report with marks is shared. */
export const MARKUP_SHARE_NOTE =
  'Sent without the marks — they stay in the app for your team.'
/** Said once when a report with marks is saved or downloaded. */
export const MARKUP_SAVE_NOTE =
  'Saved without the marks — they stay in the app for your team.'

const NO_STROKES: ReadonlyMap<number, ReadonlyArray<MarkupStroke>> = new Map()

/**
 * A report's marks, as the viewer's markup layer (`ViewerMarkup`): every
 * stroke on every page from one subscription, and the pen that adds to them.
 *
 * ── Who sees the pen ──────────────────────────────────────────────────────
 *
 * Marks are read and written as the REAL person (`reportAnnotations.ts`),
 * which is narrower than the report itself: someone looking through another
 * account can open the report but has no pen in it, and the query refuses
 * them. Undefined then — no marks and no pen — and undefined while the marks
 * are still on their way, so the pen never appears before the marks it would
 * draw over, and never as a tool that fails on its first stroke.
 *
 * ── Nothing here is optimistic ────────────────────────────────────────────
 *
 * The viewer keeps a stroke on screen while it saves, and hides a mark while
 * Undo or Clear takes it; this only asks the server. A mark is the server's
 * once the mutation resolves — Convex resolves it after this client's
 * queries have caught up with it — so `strokes` then agrees with the screen
 * and the viewer lets its own copy go.
 *
 * Undo is aimed by the viewer, at the tap, and arrives here as one mark's id
 * (`removeStroke`); each mark's `order` is when it was made (`createdAt`),
 * which is how the viewer knows your newest. Saves and Clear go through one
 * queue (`markupQueue.ts`), so a Clear sweeps up every stroke drawn before it
 * was tapped and none drawn after — one queue per report rather than per
 * viewer, so that still holds when the PDF is closed and opened again while
 * the Clear is out.
 */
export function useReportMarkup({
  businessId,
  reportId,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
}): ViewerMarkup | undefined {
  const list = useMemo(
    () =>
      convexQuery(api.reportAnnotations.listForReport, {
        businessId,
        reportId,
      }),
    [businessId, reportId],
  )
  const { data, isError } = useQuery({
    ...list,
    // A refusal is the answer (someone with no pen here), not a blip: a
    // Convex query waits out a lost connection rather than failing, so a
    // retry would only keep the pen hidden for longer before deciding.
    retry: false,
  })

  const add = useConvexMutation(api.reportAnnotations.addStroke)
  const remove = useConvexMutation(api.reportAnnotations.removeStroke)
  const clearMine = useConvexMutation(api.reportAnnotations.clearMyStrokes)
  const latest = useRef({ add, remove, clearMine })
  useLayoutEffect(() => {
    latest.current = { add, remove, clearMine }
  })

  // One queue per report, which holds the order of what has been asked for.
  // Not this hook's to keep: this is mounted with the viewer, made again
  // each time the PDF is opened, and a queue made with it forgot a Clear
  // still waiting when it closed — the reopened viewer's next stroke went
  // out ahead of it and was swept away when it landed. The report's queue
  // is held outside React while it has anything out (`reportMarkupQueue`),
  // so the reopened viewer's strokes wait behind that Clear, and the viewer
  // takes the Clear over (`clearsUnderway`) to keep its page hidden.
  const queue = useMemo(() => {
    const server: MarkupServer = {
      add: (page, points) =>
        latest.current.add({ businessId, reportId, page, points }),
      remove: (strokeId) =>
        latest.current.remove({
          businessId,
          reportId,
          // One of this report's own ids: the viewer only names marks this
          // hook handed it (`strokesByPage`) or an `add` resolved with.
          strokeId: strokeId as Id<'reportPdfAnnotations'>,
        }),
      clearMine: (page) =>
        latest.current.clearMine({ businessId, reportId, page }),
    }
    return reportMarkupQueue(`${businessId}/${reportId}`, server)
  }, [businessId, reportId])

  // A new Map only when the marks change: the viewer memoises its page
  // slots on it.
  const strokes = useMemo(
    () => (data ? strokesByPage(data) : NO_STROKES),
    [data],
  )

  return useMemo(() => {
    if (isError || data === undefined) return undefined
    return {
      strokes,
      canDraw: true,
      ...queue,
      note: MARKUP_NOTE,
      shareNote: MARKUP_SHARE_NOTE,
      saveNote: MARKUP_SAVE_NOTE,
    }
  }, [isError, data, strokes, queue])
}
