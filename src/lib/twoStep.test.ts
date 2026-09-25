import { describe, expect, test } from 'vitest'
import { ConvexError } from 'convex/values'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import {
  NEW_KEY_HEADER,
  NEW_KEY_HEADER_VALUE,
} from '../../convex/lib/twoFactorSetup'
import {
  SETUP_CLEARED,
  SETUP_SIGN_IN_LOST,
  SIGNED_OUT_HERE,
  START_OVER_WARNING,
  answered,
  deleteEntryHow,
  describeTwoFactorError,
  isMfaEnrolmentError,
  isSignInLost,
  isTwoStepNeeded,
  newKeyRequest,
  passwordStepAction,
  passwordStepCopy,
  passwordStepError,
  remindAfterRefusedCode,
  resumeFlow,
  scanStepNotice,
  setupCodeError,
  startOverFailed,
  watchForTwoStepRefusals,
  normaliseRecoveryCode,
  normaliseTotpCode,
  safeNext,
  setupKeyOf,
  twoStepHref,
} from './twoStep'
import type { TwoFactorSetupState } from './twoStep'

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

  test('the rate limit asks for a minute, which is how long it can last', () => {
    // Better Auth's 429 has no code, only "Too many requests…". The code
    // check's window is 60 s (convex/auth.ts), so "a few seconds" was wrong.
    const limited = describeTwoFactorError({
      status: 429,
      message: 'Too many requests. Please try again later.',
    })
    expect(limited.message).toMatch(/Wait a minute/)
    expect(limited.restart).toBe(false)
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

describe('setting up carries on with the same key', () => {
  // The production bug: every enable makes a new key, and the set-up screen
  // called it whenever its password step came round again, so the entry
  // already added to the authenticator never matched.
  const signedIn = (setup?: TwoFactorSetupState) => ({ signedIn: true, setup })

  test('an unfinished set-up this session started is carried on with, never started again', () => {
    expect(passwordStepAction(signedIn('unfinished'), false)).toBe('resume')
    // Even after this page lost track of a key: the one there is now is
    // this session's, so it is shown (as "the key that works now").
    expect(passwordStepAction(signedIn('unfinished'), true)).toBe('resume')
  })

  test('nothing started starts with a first key', () => {
    expect(passwordStepAction(signedIn('none'), false)).toBe('start')
  })

  test('a key that cannot be carried on with here is replaced, on purpose', () => {
    // Started in another browser or on another device — or by someone else
    // holding the password: its key is never shown here.
    expect(passwordStepAction(signedIn('elsewhere'), false)).toBe('restart')
    // The half-off state: its row is already marked verified, so a code
    // from it would turn nothing on (convex/lib/twoFactorSetup.ts).
    expect(passwordStepAction(signedIn('stale'), false)).toBe('restart')
    // Gone from under this page, which had shown it: they may have an entry.
    expect(passwordStepAction(signedIn('none'), true)).toBe('restart')
  })

  test('already on is nothing to do', () => {
    expect(passwordStepAction(signedIn('on'), false)).toBe('leave')
    expect(passwordStepAction(signedIn('on'), true)).toBe('leave')
  })

  test('a page that has lost its sign-in offers no Start', () => {
    // twoFactorStatus answers a caller it sees as signed out with "none".
    // Believing it would make a new key over the one already added.
    for (const setup of [
      'none',
      'unfinished',
      'elsewhere',
      'stale',
      'on',
      undefined,
    ] as const) {
      for (const hadKey of [false, true]) {
        expect(passwordStepAction({ signedIn: false, setup }, hadKey)).toBe(
          'signed-out',
        )
      }
    }
  })

  test('no status yet is a wait, not a guess', () => {
    expect(passwordStepAction(undefined, false)).toBe('wait')
    expect(passwordStepAction(undefined, true)).toBe('wait')
  })

  test('a backend too old to say starts as set-up always did', () => {
    expect(passwordStepAction(signedIn(undefined), false)).toBe('start')
  })

  test('the password step says which it is doing', () => {
    expect(passwordStepCopy('resume', 'unfinished').submit).toBe(
      'Continue setting up',
    )
    expect(passwordStepCopy('resume', 'unfinished').hint).toMatch(/same key/)
    expect(passwordStepCopy('start', 'none').submit).toBe('Start')
    expect(passwordStepCopy('wait', undefined).submit).not.toBe('Start')

    const restart = passwordStepCopy('restart', 'elsewhere')
    expect(restart.submit).toMatch(/new key/)
    // First, the likeliest: signed out and back in on this same phone,
    // which makes a new session, and a set-up belongs to its session.
    expect(restart.hint).toMatch(/before you last signed in/)
    expect(restart.hint).toMatch(/another device or in another browser/)
    // Including the key production already has, made by the old screen
    // before sessions claimed their keys.
    expect(restart.hint).toMatch(/older version/)
    // None of those means someone else has the password — said as a
    // possibility, not an accusation of the person who just signed back in.
    expect(restart.hint).toMatch(
      /If none of those was you, change your password/,
    )
    expect(restart.hint).not.toMatch(/did not start it at all/)
    expect(passwordStepCopy('restart', 'stale').hint).toMatch(
      /partly switched off/,
    )
    expect(passwordStepCopy('restart', 'none').hint).toMatch(/has gone/)
    for (const setup of ['elsewhere', 'stale', 'none'] as const) {
      expect(passwordStepCopy('restart', setup).hint).toMatch(
        /what to delete first/,
      )
    }
  })
})

describe('what the key on screen warns about', () => {
  test('a key is replaced only with the warning on screen, and only then', () => {
    // The two halves of one decision: the header that lets the server
    // replace a key, and the amber warning to delete every PestM8 entry.
    const restart = newKeyRequest('restart')
    expect(restart.headers).toEqual({ [NEW_KEY_HEADER]: NEW_KEY_HEADER_VALUE })
    expect(restart.flow).toBe('replaced')
    const notice = scanStepNotice(restart.flow)
    expect(notice.tone).toBe('warn')
    expect(notice.text).toMatch(/Delete every PestM8 entry/)
    // And says where that entry is, in each app's own words.
    expect(notice.howToDelete).toBe(true)

    const start = newKeyRequest('start')
    expect(start.headers).toBeUndefined()
    expect(start.flow).toBe('fresh')
    expect(scanStepNotice(start.flow).tone).toBe('quiet')
    expect(scanStepNotice(start.flow).howToDelete).toBe(false)
  })

  test('a new key says how to delete the old entry, in each app', () => {
    // The screen shows this with the amber warning — before "Make a new key"
    // and on the key it makes — so the dead entry actually goes.
    expect(START_OVER_WARNING).toMatch(/Delete every PestM8 entry/)
    const how = deleteEntryHow('pestm8.vercel.app')
    // The iPhone keeps the code on the site's login, not under "PestM8".
    expect(how).toMatch(
      /Passwords app → the pestm8\.vercel\.app login → Edit → Delete Verification Code/,
    )
    expect(how).toMatch(/Google or Microsoft Authenticator: delete the PestM8/)
    // Whatever address the page is on, and never "the  login".
    expect(deleteEntryHow('localhost')).toMatch(/the localhost login/)
    expect(deleteEntryHow('')).not.toMatch(/the {2}login/)
    expect(deleteEntryHow('')).toMatch(/Delete Verification Code/)
  })

  test('the same key again says so, and asks nothing of one good entry', () => {
    expect(resumeFlow(false)).toBe('resumed')
    const notice = scanStepNotice('resumed')
    expect(notice.tone).toBe('info')
    expect(notice.text).toMatch(/same key/)
    // One entry, added from this key: use it. Nothing tells them to delete
    // it outright — only a second entry is a reason to.
    expect(notice.text).toMatch(/enter the code it shows/)
    expect(notice.text).not.toMatch(/^[^?]*[Dd]elete/)
  })

  test('the same key again, after a new key and a reload, still says what to delete', () => {
    // "Start again with a new key" warns in amber — and tapping "Add to
    // authenticator app" is the app switch that reloads an iPhone
    // home-screen app. Back, the key is fetched again as `resumed`, with a
    // dead entry from the old key beside the new one. The server cannot
    // tell that from a first key fetched again, so the notice says it
    // either way: more than one entry, delete them all, add this key again —
    // and where the entry is, in each app.
    const notice = scanStepNotice('resumed')
    expect(notice.text).toMatch(/More than one PestM8 entry/)
    expect(notice.text).toMatch(/delete them all, then add this key again/)
    expect(notice.howToDelete).toBe(true)
  })

  test('a key fetched after this page lost track does not claim to be the same', () => {
    expect(resumeFlow(true)).toBe('current')
    const notice = scanStepNotice('current')
    expect(notice.text).not.toMatch(/same key/)
    expect(notice.text).toMatch(/do not match/)
  })

  test('a wrong code at set-up says how to get out of a dead entry', () => {
    const wrong = setupCodeError({ code: 'INVALID_CODE', status: 401 })
    expect(wrong).toMatch(/30 seconds/)
    // The key on screen may itself have been replaced since (another tab or
    // device): a reload shows the current one before anything is re-added.
    expect(wrong).toMatch(/Reload this page/)
    expect(wrong).toMatch(/Delete every PestM8 entry|delete every PestM8 entry/)
    expect(wrong).toMatch(/add it again/)
    expect(wrong).toMatch(/time/)
  })

  test('a code sent after the sign-in has gone says so, and never asks for a password here', () => {
    // A right code whose answer was lost deletes every session; the retry
    // goes out on the old cookie (convex/twoStepFlow.test.ts has the
    // server's side). So do the owner's reset and a sign-out in another tab.
    for (const error of [
      { code: 'INVALID_TWO_FACTOR_COOKIE', status: 401 },
      { code: 'UNAUTHORIZED', status: 401, message: 'Unauthorized' },
    ]) {
      expect(isSignInLost(error)).toBe(true)
      const words = setupCodeError(error)
      expect(words).toBe(SETUP_SIGN_IN_LOST)
    }
    // The scan step has no password field.
    expect(SETUP_SIGN_IN_LOST).not.toMatch(/password/i)
    // Two-step sign-in may be on: say so, how to tell, and about the codes.
    expect(SETUP_SIGN_IN_LOST).toMatch(/may already be on/)
    expect(SETUP_SIGN_IN_LOST).toMatch(/Reload this page/)
    expect(SETUP_SIGN_IN_LOST).toMatch(/PestM8 entry you just added/)
    expect(SETUP_SIGN_IN_LOST).toMatch(/new recovery codes in Settings/)
    // Sign-in itself keeps its own words: there, the password IS next.
    expect(
      describeTwoFactorError({ code: 'INVALID_TWO_FACTOR_COOKIE' }).message,
    ).toMatch(/Enter your password again/)
    expect(isSignInLost({ code: 'INVALID_CODE' })).toBe(false)
    expect(isSignInLost({})).toBe(false)
  })

  test('a key cleared from under the screen is not "TOTP not enabled"', () => {
    const gone = setupCodeError({
      code: 'TOTP_NOT_ENABLED',
      status: 400,
      message: 'TOTP not enabled',
    })
    expect(gone).not.toMatch(/TOTP/)
    expect(gone).toMatch(/Reload/)
    expect(SETUP_CLEARED).not.toMatch(/TOTP/)
  })

  test('any other refusal is worded as everywhere else', () => {
    for (const error of [
      { code: 'INVALID_PASSWORD', status: 400 },
      { status: 500, message: 'HTTPError' },
      { code: 'TWO_STEP_LOCKED', status: 429 },
    ]) {
      expect(setupCodeError(error)).toBe(describeTwoFactorError(error).message)
    }
  })

  test('"already started" blames nobody, since it may be this page\'s own Start', () => {
    // A Start whose answer was lost made the key all the same; pressing
    // Start again before the live status catches up gets this.
    const words = describeTwoFactorError({
      code: 'MFA_SETUP_STARTED',
      status: 409,
    }).message
    expect(words).toMatch(/perhaps from this page/)
    expect(words).toMatch(/Nothing has been changed/)
    expect(words).not.toMatch(/^Set-up has just been started/)
  })

  test('a key refused here names signing in again as a reason', () => {
    expect(
      describeTwoFactorError({ code: 'MFA_SETUP_KEY_UNAVAILABLE' }).message,
    ).toMatch(/before you last signed in/)
  })

  test("the server's set-up refusals are in words, not codes", () => {
    for (const code of ['MFA_SETUP_STARTED', 'MFA_SETUP_KEY_UNAVAILABLE']) {
      const words = describeTwoFactorError({
        code,
        status: 409,
        message: code,
      }).message
      expect(words).not.toMatch(/MFA_|TOTP/)
      expect(words.length).toBeGreaterThan(20)
    }
    expect(
      describeTwoFactorError({ code: 'MFA_SETUP_KEY_UNAVAILABLE' }).message,
    ).toMatch(/new key/)
  })

  test('a failed "new key" never promises the old key still works', () => {
    // The answer can be lost after the server made the new key.
    const lost = startOverFailed({ message: 'Could not reach PestM8.' })
    expect(lost).toMatch(/could not tell/)
    expect(lost).toMatch(/key that works now/)
    // A wrong password is checked before the key is touched (convex/auth.ts).
    expect(startOverFailed({ code: 'INVALID_PASSWORD' })).toMatch(
      /has not changed/,
    )
  })
})

describe('the password step, which has no code on it', () => {
  test('a lost answer says to try again, not to use "the code showing now"', () => {
    for (const error of [
      { message: 'Could not reach PestM8. Try again.' },
      { status: 500, message: 'HTTPError' },
      { status: 502, code: 'SOMETHING' },
    ]) {
      const words = passwordStepError(error)
      expect(words).toMatch(/Couldn't reach PestM8/)
      expect(words).not.toMatch(/code/)
    }
  })

  test('a lost sign-in gets the reload, not the server\'s "Unauthorized"', () => {
    expect(
      passwordStepError({
        code: 'UNAUTHORIZED',
        status: 401,
        message: 'Unauthorized',
      }),
    ).toBe(SIGNED_OUT_HERE)
  })

  test('every other refusal is worded as everywhere else', () => {
    for (const error of [
      { code: 'INVALID_PASSWORD', status: 400 },
      { code: 'MFA_SETUP_STARTED', status: 409 },
      { code: 'MFA_SETUP_KEY_UNAVAILABLE', status: 403 },
      { status: 429, message: 'Too many requests.' },
    ]) {
      expect(passwordStepError(error)).toBe(
        describeTwoFactorError(error).message,
      )
    }
  })
})

describe('whether an answer came at all', () => {
  test('a coded refusal or the rate limit is an answer; a dropped request is not', () => {
    expect(answered({ code: 'INVALID_CODE', status: 401 })).toBe(true)
    expect(answered({ code: 'MFA_ALREADY_ENABLED', status: 400 })).toBe(true)
    expect(answered({ status: 429 })).toBe(true)
    expect(answered({})).toBe(false)
    expect(answered({ status: 500, message: 'HTTPError' })).toBe(false)
    expect(answered({ code: 'X', status: 503 })).toBe(false)
  })
})

describe('the recovery-code reminder after a set-up code is refused', () => {
  // Switched on before the code is sent; this says whether it stays on.
  const wrong = { code: 'INVALID_CODE', status: 401 }
  const alreadyOn = { code: 'MFA_ALREADY_ENABLED', status: 400 }
  const noAnswer = { message: 'Could not reach PestM8. Try again.' }
  const signInLost = { code: 'INVALID_TWO_FACTOR_COOKIE', status: 401 }

  test('a code that provably turned nothing on puts it back as it was', () => {
    expect(remindAfterRefusedCode(wrong, false, false)).toBe(false)
    expect(remindAfterRefusedCode(wrong, true, false)).toBe(true)
    // Another tab turned it on and its codes were saved: no nagging.
    expect(remindAfterRefusedCode(alreadyOn, false, false)).toBe(false)
    // ...or not saved yet: that tab clears it when they are.
    expect(remindAfterRefusedCode(alreadyOn, true, false)).toBe(true)
  })

  test('no answer, or the sign-in gone, keeps it on: two-step may be on with no codes seen', () => {
    // The acceptance itself lost on the way back.
    expect(remindAfterRefusedCode(noAnswer, false, false)).toBe(true)
    // A right code deletes every session: the retry finds none.
    expect(remindAfterRefusedCode(signInLost, false, false)).toBe(true)
    expect(
      remindAfterRefusedCode(
        { code: 'UNAUTHORIZED', status: 401 },
        false,
        false,
      ),
    ).toBe(true)
  })

  test('after a code whose answer never came, "already on" may be its echo', () => {
    // The acceptance was lost but its new cookie landed: the retry is told
    // it is already on — by this page's own code, with no codes ever shown.
    expect(remindAfterRefusedCode(alreadyOn, false, true)).toBe(true)
    expect(remindAfterRefusedCode(wrong, false, true)).toBe(true)
  })
})
