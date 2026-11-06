import { describe, expect, test } from 'vitest'
import { ConvexError } from 'convex/values'
import { describeError } from '#/components/forms/describeError'
import { BOOKING_ERROR_COPY, bookingErrorCopy } from './bookingCopy'
import type {
  NewClientArgs,
  NewSiteArgs,
} from '#/components/clients/NewClientFields'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * Book job's FormAlert for a booking refused over whose account it is in:
 * said as what happened, never as the signal, which has nothing to do with
 * it, so the person doesn't go looking for a better one.
 */

describe('a booking refused over whose account it is in', () => {
  test('NOT_OWN_ACCOUNT (sent as the person’s own after PestM8 moved into someone else’s account): nothing booked, and switch back first', () => {
    const words = describeError(
      new ConvexError('NOT_OWN_ACCOUNT'),
      BOOKING_ERROR_COPY,
    )
    expect(words).toBe(
      'Could not book this job: PestM8 is now working in someone else’s account. Switch back to your own, then book it again.',
    )
    expect(words).not.toMatch(/signal/)
  })

  test.each([
    'SWITCH_EXPIRED',
    'SWITCH_REVOKED',
    'SWITCH_TEAM_CHANGED',
    'SWITCH_TARGET_INACTIVE',
    'SWITCH_NOT_PERMITTED',
    'SWITCH_CHAINED',
  ])(
    '%s (the switch it was booked under had ended): back in their own account, nothing booked',
    (code) => {
      const words = describeError(new ConvexError(code), BOOKING_ERROR_COPY)
      expect(words).toBe(
        'Could not book this job: that session ended, so you are back in your own account. Nothing was booked — try again.',
      )
      expect(words).not.toMatch(/signal/)
    },
  )

  test('the words keep the house style: a spaced em dash, curly apostrophes', () => {
    for (const code of ['NOT_OWN_ACCOUNT', 'SWITCH_EXPIRED']) {
      expect(BOOKING_ERROR_COPY[code]).not.toMatch(/'/)
    }
    expect(BOOKING_ERROR_COPY.SWITCH_EXPIRED).toMatch(/ — /)
  })
})

describe('a booking refused for what the server found as it went (M7)', () => {
  // Said by FormAlert only where the refusal’s rows aren’t on the panel:
  // the form changed while it was out (or it is a booking on the phone that
  // needs a look). So they promise nothing of the next press, which checks
  // the form as it is now, and may find nothing and book: the date moved
  // three weeks on while "Booking…" showed, the name put right.
  test.each([
    [
      'MATCHED_CLIENT',
      'Could not book this job: the caller may already be a client. Nothing was booked — book it again.',
    ],
    [
      'SITE_BOOKED',
      'Could not book this job: work is already booked at that site near that date. Nothing was booked — book it again.',
    ],
    [
      'SITE_REPEATS',
      'Could not book this job: a Recurring Job already runs at that site. Nothing was booked — book it again.',
    ],
  ])('%s', (code, said) => {
    const words = describeError(new ConvexError({ code }), BOOKING_ERROR_COPY)
    expect(words).toBe(said)
    expect(words).not.toMatch(/\bsee\b|signal|'/)
    expect(words).toMatch(/ — /)
    // Any booking but a new site for a client chosen.
    for (const property of [
      undefined,
      { propertyId: 'p-1' as Id<'properties'> },
      { newClient: {} as NewClientArgs },
    ]) {
      expect(
        describeError(
          new ConvexError({ code }),
          bookingErrorCopy(property, () => 'Jane Nguyen'),
        ),
      ).toBe(said)
    }
  })

  test('a new site for a client chosen: MATCHED_CLIENT is that client having the address typed then, not another client', () => {
    const property = {
      newProperty: { clientId: 'c-jane' as Id<'clients'> } as NewSiteArgs,
    }
    const words = describeError(
      new ConvexError({ code: 'MATCHED_CLIENT' }),
      bookingErrorCopy(property, (id) =>
        id === 'c-jane' ? 'Jane Nguyen' : undefined,
      ),
    )
    expect(words).toBe(
      'Could not book this job: Jane Nguyen already has the address as it was before the form changed. Nothing was booked — check the address and book it again.',
    )
    expect(words).not.toMatch(/\bsee\b|signal|'|\b(?:they|their|them)\b/)
    // No button named: the one pressed read Book job or Book anyway.
    expect(words).not.toMatch(/\bpressed\b|\bBook\b/)
    expect(
      describeError(
        new ConvexError({ code: 'SITE_BOOKED' }),
        bookingErrorCopy(property, () => 'Jane Nguyen'),
      ),
    ).toBe(BOOKING_ERROR_COPY.SITE_BOOKED)
    expect(
      describeError(
        new ConvexError({ code: 'MATCHED_CLIENT' }),
        bookingErrorCopy(property, () => undefined),
      ),
    ).toMatch(/^Could not book this job: the client chosen already has/)
  })
})
