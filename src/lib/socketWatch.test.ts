import { describe, expect, it, vi } from 'vitest'
import {
  MAX_PATIENCE,
  OPENING_MS,
  RESUME_GRACE_MS,
  RESUME_SILENCE_MS,
  RESUME_WINDOW_MS,
  UNANSWERED_MS,
  WatchedSockets,
  expectsAnswer,
  judgeSocket,
} from './socketWatch'
import type { PageReading, SocketReading } from './socketWatch'

const open = (reading: Partial<SocketReading> = {}): SocketReading => ({
  state: 'open',
  createdAt: 0,
  heardAt: 0,
  askedAt: null,
  ...reading,
})

const page = (reading: Partial<PageReading> = {}): PageReading => ({
  now: 0,
  shownAt: 0,
  resumed: false,
  patience: 1,
  ...reading,
})

describe('judgeSocket', () => {
  it('leaves every socket alone while the page is off screen', () => {
    expect(
      judgeSocket(open({ askedAt: 0, heardAt: 0 }), {
        ...page({ now: 600_000 }),
        shownAt: null,
      }),
    ).toBe('alive')
  })

  it(`gives up a socket still opening after ${OPENING_MS / 1000} s on screen`, () => {
    const opening = open({ state: 'opening', heardAt: null })
    expect(judgeSocket(opening, page({ now: OPENING_MS - 1 }))).toBe('alive')
    expect(judgeSocket(opening, page({ now: OPENING_MS }))).toBe('opening')
  })

  it(`gives up a socket asked something ${UNANSWERED_MS / 1000} s ago, on screen, with no word since`, () => {
    const asked = open({ askedAt: 1_000 })
    expect(judgeSocket(asked, page({ now: 1_000 + UNANSWERED_MS - 1 }))).toBe(
      'alive',
    )
    expect(judgeSocket(asked, page({ now: 1_000 + UNANSWERED_MS }))).toBe(
      'unanswered',
    )
  })

  it('counts only time on screen: an answer can sit unread while the phone sleeps', () => {
    // Asked, then five minutes away: back on screen, the answer may be
    // waiting to be read, so the clock starts again.
    const asked = open({ askedAt: 0 })
    const back = 300_000
    expect(
      judgeSocket(
        asked,
        page({ now: back + UNANSWERED_MS - 1, shownAt: back }),
      ),
    ).toBe('alive')
    expect(
      judgeSocket(asked, page({ now: back + UNANSWERED_MS, shownAt: back })),
    ).toBe('unanswered')
  })

  it(`just after coming back, gives up a socket the server has said nothing on for ${RESUME_SILENCE_MS / 1000} s`, () => {
    const quiet = open({ heardAt: 0 })
    const back = 60_000
    const resumed = (now: number) =>
      judgeSocket(quiet, page({ now, shownAt: back, resumed: true }))
    // A moment first: whatever it sent while the phone slept arrives then.
    expect(resumed(back + RESUME_GRACE_MS - 1)).toBe('alive')
    expect(resumed(back + RESUME_GRACE_MS)).toBe('silent')
  })

  it('reads silence alone as a dead line only just after coming back', () => {
    const quiet = open({ heardAt: 0 })
    // A page that loaded, rather than came back: the Convex client's own
    // minute is left to judge a quiet line.
    expect(judgeSocket(quiet, page({ now: 60_000 }))).toBe('alive')
    // Long after coming back: the same.
    expect(
      judgeSocket(
        quiet,
        page({ now: RESUME_WINDOW_MS, shownAt: 0, resumed: true }),
      ),
    ).toBe('alive')
    // Heard from lately: alive.
    expect(
      judgeSocket(
        open({ heardAt: 50_000 }),
        page({ now: 60_000 + RESUME_GRACE_MS, shownAt: 60_000, resumed: true }),
      ),
    ).toBe('alive')
  })

  it('stretches every limit by its patience', () => {
    const asked = open({ askedAt: 0 })
    expect(judgeSocket(asked, page({ now: UNANSWERED_MS, patience: 2 }))).toBe(
      'alive',
    )
    expect(
      judgeSocket(asked, page({ now: 2 * UNANSWERED_MS, patience: 2 })),
    ).toBe('unanswered')
    expect(MAX_PATIENCE * UNANSWERED_MS).toBe(60_000)
  })

  it('leaves a closed socket to the Convex client', () => {
    expect(
      judgeSocket(
        open({ state: 'closed', askedAt: 0 }),
        page({ now: 600_000 }),
      ),
    ).toBe('alive')
  })
})

