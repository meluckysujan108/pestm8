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
import { NO_LOCAL_MARKS, hasOwnMarks, sync, visibleStrokes } from './localMarks'
import { createMarkupSession } from './markupSession'
import { byPage, nextFallback } from './pendingMarks'
import type { ClearConfirm } from './clearConfirm'
import type { LocalMarks } from './localMarks'
import type { ViewerMarkup } from './types'

/**
 * Markup mode, from the viewer's side of the `ViewerMarkup` contract: whether
 * the pen is out, the strokes still saving, and Undo and Clear — each of which
 * acts the moment it is tapped (the rules are `localMarks.ts`'s, run by
 * `markupSession.ts`; this holds them in React). Undo chooses its mark then,
 * hides it, and names it to the caller by id once it has one; Clear hides the
 * page's marks and hands the clear straight over. Nothing waits for strokes
 * still saving, so nothing drawn after a tap can be caught up in it.
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

  // ---- Ahead of the caller's marks ------------------------------------------

  // State to draw from, and a ref that is always the latest: a tap acts on
  // what the tap before it did, not on the last render. Two Undos inside one
  // frame must each see the other's mark already gone, or both would take
  // the same one.
  const [local, setLocal] = useState<LocalMarks>(NO_LOCAL_MARKS)
  const localRef = useRef(local)
  const commit = useCallback((next: LocalMarks) => {
    if (next === localRef.current) return
    localRef.current = next
    setLocal(next)
  }, [])

  const strokes = markup?.strokes
  const strokesRef = useRef(strokes)
  // Before paint, so a saved stroke's twin and the new marks swap in one
  // frame. The ref first: a tap, or a save coming back, reads it.
  useLayoutEffect(() => {
    strokesRef.current = strokes
    commit(sync(localRef.current, strokes, performance.now()))
  }, [strokes, commit])

  // A save whose marks never visibly arrive is let go after a while anyway.
  const { pending } = local
  useEffect(() => {
    const due = nextFallback(pending)
    if (due === null) return
    const timer = window.setTimeout(
      () =>
        commit(sync(localRef.current, strokesRef.current, performance.now())),
      Math.max(0, due - performance.now()) + 16,
    )
    return () => window.clearTimeout(timer)
  }, [pending, commit])

  const [session] = useState(() =>
    createMarkupSession({
      markup: () => markupRef.current,
      strokes: () => strokesRef.current,
      read: () => localRef.current,
      commit: (next, urgent) => {
        if (urgent) flushSync(() => commit(next))
        else commit(next)
      },
      toast: (message) => toastRef.current(message),
      now: () => performance.now(),
    }),
  )
  const onStroke = session.stroke

  // A Clear asked for in a viewer since closed (Done, then open the document
  // again, the Clear still waiting on one bar of signal) is still out, and
  // its page's marks still stored until it lands. Taken over before the
  // first paint that could show them — and looked for again whenever the
  // caller changes, so a markup layer that arrives after the viewer opens
  // is asked too. Each Clear is taken over once; this session's own never.
  useLayoutEffect(() => {
    const underway = markup?.clearsUnderway?.()
    if (underway && underway.length > 0) session.takeOver(underway)
  }, [markup, session])

  // ---- Undo and Clear ------------------------------------------------------

  const onUndo = useCallback(() => {
    setConfirm(null)
    session.undo()
  }, [session])

  const onClear = useCallback(() => {
    if (!markupRef.current) return
    const tap = tapClear(confirm, page, performance.now())
    setConfirm(tap.confirm)
    if (tap.clear) session.clear(page)
  }, [confirm, page, session])

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

  // ---- What to draw ----------------------------------------------------------

  // A new Map only when the marks, or what is being taken from them, change:
  // the page slots are memoised on it.
  const shown = useMemo(
    () => (strokes ? visibleStrokes(strokes, local) : undefined),
    [strokes, local],
  )
  const pendingByPage = useMemo(() => byPage(pending), [pending])
  const canUndo = useMemo(() => hasOwnMarks(local, strokes), [local, strokes])
  const mineOnPage = useMemo(
    () => hasOwnMarks(local, strokes, page),
    [local, strokes, page],
  )
  const hasMarks = pendingByPage.size > 0 || anyStrokes(shown)

  return {
    /** The pen is available at all: the Markup button is drawn. */
    canDraw,
    open,
    setOpen,
    /** The caller's marks as they should be drawn now: without those an Undo
     * or a Clear is taking away. Undefined with no markup layer. */
    strokes: shown,
    onStroke,
    pendingByPage,
    /** You have a mark showing, saved or still saving: Undo is enabled. */
    canUndo,
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

function anyStrokes(strokes: ViewerMarkup['strokes'] | undefined): boolean {
  if (!strokes) return false
  for (const onPage of strokes.values()) if (onPage.length > 0) return true
  return false
}
