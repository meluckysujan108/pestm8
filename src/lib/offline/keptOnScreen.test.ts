import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  KEPT_AFTER_DOWN_MS,
  KEPT_GONE_MS,
  ON_PAGE,
  ON_SCREEN_MARGIN,
  ON_SCREEN_SHARE,
  keptShowing,
  nextNoteHold,
  noteSaysKept,
  observeOnScreen,
  showKept,
  subscribeKept,
} from './keptOnScreen'
import { QUERY_WAIT_MS, noticeOverKept } from '#/lib/reach'
import type { NoteHold } from './keptOnScreen'
import type { KeptNote } from './useKept'
import type { ReachNoticeModel } from '#/lib/reach'

/**
 * Where a line saying the screen is the kept copy is showing, which the
 * can't-reach notice gives way to: the page, or one sheet, counted while any
 * shows there and for a moment after the last goes.
 */

const SHEET = 'sheet-a'
const OTHER_SHEET = 'sheet-b'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  // Whatever a test left lingering goes before the next.
  vi.advanceTimersByTime(KEPT_GONE_MS)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the places a kept line shows (`showKept`)', () => {
  test('a place counts from the line showing, and a moment after it goes', () => {
    expect(keptShowing(ON_PAGE)).toBe(false)
    const gone = showKept(ON_PAGE)
    expect(keptShowing(ON_PAGE)).toBe(true)
    gone()
    expect(keptShowing(ON_PAGE)).toBe(true)
    vi.advanceTimersByTime(KEPT_GONE_MS - 1)
    expect(keptShowing(ON_PAGE)).toBe(true)
    vi.advanceTimersByTime(1)
    expect(keptShowing(ON_PAGE)).toBe(false)
  })

  test('the moment after is longer than ConnectionNotice takes between looks', () => {
    expect(KEPT_GONE_MS).toBeGreaterThan(1_000)
  })

  test('each place is its own: a page’s note says nothing about a sheet, nor one sheet about another', () => {
    const gone = showKept(ON_PAGE)
    expect(keptShowing(SHEET)).toBe(false)
    const sheetGone = showKept(SHEET)
    expect(keptShowing(SHEET)).toBe(true)
    expect(keptShowing(OTHER_SHEET)).toBe(false)
    gone()
    sheetGone()
  })

  test('several at one place count until the last has gone', () => {
    const first = showKept(SHEET)
    const second = showKept(SHEET)
    first()
    vi.advanceTimersByTime(KEPT_GONE_MS * 2)
    expect(keptShowing(SHEET)).toBe(true)
    second()
    vi.advanceTimersByTime(KEPT_GONE_MS)
    expect(keptShowing(SHEET)).toBe(false)
  })

  test('saying it has gone twice counts once', () => {
    const first = showKept(SHEET)
    const second = showKept(SHEET)
    first()
    first()
    vi.advanceTimersByTime(KEPT_GONE_MS)
    expect(keptShowing(SHEET)).toBe(true)
    second()
  })

  test('a line back within the moment after keeps the place counted, and starts its moment again once it goes', () => {
    showKept(ON_PAGE)()
    vi.advanceTimersByTime(KEPT_GONE_MS - 100)
    const again = showKept(ON_PAGE)
    vi.advanceTimersByTime(KEPT_GONE_MS)
    expect(keptShowing(ON_PAGE)).toBe(true)
    again()
    vi.advanceTimersByTime(KEPT_GONE_MS - 1)
    expect(keptShowing(ON_PAGE)).toBe(true)
    vi.advanceTimersByTime(1)
    expect(keptShowing(ON_PAGE)).toBe(false)
  })

  test('listeners hear when a place starts counting and when it stops, and nothing in between', () => {
    const heard = vi.fn()
    const stop = subscribeKept(heard)
    const first = showKept(SHEET)
    expect(heard).toHaveBeenCalledTimes(1)
    const second = showKept(SHEET)
    first()
    second()
    expect(heard).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(KEPT_GONE_MS)
    expect(heard).toHaveBeenCalledTimes(2)
    stop()
    showKept(SHEET)()
    vi.advanceTimersByTime(KEPT_GONE_MS)
    expect(heard).toHaveBeenCalledTimes(2)
  })
})

