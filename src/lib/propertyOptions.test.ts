import { describe, expect, test } from 'vitest'
import { propertyOptions } from './propertyOptions'
import type { PickableProperty } from './propertyOptions'
import { filterByWords, pickOnEnter } from './searchMatch'

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

/** What a person typing `query` into the picker would be offered — through
 * the same filter the Combobox runs, not a copy of it. */
function offered(query: string, list = [NGUYEN, ROBERTS, CAFE, ARCHIVED]) {
  return filterByWords(propertyOptions(list), query).map((o) => o.value)
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
    expect(offered('0412-345-678')).toEqual(['p-nguyen'])
    expect(offered('0412.345.678')).toEqual(['p-nguyen'])
  })

  test('a number saved one way is found when typed the other: 04… and +61 4…', () => {
    expect(offered('+61 412 345 678')).toEqual(['p-nguyen'])
    const international = property(
      'p-intl',
      { name: 'K. Tran', phone: '+61 498 765 432' },
      '5 Short Street',
      'Perth',
    )
    expect(offered('0498 765 432', [international])).toEqual(['p-intl'])
    expect(offered('+61 498 765 432', [international])).toEqual(['p-intl'])
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

describe('what Enter in the search box takes', () => {
  const sites = propertyOptions([NGUYEN, ROBERTS])
  const jobTypes = ['General Pest Control', 'Rodents', 'Spiders'].map((t) => ({
    value: t,
    label: t,
  }))
  const enter = (options: typeof sites, query: string, allowCustom = false) =>
    pickOnEnter(filterByWords(options, query), query, allowCustom)

  test('the only site left', () => {
    expect(enter(sites, '6062')).toBe('p-roberts')
  })

  test('nothing while several sites still match — that would be a guess', () => {
    expect(enter(sites, 'a')).toBeNull()
  })

  test('nothing before a word is typed, even when there is one site', () => {
    expect(enter(propertyOptions([NGUYEN]), '')).toBeNull()
    expect(enter(propertyOptions([NGUYEN]), '   ')).toBeNull()
  })

  test('a job type typed exactly', () => {
    expect(enter(jobTypes, 'rodents', true)).toBe('Rodents')
  })

  test('not the one partial match while "Add …" is also offered', () => {
    // "Pest" matches General Pest Control, and the picker also offers to add
    // "Pest" as a new type: two rows, so Enter takes neither.
    expect(enter(jobTypes, 'Pest', true)).toBeNull()
  })

  test('the typed text, where free text is allowed and nothing matches', () => {
    expect(enter(jobTypes, 'Possum Removal', true)).toBe('Possum Removal')
  })

  test('never free text where it is not allowed', () => {
    expect(enter(sites, 'Okafor')).toBeNull()
  })
})
