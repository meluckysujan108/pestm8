import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { rq } from '#/lib/routeQueries'
import { keeper } from './keeper'
import {
  KEPT_PAGE_AGE_MS,
  firstKeptMode,
  firstNoteLatch,
  handOverStyle,
  keptInitScript,
  mayBeBehind,
  msUntilLate,
  nextBehindLatch,
  nextKeptMode,
  nextNoteLatch,
  noteAbout,
  notePhase,
  subscribeLineDown,
  useBehindOnce,
  useKeptBeforeDay,
  useKeptMode,
  useKeptNote,
  useLineDown,
  useReadable,
  useReadableAll,
  waitSince,
} from './useKept'
import { RENDERED_AT_KEY, pageRenderedAt } from './keptSet'
import type { ReactElement } from 'react'
import type { BehindLatch, KeptMode, KeptNoteTone, NoteLatch } from './useKept'
import type { Id } from '../../../convex/_generated/dataModel'

// The kept copy's keeper reads who is signed in (lib/rootState.ts), whose
// server function needs a deployment's address to load at all.
vi.mock('#/lib/initialState', () => ({ getInitialState: vi.fn() }))

/**
 * The keeper's hooks render on the server, and in the hydration render, as
 * if nothing were kept and the line were up: what the phone knows comes
 * after.
 */

const B = 'b1' as Id<'businesses'>

function onServer(probe: () => string, client = new QueryClient()): string {
  const Probe = (): ReactElement => createElement('p', null, probe())
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(Probe)),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('on the server', () => {
  test('everything is readable, and the line is up, whatever the phone would say', () => {
    vi.stubGlobal('navigator', { onLine: false })
    const key = rq.day(B, '2026-10-25').queryKey
    expect(onServer(() => String(useReadable(key)))).toBe('<p>true</p>')
    expect(onServer(() => String(useReadableAll([key])))).toBe('<p>true</p>')
    expect(onServer(() => String(useLineDown()))).toBe('<p>null</p>')
  })

  test('no day is drawn from a copy kept before it', () => {
    const key = rq.day(B, '2026-10-25').queryKey
    expect(
      onServer(() =>
        String(useKeptBeforeDay(key, 'Australia/Perth', '2026-10-25')),
      ),
    ).toBe('<p>false</p>')
  })

  test('nothing drawn may be behind: the server drew what it had', () => {
    vi.stubGlobal('navigator', { onLine: false })
    const key = rq.directory(B).queryKey
    expect(onServer(() => String(useBehindOnce(key, true, 'Zed')))).toBe(
      '<p>false</p>',
    )
  })

  test('a page draws as the server does, and asks nothing of the phone yet', () => {
    vi.stubGlobal('navigator', { onLine: false })
    const decide = vi.fn(() => true)
    expect(onServer(() => String(useKeptMode(decide, false)))).toBe(
      '<p>false</p>',
    )
    expect(onServer(() => String(useKeptMode(decide, true)))).toBe(
      '<p>false</p>',
    )
    expect(decide).not.toHaveBeenCalled()
  })

  test('the note is hydrating, neutral, and as old as the HTML’s answers', () => {
    const client = new QueryClient()
    const today = rq.day(B, '2026-10-25').queryKey
    const week = rq.week(B, '2026-10-19').queryKey
    client.setQueryData(today, [], { updatedAt: Date.UTC(2026, 9, 25, 1, 42) })
    client.setQueryData(week, [], { updatedAt: Date.UTC(2026, 9, 25, 3) })
    expect(
      onServer(() => {
        const note = useKeptNote([today, week], 'Australia/Perth', '2026-10-25')
        return `${note.phase} ${note.tone} ${note.asOf} ${note.asOfToday}`
      }, client),
    ).toBe(`<p>hydrating kept ${Date.UTC(2026, 9, 25, 1, 42)} true</p>`)
  })
})

