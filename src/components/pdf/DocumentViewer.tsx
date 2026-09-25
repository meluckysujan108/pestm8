import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import { Dialog } from 'radix-ui'
import { useKeyboardInset } from '#/lib/useKeyboardInset'
import { handOver } from './handOver'
import { PAGE_GAP } from './layout'
import { MarkupPalette } from './MarkupPalette'
import { PageGrid } from './PageGrid'
import { PageScroller } from './PageScroller'
import { pageIsZoomed, usePageZoomed } from './pageZoom'
import { browserStorage, loadPosition, savePosition } from './readingPosition'
import { SearchBar } from './SearchBar'
import { usePageSizes, usePdfDocument } from './useDocument'
import { useMarkupSession } from './useMarkupSession'
import { useTextSearch } from './useTextSearch'
import {
  BottomBar,
  MoreMenu,
  Toolbar,
  TopBar,
  hasMoreMenu,
} from './ViewerChrome'
import { keyCommand } from './viewerKeys'
import { ErrorState, LoadingState, PasswordState } from './ViewerStates'
import type { KeyboardEvent as ReactKeyboardEvent, SyntheticEvent } from 'react'
import type { Highlight, ScrollerHandle } from './PageScroller'
import type { ReadingPosition } from './readingPosition'
import type { PageRect } from './textSearch'
import type { DocumentViewerProps } from './types'

/**
 * The in-app PDF viewer: a product's safety data sheet or label, opened
 * full-screen inside the app the way iOS Quick Look opens one — never
 * bounced to Safari, never a download just to read it.
 *
 * Loaded only with `React.lazy` (see `pdfjs.ts` for why), so it is the
 * default export as well as a named one. The caller hands it the bytes'
 * source and the actions it may offer (`types.ts`); the viewer knows nothing
 * of products, storage or who is allowed to replace what.
 *
 * Built on Radix's Dialog, without its overlay, for three things a
 * hand-rolled overlay gets wrong the moment it is opened from inside a sheet
 * (which is where the product's PDF button lives): the sheet's focus trap
 * pauses while the viewer's runs, a tap in the viewer does not count as a tap
 * outside the sheet and close it, and Escape reaches the viewer first.
 *
 * Layers: the dock is z-40, sheets z-50, alert dialogs z-60/70; the viewer
 * is z-80, and its own menu z-90. Which is why nothing inside it may ask
 * through one of the app's alert dialogs: it would open behind the viewer.
 *
 * A caller may lay marks over the pages (`markup`, a report's): the viewer
 * draws them, runs the pen, and knows nothing of reports or who may do what
 * beyond the contract's fields.
 */
