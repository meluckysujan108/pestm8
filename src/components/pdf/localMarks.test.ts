import { describe, expect, it } from 'vitest'
import {
  NO_LOCAL_MARKS,
  clear,
  clearFailed,
  clearLanded,
  drawn,
  hasOwnMarks,
  removeFailed,
  removeLanded,
  saveFailed,
  saveLanded,
  sync,
  undo,
  visibleStrokes,
} from './localMarks'
import { byPage } from './pendingMarks'
import type { LocalMarks } from './localMarks'
import type { Strokes } from './pendingMarks'
import type { MarkupPoint, MarkupStroke } from './types'

/**
 * Undo and Clear decided at the tap, before the caller's marks have caught
 * up. The cases that lose work: an Undo that takes a mark drawn after it was
 * tapped, or an older mark when the one it meant never saved; two quick
 * Undos that take the same mark (so one of them takes nothing); and a mark
 * left on screen that the server has already cleared, or hidden when the
 * clear failed and it is still there.
 */

let drawnCount = 0
/** A stroke's own points: no two strokes here share them by accident. */
function line(): Array<MarkupPoint> {
  drawnCount += 1
  return [
    { x: drawnCount / 100, y: 0.1 },
    { x: drawnCount / 100, y: 0.2 },
  ]
}

function mine(id: string, order: number, points = line()): MarkupStroke {
  return { id, points, mine: true, order }
}

function theirs(id: string, order: number): MarkupStroke {
  return { id, points: line(), mine: false, order }
}

function marks(...pages: Array<[number, Array<MarkupStroke>]>): Strokes {
  return new Map(pages)
}

/** The ids drawn on each page, as a plain object for readable failures. */
function shown(strokes: Strokes, state: LocalMarks) {
  const out: Record<number, Array<string>> = {}
  for (const [page, list] of visibleStrokes(strokes, state)) {
    if (list.length) out[page] = list.map((s) => s.id)
  }
  return out
}

/** The keys of the strokes still saving that are drawn, by page. */
function drawnPending(state: LocalMarks) {
  const out: Record<number, Array<string>> = {}
  for (const [page, list] of byPage(state.pending)) {
    out[page] = list.map((m) => m.key)
  }
  return out
}

/**
 * Draws strokes still saving, in order: `[key, page]`. Each has a line of its
 * own, which no mark on screen shares, so what is on screen as it is drawn
 * does not matter here (it does in "marks with the same points").
 */
function drawAll(
  state: LocalMarks,
  ...strokes: Array<[string, number]>
): LocalMarks {
  return strokes.reduce(
    (s, [key, page]) => drawn(s, key, page, line(), undefined),
    state,
  )
}

