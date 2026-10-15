import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { LoaderCircle } from 'lucide-react'
import { observeNear, scrollRootOf } from '#/lib/observeNear'
import { useOnline } from '#/lib/online'
import { useHydrated } from '#/lib/useHydrated'
import { SECONDARY_BUTTON_COMPACT } from './buttons'

/**
 * The end of a long list: the next page loads as the end comes near, and a
 * "Show more" button is always there for whoever gets to it first.
 *
 * Why both. Loading on its own is what a phone's lists do, and on a job
 * someone scrolling for last week's visit should not have to find and tap a
 * button every 24 cards. But a list that only loads itself is a list whose
 * footer can never be reached, and that cannot be driven from a keyboard or a
 * screen reader; and it can stall where the browser has no
 * IntersectionObserver. So the button is the way that always works, and
 * loading itself is the way that usually does.
 *
 * It stops loading on its own after eight pages (192 jobs, 240 clients) and
 * leaves the button: past that, someone is looking for something, and search
 * is the faster way to it. A tap on the button starts another eight. With no
 * signal it does not try at all; the button still asks, and the list waits
 * for signal like everything else.
 *
 * The rows it loads are the caller's to draw — bones as `CardCells` inside
 * the list's own grid while `loading` — and this is the sentinel, the button
 * and what a screen reader hears: "Loading more jobs" while a page is
 * coming, then how many are showing once it has landed.
 */

/** How many pages a list loads by itself before only the button does. */
export const AUTO_LOAD_PAGES = 8

export function LoadMore({
  canLoadMore,
  loading,
  onLoadMore,
  noun,
  shown,
  auto = true,
  resetKey = '',
  announce = true,
  className = 'mt-3',
}: {
  canLoadMore: boolean
  loading: boolean
  onLoadMore: () => void
  /** What is listed, plural: "jobs", "clients", "reports", "notes". */
  noun: string
  /** How many are showing, said once a load lands. */
  shown: number
  /** Load as the end comes near (the default), or only when tapped. */
  auto?: boolean
  /** Changes when the list starts over — a new search, filter or status. */
  resetKey?: string
  /** False inside a sheet, whose `status` region means something else. */
  announce?: boolean
  /** Where it sits: `mt-3` under a list of cards unless told otherwise. */
  className?: string
}) {
  const hydrated = useHydrated()
  const online = useOnline()
  const sentinel = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const count = useRef<HTMLDivElement>(null)
  // Whether the button had the focus as of this render — read before a
  // commit can remove it (below).
  const hadFocus = useRef(false)
  // Pages loaded by itself since the list started over or the button was
  // tapped. A ref: it decides, but nothing is drawn from it.
  const autoLoads = useRef(0)
  // How many were showing when a load was asked for, until it lands.
  const asked = useRef<number | null>(null)
  const [said, setSaid] = useState('')

  // Effects run in the order written, so a new list is reset here before
  // anything below looks at it.
  useEffect(() => {
    autoLoads.current = 0
    asked.current = null
    setSaid('')
  }, [resetKey])

  /**
   * Once a load this asked for has landed, say how many are showing — and
   * only then. Not on every change to `shown`: a search reveals afresh on
   * each keystroke and a live list changes under its reader, and a count
   * read out at every one is noise.
   */
  useEffect(() => {
    if (asked.current === null || loading) return
    if (shown !== asked.current) {
      setSaid(`${shown} ${shown === 1 ? noun.replace(/s$/, '') : noun} showing`)
    }
    // Landed, with rows or (an empty page) without: either way nothing is
    // waiting now.
    asked.current = null
  }, [shown, loading, noun])

  const request = (byHand: boolean) => {
    autoLoads.current = byHand ? 0 : autoLoads.current + 1
    asked.current = shown
    onLoadMore()
  }

  const nearEnd = useEffectEvent((near: boolean) => {
    if (!near || !canLoadMore || loading || !online) return
    if (autoLoads.current >= AUTO_LOAD_PAGES) return
    request(false)
  })

  /**
   * Watched afresh whenever the list moves on: a new page, a load finishing,
   * the signal back. An IntersectionObserver speaks only when the sentinel
   * crosses the margin, and a page of cards that lands without pushing it
   * back out (three columns on a wide screen, or a short page) crosses
   * nothing, so the list would sit there until someone scrolled. Watching
   * again makes the observer say where the sentinel is now.
   *
   * The scroll container is looked up each time, too: the same list scrolls
   * in a column on a computer and with the window on a phone
   * (`scrollRootOf`).
   */
  useEffect(() => {
    const el = sentinel.current
    if (!el || !hydrated || !auto || !canLoadMore || loading || !online) return
    return observeNear(el, nearEnd, { root: scrollRootOf(el) })
  }, [hydrated, auto, canLoadMore, loading, online, shown, resetKey])

  const showing = canLoadMore || loading

  // The load that reaches the end of the list takes the button away while
  // whoever pressed it still has it focused, and focus would fall to the
  // top of the document — the very thing aria-disabled is there to prevent.
  // So the focus moves to the count instead, which also reads it out.
  // Recorded while rendering, in the browser: a removed node's blur is not
  // something every browser fires.
  if (typeof document !== 'undefined') {
    hadFocus.current =
      button.current !== null && button.current === document.activeElement
  }
  useLayoutEffect(() => {
    if (showing || !hadFocus.current) return
    hadFocus.current = false
    const active = document.activeElement
    if (active === null || active === document.body) count.current?.focus()
  }, [showing])

  return (
    <>
      {/* A plain live region, never role=status: the page's status regions
          are its placeholders, and the end-to-end suite counts them. Always
          in the page, empty until a load lands: a region added with its
          words already in it is not reliably read, so the one after the
          last page is said by this same node. Focusable from script only,
          for when the button goes (above). */}
      <div ref={count} tabIndex={-1} aria-live="polite" className="sr-only">
        {said}
      </div>
      {showing && (
        <div className={className}>
          {/* Always rendered, in the server's HTML too: whether the browser
              can watch it is only known after hydration, and a sentinel
              that appeared then would be a page that differed from its
              HTML. */}
          <div ref={sentinel} aria-hidden className="h-px" />
          <button
            ref={button}
            type="button"
            // Disabled until hydrated, so a tap is never swallowed by inert
            // markup. While a page is coming it is aria-disabled instead,
            // not disabled: a disabled button drops the focus of whoever
            // just pressed it, and a keyboard would land at the top of the
            // page.
            disabled={!hydrated}
            aria-disabled={loading || undefined}
            onClick={() => {
              if (!loading && canLoadMore) request(true)
            }}
            className={`${SECONDARY_BUTTON_COMPACT} flex w-full items-center justify-center gap-2 aria-disabled:opacity-50`}
          >
            {loading ? (
              <>
                <LoaderCircle
                  size={15}
                  strokeWidth={2}
                  className="animate-spin"
                />
                Loading…
              </>
            ) : (
              `Show more ${noun}`
            )}
          </button>
          {loading && announce && (
            <div role="status" className="sr-only">
              {`Loading more ${noun}`}
            </div>
          )}
        </div>
      )}
    </>
  )
}
