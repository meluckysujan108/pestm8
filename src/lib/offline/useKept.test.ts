import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { rq } from '#/lib/routeQueries'
import { keeper } from './keeper'
import {
  KEPT_PAGE_AGE_MS,
  firstNoteLatch,
  keptInitScript,
  nextNoteLatch,
  notePhase,
  subscribeLineDown,
  useKeptBeforeDay,
  useKeptNote,
  useLineDown,
  useReadable,
  useReadableAll,
} from './useKept'
import { RENDERED_AT_KEY, pageRenderedAt } from './keptSet'
import type { ReactElement } from 'react'
import type { KeptNoteTone, NoteLatch } from './useKept'
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
