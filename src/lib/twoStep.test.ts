import { describe, expect, test } from 'vitest'
import { ConvexError } from 'convex/values'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import {
  describeTwoFactorError,
  isMfaEnrolmentError,
  isTwoStepNeeded,
  watchForTwoStepRefusals,
  normaliseRecoveryCode,
  normaliseTotpCode,
  safeNext,
  setupKeyOf,
  twoStepHref,
} from './twoStep'

describe('where set-up returns to', () => {
  test('a path on this site is kept', () => {
    expect(safeNext('/join/abc123')).toBe('/join/abc123')
    expect(safeNext('/coastal-pest/schedule?day=2026-09-24')).toBe(
      '/coastal-pest/schedule?day=2026-09-24',
    )
  })

  test('anything that could leave the app goes home instead', () => {
    for (const bad of [
      'https://evil.example/',
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      '',
      undefined,
      42,
    ]) {
      expect(safeNext(bad)).toBe('/')
    }
  })

  test('never back to set-up or sign-in, which would loop', () => {
    expect(safeNext('/two-step')).toBe('/')
    expect(safeNext('/two-step?next=/x')).toBe('/')
    expect(safeNext('/login')).toBe('/')
  })

  test('the link to set-up carries it', () => {
    expect(twoStepHref('/join/abc')).toBe('/two-step?next=%2Fjoin%2Fabc')
    expect(twoStepHref('/')).toBe('/two-step')
    expect(twoStepHref('https://evil.example')).toBe('/two-step')
  })
})

describe('the refusal the server sends an un-enrolled account', () => {
  test('is recognised as a ConvexError and as a message', () => {
    expect(isMfaEnrolmentError(new ConvexError('MFA_ENROLMENT_REQUIRED'))).toBe(
      true,
    )
    expect(isMfaEnrolmentError(new ConvexError('NO_ACCESS'))).toBe(false)
    expect(isMfaEnrolmentError(new Error('boom'))).toBe(false)
  })
})

describe('typed codes', () => {
  test('recovery codes match however they were copied down', () => {
    expect(normaliseRecoveryCode('abcde-fghjk')).toBe('abcde-fghjk')
    expect(normaliseRecoveryCode('ABCDE FGHJK')).toBe('abcde-fghjk')
    expect(normaliseRecoveryCode(' abcdefghjk ')).toBe('abcde-fghjk')
  })

  test('authenticator codes keep only digits, six of them', () => {
    expect(normaliseTotpCode('123 456')).toBe('123456')
    expect(normaliseTotpCode('123-4567')).toBe('123456')
  })

  test('the setup key is read out of the link, in fours', () => {
    expect(
      setupKeyOf(
        'otpauth://totp/PestM8:kevin@example.test?secret=JBSWY3DPEHPK3PXP&issuer=PestM8',
      ),
    ).toBe('JBSW Y3DP EHPK 3PXP')
    expect(setupKeyOf('not a uri')).toBe('')
  })
})

describe('two-factor errors in plain words', () => {
  test('an expired challenge sends them back to the password', () => {
    expect(
      describeTwoFactorError({ code: 'INVALID_TWO_FACTOR_COOKIE' }).restart,
    ).toBe(true)
    expect(
      describeTwoFactorError({ code: 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE' })
        .restart,
    ).toBe(true)
  })

  test('a wrong code lets them try again where they are', () => {
    const wrong = describeTwoFactorError({ code: 'INVALID_CODE' })
    expect(wrong.restart).toBe(false)
    expect(wrong.message).toMatch(/30 seconds/)
  })

  test('an unreachable server never shows the fetch library name', () => {
    // What better-fetch hands back when the backend answers 500 with no body.
    const down = describeTwoFactorError({ status: 500, message: 'HTTPError' })
    expect(down.message).not.toMatch(/HTTPError/)
    expect(down.message).toMatch(/signal/)
    expect(down.restart).toBe(false)
  })

  test("a coded refusal keeps the server's own words", () => {
    const words = describeTwoFactorError({
      code: 'MFA_ALREADY_ENABLED',
      status: 400,
      message: 'Two-step sign-in is already set up on this account.',
    })
    expect(words.message).toBe(
      'Two-step sign-in is already set up on this account.',
    )
  })
})

describe('a refusal pushed to a live query', () => {
  // How @convex-dev/react-query delivers a query the server now refuses:
  // `setState` on the entry, which the cache's onError never sees.
  function push(client: QueryClient, key: Array<string>, error: Error) {
    client
      .getQueryCache()
      .find({ queryKey: key })
      ?.setState({ error, status: 'error', fetchStatus: 'idle' })
  }

  test('turns the set-up prompt on, but only for this refusal on a query on screen', () => {
    const client = new QueryClient()
    const stop = watchForTwoStepRefusals(client)
    client.setQueryData(['shown'], 'the job sheet')
    client.setQueryData(['guard'], 'cached for a guard')
    const observer = new QueryObserver(client, {
      queryKey: ['shown'],
      queryFn: () => 'the job sheet',
      enabled: false,
    })
    const unsubscribe = observer.subscribe(() => {})

    // Nothing is showing the guard's entry: its own redirect handles it.
    push(client, ['guard'], new ConvexError('MFA_ENROLMENT_REQUIRED'))
    expect(isTwoStepNeeded()).toBe(false)
    // Any other refusal is the page's to report.
    push(client, ['shown'], new ConvexError('NO_ACCESS'))
    expect(isTwoStepNeeded()).toBe(false)

    push(client, ['shown'], new ConvexError('MFA_ENROLMENT_REQUIRED'))
    expect(isTwoStepNeeded()).toBe(true)

    unsubscribe()
    stop()
  })
})

describe('the per-account lock', () => {
  test('is worded, and goes back to the password', () => {
    const words = describeTwoFactorError({
      code: 'TWO_STEP_LOCKED',
      status: 429,
    })
    expect(words.restart).toBe(true)
    expect(words.message).toMatch(/15 minutes/)
  })
})
