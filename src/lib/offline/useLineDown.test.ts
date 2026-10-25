import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { GAP_MS, SOCKET_DOWN_MS } from '#/lib/reach'
import {
  lineDown,
  lineDownAt,
  nextDownSince,
  subscribeLineDown,
  useLineDown,
  watchLineDown,
} from './useLineDown'
import type { ConvexReactClient } from 'convex/react'

/**
 * The caption above Book job, Save client and Add property: "No signal" when
 * the phone says so, "Could not reach PestM8" once the socket has been down
 * 8 s on screen, and nothing otherwise.
 */

describe('the rule', () => {
  test('counts from when the socket was first seen down on screen', () => {
    const at = { now: 1_000, visible: true, connected: false }
    expect(nextDownSince(null, at)).toBe(1_000)
    expect(nextDownSince(400, at)).toBe(400)
  })

  test('starts again once connected, or off screen', () => {
    expect(
      nextDownSince(400, { now: 1_000, visible: true, connected: true }),
    ).toBeNull()
    expect(
      nextDownSince(400, { now: 1_000, visible: false, connected: false }),
    ).toBeNull()
  })

  test('is down after the socket’s 8 s, or at once with no signal', () => {
    expect(lineDownAt(false, 0, SOCKET_DOWN_MS - 1)).toBeNull()
    expect(lineDownAt(false, 0, SOCKET_DOWN_MS)).toBe('unreachable')
    expect(lineDownAt(false, null, 60_000)).toBeNull()
    expect(lineDownAt(true, null, 0)).toBe('no-signal')
    expect(lineDownAt(true, 0, SOCKET_DOWN_MS)).toBe('no-signal')
  })
})

/** A Convex client's connection state, which a test moves on by hand. */
function fakeClient(connected: boolean) {
  const subscribers = new Set<(s: { isWebSocketConnected: boolean }) => void>()
  let state = { isWebSocketConnected: connected }
  return {
    client: {
      connectionState: () => state,
      subscribeToConnectionState: (
        cb: (s: { isWebSocketConnected: boolean }) => void,
      ) => {
        subscribers.add(cb)
        return () => subscribers.delete(cb)
      },
    } as unknown as ConvexReactClient,
    set(next: boolean) {
      state = { isWebSocketConnected: next }
      for (const cb of subscribers) cb(state)
    },
    subscribers,
  }
}

/** A page whose visibility a test moves on by hand. */
function fakeDocument() {
  const listeners = new Set<() => void>()
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }
  return {
    doc,
    show(visible: boolean) {
      doc.visibilityState = visible ? 'visible' : 'hidden'
      for (const fn of listeners) fn()
    },
    listeners,
  }
}

describe('watching the socket', () => {
  let page: ReturnType<typeof fakeDocument>
  let stop: (() => void) | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    page = fakeDocument()
    vi.stubGlobal('document', page.doc)
    vi.stubGlobal('navigator', { onLine: true })
  })
  afterEach(() => {
    stop?.()
    stop = undefined
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  test('a socket down from the start is unreachable after 8 s', () => {
    stop = watchLineDown(fakeClient(false).client)
    vi.advanceTimersByTime(SOCKET_DOWN_MS - 1)
    expect(lineDown()).toBeNull()
    vi.advanceTimersByTime(1)
    expect(lineDown()).toBe('unreachable')
  })

  test('a socket that comes back is up again at once', () => {
    const socket = fakeClient(true)
    stop = watchLineDown(socket.client)
    socket.set(false)
    vi.advanceTimersByTime(SOCKET_DOWN_MS)
    expect(lineDown()).toBe('unreachable')
    socket.set(true)
    expect(lineDown()).toBeNull()
    // And a new spell down gets its 8 s again.
    socket.set(false)
    vi.advanceTimersByTime(SOCKET_DOWN_MS - 1)
    expect(lineDown()).toBeNull()
  })

  test('only time on screen counts', () => {
    stop = watchLineDown(fakeClient(false).client)
    vi.advanceTimersByTime(SOCKET_DOWN_MS - 1_000)
    page.show(false)
    vi.advanceTimersByTime(60_000)
    expect(lineDown()).toBeNull()
    page.show(true)
    vi.advanceTimersByTime(SOCKET_DOWN_MS - 1)
    expect(lineDown()).toBeNull()
    vi.advanceTimersByTime(1)
    expect(lineDown()).toBe('unreachable')
  })

  test('a page frozen in between starts the 8 s again', () => {
    stop = watchLineDown(fakeClient(false).client)
    // Frozen: the clock moves on, the timer doesn't fire until it thaws.
    vi.setSystemTime(Date.now() + SOCKET_DOWN_MS + GAP_MS + 1_000)
    vi.advanceTimersByTime(SOCKET_DOWN_MS)
    expect(lineDown()).toBeNull()
    vi.advanceTimersByTime(SOCKET_DOWN_MS)
    expect(lineDown()).toBe('unreachable')
  })

  test('no signal says so whatever the socket is doing', () => {
    stop = watchLineDown(fakeClient(true).client)
    vi.stubGlobal('navigator', { onLine: false })
    expect(lineDown()).toBe('no-signal')
  })

  test('tells whoever is listening when it changes, and the phone too', () => {
    const heard = vi.fn()
    const phone = new Map<string, () => void>()
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: () => void) => phone.set(type, fn),
      removeEventListener: (type: string) => phone.delete(type),
    })
    const socket = fakeClient(true)
    stop = watchLineDown(socket.client)
    const unsubscribe = subscribeLineDown(heard)
    expect([...phone.keys()].sort()).toEqual(['offline', 'online'])
    socket.set(false)
    expect(heard).not.toHaveBeenCalled()
    vi.advanceTimersByTime(SOCKET_DOWN_MS)
    expect(heard).toHaveBeenCalledTimes(1)
    socket.set(true)
    expect(heard).toHaveBeenCalledTimes(2)
    unsubscribe()
    expect(phone.size).toBe(0)
    socket.set(false)
    vi.advanceTimersByTime(SOCKET_DOWN_MS)
    expect(heard).toHaveBeenCalledTimes(2)
  })

  test('a second watch replaces the first', () => {
    const first = fakeClient(false)
    const firstStop = watchLineDown(first.client)
    vi.advanceTimersByTime(SOCKET_DOWN_MS)
    expect(lineDown()).toBe('unreachable')
    const second = fakeClient(true)
    stop = watchLineDown(second.client)
    expect(first.subscribers.size).toBe(0)
    expect(page.listeners.size).toBe(1)
    expect(lineDown()).toBeNull()
    // Stopping the old one again does nothing to the new one.
    firstStop()
    second.set(false)
    vi.advanceTimersByTime(SOCKET_DOWN_MS)
    expect(lineDown()).toBe('unreachable')
  })

  test('stopping it forgets the socket', () => {
    stop = watchLineDown(fakeClient(false).client)
    vi.advanceTimersByTime(SOCKET_DOWN_MS)
    stop()
    stop = undefined
    expect(lineDown()).toBeNull()
    expect(page.listeners.size).toBe(0)
  })
})

describe('useLineDown', () => {
  test('is up on the server, whatever the phone would say', () => {
    vi.stubGlobal('navigator', { onLine: false })
    try {
      const Probe = () => createElement('p', null, String(useLineDown()))
      expect(renderToStaticMarkup(createElement(Probe))).toBe('<p>null</p>')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