describe('the head script that marks a kept page', () => {
  function run(
    renderedAt: number,
    now: number,
    onLine = true,
  ): string | undefined {
    const attributes = new Map<string, string>()
    vi.stubGlobal('document', {
      documentElement: {
        setAttribute: (name: string, value: string) =>
          attributes.set(name, value),
      },
    })
    vi.stubGlobal('navigator', { onLine })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
    try {
      // As the browser runs it: a string, closing over nothing.
      new Function(keptInitScript(renderedAt))()
    } finally {
      vi.useRealTimers()
    }
    return attributes.get('data-kept')
  }

  test('marks a page the server drew more than two minutes ago', () => {
    const drawn = Date.UTC(2026, 9, 25, 1)
    expect(run(drawn, drawn + KEPT_PAGE_AGE_MS + 1)).toBe('')
  })

  test('says so when the phone has no network, for the note’s first words', () => {
    const drawn = Date.UTC(2026, 9, 25, 1)
    expect(run(drawn, drawn + KEPT_PAGE_AGE_MS + 1, false)).toBe('no-signal')
  })

  test('leaves a page fresh off the network alone', () => {
    const drawn = Date.UTC(2026, 9, 25, 1)
    expect(run(drawn, drawn + 3_000)).toBeUndefined()
    expect(run(drawn, drawn + KEPT_PAGE_AGE_MS)).toBeUndefined()
    expect(run(drawn, drawn + 3_000, false)).toBeUndefined()
  })

  test('leaves when the page was drawn for the keeper, fresh or kept', () => {
    const drawn = Date.UTC(2026, 9, 25, 1)
    try {
      run(drawn, drawn + 3_000)
      expect(pageRenderedAt()).toBe(drawn)
      run(drawn - 1, drawn + KEPT_PAGE_AGE_MS)
      expect(pageRenderedAt()).toBe(drawn - 1)
    } finally {
      Reflect.deleteProperty(window, RENDERED_AT_KEY)
    }
  })
})

describe('how long a page has waited', () => {
  const TAP = Date.UTC(2026, 9, 25, 1)

  test('the wait it opens with counts from the tap, so a loader’s own wait counts towards it', () => {
    // A loader that held the tap for 8 s: the 3 s are long over at mount.
    expect(msUntilLate(TAP, 3_000, TAP + 8_000)).toBe(0)
    // One that answered at once: the rest of the 3 s.
    expect(msUntilLate(TAP, 3_000, TAP + 500)).toBe(2_500)
  })

  test('kept while it lasts, begun afresh after it stops, and none while nothing is waited for', () => {
    expect(waitSince(TAP, true, TAP + 9_000)).toBe(TAP)
    expect(waitSince(TAP, false, TAP + 9_000)).toBeNull()
    // A later wait (a search cleared) counts from when it began, never from
    // the tap.
    expect(waitSince(null, true, TAP + 20_000)).toBe(TAP + 20_000)
    expect(msUntilLate(TAP + 20_000, 3_000, TAP + 20_000)).toBe(3_000)
  })
})

describe('whether an answer may be missing something newer', () => {
  /** An answer that was live on an earlier connection, on a working line. */
  const AT = {
    live: false,
    lineDown: false,
    lineLive: true,
    fromCopy: false,
    fromHtml: false,
    htmlKept: false,
  }

  test('not while it is live', () => {
    expect(mayBeBehind({ ...AT, live: true })).toBe(false)
    expect(mayBeBehind({ ...AT, live: true, lineDown: true })).toBe(false)
  })

  test('with the line down, or from the phone’s copy, whatever the line', () => {
    expect(mayBeBehind({ ...AT, lineDown: true, lineLive: false })).toBe(true)
    expect(mayBeBehind({ ...AT, fromCopy: true })).toBe(true)
  })

  test('the HTML of a page the worker kept, but not of one the server has just drawn, until the line goes down', () => {
    const html = { ...AT, fromHtml: true }
    expect(mayBeBehind({ ...html, htmlKept: true })).toBe(true)
    expect(mayBeBehind(html)).toBe(false)
    expect(mayBeBehind({ ...html, lineLive: false })).toBe(false)
    expect(mayBeBehind({ ...html, lineDown: true })).toBe(true)
  })

  test('one being asked for again on a line PestM8 is speaking on comes up to date; on one gone quiet, not', () => {
    expect(mayBeBehind(AT)).toBe(false)
    expect(mayBeBehind({ ...AT, lineLive: false })).toBe(true)
  })
})

describe('words about an answer that may be behind, decided once', () => {
  /** The latch through a run of renders, as `useBehindOnce` folds them. */
  function renders(
    ...each: Array<{
      showing?: boolean
      hydrating?: boolean
      about?: string
      behind?: boolean
    }>
  ): { latch: BehindLatch; asked: number } {
    let asked = 0
    const latch = each.reduce<BehindLatch>(
      (now, at) =>
        nextBehindLatch(now, {
          showing: at.showing ?? true,
          hydrating: at.hydrating ?? false,
          about: at.about ?? 'Zed',
          behind: () => {
            asked++
            return at.behind ?? false
          },
        }),
      null,
    )
    return { latch, asked }
  }

  test('decided as they first show, and kept while they do', () => {
    const kept = renders({ behind: true }, { behind: false }, { behind: false })
    expect(kept.latch).toEqual({ about: 'Zed', behind: true })
    expect(kept.asked).toBe(1)
    expect(renders({ behind: false }, { behind: true }).latch?.behind).toBe(
      false,
    )
  })

  test('decided again for something else, or once they have gone and show again', () => {
    expect(
      renders({ behind: false }, { about: 'Zee', behind: true }).latch,
    ).toEqual({ about: 'Zee', behind: true })
    expect(
      renders({ behind: false }, { showing: false }, { behind: true }).latch,
    ).toEqual({ about: 'Zed', behind: true })
    expect(renders({ showing: false }).latch).toBeNull()
  })

  test('never behind while hydrating, and kept so after, as the server drew it', () => {
    const hydrated = renders(
      { hydrating: true, behind: true },
      { behind: true },
    )
    expect(hydrated.latch?.behind).toBe(false)
    expect(hydrated.asked).toBe(0)
  })

  test('the same latch back when nothing changed', () => {
    const first = nextBehindLatch(null, {
      showing: true,
      hydrating: false,
      about: 'Zed',
      behind: () => true,
    })
    expect(
      nextBehindLatch(first, {
        showing: true,
        hydrating: false,
        about: 'Zed',
        behind: () => false,
      }),
    ).toBe(first)
  })
})

