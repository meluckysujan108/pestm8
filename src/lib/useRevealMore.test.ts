import { describe, expect, it } from 'vitest'
import { currentReveal, revealView } from './useRevealMore'

/**
 * A whole list drawn a step at a time. The hook is the two decisions below
 * held in state; these are the decisions.
 */

const rows = Array.from({ length: 70 }, (_, i) => i)

describe('currentReveal', () => {
  it('keeps what was revealed while the list is the same one', () => {
    const held = { key: 'q=wattle', count: 90 }
    expect(currentReveal(held, 'q=wattle', 30)).toBe(held)
  })

  it('starts again from one step when the list is a different one', () => {
    const held = { key: 'q=wattle', count: 90 }
    expect(currentReveal(held, 'q=wattleup', 30)).toEqual({
      key: 'q=wattleup',
      count: 30,
    })
  })
})

describe('revealView', () => {
  it('shows the first step, with more to come', () => {
    const view = revealView(rows, 24)
    expect(view.visible).toEqual(rows.slice(0, 24))
    expect(view.canLoadMore).toBe(true)
  })

  it('shows everything once the reveal reaches the end', () => {
    expect(revealView(rows, 72)).toEqual({ visible: rows, canLoadMore: false })
    expect(revealView(rows, 70)).toEqual({ visible: rows, canLoadMore: false })
  })

  it('has nothing more to show of an empty list', () => {
    expect(revealView([], 24)).toEqual({ visible: [], canLoadMore: false })
  })

  it('follows the rows as they change under the same reveal', () => {
    // A job booked while 48 are showing: still 48, the newest now among them.
    const grown = [-1, ...rows]
    const view = revealView(grown, 48)
    expect(view.visible).toHaveLength(48)
    expect(view.visible[0]).toBe(-1)
    expect(view.canLoadMore).toBe(true)
  })
})
