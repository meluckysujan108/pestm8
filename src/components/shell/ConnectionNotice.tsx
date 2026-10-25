import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { RefreshCw, RotateCcw, WifiOff, X } from 'lucide-react'
import { logConnection } from '#/lib/connectionLog'
import { reconnectNow } from '#/lib/convexClient'
import { useOnline } from '#/lib/online'
import {
  REACH_START,
  oldestPending,
  publishReachNotice,
  sampleReach,
} from '#/lib/reach'
import type { ReachNoticeModel, ReachWhy } from '#/lib/reach'
import type { ConvexReactClient } from 'convex/react'

/** How often the app checks. */
const SAMPLE_MS = 1_000
/** After this long with signal, or this long after a Try again that didn't
 * help, the button offers a reload instead. */
const RELOAD_AFTER_MS = 30_000
const RELOAD_AFTER_TRY_MS = 8_000

/**
 * Says when the app can't reach PestM8, instead of leaving every placeholder
 * and "Saving…" to wait in silence (lib/reach.ts has the rule and why).
 *
 * In the update banner's place (ServiceWorker.tsx has why it sits under the
 * header), and in amber: a warning, not a failure. The banner gives way while
 * this is up. Rendered after the page, so it paints over the page's own
 * header where the two meet. An open sheet covers it, and most saves are made
 * in one, so a sheet draws its own copy (primitives/Sheet.tsx). It goes by
 * itself the moment PestM8 answers; Dismiss hides it until then.
 *
 * Try again opens a new line now (`reconnectNow` in lib/convexClient.ts):
 * the socket it had is given up, even one that still says it is open, and
 * everything else that waits on the network goes at once — the Convex
 * client's reconnect skips its backoff, and the sign-in token's retry
 * abandons a request that is hanging and sends another. Until 25 Oct 2026 it
 * did only the second half, which a socket that had died without saying so
 * never heard. Once the notice has been up a while with signal, or a Try
 * again didn't help, it offers Reload. A reload never happens by itself: the
 * person may be halfway through a report. With a change waiting to save,
 * Reload asks for a second tap, since the change goes with the page.
 *
 * Each time it appears, why (`ReachWhy`), how long until it went, and every
 * Try again and Reload go into the phone's connection notes
 * (lib/connectionLog.ts).
 *
 * Screen readers hear it through a live region that is always there, with one
 * short line when it appears and when Reload is offered. The notice itself
 * is not the region, so its buttons are not read out each time they change.
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
  const [reloadArmed, setReloadArmed] = useState(false)
  const [now, setNow] = useState(0)
  const firstSeen = useRef(new Map<string, number>())

  useEffect(() => {
    let state = REACH_START
    // When saves were first seen waiting, for when an action is in flight
    // too (see below).
    let savesWaitingSince: number | null = null
    // The wait the notice is up for, and since when, for the notes.
    let noted: { why: ReachWhy; at: number } | null = null
    const sample = () => {
      const at = Date.now()
      const connection = convexClient.connectionState()
      savesWaitingSince =
        connection.inflightMutations > 0 ? (savesWaitingSince ?? at) : null
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
        // A save's own time when it is the only kind in flight. An action
        // can rightly take longer (a report's PDF, an email, the weather)
        // and its time is in the same figure, so while one is out the saves
        // are timed from when they were first seen waiting.
        oldestRequestAt:
          connection.inflightActions === 0
            ? (connection.timeOfOldestInflightRequest?.getTime() ?? null)
            : savesWaitingSince,
        oldestPendingQueryAt: oldestPending(firstSeen.current, pending, at),
      })
      state = next.state
      if (next.why !== null && noted === null) {
        noted = { why: next.why, at }
        logConnection('notice', { why: next.why })
      } else if (next.why === null && noted !== null) {
        // Off screen, everything starts again: that is not PestM8 answering.
        logConnection('notice-off', {
          why: noted.why,
          ms: at - noted.at,
          hidden: document.visibilityState !== 'visible',
        })
        noted = null
      }
      setStuck(next.stuck)
      setWaitingToSave(connection.inflightMutations > 0)
      setNow(at)
    }
    // Hidden, everything starts again; shown, it looks at once rather than
    // up to a second later.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') sample()
      else state = REACH_START
    }
    const timer = setInterval(sample, SAMPLE_MS)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [convexClient, queryClient])

  // Try again and Reload only make sense with signal, so their clock only
  // runs with it: back from a spell with none, it is Try again first.
  useEffect(() => {
    if (!stuck) setDismissed(false)
    if (!stuck || !online) {
      setShownAt(null)
      setTriedAt(null)
      setReloadArmed(false)
    } else {
      setShownAt((at) => at ?? Date.now())
    }
  }, [stuck, online])

  const showing = stuck && !dismissed
  const trying = triedAt !== null && now - triedAt < RELOAD_AFTER_TRY_MS
  const offerReload =
    !trying &&
    ((shownAt !== null && now - shownAt >= RELOAD_AFTER_MS) || triedAt !== null)
  const action: ReachNoticeModel['action'] = offerReload
    ? reloadArmed
      ? 'reload-confirm'
      : 'reload'
    : trying
      ? 'trying'
      : 'try'

  const onTry = useCallback(() => {
    setTriedAt(Date.now())
    reconnectNow(convexClient)
  }, [convexClient])
  const onReload = useCallback(() => {
    if (waitingToSave && !reloadArmed) setReloadArmed(true)
    else {
      logConnection('reload', { waitingToSave })
      window.location.reload()
    }
  }, [waitingToSave, reloadArmed])
  const onDismiss = useCallback(() => setDismissed(true), [])

  const model = useMemo<ReachNoticeModel | null>(
    () =>
      showing
        ? { online, waitingToSave, action, onTry, onReload, onDismiss }
        : null,
    [showing, online, waitingToSave, action, onTry, onReload, onDismiss],
  )
  useEffect(() => {
    publishReachNotice(model)
  }, [model])
  useEffect(() => () => publishReachNotice(null), [])

  return (
    <>
      <p role="status" className="sr-only">
        {model === null
          ? ''
          : !model.online
            ? 'No signal.'
            : model.action === 'reload' || model.action === 'reload-confirm'
              ? 'Still could not reach PestM8. Reload is offered.'
              : 'Could not reach PestM8.'}
      </p>
      {model && <ReachNotice {...model} />}
    </>
  )
}

/**
 * What ConnectionNotice shows: under the header, or as a line at the top of
 * an open sheet (`placement="sheet"`), where the sheet's own ✕ stands in for
 * Dismiss.
 */
