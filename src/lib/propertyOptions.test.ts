import { describe, expect, test } from 'vitest'
import { propertyOptions } from './propertyOptions'
import type { PickableProperty } from './propertyOptions'
import { matchesAllWords } from './searchMatch'

function property(
  id: string,
  client: PickableProperty['client'],
  addressLine: string,
  suburb: string,
  postcode = '6000',
): PickableProperty {
  return { _id: id, addressLine, suburb, postcode, client }
}

const NGUYEN = property(
  'p-nguyen',
  { name: 'J. Nguyen', phone: '0412 345 678' },
  '12 Wattle Street',
  'Bayswater',
  '6053',
)
const ROBERTS = property(
  'p-roberts',
  { name: 'M. Roberts' },
  '4 Kalinda Way',
  'Morley',
  '6062',
)
const CAFE = property(
  'p-cafe',
  { name: 'Café Lumière' },
  '1 Beaufort Street',
  'Mount Lawley',
)
const ARCHIVED = property(
  'p-archived',
  { name: 'A. Archer', archivedAt: 1 },
  '9 Old Road',
  'Bayswater',
)

/** What a person typing `query` into the picker would be offered. */
function offered(query: string, list = [NGUYEN, ROBERTS, CAFE, ARCHIVED]) {
  return propertyOptions(list)
    .filter((o) => matchesAllWords(o.searchText ?? o.label, query))
    .map((o) => o.value)
}

describe('finding a client and address for a new job', () => {
  test('a name and a suburb typed together find the one row with both', () => {
    // The old single-substring test found nothing for this: the words are
    // not next to each other in the label.
    expect(offered('nguyen bayswater')).toEqual(['p-nguyen'])
    expect(offered('bayswater nguyen')).toEqual(['p-nguyen'])
  })

  test('every word has to match, not any one of them', () => {
    expect(offered('nguyen morley')).toEqual([])
  })

  test('a street, a suburb or a postcode alone finds the site', () => {
    expect(offered('kalinda')).toEqual(['p-roberts'])
    expect(offered('morley')).toEqual(['p-roberts'])
    expect(offered('6062')).toEqual(['p-roberts'])
  })

  test('the number the caller is ringing from finds them, however it is spaced', () => {
    expect(offered('0412345678')).toEqual(['p-nguyen'])
    expect(offered('0412 345 678')).toEqual(['p-nguyen'])
    expect(offered('345678')).toEqual(['p-nguyen'])
  })

  test('case, accents and commas do not stop a match', () => {
    expect(offered('CAFE LUMIERE')).toEqual(['p-cafe'])
    expect(offered('Nguyen, Bayswater')).toEqual(['p-nguyen'])
  })

  test('nothing typed offers every site', () => {
    expect(offered('')).toHaveLength(4)
    expect(offered('   ')).toHaveLength(4)
  })
})

describe('how the picker lists them', () => {
  test('by client name, then street, with archived clients last', () => {
    const second = property(
      'p-nguyen-2',
      NGUYEN.client,
      '3 Acacia Court',
      'Bassendean',
    )
    expect(
      propertyOptions([ARCHIVED, ROBERTS, NGUYEN, CAFE, second]).map(
        (o) => o.value,
      ),
    ).toEqual(['p-cafe', 'p-nguyen-2', 'p-nguyen', 'p-roberts', 'p-archived'])
  })

  test('an archived client is still offered, and says so', () => {
    const archived = propertyOptions([ARCHIVED])[0]
    expect(archived.label).toBe('A. Archer (archived) — 9 Old Road, Bayswater')
    expect(offered('archer')).toEqual(['p-archived'])
  })

  test('each row names the client and the address, so two sites of one client differ', () => {
    expect(propertyOptions([NGUYEN])[0].label).toBe(
      'J. Nguyen — 12 Wattle Street, Bayswater',
    )
  })

  test('a site whose client is gone still has a readable label', () => {
    const orphan = property('p-orphan', null, '7 Lost Lane', 'Perth')
    expect(propertyOptions([orphan])[0].label).toBe(
      'Unknown client — 7 Lost Lane, Perth',
    )
  })
})
