import { useEffect, useMemo, useRef } from 'react'
import { ConvexHttpClient } from 'convex/browser'
import { api } from '../../../convex/_generated/api'
import { APP_VERSION } from '#/lib/appVersion'
import {
  deviceId,
  markConnectionLogSent,
  unsentConnectionLog,
} from '#/lib/connectionLog'
import { currentToken } from '#/lib/convexClient'
import { isStandalone } from '#/lib/installPrompt'
import { isOffline } from '#/lib/online'
import { useReachNotice } from '#/lib/reach'
import type { ConvexReactClient } from 'convex/react'

/** The first report of a page load: the notes from before a Reload. */
const FIRST_MS = 15_000
/** How often new notes are sent while the app is on screen. */
const EVERY_MS = 2 * 60_000
/** How soon after the "Could not reach PestM8" notice goes. */
const AFTER_NOTICE_MS = 3_000
/** Notes per report (convex/lib/diagnostics.ts takes no more). */
const PER_REPORT = 100
/** How long one report may take before it is given up. */
const REPORT_LIMIT_MS = 20_000

/**
 * Sends the phone's connection notes (lib/connectionLog.ts) to the server
 * (convex/diagnostics.ts): a while after the page loads, every two minutes
 * while there are new ones and the app is on screen, and a moment after the
 * "Could not reach PestM8" notice goes — when there is most to tell, and a
 * line to tell it on.
 *
 * Over plain HTTP with the page's freshest token, never the socket: the notes
 * matter most when the socket is the thing that is stuck, and a report going
 * over it would show in the notice as a change of the person's waiting to
 * save. Signed out, there is no token and nothing is sent. Nothing on screen,
 * and nothing on failure: a report that does not go leaves its notes for the
 * next.
 */
export function ConnectionDiagnostics({
  convexClient,
}: {
  convexClient: ConvexReactClient
}) {
  const send = useMemo(() => sender(convexClient), [convexClient])
  const notice = useReachNotice()
  const noticed = useRef(false)

  useEffect(() => {
    const first = setTimeout(send, FIRST_MS)
    const every = setInterval(send, EVERY_MS)
    return () => {
      clearTimeout(first)
      clearInterval(every)
    }
  }, [send])

  useEffect(() => {
    if (notice) {
      noticed.current = true
      return
    }
    if (!noticed.current) return
    noticed.current = false
    const soon = setTimeout(send, AFTER_NOTICE_MS)
    return () => clearTimeout(soon)
  }, [notice, send])

  return null
}

function sender(convexClient: ConvexReactClient): () => Promise<void> {
  let sending = false
  return async () => {
    if (sending || document.visibilityState !== 'visible' || isOffline()) {
      return
    }
    const token = currentToken(convexClient)
    const batch = token ? unsentConnectionLog(PER_REPORT) : null
    if (!token || !batch) return
    sending = true
    try {
      // A request into a dead line is given up, so the next report can go.
      const http = new ConvexHttpClient(convexClient.url, {
        fetch: (input, init) => {
          const giveUp = new AbortController()
          setTimeout(() => giveUp.abort(), REPORT_LIMIT_MS)
          return fetch(input, { ...init, signal: giveUp.signal })
        },
      })
      http.setAuth(token)
      await http.mutation(api.diagnostics.report, {
        device: deviceId(),
        app: APP_VERSION,
        standalone: isStandalone(),
        agent: navigator.userAgent,
        entries: batch.entries,
      })
      markConnectionLogSent(batch.through)
    } catch {
      // Kept for the next report: an older backend without diagnostics, a
      // token that ran out, no line, or too soon after the last.
    } finally {
      sending = false
    }
  }
}