export function DocumentViewer({
  title,
  fileName,
  source,
  actions,
  onClose,
  markup,
  badge,
  rememberPosition = true,
}: DocumentViewerProps) {
  const [attempt, setAttempt] = useState(0)
  const { state, blob, submitPassword } = usePdfDocument(source, attempt)
  const doc = state.phase === 'ready' ? state.doc : null
  const firstPage = state.phase === 'ready' ? state.firstPage : null
  const sizes = usePageSizes(doc, firstPage)
  const pages = doc?.numPages ?? 0

  // Made once per download: Share must hand over a finished File inside the
  // tap (see `ViewerActions.share`).
  const file = useMemo(
    () =>
      blob ? new File([blob], fileName, { type: 'application/pdf' }) : null,
    [blob, fileName],
  )

  const [barsVisible, setBarsVisible] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  const [gridOpen, setGridOpen] = useState(false)
  const [current, setCurrent] = useState(0)
  const [pillVisible, setPillVisible] = useState(false)
  const [announced, setAnnounced] = useState<number | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [insets, setInsets] = useState({ top: 0, bottom: 0 })
  const [bottomPadding, setBottomPadding] = useState(0)

  // State, not a ref: the Dialog portals its content in on a second render,
  // so effects that need the elements wait for this to be set.
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const topBarRef = useRef<HTMLElement>(null)
  const bottomBarRef = useRef<HTMLElement>(null)
  const doneRef = useRef<HTMLButtonElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchButtonRef = useRef<HTMLButtonElement>(null)
  const markupButtonRef = useRef<HTMLButtonElement>(null)
  const markupDoneRef = useRef<HTMLButtonElement>(null)
  const scrollerRef = useRef<ScrollerHandle>(null)
  const currentRef = useRef(0)
  const pillTimer = useRef(0)
  const toastTimer = useRef(0)

  // Where focus goes back to when the viewer closes: whatever opened it.
  const [returnFocus] = useState<Element | null>(() =>
    typeof document === 'undefined' ? null : document.activeElement,
  )

  const ready = doc !== null
  const badgeId = useId()

  const keyboard = useKeyboardInset()
  // The bar already reserves the home-indicator strip, which the keyboard
  // covers; rise only by the rest.
  const lift = searchOpen ? Math.max(0, keyboard - bottomPadding) : 0
  // The pages' bottom inset counts the keyboard as well as the bar, while
  // the search bar rides on it. Not only so a match is aimed above the keys:
  // the viewer is `fixed inset-0`, and neither iOS nor Android (whose Chrome
  // now resizes only the visual viewport) shrinks it for a keyboard, so the
  // scroller's height never changes and its scroll range would still end
  // with the last page behind the keys. A larger inset is a longer range —
  // the foot of the last page can be lifted into view to show a match there.
  // The layout keeps its top-left anchor through the change, so the page
  // being read stays put as the keyboard comes and goes.
  const scrollerInsets = useMemo(
    () => ({ top: insets.top, bottom: insets.bottom + lift }),
    [insets.top, insets.bottom, lift],
  )

  useBodyLock(root)

  // The bars' real heights (safe areas included) become the scroller's
  // insets: pages start below the top bar and end above the bottom one.
  useLayoutEffect(() => {
    const top = topBarRef.current
    const bottom = bottomBarRef.current
    if (!root || !top || !bottom) return
    const measure = () => {
      const next = {
        top: top.offsetHeight + PAGE_GAP,
        bottom: bottom.offsetHeight + PAGE_GAP,
      }
      setInsets((prev) =>
        prev.top === next.top && prev.bottom === next.bottom ? prev : next,
      )
      try {
        setBottomPadding(
          parseFloat(getComputedStyle(bottom).paddingBottom) || 0,
        )
      } catch {
        setBottomPadding(0)
      }
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(top)
    observer.observe(bottom)
    return () => observer.disconnect()
  }, [root])

  // ---- Reading position ---------------------------------------------------

  // Fixed for the life of the viewer: a draft preview neither opens where the
  // last draft was left nor pushes real documents out of the remembered list.
  const [remember] = useState(rememberPosition)
  const initialPosition = useMemo(() => {
    if (!doc || !remember) return null
    const saved = loadPosition(browserStorage(), source.key)
    return saved && saved.page <= doc.numPages ? saved : null
    // Read once per document; later saves must not move the view.
  }, [doc, source.key, remember])

  const positionRef = useRef<{ key: string; position: ReadingPosition } | null>(
    null,
  )
  const saveTimer = useRef(0)
  const flushPosition = useCallback(() => {
    window.clearTimeout(saveTimer.current)
    saveTimer.current = 0
    const pending = positionRef.current
    if (pending) {
      savePosition(browserStorage(), pending.key, pending.position, Date.now())
    }
  }, [])
  const keyRef = useRef(source.key)
  useLayoutEffect(() => {
    keyRef.current = source.key
  })
  const onPosition = useCallback(
    (position: ReadingPosition) => {
      if (!remember) return
      positionRef.current = { key: keyRef.current, position }
      if (saveTimer.current) return
      saveTimer.current = window.setTimeout(flushPosition, 500)
    },
    [flushPosition, remember],
  )
  useEffect(() => flushPosition, [flushPosition])

  // ---- Toasts --------------------------------------------------------------

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 3000)
  }, [])

  // ---- Markup --------------------------------------------------------------

  // Not while the app itself is pinch-zoomed: its pinches are then the
  // browser's (`pageZoom.ts`), and a page that swallowed one-finger touches
  // for the pen could leave it stuck zoomed.
  const appZoomed = usePageZoomed()
  const pen = useMarkupSession(markup, {
    ready,
    appZoomed,
    page: current,
    showToast,
  })
  const marking = pen.open
  const setMarkupOpen = pen.setOpen

  // Search, the page grid and the pen need their controls on screen.
  const showBars = barsVisible || searchOpen || gridOpen || marking || !ready

  const openMarkup = () => {
    flushSync(() => {
      setMarkupOpen(true)
      setBarsVisible(true)
    })
    markupDoneRef.current?.focus()
  }
  const closeMarkup = useCallback(() => {
    flushSync(() => setMarkupOpen(false))
    // Back to the button that opened it, which the palette was covering.
    markupButtonRef.current?.focus()
  }, [setMarkupOpen])

  // ---- Scroller callbacks --------------------------------------------------

  // A tap on the page shows or hides the bars — except while search, the
  // grid or the pen holds them on screen. There it would change nothing that
  // could be seen, only what is remembered, and the bars would then vanish,
  // Done and all, the moment search closed. Read at tap time (it fires 250 ms
  // after the finger lifts), so a ref.
  const barsHeld = useRef(false)
  useLayoutEffect(() => {
    barsHeld.current = searchOpen || gridOpen || marking
  })
  const onTap = useCallback(() => {
    if (barsHeld.current) return
    setBarsVisible((visible) => !visible)
  }, [])
  const onPageChange = useCallback((index: number) => {
    currentRef.current = index
    setCurrent(index)
  }, [])
  const onScrollActivity = useCallback(() => {
    setPillVisible(true)
    window.clearTimeout(pillTimer.current)
    pillTimer.current = window.setTimeout(() => {
      setPillVisible(false)
      // Said once scrolling stops, not on every page that flies past.
      setAnnounced(currentRef.current)
    }, 1200)
  }, [])

  useEffect(
    () => () => {
      window.clearTimeout(pillTimer.current)
      window.clearTimeout(toastTimer.current)
    },
    [],
  )

  // ---- Search ------------------------------------------------------------

  const [query, setQuery] = useState('')
  const [searched, setSearched] = useState('')
  useEffect(() => {
    const timer = window.setTimeout(() => setSearched(query), 150)
    return () => window.clearTimeout(timer)
  }, [query])
  const result = useTextSearch(doc, searchOpen, searched)
  // The match being looked at, for the search it belongs to.
  const [selection, setSelection] = useState<{
    query: string
    index: number
  } | null>(null)
  const selected =
    selection?.query === searched && selection.index < result.matches.length
      ? selection.index
      : null

  const reveal = useCallback(
    (index: number) => {
      const match = result.matches.at(index)
      if (!match) return
      // Above the keyboard, which `scrollerInsets` already counts.
      scrollerRef.current?.revealRect(match.page, union(match.rects))
    },
    [result.matches],
  )

  // A new search jumps to its first match at or after the page being read,
  // as Quick Look does — waiting for the pages still being read if needed.
  useEffect(() => {
    if (!searchOpen || !searched || selected !== null) return
    const { matches, done } = result
    if (matches.length === 0) return
    let index = matches.findIndex((m) => m.page >= currentRef.current)
    if (index < 0) {
      if (!done) return
      index = 0
    }
    setSelection({ query: searched, index })
    reveal(index)
  }, [result, searched, searchOpen, selected, reveal])

  const step = useCallback(
    (direction: 1 | -1) => {
      const count = result.matches.length
      if (count === 0) return
      const from = selected ?? (direction === 1 ? -1 : 0)
      const index = (from + direction + count) % count
      setSelection({ query: searched, index })
      reveal(index)
    },
    [result.matches.length, selected, searched, reveal],
  )

  const highlights = useMemo(() => {
    const byPage = new Map<number, Highlight[]>()
    if (!searchOpen || !searched) return byPage
    result.matches.forEach((match, index) => {
      const list = byPage.get(match.page) ?? []
      for (const rect of match.rects) {
        list.push({ rect, current: index === selected })
      }
      byPage.set(match.page, list)
    })
    return byPage
  }, [result.matches, selected, searchOpen, searched])

  const openSearch = useCallback(() => {
    if (!ready) return
    // Rendered and focused inside the tap, or iOS shows the caret and no
    // keyboard (see "+ Add site contact" in NewClientFields).
    flushSync(() => {
      setSearchOpen(true)
      setGridOpen(false)
      setMarkupOpen(false)
      setBarsVisible(true)
    })
    searchInputRef.current?.focus()
    searchInputRef.current?.select()
  }, [ready, setMarkupOpen])

  const closeSearch = useCallback(() => {
    flushSync(() => {
      setSearchOpen(false)
      setSelection(null)
      // Search leaves the bars as it found them: on screen. Focus is about
      // to go to the Search button, which must not be in a hidden bar.
      setBarsVisible(true)
    })
    searchButtonRef.current?.focus()
  }, [])

  // ---- Share and save ------------------------------------------------------

  // The file goes out exactly as the caller stored it: marks are for the
  // team, drawn over the pages here and never burned into the PDF. Said once
  // it has gone — not as the share sheet opens, when it would sit behind the
  // sheet, and not at all if the sheet is closed without sending
  // (`handOver`).
  const withoutMarks = (note: string | undefined) => {
    const said = pen.hasMarks ? note : undefined
    return said ? () => showToast(said) : undefined
  }
  const share = () => {
    if (!file || !actions.share) return
    // No await before this call: Safari opens the share sheet only from
    // inside the tap.
    handOver(
      () => actions.share?.(file),
      "Couldn't share this PDF",
      showToast,
      withoutMarks(markup?.shareNote),
    )
  }
  const save = () => {
    if (!file || !actions.save) return
    handOver(
      () => actions.save?.(file),
      "Couldn't save this PDF",
      showToast,
      withoutMarks(markup?.saveNote ?? markup?.shareNote),
    )
  }

  // ---- Keys ---------------------------------------------------------------

  /** Runs the viewer's command for a key, if it has one; true if it did. */
  const handleKey = (event: ReactKeyboardEvent): boolean => {
    const target = event.target as HTMLElement
    // Keys from the menu, which is portalled outside, reach here through
    // React; they are the menu's. So is a key something already handled.
    if (event.defaultPrevented || !root?.contains(target)) return false
    const command = keyCommand(event, {
      ready,
      gridOpen,
      inField: !!target.closest(
        'input, textarea, select, [contenteditable="true"]',
      ),
      inSearchBar: !!target.closest('[role="search"]'),
    })
    if (!command) return false
    event.preventDefault()
    const scroller = scrollerRef.current
    switch (command.kind) {
      case 'search':
        openSearch()
        break
      case 'zoomBy':
        scroller?.zoomBy(command.factor)
        break
      case 'zoomTo':
        scroller?.zoomTo(command.zoom)
        break
      case 'scroll':
        scroller?.scrollByKey(command.key)
        break
    }
    return true
  }

  // Space is taken on the way down, before the focused element sees it. A
  // focused button presses itself on Space — and the viewer opens with focus
  // on Done, so reading on would close the PDF — and the More button opens
  // its menu on Space in a handler of its own, which runs before anything
  // that listens as the key bubbles back up.
  const spaceTaken = useRef(false)
  const onKeyDownCapture = (event: ReactKeyboardEvent) => {
    if (event.key !== ' ') return
    spaceTaken.current = handleKey(event)
    if (spaceTaken.current) event.stopPropagation()
  }
  const onKeyUpCapture = (event: ReactKeyboardEvent) => {
    if (event.key !== ' ' || !spaceTaken.current) return
    spaceTaken.current = false
    // A button presses on Space's keyup, and not every browser lets a
    // cancelled keydown call that off.
    event.preventDefault()
    event.stopPropagation()
  }
  const onKeyDown = (event: ReactKeyboardEvent) => {
    stopBubbling(event)
    // Space was the capture handler's to take or to leave.
    if (event.key !== ' ') handleKey(event)
  }

  // ---- Render ---------------------------------------------------------------

  const matchCount = result.matches.length
  const searchStatus = !searched
    ? null
    : matchCount > 0
      ? `${(selected ?? 0) + 1} of ${matchCount}`
      : result.done
        ? 'No matches'
        : null
  const noText = searchOpen && result.done && !result.hasText
  const topBarHeight = Math.max(0, insets.top - PAGE_GAP)

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Content
          ref={setRoot}
          aria-label={`${title} PDF`}
          aria-modal="true"
          // A draft preview says what it is as it opens, not only on screen.
          aria-describedby={badge ? badgeId : undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            doneRef.current?.focus()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (returnFocus instanceof HTMLElement && returnFocus.isConnected) {
              returnFocus.focus()
            }
          }}
          // Full screen, so "outside" is only ever something layered over it
          // — a toast, or wherever the caller's file input for Replace lives.
          // Neither is a reason to close; Done and Escape are the ways out.
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            // Escape backs out one step at a time, as Done would.
            if (searchOpen) {
              event.preventDefault()
              closeSearch()
            } else if (gridOpen) {
              event.preventDefault()
              setGridOpen(false)
            } else if (marking) {
              event.preventDefault()
              closeMarkup()
            }
          }}
          onKeyDownCapture={onKeyDownCapture}
          onKeyUpCapture={onKeyUpCapture}
          onKeyDown={onKeyDown}
          // The viewer is portalled, but React events still bubble to
          // whatever rendered it — a card, a sheet. They stop here.
          onClick={stopBubbling}
          onPointerDown={stopBubbling}
          onPointerUp={stopBubbling}
          onTouchStart={stopBubbling}
          onTouchEnd={stopBubbling}
          onWheel={stopBubbling}
          onContextMenu={stopBubbling}
          className="fixed inset-0 z-[80] overflow-hidden bg-viewer-backdrop text-ink outline-none [touch-action:manipulation]"
        >
          {state.phase === 'ready' && doc && (
            <PageScroller
              key={source.key}
              doc={doc}
              sizes={sizes}
              insets={scrollerInsets}
              initial={initialPosition}
              highlights={highlights}
              onTap={onTap}
              onPageChange={onPageChange}
              onScrollActivity={onScrollActivity}
              onPosition={onPosition}
              handleRef={scrollerRef}
              inert={gridOpen}
              markStrokes={pen.strokes}
              pendingMarks={pen.pendingByPage}
              marking={marking}
              onStroke={pen.onStroke}
            />
          )}
          {state.phase === 'loading' && (
            <LoadingState progress={state.progress} />
          )}
          {state.phase === 'password' && (
            <PasswordState
              wrong={state.wrong}
              checking={state.checking}
              onSubmit={submitPassword}
              onCancel={onClose}
            />
          )}
          {state.phase === 'error' && (
            <ErrorState
              reason={state.reason}
              detail={state.detail}
              onRetry={() => setAttempt((n) => n + 1)}
            />
          )}

          {gridOpen && doc && (
            <PageGrid
              key={source.key}
              doc={doc}
              sizes={sizes}
              current={current}
              insets={insets}
              onPick={(index) => {
                setGridOpen(false)
                scrollerRef.current?.scrollToPage(index)
              }}
            />
          )}

          {/* "3 of 12", while scrolling — below the badge, when there is
              one, rather than on top of it on a narrow phone. */}
          {ready && !gridOpen && (
            <div
              aria-hidden
              className={[
                'chrome-blur pointer-events-none absolute left-[max(0.75rem,env(safe-area-inset-left))] z-10 rounded-full px-2.5 py-1 text-caption font-semibold text-ink shadow-elevation transition-[opacity,top] duration-300',
                pillVisible ? 'opacity-100' : 'opacity-0',
              ].join(' ')}
              style={{ top: pillTop(showBars, topBarHeight, badge ? 1 : 0) }}
            >
              {current + 1} of {pages}
            </div>
          )}
          <p aria-live="polite" className="sr-only">
            {ready && announced !== null
              ? `Page ${announced + 1} of ${pages}`
              : ''}
          </p>

          <TopBar
            barRef={topBarRef}
            doneRef={doneRef}
            visible={showBars}
            title={title}
            pages={pages}
            onDone={onClose}
            menu={
              hasMoreMenu(actions) ? (
                <MoreMenu actions={actions} canSave={!!file} onSave={save} />
              ) : null
            }
          />

          {/* What this document is, kept in view: "Draft — not the finished
              document". Read once as the viewer opens (it describes the
              dialog), and not again every time the bars come and go. */}
          {badge && !gridOpen && (
            <p
              id={badgeId}
              aria-live="off"
              className="chrome-blur pointer-events-none absolute left-1/2 z-10 max-w-[calc(100%-1.5rem)] -translate-x-1/2 truncate rounded-full px-2.5 py-1 text-caption font-semibold text-ink shadow-elevation transition-[top] duration-300"
              style={{ top: pillTop(showBars, topBarHeight, 0) }}
            >
              {badge}
            </p>
          )}

          {noText && (
            <p
              role="status"
              className="chrome-blur absolute inset-x-3 z-10 mx-auto max-w-sm rounded-xl px-3 py-2 text-center text-caption text-ink shadow-elevation"
              style={{ bottom: insets.bottom + lift }}
            >
              This PDF may be a scan: it has no text to search.
            </p>
          )}
          {toast && (
            <p
              role="status"
              className="chrome-blur absolute inset-x-3 z-10 mx-auto max-w-sm rounded-xl px-3 py-2 text-center text-caption font-semibold text-ink shadow-elevation"
              style={{ bottom: insets.bottom + lift }}
            >
              {toast}
            </p>
          )}

          <BottomBar barRef={bottomBarRef} visible={showBars} lift={lift}>
            {marking ? (
              <MarkupPalette
                note={markup?.note}
                canUndo={pen.canUndo}
                onUndo={pen.onUndo}
                page={current}
                canClear={pen.canClear}
                clearArmed={pen.clearArmed}
                onClear={pen.onClear}
                onDone={closeMarkup}
                doneRef={markupDoneRef}
              />
            ) : searchOpen && ready ? (
              <SearchBar
                inputRef={searchInputRef}
                query={query}
                onQuery={setQuery}
                status={searchStatus}
                busy={!!searched && matchCount === 0 && !result.done}
                canStep={matchCount > 0}
                onStep={step}
                onDone={closeSearch}
              />
            ) : (
              <Toolbar
                actions={actions}
                canShare={!!file}
                ready={ready}
                searchOpen={searchOpen}
                gridOpen={gridOpen}
                onShare={share}
                onSearch={openSearch}
                onPages={() => {
                  setBarsVisible(true)
                  setMarkupOpen(false)
                  setGridOpen((open) => !open)
                }}
                searchButtonRef={searchButtonRef}
                // The palette covers this bar while the pen is out, and its
                // own Done puts the pen away.
                markup={
                  pen.canDraw
                    ? {
                        open: marking,
                        onToggle: openMarkup,
                        buttonRef: markupButtonRef,
                      }
                    : undefined
                }
              />
            )}
          </BottomBar>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export default DocumentViewer