export function ReachNotice({
  online,
  waitingToSave,
  action,
  onTry,
  onReload,
  onDismiss,
  placement = 'banner',
}: ReachNoticeModel & { placement?: 'banner' | 'sheet' }) {
  const banner = placement === 'banner'
  return (
    <div
      data-reach-notice={placement}
      className={`flex items-start gap-2.5 border border-amber-line bg-amber-bg text-amber-ink ${
        banner
          ? 'fixed inset-x-4 top-[calc(84px+env(safe-area-inset-top))] z-30 mx-auto max-w-[420px] rounded-2xl py-1.5 pl-3.5 pr-1.5 shadow-elevation lg:inset-x-auto lg:right-4'
          : 'mb-1 ml-4 mr-14 mt-1.5 shrink-0 rounded-xl px-3 py-0.5'
      }`}
    >
      <WifiOff
        aria-hidden
        size={18}
        strokeWidth={1.7}
        className="mt-3 shrink-0"
      />
      <div className="min-w-0 flex-1 pb-1 pt-2.5 text-caption">
        <p className="font-semibold">
          {online ? 'Could not reach PestM8' : 'No signal'}
        </p>
        <p>
          {online
            ? 'What’s on screen may be out of date. Check your signal or VPN — it keeps trying.'
            : 'What’s on screen may be out of date. It carries on when you have signal.'}
        </p>
        {waitingToSave && (
          <p>
            {action === 'reload-confirm'
              ? 'A change you made is waiting to save, and reloading loses it.'
              : 'A change you made is waiting to save.'}
          </p>
        )}
        {online &&
          (action === 'reload' || action === 'reload-confirm' ? (
            <button
              type="button"
              onClick={onReload}
              className="-ml-1 mt-1 flex h-11 items-center gap-1.5 rounded-xl px-1 text-body font-semibold transition active:scale-[.975]"
            >
              <RefreshCw aria-hidden className="size-4" />
              {action === 'reload-confirm' ? 'Tap again to reload' : 'Reload'}
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
      {banner && (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="flex size-11 shrink-0 items-center justify-center rounded-xl"
        >
          <X aria-hidden className="size-5" />
        </button>
      )}
    </div>
  )
}
