import { describe, expect, test } from 'vitest'
import {
  holdersFirst,
  namedClient,
  noMatchRoute,
  propertyListEnd,
  queryHolders,
  queryShape,
  siteLessFound,
  siteLessNamed,
} from './clientSearch'
import { clientOptions } from './propertyOptions'
import { NO_OURS, buildMatchIndex } from '../../convex/lib/clientMatch'
import type { MatchDirectory, OursSource } from '../../convex/lib/clientMatch'
import type { Id } from '../../convex/_generated/dataModel'

/**
 * Searching for the caller in New Job's pickers (lib/clientSearch.ts): what
 * a query is read as, who holds a number or an email by its key, and what
 * "nothing matches" offers. Numbers are from ACMA's ranges for fiction.
 */

const client = (id: string) => id as Id<'clients'>
const site = (id: string) => id as Id<'properties'>
const contact = (id: string) => id as Id<'clientContacts'>

/** A small book: Jane with her mobile saved without its 04's 0 and a local
 * landline saved without its area code, an agency with a contact person and
 * a site contact, a family sharing a mobile, and the office's own number on
 * a client who has none. */
const BOOK: MatchDirectory = {
  clients: [
    {
      _id: client('c-jane'),
      name: 'Jane Nguyen',
      kind: 'person',
      phone: '5550 4321',
      email: 'Jane.Nguyen@Example.com',
    },
    {
      _id: client('c-agency'),
      name: 'Ray White Bayswater',
      kind: 'business',
      phone: '08 7010 1234',
      email: 'rentals@raywhite.example',
    },
    {
      _id: client('c-lisa'),
      name: 'Lisa Tran',
      kind: 'person',
      phone: '0491 570 159',
    },
    {
      _id: client('c-tom'),
      name: 'Tom Tran',
      kind: 'person',
      phone: '+61 491 570 159',
    },
    // The office's own number, put on a client who had none.
    {
      _id: client('c-office'),
      name: 'Kim Lee',
      kind: 'person',
      phone: '08 5550 0100',
    },
    {
      _id: client('c-sam'),
      name: 'Sam Wu',
      kind: 'person',
      phone: '0491 570 156',
    },
  ],
  sites: [
    {
      _id: site('p-jane'),
      clientId: client('c-jane'),
      addressLine: '12 Wattle St',
      suburb: 'Bayswater',
      postcode: '6053',
    },
    {
      _id: site('p-agency-1'),
      clientId: client('c-agency'),
      addressLine: '1 King William St',
      suburb: 'Bayswater',
      postcode: '6053',
      siteContactName: 'Priya Shah',
      siteContactPhone: '0491 570 313',
    },
    {
      _id: site('p-agency-2'),
      clientId: client('c-agency'),
      addressLine: '3/12 Ocean Pde',
      suburb: 'Cottesloe',
      postcode: '6011',
    },
    {
      _id: site('p-lisa'),
      clientId: client('c-lisa'),
      addressLine: '4 Hay St',
      suburb: 'Perth',
      postcode: '6000',
    },
    {
      _id: site('p-tom'),
      clientId: client('c-tom'),
      addressLine: '6 Hay St',
      suburb: 'Perth',
      postcode: '6000',
    },
  ],
  contacts: [
    {
      _id: contact('k-sarah'),
      clientId: client('c-agency'),
      name: 'Sarah Lee',
      phone: '0491 570 110',
      email: 'Sarah@RW.example',
    },
  ],
}

const OURS: OursSource = { phones: ['(08) 5550 0100'], emails: [] }
const INDEX = buildMatchIndex(BOOK, { areaCode: '08', ours: OURS })

const holders = (query: string, index = INDEX) =>
  queryHolders(index, query)?.clientIds ?? null

describe('what a query typed into a picker is read as', () => {
  test.each([
    ['0412 345 678', 'phone'],
    ['(08) 5550 4321', 'phone'],
    ['5550 4321', 'phone'],
    ['+61 412 345 678', 'phone'],
    ['0412-345-678', 'phone'],
    ['13 12 34', 'phone'],
    ['1300 123 456', 'phone'],
    ['+44 20 7946 0958', 'phone'],
    ['sam@example.com', 'email'],
    ['12 Wattle St', 'address'],
    ['3/12 Ocean Pde', 'address'],
    ['12A Smith Rd', 'address'],
    ['Sam Wu', 'name'],
    ['O’Brien', 'name'],
    ['J. Nguyen', 'name'],
    ['Smith-Jones & Co', 'name'],
    ['6014', 'other'],
    ['0412 345', 'other'],
    ['J', 'other'],
    ['Unit 3 12 Ocean Pde', 'other'],
    ['', 'other'],
    // Digits enough, but no number a key can be made of: an ABN, a number a
    // digit short, a local number can't start with 0 or 1, a number nobody
    // answers.
    ['51 824 753 556', 'other'],
    ['08 9345 678', 'other'],
    ['0934 5678', 'other'],
    ['0400 000 000', 'other'],
  ])('%s → %s', (query, shape) => {
    expect(queryShape(query, '08')).toBe(shape)
  })
})

