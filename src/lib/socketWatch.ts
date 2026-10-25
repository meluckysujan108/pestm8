/**
 * Notices a dead connection to PestM8 in seconds, rather than the minute the
 * Convex client gives it, and gives it up the way the browser would have if
 * it had noticed.
 *
 * A phone's Home Screen app sleeps while it is in the background — on a call,
 * say — and iOS often cuts its connection without telling the page. When the
 * app comes back, the socket still says it is open. The Convex client counts
 * a socket as dead only after 60 s without a word from the server
 * (`serverInactivityThreshold`, the same in 1.45.0 and 1.48.0), and it has no
 * check of its own for a page coming back on screen. So for up to a minute
 * after a call, everything asked for — New Job's client list, a booking's
 * save — went down a line that was no longer there (25 Oct 2026: "if a client
 * calls and I go to book them in it hangs").
 *
 * So the browser's socket is wrapped, through Convex's own
 * `webSocketConstructor` option, and the wrapper keeps the two things the
 * Convex client keeps to itself: when the server last said anything, and
 * whether something it always answers at once is still waiting. The server
 * says something at least every 15 s — a Ping, when there is nothing else —
 * so no live line is quiet for 20 s (`QUIET_LINE_MS`), and a socket is dead
 * when (`judgeSocket`):
 *
 * - it is still opening after 10 s on screen (`opening`);
 * - it has been asked something the server answers at once — a query to
 *   watch, a save, a token — and nothing at all has come back in 20 s on
 *   screen (`unanswered`). Not 10: a message is heard only once the whole of
 *   it has arrived, and the first after a reconnect carries every live query,
 *   the whole client list among them, which on one bar can take a while;
 * - the app has just come back on screen and, a moment later, the server has
 *   said nothing for 20 s (`silent`). Whatever it sent while the phone slept
 *   would have arrived the moment it woke.
 *
 * Time off screen never counts towards the first two: a reply can sit
 * unread while the page sleeps. Each socket given up in a row stretches the
 * limits (×2, then ×3: a minute), so a line that opens and then carries
 * nothing (some VPNs, a captive Wi-Fi) is not torn down every few seconds;
 * the first answer on a new socket puts them back.
 *
 * A dead socket is given up as the browser gives one up: its handlers are
 * taken off, it is closed, and the Convex client is handed the close event
 * the browser would have sent. The client then reconnects as after any
 * dropped line: it asks for every query again and resends every save, which
 * the server knows not to apply twice. HandoverConvexClient decides when it
 * is safe to (src/lib/convexClient.ts).
 */

import { logConnection } from '#/lib/connectionLog'

/** Longer than any live line is quiet: the server pings every 15 s. */
export const QUIET_LINE_MS = 20_000
/** After coming back on screen, how long a sleeping socket's mail has to arrive. */
export const RESUME_GRACE_MS = 2_500
/** How long after coming back silence alone is read as a dead line. */
export const RESUME_WINDOW_MS = 30_000
/** Silence that means dead, just after coming back. */
export const RESUME_SILENCE_MS = QUIET_LINE_MS
/** How long something the server answers at once may wait, on screen. */
export const UNANSWERED_MS = QUIET_LINE_MS
/** How long a socket may take to open, on screen. */
export const OPENING_MS = 10_000
/** The most the limits stretch after sockets given up in a row (×3: a
 * minute to answer). */
export const MAX_PATIENCE = 3

/** What a watched socket knows about itself. Times are epoch ms. */
export type SocketReading = {
  state: 'opening' | 'open' | 'closed'
  createdAt: number
  /** When the server last said anything, or the socket opened; null before. */
  heardAt: number | null
  /** When the oldest thing the server answers at once was sent, with nothing
   * heard since; null when nothing is waiting. */
  askedAt: number | null
}

/** Where the page is, for judging a socket. */
export type PageReading = {
  now: number
  /** When this spell on screen began; null while off screen. */
  shownAt: number | null
  /** Whether this spell followed time away (or a frozen page) rather than
   * the page loading: the one time silence alone means a dead line. */
  resumed: boolean
  /** Multiplies every limit: 1, then doubling with each socket given up in a
   * row, up to MAX_PATIENCE. */
  patience: number
}

export type Verdict = 'alive' | 'opening' | 'unanswered' | 'silent'

