import { useCallback, useRef } from 'react'

/**
 * A sheet with the phone's keyboard up: sat on the keyboard, no taller than
 * what is left to see above it, its body scrolling the field being typed in
 * into view. `SheetShell` follows the keyboard with this, not with Vaul's
 * own `repositionInputs`.
 *
 * Vaul takes the keyboard's height as `innerHeight − visualViewport.height`.
 * From iOS 27, `innerHeight` shrinks with the keyboard too, so that is 0, and
 * Vaul held a tall sheet at its full height, sat on the keyboard: New Job's
 * title, ✕, Client and Property went off the top of the screen as Price was
 * tapped, and nothing scrolled until the keyboard was put away (iOS 27.2
 * simulator, Safari and the Home Screen app, 23 Nov 2026). Earlier iOS keeps
 * `innerHeight` and moves the visual viewport instead, which Vaul read with a
 * guess — a jump of 60px or more flips "the keyboard is open" — that a
 * letters-to-number-pad switch or a sheet closed with the keyboard up could
 * leave the wrong way round.
 *
 * Here nothing is guessed. The sheet's foot goes where the visible part of
 * the screen ends (`lift`: what the keyboard covers of the layout viewport,
 * 0 where fixed elements already sit on it), and the sheet is at most 92% of
 * what is visible (`room`) — the 92vh it is without a keyboard, of what is
 * left with one.
 */

/** The share of the visible screen a sheet may take: its 92vh. */
const ROOM = 0.92

/** Below this, a field reaching the edge of the sheet's body is moved in. */
const FIELD_MARGIN = 16

/** How far above a field its label may start: a section label and its gap. */
const LABEL_REACH = 48

export type VisibleArea = {
  innerHeight: number
  height: number
  offsetTop: number
  scale: number
}

/**
 * Where the sheet goes for what is visible: `lift` above the bottom of the
 * layout viewport, and at most `room` tall. Pinch-zoomed in, the visible part
 * is a window onto the page, not what the keyboard left, and the sheet stays
 * as it is laid out (`room` null).
 */
export function sheetPlace(area: VisibleArea): {
  lift: number
  room: number | null
} {
  if (area.scale > 1.01) return { lift: 0, room: null }
  return {
    lift: Math.max(
      0,
      Math.round(area.innerHeight - area.height - area.offsetTop),
    ),
    room: Math.floor(area.height * ROOM),
  }
}

/**
 * How far to scroll a sheet's body (`view`) so a field (`field`, its label
 * at `labelTop` where it has one above it) is in it: its label clear of the
 * top, the field clear of the bottom. 0 when it already is.
 */
export function revealBy(
  view: { top: number; bottom: number },
  field: { top: number; bottom: number },
  labelTop: number = field.top,
): number {
  const top = Math.min(labelTop, field.top)
  const below = field.bottom - (view.bottom - FIELD_MARGIN)
  if (below > 0) {
    // A field taller than the body keeps its top in sight, not its foot.
    return Math.min(below, top - (view.top + FIELD_MARGIN))
  }
  const above = view.top + FIELD_MARGIN - top
  return above > 0 ? -above : 0
}

const NOT_TYPED = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
])

/** A control the phone puts its keyboard up for. */
function takesKeyboard(element: Element | null): element is HTMLElement {
  if (element instanceof HTMLInputElement) return !NOT_TYPED.has(element.type)
  return (
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  )
}

/** The scrolling box inside `sheet` that holds `element`, if one does. */
function scrollingBox(element: HTMLElement, sheet: HTMLElement) {
  for (
    let box = element.parentElement;
    box && box !== sheet;
    box = box.parentElement
  ) {
    const { overflowY } = getComputedStyle(box)
    if (
      (overflowY === 'auto' || overflowY === 'scroll') &&
      box.scrollHeight > box.clientHeight
    ) {
      return box
    }
  }
  return null
}

/** Scrolls the sheet's body so the field being typed in is in sight. */
function revealFocused(sheet: HTMLElement) {
  const field = document.activeElement
  if (!takesKeyboard(field) || !sheet.contains(field)) return
  const box = scrollingBox(field, sheet)
  if (!box) return
  const rect = field.getBoundingClientRect()
  // The field's own label, just above it (`FormField`), comes into view with
  // it; not a label that wraps more than one line of something.
  const label = field.closest('label')?.getBoundingClientRect()
  const by = revealBy(
    box.getBoundingClientRect(),
    rect,
    label && rect.top - label.top <= LABEL_REACH ? label.top : undefined,
  )
  if (by !== 0) box.scrollTop += by
}

/**
 * Follows the visible part of the screen for one sheet: its `--sheet-lift`
 * and `--sheet-room` as the keyboard comes, goes or changes, and the field
 * being typed in scrolled into view once the sheet has its new size, and as
 * focus moves to another field (the keyboard's ˄ ˅, or a tap on one half
 * hidden). Returns what stops it.
 */
function followKeyboard(sheet: HTMLElement): () => void {
  const viewport = window.visualViewport
  if (!viewport) return () => {}
  let frame = 0

  const place = () => {
    const { lift, room } = sheetPlace({
      innerHeight: window.innerHeight,
      height: viewport.height,
      offsetTop: viewport.offsetTop,
      scale: viewport.scale,
    })
    sheet.style.setProperty('--sheet-lift', `${lift}px`)
    if (room === null) sheet.style.removeProperty('--sheet-room')
    else sheet.style.setProperty('--sheet-room', `${room}px`)
  }
  // A frame later, so the sheet has been laid out at its new size.
  const reveal = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => revealFocused(sheet))
  }
  const resized = () => {
    place()
    reveal()
  }

  place()
  viewport.addEventListener('resize', resized)
  // iOS before 27 moves the visual viewport rather than resizing it as the
  // page under the keyboard is scrolled.
  viewport.addEventListener('scroll', place)
  sheet.addEventListener('focusin', reveal)
  return () => {
    cancelAnimationFrame(frame)
    viewport.removeEventListener('resize', resized)
    viewport.removeEventListener('scroll', place)
    sheet.removeEventListener('focusin', reveal)
  }
}

/**
 * A ref for a sheet's panel that keeps it above the keyboard
 * (`followKeyboard`) for as long as the panel is on the page. The panel's
 * classes read `--sheet-lift` and `--sheet-room`.
 */
export function useFollowKeyboard(): (sheet: HTMLElement | null) => void {
  const stop = useRef<(() => void) | null>(null)
  return useCallback((sheet: HTMLElement | null) => {
    stop.current?.()
    stop.current = sheet ? followKeyboard(sheet) : null
  }, [])
}