function stopBubbling(event: SyntheticEvent) {
  event.stopPropagation()
}

/**
 * Where a pill under the top bar sits: just below the bar, or near the top
 * of the screen when the bars are away; `row` 1 is the second pill down.
 */
function pillTop(showBars: boolean, topBarHeight: number, row: number) {
  const below = 8 + row * 32
  return showBars
    ? topBarHeight + below
    : `calc(env(safe-area-inset-top) + ${below}px)`
}

/** The smallest rectangle around all of a match's pieces. */
function union(rects: PageRect[]): PageRect {
  if (rects.length === 0) return { x: 0, y: 0, w: 0, h: 0 }
  const x0 = Math.min(...rects.map((r) => r.x))
  const y0 = Math.min(...rects.map((r) => r.y))
  const x1 = Math.max(...rects.map((r) => r.x + r.w))
  const y1 = Math.max(...rects.map((r) => r.y + r.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * Holds the page behind still while the viewer is open.
 *
 * The overflow lock stops the app scrolling under it on desktop and Android;
 * on iOS a fixed overlay can still drag the page behind it — or rubber-band
 * itself — from anywhere that does not scroll, so single-finger moves outside
 * the viewer's own scrolling areas are cancelled too. Two-finger moves and
 * Safari's gesture events are cancelled everywhere, or a pinch on a bar would
 * zoom the whole app.
 *
 * Except while the app is already zoomed (`pageIsZoomed`): then the browser
 * keeps every gesture, pans included, so the app can be zoomed back out.
 */
function useBodyLock(root: HTMLElement | null) {
  useEffect(() => {
    if (typeof document === 'undefined' || !root) return
    const { documentElement: html, body } = document
    const previous = [html.style.overflow, body.style.overflow]
    html.style.overflow = 'hidden'
    body.style.overflow = 'hidden'

    // Decided as each touch and each gesture starts, not on every move.
    let touchZoomed = false
    let gestureZoomed = false
    const onTouchStart = () => {
      touchZoomed = pageIsZoomed()
    }
    const onTouchMove = (event: TouchEvent) => {
      if (!event.cancelable || touchZoomed) return
      if (event.touches.length > 1) {
        event.preventDefault()
        return
      }
      const target = event.target
      if (!(target instanceof Element)) return
      // Anywhere inside a scrolling area — a page, and just as much the gap
      // between two pages or the margin beside them, which is the scroller's
      // own background — or a text field, whose caret a finger can drag.
      if (target.closest('[data-viewer-scroll], input, textarea')) return
      event.preventDefault()
    }
    const onGestureStart = (event: Event) => {
      gestureZoomed = pageIsZoomed()
      if (!gestureZoomed) event.preventDefault()
    }
    const onGestureChange = (event: Event) => {
      if (!gestureZoomed) event.preventDefault()
    }
    root.addEventListener('touchstart', onTouchStart, { passive: true })
    root.addEventListener('touchmove', onTouchMove, { passive: false })
    document.addEventListener('gesturestart', onGestureStart, {
      passive: false,
    })
    document.addEventListener('gesturechange', onGestureChange, {
      passive: false,
    })
    return () => {
      html.style.overflow = previous[0]
      body.style.overflow = previous[1]
      root.removeEventListener('touchstart', onTouchStart)
      root.removeEventListener('touchmove', onTouchMove)
      document.removeEventListener('gesturestart', onGestureStart)
      document.removeEventListener('gesturechange', onGestureChange)
    }
  }, [root])
}
