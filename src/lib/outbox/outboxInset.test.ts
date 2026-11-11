import { describe, expect, test } from 'vitest'
import { LEFT_ON_PHONE } from './book'
import {
  DISCARD_ITEM,
  DISCARD_MAY_HAVE_GONE,
  OUTBOX_ACTION_COPY,
  discardDialog,
  mayAlreadyBeBooked,
  outboxFooter,
  outboxInset,
  outboxProblemCopy,
  savedLine,
} from './outboxInset'
import {
  MAY_HAVE_GONE_AFTER_MS,
  MAY_HAVE_GONE_FINDS,
  PAUSED_HOLD_MS,
} from './outboxSet'
import { bookingFor, itemFor } from './outboxStore.fixtures'
import type { InsetFacts } from './outboxInset'
import type { OutboxItem } from './outboxItem'

/**
 * What a booking's sheet says of it: where it is, and why it hasn't gone,
 * so the person knows never to book it again.
 */

const TZ = 'Australia/Perth'
const TODAY = '2026-10-27'
/** 9:42am on TODAY in Perth. */
const SAVED = Date.UTC(2026, 9, 27, 1, 42)

function facts(
  item: Partial<OutboxItem> = {},
  extra: Partial<InsetFacts> = {},
): InsetFacts {
  return {
    item: itemFor('u1', item, SAVED),
    lineLive: true,
    held: null,
    sendingHere: false,
    sendingElsewhere: false,
    storageTrouble: false,
    timezone: TZ,
    todayKey: TODAY,
    ...extra,
  }
}

const words = (f: InsetFacts) => {
  const said = outboxInset(f)
  return 'words' in said ? said.words : `problem:${said.problem}`
}

describe('a booking’s sheet says', () => {
  test('waiting, by why', () => {
    expect(words(facts({}, { lineLive: false, held: 'line' }))).toBe(
      'Not sent yet — it’s on this phone and goes when PestM8 is open with signal.',
    )
    expect(words(facts())).toBe('Not sent yet — it goes in a moment.')
    expect(words(facts({}, { held: 'switched' }))).toBe(
      'Not sent yet — it goes when you’re back in your own account.',
    )
    expect(words(facts({}, { held: 'two-step' }))).toBe(
      'Not sent yet — it goes once two-step sign-in is set up.',
    )
    expect(words(facts({}, { held: 'other-person' }))).toBe(
      'Not sent yet — someone else is signed in to PestM8 in another tab.',
    )
    expect(words(facts({}, { storageTrouble: true }))).toBe(
      'This phone’s storage isn’t answering. Reload PestM8 to send it.',
    )
    expect(
      words(facts({ retryAt: SAVED + 5 * 60_000 }, { held: 'retry' })),
    ).toBe(
      'Not sent yet — PestM8 couldn’t take it just now. It tries again at 9:47am.',
    )
  })

  test('the server’s pause, told from a shorter hold by its length', () => {
    const paused = facts(
      { lastAttemptAt: SAVED, holdUntil: SAVED + PAUSED_HOLD_MS },
      { held: 'hold' },
    )
    expect(words(paused)).toBe(
      'Not sent yet — PestM8 has paused sending from phones. It tries again at 9:57am.',
    )
    const signIn = facts(
      { lastAttemptAt: SAVED, holdUntil: SAVED + 30_000 },
      { held: 'hold' },
    )
    expect(words(signIn)).toBe(
      'Not sent yet — it goes once PestM8 has checked your sign-in.',
    )
  })

  test('sending: here, live or not; from another tab; or from an earlier page, which may already be booked', () => {
    const sending = { state: 'sending' as const }
    expect(words(facts(sending, { sendingHere: true }))).toBe('Sending now.')
    expect(words(facts(sending, { sendingHere: true, lineLive: false }))).toBe(
      'Sent as the signal went. It goes again when PestM8 is open with signal, and can be changed once PestM8 answers.',
    )
    expect(words(facts(sending, { sendingElsewhere: true }))).toBe(
      'It’s being sent from another PestM8 tab or window. It can be changed once PestM8 answers there.',
    )
    expect(words(facts(sending))).toBe(
      'It was sent and PestM8 hasn’t answered yet, so it may already be booked. Don’t book it again: it can be changed once PestM8 answers.',
    )
  })

  test('needing a look: its code, for FormAlert', () => {
    expect(
      words(
        facts({ state: 'needsLook', problem: { code: 'INVALID_ASSIGNEE' } }),
      ),
    ).toBe('problem:INVALID_ASSIGNEE')
  })

  test('when it was saved, today or another day', () => {
    expect(savedLine({ createdAt: SAVED }, TZ, TODAY)).toBe(
      'Saved on this phone at 9:42am.',
    )
    expect(savedLine({ createdAt: SAVED }, TZ, '2026-10-28')).toBe(
      'Saved on this phone on Tue 27 Oct at 9:42am.',
    )
  })

  test('the phone’s own reasons for a look, and a site gone', () => {
    const item = itemFor(
      'u1',
      {
        booking: bookingFor({
          scheduledAt: Date.UTC(2026, 9, 20, 0),
          repeat: { count: 1, unit: 'month' },
        }),
      },
      Date.UTC(2026, 9, 20, 0),
    )
    const copy = outboxProblemCopy(item, TZ, TODAY)
    expect(copy.STALE).toBe(
      'Saved on this phone on Tue 20 Oct and not sent. Send it now, or discard it.',
    )
    expect(copy.FIRST_VISIT_PAST).toBe(
      'Could not book this job: its first visit, Tue 20 Oct at 8:00am, went by before it was sent. Change the start date to book it.',
    )
    expect(copy.NOT_FOUND).toBe(copy.MISSING_PROPERTY)
    // Left on the phone by mistake (book.ts `leftOnPhoneChange`).
    expect(copy[LEFT_ON_PHONE]).toBe(
      'Could not take this booking off this phone, and it may already be booked. Check the schedule before you send it, or discard it.',
    )
  })
})