describe('nothing matches: the way in to a new client, saying what it fills', () => {
  test.each([
    ['0491 570 156', 'New client, phone “0491 570 156”', 'phone'],
    ['  sam@example.com ', 'New client, email “sam@example.com”', 'email'],
    ['12 Wattle St', 'New client at “12 Wattle St”', 'addressLine'],
    ['Sam Wu', 'New client named “Sam Wu”', 'clientName'],
    // A postcode, or the start of a number: put nowhere.
    ['6014', 'New client', null],
    // Nor an ABN, nor a number a digit short: neither is a phone number.
    ['51 824 753 556', 'New client', null],
    ['08 9345 678', 'New client', null],
  ])('%s', (query, label, fills) => {
    expect(noMatchRoute(query, '08')).toEqual({
      label,
      fills,
      value: query.trim(),
    })
  })
})

describe('who holds a number or an email, by its key', () => {
  test('"08 5550 4321" finds a client saved as "5550 4321", which its words never could', () => {
    expect(holders('08 5550 4321')).toEqual(['c-jane'])
    expect(holders('(08) 5550 4321')).toEqual(['c-jane'])
    expect(holders('+61 8 5550 4321')).toEqual(['c-jane'])
  })

  test('a mobile in either form finds both of a family sharing it', () => {
    expect(holders('0491 570 159')).toEqual(['c-lisa', 'c-tom'])
    expect(holders('+61 491 570 159')).toEqual(['c-lisa', 'c-tom'])
  })

  test('an email whatever its capitals', () => {
    expect(holders('jane.nguyen@example.com')).toEqual(['c-jane'])
    expect(holders('JANE.NGUYEN@EXAMPLE.COM')).toEqual(['c-jane'])
  })

  test('a contact person’s number or email finds their business', () => {
    expect(holders('0491 570 110')).toEqual(['c-agency'])
    expect(holders('sarah@rw.example')).toEqual(['c-agency'])
  })

  test('a site contact’s number finds the site, but is nobody’s', () => {
    expect(queryHolders(INDEX, '0491 570 313')).toEqual({
      clientIds: [],
      siteContactSiteIds: ['p-agency-1'],
    })
  })

  test('the business’s own number is nobody’s', () => {
    expect(holders('08 5550 0100')).toEqual([])
  })

  test('a name, an address, part of a number or an ABN is not looked up', () => {
    expect(holders('Jane')).toBeNull()
    expect(holders('12 Wattle St')).toBeNull()
    expect(holders('0491 570')).toBeNull()
    expect(holders('51 824 753 556')).toBeNull()
  })

  test('no email is looked up in a copy without them all', () => {
    const old = buildMatchIndex(
      { ...BOOK, contacts: undefined },
      { areaCode: '08', ours: NO_OURS },
    )
    expect(old.complete).toBe(false)
    expect(holders('jane.nguyen@example.com', old)).toEqual([])
    // Numbers still are.
    expect(holders('08 5550 4321', old)).toEqual(['c-jane'])
  })
})

describe('the Property picker’s rows a number brings first', () => {
  const ORDER = BOOK.sites.map((s) => ({ _id: s._id, clientId: s.clientId }))

  test('each holder’s sites, in the picker’s order', () => {
    const held = queryHolders(INDEX, '0491 570 159')!
    expect(holdersFirst(held, ORDER)).toEqual(['p-lisa', 'p-tom'])
    expect(holdersFirst(held, [...ORDER].reverse())).toEqual([
      'p-tom',
      'p-lisa',
    ])
  })

  test('an agency’s every site for its contact person’s mobile', () => {
    expect(holdersFirst(queryHolders(INDEX, '0491 570 110')!, ORDER)).toEqual([
      'p-agency-1',
      'p-agency-2',
    ])
  })

  test('then the sites whose site contact has it', () => {
    expect(holdersFirst(queryHolders(INDEX, '0491 570 313')!, ORDER)).toEqual([
      'p-agency-1',
    ])
  })

  test('none for a client with no site yet: New site for is the way', () => {
    expect(holders('0491 570 156')).toEqual(['c-sam'])
    expect(holdersFirst(queryHolders(INDEX, '0491 570 156')!, ORDER)).toEqual(
      [],
    )
  })
})

