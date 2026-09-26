import { useEffect, useState } from 'react'

/**
 * Sets `data-scrolled` on a bar while page content sits beneath it, so its
 * hairline can show only then — as iOS draws a bar's separator once something
 * has scrolled under it, and leaves a bar over nothing clean.
 *
 * `top`: a sticky bar, once it is pinned and the page has scrolled — the page
 * header, or the schedule's week strip once it reaches the header.
 * `bottom`: a fixed bar, while there is page left below the fold.
 *
 * Written straight onto the element rather than kept in state: it changes on
 * scroll, and a re-render of the header or dock per frame would be wasted.
 *
 * Returns a callback ref rather than taking a ref object, so a bar that
 * mounts later — the week strip, when a desktop window narrows to a phone's —
 * is picked up.
 */
export function useScrolledUnder(edge: 'top' | 'bottom') {
  const [el, setEl] = useState<HTMLElement | null>(null)

  useEffect(() => {
    if (!el) return

    let frame = 0
    const update = () => {
      frame = 0
      const root = document.documentElement
      const under =
        edge === 'top'
          ? window.scrollY > 0 &&
            el.getBoundingClientRect().top <=
              (parseFloat(getComputedStyle(el).top) || 0) + 0.5
          : window.scrollY + window.innerHeight < root.scrollHeight - 1
      el.toggleAttribute('data-scrolled', under)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }

    update()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    // The page can grow or shrink under a bar without a scroll — data landing,
    // a card expanding — which moves where the fold is.
    const resize = new ResizeObserver(schedule)
    resize.observe(document.body)
    return () => {
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      resize.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [el, edge])

  return setEl
}
