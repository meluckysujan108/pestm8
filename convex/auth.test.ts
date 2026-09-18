import { describe, expect, test } from 'vitest'
import { APIError } from 'better-auth/api'
import { isBreachVerdict } from './auth'

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
