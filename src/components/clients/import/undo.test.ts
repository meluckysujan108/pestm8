import { describe, expect, it } from 'vitest'
import { UNDO_STUCK_MS } from '../../../../convex/lib/clientImport'
import {
  UNDO_ERROR_COPY,
  sightUndos,
  undoClock,
  undoHolding,
  undoRunning,
  undoStuck,
  undoUnderway,
} from './undo'

const NOW = 1_800_000_000_000

const standing = { undoneAt: undefined, undoState: undefined }
/** Asked `since` ago; its last step `stepped` ago, when one has run. */
const running = (since: number, stepped?: number) => ({
  undoneAt: NOW - since,
  undoState: 'running' as const,
  ...(stepped === undefined ? {} : { undoStepAt: NOW - stepped }),
})
const done = { undoneAt: NOW - 60_000, undoState: 'done' as const }
/** The page's clock with nothing learnt, once it is up. */
const clock = undoClock(NOW, undefined, true)

describe('undo, under way or stopped', () => {
  it('an undo is running from when it is asked for until it is done', () => {
    expect(undoRunning(standing)).toBe(false)
    expect(undoRunning(running(1_000))).toBe(true)
    expect(undoRunning(done)).toBe(false)
  })

  it('has stopped once no step has run for far too long', () => {
    // Before the first step, from when it was asked for.
    expect(undoStuck(running(UNDO_STUCK_MS + 1), NOW)).toBe(true)
    expect(undoStuck(running(UNDO_STUCK_MS - 1), NOW)).toBe(false)
    // After, from the last step: a long undo that is still moving isn't
    // stopped, however long ago it was asked for.
    expect(undoStuck(running(UNDO_STUCK_MS * 3, 5_000), NOW)).toBe(false)
    expect(undoStuck(running(UNDO_STUCK_MS * 3, UNDO_STUCK_MS + 1), NOW)).toBe(
      true,
    )
    expect(undoStuck(done, NOW + UNDO_STUCK_MS * 2)).toBe(false)
    expect(undoStuck(standing, NOW)).toBe(false)
  })

  it('an undo carried on reads as moving again, not stopped', () => {
    // Asked for long ago and stopped; carrying it on marks `undoStepAt`
    // (convex/clientImports.ts `undo`) and leaves `undoneAt` as it was.
    const stopped = running(UNDO_STUCK_MS * 2)
    expect(undoStuck(stopped, NOW)).toBe(true)
    const carriedOn = { ...stopped, undoStepAt: NOW - 1_000 }
    expect(undoStuck(carriedOn, NOW)).toBe(false)
    expect(undoHolding([carriedOn], clock)).toEqual({
      row: carriedOn,
      stopped: false,
    })
  })

  it('a new file waits for any undo not yet done, stopped ones too', () => {
    expect(undoUnderway(undefined)).toBe(false)
    expect(undoUnderway([standing, done])).toBe(false)
    expect(undoUnderway([standing, running(5_000)])).toBe(true)
    // A stopped undo still holds the rows a re-import would skip, and takes
    // them the moment it is carried on.
    expect(undoUnderway([running(UNDO_STUCK_MS + 1)])).toBe(true)
  })

  it('says which undo a new file is waiting for: a stopped one first', () => {
    expect(undoHolding(undefined, clock)).toBeNull()
    expect(undoHolding([standing, done], clock)).toBeNull()

    const moving = running(1_000)
    expect(undoHolding([standing, moving], clock)).toEqual({
      row: moving,
      stopped: false,
    })

    // A stopped one waits for someone to carry it on, so it is the one to
    // name, even behind one still moving.
    const stopped = running(UNDO_STUCK_MS + 1)
    expect(undoHolding([moving, stopped], clock)).toEqual({
      row: stopped,
      stopped: true,
    })
  })

  it('says what the server means when an undo is still moving', () => {
    expect(UNDO_ERROR_COPY.UNDO_RUNNING).toBe(
      'This undo is still going — give it a moment.',
    )
  })
})

