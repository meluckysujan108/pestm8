import { describe, expect, it } from 'vitest'
import { LOADING, askPassword, checkPassword } from './documentState'

/**
 * A locked PDF's password round trip. The rule that matters: trying a
 * password never leaves the password phase, because leaving it unmounts the
 * field and takes the iPhone's keyboard with it (see `checkPassword`).
 */

describe('password', () => {
  it('is asked for, not yet refused', () => {
    expect(askPassword(false)).toEqual({
      phase: 'password',
      wrong: false,
      checking: false,
    })
  })

  it('stays on the form while pdf.js tries it', () => {
    const trying = checkPassword(askPassword(false))
    expect(trying).toEqual({ phase: 'password', wrong: false, checking: true })
    // A second Open while the first is out changes nothing.
    expect(checkPassword(trying)).toBe(trying)
  })

  it('comes back to the same form, refused, when it is wrong', () => {
    const trying = checkPassword(askPassword(true))
    // Still marked wrong from the last try while this one is checked; the
    // form hides the message until the answer is in.
    expect(trying).toMatchObject({ phase: 'password', checking: true })
    expect(askPassword(true)).toEqual({
      phase: 'password',
      wrong: true,
      checking: false,
    })
  })

  it('leaves any other phase alone', () => {
    expect(checkPassword(LOADING)).toBe(LOADING)
    const failed = { phase: 'error', reason: 'damaged' } as const
    expect(checkPassword(failed)).toBe(failed)
  })
})