describe('Undo chooses at the tap', () => {
  it('takes a stroke still saving off the screen at once, and names it when its save does', () => {
    const strokes = marks([0, [mine('old', 1)]])
    let state = drawAll(NO_LOCAL_MARKS, ['B', 0])

    const tap = undo(state, strokes)
    expect(tap?.remove).toBeNull()
    state = tap!.state
    expect(drawnPending(state)).toEqual({})
    expect(hasOwnMarks(state, strokes)).toBe(true) // "old" is still yours

    const landed = saveLanded(state, 'B', 'b', strokes, 10)
    expect(landed.remove).toBe('b')
    // Its stored twin arrives, and stays hidden while it is removed.
    const withB = marks([0, [mine('old', 1), mine('b', 2)]])
    expect(shown(withB, landed.state)).toEqual({ 0: ['old'] })
  })

  it('never takes a stroke drawn after it was tapped', () => {
    let state = drawAll(NO_LOCAL_MARKS, ['A', 0], ['B', 0])
    state = undo(state, marks())!.state // at B, still saving
    state = drawAll(state, ['C', 0]) // drawn while the Undo waits

    const landed = saveLanded(state, 'B', 'b', marks(), 10)
    expect(landed.remove).toBe('b')
    expect(drawnPending(landed.state)).toEqual({ 0: ['A', 'C'] })
  })

  /**
   * At a report's mark limit: the new stroke is refused ("This report is
   * full of marks") and a quick Undo meant for it must not delete a real one.
   */
  it('is spent, taking nothing, when the stroke it chose fails to save', () => {
    const strokes = marks([0, [mine('real', 1)]])
    let state = drawAll(NO_LOCAL_MARKS, ['B', 0])
    state = undo(state, strokes)!.state
    state = saveFailed(state, 'B')

    expect(state.pending).toEqual([])
    expect(state.hidden.size).toBe(0)
    expect(shown(strokes, state)).toEqual({ 0: ['real'] })
  })

  it('takes two different marks for two quick taps, and none twice', () => {
    const strokes = marks(
      [0, [mine('s1', 1)]],
      [2, [mine('s2', 2), theirs('t', 9)]],
    )
    let state = drawAll(NO_LOCAL_MARKS, ['A', 1], ['B', 1])
    const chosen: Array<string | null> = []
    for (let i = 0; i < 4; i++) {
      const tap = undo(state, strokes)
      state = tap!.state
      chosen.push(tap!.remove)
    }
    // B and A are still saving: named when they land.
    expect(chosen).toEqual([null, null, 's2', 's1'])
    expect(state.pending.map((m) => [m.key, m.taken])).toEqual([
      ['A', 'undo'],
      ['B', 'undo'],
    ])
    // Nothing of yours is left to take: the teammate's is never a target.
    expect(undo(state, strokes)).toBeNull()
    expect(hasOwnMarks(state, strokes)).toBe(false)
    expect(shown(strokes, state)).toEqual({ 2: ['t'] })
  })

  it('takes a saved stroke still drawn by its id, before the marks hold it', () => {
    let state = drawAll(NO_LOCAL_MARKS, ['A', 0])
    // The save is back; the marks that hold it are a render behind.
    state = saveLanded(state, 'A', 'a', marks(), 10).state
    expect(drawnPending(state)).toEqual({ 0: ['A'] })

    const tap = undo(state, marks())
    expect(tap?.remove).toBe('a')
    expect(drawnPending(tap!.state)).toEqual({})
    expect(shown(marks([0, [mine('a', 5)]]), tap!.state)).toEqual({})
  })

  /**
   * The marks can hold a stroke a moment before its save names it. Shown
   * there, it would be back on screen after its Undo — and the next Undo's
   * choice, so two taps would take one mark between them.
   */
  it('hides the twin of a stroke it took while saving, even before the save names it', () => {
    const points = line()
    let state = drawn(NO_LOCAL_MARKS, 'B', 0, points, marks())
    state = undo(state, marks())!.state
    const early = marks([0, [mine('old', 1), mine('b', 2, [...points])]])

    expect(shown(early, state)).toEqual({ 0: ['old'] })
    expect(undo(state, early)?.remove).toBe('old')
  })

  it('goes to your newest stored mark, by order, wherever it is', () => {
    const strokes = marks(
      [0, [mine('p1', 100), theirs('t', 900)]],
      [3, [mine('p4', 300)]],
      [1, [mine('p2', 200)]],
    )
    expect(undo(NO_LOCAL_MARKS, strokes)?.remove).toBe('p4')
  })

  it('of two in one millisecond, takes the later in the marks', () => {
    const strokes = marks([0, [mine('first', 500), mine('second', 500)]])
    expect(undo(NO_LOCAL_MARKS, strokes)?.remove).toBe('second')
  })

  it('has nothing to take with no marks of yours', () => {
    expect(undo(NO_LOCAL_MARKS, marks([0, [theirs('t', 1)]]))).toBeNull()
    expect(undo(NO_LOCAL_MARKS, undefined)).toBeNull()
    expect(hasOwnMarks(NO_LOCAL_MARKS, marks([0, [theirs('t', 1)]]))).toBe(
      false,
    )
  })
})

/**
 * A tap that does not move is a one-point stroke, and two taps on one spot
 * give exactly the same point: nothing between the finger and the record
 * rounds or moves it. So "your stroke with these points" is not enough to
 * know which mark a stroke still saving is — an older dot of yours on the
 * same spot has them too, and taking it for the twin would hide it, and the
 * next Undo would pass it over for a mark older still.
 */
