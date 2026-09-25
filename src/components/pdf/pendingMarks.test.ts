import { describe, expect, it } from 'vitest'
import {
  PENDING_FALLBACK_MS,
  byPage,
  dropMark,
  isTwin,
  markSaved,
  nextFallback,
  reconcile,
} from './pendingMarks'
import type { PendingMark, Strokes } from './pendingMarks'
import type { MarkupStroke } from './types'

/**
 * A finished stroke stays on the page until the marks that include it are
 * on screen: never a moment with neither (a blink), and never one left behind
 * for good. The trap is that the save can come back a render before or after
 * the marks that hold it.
 */

const POINTS = [
  { x: 0.1, y: 0.2 },
  { x: 0.3, y: 0.4 },
]

function drawn(key = 'pending-1', page = 0): PendingMark {
  return {
    key,
    page,
    points: POINTS,
    others: new Set(),
    saved: null,
    taken: null,
  }
}

function stroke(id: string, extra: Partial<MarkupStroke> = {}): MarkupStroke {
  return { id, points: [{ x: 0.9, y: 0.9 }], mine: true, order: 1, ...extra }
}

const BEFORE: Strokes = new Map([[0, [stroke('a')]]])
const AFTER: Strokes = new Map([
  [0, [stroke('a'), stroke('b', { points: [...POINTS] })]],
])

describe('pending marks', () => {
  it('stay while the save is out, whatever marks arrive', () => {
    const list = [drawn()]
    expect(reconcile(list, BEFORE, 0)).toBe(list)
    expect(reconcile(list, AFTER, 0)).toBe(list)
    expect(reconcile(list, AFTER, 60_000)).toBe(list)
  })

  it('stay after the save until newer marks arrive, when the save came back first', () => {
    // The save resolved with the old marks still on screen.
    const saved = markSaved([drawn()], 'pending-1', BEFORE, 1000, 'row-b')
    expect(saved).toHaveLength(1)
    // A re-render with the same marks changes nothing…
    expect(reconcile(saved, BEFORE, 1100)).toBe(saved)
    // …and the marks that hold the stroke take its place.
    expect(reconcile(saved, AFTER, 1200)).toHaveLength(0)
  })

  it('go at once when the marks on screen already hold the stroke', () => {
    // The marks arrived a render before the save came back, as Convex
    // usually orders them.
    expect(markSaved([drawn()], 'pending-1', AFTER, 1000, 'b')).toHaveLength(0)
  })

  it('know their stroke by the id the save hands back', () => {
    const renamed: Strokes = new Map([
      [0, [stroke('a'), stroke('row-7', { points: [{ x: 0.5, y: 0.5 }] })]],
    ])
    expect(markSaved([drawn()], 'pending-1', renamed, 1000, 'row-7')).toEqual(
      [],
    )
    expect(
      markSaved([drawn()], 'pending-1', renamed, 1000, 'row-8'),
    ).toHaveLength(1)
  })

  it('are not mistaken for a teammate’s identical stroke', () => {
    const theirs: Strokes = new Map([
      [0, [stroke('t', { points: [...POINTS], mine: false })]],
    ])
    expect(markSaved([drawn()], 'pending-1', theirs, 1000, 'b')).toHaveLength(1)
  })

  /** A dot tapped twice on one spot: the older one is not this one's twin. */
  it('are not let go for an older stroke of yours with the same points', () => {
    const older: Strokes = new Map([
      [0, [stroke('old', { points: [...POINTS] })]],
    ])
    expect(markSaved([drawn()], 'pending-1', older, 1000, 'new')).toHaveLength(
      1,
    )
  })

  it('go after the fallback if the marks never visibly change', () => {
    const saved = markSaved([drawn()], 'pending-1', BEFORE, 1000, 'row-b')
    expect(nextFallback(saved)).toBe(1000 + PENDING_FALLBACK_MS)
    expect(reconcile(saved, BEFORE, 1000 + PENDING_FALLBACK_MS - 1)).toBe(saved)
    expect(reconcile(saved, BEFORE, 1000 + PENDING_FALLBACK_MS)).toHaveLength(0)
  })

  it('go when the save fails, and only that one', () => {
    const list = [drawn('pending-1'), drawn('pending-2', 3)]
    expect(dropMark(list, 'pending-1')).toEqual([list[1]])
    expect(dropMark(list, 'pending-9')).toBe(list)
  })

  it('settle one at a time, each against the marks it came back to', () => {
    const list = markSaved(
      [drawn('pending-1'), drawn('pending-2')],
      'pending-1',
      BEFORE,
      1000,
      'row-b',
    )
    // The second is still saving, so newer marks let only the first go.
    const next = reconcile(list, new Map(BEFORE), 1100)
    expect(next.map((mark) => mark.key)).toEqual(['pending-2'])
    expect(nextFallback(next)).toBeNull()
  })

  it('are grouped by page for the page slots', () => {
    const pages = byPage([drawn('p1', 0), drawn('p2', 3), drawn('p3', 0)])
    expect(pages.get(0)?.map((mark) => mark.key)).toEqual(['p1', 'p3'])
    expect(pages.get(3)?.map((mark) => mark.key)).toEqual(['p2'])
    expect(pages.has(1)).toBe(false)
  })

  it('are not drawn once an Undo or a Clear has taken them back', () => {
    const pages = byPage([
      { ...drawn('p1', 0), taken: 'undo' },
      drawn('p2', 0),
      { ...drawn('p3', 3), taken: { clear: 1 } },
    ])
    expect(pages.get(0)?.map((mark) => mark.key)).toEqual(['p2'])
    expect(pages.has(3)).toBe(false)
  })

  it('know their twin by id once saved, and by their points before', () => {
    const twin = stroke('row-9', { points: [...POINTS] })
    expect(isTwin(twin, drawn())).toBe(true)
    expect(isTwin({ ...twin, mine: false }, drawn())).toBe(false)
    const moved = stroke('row-9')
    expect(isTwin(moved, drawn())).toBe(false)
    const saved: PendingMark = {
      ...drawn(),
      saved: { strokes: BEFORE, at: 0, id: 'row-9' },
    }
    expect(isTwin(moved, saved)).toBe(true)
    // Once named, only that id is it, whatever else has its points.
    expect(isTwin(stroke('row-2', { points: [...POINTS] }), saved)).toBe(false)
  })

  it('are never the twin of a stroke known to be another mark', () => {
    const older = stroke('row-1', { points: [...POINTS] })
    const mark: PendingMark = { ...drawn(), others: new Set(['row-1']) }
    expect(isTwin(older, mark)).toBe(false)
    expect(isTwin({ ...older, id: 'row-2' }, mark)).toBe(true)
  })
})
