import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { hookHarness } from '#/lib/offline/hooks.fixtures'
import { FIX_ARM_MS } from '#/components/forms/saveWarningRules'
import { blurLine } from '#/lib/clientMatchRows'
import { NO_OURS, buildMatchIndex } from '../../../convex/lib/clientMatch'
import { keepInPlace, matchKeyOf, useMatchLines } from './useMatchLines'
import type {
  MatchLineValues,
  NewClientMatchField,
  NewClientMatchLine,
  Placed,
} from './useMatchLines'
import type { MatchDirectory } from '../../../convex/lib/clientMatch'
import type { Id } from '../../../convex/_generated/dataModel'
import type * as React from 'react'

// React's hooks run here by the harness, timers included: there is no
// document to render into.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  ...(await import('#/lib/offline/hooks.fixtures')).hookHarness.hooks,
}))

/**
 * The line under Name, Phone or Email as it is left (the matching plan's
 * §2.6), and nothing moving under a thumb as it comes in (RK14): the field
 * just tapped stays where it was on screen, and the line's fixes take no tap
 * for the moment it comes in. Left before the client list is read, a
 * field's line comes once it is.
 */

const AT = Date.UTC(2026, 10, 1, 1)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(AT)
})

afterEach(() => {
  hookHarness.mount(() => null)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** A sheet's scrolling body, and a field in it whose top is read from
 * `tops`, one reading at a time: where it was, then where it is drawn. */
function onScreen(tops: Array<number>) {
  const body: Placed & { scrollTop: number; scroller: true } = {
    getBoundingClientRect: () => ({ top: 0 }),
    parentElement: null,
    scrollTop: 0,
    scrollHeight: 2_000,
    clientHeight: 700,
    scroller: true,
  }
  const field: Placed = {
    getBoundingClientRect: () => ({ top: tops.shift() ?? 0 }),
    parentElement: body,
  }
  vi.stubGlobal('getComputedStyle', (el: { scroller?: boolean }) => ({
    overflowY: el.scroller ? 'auto' : 'visible',
  }))
  return { body, field }
}

const values: MatchLineValues = {
  clientName: 'Jane Nguyen',
  phone: '0491 570 156',
  email: '',
}

type LineFor = (
  field: NewClientMatchField,
  values: MatchLineValues,
) => NewClientMatchLine | null

/** By the fields' match keys, as NewClientFields decides them. */
const byKeys = (field: NewClientMatchField, value: string) =>
  matchKeyOf(field, value, '08')

function mount(
  matchLine: LineFor | undefined,
  typed: MatchLineValues = values,
) {
  let now = { typed, matchLine }
  const hook = hookHarness.mount(() =>
    useMatchLines(now.typed, now.matchLine, byKeys),
  )
  return {
    current: () => hook.current(),
    with: (next: Partial<typeof now>) => {
      now = { ...now, ...next }
      hook.rerender()
    },
  }
}

describe('a line’s fixes, as it comes in', () => {
  test('take no tap for 400 ms, held for their aria-disabled, then do', () => {
    const book = vi.fn()
    const lines = mount(() => ({
      text: 'Jane Nguyen, of Bayswater, has this mobile.',
      fix: { label: 'Book at 12 Wattle St', onApply: book },
    }))
    lines.current().leaving('phone', null)
    const line = lines.current().lineOf('phone')
    expect(line?.text).toBe('Jane Nguyen, of Bayswater, has this mobile.')
    expect(line?.fix?.held).toBe(true)
    // The thumb that tapped Email, tapping again.
    vi.advanceTimersByTime(120)
    lines.current().lineOf('phone')?.fix?.onApply()
    expect(book).not.toHaveBeenCalled()
    vi.advanceTimersByTime(FIX_ARM_MS - 120)
    expect(lines.current().lineOf('phone')?.fix?.held).toBe(false)
    lines.current().lineOf('phone')?.fix?.onApply()
    expect(book).toHaveBeenCalledTimes(1)
  })
})

describe('the field focus went to, as the line goes in above it', () => {
  test('stays where it was on screen: the sheet is scrolled by as much as it moved', () => {
    // Email was at 300, and the line under Phone pushes it to 365.
    const { body, field } = onScreen([300, 365])
    const lines = mount(() => ({
      text: 'Jane Nguyen, of Bayswater, has this mobile.',
    }))
    lines.current().leaving('phone', field)
    expect(lines.current().lineOf('phone')).not.toBeNull()
    expect(body.scrollTop).toBe(65)
  })

  test('nothing to do when it didn’t move, or no line came', () => {
    const still = onScreen([300, 300])
    const lines = mount(() => ({
      text: 'Jane Nguyen, of Bayswater, has this mobile.',
    }))
    lines.current().leaving('phone', still.field)
    expect(still.body.scrollTop).toBe(0)

    const none = onScreen([300, 365])
    const quiet = mount(() => null)
    quiet.current().leaving('phone', none.field)
    expect(quiet.current().lineOf('phone')).toBeNull()
    expect(none.body.scrollTop).toBe(0)
  })

  test('`keepInPlace` on its own: by the nearest ancestor that scrolls', () => {
    const { body, field } = onScreen([340])
    keepInPlace(field, 300)
    expect(body.scrollTop).toBe(40)
  })
})

describe('a field left before the client list is read', () => {
  test('gets its line once the list comes, if it still holds what was left in it', () => {
    const matchLine = vi.fn((field: NewClientMatchField) =>
      field === 'phone'
        ? { text: 'Jane Nguyen, of Bayswater, has this mobile.' }
        : null,
    )
    const lines = mount(undefined)
    lines.current().leaving('phone', null)
    expect(lines.current().lineOf('phone')).toBeNull()
    lines.with({ matchLine })
    expect(lines.current().lineOf('phone')?.text).toBe(
      'Jane Nguyen, of Bayswater, has this mobile.',
    )
  })

  test('not once it has been changed since', () => {
    const lines = mount(undefined)
    lines.current().leaving('phone', null)
    lines.current().changing('phone', '0491 570 199')
    lines.with({ typed: { ...values, phone: '0491 570 199' } })
    lines.with({
      matchLine: () => ({ text: 'Someone has this mobile.' }),
    })
    expect(lines.current().lineOf('phone')).toBeNull()
  })
})

describe('a line shows while its field holds what it was decided for', () => {
  test('and goes as the field is changed to another number', () => {
    const lines = mount(() => ({
      text: 'Jane Nguyen, of Bayswater, has this mobile.',
    }))
    lines.current().leaving('phone', null)
    expect(lines.current().lineOf('phone')).not.toBeNull()
    lines.current().changing('phone', '0491 570 199')
    lines.with({ typed: { ...values, phone: '0491 570 199' } })
    expect(lines.current().lineOf('phone')).toBeNull()
  })

  test('the same number written another way keeps it: PhoneInput’s own tidy fix takes nothing away', () => {
    // Typed as a keypad enters it, and left for Email: the line, under
    // PhoneInput's own "Use 0491 570 156".
    const typed = { ...values, phone: '0491570156' }
    const decided = vi.fn<LineFor>((_, now) => ({
      text: `${now.phone} is on 2 clients — Ray White Bayswater and 1 other.`,
      fix: { label: 'Show them', onApply: () => {} },
    }))
    const lines = mount(decided, typed)
    lines.current().leaving('phone', null)
    const before = lines.current().lineOf('phone')
    expect(before?.text).toBe(
      '0491570156 is on 2 clients — Ray White Bayswater and 1 other.',
    )
    // The tidy fix tapped: the same number, as it is usually written. The
    // line stays, said as the number now reads, and its fixes are held no
    // longer than they were.
    lines.current().changing('phone', '0491 570 156')
    lines.with({ typed: { ...typed, phone: '0491 570 156' } })
    const after = lines.current().lineOf('phone')
    expect(after?.text).toBe(
      '0491 570 156 is on 2 clients — Ray White Bayswater and 1 other.',
    )
    vi.advanceTimersByTime(FIX_ARM_MS)
    expect(lines.current().lineOf('phone')?.fix?.held).toBe(false)
    // So with +61, or brackets: the same keys.
    lines.current().changing('phone', '+61 491 570 156')
    lines.with({ typed: { ...typed, phone: '+61 491 570 156' } })
    expect(lines.current().lineOf('phone')).not.toBeNull()
  })

  test('as a line goes, the field focus is in stays where it was on screen', () => {
    const { body, field } = onScreen([500, 435])
    body.scrollTop = 200
    vi.stubGlobal('document', { activeElement: field, scrollingElement: null })
    const lines = mount(() => ({
      text: 'Jane Nguyen, of Bayswater, has this mobile.',
    }))
    lines.current().leaving('phone', null)
    // Email, below the line, was at 500; with the line gone it is drawn at
    // 435: the sheet is scrolled back by as much.
    lines.current().changing('phone', '0491 570 199')
    lines.with({ typed: { ...values, phone: '0491 570 199' } })
    expect(lines.current().lineOf('phone')).toBeNull()
    expect(body.scrollTop).toBe(135)
  })

  test('a field’s keys: the number, the email, the name, however written', () => {
    expect(matchKeyOf('phone', '0491570156', '08')).toBe(
      matchKeyOf('phone', '+61 491 570 156', '08'),
    )
    expect(matchKeyOf('phone', '9272 1234', '08')).toBe(
      matchKeyOf('phone', '(08) 9272 1234', '08'),
    )
    expect(matchKeyOf('phone', '0491 570 156', '08')).not.toBe(
      matchKeyOf('phone', '0491 570 199', '08'),
    )
    expect(matchKeyOf('email', 'Jane@Example.com ', '08')).toBe(
      matchKeyOf('email', 'jane@example.com', '08'),
    )
    expect(matchKeyOf('clientName', 'jane  nguyen', '08')).toBe(
      matchKeyOf('clientName', 'Jane Nguyen', '08'),
    )
    // Nothing a key can be made of: what was typed.
    expect(matchKeyOf('phone', '12', '08')).not.toBe(
      matchKeyOf('phone', '123', '08'),
    )
  })
})

describe('a Phone or Email line, as the Name is changed after it was left', () => {
  // Jane Nguyen with her own mobile and email, at one site; Tom Lee with a
  // landline of his own. Numbers from ACMA's ranges for fiction.
  const directory: MatchDirectory = {
    clients: [
      {
        _id: 'c_jane' as Id<'clients'>,
        name: 'Jane Nguyen',
        kind: 'person',
        phone: '0491 570 161',
        email: 'jane.nguyen@example.com',
      },
      {
        _id: 'c_tom' as Id<'clients'>,
        name: 'Tom Lee',
        kind: 'person',
        phone: '08 9272 1234',
      },
    ],
    sites: [
      {
        _id: 'p_jane' as Id<'properties'>,
        clientId: 'c_jane' as Id<'clients'>,
        addressLine: '12 Wattle St',
        suburb: 'Bayswater',
        postcode: '6053',
      },
      {
        _id: 'p_tom' as Id<'properties'>,
        clientId: 'c_tom' as Id<'clients'>,
        addressLine: '8 Oak St',
        suburb: 'Morley',
        postcode: '6062',
      },
    ],
    contacts: [],
  }
  const ctx = {
    index: buildMatchIndex(directory, { areaCode: '08', ours: NO_OURS }),
    contacts: [],
    verb: 'book' as const,
  }
  /** As New Job decides a line (`blurLine`), its fixes by their labels. */
  const decided = vi.fn<LineFor>((field, now) => {
    const line = blurLine(ctx, field, {
      name: now.clientName,
      phone: now.phone,
      email: now.email,
    })
    if (!line) return null
    const fix = (label: string) => ({ label, onApply: () => {} })
    return {
      text: line.text,
      ...(line.fix ? { fix: fix(line.fix.label) } : {}),
      ...(line.fix2 ? { fix2: fix(line.fix2.label) } : {}),
    }
  })
  const said = (line: NewClientMatchLine | null) =>
    line && { text: line.text, fix: line.fix?.label, held: line.fix?.held }

  test('her name agreeing, then another: Show them, never Book at her site one tap away', () => {
    const typed = {
      clientName: 'Jane Nguyen',
      phone: '0491 570 161',
      email: 'jane.nguyen@example.com',
    }
    const lines = mount(decided, typed)
    lines.current().leaving('phone', null)
    lines.current().leaving('email', null)
    vi.advanceTimersByTime(FIX_ARM_MS)
    expect(said(lines.current().lineOf('phone'))).toEqual({
      text: 'Jane Nguyen, of Bayswater, has this mobile.',
      fix: 'Book at 12 Wattle St',
      held: false,
    })
    expect(lines.current().lineOf('email')?.fix?.label).toBe(
      'Book at 12 Wattle St',
    )

    // The caller is her husband: the Name is put right.
    lines.current().changing('clientName', 'Tom Nguyen')
    lines.with({ typed: { ...typed, clientName: 'Tom Nguyen' } })
    // As the lines would be decided now: who has it, and Show them. The
    // fix that changed takes no tap for as long as a new line's.
    expect(said(lines.current().lineOf('phone'))).toEqual({
      text: 'Jane Nguyen, of Bayswater, has this mobile.',
      fix: 'Show them',
      held: true,
    })
    expect(said(lines.current().lineOf('email'))).toEqual({
      text: 'Jane Nguyen, of Bayswater, has this email.',
      fix: 'Show them',
      held: true,
    })
    vi.advanceTimersByTime(FIX_ARM_MS)
    expect(lines.current().lineOf('phone')?.fix?.held).toBe(false)

    // Her name again: the one tap is back.
    lines.current().changing('clientName', 'Jane Nguyen')
    lines.with({ typed })
    expect(lines.current().lineOf('phone')?.fix?.label).toBe(
      'Book at 12 Wattle St',
    )
  })

  test('a landline: whose number it is, once the name no longer agrees', () => {
    const typed = { clientName: 'Tom Lee', phone: '08 9272 1234', email: '' }
    const lines = mount(decided, typed)
    lines.current().leaving('phone', null)
    expect(said(lines.current().lineOf('phone'))).toMatchObject({
      text: 'Tom Lee, of Morley, has this number.',
      fix: 'Book at 8 Oak St',
    })
    lines.current().changing('clientName', 'Sam Wu')
    lines.with({ typed: { ...typed, clientName: 'Sam Wu' } })
    expect(said(lines.current().lineOf('phone'))).toMatchObject({
      text: '08 9272 1234 is Tom Lee’s number.',
      fix: 'Show them',
    })
  })

  test('a line that no longer holds goes, and focus stays where it is on screen', () => {
    const { body, field } = onScreen([500, 435])
    body.scrollTop = 200
    vi.stubGlobal('document', { activeElement: field, scrollingElement: null })
    const lines = mount((f, now) =>
      f === 'phone' && now.clientName === 'Jane Nguyen'
        ? {
            text: 'Jane Nguyen, of Bayswater, has this mobile.',
            fix: { label: 'Book at 12 Wattle St', onApply: () => {} },
          }
        : null,
    )
    lines.current().leaving('phone', null)
    expect(lines.current().lineOf('phone')).not.toBeNull()
    lines.current().changing('clientName', 'Kim Pham')
    lines.with({ typed: { ...values, clientName: 'Kim Pham' } })
    expect(lines.current().lineOf('phone')).toBeNull()
    expect(body.scrollTop).toBe(135)
  })

  test('the same name written another way decides nothing again', () => {
    const typed = {
      clientName: 'Jane Nguyen',
      phone: '0491 570 161',
      email: '',
    }
    const lines = mount(decided, typed)
    lines.current().leaving('phone', null)
    const calls = decided.mock.calls.length
    lines.current().changing('clientName', 'jane  nguyen')
    lines.with({ typed: { ...typed, clientName: 'jane  nguyen' } })
    expect(decided.mock.calls.length).toBe(calls)
    // Its fix is held only as long as it was, not again.
    vi.advanceTimersByTime(FIX_ARM_MS)
    expect(lines.current().lineOf('phone')?.fix).toMatchObject({
      label: 'Book at 12 Wattle St',
      held: false,
    })
  })
})
