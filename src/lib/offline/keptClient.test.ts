import { describe, expect, test } from 'vitest'
import {
  NOT_KEPT_CLIENT,
  OPENS_WITH_SIGNAL,
  findKeptClient,
  keptClientEmail,
  keptClientState,
  xeroKnown,
} from './keptClient'
import type { Directory } from '#/lib/directory'

/**
 * The client sheet with no answer from PestM8: the client from the phone's
 * client list once the line is down, or the answer is late and the list
 * isn't live, and "not on this phone" only once the list is known not to
 * have them.
 */

const AT = 1_760_000_000_000

function directory(): Directory {
  const client = (id: string, name: string, kind: 'person' | 'business') => ({
    _id: id,
    _creationTime: AT,
    name,
    kind,
    createdAt: AT,
  })
  const site = (id: string, clientId: string, addressLine: string) => ({
    _id: id,
    clientId,
    addressLine,
    suburb: 'Wellard',
    postcode: '6170',
    createdAt: AT,
  })
  return {
    clients: [
      client('c1', 'Arthur Wellard', 'person'),
      client('c2', 'Subi Café Group', 'business'),
    ],
    sites: [
      site('p1', 'c2', '220 Hay St'),
      site('p2', 'c1', '14 Arthur Street'),
      site('p3', 'c2', '9 Rokeby Rd'),
    ],
    capped: false,
  } as unknown as Directory
}

describe('the client as the client list has them', () => {
  test('with their own sites, oldest first as the list has them', () => {
    const found = findKeptClient(directory(), 'c2')
    expect(found?.client.name).toBe('Subi Café Group')
    expect(found?.sites.map((site) => site.addressLine)).toEqual([
      '220 Hay St',
      '9 Rokeby Rd',
    ])
  })

  test('none for a client the list doesn’t have', () => {
    expect(findKeptClient(directory(), 'c9')).toBeNull()
  })
})

describe('what the sheet shows with no answer yet', () => {
  const DOWN = {
    down: 'no-signal',
    waitedOut: true,
    shown: false,
    found: true,
    live: false,
    listed: true,
    listReadable: true,
  } as const
  const UP = { ...DOWN, down: null, waitedOut: false }

  test('on a working line, its placeholder until the wait is over', () => {
    expect(keptClientState(UP)).toBe('waiting')
    expect(keptClientState({ ...UP, found: false })).toBe('waiting')
  })

  test('the client from the list once the wait is over, as the job sheet does', () => {
    expect(keptClientState({ ...UP, waitedOut: true })).toBe('kept')
  })

  test('a late answer while the list is live is on its way: the placeholder stays', () => {
    expect(keptClientState({ ...UP, waitedOut: true, live: true })).toBe(
      'waiting',
    )
  })

  test('a late answer on a line that looks up never says the client isn’t on the phone', () => {
    expect(keptClientState({ ...UP, waitedOut: true, found: false })).toBe(
      'waiting',
    )
  })

  test('the client from the list at once with the line down', () => {
    expect(keptClientState(DOWN)).toBe('kept')
    expect(keptClientState({ ...DOWN, down: 'unreachable' })).toBe('kept')
    expect(keptClientState({ ...DOWN, live: true })).toBe('kept')
  })

  test('once shown, kept up with the line back until the answer comes', () => {
    expect(keptClientState({ ...UP, shown: true })).toBe('kept')
    expect(keptClientState({ ...UP, shown: true, live: true })).toBe('kept')
  })

  test('not on this phone when the list is here without them, or there is none to show', () => {
    const missing = { ...DOWN, found: false }
    expect(keptClientState(missing)).toBe('not-kept')
    expect(
      keptClientState({ ...missing, listed: false, listReadable: false }),
    ).toBe('not-kept')
  })

  test('the list still on its way from the phone’s copy is waited for', () => {
    expect(keptClientState({ ...DOWN, found: false, listed: false })).toBe(
      'waiting',
    )
  })
})

describe('their email: the client list’s, or for an older copy a day’s', () => {
  const rows = [
    { propertyId: 'p_other', clientEmail: 'other@example.com' },
    { propertyId: 'p2', clientEmail: 'accounts@subicafe.com.au' },
    { propertyId: 'p_none', clientEmail: '' },
  ]
  const findRow = (match: (row: { propertyId: string }) => boolean) => {
    const row = rows.find(match)
    return row ? { row } : null
  }
  const kept = (sites: Array<{ _id: string }>, email?: string) => ({
    client: email === undefined ? {} : { email },
    sites,
  })

  test('the client list’s own, since it carries emails', () => {
    expect(
      keptClientEmail(kept([{ _id: 'p2' }], 'ops@subicafe.com.au'), findRow),
    ).toBe('ops@subicafe.com.au')
    // With no site, and no day saying it, as well.
    expect(keptClientEmail(kept([], 'ops@subicafe.com.au'), findRow)).toBe(
      'ops@subicafe.com.au',
    )
  })

  test('off a visit to one of their sites, for a copy without emails', () => {
    expect(keptClientEmail(kept([{ _id: 'p1' }, { _id: 'p2' }]), findRow)).toBe(
      'accounts@subicafe.com.au',
    )
  })

  test('none with no visit of theirs, an empty one, or no sites', () => {
    expect(keptClientEmail(kept([{ _id: 'p9' }]), findRow)).toBeUndefined()
    expect(keptClientEmail(kept([{ _id: 'p_none' }]), findRow)).toBeUndefined()
    expect(keptClientEmail(kept([]), () => ({ row: rows[0] }))).toBeUndefined()
  })
})

describe('whether the sheet has a Xero row', () => {
  const status = (business: string | null, mine: string | null = null) => ({
    configured: true,
    business: business === null ? null : { status: business },
    mine: mine === null ? null : { status: mine },
  })

  test('not where memory shows no Xero, which is most businesses', () => {
    expect(xeroKnown({ lines: [], status: undefined })).toBe(false)
    expect(xeroKnown({ lines: [[], undefined], status: status(null) })).toBe(
      false,
    )
    // Disconnected: the live sheet has no lines from it.
    expect(xeroKnown({ lines: [], status: status('disconnected') })).toBe(false)
    // A deployment without Xero's keys says nothing is set up.
    expect(
      xeroKnown({
        lines: [],
        status: { ...status('connected'), configured: false },
      }),
    ).toBe(false)
  })

  test('where a client’s Xero lines are in memory, or a connection they come from', () => {
    expect(
      xeroKnown({ lines: [[{ state: 'in_xero' }]], status: undefined }),
    ).toBe(true)
    expect(xeroKnown({ lines: [], status: status('connected') })).toBe(true)
    expect(xeroKnown({ lines: [], status: status('needs_reconnect') })).toBe(
      true,
    )
    expect(xeroKnown({ lines: [], status: status(null, 'connected') })).toBe(
      true,
    )
  })
})

describe('what it says', () => {
  test('what isn’t kept opens with signal', () => {
    expect(OPENS_WITH_SIGNAL).toBe('Opens when you have signal.')
  })

  test('a client not on the phone says when it opens', () => {
    expect(NOT_KEPT_CLIENT).toBe(
      'This client isn’t on this phone. It opens when you have signal.',
    )
  })
})
