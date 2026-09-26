import { describe, expect, test } from 'vitest'
import { APIError } from 'better-auth/api'
import { inviteRefusalMessage, isBreachVerdict } from './auth'

/**
 * Telling an outage apart from a verdict.
 *
 * The breach check guards `/change-password` and `/reset-password` as well as
 * sign-up, and upstream turns every failure of api.pwnedpasswords.com into a
 * 500 — so a third party going down takes out the password recovery paths,
 * which are exactly what someone needs when something has already gone wrong.
 * An outage of that service failed 54 of 127 e2e tests in one run.
 *
 * These two cases are the whole rule. Get the first wrong and a breached
 * password is accepted; get the second wrong and nobody can change a password
 * while someone else's API is down.
 */
describe('a breach check failure', () => {
  test('is honoured when the service gave a verdict', () => {
    // Exactly what the plugin throws on a match.
    const verdict = APIError.from('BAD_REQUEST', {
      message: 'The password you entered has been compromised.',
      code: 'PASSWORD_COMPROMISED',
    })
    expect(isBreachVerdict(verdict)).toBe(true)
  })

  test('is not honoured when the service could not be reached', () => {
    // Exactly what the plugin throws when the fetch fails.
    const outage = new APIError('INTERNAL_SERVER_ERROR', {
      message: 'Failed to check password. Please try again later.',
    })
    expect(isBreachVerdict(outage)).toBe(false)
  })

  /** A refusal has to come from the service, not from anything that happens to
   * be an error on the way there. */
  test('is not inferred from anything that is not an API error', () => {
    expect(isBreachVerdict(new TypeError('fetch failed'))).toBe(false)
    expect(isBreachVerdict(new Error('PASSWORD_COMPROMISED'))).toBe(false)
    expect(isBreachVerdict(null)).toBe(false)
    expect(isBreachVerdict({ body: { code: 'PASSWORD_COMPROMISED' } })).toBe(
      false,
    )
  })
})

/**
 * The invite-only sign-up gate's refusals. The one that matters: a live link
 * with the wrong address typed must not read as a dead link — it did, and the
 * person went looking for a new link instead of retyping their email.
 */
describe('an invitation refused at sign-up', () => {
  test('names the address, not the link, when the address is wrong', () => {
    const message = inviteRefusalMessage('INVITE_EMAIL_MISMATCH')
    expect(message).toMatch(/different email address/)
    expect(message).not.toMatch(/not valid/)
  })

  test('says used for either kind of link', () => {
    expect(inviteRefusalMessage('INVITE_CLAIMED')).toMatch(/already been used/)
    expect(inviteRefusalMessage('INVITE_ALREADY_USED')).toMatch(
      /already been used/,
    )
  })

  test('says expired and withdrawn as such', () => {
    expect(inviteRefusalMessage('INVITE_EXPIRED')).toMatch(/expired/)
    expect(inviteRefusalMessage('INVITE_REVOKED')).toMatch(/withdrawn/)
  })

  test('falls back to not valid for anything else', () => {
    expect(inviteRefusalMessage('INVITE_INVALID')).toMatch(/not valid/)
    expect(inviteRefusalMessage('INVITE_LEGACY')).toMatch(/not valid/)
  })
})
