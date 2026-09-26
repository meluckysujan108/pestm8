import { describe, expect, test } from 'vitest'
import { ConvexError } from 'convex/values'
import {
  NO_LOCAL_MARKS,
  sync,
  visibleStrokes,
} from '#/components/pdf/localMarks'
import { createMarkupSession } from '#/components/pdf/markupSession'
import { byPage } from '#/components/pdf/pendingMarks'
import {
  createMarkupQueue,
  heldMarkupQueues,
  reportMarkupQueue,
} from './markupQueue'
import { strokesByPage } from './reportPdfModel'
import type { LocalMarks } from '#/components/pdf/localMarks'
import type { MarkupQueue, MarkupServer } from './markupQueue'
import type { AnnotationRow } from './reportPdfModel'
import type { MarkupPoint, MarkupStroke } from '#/components/pdf/types'

const POINTS: Array<MarkupPoint> = [
  { x: 0.1, y: 0.1 },
  { x: 0.3, y: 0.2 },
]

/** Lets every promise callback already queued run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Convex, as the queue meets it: mutations reach the server in the order they
 * are sent and run there one at a time, and each comes back only once this
 * client's copy of the marks includes it — the copy first, then the promise.
 * Nothing comes back until the test says the signal let it (`deliver`), which
 * is how a tap lands inside another's round trip.
 *
 * The server's rules are `reportAnnotations.ts`'s: remove takes the one mark
 * it names — refused if it is someone else's, nothing if it is already gone;
 * clear takes all of yours on the page, whenever they arrived.
 */
function fakeConvex(initial: Array<Omit<AnnotationRow, 'points'>>) {
  let clock = Math.max(0, ...initial.map((row) => row.createdAt))
  let written = 0
  let server: Array<AnnotationRow> = initial.map((row) => ({
    ...row,
    points: POINTS,
  }))
  let client = server
  const sent: Array<{
    apply: () => unknown
    resolve: (value: unknown) => void
    reject: (error: unknown) => void
  }> = []
  const log: Array<string> = []

  const send = <T>(label: string, apply: () => T) =>
    new Promise<T>((resolve, reject) => {
      log.push(label)
      sent.push({
        apply,
        resolve: resolve as (value: unknown) => void,
        reject,
      })
    })

  return {
    /** The marks as this client holds them: a new array only when they change. */
    rows: () => client,
    add: (page: number, points: Array<MarkupPoint>) =>
      send(`add p${page}`, () => {
        written += 1
        const row: AnnotationRow = {
          id: `new-${written}`,
          page,
          points,
          createdAt: ++clock,
          mine: true,
          authorColour: null,
        }
        server = [...server, row]
        return row.id
      }),
    remove: (strokeId: string) =>
      send(`remove ${strokeId}`, () => {
        const row = server.find((r) => r.id === strokeId)
        if (!row) return null
        if (!row.mine) throw new ConvexError('NO_ACCESS')
        server = server.filter((r) => r !== row)
        return null
      }),
    clearMine: (page: number) =>
      send(`clear p${page}`, () => {
        server = server.filter((row) => !(row.mine && row.page === page))
        return null
      }),
    /** Mutations sent so far, in order. */
    log,
    /** The oldest mutation still out runs, and its answer comes back. */
    async deliverOne(failWith?: unknown) {
      await settle()
      const next = sent.shift()
      if (!next) throw new Error('nothing was sent')
      if (failWith !== undefined) {
        next.reject(failWith)
      } else {
        try {
          const result = next.apply()
          client = server
          next.resolve(result)
        } catch (error) {
          next.reject(error)
        }
      }
      await settle()
    },
    /** Every mutation, including any sent while earlier ones came back. */
    async deliverAll() {
      await settle()
      while (sent.length > 0) await this.deliverOne()
    },
    ids: () => server.map((row) => row.id),
    waiting: () => sent.length,
  }
}

type FakeConvex = ReturnType<typeof fakeConvex>

const mine = (id: string, page: number, createdAt: number) => ({
  id,
  page,
  createdAt,
  mine: true,
  authorColour: null,
})

