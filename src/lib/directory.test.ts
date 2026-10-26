import { describe, expect, test } from 'vitest'
import {
  clientOf,
  clientRows,
  clientsForPicker,
  normaliseDirectory,
  sitesWithClients,
} from './directory'
import type { Directory } from './directory'
import type { Id } from '../../convex/_generated/dataModel'

/**
 * The client list as the screens read it (lib/directory.ts): an answer from
 * before contact people were sent, one with them, and a client with no site
 * yet, who is still somebody to add a site for.
 */

const client = (id: string) => id as Id<'clients'>
const site = (id: string) => id as Id<'properties'>
const contact = (id: string) => id as Id<'clientContacts'>

/** As `clients.directory` answered before 28 Oct 2026, and as a phone may
 * still have it kept: no emails, no `contacts`. */
const BEFORE: Directory = {
  clients: [
    {
      _id: client('c-jane'),
      _creationTime: 1,
      name: 'Jane Nguyen',
      kind: 'person',
      createdAt: 1,
    },
    {
      _id: client('c-agency'),
      _creationTime: 2,
      name: 'Ray White Bayswater',
      kind: 'business',
      createdAt: 2,
    },
    {
      _id: client('c-sam'),
      _creationTime: 3,
      name: 'Sam Wu',
      kind: 'business',
      createdAt: 3,
    },
  ],
  sites: [
    {
      _id: site('p-jane'),
      clientId: client('c-jane'),
      addressLine: '12 Wattle St',
      suburb: 'Bayswater',
      postcode: '6053',
      createdAt: 1,
    },
    {
      _id: site('p-agency'),
      clientId: client('c-agency'),
      addressLine: '1 King William St',
      suburb: 'Bayswater',
      postcode: '6053',
      createdAt: 2,
    },
  ],
  capped: false,
}

/** The same book as it is answered now: emails and contact people. */
const NOW: Directory = {
  ...BEFORE,
  clients: BEFORE.clients.map((c) =>
    c._id === 'c-jane' ? { ...c, email: 'jane@example.com' } : c,
  ),
  contacts: [
    {
      _id: contact('k-sarah'),
      clientId: client('c-agency'),
      name: 'Sarah Lee',
      phone: '0491 570 110',
    },
    // A person client's, should one ever arrive: the app hides them.
    {
      _id: contact('k-hidden'),
      clientId: client('c-jane'),
      name: 'Tom Nguyen',
    },
  ],
  contactsCapped: false,
}

describe('an answer as the screens read it (`normaliseDirectory`)', () => {
  test('one kept before contact people were sent reads as having none, and incomplete', () => {
    const read = normaliseDirectory(BEFORE)
    expect(read.contacts).toEqual([])
    expect(read.complete).toBe(false)
    expect(read.clients).toBe(BEFORE.clients)
  })

  test('one with them is complete', () => {
    const read = normaliseDirectory(NOW)
    expect(read.contacts).toHaveLength(2)
    expect(read.complete).toBe(true)
  })

  test('the same answer gives back the same object, and a normalised one itself', () => {
    const read = normaliseDirectory(NOW)
    expect(normaliseDirectory(NOW)).toBe(read)
    expect(normaliseDirectory(read)).toBe(read)
    // A push is a new answer: read afresh.
    expect(normaliseDirectory({ ...NOW })).not.toBe(read)
  })
})

describe('what the pickers and the Clients page are built from', () => {
  test('every site with its client, and a business’s contact people beside it', () => {
    const rows = sitesWithClients(NOW)
    expect(rows.map((r) => [r._id, r.client.name, r.contacts.length])).toEqual([
      ['p-jane', 'Jane Nguyen', 0],
      ['p-agency', 'Ray White Bayswater', 1],
    ])
    expect(sitesWithClients(BEFORE).every((r) => r.contacts.length === 0)).toBe(
      true,
    )
  })

  test('the client picker lists a client with no site yet', () => {
    expect(
      clientsForPicker(NOW).map((c) => [c._id, c.sites.length, c.contacts]),
    ).toEqual([
      ['c-jane', 1, []],
      ['c-agency', 1, [NOW.contacts![0]]],
      ['c-sam', 0, []],
    ])
  })

  test('a client with no site, chosen in New site for, is still found, so stays chosen', () => {
    expect(clientOf(NOW, 'c-sam')?.name).toBe('Sam Wu')
    expect(clientOf(NOW, 'c-sam')?.kind).toBe('business')
    expect(clientOf(NOW, 'c-gone')).toBeUndefined()
    expect(clientOf(NOW, '')).toBeUndefined()
  })

  test('the Clients page’s rows carry a business’s contact people, never a person’s', () => {
    expect(
      clientRows(NOW).map((r) => [r.client._id, r.contacts.map((c) => c.name)]),
    ).toEqual([
      ['c-jane', []],
      ['c-agency', ['Sarah Lee']],
      ['c-sam', []],
    ])
  })
})