describe('marks with the same points', () => {
  const DOT = [{ x: 0.5, y: 0.5 }]

  it('an Undo aimed at a dot still saving leaves your older dot on the spot alone', () => {
    const strokes = marks([0, [mine('s0', 1), mine('s1', 2, [...DOT])]])
    let state = drawn(NO_LOCAL_MARKS, 'A', 0, [...DOT], strokes)
    const first = undo(state, strokes)!
    expect(first.remove).toBeNull()
    state = first.state
    expect(shown(strokes, state)).toEqual({ 0: ['s0', 's1'] })

    // A's twin arrives before its save names it: that one, and only that
    // one, is hidden.
    const early = marks([
      0,
      [mine('s0', 1), mine('s1', 2, [...DOT]), mine('a', 3, [...DOT])],
    ])
    expect(shown(early, state)).toEqual({ 0: ['s0', 's1'] })

    const second = undo(state, early)!
    expect(second.remove).toBe('s1')
    const landed = saveLanded(second.state, 'A', 'a', early, 10)
    expect(landed.remove).toBe('a')
    expect(shown(early, landed.state)).toEqual({ 0: ['s0'] })
  })

  it('two dots drawn on one spot are each their own mark', () => {
    let state = drawn(NO_LOCAL_MARKS, 'A', 0, [...DOT], marks())
    state = drawn(state, 'B', 0, [...DOT], marks())
    state = undo(state, marks())!.state // at B, still saving

    // A saves, and the marks that hold it follow.
    state = saveLanded(state, 'A', 'a', marks(), 10).state
    const withA = marks([0, [mine('a', 1, [...DOT])]])
    state = sync(state, withA, 20)
    expect(state.pending.map((m) => m.key)).toEqual(['B'])

    // A is not B's twin: it is shown, and the next Undo's to take.
    expect(shown(withA, state)).toEqual({ 0: ['a'] })
    expect(undo(state, withA)?.remove).toBe('a')
  })

  it('a dot drawn on a spot whose stroke has saved, but not yet arrived, is its own mark', () => {
    let state = drawn(NO_LOCAL_MARKS, 'A', 0, [...DOT], marks())
    state = saveLanded(state, 'A', 'a', marks(), 10).state
    state = drawn(state, 'B', 0, [...DOT], marks())
    state = undo(state, marks())!.state // at B

    const withA = marks([0, [mine('a', 1, [...DOT])]])
    state = sync(state, withA, 20)
    expect(shown(withA, state)).toEqual({ 0: ['a'] })
    expect(undo(state, withA)?.remove).toBe('a')
  })
})

describe('a removal coming back', () => {
  const before = marks([0, [mine('a', 1), mine('b', 2)]])
  const after = marks([0, [mine('a', 1)]])

  it('keeps the mark hidden until the marks no longer hold it, then forgets it', () => {
    let state = undo(NO_LOCAL_MARKS, before)!.state
    state = removeLanded(state, 'b', before)
    expect(shown(before, state)).toEqual({ 0: ['a'] })
    expect(state.hidden.get('b')).toBe(true)

    state = sync(state, after, 0)
    expect(state.hidden.size).toBe(0)
  })

  it('forgets it at once when the marks have already caught up', () => {
    let state = undo(NO_LOCAL_MARKS, before)!.state
    state = removeLanded(state, 'b', after)
    expect(state.hidden.size).toBe(0)
  })

  it('shows the mark again when the removal fails', () => {
    let state = undo(NO_LOCAL_MARKS, before)!.state
    state = removeFailed(state, 'b')
    expect(shown(before, state)).toEqual({ 0: ['a', 'b'] })
    // And it is yours to Undo again.
    expect(undo(state, before)?.remove).toBe('b')
  })

  it('does not forget a mark whose removal is still out, whatever the marks say', () => {
    const state = undo(NO_LOCAL_MARKS, before)!.state
    expect(sync(state, after, 0)).toBe(state)
  })
})

