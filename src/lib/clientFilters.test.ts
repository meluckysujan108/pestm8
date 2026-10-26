import { describe, expect, test } from 'vitest'
import {
  computeSuburbLoad,
  filterClientRows,
  matchesClientSearch,
  searchClientRows,
} from './clientFilters'
import type { ClientKind } from './clientFilters'

type Site = {
  addressLine: string
  suburb: string
  siteContactName?: string
  siteContactPhone?: string
}

const row = (
  client: { name: string; kind: ClientKind; abn?: string },
  properties: Array<Site>,
) => ({ client, properties })

// A business with an ABN and two sites, one with a caretaker who has a number.
const MART = row({ name: 'Mahal Mart', kind: 'business', abn: '51824753556' }, [
  {
    addressLine: '3 Walter Road',
    suburb: 'Morley',
    siteContactName: 'Jan Kowalski',
    siteContactPhone: '0433 222 111',
  },
  {
    addressLine: '8 Great Eastern Highway',
    suburb: 'Midland',
    siteContactName: 'Priya Shah',
  },
])

const found = (term: string, r = MART) => matchesClientSearch(r, term)

describe('the Clients page search', () => {
  test('still finds a client by name, street and suburb', () => {
    expect(found('mahal')).toBe(true)
    expect(found('walter road')).toBe(true)
    expect(found('MIDLAND')).toBe(true)
    expect(found('  ')).toBe(true)
    expect(found('bayswater')).toBe(false)
  })

  test('finds a business by its ABN, with or without the spaces', () => {
    expect(found('51824753556')).toBe(true)
    expect(found('51 824 753 556')).toBe(true)
    expect(found('51 824')).toBe(true)
    // From the front, as one is read out: a run of digits from its middle is
    // more likely part of a postcode or a phone number.
    expect(found('824 753')).toBe(false)
    expect(found('7535')).toBe(false)
    expect(found('99 999 999 999')).toBe(false)
  })

  test('finds a business by a site contact’s name or number', () => {
    expect(found('kowalski')).toBe(true)
    expect(found('priya')).toBe(true)
    expect(found('0433 222 111')).toBe(true)
    expect(found('0433222111')).toBe(true)
    expect(found('+61 433 222 111')).toBe(true)
  })

  test('a street number does not find a client through its ABN or site phone', () => {
    // "22" is in the site's number and "82" in the ABN, but not on the card.
    expect(found('22')).toBe(false)
    expect(found('82')).toBe(false)
    // As text it still finds a street, as it always did.
    expect(found('3 walter')).toBe(true)
  })

  test('a client flipped to person keeps its ABN and site contacts hidden', () => {
    const switched = row(
      { ...MART.client, name: 'M. Roberts', kind: 'person' },
      MART.properties,
    )
    expect(found('51824753556', switched)).toBe(false)
    expect(found('kowalski', switched)).toBe(false)
    expect(found('0433222111', switched)).toBe(false)
    expect(found('walter road', switched)).toBe(true)
  })

  test('a Perth postcode does not find a site through the +61 form of its mobile', () => {
    // 0478 123 456 is +61 478 123 456, which starts 6147 — Lynwood's postcode.
    const mobile = row({ name: 'Riverside Strata', kind: 'business' }, [
      {
        addressLine: '1 Kent Street',
        suburb: 'Cannington',
        siteContactName: 'Dana',
        siteContactPhone: '0478 123 456',
      },
    ])
    expect(found('6147', mobile)).toBe(false)
    expect(found('0478', mobile)).toBe(true)
    expect(found('+61 478', mobile)).toBe(true)
    expect(found('61478123', mobile)).toBe(true)
  })
})

describe('the Clients page search finds the caller by their own details', () => {
  const JANE = {
    client: {
      name: 'Jane Nguyen',
      kind: 'person' as const,
      phone: '0491 570 156',
      email: 'Jane.Nguyen@Example.com',
    },
    properties: [{ addressLine: '12 Wattle St', suburb: 'Bayswater' }],
  }
  // Saved without its area code, as a local number often is.
  const LANDLINE = {
    client: { name: 'Bob Lee', kind: 'person' as const, phone: '5550 4321' },
    properties: [{ addressLine: '4 Hay St', suburb: 'Perth' }],
  }
  const AGENCY = {
    client: { name: 'Ray White Bayswater', kind: 'business' as const },
    properties: [{ addressLine: '1 King William St', suburb: 'Bayswater' }],
    contacts: [
      { name: 'Sarah Lee', phone: '0491 570 110', email: 'sarah@rw.example' },
    ],
  }

  test('by their own mobile, however it is written', () => {
    expect(matchesClientSearch(JANE, '0491 570 156')).toBe(true)
    expect(matchesClientSearch(JANE, '0491570156')).toBe(true)
    expect(matchesClientSearch(JANE, '+61 491 570 156')).toBe(true)
    expect(matchesClientSearch(JANE, '0491 570 157')).toBe(false)
  })

  test('by their email, whatever its capitals', () => {
    expect(matchesClientSearch(JANE, 'jane.nguyen@example.com')).toBe(true)
    expect(matchesClientSearch(JANE, 'JANE.NGUYEN@')).toBe(true)
    expect(matchesClientSearch(JANE, 'someone@example.com')).toBe(false)
  })

  test('a whole number with its area code finds one saved without it', () => {
    expect(matchesClientSearch(LANDLINE, '08 5550 4321')).toBe(true)
    expect(matchesClientSearch(LANDLINE, '(08) 5550 4321')).toBe(true)
    // Another state's area code is another number.
    expect(matchesClientSearch(LANDLINE, '02 5550 4321')).toBe(false)
    // In a Sydney business, the number saved without one is Sydney's.
    expect(matchesClientSearch(LANDLINE, '02 5550 4321', '02')).toBe(true)
    expect(matchesClientSearch(LANDLINE, '08 5550 4321', '02')).toBe(false)
  })

  test('a business by a contact person’s name, number or email', () => {
    expect(matchesClientSearch(AGENCY, 'sarah lee')).toBe(true)
    expect(matchesClientSearch(AGENCY, '0491 570 110')).toBe(true)
    expect(matchesClientSearch(AGENCY, 'sarah@rw')).toBe(true)
  })

  test('a person client’s leftover contacts find nothing', () => {
    const switched = {
      ...AGENCY,
      client: { ...AGENCY.client, kind: 'person' as const },
    }
    expect(matchesClientSearch(switched, 'sarah')).toBe(false)
    expect(matchesClientSearch(switched, '0491 570 110')).toBe(false)
  })
})