describe('Undo takes the mark it names', () => {
  test('two quick Undos take the two marks they named, wherever they are — not an older one on the first page', async () => {
    // Yesterday's X on page 3; today A on page 2, then B on page 3. The
    // viewer names B, then A; neither waits for the other.
    const convex = fakeConvex([
      mine('X', 3, 100),
      mine('A', 2, 200),
      mine('B', 3, 300),
    ])
    const queue = createMarkupQueue(convex)

    const first = queue.removeStroke('B')
    const second = queue.removeStroke('A')
    await settle()
    expect(convex.waiting()).toBe(2)
    await convex.deliverAll()
    await Promise.all([first, second])

    expect(convex.ids()).toEqual(['X'])
    expect(convex.log).toEqual(['remove B', 'remove A'])
  })

  test('a removal waits for nothing — not for saves, not for a Clear', async () => {
    const convex = fakeConvex([mine('A', 1, 1), mine('B', 2, 2)])
    const queue = createMarkupQueue(convex)

    void queue.addStroke(0, POINTS)
    void queue.clearPage(1)
    void queue.removeStroke('A')
    // Sent with nothing delivered yet: the Clear waits on the save, the
    // removal on neither.
    await settle()
    expect(convex.log).toContain('remove A')
    expect(convex.log).not.toContain('clear p2')
    await convex.deliverAll()

    expect(convex.log).toContain('clear p2')
    expect(convex.ids()).toEqual(['new-1'])
  })

  test('a colleague’s mark is refused, in words, and stays', async () => {
    const convex = fakeConvex([{ ...mine('Theirs', 1, 1), mine: false }])
    const queue = createMarkupQueue(convex)

    const refused = expect(queue.removeStroke('Theirs')).rejects.toThrow(
      'Your access doesn’t let you mark this report.',
    )
    await convex.deliverAll()
    await refused
    expect(convex.ids()).toEqual(['Theirs'])
  })

  test('a mark already gone is no failure', async () => {
    const convex = fakeConvex([mine('A', 1, 1)])
    const queue = createMarkupQueue(convex)

    const first = queue.removeStroke('A')
    const again = queue.removeStroke('A')
    await convex.deliverAll()
    await expect(Promise.all([first, again])).resolves.toBeDefined()
    expect(convex.ids()).toEqual([])
  })
})

/**
 * What the viewer does with the queue, spelled out: an Undo aimed at a
 * stroke still saving names it once `addStroke` resolves with its id.
 */
const undoOnceSaved = (queue: MarkupQueue, save: Promise<string>) =>
  save.then((id) => queue.removeStroke(id))

describe('the race Undo used to lose', () => {
  test('draw A, draw B, Undo at B while it saves, draw C meanwhile: B goes and C stays', async () => {
    const convex = fakeConvex([])
    const queue = createMarkupQueue(convex)

    void queue.addStroke(0, POINTS) // A
    const b = queue.addStroke(0, POINTS)
    const undone = undoOnceSaved(queue, b) // tapped now, at B
    void queue.addStroke(0, POINTS) // C, drawn during the wait
    await convex.deliverAll()
    await undone

    // C reached the server before the Undo did. "My newest on page 1" would
    // have taken it; by id, the Undo takes B.
    expect(convex.log).toEqual(['add p1', 'add p1', 'add p1', 'remove new-2'])
    expect(convex.ids()).toEqual(['new-1', 'new-3'])
  })

  test('Undo twice fast, both strokes still saving: the two newest go', async () => {
    const convex = fakeConvex([mine('X', 1, 1)])
    const queue = createMarkupQueue(convex)

    const a = queue.addStroke(0, POINTS)
    const b = queue.addStroke(1, POINTS)
    const undone = [undoOnceSaved(queue, b), undoOnceSaved(queue, a)]
    await convex.deliverAll()
    await Promise.all(undone)

    expect(convex.ids()).toEqual(['X'])
  })

  test('addStroke resolves with the saved mark’s id', async () => {
    const convex = fakeConvex([])
    const queue = createMarkupQueue(convex)

    const saved = queue.addStroke(2, POINTS)
    await convex.deliverAll()
    expect(await saved).toBe('new-1')
  })
})

