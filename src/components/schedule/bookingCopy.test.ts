import { describe, expect, test } from 'vitest'
import { ConvexError } from 'convex/values'
import { describeError } from '#/components/forms/describeError'
import { BOOKING_ERROR_COPY } from './bookingCopy'

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
