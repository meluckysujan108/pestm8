import type { ScrollKey } from './PageScroller'

/**
 * What a key does in the viewer, worked out apart from the DOM so the rules
 * can be tested: which keys zoom, which scroll, and — the one that is easy to
 * get wrong — when a key belongs to whatever has focus instead.
 *
 * The viewer is read on a desktop, and on an iPad with a keyboard, the way
 * Preview and Chrome's PDF viewer are, so it answers their keys: + and − to
 * zoom, 0 for fit width, the arrows, Page Up/Down, Home/End, and Space and
 * Shift+Space to read on and back.
 */

export type KeyCommand =
  | { kind: 'search' }
  | { kind: 'zoomBy'; factor: number }
  | { kind: 'zoomTo'; zoom: number }
  | { kind: 'scroll'; key: ScrollKey }

/** The parts of a keyboard event the rules read. */
export type KeyPress = {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
}

export type KeyContext = {
  /** The document is open: there is something to scroll and zoom. */
  ready: boolean
  /** The page grid covers the pages; its thumbnails take the keys. */
  gridOpen: boolean
  /** Focus is in a text field, where every key is for typing. */
  inField: boolean
  /**
   * Focus is on the search bar's own buttons (up, down, Done). Space there
   * presses the button, as it does in any form: someone who has reached
   * "Next match" is working the search, not reading.
   */
  inSearchBar: boolean
}

const ZOOM_IN = 1.25
const ZOOM_OUT = 0.8

const SCROLL_KEYS: Record<string, ScrollKey | undefined> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  PageUp: 'pageUp',
  PageDown: 'pageDown',
  Home: 'home',
  End: 'end',
}

/**
 * The viewer's command for `press`, or null when the key is not the
 * viewer's to take and should do whatever it does by default.
 */
export function keyCommand(
  press: KeyPress,
  context: KeyContext,
): KeyCommand | null {
  const mod = press.metaKey || press.ctrlKey
  // Find, from anywhere — the search field included, where it selects what
  // is already typed.
  if (mod && press.key.toLowerCase() === 'f') return { kind: 'search' }
  if (mod || press.altKey || !context.ready || context.gridOpen) return null
  if (context.inField) return null

  if (press.key === ' ') {
    if (context.inSearchBar) return null
    // Space reads on even with a bar button focused — and one always is:
    // the viewer opens with focus on Done, so without this the first Space
    // someone presses to read on would close the PDF instead. The focused
    // button still answers Enter.
    return { kind: 'scroll', key: press.shiftKey ? 'pageUp' : 'pageDown' }
  }

  switch (press.key) {
    case '+':
    case '=':
      return { kind: 'zoomBy', factor: ZOOM_IN }
    case '-':
    case '_':
      return { kind: 'zoomBy', factor: ZOOM_OUT }
    case '0':
      return { kind: 'zoomTo', zoom: 1 }
  }
  const scroll = SCROLL_KEYS[press.key]
  return scroll ? { kind: 'scroll', key: scroll } : null
}
