import { describe, expect, test } from 'vitest'
import {
  EVERYONE_GROUP,
  NO_SITES,
  RECENT_GROUP,
  clientOptions,
  pickerName,
  propertyOptions,
} from './propertyOptions'
import type { PickableClient, PickableProperty } from './propertyOptions'
import { filterByWords, pickOnEnter, startsFirst } from './searchMatch'
import { clientsForPicker, sitesWithClients } from './directory'
import type { Directory } from './directory'
import type { Id } from '../../convex/_generated/dataModel'

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

describe('finding a business site by its site contact', () => {
  // Two sites of one business, each with its own caretaker: the office is
  // talking to Jan, not to head office.
  const MART = {
    name: 'Mahal Mart',
    phone: '08 9300 0000',
    kind: 'business' as const,
  }
  const MORLEY = {
    ...property('p-mart-morley', MART, '3 Walter Road', 'Morley'),
    siteContactName: 'Jan Kowalski',
    siteContactPhone: '0433 222 111',
  }
  const MIDLAND = {
    ...property('p-mart-midland', MART, '8 Great Eastern Highway', 'Midland'),
    siteContactName: 'Priya Shah',
  }
  const sites = [MORLEY, MIDLAND, NGUYEN]

  test('by the site contact’s name', () => {
    expect(offered('kowalski', sites)).toEqual(['p-mart-morley'])
    expect(offered('priya', sites)).toEqual(['p-mart-midland'])
  })

  test('by the site contact’s number, written either way', () => {
    expect(offered('0433 222 111', sites)).toEqual(['p-mart-morley'])
    expect(offered('+61 433 222 111', sites)).toEqual(['p-mart-morley'])
  })

  test('head office’s number still finds every site', () => {
    expect(offered('9300 0000', sites)).toEqual([
      'p-mart-morley',
      'p-mart-midland',
    ])
  })

  test('the label is unchanged: client and address, not the site contact', () => {
    expect(propertyOptions([MORLEY])[0].label).toBe(
      'Mahal Mart — 3 Walter Road, Morley',
    )
  })

  test('a person client’s leftover site contact does not find their house', () => {
    // Switched from business to person, the site contact is kept but hidden
    // everywhere else (convex/lib/siteContact.ts).
    const switched = {
      ...MORLEY,
      _id: 'p-switched',
      client: { name: 'M. Roberts', kind: 'person' as const },
    }
    expect(offered('kowalski', [switched])).toEqual([])
    expect(offered('0433222111', [switched])).toEqual([])
    expect(offered('roberts', [switched])).toEqual(['p-switched'])
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

  test('a client is named the same way in a row and in an action that offers them', () => {
    // "New site for {pickerName}": never an archived client unmarked.
    expect(pickerName({ name: 'Sam Wu', archivedAt: 1 })).toBe(
      'Sam Wu (archived)',
    )
    expect(pickerName({ name: 'Sam Wu' })).toBe('Sam Wu')
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

describe('the client picker for a new site (Prompt 6.3)', () => {
  type Site = PickableClient['sites'][number]
  function client(
    _id: string,
    fields: Omit<PickableClient, '_id' | 'sites'>,
    sites: Array<Site>,
  ): PickableClient {
    return { _id, ...fields, sites }
  }
  const at = (
    addressLine: string,
    suburb: string,
    more: Partial<Site> = {},
  ): Site => ({ addressLine, suburb, ...more })
  const MAHAL = client(
    'c-mahal',
    {
      name: 'Mahal Mart',
      phone: '+61 8 9000 1111',
      email: 'Accounts@MahalMart.com.au',
      kind: 'business',
      contacts: [
        { name: 'Sarah Lee', phone: '0491 570 110', email: 'sarah@mahal.au' },
      ],
    },
    [
      at('14 Kewdale Road', 'Kewdale', {
        siteContactName: 'Jan Kowalski',
        siteContactPhone: '0433 222 111',
      }),
      at('5 Abernethy Road', 'Belmont'),
    ],
  )
  const CLIENTS = [
    MAHAL,
    client('c-nguyen-1', { name: 'J. Nguyen' }, [
      at('12 Wattle Street', 'Bayswater'),
    ]),
    client('c-nguyen-2', { name: 'J. Nguyen' }, [
      at('3 Coode Street', 'Dianella'),
    ]),
    client('c-archer', { name: 'A. Archer', archivedAt: 1 }, [
      at('9 Old Road', 'Bayswater'),
    ]),
    // No site yet: the one New site for is most often for.
    client('c-sam', { name: 'Sam Wu', phone: '0491 570 156' }, []),
  ]
  const find = (query: string, clients = CLIENTS) =>
    filterByWords(clientOptions(clients), query).map((o) => o.value)

  test('one option per client, saying where its sites are', () => {
    expect(clientOptions(CLIENTS).map((o) => o.label)).toEqual([
      'J. Nguyen — Bayswater',
      'J. Nguyen — Dianella',
      'Mahal Mart — Kewdale, Belmont',
      `Sam Wu — ${NO_SITES}`,
      'A. Archer (archived) — Bayswater',
    ])
  })

  test('a client with no site yet is offered, said to have none', () => {
    expect(find('sam')).toEqual(['c-sam'])
    expect(find('0491 570 156')).toEqual(['c-sam'])
  })

  test('an archived client is still offered, last, so it is not typed in again', () => {
    expect(find('Archer')).toEqual(['c-archer'])
  })

  test('found by the number in either form, or by a street or suburb', () => {
    expect(find('08 9000 1111')).toEqual(['c-mahal'])
    expect(find('0890001111')).toEqual(['c-mahal'])
    expect(find('Abernethy')).toEqual(['c-mahal'])
    expect(find('Dianella')).toEqual(['c-nguyen-2'])
  })

  test('found by their email, whatever its capitals', () => {
    expect(find('accounts@mahalmart.com.au')).toEqual(['c-mahal'])
    expect(find('ACCOUNTS@MAHALMART')).toEqual(['c-mahal'])
  })

  test('a business found by a contact person’s name, number or email, and its sites’ contacts', () => {
    expect(find('sarah lee')).toEqual(['c-mahal'])
    expect(find('0491 570 110')).toEqual(['c-mahal'])
    expect(find('+61 491 570 110')).toEqual(['c-mahal'])
    expect(find('sarah@mahal.au')).toEqual(['c-mahal'])
    expect(find('kowalski')).toEqual(['c-mahal'])
    expect(find('0433 222 111')).toEqual(['c-mahal'])
  })

  test('a person client’s leftover contacts and site contacts find nothing', () => {
    const switched = { ...MAHAL, _id: 'c-switched', kind: 'person' as const }
    expect(find('sarah', [switched])).toEqual([])
    expect(find('0491570110', [switched])).toEqual([])
    expect(find('kowalski', [switched])).toEqual([])
    expect(find('mahal', [switched])).toEqual(['c-switched'])
  })

  test('many suburbs are summed up rather than listed', () => {
    const many = client(
      'c-mahal',
      { name: 'Mahal Mart' },
      ['Kewdale', 'Belmont', 'Welshpool', 'Cannington'].map((s, i) =>
        at(`${i + 1} Road`, s),
      ),
    )
    expect(clientOptions([many])[0].label).toBe(
      'Mahal Mart — Kewdale, Belmont +2',
    )
  })
})

describe('finding a client and address by their email and contact people', () => {
  const AGENCY = {
    ...property(
      'p-agency',
      {
        name: 'Ray White Bayswater',
        kind: 'business' as const,
        email: 'Rentals@RayWhite.example',
      },
      '1 King William St',
      'Bayswater',
    ),
    contacts: [
      { name: 'Sarah Lee', phone: '0491 570 110', email: 'sarah@rw.example' },
    ],
  }
  const JANE = property(
    'p-jane',
    { name: 'Jane Nguyen', email: 'jane@example.com', kind: 'person' },
    '12 Wattle St',
    'Bayswater',
  )
  const list = [AGENCY, JANE, ROBERTS]

  test('the client’s own email, whatever its capitals', () => {
    expect(offered('jane@example.com', list)).toEqual(['p-jane'])
    expect(offered('JANE@EXAMPLE', list)).toEqual(['p-jane'])
    expect(offered('rentals@raywhite', list)).toEqual(['p-agency'])
  })

  test('a contact person’s name, number in either form, or email finds the business', () => {
    expect(offered('sarah lee', list)).toEqual(['p-agency'])
    expect(offered('0491 570 110', list)).toEqual(['p-agency'])
    expect(offered('+61 491 570 110', list)).toEqual(['p-agency'])
    expect(offered('sarah@rw', list)).toEqual(['p-agency'])
  })

  test('a person client’s leftover contacts find nothing', () => {
    const switched = {
      ...AGENCY,
      _id: 'p-switched',
      client: { ...AGENCY.client!, kind: 'person' as const },
    }
    expect(offered('sarah', [switched])).toEqual([])
    expect(offered('0491570110', [switched])).toEqual([])
  })

  test('each option’s search keys are worked out as it is built, not as it is searched', () => {
    const [option] = propertyOptions([JANE])
    expect(option.searchKey).toContain('jane@example com')
    expect(option.labelKey).toBe('jane nguyen 12 wattle st bayswater')
  })
})

describe('“Added recently”, then everyone A–Z', () => {
  const DAY = 24 * 60 * 60 * 1000
  // Tue 29 Sept 2026, 10:00 in Perth.
  const NOW = Date.parse('2026-09-29T10:00:00+08:00')
  const recent = { timezone: 'Australia/Perth', now: NOW }
  const added = (p: PickableProperty, daysAgo: number, importId?: string) => ({
    ...p,
    createdAt: NOW - daysAgo * DAY,
    ...(importId !== undefined && { importId }),
  })

  test('puts the newest sites added by hand first, with the day, and the rest A–Z under their own heading', () => {
    const options = propertyOptions(
      [added(NGUYEN, 400), added(ROBERTS, 1), added(CAFE, 3), ARCHIVED],
      recent,
    )
    expect(options.map((o) => [o.value, o.group, o.detail])).toEqual([
      ['p-roberts', 'Added recently', 'Added Mon 28 Sept'],
      ['p-cafe', 'Added recently', 'Added Sat 26 Sept'],
      ['p-nguyen', 'Everyone, A–Z', undefined],
      ['p-archived', 'Everyone, A–Z', undefined],
    ])
    // Each once: a recent site is not listed again in A–Z.
    expect(new Set(options.map((o) => o.value)).size).toBe(4)
  })

  test('leaves imported sites, archived clients and anything older than 90 days in A–Z', () => {
    const options = propertyOptions(
      [
        added(NGUYEN, 2, 'import-1'),
        added({ ...ROBERTS, client: { name: 'M. Roberts', archivedAt: 1 } }, 2),
        added(CAFE, 91),
        // Kept by an import's Undo: `importId` cleared, where it came from
        // not.
        {
          ...added(ARCHIVED, 1),
          client: { name: 'A. Archer' },
          importedFrom: 'import-2',
        },
      ],
      recent,
    )
    // Nothing recent at all: no headings, just the list as it always was.
    expect(options.map((o) => o.group)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })

  test('keeps at most eight in the section, newest first', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      added(
        property(`p-${i}`, { name: `Client ${i}` }, `${i} Hay St`, 'Perth'),
        i,
      ),
    )
    const options = propertyOptions(many, recent)
    expect(
      options.filter((o) => o.group === 'Added recently').map((o) => o.value),
    ).toEqual(['p-0', 'p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6', 'p-7'])
    expect(options.slice(8).map((o) => o.value)).toEqual(['p-8', 'p-9'])
  })

  test('works the same for the "new site for" client picker, by when the client was added', () => {
    const sites: Array<PickableClient> = [
      {
        _id: 'c-old',
        name: 'Aaron',
        createdAt: NOW - 200 * DAY,
        sites: [{ addressLine: '1 A St', suburb: 'Perth' }],
      },
      {
        _id: 'c-new',
        name: 'Zara',
        createdAt: NOW - DAY,
        sites: [{ addressLine: '2 B St', suburb: 'Perth' }],
      },
      {
        _id: 'c-imp',
        name: 'Bea',
        createdAt: NOW - DAY,
        importId: 'i',
        sites: [{ addressLine: '3 C St', suburb: 'Perth' }],
      },
    ]
    expect(clientOptions(sites, recent).map((o) => [o.value, o.group])).toEqual(
      [
        ['c-new', 'Added recently'],
        ['c-old', 'Everyone, A–Z'],
        ['c-imp', 'Everyone, A–Z'],
      ],
    )
  })

  test('a site sent as imported, a flag with no id (`clients.directory`), stays in A–Z', () => {
    const options = propertyOptions(
      [{ ...added(NGUYEN, 2), imported: true }, added(ROBERTS, 1)],
      recent,
    )
    expect(options.map((o) => [o.value, o.group])).toEqual([
      ['p-roberts', 'Added recently'],
      ['p-nguyen', 'Everyone, A–Z'],
    ])
  })

  test('a client sent as imported stays in A–Z in the "new site for" picker too', () => {
    const sites: Array<PickableClient> = [
      {
        _id: 'c-imp',
        name: 'Bea',
        createdAt: NOW - DAY,
        imported: true,
        sites: [{ addressLine: '3 C St', suburb: 'Perth' }],
      },
      {
        _id: 'c-new',
        name: 'Zara',
        createdAt: NOW - DAY,
        sites: [{ addressLine: '2 B St', suburb: 'Perth' }],
      },
    ]
    expect(clientOptions(sites, recent).map((o) => [o.value, o.group])).toEqual(
      [
        ['c-new', 'Added recently'],
        ['c-imp', 'Everyone, A–Z'],
      ],
    )
  })
})

describe('the pickers over the slim directory', () => {
  const DAY = 24 * 60 * 60 * 1000
  // Tue 29 Sept 2026, 10:00 in Perth.
  const NOW = Date.parse('2026-09-29T10:00:00+08:00')
  const recent = { timezone: 'Australia/Perth', now: NOW }
  const clientId = (id: string) => id as Id<'clients'>
  const siteId = (id: string) => id as Id<'properties'>

  // A small book as `clients.directory` sends it: slim rows, oldest first,
  // a flag for "came from an import", and archived clients kept.
  const DIRECTORY: Directory = {
    clients: [
      {
        _id: clientId('c-old'),
        _creationTime: 1,
        name: 'Aaron Old',
        kind: 'person',
        phone: '0412 000 111',
        email: 'aaron@example.com',
        clientNumber: 1,
        createdAt: NOW - 400 * DAY,
      },
      {
        _id: clientId('c-arch'),
        _creationTime: 2,
        name: 'Archer & Co',
        kind: 'business',
        clientNumber: 2,
        archivedAt: NOW - DAY,
        createdAt: NOW - 3 * DAY,
      },
      {
        _id: clientId('c-imp'),
        _creationTime: 3,
        name: 'Bea Imported',
        kind: 'person',
        clientNumber: 3,
        createdAt: NOW - 2 * DAY,
        imported: true,
      },
      {
        _id: clientId('c-mart'),
        _creationTime: 4,
        name: 'Mahal Mart',
        kind: 'business',
        phone: '08 9300 0000',
        abn: '51824753556',
        clientNumber: 4,
        status: 'lead',
        tags: ['Strata'],
        createdAt: NOW - 2 * DAY,
      },
      // No site yet: nothing to book at, so not in the Property picker,
      // but there in New site for's.
      {
        _id: clientId('c-none'),
        _creationTime: 5,
        name: 'Nell Nosite',
        kind: 'person',
        clientNumber: 5,
        createdAt: NOW - DAY,
      },
      {
        _id: clientId('c-new'),
        _creationTime: 6,
        name: 'Zara Hussain',
        kind: 'person',
        clientNumber: 6,
        createdAt: NOW - DAY,
      },
    ],
    sites: [
      {
        _id: siteId('p-old'),
        clientId: clientId('c-old'),
        addressLine: '1 Hay St',
        suburb: 'Perth',
        postcode: '6000',
        createdAt: NOW - 400 * DAY,
      },
      {
        _id: siteId('p-arch'),
        clientId: clientId('c-arch'),
        addressLine: '9 Old Rd',
        suburb: 'Bayswater',
        postcode: '6053',
        createdAt: NOW - 3 * DAY,
      },
      {
        _id: siteId('p-imp'),
        clientId: clientId('c-imp'),
        addressLine: '3 Coode St',
        suburb: 'Como',
        postcode: '6152',
        createdAt: NOW - 2 * DAY,
        imported: true,
      },
      {
        _id: siteId('p-mart-morley'),
        clientId: clientId('c-mart'),
        addressLine: '3 Walter Rd',
        suburb: 'Morley',
        postcode: '6062',
        siteContactName: 'Jan Kowalski',
        siteContactPhone: '0433 222 111',
        createdAt: NOW - 2 * DAY,
      },
      // Kept by an import's Undo: only `importedFrom` left behind it.
      {
        _id: siteId('p-mart-midland'),
        clientId: clientId('c-mart'),
        addressLine: '8 Great Eastern Hwy',
        suburb: 'Midland',
        postcode: '6056',
        createdAt: NOW - DAY,
        imported: true,
      },
      {
        _id: siteId('p-new'),
        clientId: clientId('c-new'),
        addressLine: '12 Beach Rd',
        suburb: 'Scarborough',
        postcode: '6019',
        createdAt: NOW - DAY,
      },
    ],
    capped: false,
  }

  // The same book as `properties.list` sent it: every site with its whole
  // client attached, and the import's id where the directory has a flag.
  const OLD = {
    _id: 'c-old',
    name: 'Aaron Old',
    kind: 'person' as const,
    phone: '0412 000 111',
    email: 'aaron@example.com',
    clientNumber: 1,
    createdAt: NOW - 400 * DAY,
  }
  const ARCHER = {
    _id: 'c-arch',
    name: 'Archer & Co',
    kind: 'business' as const,
    clientNumber: 2,
    archivedAt: NOW - DAY,
    createdAt: NOW - 3 * DAY,
  }
  const BEA = {
    _id: 'c-imp',
    name: 'Bea Imported',
    kind: 'person' as const,
    clientNumber: 3,
    createdAt: NOW - 2 * DAY,
    importId: 'import-1',
  }
  const MART = {
    _id: 'c-mart',
    name: 'Mahal Mart',
    kind: 'business' as const,
    phone: '08 9300 0000',
    abn: '51824753556',
    clientNumber: 4,
    status: 'lead',
    tags: ['Strata'],
    notes: 'Head office on the 3rd floor.',
    createdAt: NOW - 2 * DAY,
  }
  const ZARA = {
    _id: 'c-new',
    name: 'Zara Hussain',
    kind: 'person' as const,
    clientNumber: 6,
    createdAt: NOW - DAY,
  }
  const LIST = [
    {
      _id: 'p-old',
      clientId: 'c-old',
      addressLine: '1 Hay St',
      suburb: 'Perth',
      state: 'WA',
      postcode: '6000',
      createdAt: NOW - 400 * DAY,
      client: OLD,
    },
    {
      _id: 'p-arch',
      clientId: 'c-arch',
      addressLine: '9 Old Rd',
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
      createdAt: NOW - 3 * DAY,
      client: ARCHER,
    },
    {
      _id: 'p-imp',
      clientId: 'c-imp',
      addressLine: '3 Coode St',
      suburb: 'Como',
      state: 'WA',
      postcode: '6152',
      createdAt: NOW - 2 * DAY,
      importId: 'import-1',
      client: BEA,
    },
    {
      _id: 'p-mart-morley',
      clientId: 'c-mart',
      addressLine: '3 Walter Rd',
      suburb: 'Morley',
      state: 'WA',
      postcode: '6062',
      siteContactName: 'Jan Kowalski',
      siteContactPhone: '0433 222 111',
      createdAt: NOW - 2 * DAY,
      client: MART,
    },
    {
      _id: 'p-mart-midland',
      clientId: 'c-mart',
      addressLine: '8 Great Eastern Hwy',
      suburb: 'Midland',
      state: 'WA',
      postcode: '6056',
      createdAt: NOW - DAY,
      importedFrom: 'import-2',
      client: MART,
    },
    {
      _id: 'p-new',
      clientId: 'c-new',
      addressLine: '12 Beach Rd',
      suburb: 'Scarborough',
      state: 'WA',
      postcode: '6019',
      createdAt: NOW - DAY,
      client: ZARA,
    },
  ]

  test('offer exactly what `properties.list` offered, in the same order', () => {
    const sites = sitesWithClients(DIRECTORY)
    expect(propertyOptions(sites, recent)).toEqual(
      propertyOptions(LIST, recent),
    )
    expect(propertyOptions(sites)).toEqual(propertyOptions(LIST))
  })

  test('“Added recently” leaves out the imported and the archived', () => {
    const sites = sitesWithClients(DIRECTORY)
    expect(
      propertyOptions(sites, recent).map((o) => [o.value, o.group]),
    ).toEqual([
      ['p-new', RECENT_GROUP],
      ['p-mart-morley', RECENT_GROUP],
      ['p-old', EVERYONE_GROUP],
      ['p-imp', EVERYONE_GROUP],
      ['p-mart-midland', EVERYONE_GROUP],
      ['p-arch', EVERYONE_GROUP],
    ])
    expect(
      clientOptions(clientsForPicker(DIRECTORY), recent).map((o) => [
        o.value,
        o.group,
      ]),
    ).toEqual([
      ['c-none', RECENT_GROUP],
      ['c-new', RECENT_GROUP],
      ['c-mart', RECENT_GROUP],
      ['c-old', EVERYONE_GROUP],
      ['c-imp', EVERYONE_GROUP],
      ['c-arch', EVERYONE_GROUP],
    ])
  })

  test('an archived client is offered, labelled; one with no site only for a new site', () => {
    const sites = sitesWithClients(DIRECTORY)
    expect(
      propertyOptions(sites).find((o) => o.value === 'p-arch')?.label,
    ).toBe('Archer & Co (archived) — 9 Old Rd, Bayswater')
    expect(propertyOptions(sites).map((o) => o.value)).not.toContain('c-none')
    expect(
      clientOptions(clientsForPicker(DIRECTORY)).find(
        (o) => o.value === 'c-none',
      )?.label,
    ).toBe(`Nell Nosite — ${NO_SITES}`)
  })
})

describe('what was typed, best match first', () => {
  test('labels that start with the text come first, the rest keep their order', () => {
    const rows = [
      { value: 'a', label: 'Josh Harbour — 12 Harvey St, Perth' },
      { value: 'b', label: 'Harbourside Strata — 1 Riverside Dr, East Perth' },
      { value: 'c', label: 'Ann Lee — 4 Harbour Rd, Hillarys' },
    ]
    expect(
      startsFirst(filterByWords(rows, 'harb'), 'harb').map((r) => r.value),
    ).toEqual(['b', 'a', 'c'])
    expect(startsFirst(rows, '').map((r) => r.value)).toEqual(['a', 'b', 'c'])
    // Punctuation and case are ignored, as the search itself ignores them.
    expect(
      startsFirst(
        [
          { value: 'x', label: 'Zed' },
          { value: 'n', label: 'J. Nguyen — Bayswater' },
        ],
        'j nguyen',
      ).map((r) => r.value),
    ).toEqual(['n', 'x'])
  })
})