describe('Clear keeps the order it was tapped in', () => {
  test('Clear, then draw straight away on the same page: the new mark survives', async () => {
    const convex = fakeConvex([mine('A', 1, 1)])
    const queue = createMarkupQueue(convex)

    void queue.clearPage(0)
    void queue.addStroke(0, POINTS)
    // Held back until the clear has landed, so it cannot be swept up in it.
    await settle()
    expect(convex.log).toEqual(['clear p1'])
    await convex.deliverAll()

    expect(convex.log).toEqual(['clear p1', 'add p1'])
    expect(convex.ids()).toEqual(['new-1'])
  })

  test('draw, then Clear before the save lands: the mark is cleared', async () => {
    const convex = fakeConvex([mine('A', 1, 1)])
    const queue = createMarkupQueue(convex)

    void queue.addStroke(0, POINTS)
    void queue.clearPage(0)
    // The clear waits for the save it was tapped after.
    await settle()
    expect(convex.log).toEqual(['add p1'])
    await convex.deliverAll()

    expect(convex.log).toEqual(['add p1', 'clear p1'])
    expect(convex.ids()).toEqual([])
  })

  test('a second Clear sweeps up a stroke held behind the first', async () => {
    const convex = fakeConvex([])
    const queue = createMarkupQueue(convex)

    void queue.clearPage(0)
    void queue.addStroke(0, POINTS) // after the first, before the second
    void queue.clearPage(0)
    await convex.deliverAll()

    expect(convex.log).toEqual(['clear p1', 'add p1', 'clear p1'])
    expect(convex.ids()).toEqual([])
  })

  test('strokes with nothing ahead of them are sent at once, side by side', async () => {
    const convex = fakeConvex([])
    const queue = createMarkupQueue(convex)

    void queue.addStroke(0, POINTS)
    void queue.addStroke(1, POINTS)
    await settle()
    expect(convex.waiting()).toBe(2)
    await convex.deliverAll()
    expect(convex.ids()).toEqual(['new-1', 'new-2'])
  })
})

describe('one queue per report, not per viewer', () => {
  // Each test names a report of its own: the queues are held for the app,
  // not for a test.

  test('closed and opened again while a Clear waits: a stroke drawn after it is sent after it, and survives', async () => {
    const convex = fakeConvex([])
    // The viewer that asked, and the one opened after it was closed.
    const first = reportMarkupQueue('b1/closed', convex)
    const second = reportMarkupQueue('b1/closed', convex)
    void first.addStroke(0, POINTS) // A, still saving on one bar of signal
    const cleared = first.clearPage(0) // waits for A
    const drawnAfter = second.addStroke(0, POINTS) // B, after the Clear

    await settle()
    expect(convex.log).toEqual(['add p1'])
    await convex.deliverAll()
    await cleared

    expect(convex.log).toEqual(['add p1', 'clear p1', 'add p1'])
    expect(convex.ids()).toEqual([await drawnAfter])
  })

  test('another report’s strokes do not wait on this one’s Clear', async () => {
    const convex = fakeConvex([])
    void reportMarkupQueue('b1/busy', convex).addStroke(0, POINTS)
    void reportMarkupQueue('b1/busy', convex).clearPage(0)
    void reportMarkupQueue('b1/other', convex).addStroke(0, POINTS)

    await settle()
    expect(convex.log).toEqual(['add p1', 'add p1'])
    await convex.deliverAll()
  })

  test('held while anything is out, and let go once nothing is, whichever way it went', async () => {
    const convex = fakeConvex([mine('X', 1, 1)])
    const queue = reportMarkupQueue('b1/released', convex)
    const before = heldMarkupQueues()

    // Nothing kept for an Undo, which keeps no order, or a stroke refused
    // before it is sent.
    const undone = queue.removeStroke('X')
    await expect(queue.addStroke(0, [])).rejects.toThrow()
    expect(heldMarkupQueues()).toBe(before)
    await convex.deliverAll()
    await undone

    void queue.addStroke(0, POINTS)
    const cleared = expect(queue.clearPage(0)).rejects.toThrow(
      'Your access doesn’t let you mark this report.',
    )
    expect(heldMarkupQueues()).toBe(before + 1)
    expect(queue.clearsUnderway().map((c) => c.pageIndex)).toEqual([0])

    await convex.deliverOne()
    expect(heldMarkupQueues()).toBe(before + 1)
    await convex.deliverOne(new ConvexError('NO_ACCESS'))
    await cleared

    expect(heldMarkupQueues()).toBe(before)
    expect(queue.clearsUnderway()).toEqual([])
  })

  test('what is sent next goes through the newest viewer’s way to Convex', async () => {
    const convex = fakeConvex([])
    const sentBy: Array<string> = []
    const through = (who: string): MarkupServer => ({
      add: (page, points) => {
        sentBy.push(who)
        return convex.add(page, points)
      },
      remove: convex.remove,
      clearMine: (page) => {
        sentBy.push(who)
        return convex.clearMine(page)
      },
    })
    const first = reportMarkupQueue('b1/newest', through('first'))
    void first.addStroke(0, POINTS)
    const cleared = first.clearPage(0)
    await settle() // the stroke is sent; the Clear waits for it
    const second = reportMarkupQueue('b1/newest', through('second'))
    void second.addStroke(0, POINTS)
    await convex.deliverAll()
    await cleared

    expect(sentBy).toEqual(['first', 'second', 'second'])
  })
})