/** Whether a socket is dead, and why (see the top of this file). */
export function judgeSocket(socket: SocketReading, page: PageReading): Verdict {
  const { now, shownAt, patience } = page
  if (shownAt === null) return 'alive'
  const onScreen = (since: number) => now - Math.max(since, shownAt)
  if (socket.state === 'opening') {
    return onScreen(socket.createdAt) >= OPENING_MS * patience
      ? 'opening'
      : 'alive'
  }
  if (socket.state !== 'open') return 'alive'
  if (
    socket.askedAt !== null &&
    onScreen(socket.askedAt) >= UNANSWERED_MS * patience
  ) {
    return 'unanswered'
  }
  const sinceShown = now - shownAt
  if (
    page.resumed &&
    sinceShown >= RESUME_GRACE_MS &&
    sinceShown < RESUME_WINDOW_MS &&
    now - (socket.heardAt ?? socket.createdAt) >= RESUME_SILENCE_MS * patience
  ) {
    return 'silent'
  }
  return 'alive'
}

/**
 * Whether a message the client sends is one the server answers at once: a
 * change to the queries it watches, a save, a token. Not an action, which
 * answers when it is done however long that takes, nor Connect or an Event,
 * which it never answers.
 */
export function expectsAnswer(data: unknown): boolean {
  if (typeof data !== 'string') return false
  const type = /^\{"type":"([A-Za-z]+)"/.exec(data)?.[1] ?? typeOfMessage(data)
  return (
    type === 'ModifyQuerySet' || type === 'Mutation' || type === 'Authenticate'
  )
}

function typeOfMessage(data: string): string | undefined {
  try {
    const message: unknown = JSON.parse(data)
    return typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      typeof message.type === 'string'
      ? message.type
      : undefined
  } catch {
    return undefined
  }
}

/** A socket the app watches, as WatchedSockets makes them. */
export type WatchedSocket = {
  reading: () => SocketReading
  /** Gives the socket up now, as the browser would once it noticed the line
   * had gone: Convex hears a close and reconnects. */
  giveUp: (why: string) => void
}

/**
 * Makes the sockets the Convex client opens watched ones, and keeps the
 * latest: the one the client is using, since it opens one at a time.
 */
export class WatchedSockets {
  current: WatchedSocket | null = null
  /**
   * When the server last sent anything down any of them, or null before it
   * ever has: the last time this page load heard from PestM8 itself. Only
   * the server's own messages count, not a socket opening, nor a wait for a
   * sign-in token ending (which `readLine` in convexClient.ts counts as
   * hearing, for judging a line): the kept copy says how old what is on
   * screen is from this (lib/offline/keeper.ts).
   */
  lastMessageAt: number | null = null

  /** A WebSocket class for Convex's `webSocketConstructor` option. */
  wrap(Base: typeof WebSocket): typeof WebSocket {
    const adopt = (socket: WatchedSocket) => {
      this.current = socket
    }
    const heard = () => {
      this.lastMessageAt = Date.now()
    }
    return class Watched extends Base {
      private readonly createdAt = Date.now()
      private openedAt: number | null = null
      private heardAt: number | null = null
      private askedAt: number | null = null
      private givenUp = false

      constructor(url: string | URL, protocols?: string | Array<string>) {
        super(url, protocols)
        adopt(this)
        this.addEventListener('open', () => {
          this.openedAt = this.heardAt = Date.now()
          logConnection('ws-open', { ms: this.openedAt - this.createdAt })
        })
        this.addEventListener('message', () => {
          this.heardAt = Date.now()
          this.askedAt = null
          // A socket given up is no longer read by the Convex client.
          if (!this.givenUp) heard()
        })
        this.addEventListener('close', (event) => {
          logConnection('ws-close', {
            code: Number(event.code) || 0,
            clean: Boolean(event.wasClean),
            open: this.openedAt === null ? 0 : Date.now() - this.openedAt,
          })
        })
      }

      override send(data: Parameters<WebSocket['send']>[0]) {
        if (this.askedAt === null && expectsAnswer(data)) {
          this.askedAt = Date.now()
        }
        super.send(data)
      }

      reading(): SocketReading {
        return {
          // readyState's numbers are fixed by the WebSocket standard.
          state: this.givenUp
            ? 'closed'
            : this.readyState === 0
              ? 'opening'
              : this.readyState === 1
                ? 'open'
                : 'closed',
          createdAt: this.createdAt,
          heardAt: this.heardAt,
          askedAt: this.askedAt,
        }
      }

      giveUp(why: string) {
        if (this.givenUp) return
        this.givenUp = true
        const onclose = this.onclose
        this.onopen = null
        this.onmessage = null
        this.onerror = null
        this.onclose = null
        try {
          this.close()
        } catch {
          // Closing an unopened socket can throw in older browsers; it is
          // given up either way.
        }
        // The event the browser sends for a line that went without a
        // closing handshake. Convex reads only `code` and `reason`.
        onclose?.call(this, {
          type: 'close',
          code: 1006,
          reason: why,
          wasClean: false,
        } as CloseEvent)
      }
    }
  }
}