describe('expectsAnswer', () => {
  it('is true of what the server answers at once', () => {
    for (const type of ['ModifyQuerySet', 'Mutation', 'Authenticate']) {
      expect(expectsAnswer(JSON.stringify({ type, requestId: 1 }))).toBe(true)
    }
  })

  it('is false of an action, which answers when it is done, and of what is never answered', () => {
    for (const type of ['Action', 'Connect', 'Event']) {
      expect(expectsAnswer(JSON.stringify({ type }))).toBe(false)
    }
  })

  it('finds the type wherever it is in the message', () => {
    expect(expectsAnswer('{"requestId":1,"type":"Mutation"}')).toBe(true)
  })

  it('is false of anything it cannot read', () => {
    expect(expectsAnswer(new ArrayBuffer(4))).toBe(false)
    expect(expectsAnswer('{')).toBe(false)
    expect(expectsAnswer('null')).toBe(false)
  })
})

/** A socket as a browser makes one: events to listeners, then the handler. */
class BrowserSocket extends EventTarget {
  readyState = 0
  sent: Array<unknown> = []
  closed = false
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: unknown) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  constructor(readonly url: string) {
    super()
  }

  send(data: unknown) {
    this.sent.push(data)
  }

  close() {
    this.closed = true
    this.readyState = 2
  }

  fire(type: 'open' | 'message', fields: object = {}) {
    if (type === 'open') this.readyState = 1
    const event = Object.assign(new Event(type), fields)
    this.dispatchEvent(event)
    if (type === 'open') this.onopen?.(event)
    else this.onmessage?.(event)
  }
}

function watchedSocket() {
  const sockets = new WatchedSockets()
  const Watched = sockets.wrap(BrowserSocket as unknown as typeof WebSocket)
  const socket = new Watched('wss://example.test') as unknown as BrowserSocket
  const watched = sockets.current!
  return { sockets, Watched, socket, watched }
}

describe('WatchedSockets', () => {
  it('keeps the socket the Convex client opened last', () => {
    const { sockets, Watched } = watchedSocket()
    const next = new Watched('wss://example.test')
    expect(sockets.current).toBe(next)
  })

  it('notes when the server last spoke, and whether it has been asked something since', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(1_000)
      const { socket, watched } = watchedSocket()
      expect(watched.reading()).toMatchObject({
        state: 'opening',
        heardAt: null,
      })

      vi.setSystemTime(2_000)
      socket.fire('open')
      expect(watched.reading()).toMatchObject({ state: 'open', heardAt: 2_000 })

      vi.setSystemTime(3_000)
      socket.send(JSON.stringify({ type: 'ModifyQuerySet' }))
      vi.setSystemTime(4_000)
      socket.send(JSON.stringify({ type: 'Mutation' }))
      // The oldest question still waiting.
      expect(watched.reading().askedAt).toBe(3_000)

      vi.setSystemTime(5_000)
      socket.fire('message', { data: '{"type":"Ping"}' })
      expect(watched.reading()).toMatchObject({ heardAt: 5_000, askedAt: null })

      socket.send(JSON.stringify({ type: 'Action' }))
      expect(watched.reading().askedAt).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives a socket up as the browser would: the client hears a close, then nothing', () => {
    const { socket, watched } = watchedSocket()
    socket.fire('open')
    const heard = vi.fn()
    const closed = vi.fn()
    socket.onmessage = heard
    socket.onclose = closed

    watched.giveUp('PestM8: silent')
    expect(closed).toHaveBeenCalledTimes(1)
    expect(closed.mock.calls[0]?.[0]).toMatchObject({
      code: 1006,
      reason: 'PestM8: silent',
      wasClean: false,
    })
    expect(socket.closed).toBe(true)
    expect(watched.reading().state).toBe('closed')

    // Whatever the old line still delivers goes nowhere, and a second give
    // up is not a second close.
    socket.fire('message', { data: '{"type":"Ping"}' })
    watched.giveUp('again')
    expect(heard).not.toHaveBeenCalled()
    expect(closed).toHaveBeenCalledTimes(1)
  })
})
