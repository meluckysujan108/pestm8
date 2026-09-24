import { afterEach, describe, expect, it, vi } from 'vitest'
import { pageIsZoomed } from './pageZoom'

/**
 * Whether the app itself is pinch-zoomed. The viewer hands pinches back to
 * the browser while it is, so an app zoomed before View PDF can be zoomed
 * back out rather than trapped magnified.
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pageIsZoomed', () => {
  it('is true only past a hair above 1x', () => {
    vi.stubGlobal('window', { visualViewport: { scale: 1.6 } })
    expect(pageIsZoomed()).toBe(true)
    vi.stubGlobal('window', { visualViewport: { scale: 1.005 } })
    expect(pageIsZoomed()).toBe(false)
    vi.stubGlobal('window', { visualViewport: { scale: 1 } })
    expect(pageIsZoomed()).toBe(false)
  })

  it('is false with no visual viewport, or no window at all', () => {
    vi.stubGlobal('window', {})
    expect(pageIsZoomed()).toBe(false)
    vi.stubGlobal('window', undefined)
    expect(pageIsZoomed()).toBe(false)
  })
})
