import { describe, expect, it } from 'vitest'
import { NO_LOCAL_MARKS, visibleStrokes } from './localMarks'
import { createMarkupSession } from './markupSession'
import { byPage } from './pendingMarks'
import type { LocalMarks } from './localMarks'
import type { Strokes } from './pendingMarks'
import type { MarkupStroke, ViewerMarkup } from './types'

/**
 * The pen's acts against a caller that answers only when the test says so —
 * which is how a stroke is drawn, or Undo tapped, while another is still on
 * its way. What is checked is what the caller is asked to do, and when:
 * `removeStroke` for exactly the mark the Undo was aimed at, `clearPage` the
 * moment Clear is confirmed, and nothing at all for an Undo whose stroke
 * never saved.
 */

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Lets every queued promise callback run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const POINTS = [
  { x: 0.1, y: 0.1 },
  { x: 0.2, y: 0.2 },
]

function stored(id: string, order: number): MarkupStroke {
  return { id, points: [{ x: order / 100, y: 0.5 }], mine: true, order }
}

function harness(initial: Strokes = new Map()) {
  let local: LocalMarks = NO_LOCAL_MARKS
  let strokes: Strokes | undefined = initial
  let present = true
  const toasts: Array<string> = []
  const urgent: Array<boolean> = []
  const saves: Array<Deferred<string>> = []
  const removals: Array<{ id: string; answer: Deferred<void> }> = []
  const clears: Array<{ page: number; answer: Deferred<void> }> = []

  const markup: ViewerMarkup = {
    strokes: initial,
    canDraw: true,
    addStroke: () => {
      const save = deferred<string>()
      saves.push(save)
      return save.promise
    },
    removeStroke: (id) => {
      const answer = deferred<void>()
      removals.push({ id, answer })
      return answer.promise
    },
    clearPage: (page) => {
      const answer = deferred<void>()
      clears.push({ page, answer })
      return answer.promise
    },
  }

  const session = createMarkupSession({
    markup: () => (present ? markup : undefined),
    strokes: () => strokes,
    read: () => local,
    commit: (next, isUrgent) => {
      local = next
      urgent.push(!!isUrgent)
    },
    toast: (message) => toasts.push(message),
    now: () => 0,
  })

  return {
    session,
    markup,
    saves,
    removals,
    clears,
    toasts,
    urgent,
    local: () => local,
    setStrokes: (next: Strokes) => {
      strokes = next
    },
    goAway: () => {
      present = false
    },
    /** What is drawn: the caller's marks still showing, and strokes saving. */
    drawnNow: () => ({
      stored: [...visibleStrokes(strokes ?? new Map(), local).values()]
        .flat()
        .map((s) => s.id),
      saving: [...byPage(local.pending).values()].flat().map((m) => m.key),
    }),
  }
}

