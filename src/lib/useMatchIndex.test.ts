import { afterEach, describe, expect, test, vi } from 'vitest'
import { hookHarness } from './offline/hooks.fixtures'
import { logConnectionSlower } from './connectionLog'
import { normaliseDirectory } from './directory'
import { useMatchIndex, useMatchIndexWhenRead } from './useMatchIndex'
import type * as React from 'react'
import type { Directory } from './directory'
import type { Id } from '../../convex/_generated/dataModel'

// React's hooks run here by the harness: there is no document to render into.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  ...(await import('./offline/hooks.fixtures')).hookHarness.hooks,
}))

// The phone's own notes, as each index says what it cost.
vi.mock('./connectionLog', () => ({ logConnectionSlower: vi.fn() }))

/**
 * The match index over the client list, in the phone's own notes (the
 * matching plan's §2.12): `match-index {rows, ms}`, counts only, once for
 * each index built, so what a push costs New Job on an old phone can be
 * read from the phone's notes (`diagnostics:recent`), with nothing typed.
 */

afterEach(() => {
  hookHarness.mount(() => null)
  vi.restoreAllMocks()
  vi.mocked(logConnectionSlower).mockClear()
})

const BUSINESS = {
  state: 'WA',
  phone: '08 7010 9000',
  membership: { phone: '0491 570 006' },
}
const ACCESS = { membershipId: 'm-owner', caps: { 'team.manage': false } }

/** A new answer each time, as each push is. */
function answer(): ReturnType<typeof normaliseDirectory> {
  const raw = {
    clients: [
      {
        _id: 'c_jane' as Id<'clients'>,
        name: 'Jane Nguyen',
        kind: 'person' as const,
        phone: '0491 570 156',
      },
      {
        _id: 'c_tom' as Id<'clients'>,
        name: 'Tom Lee',
        kind: 'person' as const,
      },
    ],
    sites: [
      {
        _id: 'p_jane' as Id<'properties'>,
        clientId: 'c_jane' as Id<'clients'>,
        addressLine: '12 Wattle St',
        suburb: 'Bayswater',
        postcode: '6053',
      },
    ],
    contacts: [],
    capped: false,
  } as unknown as Directory
  return normaliseDirectory(raw)
}

describe('each match index, in the phone’s own notes', () => {
  test('is noted once as it is built: how many rows went in, and how long it took', () => {
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(2_023.5)
    const directory = answer()
    let now = directory
    const hook = hookHarness.mount(() =>
      useMatchIndex(now, BUSINESS, [], ACCESS),
    )
    expect(logConnectionSlower).toHaveBeenCalledTimes(1)
    expect(logConnectionSlower).toHaveBeenCalledWith('match-index', {
      rows: 3,
      ms: 23.5,
    })

    // Drawn again with the same answer: the same index, not noted again.
    hook.rerender()
    expect(logConnectionSlower).toHaveBeenCalledTimes(1)
    // Another screen over the same answer (Clients → New client): built
    // already, so nothing more is said.
    hookHarness.mount(() =>
      useMatchIndexWhenRead(directory, BUSINESS, [], ACCESS),
    )
    expect(logConnectionSlower).toHaveBeenCalledTimes(1)

    // A push: a new answer, a new index, noted.
    const back = hookHarness.mount(() =>
      useMatchIndex(now, BUSINESS, [], ACCESS),
    )
    expect(logConnectionSlower).toHaveBeenCalledTimes(1)
    now = answer()
    back.rerender()
    expect(logConnectionSlower).toHaveBeenCalledTimes(2)
    expect(vi.mocked(logConnectionSlower).mock.calls[1][0]).toBe('match-index')
  })

  test('nothing is noted while there is no list to build it from', () => {
    hookHarness.mount(() =>
      useMatchIndexWhenRead(undefined, BUSINESS, undefined, ACCESS),
    )
    expect(logConnectionSlower).not.toHaveBeenCalled()
  })
})