describe('the inset, for what 2c-E adds', () => {
  test('saved by a newer build, whatever it is doing: it goes once this phone has that build', () => {
    const newer =
      'Saved by a newer PestM8. It goes once this phone has the newer PestM8.'
    expect(words(facts({ v: 2 }))).toBe(newer)
    expect(words(facts({ kind: 'invoice' }))).toBe(newer)
    expect(words(facts({ v: 2, state: 'needsLook' }))).toBe(newer)
    expect(words(facts({}, { held: 'newer-build' }))).toBe(newer)
  })

  test('saved by a newer build and sent: why its Discard is locked, and not to book it again', () => {
    expect(words(facts({ v: 2, state: 'sending' }))).toBe(
      'Saved by a newer PestM8 and sent, so it may already be booked. Don’t book it again: it can be changed once this phone has the newer PestM8.',
    )
  })

  test('waiting on the booking it is made on (2c-I): named by its client', () => {
    expect(
      words(facts({}, { held: 'parent', parentClient: 'Jane Nguyen' })),
    ).toBe('Not sent yet — it goes after the first booking for Jane Nguyen.')
  })

  test('changed here, or in another tab with its lease still running', () => {
    const now = SAVED + 60_000
    expect(words(facts({}, { held: 'editing', editingHere: true }))).toBe(
      'Not sent yet — it goes once the change is booked.',
    )
    expect(
      words(
        facts(
          { editing: { tab: 'other', until: now + 1 } },
          { held: 'editing', now, tab: 'mine' },
        ),
      ),
    ).toBe('Not sent yet — it’s being changed in another PestM8 tab or window.')
    // A lease of this tab's, or one run out, is no other tab's.
    expect(
      words(
        facts(
          { editing: { tab: 'mine', until: now + 1 } },
          { now, tab: 'mine' },
        ),
      ),
    ).toBe('Not sent yet — it goes in a moment.')
    expect(
      words(
        facts(
          { editing: { tab: 'other', until: now - 1 } },
          { now, tab: 'mine' },
        ),
      ),
    ).toBe('Not sent yet — it goes in a moment.')
  })

  test('another tab’s lock, the dead-line send and storage not answering', () => {
    const sending = { state: 'sending' as const }
    expect(words(facts(sending, { sendingElsewhere: true }))).toMatch(
      /^It’s being sent from another PestM8 tab or window\./,
    )
    expect(
      words(facts(sending, { sendingHere: true, lineLive: false })),
    ).toMatch(/^Sent as the signal went\./)
    expect(words(facts({}, { storageTrouble: true }))).toBe(
      'This phone’s storage isn’t answering. Reload PestM8 to send it.',
    )
  })

  test('the server’s backstop and anything else it refused: honest words for one kept on the phone, with Edit and Discard', () => {
    const copy = outboxProblemCopy(itemFor('u1', {}, SAVED), TZ, TODAY)
    for (const code of ['MATCHED_CLIENT', 'SITE_BOOKED', 'SITE_REPEATS']) {
      expect(copy[code]).toMatch(
        /Nothing was booked — .*edit it to book it, or discard it\.$/,
      )
    }
    expect(copy.default).toBe(
      'Could not book this job. Nothing was booked — edit it to book it, or discard it.',
    )
    for (const code of ['MATCHED_CLIENT', 'SITE_BOOKED', 'SITE_REPEATS']) {
      const item = itemFor(
        'u1',
        { state: 'needsLook', problem: { code } },
        SAVED,
      )
      expect(outboxFooter(item, { now: SAVED, mayHaveGone: false })).toEqual({
        fix: 'edit',
        alsoEdit: false,
        discard: 'item',
        locked: false,
      })
    }
  })
})

