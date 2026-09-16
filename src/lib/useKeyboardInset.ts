import { useEffect, useState } from 'react'

/**
 * Pixels the software keyboard currently covers at the bottom of the window.
 *
 * `position: fixed` is measured against the layout viewport, which iOS does
 * not shrink when the keyboard opens — so a bar fixed to the bottom sits
 * underneath the keyboard, invisible, exactly while someone is typing. The
 * visual viewport does know, and this turns it into a number to offset by.
 *
 * Lifted out of the notes toolbar when the report builder's Back/Next bar
 * needed the same thing: a technician typing a comment must still be able to
 * see the way to the next section.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)

  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return

    const update = () =>
      setInset(Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop)))

    update()
    viewport.addEventListener('resize', update)
    // Also on scroll: iOS moves the visual viewport rather than resizing it
    // when the page scrolls with the keyboard open.
    viewport.addEventListener('scroll', update)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
    }
  }, [])

  return inset
}