describe('Undo', () => {
  it('removes the stroke it was tapped over, not one drawn while it waited', async () => {
    const h = harness()
    h.session.stroke(0, POINTS) // B
    h.session.undo() // at B, still saving
    h.session.stroke(0, POINTS) // C, drawn while the Undo waits
    expect(h.drawnNow().saving).toEqual(['pending-2'])

    // C's save may come back first; it is not the Undo's.
    h.saves[1].resolve('c')
    await flush()
    expect(h.removals).toEqual([])
    h.saves[0].resolve('b')
    await flush()
    expect(h.removals.map((r) => r.id)).toEqual(['b'])
  })

  it('is spent when that stroke fails to save: nothing removed, and only the save says so', async () => {
    const h = harness(new Map([[0, [stored('real', 1)]]]))
    h.session.stroke(0, POINTS)
    h.session.undo()
    h.saves[0].reject(new Error('This report is full of marks.'))
    await flush()

    expect(h.removals).toEqual([])
    expect(h.toasts).toEqual(['This report is full of marks.'])
    expect(h.drawnNow()).toEqual({ stored: ['real'], saving: [] })
  })

  it('removes a stored mark at once, hidden while it goes', async () => {
    const h = harness(new Map([[2, [stored('a', 1), stored('b', 2)]]]))
    h.session.undo()
    expect(h.removals.map((r) => r.id)).toEqual(['b'])
    expect(h.drawnNow().stored).toEqual(['a'])

    h.removals[0].answer.resolve()
    await flush()
    // The marks have not caught up yet: still hidden.
    expect(h.drawnNow().stored).toEqual(['a'])
    expect(h.toasts).toEqual([])
  })

  it('shows the mark again, and says so, when it cannot be removed', async () => {
    const h = harness(new Map([[0, [stored('a', 1)]]]))
    h.session.undo()
    h.removals[0].answer.reject(new Error(''))
    await flush()

    expect(h.drawnNow().stored).toEqual(['a'])
    expect(h.toasts).toEqual(['Could not undo your last mark.'])
  })

  /** Nothing comes back, so there is nothing to apologise for: the page's
   * Clear took the mark while its removal was out. */
  it('says nothing when a removal fails for a mark a Clear has taken meanwhile', async () => {
    const h = harness(new Map([[1, [stored('a', 1)]]]))
    h.session.undo()
    h.session.clear(1)
    h.clears[0].answer.resolve()
    await flush()
    h.removals[0].answer.reject(new Error('offline'))
    await flush()

    expect(h.toasts).toEqual([])
    expect(h.drawnNow().stored).toEqual([])
  })

  it('takes two marks for two quick taps', async () => {
    const h = harness(new Map([[0, [stored('a', 1), stored('b', 2)]]]))
    h.session.undo()
    h.session.undo()
    h.session.undo()
    expect(h.removals.map((r) => r.id)).toEqual(['b', 'a'])
  })

  /**
   * A tap that does not move is a one-point stroke, so two taps on one spot
   * are the same points exactly. The older dot is not the new one's twin:
   * two quick Undos take the new dot and then the older one — never a mark
   * older still, which nothing could bring back.
   */
  it('takes a dot still saving and then your older dot on the same spot', async () => {
    const dot = [{ x: 0.5, y: 0.5 }]
    const h = harness(
      new Map([[0, [stored('s0', 1), { ...stored('s1', 2), points: dot }]]]),
    )
    h.session.stroke(0, [...dot]) // A
    h.session.undo() // at A, still saving
    expect(h.drawnNow()).toEqual({ stored: ['s0', 's1'], saving: [] })
    h.session.undo()
    expect(h.removals.map((r) => r.id)).toEqual(['s1'])

    h.saves[0].resolve('a')
    await flush()
    expect(h.removals.map((r) => r.id)).toEqual(['s1', 'a'])
    expect(h.drawnNow()).toEqual({ stored: ['s0'], saving: [] })
  })

  it('does nothing once the markup has gone', () => {
    const h = harness(new Map([[0, [stored('a', 1)]]]))
    h.goAway()
    h.session.undo()
    expect(h.removals).toEqual([])
    expect(h.local()).toBe(NO_LOCAL_MARKS)
  })
})

describe('Clear', () => {
  it('is handed over the moment it is confirmed, strokes still saving or not', () => {
    const h = harness(new Map([[1, [stored('a', 1)]]]))
    h.session.stroke(1, POINTS)
    h.session.clear(1)
    expect(h.clears.map((c) => c.page)).toEqual([1])
    expect(h.drawnNow()).toEqual({ stored: [], saving: [] })
  })

  it('leaves a stroke drawn after it on screen', () => {
    const h = harness(new Map([[1, [stored('a', 1)]]]))
    h.session.clear(1)
    h.session.stroke(1, POINTS)
    expect(h.drawnNow().saving).toEqual(['pending-1'])
  })

  it('brings the page back, and says which, when it fails', async () => {
    const h = harness(new Map([[1, [stored('a', 1)]]]))
    h.session.stroke(1, POINTS)
    h.session.clear(1)
    h.clears[0].answer.reject(new Error(''))
    await flush()

    expect(h.drawnNow()).toEqual({ stored: ['a'], saving: ['pending-1'] })
    expect(h.toasts).toEqual(['Could not clear your marks on page 2.'])
  })

  it('keeps the page hidden once it lands, until the marks catch up', async () => {
    const h = harness(new Map([[1, [stored('a', 1)]]]))
    h.session.clear(1)
    h.clears[0].answer.resolve()
    await flush()
    expect(h.local().clearing.size).toBe(0)
    expect(h.drawnNow().stored).toEqual([])
  })
})

