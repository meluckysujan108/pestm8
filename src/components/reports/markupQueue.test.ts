import { describe, expect, test } from 'vitest'
import { ConvexError } from 'convex/values'
import { createMarkupQueue } from './markupQueue'
import type { AnnotationRow } from './reportPdfModel'
import type { MarkupPoint } from '#/components/pdf/types'

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
 * is how two taps land inside one round trip.
 *
 * The server's rules are `reportAnnotations.ts`'s: undo takes your newest
 * mark on the page it is given (the latest `createdAt`, and of two in one
 * millisecond the later-written); clear takes all of yours on the page.
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
    label: string
    apply: () => unknown
    resolve: (value: unknown) => void
    reject: (error: unknown) => void
  }> = []
  const log: Array<string> = []

  const send = (label: string, apply: () => unknown) =>
    new Promise<unknown>((resolve, reject) => {
      log.push(label)
      sent.push({ label, apply, resolve, reject })
    })

  return {
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
    undoLast: (page: number) =>
      send(`undo p${page}`, () => {
        let newest: AnnotationRow | null = null
        for (const row of server) {
          if (!row.mine || row.page !== page) continue
          if (!newest || row.createdAt >= newest.createdAt) newest = row
        }
        server = server.filter((row) => row !== newest)
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
        const result = next.apply()
        client = server
        next.resolve(result)
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

const mine = (id: string, page: number, createdAt: number) => ({
  id,
  page,
  createdAt,
  mine: true,
  authorColour: null,
})

describe('two Undo taps inside one round trip', () => {
  test('take your two newest marks, wherever they are — not an older one on the first page', async () => {
    // Yesterday's X on page 3; today A on page 2, then B on page 3.
    const convex = fakeConvex([
      mine('X', 3, 100),
      mine('A', 2, 200),
      mine('B', 3, 300),
    ])
    const queue = createMarkupQueue(convex)

    const first = queue.undo()
    const second = queue.undo()
    await convex.deliverAll()
    await Promise.all([first, second])

    expect(convex.ids()).toEqual(['X'])
    expect(convex.log).toEqual(['undo p3', 'undo p2'])
  })

  test('the second waits for the first to land before it chooses a page', async () => {
    // A on page 2, B on page 1, C on page 2 — C, then B, are the newest.
    const convex = fakeConvex([
      mine('A', 2, 1),
      mine('B', 1, 2),
      mine('C', 2, 3),
    ])
    const queue = createMarkupQueue(convex)

    void queue.undo()
    void queue.undo()
    await convex.deliverOne()
    // Only now, with C gone from this client's marks, is the second sent.
    expect(convex.log).toEqual(['undo p2', 'undo p1'])
    await convex.deliverAll()

    expect(convex.ids()).toEqual(['A'])
  })

  test('a colleague’s marks are never the target', async () => {
    const convex = fakeConvex([
      mine('A', 1, 1),
      { ...mine('Theirs', 2, 5), mine: false },
      mine('B', 3, 2),
    ])
    const queue = createMarkupQueue(convex)

    void queue.undo()
    void queue.undo()
    void queue.undo()
    await convex.deliverAll()

    expect(convex.ids()).toEqual(['Theirs'])
  })
})

describe('Undo and Clear in the order they were tapped', () => {
  test('Undo straight after Clear takes your newest mark left, not nothing', async () => {
    const convex = fakeConvex([mine('A', 1, 1), mine('B', 2, 2)])
    const queue = createMarkupQueue(convex)

    void queue.clearPage(1) // "Clear my marks on page 2"
    void queue.undo()
    await convex.deliverAll()

    expect(convex.log).toEqual(['clear p2', 'undo p1'])
    expect(convex.ids()).toEqual([])
  })

  test('Undo straight after a stroke still saving takes that stroke', async () => {
    const convex = fakeConvex([mine('A', 1, 1)])
    const queue = createMarkupQueue(convex)

    void queue.addStroke(1, POINTS)
    void queue.undo()
    await convex.deliverAll()

    expect(convex.log).toEqual(['add p2', 'undo p2'])
    expect(convex.ids()).toEqual(['A'])
  })

  test('a mark drawn while an Undo waits is not the one it takes', async () => {
    const convex = fakeConvex([mine('A', 1, 1)])
    const queue = createMarkupQueue(convex)

    void queue.undo()
    void queue.addStroke(0, POINTS)
    // Held back until the Undo has landed, so the server cannot see it as
    // the newest mark on page 1 and take it instead of A.
    await settle()
    expect(convex.log).toEqual(['undo p1'])
    await convex.deliverAll()

    expect(convex.log).toEqual(['undo p1', 'add p1'])
    expect(convex.ids()).toEqual(['new-1'])
  })

  test('a mark drawn straight after Clear survives it', async () => {
    const convex = fakeConvex([mine('A', 1, 1)])
    const queue = createMarkupQueue(convex)

    void queue.clearPage(0)
    void queue.addStroke(0, POINTS)
    await convex.deliverAll()

    expect(convex.log).toEqual(['clear p1', 'add p1'])
    expect(convex.ids()).toEqual(['new-1'])
  })

  test('strokes with nothing ahead of them are sent at once, side by side', async () => {
    const convex = fakeConvex([])
    const counts: Array<number> = []
    const queue = createMarkupQueue(convex, (count) => counts.push(count))

    void queue.addStroke(0, POINTS)
    void queue.addStroke(1, POINTS)
    await settle()
    expect(convex.waiting()).toBe(2)
    await convex.deliverAll()
    expect(counts).toEqual([1, 2, 1, 0])
  })
})

describe('failures', () => {
  test('a refused Undo says so, and the next one still runs', async () => {
    const convex = fakeConvex([mine('A', 1, 1), mine('B', 2, 2)])
    const queue = createMarkupQueue(convex)

    // Watched from the start: the refusal lands while the test waits.
    const refused = expect(queue.undo()).rejects.toThrow(
      'Your access doesn’t let you mark this report.',
    )
    const next = queue.undo()
    await convex.deliverOne(new ConvexError('NO_ACCESS'))
    await refused
    await convex.deliverAll()
    await next

    expect(convex.ids()).toEqual(['A'])
  })

  test('a refused Clear does not hold back what comes after it', async () => {
    const convex = fakeConvex([mine('A', 1, 1)])
    const queue = createMarkupQueue(convex)

    const cleared = expect(queue.clearPage(0)).rejects.toThrow(
      'Couldn’t clear your marks. Try again.',
    )
    const saved = queue.addStroke(1, POINTS)
    await convex.deliverOne(new Error('boom'))
    await cleared
    await convex.deliverAll()
    await saved

    expect(convex.ids()).toEqual(['A', 'new-1'])
  })

  test('a stroke with nothing drawable is refused before it is sent', async () => {
    const convex = fakeConvex([])
    const queue = createMarkupQueue(convex)

    await expect(queue.addStroke(0, [{ x: Number.NaN, y: 0 }])).rejects.toThrow(
      'That mark couldn’t be saved. Try drawing it again.',
    )
    expect(convex.log).toEqual([])
  })

  test('Undo with no marks of yours sends nothing', async () => {
    const convex = fakeConvex([{ ...mine('Theirs', 1, 1), mine: false }])
    const queue = createMarkupQueue(convex)

    await queue.undo()
    expect(convex.log).toEqual([])
  })
})
