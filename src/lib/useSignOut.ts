import { useCallback, useRef, useState } from 'react'
import { authClient } from '#/lib/auth-client'
import { confirmLeave } from '#/lib/offline/leaveGuard'
import { isOffline } from '#/lib/online'
import { outbox } from '#/lib/outbox/outbox'
import {
  UNREADABLE_QUESTION,
  confirmedLeave,
  notSentOnPhone,
  signOutFailedWords,
} from '#/lib/outbox/leaveAsk'
import {
  beginSignOut,
  forgetCachedPages,
  signOutFailed,
  signedInUserId,
} from '#/lib/rootState'
import { signOutWithin } from '#/lib/signOutWithin'

/** How long a sign-out waits for PestM8 to answer, at most. */
export const SIGN_OUT_WAIT_MS = 10_000

/** What a sign-out says when it can't go ahead, in the amber box above it. */
export const SIGN_OUT_COPY = {
  offline: 'Signing out needs signal.',
  failed: signOutFailedWords(0),
} as const

/**
 * Signing out, for every way out there is (plan part 2c §11.3, S20):
 * Settings' Sign out, the no-business screen's, set-up's "Signed in as …",
 * the two-step screen's, and the join and start pages' (`then: 'reload'`,
 * which load the same link again for whoever signs in next). A full load
 * finishes it, so nothing cached for this person is shown to the next.
 *
 * With no signal it says so and does nothing else: the person is still
 * signed in, here and on the server, and nothing is cleared. Otherwise,
 * once anything that would be lost has asked (`confirmLeave`: the bookings
 * on this phone not sent yet, `OutboxLeaveGuard`) and the signal is asked
 * about again (an answer can take a while), everything kept on this phone
 * for them goes first (`beginSignOut`), then the request, given ten seconds
 * (`signOutWithin`).
 *
 * One that fails or doesn't answer in time says so, the page gets around on
 * the cached sign-in again (`signOutFailed`), and it can be tapped again. A
 * request given up on still goes, and if it lands after all, the sign-out
 * finishes then. Bookings the confirm discarded stay discarded, and it says
 * so: "The 2 jobs not sent yet were discarded." (plan D27), or, after the
 * question asked when the phone couldn't be read, "Any jobs not sent yet on
 * this phone were discarded." One being sent as it went is never said to be
 * discarded, as its call is still out: "1 being sent may still be booked —
 * check the schedule before booking it again."
 *
 * `problem` is the words for a `FormAlert` just above the button, or null.
 * `checking` is true from the tap until the question is answered (or found
 * not needed), which can take seconds (lib/outbox/leaveAsk.ts): the button
 * says "Signing out…" meanwhile, `aria-disabled` rather than `disabled`, so
 * focus can go back to it once the question is answered stay.
 */
export function useSignOut({ then }: { then: 'login' | 'reload' }): {
  signOut: () => Promise<void>
  signingOut: boolean
  checking: boolean
  problem: string | null
} {
  const [signingOut, setSigningOut] = useState(false)
  const [checking, setChecking] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // A second tap while the first is still asking is the same tap.
  const busy = useRef(false)

  const signOut = useCallback(async () => {
    if (busy.current) return
    setProblem(null)
    if (isOffline()) {
      setProblem(SIGN_OUT_COPY.offline)
      return
    }
    busy.current = true
    setChecking(true)
    try {
      const go = await confirmLeave('signOut')
      // What was asked, read in the same turn as the answer.
      const asked = go ? confirmedLeave() : null
      setChecking(false)
      if (!go) return
      if (isOffline()) {
        setProblem(SIGN_OUT_COPY.offline)
        return
      }
      setSigningOut(true)
      // What the sign-out discards, counted as it does so, for the words if
      // the request then fails: after the question asked of a phone that
      // couldn't be read, nobody knows how many. One being sent is counted
      // apart: its call is out, and this page stays signed in if the
      // request fails, so it may still be booked (`signOutFailedWords`).
      const unsent = notSentOnPhone(outbox.all(), signedInUserId())
      const sending = unsent.filter((item) => item.state === 'sending').length
      const discarded =
        asked === UNREADABLE_QUESTION ? 'unknown' : unsent.length - sending
      // Before the request, so nothing kept on this phone for them is
      // written again while it is in flight (rootState.ts).
      beginSignOut()
      const { inTime, landed } = await signOutWithin(
        authClient.signOut(),
        SIGN_OUT_WAIT_MS,
      )
      if (inTime) {
        await leaveAfterSignOut(then)
        return
      }
      signOutFailed()
      setSigningOut(false)
      setProblem(signOutFailedWords(discarded, sending))
      void landed.then((ok) => (ok ? leaveAfterSignOut(then) : undefined))
    } finally {
      busy.current = false
      setChecking(false)
    }
  }, [then])

  return { signOut, signingOut, checking, problem }
}

/**
 * The end of a sign-out the server has made. A full load, not a soft
 * navigation, so every cached query and component tied to the old identity
 * is gone rather than briefly visible to whoever signs in next on this
 * device: the sign-in page, in place of the page left (`replace`, so Back
 * doesn't return to it), or the same link again.
 */
async function leaveAfterSignOut(then: 'login' | 'reload'): Promise<void> {
  await forgetCachedPages()
  if (then === 'reload') window.location.reload()
  else window.location.replace('/login')
}