describe('the footer', () => {
  const at = { now: SAVED, mayHaveGone: false, tab: 'mine' }
  const footer = (item: Partial<OutboxItem>, more: Partial<typeof at> = {}) =>
    outboxFooter(itemFor('u1', item, SAVED), { ...at, ...more })
  const look = (code: string) => ({
    state: 'needsLook' as const,
    problem: { code },
  })

  test('waiting: Edit, and Discard', () => {
    expect(footer({})).toEqual({
      fix: 'edit',
      alsoEdit: false,
      discard: 'item',
      locked: false,
    })
  })

  test('needing a look: the fix its class names', () => {
    expect(footer(look('INVALID_ASSIGNEE'))?.fix).toBe('edit')
    expect(footer(look('NOT_FOUND'))?.fix).toBe('edit')
    expect(footer(look('FIRST_VISIT_PAST'))?.fix).toBe('changeDate')
    expect(footer(look('STALE'))?.fix).toBe('send')
    expect(footer(look(LEFT_ON_PHONE))?.fix).toBe('send')
    expect(footer(look('SERVER'))).toEqual({
      fix: 'tryAgain',
      alsoEdit: true,
      discard: 'item',
      locked: false,
    })
  })

  test('sending: both shown, both locked; once it may already be booked, Discard alone', () => {
    expect(footer({ state: 'sending' })).toEqual({
      fix: 'edit',
      alsoEdit: false,
      discard: 'item',
      locked: true,
    })
    expect(footer({ state: 'sending' }, { mayHaveGone: true })).toEqual({
      fix: null,
      alsoEdit: false,
      discard: 'mayHaveGone',
      locked: false,
    })
  })

  test('being changed in another tab: locked', () => {
    expect(
      footer({ editing: { tab: 'other', until: SAVED + 1 } })?.locked,
    ).toBe(true)
    expect(footer({ editing: { tab: 'mine', until: SAVED + 1 } })?.locked).toBe(
      false,
    )
  })

  test('sent: none; a newer build’s: Discard alone, locked while it sends', () => {
    expect(footer({ state: 'sent' })).toBeNull()
    expect(footer({ v: 2 })).toEqual({
      fix: null,
      alsoEdit: false,
      discard: 'item',
      locked: false,
    })
    expect(footer({ v: 2, state: 'sending' })?.locked).toBe(true)
  })

  test('made on a booking still on the phone (2c-I): nothing to edit, Discard only', () => {
    const local = {
      booking: bookingFor({ property: { local: 'parent-1' } }),
    }
    expect(footer(local)?.fix).toBeNull()
    expect(footer({ ...local, ...look('FIRST_VISIT_PAST') })?.fix).toBeNull()
    expect(footer({ ...local, ...look('SERVER') })).toMatchObject({
      fix: 'tryAgain',
      alsoEdit: false,
    })
  })
})

