/**
 * Whether the end of a long list is coming near — the trigger for loading
 * the next page before anyone reaches the bottom (`LoadMore`).
 *
 * "Near" is within one and a half screens: a phone scrolled with a flick
 * covers a screen in well under a second, and a page of cards takes a Convex
 * round trip (~430 ms) to arrive, so a margin of one screen still showed the
 * bones on a fast flick. Measured against the scroll container the list is
 * in, which is the window on a phone and may be a column of its own on a
 * computer (Notes' middle column at `lg:`) — see `scrollRootOf`.
 *
 * Kept free of React, and of anything that reads the DOM at import time, so
 * it can be tested with a stand-in observer and imported by anything the
 * server renders.
 */

/** One and a half of the root's heights below its bottom edge. */
export const NEAR_MARGIN = '0px 0px 150% 0px'

export type NearOptions = {
  /** The scroll container to measure against; the viewport when null. */
  root?: Element | null
  rootMargin?: string
}

/**
 * Calls `onChange(true)` when `el` comes within the margin of its root, and
 * `onChange(false)` when it leaves. An IntersectionObserver also reports the
 * element's state once as soon as it starts watching, which is how a caller
 * re-checks after the list under it has grown: watch again, and the first
 * answer is the current one. Returns the way to stop.
 *
 * A browser without IntersectionObserver (old WebViews, the server) is told
 * `false` once and nothing more: the list's own button still loads the next
 * page, it just does not load itself.
 */
export function observeNear(
  el: Element,
  onChange: (near: boolean) => void,
  { root = null, rootMargin = NEAR_MARGIN }: NearOptions = {},
): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    onChange(false)
    return () => {}
  }
  const observer = new IntersectionObserver(
    (entries) => {
      // Several entries can arrive in one batch when the list moves quickly;
      // the last is the element's state now.
      const latest = entries.at(-1)
      if (latest) onChange(latest.isIntersecting)
    },
    { root, rootMargin },
  )
  observer.observe(el)
  return () => observer.disconnect()
}

/**
 * The element that scrolls `el`, or null for the viewport.
 *
 * Not a fixed choice per screen, because the same list scrolls in different
 * places at different widths. The notes list scrolls inside its column on a
 * computer (`lg:overflow-y-auto`) and with the window on a phone. Measured
 * against the window on a computer, the column clips the end of the list
 * before the margin can reach it, so nothing ever loads; measured against
 * the column on a phone, where the column is as tall as its content, the end
 * is always "inside" it, and every page loads at once.
 *
 * So: the nearest ancestor that is set to scroll AND has more content than
 * room — a column whose overflow is `auto` but which fits its content is not
 * the thing that scrolls. Asked when the list starts watching, which is after
 * layout, when both are known. The body and the page itself are the viewport
 * and never the answer: an observer rooted on <html> measures the whole
 * document, not the screen.
 */
export function scrollRootOf(el: Element): Element | null {
  if (typeof getComputedStyle === 'undefined') return null
  for (
    let node = el.parentElement;
    // <html> is the one element with no parent.
    node?.parentElement && node.tagName !== 'BODY';
    node = node.parentElement
  ) {
    const { overflowY } = getComputedStyle(node)
    if (
      (overflowY === 'auto' || overflowY === 'scroll') &&
      node.scrollHeight > node.clientHeight
    ) {
      return node
    }
  }
  return null
}
