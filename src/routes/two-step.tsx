import { useRef, useState } from 'react'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { Check, Copy } from 'lucide-react'
import { z } from 'zod'
import { api } from '../../convex/_generated/api'
import { QrCode } from '#/components/auth/QrCode'
import { RecoveryCodes } from '#/components/auth/RecoveryCodes'
import { authClient } from '#/lib/auth-client'
import { beginSignOut, forgetCachedPages } from '#/lib/rootState'
import {
  RECOVERY_CODES_NOT_MADE,
  SETUP_CLEARED,
  SETUP_SIGN_IN_LOST,
  SIGNED_OUT_HERE,
  START_OVER_WARNING,
  answered,
  deleteEntryHow,
  isSignInLost,
  newKeyRequest,
  normaliseTotpCode,
  passwordStepAction,
  passwordStepCopy,
  passwordStepError,
  remindAfterRefusedCode,
  resumeFlow,
  safeNext,
  scanStepNotice,
  setupCodeError,
  setupKeyOf,
  startOverFailed,
} from '#/lib/twoStep'
import {
  markRecoveryCodesUnsaved,
  recoveryCodesUnsaved,
} from '#/lib/twoStepReminders'
import { useHydrated } from '#/lib/useHydrated'
import type { SetupFlow, SetupStatus } from '#/lib/twoStep'
import {
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from '#/components/primitives/buttons'
import { FIELD } from '#/components/forms/FormField'
import { FormAlert } from '#/components/forms/FormAlert'

/**
 * Setting up two-step sign-in. Optional (convex/lib/mfa.ts): people arrive
 * here from "Turn on two-step sign-in" in Settings → Two-step sign-in, and "Not now"
 * takes them back. Where a deployment makes it compulsory
 * (`AUTH_MFA_REQUIRED=on`), this is also where the app sends anyone signed in
 * who has not done it — after creating an account from an invitation, after
 * the owner has reset them — the server refuses them everything else until it
 * is done (`requireAuthUser`), and the way out is Sign out instead.
 *
 * Three steps: confirm the password (the server asks for it — a phone left
 * unlocked on a bench is not enough to change how its owner signs in), add
 * the account to an authenticator app and prove it with a code, then save the
 * recovery codes. `twoFactorEnabled` only flips at the code, so leaving
 * half-way turns nothing on.
 *
 * Leaving half-way does leave a KEY, though, and the next visit carries on
 * with it rather than making another. Every `/two-factor/enable` makes a new
 * secret and replaces the old one, and this screen used to call it every time
 * it showed the password step — so anything that brought that step back
 * after the person had added PestM8 to their authenticator (an iPhone
 * home-screen app reloaded on the way back from the authenticator, a second
 * tap on Start, going back) left them with an entry whose codes never
 * matched. Now the server says how far set-up has got, as seen from this
 * session (`twoFactorStatus().setup`), and a set-up this session started
 * shows the SAME key again (`/two-factor/get-totp-uri`). One started
 * anywhere else is never shown here — it may not be the person's at all
 * (convex/lib/twoFactorSetup.ts) — so it starts again with a new key. A new
 * key over an old one is only ever made on purpose, with the warning to
 * delete the old entry, and the server refuses one that did not ask.
 * `passwordStepAction` in lib/twoStep.ts decides which.
 *
 * `next` brings them back to where they were going — the invitation they were
 * accepting, the page they opened — through `safeNext`, so it can only ever
 * be a path on this site.
 */
export const Route = createFileRoute('/two-step')({
  validateSearch: z.object({ next: z.string().optional() }),
  beforeLoad: async ({ context, search }) => {
    if (!context.isAuthenticated) throw redirect({ to: '/login' })

    const status = await context.queryClient.ensureQueryData(
      convexQuery(api.auth.twoFactorStatus, {}),
    )
    if (!status.signedIn) throw redirect({ to: '/login' })
    // Already set up: nothing to do here.
    if (status.enabled) throw redirect({ href: safeNext(search.next) })
  },
  component: TwoStepPage,
})

/**
 * The key on the scan step. No recovery codes: enable's are never shown —
 * another tab's set-up may have replaced them by the time this one's code is
 * right — and the codes are made after the code instead, so the ones on
 * screen are always the ones stored.
 */
type Setup = { totpURI: string; flow: SetupFlow }

/** After the code: recovery codes being made, ready to save, or not made. */
type AfterCode =
  | { kind: 'making' }
  | { kind: 'codes'; codes: Array<string> }
  | { kind: 'no-codes' }

/** A request that never reached the server, shaped as the auth client
 * answers, so every call site handles one kind of failure. */
function unreachable() {
  return {
    data: null,
    error: { message: 'Could not reach PestM8. Try again.' },
  }
}

function codeOf(error: object): string | undefined {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function TwoStepPage() {
  const { next } = Route.useSearch()
  const router = useRouter()
  // Already in the cache from beforeLoad, and live from here on. Compulsory
  // changes the words and the way out: nothing to go back to, so Sign out
  // rather than Not now. `setup` decides what the password step does.
  const status = useQuery(convexQuery(api.auth.twoFactorStatus, {})).data
  const required = status?.required === true
  const [setup, setSetup] = useState<Setup | null>(null)
  const [after, setAfter] = useState<AfterCode | null>(null)
  // This page has shown a key it has since lost track of — cleared from
  // under it, or a "new key" that failed half-way — so the person may have an
  // entry from it. The next new key warns, and a key fetched again says it
  // may not be the one they have (`passwordStepAction`, `resumeFlow`).
  const [hadKey, setHadKey] = useState(false)
  // Why the password step is back, when a "new key" sent it there.
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null)
  // Whose set-up this is, for the reminders (lib/twoStepReminders). Held once
  // known: checking the code replaces the session, after which this query is
  // refused until the page reloads.
  const user = useQuery(convexQuery(api.auth.getCurrentUser, {})).data
  const userIdRef = useRef<string | null>(null)
  if (user?._id && userIdRef.current === null) userIdRef.current = user._id
  const userId = userIdRef.current
  /**
   * The password, from the password step until the code is right: the
   * recovery codes are made after the code (the server asks for it again),
   * and "Start over with a new key" needs it too. In this page's memory and
   * nowhere else — never browser storage, never the URL, never sent anywhere
   * but those requests — and cleared the moment neither can happen any more.
   * A reload drops it with everything else, and the password step asks again.
   */
  const password = useRef<string | null>(null)

  /**
   * A full load into the app, as sign-in does. Checking the code replaces the
   * session (Better Auth rotates it when two-step sign-in is switched on), and
   * the Convex client holds a token for the old one until a page load — every
   * query after this would be refused until then.
   */
  async function finish() {
    password.current = null
    await forgetCachedPages()
    window.location.replace(safeNext(next))
  }

  function onReady(ready: Setup, typed: string) {
    password.current = typed
    setPasswordNotice(null)
    setSetup(ready)
  }

  async function onVerified() {
    // On from here, whether or not codes are ever saved: until "I've saved
    // these", Settings asks for new ones. The scan step switched that
    // reminder on before it sent the code, so an acceptance lost on the way
    // back is covered too (`remindAfterRefusedCode` in lib/twoStep.ts).
    // The code just replaced the session; the new cookie is already in
    // place, and this goes out with it. Two-step sign-in is on either way —
    // if the codes cannot be made, say so and leave Settings asking for them.
    const typed = password.current
    password.current = null
    setAfter({ kind: 'making' })
    const result =
      typed === null
        ? null
        : await authClient.twoFactor
            .generateBackupCodes({ password: typed })
            .catch(() => null)
    setAfter(
      result?.data
        ? { kind: 'codes', codes: result.data.backupCodes }
        : { kind: 'no-codes' },
    )
  }

  /**
   * "Start over with a new key", from a set-up that carried on with its
   * earlier one: enable, on purpose this time, with the password typed a
   * moment ago. Either way the scan step it came from goes: a new key
   * replaces it, and a failure goes back to the password step — whether the
   * old key still works is not known any more (the answer may have been lost
   * after the server made the new one), and the password step follows the
   * live state to whichever key is there now.
   */
  async function startOver(): Promise<void> {
    const typed = password.current
    const request = newKeyRequest('restart')
    const result =
      typed === null
        ? unreachable()
        : await authClient.twoFactor
            .enable({
              password: typed,
              fetchOptions: { headers: request.headers },
            })
            .catch(unreachable)
    if (result.error) {
      if (codeOf(result.error) === 'MFA_ALREADY_ENABLED') {
        void finish()
        return
      }
      password.current = null
      setHadKey(true)
      setPasswordNotice(startOverFailed(result.error))
      setSetup(null)
      return
    }
    setSetup({ totpURI: result.data.totpURI, flow: request.flow })
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col justify-center px-6 py-10">
      <div className="mb-6">
        <p className="section-label mb-2">PestM8</p>
        <h1 className="text-page-title text-ink">
          {after === null
            ? 'Set up two-step sign-in'
            : after.kind === 'no-codes'
              ? 'Two-step sign-in is on'
              : 'Save your recovery codes'}
        </h1>
        {after === null && (
          <p className="mt-2 text-body text-muted">
            {required
              ? 'Every PestM8 account now signs in with a password and a 6-digit code from an authenticator app on your phone. It keeps client records safe if a password gets out. It takes about a minute.'
              : 'Once it is on, signing in asks for your password and a 6-digit code from an authenticator app on your phone, so a password that gets out is not enough on its own. You stay signed in until you sign out, so the code is only asked for when you sign in again. Turning it on signs you out on your other devices — sign in there again with a code. It takes about a minute.'}
          </p>
        )}
      </div>

      {after?.kind === 'codes' ? (
        <RecoveryCodes
          codes={after.codes}
          onDone={() => {
            if (userId) markRecoveryCodesUnsaved(userId, false)
            void finish()
          }}
        />
      ) : after?.kind === 'making' ? (
        <p role="status" className="text-body text-muted">
          Making your recovery codes…
        </p>
      ) : after?.kind === 'no-codes' ? (
        <div className="flex flex-col gap-4">
          <FormAlert>{RECOVERY_CODES_NOT_MADE}</FormAlert>
          <button
            type="button"
            onClick={() => void finish()}
            className={PRIMARY_BUTTON}
          >
            Continue
          </button>
        </div>
      ) : setup ? (
        <ScanStep
          // A new key is a new step: nothing typed for the old one carries.
          key={setup.totpURI}
          setup={setup}
          userId={userId}
          signedOut={status?.signedIn === false}
          onVerified={() => void onVerified()}
          onAlreadyOn={() => void finish()}
          onStartOver={
            setup.flow === 'resumed' || setup.flow === 'current'
              ? startOver
              : undefined
          }
        />
      ) : (
        <PasswordStep
          status={status}
          hadKey={hadKey}
          notice={passwordNotice}
          onReady={onReady}
          onKeyGone={() => setHadKey(true)}
          onAlreadyOn={() => void finish()}
        />
      )}

      {after === null && !required && (
        <button
          type="button"
          // Leaving half-way turns nothing on (`twoFactorEnabled` only flips
          // at the code), and the key made so far is picked up next time.
          onClick={() => void router.navigate({ href: safeNext(next) })}
          className="mt-8 min-h-11 text-body text-blue"
        >
          Not now
        </button>
      )}

      {after === null && required && (
        <div className="mt-8 flex flex-col items-center gap-1">
          <button
            type="button"
            // A reload, as Settings' sign-out does: whoever signs in next
            // must not be shown this person's cached answers.
            onClick={() => {
              // Before the request (rootState.ts has why).
              beginSignOut()
              void authClient
                .signOut()
                .then(forgetCachedPages)
                .then(() => window.location.replace('/login'))
            }}
            className="min-h-11 text-body text-blue"
          >
            Sign out
          </button>
          {/* A set-up belongs to the session that started it
              (convex/lib/twoFactorSetup.ts), and signing out ends that
              session: back in, even on this phone, it starts again with a
              new key, and the entry already added is dead. Said here, where
              it can still be chosen, rather than only afterwards. */}
          {(setup !== null || status.setup === 'unfinished') && (
            <p className="text-center text-caption text-muted">
              Signing out now means starting again with a new key when you sign
              back in.
            </p>
          )}
        </div>
      )}
    </main>
  )
}

function PasswordStep({
  status,
  hadKey,
  notice,
  onReady,
  onKeyGone,
  onAlreadyOn,
}: {
  /** The live status; `setup` is missing from a backend older than this. */
  status: SetupStatus | undefined
  hadKey: boolean
  /** Why this step is showing again, if a "new key" sent it back here. */
  notice: string | null
  onReady: (setup: Setup, password: string) => void
  /** The key this page was about to carry on with has gone. */
  onKeyGone: () => void
  onAlreadyOn: () => void
}) {
  const hydrated = useHydrated()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(notice)
  const [pending, setPending] = useState(false)
  // One request at a time. A double tap on Start used to call enable twice —
  // two new keys, the second replacing the first while the person was
  // already adding it. `disabled` alone is not enough: the second tap can
  // land before React has re-rendered the button.
  const busy = useRef(false)
  // From the LIVE status, so it follows whatever happens elsewhere: set-up
  // finished in another tab, a key cleared, this page losing its sign-in.
  const action = passwordStepAction(status, hadKey)

  if (action === 'leave') {
    // Finished in another tab or on another device since this page loaded.
    return (
      <div className="flex flex-col gap-3">
        <p className="text-body text-muted">
          Two-step sign-in is already on for this account.
        </p>
        <button
          type="button"
          disabled={!hydrated}
          onClick={onAlreadyOn}
          className={PRIMARY_BUTTON}
        >
          Continue
        </button>
      </div>
    )
  }

  if (action === 'signed-out') {
    // "Nothing started" from a query that has lost its sign-in is not to be
    // believed, and Start on the strength of it would replace a key the
    // person may already have added. A reload finds the session again, or
    // goes to sign-in.
    return (
      <div className="flex flex-col gap-3">
        <FormAlert>{SIGNED_OUT_HERE}</FormAlert>
        <button
          type="button"
          disabled={!hydrated}
          onClick={() => window.location.reload()}
          className={PRIMARY_BUTTON}
        >
          Reload
        </button>
      </div>
    )
  }

  // What the form does — narrowed here, where the early returns above
  // apply, for the handlers below.
  const step = action
  const copy = passwordStepCopy(step, status?.setup)

  /** The earlier key, again. Never enable: that would replace it. */
  async function resume(): Promise<string | null> {
    const result = await authClient.twoFactor
      .getTotpUri({ password })
      .catch(unreachable)
    if (result.error) {
      const code = codeOf(result.error)
      if (code === 'MFA_ALREADY_ENABLED') {
        onAlreadyOn()
        return null
      }
      // Cleared (the owner reset it), or no longer this session's: the live
      // status catches up, and the button becomes "Start again with a new
      // key", warned.
      if (code === 'TOTP_NOT_ENABLED' || code === 'MFA_SETUP_KEY_UNAVAILABLE') {
        onKeyGone()
      }
      return code === 'TOTP_NOT_ENABLED'
        ? SETUP_CLEARED
        : passwordStepError(result.error)
    }
    onReady(
      { totpURI: result.data.totpURI, flow: resumeFlow(hadKey) },
      password,
    )
    return null
  }

  /** A new key — over an old one only when `restart` says so. */
  async function start(kind: 'start' | 'restart'): Promise<string | null> {
    const request = newKeyRequest(kind)
    const result = await authClient.twoFactor
      .enable({ password, fetchOptions: { headers: request.headers } })
      .catch(unreachable)
    if (result.error) {
      if (codeOf(result.error) === 'MFA_ALREADY_ENABLED') {
        onAlreadyOn()
        return null
      }
      // MFA_SETUP_STARTED lands here: a key this page did not know about —
      // maybe its own, from a Start whose answer was lost. Nothing was
      // replaced, and the live status says what to do once it arrives.
      return passwordStepError(result.error)
    }
    onReady({ totpURI: result.data.totpURI, flow: request.flow }, password)
    return null
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (step === 'wait' || busy.current) return
    busy.current = true
    setError(null)
    setPending(true)
    const failed = step === 'resume' ? await resume() : await start(step)
    if (failed !== null) {
      busy.current = false
      setPending(false)
      setError(failed)
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="section-label">Your password</span>
        <input
          type="password"
          value={password}
          required
          autoComplete="current-password"
          enterKeyHint="go"
          onChange={(e) => setPassword(e.target.value)}
          className={FIELD}
        />
        <span className="text-caption text-muted">{copy.hint}</span>
      </label>

      {error && <FormAlert>{error}</FormAlert>}

      <button
        type="submit"
        disabled={pending || !hydrated || step === 'wait'}
        className={`${PRIMARY_BUTTON} mt-2`}
      >
        {pending ? 'Just a moment…' : copy.submit}
      </button>
    </form>
  )
}

function ScanStep({
  setup,
  userId,
  signedOut,
  onVerified,
  onAlreadyOn,
  onStartOver,
}: {
  setup: Setup
  /** Whose recovery-code reminder to switch on (lib/twoStepReminders). */
  userId: string | null
  /** The live status says this page's sign-in has gone. */
  signedOut: boolean
  onVerified: () => void
  /** Turned on elsewhere (another tab) since this key was shown. */
  onAlreadyOn: () => void
  /** Only on a set-up that carried on with its earlier key. Replaces this
   * step whatever happens: a new key, or the password step again. */
  onStartOver?: () => Promise<void>
}) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [copied, setCopied] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // Auto-submit at six digits and a tap on the button can land together; and
  // a code must not be checked against a key that is being replaced.
  const busy = useRef(false)
  // A code from this step went out and no answer came back. It may be the
  // one that turned two-step sign-in on (`remindAfterRefusedCode`).
  const unanswered = useRef(false)
  // The last code came back to a sign-in that no longer exists.
  const [lostHere, setLostHere] = useState(false)
  // Its sign-in has gone, by the code's answer or the live status: every
  // code from here gets the same answer, and two-step sign-in may be on.
  // Not while a code is out — a right code deletes the old session, and the
  // live status can say so before the code's own answer arrives.
  const lost = !pending && (lostHere || signedOut)
  const key = setupKeyOf(setup.totpURI)
  const notice = scanStepNotice(setup.flow)
  // Only ever rendered after a tap (a key needs the password step first), so
  // never on the server — but the words must not throw if it ever were.
  const howToDelete = deleteEntryHow(
    typeof window === 'undefined' ? '' : window.location.hostname,
  )

  async function verify(value: string) {
    if (busy.current) return
    busy.current = true
    setError(null)
    setPending(true)
    // Before the code goes out, not after it is accepted: an acceptance lost
    // on the way back leaves two-step sign-in on and no codes ever shown.
    const before = userId !== null && recoveryCodesUnsaved(userId)
    if (userId) markRecoveryCodesUnsaved(userId, true)
    const result = await authClient.twoFactor
      .verifyTotp({ code: normaliseTotpCode(value) })
      .catch(unreachable)
    if (result.error) {
      if (userId) {
        markRecoveryCodesUnsaved(
          userId,
          remindAfterRefusedCode(result.error, before, unanswered.current),
        )
      }
      if (!answered(result.error)) unanswered.current = true
      // Already on: another tab turned it on first and made the recovery
      // codes that count — or this page's own earlier code did, and its
      // answer was lost (the reminder above stays on for that). Nothing to
      // do here; this key's codes change nothing now.
      if (codeOf(result.error) === 'MFA_ALREADY_ENABLED') {
        onAlreadyOn()
        return
      }
      busy.current = false
      setPending(false)
      setCode('')
      setLostHere(isSignInLost(result.error))
      setError(setupCodeError(result.error))
      return
    }
    onVerified()
  }

  async function startOver() {
    if (busy.current || !onStartOver) return
    busy.current = true
    setPending(true)
    await onStartOver()
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3 rounded-2xl border border-hairline bg-surface p-4 shadow-elevation">
        <h2 className="section-label">1 · Add PestM8 to your authenticator</h2>
        {notice.tone === 'warn' && (
          <Warning>
            {notice.text}
            {notice.howToDelete && (
              <span className="mt-1 block">{howToDelete}</span>
            )}
          </Warning>
        )}
        {notice.tone === 'info' && (
          <p className="rounded-xl bg-surface-2 px-3 py-2 text-caption text-ink">
            {notice.text}
            {notice.howToDelete && (
              <span className="mt-1 block">{howToDelete}</span>
            )}
          </p>
        )}
        <p className="text-body text-muted">
          Use Google Authenticator, Microsoft Authenticator, or the iPhone's own
          Passwords app. On this phone, tap the button — it opens the app with
          PestM8 filled in.
        </p>
        <a
          href={setup.totpURI}
          className={`${SECONDARY_BUTTON} flex items-center justify-center`}
        >
          Add to authenticator app
        </a>

        {/* A phone cannot scan its own screen; this is for setting up at a
            desk with the phone in hand. */}
        <div className="hidden flex-col items-center gap-2 pt-2 sm:flex">
          <QrCode
            value={setup.totpURI}
            label="QR code to add PestM8 to an authenticator app"
          />
          <p className="text-caption text-muted">
            Or scan this with your authenticator app.
          </p>
        </div>

        <div className="flex flex-col gap-1.5 pt-1">
          <span className="section-label">Or type this setup key</span>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 rounded-xl bg-surface-3 px-3.5 py-3 font-mono text-[16px] break-all text-ink select-all">
              {key}
            </code>
            <button
              type="button"
              aria-label="Copy setup key"
              onClick={() => {
                void navigator.clipboard
                  .writeText(key.replace(/\s/g, ''))
                  .then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  })
              }}
              className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink transition active:scale-[.975]"
            >
              {copied ? (
                <Check size={18} strokeWidth={2} />
              ) : (
                <Copy size={18} strokeWidth={1.7} />
              )}
            </button>
          </div>
        </div>

        {notice.tone === 'quiet' && (
          <p className="text-caption text-muted">{notice.text}</p>
        )}
      </section>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void verify(code)
        }}
        className="flex flex-col gap-3 rounded-2xl border border-hairline bg-surface p-4 shadow-elevation"
      >
        <label className="flex flex-col gap-1.5">
          <span className="section-label">
            2 · Enter the 6-digit code it shows
          </span>
          <input
            value={code}
            required
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="one-time-code"
            enterKeyHint="go"
            maxLength={7}
            onChange={(e) => {
              const next = normaliseTotpCode(e.target.value)
              setCode(next)
              if (next.length === 6) void verify(next)
            }}
            className="h-12 rounded-xl bg-surface-3 px-3.5 text-center font-mono text-sheet-title font-medium tracking-[0.3em] text-ink outline-none focus:ring-2 focus:ring-blue"
          />
        </label>

        {lost ? (
          // An iPhone home-screen app has no reload button of its own.
          <div className="flex flex-col gap-3">
            <FormAlert>{SETUP_SIGN_IN_LOST}</FormAlert>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className={SECONDARY_BUTTON}
            >
              Reload
            </button>
          </div>
        ) : (
          error && <FormAlert>{error}</FormAlert>
        )}

        <button
          type="submit"
          disabled={pending || normaliseTotpCode(code).length !== 6}
          className={PRIMARY_BUTTON}
        >
          {pending ? 'Checking…' : 'Turn on two-step sign-in'}
        </button>
      </form>

      {onStartOver && !confirming && (
        <button
          type="button"
          disabled={pending}
          onClick={() => setConfirming(true)}
          className="min-h-11 text-body text-blue disabled:opacity-50"
        >
          Start over with a new key
        </button>
      )}

      {onStartOver && confirming && (
        <section className="flex flex-col gap-3 rounded-2xl border border-hairline bg-surface p-4 shadow-elevation">
          <h2 className="section-label">Start over with a new key</h2>
          <Warning>
            {START_OVER_WARNING}
            <span className="mt-1 block">{howToDelete}</span>
          </Warning>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirming(false)}
              className={`${SECONDARY_BUTTON} flex-1`}
            >
              Keep this key
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => void startOver()}
              className={`${PRIMARY_BUTTON} flex-1`}
            >
              {pending ? 'Just a moment…' : 'Make a new key'}
            </button>
          </div>
        </section>
      )}
    </div>
  )
}

/** The same amber box for something to read first, but not announced: it is
 * part of the step, not news. */
function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-amber-ink">
      {children}
    </p>
  )
}
