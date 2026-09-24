import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import { CLEAR_CONFIRM_MS, tapClear } from './clearConfirm'
import { MarkupSaves } from './markupSaves'
import {
  byPage,
  dropMark,
  markSaved,
  nextFallback,
  reconcile,
} from './pendingMarks'
import type { ClearConfirm } from './clearConfirm'
import type { PendingMark } from './pendingMarks'
import type { MarkupPoint, ViewerMarkup } from './types'

/**
 * Markup mode, from the viewer's side of the `ViewerMarkup` contract: whether
 * the pen is out, the strokes still saving, and Undo and Clear — each of which
 * waits for any stroke still on its way to the server, so that Undo takes back
 * the stroke just drawn rather than the one before it (and nothing at all if
 * that stroke never saved), and Clear takes that one too (`markupSaves.ts`).
 *
 * Whether someone may draw, and whose marks are whose, is the caller's to say
 * and the server's to enforce; this only keeps the screen honest while the
 * answers travel.
 */
export function useMarkupSession(
  markup: ViewerMarkup | undefined,
  {
    ready,
    appZoomed,
    page,
    showToast,
  }: {
    /** The document is open: there are pages to draw on. */
    ready: boolean
    /** The app itself is pinch-zoomed (`pageZoom.ts`). */
    appZoomed: boolean
    /** The page being read, 0-based: the one Clear clears. */
    page: number
    showToast: (message: string) => void
  },
) {
  // The button is there (disabled) while the document opens, so the toolbar
  // does not rearrange itself under a thumb the moment it does.
  const canDraw = !!markup?.canDraw && !appZoomed
  const [modeOn, setModeOn] = useState(false)
  const [pending, setPending] = useState<ReadonlyArray<PendingMark>>([])
  const [confirm, setConfirm] = useState<ClearConfirm>(null)

  // The pen goes away with the right to use it — the caller's marks failing
  // to load, say, or the app zoomed — or with the pages (a reload), and does
  // not come back by itself.
  if (modeOn && !(canDraw && ready)) {
    setModeOn(false)
    setConfirm(null)
  }
  const open = modeOn && canDraw && ready

  const markupRef = useRef(markup)
  const toastRef = useRef(showToast)
  useLayoutEffect(() => {
    markupRef.current = markup
    toastRef.current = showToast
  })

  // ---- Strokes still saving ------------------------------------------------

  const strokes = markup?.strokes
  const strokesRef = useRef(strokes)
  // Before paint, so a saved stroke's twin and the new marks swap in one
  // frame. The ref first: a save coming back later compares against it.
  useLayoutEffect(() => {
    strokesRef.current = strokes
    setPending((list) => reconcile(list, strokes, performance.now()))
  }, [strokes])

  // A save whose marks never visibly arrive is let go after a while anyway.
  useEffect(() => {
    const due = nextFallback(pending)
    if (due === null) return
    const timer = window.setTimeout(
      () =>
        setPending((list) =>
          reconcile(list, strokesRef.current, performance.now()),
        ),
      Math.max(0, due - performance.now()) + 16,
    )
    return () => window.clearTimeout(timer)
  }, [pending])

  const [saves] = useState(() => new MarkupSaves())
  const counter = useRef(0)

  const onStroke = useCallback(
    (index: number, points: Array<MarkupPoint>) => {
      const current = markupRef.current
      if (!current) return
      const key = `pending-${++counter.current}`
      // Synchronously: the pen clears its live line the moment this returns.
      flushSync(() =>
        setPending((list) => [
          ...list,
          { key, page: index, points, saved: null },
        ]),
      )
      let save: Promise<unknown>
      try {
        save = Promise.resolve(current.addStroke(index, points.slice()))
      } catch (error) {
        save = Promise.reject(error)
      }
      saves.add(
        save.then(
          // The contract promises nothing back; a caller that does hand back
          // the new stroke's id lets its stand-in go the moment that id is
          // drawn.
          (result: unknown) => {
            const id = typeof result === 'string' ? result : null
            setPending((list) =>
              markSaved(list, key, strokesRef.current, performance.now(), id),
            )
            return true
          },
          (error: unknown) => {
            setPending((list) => dropMark(list, key))
            toastRef.current(wordsFor(error, "Your mark didn't save."))
            return false
          },
        ),
      )
    },
    [saves],
  )

  // ---- Undo and Clear ------------------------------------------------------

  const pendingByPage = useMemo(() => byPage(pending), [pending])

  const undo = markup?.undo ?? null
  const onUndo = useCallback(() => {
    if (!undo) return
    setConfirm(null)
    // Spent, rather than undone, when the stroke it was aimed at failed to
    // save: that already said so, and there is nothing more to take back.
    saves.undo(undo).catch((error: unknown) => {
      toastRef.current(wordsFor(error, "Couldn't undo your last mark."))
    })
  }, [undo, saves])

  const mineOnPage =
    !!markup?.strokes.get(page)?.some((stroke) => stroke.mine) ||
    !!pendingByPage.get(page)?.length

  const onClear = useCallback(() => {
    const current = markupRef.current
    if (!current) return
    const tap = tapClear(confirm, page, performance.now())
    setConfirm(tap.confirm)
    if (!tap.clear) return
    saves
      .clear(() => current.clearPage(page))
      .catch((error: unknown) => {
        toastRef.current(
          wordsFor(error, `Couldn't clear your marks on page ${page + 1}.`),
        )
      })
  }, [confirm, page, saves])

  // "Tap again to clear page 3" reverts by itself if the second tap never
  // comes.
  useEffect(() => {
    if (!confirm) return
    const timer = window.setTimeout(
      () => setConfirm(null),
      Math.max(0, confirm.at + CLEAR_CONFIRM_MS - performance.now()),
    )
    return () => window.clearTimeout(timer)
  }, [confirm])

  // ---- Mode ------------------------------------------------------------------

  const setOpen = useCallback((next: boolean) => {
    setModeOn(next)
    setConfirm(null)
  }, [])

  const hasMarks = pending.length > 0 || anyStrokes(markup?.strokes)

  return {
    /** The pen is available at all: the Markup button is drawn. */
    canDraw,
    open,
    setOpen,
    onStroke,
    pendingByPage,
    canUndo: undo !== null,
    onUndo,
    /** You have marks on the page being read: Clear is enabled. */
    canClear: mineOnPage,
    /** Clear is waiting on a second tap for the page being read. */
    clearArmed: confirm?.page === page,
    onClear,
    /** Any page has marks, anyone's: Share and Save say they are left out. */
    hasMarks,
  }
}

/**
 * What to say when a save, an undo or a clear fails: the caller's own words
 * when it rejected with some — it knows why ("This report is full of marks"),
 * and that is worth more than "didn't save" to someone about to try again —
 * and the viewer's otherwise.
 */
function wordsFor(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== ''
    ? error.message
    : fallback
}

function anyStrokes(strokes: ViewerMarkup['strokes'] | undefined): boolean {
  if (!strokes) return false
  for (const onPage of strokes.values()) if (onPage.length > 0) return true
  return false
}