describe('a sheet’s body held across the hand-over', () => {
  test('nothing while the kept view shows, or where none was measured', () => {
    expect(handOverStyle(true, 630)).toBeUndefined()
    expect(handOverStyle(false, null)).toBeUndefined()
  })

  test('then at the kept view’s height, which it may give up for a notice above it but never grow past', () => {
    expect(handOverStyle(false, 630)).toEqual({ flex: '0 1 auto', height: 630 })
  })
})

describe('whether a page draws from the phone’s copy, decided once', () => {
  /** The choice through a run of renders, as `useKeptMode` folds them. */
  function renders(
    ...each: Array<{ hydrating?: boolean; drawn?: boolean; kept?: boolean }>
  ): { mode: KeptMode; asked: number } {
    let asked = 0
    const at = (render: (typeof each)[number]) => ({
      hydrating: render.hydrating ?? false,
      drawn: render.drawn ?? false,
      decide: () => {
        asked++
        return render.kept ?? false
      },
    })
    const [first, ...rest] = each
    let mode = firstKeptMode(at(first))
    for (const render of rest) mode = nextKeptMode(mode, at(render))
    return { mode, asked }
  }

  test('a page reached in the app takes it, or not, as it first draws', () => {
    expect(renders({ kept: true }).mode).toBe(true)
    expect(renders({ drawn: true }).mode).toBe(false)
  })

  test('never changed once made: the list never changes source under a thumb', () => {
    expect(renders({ kept: true }, { drawn: true }).mode).toBe(true)
    const usual = renders({ drawn: true }, { kept: true }, { kept: true })
    expect(usual.mode).toBe(false)
    // And not asked again.
    expect(usual.asked).toBe(1)
  })

  test('a page still on its placeholder can take it later, as nothing on screen moves', () => {
    const waiting = renders({}, {})
    expect(waiting.mode).toBeNull()
    expect(renders({}, {}, { kept: true }).mode).toBe(true)
    // Until it has drawn from its usual source.
    expect(renders({}, { drawn: true }, { kept: true }).mode).toBe(false)
  })

  test('what the hydration render drew from the usual source stays, whatever the phone says after', () => {
    const hydrated = renders(
      { hydrating: true, drawn: true },
      { drawn: true, kept: true },
    )
    expect(hydrated.mode).toBe(false)
    expect(hydrated.asked).toBe(0)
    // Nothing is asked while hydrating.
    expect(renders({ hydrating: true }, { hydrating: true }).asked).toBe(0)
    // A hydration render on its placeholder decides once hydrated.
    expect(renders({ hydrating: true }, { kept: true }).mode).toBe(true)
  })
})