describe('failures', () => {
  test('a refused Clear says so, and does not hold back what comes after it', async () => {
    const convex = fakeConvex([mine('A', 1, 1)])
    const queue = createMarkupQueue(convex)

    const cleared = expect(queue.clearPage(0)).rejects.toThrow(
      'Could not clear your marks. Try again.',
    )
    const saved = queue.addStroke(1, POINTS)
    await convex.deliverOne(new Error('boom'))
    await cleared
    await convex.deliverAll()
    await saved

    expect(convex.ids()).toEqual(['A', 'new-1'])
  })

  test('a Clear waits out a save that fails, and still runs', async () => {
    const convex = fakeConvex([mine('A', 1, 1)])
    const queue = createMarkupQueue(convex)

    const refused = expect(queue.addStroke(0, POINTS)).rejects.toThrow(
      'You’ve made as many marks as one person can on this report. Clear some of yours to add more.',
    )
    const cleared = queue.clearPage(0)
    await convex.deliverOne(new ConvexError('TOO_MANY_STROKES'))
    await refused
    await convex.deliverAll()
    await cleared

    expect(convex.ids()).toEqual([])
  })

  test('a refused removal says so in words for Undo', async () => {
    const convex = fakeConvex([mine('A', 1, 1)])
    const queue = createMarkupQueue(convex)

    const refused = expect(queue.removeStroke('A')).rejects.toThrow(
      'Could not undo your last mark. Try again.',
    )
    await convex.deliverOne(new Error('boom'))
    await refused
    expect(convex.ids()).toEqual(['A'])
  })

  test('a stroke with nothing drawable is refused before it is sent', async () => {
    const convex = fakeConvex([])
    const queue = createMarkupQueue(convex)

    await expect(queue.addStroke(0, [{ x: Number.NaN, y: 0 }])).rejects.toThrow(
      'That mark couldn’t be saved. Try drawing it again.',
    )
    expect(convex.log).toEqual([])
  })
})

/**
 * The viewer's own taps (`markupSession.ts`, choosing at the tap) in front of
 * this queue and the server: what the person sees, and what is stored, once
 * everything has landed. The marks on screen are this client's copy, drawn
 * as the viewer draws them.
 */
function viewerOn(
  convex: FakeConvex,
  queue: MarkupQueue = createMarkupQueue(convex),
) {
  let local: LocalMarks = NO_LOCAL_MARKS
  let rows: ReadonlyArray<AnnotationRow> | null = null
  let strokes: ReadonlyMap<number, ReadonlyArray<MarkupStroke>> = new Map()
  // A new Map only when the client's copy changes, as the hook's query does.
  const current = () => {
    if (convex.rows() !== rows) {
      rows = convex.rows()
      strokes = strokesByPage(rows)
    }
    return strokes
  }
  const toasts: Array<string> = []
  const session = createMarkupSession({
    markup: () => ({ strokes: current(), canDraw: true, ...queue }),
    strokes: current,
    read: () => local,
    commit: (next) => {
      local = next
    },
    toast: (message) => toasts.push(message),
    now: () => 0,
  })
  // As the viewer opens: any Clear an earlier one left out is taken over.
  session.takeOver(queue.clearsUnderway())
  return {
    session,
    toasts,
    /** Stored marks drawn, by id, and strokes drawn while they save — as
     * the next render draws them, once the hook has caught up (`sync`). */
    screen: () => {
      local = sync(local, current(), 0)
      const shown = visibleStrokes(current(), local)
      return {
        stored: [...shown.values()].flat().map((s) => s.id),
        saving: [...byPage(local.pending).values()].flat().length,
      }
    },
  }
}