describe('“This may already be booked”', () => {
  const went = SAVED
  const sending = itemFor(
    'u1',
    { state: 'sending', lastAttemptAt: went },
    SAVED,
  )
  const at = {
    now: went + MAY_HAVE_GONE_AFTER_MS,
    refusedFinds: 0,
    sendingHere: false,
    lockFree: true,
  }

  test('after a day since it went, or three refused finds', () => {
    expect(mayAlreadyBeBooked(sending, at)).toBe(true)
    expect(mayAlreadyBeBooked(sending, { ...at, now: at.now - 1 })).toBe(false)
    expect(
      mayAlreadyBeBooked(sending, {
        ...at,
        now: went + 60_000,
        refusedFinds: MAY_HAVE_GONE_FINDS,
      }),
    ).toBe(true)
  })

  test('only while no tab holds its lock and this page has no call out for it', () => {
    expect(mayAlreadyBeBooked(sending, { ...at, lockFree: false })).toBe(false)
    expect(mayAlreadyBeBooked(sending, { ...at, sendingHere: true })).toBe(
      false,
    )
    expect(
      mayAlreadyBeBooked(itemFor('u1', { lastAttemptAt: went }, SAVED), at),
    ).toBe(false)
  })
})

describe('the dialogs, and the refusals mid-dialog (S22b)', () => {
  test('Discard (§9.7) and “This may already be booked” (§6.3)', () => {
    expect(DISCARD_ITEM).toEqual({
      title: 'Discard this job?',
      body: 'It hasn’t been sent, so it’s only on this phone. This can’t be undone.',
      confirm: 'Discard',
      cancel: 'Keep job',
    })
    expect(DISCARD_MAY_HAVE_GONE).toEqual({
      title: 'This may already be booked. Discard it from this phone?',
      body: 'It was sent and PestM8 never said whether it was booked. Check the schedule with signal before booking it again.',
      confirm: 'Discard',
      cancel: 'Keep job',
    })
  })

  test('one New Job sent straight and couldn’t take off the phone: asked as one that may already be booked, never as only on this phone', () => {
    const left = itemFor(
      'u1',
      { state: 'needsLook', problem: { code: LEFT_ON_PHONE } },
      SAVED,
    )
    expect(discardDialog(left, 'item')).toEqual({
      title: 'This may already be booked. Discard it from this phone?',
      body: 'New Job sent it to PestM8, so it may already be booked, or be booked once this phone has signal. Check the schedule with signal before booking it again.',
      confirm: 'Discard',
      cancel: 'Keep job',
    })
    expect(discardDialog(itemFor('u1', {}, SAVED), 'item')).toBe(DISCARD_ITEM)
    expect(
      discardDialog(itemFor('u1', { state: 'sending' }, SAVED), 'mayHaveGone'),
    ).toBe(DISCARD_MAY_HAVE_GONE)
  })

  test('a Discard, an Edit or a Book refused once the dialog or form was open', () => {
    expect(OUTBOX_ACTION_COPY.OUTBOX_DISCARD_REFUSED).toBe(
      'It started sending before it could be discarded. It can be discarded once PestM8 answers, if it still needs to be.',
    )
    expect(OUTBOX_ACTION_COPY.OUTBOX_EDIT_REFUSED).toBe(
      'It started sending, so it can’t be changed now. Open it again once PestM8 answers.',
    )
    expect(OUTBOX_ACTION_COPY.OUTBOX_EDIT_SENT).toBe(
      'This was sent while you were changing it. Open the job to change it with signal.',
    )
    expect(OUTBOX_ACTION_COPY.OUTBOX_EDIT_LAPSED).toBe(
      'This job is still on this phone, not sent yet, and the change wasn’t booked — close this and edit it again.',
    )
    expect(OUTBOX_ACTION_COPY.OUTBOX_DISCARD_ELSEWHERE).toBe(
      'It’s being changed in another PestM8 tab or window, so it wasn’t discarded. Close New Job there, then discard it here.',
    )
  })

  test('a Send, Discard or Book the phone’s storage hasn’t answered may land yet, so it never says nothing was changed', () => {
    expect(OUTBOX_ACTION_COPY.OUTBOX_STORAGE_UNSURE).toBe(
      'This phone’s storage isn’t answering, so PestM8 can’t tell yet whether that was done. Reload PestM8 to see where it is.',
    )
  })
})