describe('whether the note shows, decided once', () => {
  const ABOUT = 'today'

  /** The latch through a run of renders, as `useKeptNote` folds them. */
  function renders(
    latch: NoteLatch,
    ...each: Array<{
      hydrating?: boolean
      htmlKept?: boolean
      tone?: KeptNoteTone
      about?: string
      now?: number
      empty?: boolean
    }>
  ): NoteLatch {
    return each.reduce(
      (now, at) =>
        nextNoteLatch(now, {
          hydrating: at.hydrating ?? false,
          htmlKept: at.htmlKept ?? false,
          tone: at.tone ?? 'kept',
          about: at.about ?? ABOUT,
          now: at.now ?? 0,
          empty: at.empty,
        }),
      latch,
    )
  }

  test('a page from the server shows it only if it was a copy the worker kept', () => {
    const hydrated = firstNoteLatch(true, true)
    expect(notePhase(hydrated, true)).toBe('hydrating')
    expect(
      notePhase(
        renders(hydrated, { hydrating: true }, { htmlKept: true }),
        false,
      ),
    ).toBe('shown')
    // Fresh off the network, with the line down by now: never put in.
    expect(
      notePhase(
        renders(hydrated, { htmlKept: false, tone: 'no-signal' }),
        false,
      ),
    ).toBe('hidden')
  })

  test('a page reached in the app shows it only if the line is down as it first renders', () => {
    expect(notePhase(firstNoteLatch(false, true), false)).toBe('shown')
    const up = firstNoteLatch(false, false)
    expect(notePhase(renders(up, { tone: 'no-signal' }), false)).toBe('hidden')
  })

  test('once all of it is live it stays, with when, and goes at the next change', () => {
    const shown = renders(firstNoteLatch(false, true), { tone: 'no-signal' })
    const live = renders(shown, { tone: 'live', now: 42 })
    expect(live.liveFor).toEqual({ about: ABOUT, at: 42 })
    expect(notePhase(renders(live, { tone: 'live', now: 99 }), false)).toBe(
      'shown',
    )
    expect(renders(live, { tone: 'live', now: 99 }).liveFor?.at).toBe(42)
    const moved = renders(live, { tone: 'live', about: 'tomorrow' })
    expect(notePhase(moved, false)).toBe('hidden')
    // And gone for good.
    expect(notePhase(renders(moved, { tone: 'no-signal' }), false)).toBe(
      'hidden',
    )
  })

  test('the line going down again before that keeps it', () => {
    const live = renders(firstNoteLatch(false, true), { tone: 'live' })
    const down = renders(live, { tone: 'unreachable' })
    expect(down.liveFor).toBeNull()
    expect(
      notePhase(
        renders(down, { tone: 'unreachable', about: 'tomorrow' }),
        false,
      ),
    ).toBe('shown')
  })

  test('the same latch back when nothing changed', () => {
    const shown = firstNoteLatch(false, true)
    expect(renders(shown, { tone: 'kept' })).toBe(shown)
  })

  test('never over a page with nothing to draw: hidden from the first render, or gone for good once that is known', () => {
    const down = firstNoteLatch(false, true)
    expect(
      notePhase(renders(down, { tone: 'no-signal', empty: true }), false),
    ).toBe('hidden')
    const later = renders(down, { tone: 'no-signal' }, { empty: true })
    expect(notePhase(later, false)).toBe('hidden')
    // A list that comes after all brings no note back above it.
    expect(notePhase(renders(later, { tone: 'live' }), false)).toBe('hidden')
    // While hydrating, nothing is known to be missing yet.
    expect(
      notePhase(
        renders(firstNoteLatch(true, true), { hydrating: true, empty: true }),
        true,
      ),
    ).toBe('hydrating')
  })

  test('left out while what is under it could not load for now, and back as before after', () => {
    const shown = renders(firstNoteLatch(false, true), { tone: 'no-signal' })
    expect(notePhase(shown, false, true)).toBe('hidden')
    expect(notePhase(shown, false)).toBe('shown')
    // Never shown, it isn't put in after either.
    expect(notePhase(firstNoteLatch(false, false), false, false)).toBe('hidden')
    // As the server drew it while hydrating.
    expect(notePhase(firstNoteLatch(true, true), true, true)).toBe('hydrating')
  })

  test('a search, order or filter the page names is part of what it is about', () => {
    const keys = [rq.directory(B).queryKey]
    expect(noteAbout('2026-10-25', keys, '["Beat"]')).not.toBe(
      noteAbout('2026-10-25', keys, '["Bea"]'),
    )
    expect(noteAbout('2026-10-25', keys)).not.toBe(
      noteAbout('2026-10-26', keys),
    )
    expect(noteAbout('2026-10-25', keys)).not.toBe(
      noteAbout('2026-10-25', [rq.day(B, '2026-10-25').queryKey]),
    )
    // Live on the Clients page, then a new search: the note goes.
    const live = renders(firstNoteLatch(false, true), {
      tone: 'live',
      about: noteAbout('2026-10-25', keys, '["",""]'),
    })
    expect(
      notePhase(
        renders(live, {
          tone: 'live',
          about: noteAbout('2026-10-25', keys, '["B",""]'),
        }),
        false,
      ),
    ).toBe('hidden')
  })
})

describe('the line, outside React', () => {
  test('tells whoever is listening when the phone goes on or off line, and what the keeper says', () => {
    const phone = new Map<string, () => void>()
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: () => void) => phone.set(type, fn),
      removeEventListener: (type: string) => phone.delete(type),
    })
    const told = vi.spyOn(keeper, 'subscribe')
    try {
      const heard = vi.fn()
      const stop = subscribeLineDown(heard)
      expect([...phone.keys()].sort()).toEqual(['offline', 'online'])
      expect(told).toHaveBeenCalledWith(heard)
      phone.get('offline')?.()
      phone.get('online')?.()
      expect(heard).toHaveBeenCalledTimes(2)
      stop()
      expect(phone.size).toBe(0)
    } finally {
      told.mockRestore()
    }
  })
})
