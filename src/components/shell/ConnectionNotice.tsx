import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { RefreshCw, RotateCcw, WifiOff, X } from 'lucide-react'
import { retryNow, useOnline } from '#/lib/online'
import {
  REACH_START,
  oldestPending,
  sampleReach,
  setReachNoticeShowing,
} from '#/lib/reach'
import type { ConvexReactClient } from 'convex/react'

/** How often the app checks. */
const SAMPLE_MS = 1_000
/** After this long on screen, or this long after a Try again that didn't
 * help, the button offers a reload instead. */
const RELOAD_AFTER_MS = 30_000
const RELOAD_AFTER_TRY_MS = 8_000

/**
 * Says when the app can't reach PestM8, instead of leaving every placeholder
 * and "Saving…" to wait in silence (lib/reach.ts has the rule and why).
 *
 * In the update banner's place (ServiceWorker.tsx has why it sits under the
 * header), and in amber: a warning, not a failure. The banner gives way while
 * this is up. It goes by itself the moment PestM8 answers; Dismiss hides it
 * until then.
 *
 * Try again asks everything that waits on the network to go now
 * (`retryNow`): it skips the Convex client's reconnect backoff and the
 * sign-in token's retry pause, and abandons a token request that is hanging.
 * It can't open a socket that is stuck some other way, which nothing outside
 * the Convex client can, so when the notice has been up a while, or a Try
 * again didn't help, it offers Reload. A reload never happens by itself: the
 * person may be halfway through a report.
 */
export function ConnectionNotice({
  convexClient,
}: {
  convexClient: ConvexReactClient
}) {
  const queryClient = useQueryClient()
  const online = useOnline()
  const [stuck, setStuck] = useState(false)
  const [waitingToSave, setWaitingToSave] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [shownAt, setShownAt] = useState<number | null>(null)
  const [triedAt, setTriedAt] = useState<number | null>(null)
  const [now, setNow] = useState(0)
  const firstSeen = useRef(new Map<string, number>())

  useEffect(() => {
    let state = REACH_START
    const sample = () => {
      const at = Date.now()
      const connection = convexClient.connectionState()
      const pending = queryClient
        .getQueryCache()
        .getAll()
        .filter(
          (query) =>
            query.queryKey[0] === 'convexQuery' &&
            query.state.status === 'pending' &&
            query.state.fetchStatus !== 'idle',
        )
        .map((query) => query.queryHash)
      const next = sampleReach(state, {
        now: at,
        visible: document.visibilityState === 'visible',
        socketConnected: connection.isWebSocketConnected,
        // A save only: an action can rightly take longer (a report's PDF, an
        // email), and its time is in the same figure.
        oldestRequestAt:
          connection.inflightActions === 0
            ? (connection.timeOfOldestInflightRequest?.getTime() ?? null)
            : null,
        oldestPendingQueryAt: oldestPending(firstSeen.current, pending, at),
      })
      state = next.state
      setStuck(next.stuck)
      setWaitingToSave(connection.inflightMutations > 0)
      setNow(at)
    }
    const timer = setInterval(sample, SAMPLE_MS)
    return () => clearInterval(timer)
  }, [convexClient, queryClient])

  useEffect(() => {
    if (!stuck) {
      setDismissed(false)
      setShownAt(null)
      setTriedAt(null)
    } else {
      setShownAt((at) => at ?? Date.now())
    }
  }, [stuck])

  const showing = stuck && !dismissed
  useEffect(() => {
    setReachNoticeShowing(showing)
    return () => setReachNoticeShowing(false)
  }, [showing])

  if (!showing) return null

  const trying = triedAt !== null && now - triedAt < RELOAD_AFTER_TRY_MS
  const offerReload =
    !trying &&
    ((shownAt !== null && now - shownAt >= RELOAD_AFTER_MS) || triedAt !== null)

  return (
    <ReachNotice
      online={online}
      waitingToSave={waitingToSave}
      action={offerReload ? 'reload' : trying ? 'trying' : 'try'}
      onTry={() => {
        setTriedAt(Date.now())
        retryNow()
      }}
      onReload={() => window.location.reload()}
      onDismiss={() => setDismissed(true)}
    />
  )
}

/** What ConnectionNotice shows, given what it knows. */
export function ReachNotice({
  online,
  waitingToSave,
  action,
  onTry,
  onReload,
  onDismiss,
}: {
  online: boolean
  waitingToSave: boolean
  /** Try again, its "Trying…", or Reload once trying hasn't helped. */
  action: 'try' | 'trying' | 'reload'
  onTry: () => void
  onReload: () => void
  onDismiss: () => void
}) {
  return (
    <div
      role="status"
      className="fixed inset-x-4 top-[calc(84px+env(safe-area-inset-top))] z-30 mx-auto flex max-w-[420px] items-start gap-2.5 rounded-2xl border border-amber-line bg-amber-bg py-1.5 pl-3.5 pr-1.5 text-amber-ink shadow-elevation lg:inset-x-auto lg:right-4"
    >
      <WifiOff
        aria-hidden
        size={18}
        strokeWidth={1.7}
        className="mt-3 shrink-0"
      />
      <div className="min-w-0 flex-1 pt-2.5 pb-1 text-caption">
        {online ? (
          <>
            <p className="font-semibold">Could not reach PestM8</p>
            <p>
              What’s on screen may be out of date. Check your signal or VPN — it
              keeps trying.
            </p>
          </>
        ) : (
          <p className="font-semibold">
            No signal — showing what’s kept on this phone.
          </p>
        )}
        {waitingToSave && <p>A change you made is waiting to save.</p>}
        {online &&
          (action === 'reload' ? (
            <button
              type="button"
              onClick={onReload}
              className="-ml-1 mt-1 flex h-11 items-center gap-1.5 rounded-xl px-1 text-body font-semibold transition active:scale-[.975]"
            >
              <RefreshCw aria-hidden className="size-4" />
              Reload
            </button>
          ) : (
            <button
              type="button"
              disabled={action === 'trying'}
              onClick={onTry}
              className="-ml-1 mt-1 flex h-11 items-center gap-1.5 rounded-xl px-1 text-body font-semibold transition active:scale-[.975] disabled:opacity-60"
            >
              <RotateCcw aria-hidden className="size-4" />
              {action === 'trying' ? 'Trying…' : 'Try again'}
            </button>
          ))}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="flex size-11 shrink-0 items-center justify-center rounded-xl"
      >
        <X aria-hidden className="size-5" />
      </button>
    </div>
  )
}