describe('with the viewer in front', () => {
  test('draw A, draw B, Undo, draw C: A and C, on screen and stored', async () => {
    const convex = fakeConvex([])
    const viewer = viewerOn(convex)

    viewer.session.stroke(0, POINTS)
    viewer.session.stroke(0, POINTS)
    viewer.session.undo() // B, still saving: gone from the screen at once
    expect(viewer.screen()).toEqual({ stored: [], saving: 1 })
    viewer.session.stroke(0, POINTS)
    await convex.deliverAll()

    expect(convex.ids()).toEqual(['new-1', 'new-3'])
    expect(viewer.screen()).toEqual({ stored: ['new-1', 'new-3'], saving: 0 })
    expect(viewer.toasts).toEqual([])
  })

  test('Undo twice fast takes your two newest marks', async () => {
    const convex = fakeConvex([
      mine('X', 3, 100),
      mine('A', 2, 200),
      mine('B', 3, 300),
    ])
    const viewer = viewerOn(convex)

    viewer.session.undo()
    viewer.session.undo()
    expect(viewer.screen().stored).toEqual(['X'])
    await convex.deliverAll()

    expect(convex.ids()).toEqual(['X'])
    expect(viewer.screen().stored).toEqual(['X'])
  })

  test('Clear, then draw on the same page at once: the new mark survives', async () => {
    const convex = fakeConvex([mine('A', 1, 1), mine('P2', 2, 2)])
    const viewer = viewerOn(convex)

    viewer.session.clear(0)
    viewer.session.stroke(0, POINTS)
    expect(viewer.screen()).toEqual({ stored: ['P2'], saving: 1 })
    await convex.deliverAll()

    expect(convex.ids()).toEqual(['P2', 'new-1'])
    expect(viewer.screen()).toEqual({ stored: ['P2', 'new-1'], saving: 0 })
  })

  test('draw, then Clear before the save lands: the mark is cleared', async () => {
    const convex = fakeConvex([mine('A', 1, 1)])
    const viewer = viewerOn(convex)

    viewer.session.stroke(0, POINTS)
    viewer.session.clear(0)
    expect(viewer.screen()).toEqual({ stored: [], saving: 0 })
    // The save lands first and the page stays empty while the clear runs.
    await convex.deliverOne()
    expect(viewer.screen()).toEqual({ stored: [], saving: 0 })
    await convex.deliverAll()

    expect(convex.ids()).toEqual([])
    expect(viewer.screen()).toEqual({ stored: [], saving: 0 })
  })

  test('Undo straight after Clear takes your newest mark left, not nothing', async () => {
    const convex = fakeConvex([mine('A', 1, 1), mine('B', 2, 2)])
    const viewer = viewerOn(convex)

    viewer.session.clear(1) // "Clear my marks on page 2"
    viewer.session.undo()
    await convex.deliverAll()

    // The Undo passed over B, which the Clear is taking. (Its removal goes
    // out at once; the Clear a moment later, once nothing is ahead of it.)
    expect(convex.log).toEqual(['remove A', 'clear p2'])
    expect(convex.ids()).toEqual([])
  })

  /**
   * Done, then View PDF, while a Clear still waits on a save — one bar of
   * signal. The reopened viewer is a new session over the same report's
   * queue: the page it was cleared from stays empty, not showing again the
   * marks on their way out, and a stroke drawn there now waits for the Clear
   * and outlives it, rather than going first and being swept away with no
   * word said.
   */
  test('closed and reopened while a Clear waits: the page stays cleared, and a stroke drawn after it survives', async () => {
    const convex = fakeConvex([mine('A', 1, 1), mine('P2', 2, 2)])
    const first = viewerOn(convex, reportMarkupQueue('b1/reopened', convex))
    first.session.stroke(0, POINTS) // B, still saving
    first.session.clear(0) // "Clear my marks on page 1", waiting for B
    expect(first.screen()).toEqual({ stored: ['P2'], saving: 0 })

    // Done, then View PDF.
    const second = viewerOn(convex, reportMarkupQueue('b1/reopened', convex))
    expect(second.screen()).toEqual({ stored: ['P2'], saving: 0 })
    second.session.stroke(0, POINTS) // C, drawn after the Clear
    await settle()
    expect(convex.log).toEqual(['add p1'])

    // B lands, the Clear goes out behind it, and C behind that.
    await convex.deliverOne()
    expect(second.screen()).toEqual({ stored: ['P2'], saving: 1 })
    await convex.deliverAll()

    expect(convex.log).toEqual(['add p1', 'clear p1', 'add p1'])
    expect(convex.ids()).toEqual(['P2', 'new-2'])
    expect(second.screen()).toEqual({ stored: ['P2', 'new-2'], saving: 0 })
    expect(second.toasts).toEqual([])
  })

  test('an Undo aimed at a stroke the server refuses is spent: no older mark goes', async () => {
    const convex = fakeConvex([mine('Real', 1, 1)])
    const viewer = viewerOn(convex)

    viewer.session.stroke(0, POINTS)
    viewer.session.undo()
    await convex.deliverOne(new ConvexError('TOO_MANY_STROKES'))
    await convex.deliverAll()

    expect(convex.log).toEqual(['add p1'])
    expect(convex.ids()).toEqual(['Real'])
    expect(viewer.screen()).toEqual({ stored: ['Real'], saving: 0 })
    expect(viewer.toasts).toEqual([
      'You’ve made as many marks as one person can on this report. Clear some of yours to add more.',
    ])
  })
})