describe('when the note says the line is down (`noteSaysKept`)', () => {
  test('"No signal — …" and "Could not reach PestM8 — …", once shown', () => {
    expect(noteSaysKept({ phase: 'shown', tone: 'no-signal' })).toBe(true)
    expect(noteSaysKept({ phase: 'shown', tone: 'unreachable' })).toBe(true)
  })

  test('not "Showing the copy kept on this phone.", which says nothing of the line, nor "Up to date."', () => {
    expect(noteSaysKept({ phase: 'shown', tone: 'kept' })).toBe(false)
    expect(noteSaysKept({ phase: 'shown', tone: 'live' })).toBe(false)
  })

  test('not while hydrating, nor hidden or gone', () => {
    expect(noteSaysKept({ phase: 'hydrating', tone: 'kept' })).toBe(false)
    expect(noteSaysKept({ phase: 'hydrating', tone: 'no-signal' })).toBe(false)
    expect(noteSaysKept({ phase: 'hidden', tone: 'no-signal' })).toBe(false)
    expect(noteSaysKept({ phase: 'hidden', tone: 'unreachable' })).toBe(false)
  })
})

describe('the banner over a kept page', () => {
  const NOTICE: ReachNoticeModel = {
    online: false,
    waitingToSave: false,
    updated: '9:42am',
    action: 'try',
    onTry: () => {},
    onReload: () => {},
    onDismiss: () => {},
  }
  const onPage = (notice: ReachNoticeModel) =>
    noticeOverKept(notice, keptShowing(ON_PAGE))

  test('a note saying no signal holds back a notice waiting only on reads, and lets one back once it has gone', () => {
    expect(onPage(NOTICE)).toBe(NOTICE)
    const gone = showKept(ON_PAGE)
    expect(onPage(NOTICE)).toBeNull()
    gone()
    // A notice the line coming back has made stale goes at the next look.
    expect(onPage(NOTICE)).toBeNull()
    vi.advanceTimersByTime(KEPT_GONE_MS)
    expect(onPage(NOTICE)).toBe(NOTICE)
  })

  test('a change waiting to save is always said', () => {
    const saving = { ...NOTICE, waitingToSave: true }
    const gone = showKept(ON_PAGE)
    expect(onPage(saving)).toBe(saving)
    gone()
  })

  test('a kept view in a sheet holds back that sheet’s notice, not the page’s', () => {
    const gone = showKept(SHEET)
    expect(noticeOverKept(NOTICE, keptShowing(SHEET))).toBeNull()
    expect(onPage(NOTICE)).toBe(NOTICE)
    gone()
  })

  test('a note on the page behind a sheet with no kept view leaves the sheet’s notice up', () => {
    const gone = showKept(ON_PAGE)
    expect(noticeOverKept(NOTICE, keptShowing(OTHER_SHEET))).toBe(NOTICE)
    gone()
  })
})