/**
 * The viewer was closed and opened again while a Clear it asked for was still
 * out. The caller hands the new viewer that Clear (`clearsUnderway`); its
 * page stays hidden until it lands, as it would have in the viewer that
 * asked, and nothing drawn in this one is swept up with it.
 */
describe('a Clear taken over from a viewer since closed', () => {
  const underway = (pageIndex: number) => {
    const answer = deferred<void>()
    return { answer, clear: { pageIndex, done: answer.promise } }
  }

  it('hides its page until it lands, and spares a stroke drawn here', async () => {
    const h = harness(
      new Map([
        [1, [stored('a', 1)]],
        [0, [stored('b', 2)]],
      ]),
    )
    const out = underway(1)
    h.session.takeOver([out.clear])
    expect(h.drawnNow()).toEqual({ stored: ['b'], saving: [] })
    h.session.stroke(1, POINTS)
    expect(h.drawnNow()).toEqual({ stored: ['b'], saving: ['pending-1'] })

    out.answer.resolve()
    await flush()
    // Landed: until the marks catch up, the cleared mark stays hidden.
    expect(h.local().clearing.size).toBe(0)
    expect(h.drawnNow()).toEqual({ stored: ['b'], saving: ['pending-1'] })
    expect(h.toasts).toEqual([])
  })

  it('brings the page back, and says so here, when it fails', async () => {
    const h = harness(new Map([[1, [stored('a', 1)]]]))
    const out = underway(1)
    h.session.takeOver([out.clear])
    out.answer.reject(new Error(''))
    await flush()

    expect(h.drawnNow().stored).toEqual(['a'])
    expect(h.toasts).toEqual(['Could not clear your marks on page 2.'])
  })

  it('is taken over once, and a Clear asked for here never', async () => {
    const h = harness(new Map([[1, [stored('a', 1)]]]))
    h.session.clear(1)
    const own = { pageIndex: 1, done: h.clears[0].answer.promise }
    const before = h.local()
    h.session.takeOver([own])
    expect(h.local()).toBe(before)

    const out = underway(0)
    h.session.takeOver([out.clear, own])
    h.session.takeOver([out.clear])
    expect([...h.local().clearing.values()]).toEqual([1, 0])

    // Its own Clear failing is said once, not once for each time it was seen.
    h.clears[0].answer.reject(new Error(''))
    out.answer.resolve()
    await flush()
    expect(h.toasts).toEqual(['Could not clear your marks on page 2.'])
  })
})

describe('strokes', () => {
  it('are on screen before the pen lets go of its own line', () => {
    const h = harness()
    h.session.stroke(0, POINTS)
    expect(h.urgent).toEqual([true])
    expect(h.drawnNow().saving).toEqual(['pending-1'])
  })

  it('that fail say so in the caller’s words, or the viewer’s', async () => {
    const h = harness()
    h.session.stroke(0, POINTS)
    h.session.stroke(0, POINTS)
    h.saves[0].reject(new Error('This report is full of marks.'))
    h.saves[1].reject(new Error(' '))
    await flush()
    expect(h.toasts).toEqual([
      'This report is full of marks.',
      "Your mark didn't save.",
    ])
  })

  it('a caller that throws instead of rejecting is a failure like any other', async () => {
    const h = harness()
    h.markup.addStroke = () => {
      throw new Error('boom')
    }
    h.session.stroke(0, POINTS)
    await flush()
    expect(h.toasts).toEqual(['boom'])
    expect(h.drawnNow().saving).toEqual([])
  })
})