describe('Clear hides the page at the tap', () => {
  const strokes = marks(
    [0, [mine('s0', 1)]],
    [1, [mine('s1', 2), theirs('t1', 3), mine('s1b', 4)]],
  )

  it('hides your marks on the page — stored, and still saving — and nobody else’s', () => {
    let state = drawAll(NO_LOCAL_MARKS, ['A', 1], ['B', 0])
    state = clear(state, 1, 1)

    expect(shown(strokes, state)).toEqual({ 0: ['s0'], 1: ['t1'] })
    expect(drawnPending(state)).toEqual({ 0: ['B'] })
    expect(hasOwnMarks(state, strokes, 1)).toBe(false)
    expect(hasOwnMarks(state, strokes, 0)).toBe(true)
  })

  it('leaves a stroke drawn after the tap on screen', () => {
    let state = clear(NO_LOCAL_MARKS, 1, 1)
    state = drawAll(state, ['C', 1])
    expect(drawnPending(state)).toEqual({ 1: ['C'] })
    expect(hasOwnMarks(state, strokes, 1)).toBe(true)
  })

  it('sweeps up a stroke that was saving there: its stored twin is never shown', () => {
    let state = drawAll(NO_LOCAL_MARKS, ['A', 1])
    state = clear(state, 1, 1)
    const landed = saveLanded(state, 'A', 'a', strokes, 10)
    expect(landed.remove).toBeNull()
    state = landed.state
    expect(state.pending).toEqual([])

    const withA = marks([1, [mine('s1', 2), mine('a', 5)]])
    expect(shown(withA, state)).toEqual({})
  })

  it('takes a stroke there that had saved already, with the page', () => {
    let state = drawAll(NO_LOCAL_MARKS, ['A', 1])
    state = saveLanded(state, 'A', 'a', marks(), 10).state
    state = clear(state, 1, 1)
    expect(state.pending).toEqual([])
    expect(shown(marks([1, [mine('a', 5)]]), state)).toEqual({})
  })

  it('once it lands, keeps the page’s marks hidden until the marks catch up', () => {
    let state = clear(NO_LOCAL_MARKS, 1, 1)
    state = clearLanded(state, 1, strokes)
    expect(state.clearing.size).toBe(0)
    expect(shown(strokes, state)).toEqual({ 0: ['s0'], 1: ['t1'] })

    const caughtUp = marks([0, [mine('s0', 1)]], [1, [theirs('t1', 3)]])
    state = sync(state, caughtUp, 0)
    expect(state.hidden.size).toBe(0)
    // A mark drawn there afterwards is shown: the clear is over.
    const later = marks([0, [mine('s0', 1)]], [1, [mine('new', 9)]])
    expect(shown(later, state)).toEqual({ 0: ['s0'], 1: ['new'] })
  })

  it('brings everything back when it fails', () => {
    let state = drawAll(NO_LOCAL_MARKS, ['A', 1])
    state = clear(state, 1, 1)
    state = clearFailed(state, 1)

    expect(state.clearing.size).toBe(0)
    expect(shown(strokes, state)).toEqual({
      0: ['s0'],
      1: ['s1', 't1', 's1b'],
    })
    expect(drawnPending(state)).toEqual({ 1: ['A'] })
  })

  it('a second clear of the page keeps it hidden when the first fails', () => {
    let state = clear(NO_LOCAL_MARKS, 1, 1)
    state = drawAll(state, ['C', 1])
    state = clear(state, 2, 1)
    state = clearFailed(state, 1)
    expect(shown(strokes, state)).toEqual({ 0: ['s0'], 1: ['t1'] })
    // C was the second clear's to take, and stays taken.
    expect(drawnPending(state)).toEqual({})
  })

  it('Undo straight after takes your newest mark left, not one being cleared', () => {
    const state = clear(NO_LOCAL_MARKS, 1, 1)
    expect(undo(state, strokes)?.remove).toBe('s0')
  })

  it('a failed Undo does not bring back a mark the clear took meanwhile', () => {
    let state = undo(NO_LOCAL_MARKS, strokes)!.state // s1b
    state = clear(state, 1, 1)
    state = clearLanded(state, 1, strokes)
    expect(removeFailed(state, 's1b')).toBe(state)
    expect(shown(strokes, state)).toEqual({ 0: ['s0'], 1: ['t1'] })
  })
})

describe('what is drawn', () => {
  it('is the caller’s own Map when nothing is being taken away', () => {
    const strokes = marks([0, [mine('a', 1)]])
    expect(visibleStrokes(strokes, NO_LOCAL_MARKS)).toBe(strokes)
    const other = undo(NO_LOCAL_MARKS, marks([4, [mine('x', 1)]]))!.state
    expect(visibleStrokes(strokes, other)).toBe(strokes)
  })

  it('keeps each untouched page’s own array, so its slot is not redrawn', () => {
    const page0 = [mine('a', 1)]
    const page1 = [mine('b', 2)]
    const strokes = marks([0, page0], [1, page1])
    const state = undo(NO_LOCAL_MARKS, strokes)!.state // b
    const visible = visibleStrokes(strokes, state)
    expect(visible).not.toBe(strokes)
    expect(visible.get(0)).toBe(page0)
    expect(visible.get(1)).toEqual([])
  })

  it('changes nothing for answers about strokes it has already let go', () => {
    const state = drawAll(NO_LOCAL_MARKS, ['A', 0])
    const gone = saveFailed(state, 'A')
    expect(saveFailed(gone, 'A')).toBe(gone)
    expect(saveLanded(gone, 'A', 'a', marks(), 0).state).toBe(gone)
    expect(clearLanded(gone, 7, marks())).toBe(gone)
    expect(clearFailed(gone, 7)).toBe(gone)
    expect(removeLanded(gone, 'zz', marks())).toBe(gone)
  })
})
