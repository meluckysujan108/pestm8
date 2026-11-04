import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import {
  BOOKING_KEPT,
  BOOKING_WAITS,
  NEW_JOB_NOT_ON_PHONE,
  NewJobNotOnPhone,
  OPEN_WORK_WAIT_MS,
  bookingCaption,
  createWorkWait,
  newJobBody,
} from './NewJobSheet'
import { SAVE_CHECK_TIMEOUT_MS } from '#/components/forms/saveWarningRules'
import type { ReactNode } from 'react'

// New Job reaches who is signed in (lib/rootState.ts), whose server
// function needs a deployment's address to load at all.
vi.mock('#/lib/initialState', () => ({ getInitialState: vi.fn() }))

// vaul's pieces as plain elements: there's no document here to open one in.
vi.mock('vaul', () => {
  const pass = ({ children }: { children?: ReactNode }) => <>{children}</>
  return {
    Drawer: {
      Root: pass,
      Portal: pass,
      Overlay: () => null,
      Title: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
      Description: pass,
      Content: pass,
      Handle: () => null,
      NestedRoot: pass,
    },
  }
})

/**
 * New Job's words with the line down: kept on the phone where it can be
 * (keeping switched on and the rest, lib/outbox/book.ts `canKeepNow`), as
 * they always were where it can't, which is every phone while the outbox is
 * switched off. And, whatever the switch, what it says with nothing of it on
 * the phone, in place of a placeholder that would wait for good.
 */

describe('above Book job, with the line down', () => {
  test('where the booking can’t be kept (keeping off, or no Web Locks, or someone else’s account): as it always said', () => {
    expect(bookingCaption('no-signal', false)).toBe(
      'No signal — the booking goes when you have signal. Keep PestM8 open until then.',
    )
    expect(bookingCaption('unreachable', false)).toBe(
      'Could not reach PestM8 — the booking goes once it can. Keep PestM8 open until then.',
    )
    expect(bookingCaption('no-signal', false)).toBe(BOOKING_WAITS['no-signal'])
  })

  test('where it is kept on the phone: nothing to keep open', () => {
    expect(bookingCaption('no-signal', true)).toBe(
      'No signal — the booking is kept on this phone and goes when PestM8 is open with signal.',
    )
    expect(bookingCaption('unreachable', true)).toBe(
      'Could not reach PestM8 — the booking is kept on this phone and goes once PestM8 answers.',
    )
    expect(bookingCaption('unreachable', true)).toBe(BOOKING_KEPT.unreachable)
  })

  test('the words keep the house style: a spaced em dash, curly apostrophes, “signal”', () => {
    for (const words of [
      ...Object.values(BOOKING_WAITS),
      ...Object.values(BOOKING_KEPT),
    ]) {
      expect(words).toMatch(/ — /)
      expect(words).not.toMatch(/'|connection/)
    }
  })
})

describe('New Job with nothing of it on the phone', () => {
  test('says so, under the sheet’s own title, rather than wait', () => {
    const html = renderToStaticMarkup(<NewJobNotOnPhone />)
    expect(html).toContain('<h2>New job</h2>')
    expect(html).toContain('New Job isn’t on this phone yet')
    expect(html).toContain(
      'It needs the client list and the team, which this phone doesn’t have yet. It opens when you have signal.',
    )
    expect(NEW_JOB_NOT_ON_PHONE.title).not.toMatch(/'/)
    // No placeholder: nothing here is still loading.
    expect(html).not.toContain('role="status"')
  })
})

describe('what the sheet holds (`newJobBody`)', () => {
  test('nothing while closed; the form once it can be made; else that it isn’t on the phone', () => {
    expect(newJobBody({ open: false, onPhone: true, formUp: false })).toBe(
      'none',
    )
    expect(newJobBody({ open: true, onPhone: true, formUp: false })).toBe(
      'form',
    )
    expect(newJobBody({ open: true, onPhone: false, formUp: false })).toBe(
      'notOnPhone',
    )
  })

  test('once the form is up it stays, whatever the line does: nothing typed is taken away', () => {
    // Typed into, and the line went before the job types had come.
    expect(newJobBody({ open: true, onPhone: false, formUp: true })).toBe(
      'form',
    )
  })
})

describe('a press of Book waiting for what is booked at each site', () => {
  test('waits less than any check at Book is given, so the row saying the site couldn’t be checked is still said if it never comes', () => {
    expect(OPEN_WORK_WAIT_MS).toBe(2000)
    expect(OPEN_WORK_WAIT_MS).toBeLessThan(SAVE_CHECK_TIMEOUT_MS)
  })

  test('one wait for both checks of a press, let go as the answer comes', async () => {
    vi.useFakeTimers()
    try {
      const wait = createWorkWait()
      const match = wait.until()
      expect(wait.until()).toBe(match)
      let done = false
      void match.then(() => {
        done = true
      })
      await vi.advanceTimersByTimeAsync(500)
      expect(done).toBe(false)
      wait.settle()
      await vi.advanceTimersByTimeAsync(0)
      expect(done).toBe(true)
      // It came: nothing ran out, and the next press would wait anew.
      expect(wait.ranOut()).toBe(false)
      expect(wait.until()).not.toBe(match)
    } finally {
      vi.useRealTimers()
    }
  })

  test('a wait that ran out isn’t waited again by the press after it (the Book anyway confirming “Not checked”), until what is held or coming changes', async () => {
    vi.useFakeTimers()
    try {
      const wait = createWorkWait()
      let done = false
      void wait.until().then(() => {
        done = true
      })
      await vi.advanceTimersByTimeAsync(OPEN_WORK_WAIT_MS - 1)
      expect(done).toBe(false)
      expect(wait.ranOut()).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(done).toBe(true)
      // The sheet's `waitsForWork` reads this: the next press says what it
      // can at once.
      expect(wait.ranOut()).toBe(true)
      // The answer comes, or is asked for afresh: a press may wait again.
      wait.reset()
      expect(wait.ranOut()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