describe('client number and tags in the search', () => {
  const ALAN = {
    client: {
      name: 'Alan Vilay',
      kind: 'person' as const,
      clientNumber: 1928,
      tags: ['GPC', 'Real estate'],
    },
    properties: [{ addressLine: '6 Trinity Close', suburb: 'Canning Vale' }],
  }

  test('finds a client by its number, with or without the #', () => {
    expect(matchesClientSearch(ALAN, '#1928')).toBe(true)
    expect(matchesClientSearch(ALAN, '1928')).toBe(true)
    expect(matchesClientSearch(ALAN, '#192')).toBe(false)
  })

  test('a bare client number finds that client alone, not every phone holding its digits', () => {
    const JANE = {
      client: {
        name: 'Jane Nguyen',
        kind: 'person' as const,
        clientNumber: 2041,
      },
      properties: [{ addressLine: '12 Wattle St', suburb: 'Bayswater' }],
    }
    // 0420 418 888 has 2041 in it.
    const BOB = {
      client: {
        name: 'Bob Lee',
        kind: 'person' as const,
        phone: '0420 418 888',
      },
      properties: [{ addressLine: '4 Hay St', suburb: 'Perth' }],
    }
    const names = (term: string) =>
      searchClientRows([BOB, JANE], term).map((r) => r.client.name)
    expect(names('2041')).toEqual(['Jane Nguyen'])
    expect(names(' 2041 ')).toEqual(['Jane Nguyen'])
    expect(names('#2041')).toEqual(['Jane Nguyen'])
    // No client has the number: the digits of a phone, as before.
    expect(names('4188')).toEqual(['Bob Lee'])
    // Written as no client number is, it is the start of a mobile.
    expect(names('0420')).toEqual(['Bob Lee'])
    // Anything else is searched as it always was.
    expect(names('lee')).toEqual(['Bob Lee'])
  })

  test('a short number finds only the client with that number', () => {
    const seven = { ...ALAN, client: { ...ALAN.client, clientNumber: 7 } }
    expect(matchesClientSearch(seven, '7')).toBe(true)
    expect(matchesClientSearch(ALAN, '7')).toBe(false)
  })

  test('finds a client by a tag', () => {
    expect(matchesClientSearch(ALAN, 'real estate')).toBe(true)
  })
})

describe('the Clients page filters', () => {
  const NO_FILTERS = {
    kind: 'all',
    suburb: 'all',
    status: 'all',
    tag: 'all',
  } as const
  const ROWS = [
    {
      client: { name: 'Alan Vilay', kind: 'person' as const },
      properties: [{ suburb: 'Canning Vale' }],
    },
    {
      client: {
        name: 'Mahal Mart',
        kind: 'business' as const,
        status: 'lead' as const,
        tags: ['Real estate'],
      },
      properties: [{ suburb: 'Morley' }, { suburb: 'Midland' }],
    },
    {
      client: {
        name: 'Jo Bloggs',
        kind: 'person' as const,
        status: 'inactive' as const,
        tags: ['GPC'],
      },
      properties: [],
    },
  ]
  const names = (filters: Partial<Parameters<typeof filterClientRows>[1]>) =>
    filterClientRows(ROWS, { ...NO_FILTERS, ...filters }).map(
      (r) => r.client.name,
    )

  test('keeps every row, in order, with nothing set', () => {
    expect(names({})).toEqual(['Alan Vilay', 'Mahal Mart', 'Jo Bloggs'])
  })

  test('takes a client with no status as active', () => {
    expect(names({ status: 'active' })).toEqual(['Alan Vilay'])
    expect(names({ status: 'lead' })).toEqual(['Mahal Mart'])
  })

  test('matches a tag whatever its capitals, and a suburb of any site', () => {
    expect(names({ tag: 'real ESTATE' })).toEqual(['Mahal Mart'])
    expect(names({ suburb: 'Midland' })).toEqual(['Mahal Mart'])
    expect(names({ suburb: 'midland' })).toEqual([])
  })

  test('needs every filter set to match', () => {
    expect(names({ kind: 'person' })).toEqual(['Alan Vilay', 'Jo Bloggs'])
    expect(names({ kind: 'person', tag: 'GPC' })).toEqual(['Jo Bloggs'])
    expect(names({ kind: 'business', tag: 'GPC' })).toEqual([])
  })

  test('counts a client once per suburb, however many sites it has there', () => {
    // Still found here, where the page and its tests have always looked.
    expect(
      computeSuburbLoad([
        { properties: [{ suburb: 'Morley' }, { suburb: 'Morley' }] },
        { properties: [{ suburb: 'Morley' }, { suburb: '' }] },
      ]),
    ).toEqual([{ suburb: 'Morley', count: 2 }])
  })
})
