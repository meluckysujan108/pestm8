import { describe, expect, test } from 'vitest'
import { passesOn, pickAuthCookie } from './authCookies'

/**
 * The auth proxy can pass on one Set-Cookie per response. These are the
 * sequences Better Auth writes, in the order it writes them (the flow test in
 * convex/twoStepFlow.test.ts runs the real endpoints and checks the same
 * choice against what they actually send).
 */

const SET_SESSION =
  '__Secure-better-auth.session_token=abc.sig; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax'
const CLEAR_SESSION =
  '__Secure-better-auth.session_token=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax'
const CLEAR_DATA =
  '__Secure-better-auth.session_data=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax'
const CLEAR_DONT_REMEMBER =
  '__Secure-better-auth.dont_remember=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax'
const SET_CHALLENGE =
  '__Secure-better-auth.two_factor=2fa-xyz.sig; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax'
const CLEAR_CHALLENGE =
  '__Secure-better-auth.two_factor=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax'
const JWT =
  '__Secure-better-auth.convex_jwt=eyJ.x.y; Max-Age=900; Path=/; HttpOnly; Secure; SameSite=Lax'

describe('the one cookie the auth proxy passes on', () => {
  test('a plain sign-in keeps the session, not the JWT sent after it', () => {
    expect(pickAuthCookie([SET_SESSION, JWT])).toBe(SET_SESSION)
  })

  test('a password that needs a code keeps the challenge', () => {
    expect(
      pickAuthCookie([SET_SESSION, CLEAR_SESSION, CLEAR_DATA, SET_CHALLENGE]),
    ).toBe(SET_CHALLENGE)
  })

  test('a correct code keeps the new session, not the challenge being cleared', () => {
    expect(pickAuthCookie([SET_SESSION, CLEAR_CHALLENGE])).toBe(SET_SESSION)
  })

  test('sign-out keeps the session being cleared', () => {
    expect(
      pickAuthCookie([CLEAR_SESSION, CLEAR_DATA, CLEAR_DONT_REMEMBER, JWT]),
    ).toBe(CLEAR_SESSION)
  })

  test('works on the unprefixed names local dev uses', () => {
    const dev = SET_CHALLENGE.replace('__Secure-', '')
    expect(pickAuthCookie([SET_SESSION.replace('__Secure-', ''), dev])).toBe(
      SET_SESSION.replace('__Secure-', ''),
    )
  })

  test('a date in the past counts as clearing', () => {
    const expired =
      'better-auth.session_token=abc; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/'
    expect(pickAuthCookie([expired, SET_CHALLENGE])).toBe(SET_CHALLENGE)
  })

  test('anything else: the last cookie that is not the JWT, as before', () => {
    const theme = 'pestm8-theme=dark; Path=/'
    expect(pickAuthCookie([theme, JWT])).toBe(theme)
    expect(pickAuthCookie([JWT])).toBeNull()
    expect(pickAuthCookie([])).toBeNull()
  })
})

describe('what a read may do to the session cookie', () => {
  // A read that set out on a cookie since replaced — the Convex token, the
  // session check — is answered "no such session" with the session cookie
  // cleared, and that clearing lands on the browser's NEW cookie. It signed
  // people out the moment two-step sign-in came on (convex/twoStepFlow.test.ts,
  // "a read already on its way when the code is checked").
  test('a read does not clear the session cookie', () => {
    expect(passesOn('GET', CLEAR_SESSION)).toBe(false)
    expect(passesOn('GET', CLEAR_SESSION.replace('__Secure-', ''))).toBe(false)
  })

  test('a read still renews it', () => {
    expect(passesOn('GET', SET_SESSION)).toBe(true)
  })

  test('signing out, signing in and checking a code still clear it', () => {
    expect(passesOn('POST', CLEAR_SESSION)).toBe(true)
  })

  test('only the session cookie is held back', () => {
    expect(passesOn('GET', CLEAR_CHALLENGE)).toBe(true)
    expect(passesOn('GET', 'pestm8-theme=dark; Path=/')).toBe(true)
  })
})