describe('what the note holds the notice back for (`nextNoteHold`)', () => {
  type Note = Pick<KeptNote, 'phase' | 'tone'>
  const shown = (tone: Note['tone']): Note => ({ phase: 'shown', tone })

  /** The holds a note's words make in turn, each a second after the last. */
  function holds(notes: Array<Note>, from: NoteHold = null): Array<NoteHold> {
    const seen: Array<NoteHold> = []
    let hold = from
    notes.forEach((note, i) => {
      hold = nextNoteHold(hold, note, 1_000 * (i + 1))
      seen.push(hold)
    })
    return seen
  }

  test('no signal, then "Showing the copy kept on this phone." as the socket opens, then "Up to date."', () => {
    expect(
      holds([shown('no-signal'), shown('kept'), shown('kept'), shown('live')]),
    ).toEqual(['down', { keptFrom: 2_000 }, { keptFrom: 2_000 }, null])
  })

  test('could not reach PestM8 holds as no signal does, and so does what follows it', () => {
    expect(holds([shown('unreachable'), shown('kept')])).toEqual([
      'down',
      { keptFrom: 2_000 },
    ])
  })

  test('the same hold back while the words stay, so a render can set it each time', () => {
    const after = nextNoteHold('down', shown('kept'), 5_000)
    expect(nextNoteHold(after, shown('kept'), 9_000)).toBe(after)
  })

  test('a note that has only said "Showing the copy kept on this phone." holds nothing: an open socket that never answers gets its notice', () => {
    expect(holds([shown('kept'), shown('kept')])).toEqual([null, null])
    // Nor once "Up to date." has come between.
    expect(
      holds([shown('no-signal'), shown('kept'), shown('live'), shown('kept')]),
    ).toEqual(['down', { keptFrom: 2_000 }, null, null])
  })

  test('the line down again starts it over, and the next return is timed afresh', () => {
    expect(
      holds([
        shown('no-signal'),
        shown('kept'),
        shown('unreachable'),
        shown('kept'),
      ]),
    ).toEqual(['down', { keptFrom: 2_000 }, 'down', { keptFrom: 4_000 }])
  })

  test('nothing hidden, gone or hydrating', () => {
    expect(nextNoteHold('down', { phase: 'hidden', tone: 'kept' }, 1)).toBe(
      null,
    )
    expect(
      nextNoteHold({ keptFrom: 1 }, { phase: 'hidden', tone: 'kept' }, 2),
    ).toBe(null)
    expect(
      nextNoteHold(null, { phase: 'hydrating', tone: 'no-signal' }, 1),
    ).toBe(null)
  })

  test('held after the line is back for as long as a fresh page’s answers are given', () => {
    expect(KEPT_AFTER_DOWN_MS).toBe(QUERY_WAIT_MS)
  })
})

describe('whether the page’s note is on screen (`observeOnScreen`)', () => {
  type Entry = { isIntersecting: boolean; intersectionRatio: number }
  type Made = {
    callback: (entries: Array<Entry>) => void
    options: { rootMargin: string; threshold: number }
    watched: Array<Element>
    disconnected: boolean
  }

  function fakeObserver(): Array<Made> {
    const made: Array<Made> = []
    class FakeIntersectionObserver {
      record: Made
      constructor(callback: Made['callback'], options: Made['options']) {
        this.record = { callback, options, watched: [], disconnected: false }
        made.push(this.record)
      }
      observe(el: Element) {
        this.record.watched.push(el)
      }
      disconnect() {
        this.record.disconnected = true
      }
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    return made
  }

  const note = {} as Element

  test('watches the note against the screen below the band’s place under the header, for half of it', () => {
    const made = fakeObserver()
    observeOnScreen(note, () => {})
    expect(made).toHaveLength(1)
    expect(made[0].watched).toEqual([note])
    expect(made[0].options).toEqual({
      rootMargin: ON_SCREEN_MARGIN,
      threshold: ON_SCREEN_SHARE,
    })
    expect(ON_SCREEN_MARGIN).toBe('-84px 0px 0px 0px')
  })

  test('on screen with half of it or more there, not with less or none, by the last of a batch', () => {
    const made = fakeObserver()
    const heard: Array<boolean> = []
    observeOnScreen(note, (onScreen) => heard.push(onScreen))
    made[0].callback([{ isIntersecting: true, intersectionRatio: 1 }])
    made[0].callback([{ isIntersecting: true, intersectionRatio: 0.3 }])
    made[0].callback([{ isIntersecting: false, intersectionRatio: 0 }])
    made[0].callback([
      { isIntersecting: false, intersectionRatio: 0 },
      { isIntersecting: true, intersectionRatio: 0.5 },
    ])
    expect(heard).toEqual([true, false, false, true])
  })

  test('stops watching when asked', () => {
    const made = fakeObserver()
    observeOnScreen(note, () => {})()
    expect(made[0].disconnected).toBe(true)
  })

  test('says nothing where there is no IntersectionObserver, so the note counts as it was taken', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const heard = vi.fn()
    const stop = observeOnScreen(note, heard)
    expect(heard).not.toHaveBeenCalled()
    stop()
  })
})