describe('the page’s clock for its undos', () => {
  const MIN = 60_000
  const id = 'i1'
  /** One import, as the list says it: asked to be undone at `undoneAt`,
   * its last step at `undoStepAt` — both the server's times. */
  const listed = (undoneAt: number, undoStepAt?: number) => [
    {
      _id: id,
      undoneAt,
      undoState: 'running' as const,
      ...(undoStepAt === undefined ? {} : { undoStepAt }),
    },
  ]

  it('learns nothing from what is there at the first look', () => {
    // Asked for an hour ago, its last step 20 minutes ago: stopped, by the
    // server's clock and this one's alike.
    const rows = listed(NOW - 60 * MIN, NOW - 20 * MIN)
    const seen = sightUndos(null, rows, NOW)
    expect(seen.offset).toBeUndefined()
    // No change seen: judged by this device's clock as it stands.
    const judged = undoClock(NOW, seen.offset, true)
    expect(judged.now).toBe(NOW)
    expect(judged.stuck(rows[0])).toBe(true)
    // The same answer again is the same sighting.
    expect(sightUndos(seen, rows, NOW + 5 * MIN)).toBe(seen)
  })

  it('on a clock that runs fast, an undo still moving is not called stopped', () => {
    const FAST = 15 * MIN
    const server = NOW
    const device = () => server + FAST
    let seen = sightUndos(null, listed(server - MIN, server - 30_000), device())
    // Unlearnt, the device's clock alone calls it stopped — the bug.
    expect(undoClock(device(), seen.offset, true).stuck(seen.rows![0])).toBe(
      true,
    )
    // A step is seen to land, a second after the server marked it.
    const step = server + 60_000
    const rows = listed(server - MIN, step)
    seen = sightUndos(seen, rows, step + FAST + 1_000)
    expect(seen.offset).toBe(FAST + 1_000)
    const at = (deviceNow: number) => undoClock(deviceNow, seen.offset, true)
    expect(at(step + FAST + 1_000).stuck(rows[0])).toBe(false)
    // Stopped once no step has come for the server's ten minutes, as the
    // server would then let it be carried on.
    expect(at(step + FAST + UNDO_STUCK_MS).stuck(rows[0])).toBe(false)
    expect(at(step + FAST + 1_000 + UNDO_STUCK_MS + 1).stuck(rows[0])).toBe(
      true,
    )
  })

  it('on a clock that runs slow, an undo that has stopped is said so on time', () => {
    const SLOW = -15 * MIN
    const server = NOW
    let seen = sightUndos(null, listed(server - MIN), server + SLOW)
    const step = server + 30_000
    const rows = listed(server - MIN, step)
    seen = sightUndos(seen, rows, step + SLOW)
    expect(seen.offset).toBe(SLOW)
    // Ten minutes on, by this device's own clock, and no step since.
    const judged = undoClock(step + SLOW + UNDO_STUCK_MS + 1, seen.offset, true)
    expect(judged.now).toBe(step + UNDO_STUCK_MS + 1)
    expect(judged.stuck(rows[0])).toBe(true)
    // Unlearnt, it would read as moving for the 15 minutes more.
    expect(
      undoClock(step + SLOW + UNDO_STUCK_MS + 1, undefined, true).stuck(
        rows[0],
      ),
    ).toBe(false)
  })

  it('learns from an undo asked for while the page is open, before its first step', () => {
    const FAST = 12 * MIN
    const before = [{ _id: id, undoneAt: undefined, undoState: undefined }]
    let seen = sightUndos(null, before, NOW + FAST)
    const rows = listed(NOW + 5_000)
    seen = sightUndos(seen, rows, NOW + 5_000 + FAST + 200)
    expect(seen.offset).toBe(FAST + 200)
  })

  it('keeps the smallest reading: one heard late, after a sleep, says nothing new', () => {
    const FAST = 15 * MIN
    let seen = sightUndos(null, listed(NOW - MIN, NOW - 30_000), NOW + FAST)
    seen = sightUndos(seen, listed(NOW - MIN, NOW), NOW + FAST + 300)
    expect(seen.offset).toBe(FAST + 300)
    // The phone slept; the last step, 20 minutes before it woke, is heard
    // of only now. The undo has stopped since.
    const late = NOW + 60_000
    const rows = listed(NOW - MIN, late)
    seen = sightUndos(seen, rows, late + 20 * MIN + FAST)
    expect(seen.offset).toBe(FAST + 300)
    expect(
      undoClock(late + 20 * MIN + FAST, seen.offset, true).stuck(rows[0]),
    ).toBe(true)
  })

  it('a first reading heard late is caught by watching: stopped once the page has seen it stand still', () => {
    // The page saw the undo before its first step, then the laptop slept.
    // The undo's one step landed at 7:00 and it stopped there; the page
    // hears of that step only on waking two hours later — a reading two
    // hours too big.
    let seen = sightUndos(null, listed(NOW - MIN), NOW)
    const step = NOW + 60_000
    const rows = listed(NOW - MIN, step)
    const woke = step + 120 * MIN
    seen = sightUndos(seen, rows, woke)
    expect(seen.offset).toBe(120 * MIN)
    const at = (deviceNow: number) =>
      undoClock(deviceNow, seen.offset, true, seen.since)
    // By the (wrong) offset it still reads as moving...
    expect(at(woke + 5 * MIN).stuck(rows[0])).toBe(false)
    // ...but once the page has watched it make no progress for as long as
    // a stopped undo takes to call, it is stopped.
    expect(at(woke + UNDO_STUCK_MS + 1).stuck(rows[0])).toBe(true)
  })

  it('keeps the undo week on this device’s clock, whatever offset is learnt', () => {
    const judged = undoClock(NOW, 120 * MIN, true)
    expect(judged.now).toBe(NOW - 120 * MIN)
    expect(judged.deviceNow).toBe(NOW)
  })

  it('calls nothing stopped until the page is up', () => {
    const stopped = running(UNDO_STUCK_MS * 2)
    expect(undoClock(NOW, undefined, false).stuck(stopped)).toBe(false)
    expect(undoClock(NOW, undefined, true).stuck(stopped)).toBe(true)
    // So the server's render names it as moving, as every piece does.
    expect(undoHolding([stopped], undoClock(NOW, undefined, false))).toEqual({
      row: stopped,
      stopped: false,
    })
  })
})