describe('a client with no site yet, whom the Property picker has no row for', () => {
  /** The client picker's rows for the clients with no site: Sam, and Kim
   * with the office's number. */
  const SITE_LESS = clientOptions(
    BOOK.clients
      .filter((c) => !BOOK.sites.some((s) => s.clientId === c._id))
      .map((c) => ({ ...c, sites: [] })),
  )
  const found = (query: string) =>
    siteLessFound(query, queryHolders(INDEX, query), SITE_LESS)
  const end = (query: string) =>
    propertyListEnd(queryHolders(INDEX, query), found(query))

  test('is found by name, and offered a new site, not a second record', () => {
    expect(SITE_LESS.map((o) => o.label)).toEqual([
      'Kim Lee — No sites',
      'Sam Wu — No sites',
    ])
    expect(found('Sam Wu')).toEqual(['c-sam'])
    expect(found('sam')).toEqual(['c-sam'])
    expect(end('Sam Wu')).toEqual({ kind: 'one', clientId: 'c-sam' })
  })

  test('and by number, in either form', () => {
    expect(found('0491 570 156')).toEqual(['c-sam'])
    expect(found('+61 491 570 156')).toEqual(['c-sam'])
    expect(end('+61 491 570 156')).toEqual({ kind: 'one', clientId: 'c-sam' })
  })

  test('the business’s own number on one finds nobody, though its digits are theirs', () => {
    expect(found('08 5550 0100')).toEqual([])
    expect(end('08 5550 0100')).toBeNull()
    // By name, still found.
    expect(end('Kim Lee')).toEqual({ kind: 'one', clientId: 'c-office' })
  })

  test('nobody with no site matches: nothing to end with, and New client is the way', () => {
    expect(found('Kim Pham')).toEqual([])
    expect(end('Kim Pham')).toBeNull()
    expect(end('0491 570 158')).toBeNull()
  })

  test('one holder with sites still ends with a new site for them', () => {
    expect(end('jane.nguyen@example.com')).toEqual({
      kind: 'one',
      clientId: 'c-jane',
    })
  })

  test('a number two clients with no site share: a way to choose between them', () => {
    const twins = buildMatchIndex(
      {
        ...BOOK,
        clients: [
          ...BOOK.clients,
          {
            _id: client('c-amy'),
            name: 'Amy Wu',
            kind: 'person',
            phone: '0491 570 156',
          },
        ],
      },
      { areaCode: '08', ours: OURS },
    )
    const siteLess = clientOptions([
      { _id: 'c-sam', name: 'Sam Wu', sites: [] },
      { _id: 'c-amy', name: 'Amy Wu', sites: [] },
    ])
    const held = queryHolders(twins, '0491 570 156')
    const both = siteLessFound('0491 570 156', held, siteLess)
    expect([...both].sort()).toEqual(['c-amy', 'c-sam'])
    expect(propertyListEnd(held, both)).toEqual({
      kind: 'several',
      count: 2,
    })
    // By name, the same.
    expect(propertyListEnd(null, siteLessFound('wu', null, siteLess))).toEqual({
      kind: 'several',
      count: 2,
    })
  })
})

