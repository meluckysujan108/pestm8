import { describe, expect, test } from 'vitest'
import { matchesClientSearch } from './clientFilters'
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
    expect(found('824 753')).toBe(true)
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
})
