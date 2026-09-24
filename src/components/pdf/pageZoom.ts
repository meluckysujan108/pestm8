import { useSyncExternalStore } from 'react'

/**
 * Whether the whole app is pinch-zoomed — the browser's own zoom, not the
 * viewer's.
 *
 * The viewer takes every pinch for itself (`useBodyLock`, `PageScroller`),
 * because iOS ignores `user-scalable=no` and two fingers would otherwise zoom
 * the whole app, bars and all. But the app can already be zoomed when the
 * viewer opens: someone pinched the product list to read it, then tapped
 * View PDF. The viewer is laid out for the unzoomed screen, so it shows
 * magnified, Done often off the edge — and if it took that pinch too, nothing
 * could ever zoom the app back out. So while this is true a pinch is left to
 * the browser, and the viewer's own zoom takes over once the app is back at
 * 1x. Callers decide as each gesture starts, so a pinch that zooms the app
 * back out is not cut off halfway when it passes 1x.
 */
export function pageIsZoomed(): boolean {
  try {
    return (window.visualViewport?.scale ?? 1) > 1.01
  } catch {
    // No window (the server), or no visual viewport: nothing is zoomed.
    return false
  }
}

function subscribe(listener: () => void): () => void {
  const viewport =
    typeof window === 'undefined' ? undefined : window.visualViewport
  if (!viewport) return () => {}
  viewport.addEventListener('resize', listener)
  return () => viewport.removeEventListener('resize', listener)
}

/**
 * `pageIsZoomed`, as state: for a `touch-action` that must let the browser
 * pinch while the app is zoomed. False on the server.
 */
export function usePageZoomed(): boolean {
  return useSyncExternalStore(subscribe, pageIsZoomed, () => false)
}