describe('a client named in full, sites or not', () => {
  // "Choose Jane Nguyen’s site", the line under Name, opens the Property
  // picker with her name: her sites, then a new one for her, never "New
  // client" (the matching plan's §2.6).
  const end = (query: string) =>
    propertyListEnd(queryHolders(INDEX, query), [], namedClient(INDEX, query))

  test('ends the list with New site for them', () => {
    expect(namedClient(INDEX, 'Jane Nguyen')).toBe('c-jane')
    expect(namedClient(INDEX, '  jane   NGUYEN ')).toBe('c-jane')
    expect(end('Jane Nguyen')).toEqual({ kind: 'one', clientId: 'c-jane' })
    expect(end('Ray White Bayswater')).toEqual({
      kind: 'one',
      clientId: 'c-agency',
    })
  })

  test('not for part of a name, a name two clients have, a placeholder, or a number', () => {
    expect(namedClient(INDEX, 'Jane')).toBeNull()
    expect(end('Jane')).toBeNull()
    const twins = buildMatchIndex(
      {
        clients: [
          { _id: client('c-1'), name: 'John Smith', kind: 'person' },
          { _id: client('c-2'), name: 'John Smith', kind: 'person' },
          { _id: client('c-3'), name: 'The Owner', kind: 'person' },
        ],
        sites: [],
        contacts: [],
      },
      { areaCode: '08', ours: NO_OURS },
    )
    expect(namedClient(twins, 'John Smith')).toBeNull()
    expect(namedClient(twins, 'The Owner')).toBeNull()
    // A number is found by who holds it, as ever.
    expect(namedClient(INDEX, '0491 570 156')).toBeNull()
    expect(end('0491 570 156')).toEqual({ kind: 'one', clientId: 'c-sam' })
  })
  test('a client with no site the words find comes first: the end row is the only way to them', () => {
    // "Sam", one word, with a site at 9 Oak St; "Sam Wu" with none yet; and
    // two Smiths with none.
    const book = buildMatchIndex(
      {
        clients: [
          { _id: client('c-sam1'), name: 'Sam', kind: 'person' },
          { _id: client('c-samwu'), name: 'Sam Wu', kind: 'person' },
          { _id: client('c-smith'), name: 'Smith', kind: 'person' },
          { _id: client('c-ann'), name: 'Ann Smith', kind: 'person' },
          { _id: client('c-bob'), name: 'Bob Smith', kind: 'person' },
        ],
        sites: [
          {
            _id: site('p-sam1'),
            clientId: client('c-sam1'),
            addressLine: '9 Oak St',
            suburb: 'Morley',
            postcode: '6062',
          },
          {
            _id: site('p-smith'),
            clientId: client('c-smith'),
            addressLine: '3 Elm St',
            suburb: 'Morley',
            postcode: '6062',
          },
        ],
        contacts: [],
      },
      { areaCode: '08', ours: NO_OURS },
    )
    const siteLess = clientOptions([
      { _id: 'c-samwu', name: 'Sam Wu', sites: [] },
      { _id: 'c-ann', name: 'Ann Smith', sites: [] },
      { _id: 'c-bob', name: 'Bob Smith', sites: [] },
    ])
    // As New Job's Property picker ends its list.
    const endOf = (query: string) => {
      const named = namedClient(book, query)
      const found = siteLessFound(query, queryHolders(book, query), siteLess)
      return propertyListEnd(
        queryHolders(book, query),
        named === null ? found : siteLessNamed(book, query, found),
        named,
      )
    }
    // "Sam" names Sam in full, whose site is listed above: Sam Wu, whom the
    // list can't show, is the end row, as before there was a Name line.
    expect(namedClient(book, 'Sam')).toBe('c-sam1')
    expect(endOf('Sam')).toEqual({ kind: 'one', clientId: 'c-samwu' })
    // So too several: a way to choose among them.
    expect(namedClient(book, 'Smith')).toBe('c-smith')
    expect(endOf('Smith')).toEqual({ kind: 'several', count: 2 })
    // Nobody with no site found: the one named.
    expect(endOf('Sam Wu')).toEqual({ kind: 'one', clientId: 'c-samwu' })
    expect(propertyListEnd(null, [], namedClient(book, 'Sam'))).toEqual({
      kind: 'one',
      clientId: 'c-sam1',
    })
  })

  test('not a client with no site the words are only inside, or found by a contact: they are someone else', () => {
    // Choose Tom Lee’s site, from the line under Name: his site, then New
    // site for Tom Lee, never a row for Lee Tomkins and a strata whose
    // contact is Tom Leeming.
    const directory: MatchDirectory = {
      clients: [
        { _id: client('c-tom'), name: 'Tom Lee', kind: 'person' },
        { _id: client('c-lt'), name: 'Lee Tomkins', kind: 'person' },
        {
          _id: client('c-strata'),
          name: 'Harbourside Strata',
          kind: 'business',
        },
      ],
      sites: [
        {
          _id: site('p-tom'),
          clientId: client('c-tom'),
          addressLine: '8 Oak St',
          suburb: 'Morley',
          postcode: '6062',
        },
      ],
      contacts: [
        {
          _id: contact('k-tl'),
          clientId: client('c-strata'),
          name: 'Tom Leeming',
        },
      ],
    }
    const book = buildMatchIndex(directory, { areaCode: '08', ours: NO_OURS })
    const siteLess = clientOptions([
      { _id: 'c-lt', name: 'Lee Tomkins', sites: [] },
      {
        _id: 'c-strata',
        name: 'Harbourside Strata',
        sites: [],
        kind: 'business',
        contacts: [{ name: 'Tom Leeming' }],
      },
    ])
    const found = siteLessFound('Tom Lee', null, siteLess)
    // The words find both.
    expect([...found].sort()).toEqual(['c-lt', 'c-strata'])
    expect(siteLessNamed(book, 'Tom Lee', found)).toEqual([])
    expect(
      propertyListEnd(
        null,
        siteLessNamed(book, 'Tom Lee', found),
        namedClient(book, 'Tom Lee'),
      ),
    ).toEqual({ kind: 'one', clientId: 'c-tom' })
  })
})
