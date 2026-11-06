import { describe, expect, test } from 'vitest'
import {
  NO_OURS,
  buildMatchIndex,
  matchNewClient,
} from '../../convex/lib/clientMatch'
import { MAY_BE_SAME_GROUP } from './clientMergeCopy'
import { evidencePhrase } from './clientMatchRows'
import {
  HINTS_AFTER_DRAW_MS,
  firstHintsNow,
  hintThroughContact,
  keepsByDefault,
  maybeSameLine,
  maybeSameName,
  mergeMatches,
  mergeOptions,
  sameAsDetail,
  mergeBook,
  shownHints,
} from './clientMergePicker'
import { EVERYONE_GROUP } from './propertyOptions'
import { orderedMatches } from './searchMatch'
import type { NormalisedDirectory } from './directory'
import type { Id } from '../../convex/_generated/dataModel'

/**
 * Who a client on the sheet may be, and the list Merge into… chooses the
 * client to keep from (the matching plan's M8), over a small book. Numbers
 * are from ACMA's ranges for fiction.
 */

const MOBILE = '0491 570 156'
const cid = (id: string) => id as Id<'clients'>

type Row = {
  id: string
  name: string
  number?: number
  phone?: string
  email?: string
  archived?: boolean
  business?: boolean
  contacts?: Array<{ id: string; name: string; phone: string }>
  sites?: Array<{ addressLine: string; suburb: string; postcode: string }>
}

function book(rows: ReadonlyArray<Row>): NormalisedDirectory {
  return {
    clients: rows.map((row) => ({
      _id: cid(row.id),
      _creationTime: 0,
      name: row.name,
      kind: row.business ? ('business' as const) : ('person' as const),
      createdAt: 0,
      ...(row.number !== undefined ? { clientNumber: row.number } : {}),
      ...(row.phone ? { phone: row.phone } : {}),
      ...(row.email ? { email: row.email } : {}),
      ...(row.archived ? { archivedAt: 1 } : {}),
    })),
    sites: rows.flatMap((row) =>
      (row.sites ?? []).map((site, i) => ({
        _id: `${row.id}-site-${i}` as Id<'properties'>,
        clientId: cid(row.id),
        ...site,
        createdAt: 0,
      })),
    ),
    contacts: rows.flatMap((row) =>
      (row.contacts ?? []).map((contact) => ({
        _id: contact.id as Id<'clientContacts'>,
        clientId: cid(row.id),
        name: contact.name,
        phone: contact.phone,
      })),
    ),
    complete: true,
  } as unknown as NormalisedDirectory
}

const WATTLE = {
  addressLine: '12 Wattle Street',
  suburb: 'Bayswater',
  postcode: '6053',
}

const HERE = {
  id: 'here',
  name: 'Jane Nguyen',
  number: 31,
  phone: MOBILE,
  sites: [WATTLE],
}

const BOOK = book([
  HERE,
  // Her own record from before, with her mobile.
  {
    id: 'older',
    name: 'Jane Nguyen',
    number: 12,
    phone: MOBILE,
    sites: [
      { addressLine: '4 Banksia Road', suburb: 'Morley', postcode: '6062' },
    ],
  },
  // Someone else at her address: a tenant, the house's last owner.
  { id: 'tenant', name: 'Tom Brown', number: 20, sites: [WATTLE] },
  // Her name, at her address, with nothing else of hers.
  { id: 'namesake', name: 'Jane Nguyen', number: 44, sites: [WATTLE] },
  { id: 'amy', name: 'Amy Lo', number: 3 },
  { id: 'zed', name: 'Bea Archer', number: 7 },
  // Archived, with her mobile: a merge refuses one.
  { id: 'gone', name: 'Jane Nguyen', phone: MOBILE, archived: true },
])

function matchesFor(directory: NormalisedDirectory) {
  const index = buildMatchIndex(mergeBook(directory, 'here'), {
    areaCode: '08',
    ours: NO_OURS,
  })
  return mergeMatches(index, { name: HERE.name, phone: HERE.phone }, HERE.sites)
}

describe('who the client on the sheet may be', () => {
  test('the same name and mobile, the same name and address; never someone archived', () => {
    expect(matchesFor(BOOK)).toEqual([
      { clientId: 'namesake', evidence: ['name', 'site'] },
      { clientId: 'older', evidence: ['name', 'mobile'] },
    ])
  })

  test('never an address under another name: a tenant or the last owner is not the same customer, as the server’s hints have it', () => {
    expect(matchesFor(BOOK).map((m) => m.clientId)).not.toContain('tenant')
    // Their address beside a number of theirs is.
    const withMobile = book([
      HERE,
      { id: 'tenant', name: 'Tom Brown', phone: MOBILE, sites: [WATTLE] },
    ])
    expect(matchesFor(withMobile)).toEqual([
      { clientId: 'tenant', evidence: ['site', 'mobile'] },
    ])
  })

  test('read from the book without them or anyone archived: with them, their own mobile is one several clients share, and evidence of no one', () => {
    const withThem = buildMatchIndex(BOOK, { areaCode: '08', ours: NO_OURS })
    const found = mergeMatches(withThem, { phone: HERE.phone, name: '' }, [])
    expect(found.map((m) => m.clientId)).not.toContain('older')
    expect(
      mergeMatches(
        buildMatchIndex(mergeBook(BOOK, 'here'), {
          areaCode: '08',
          ours: NO_OURS,
        }),
        { phone: HERE.phone, name: '' },
        [],
      ),
    ).toEqual([{ clientId: 'older', evidence: ['mobile'] }])
  })

  test('a name like theirs alone still counts beside someone stronger: the other record of a customer back under a new number, at a new address', () => {
    const MORLEY = {
      addressLine: '4 Banksia Road',
      suburb: 'Morley',
      postcode: '6062',
    }
    const NEW_MOBILE = '0491 570 162'
    const back: Row = {
      id: 'here',
      name: 'Jane Nguyen',
      number: 31,
      phone: NEW_MOBILE,
      sites: [MORLEY],
    }
    // Her own record from before: her old mobile, her old address.
    const before: Row = {
      id: 'older',
      name: 'Jane Nguyen',
      number: 12,
      phone: MOBILE,
      sites: [WATTLE],
    }
    const amy: Row = { id: 'amy', name: 'Amy Lo', number: 3 }
    const listed = (rows: ReadonlyArray<Row>) => {
      const directory = book(rows)
      const index = buildMatchIndex(mergeBook(directory, 'here'), {
        areaCode: '08',
        ours: NO_OURS,
      })
      const matches = mergeMatches(
        index,
        { name: 'Jane Nguyen', phone: NEW_MOBILE },
        [MORLEY],
      )
      return mergeOptions(directory, 'here', matches).map((o) => [
        o.value,
        o.group,
        o.detail,
      ])
    }
    // Nobody else alike.
    expect(listed([back, before, amy])).toEqual([
      ['older', MAY_BE_SAME_GROUP, 'Same name · #12'],
      ['amy', EVERYONE_GROUP, '#3'],
    ])
    // The house's last owner at her new address, whom the list leaves out.
    expect(
      listed([
        back,
        before,
        { id: 'tenant', name: 'Tom Brown', number: 20, sites: [MORLEY] },
        amy,
      ]),
    ).toEqual([
      ['older', MAY_BE_SAME_GROUP, 'Same name · #12'],
      ['amy', EVERYONE_GROUP, '#3'],
      ['tenant', EVERYONE_GROUP, '#20'],
    ])
    // Her partner, on her new mobile: first, and her record from before
    // still with them.
    expect(
      listed([
        back,
        before,
        { id: 'partner', name: 'Minh Nguyen', number: 21, phone: NEW_MOBILE },
        amy,
      ]),
    ).toEqual([
      ['partner', MAY_BE_SAME_GROUP, 'Same mobile · #21'],
      ['older', MAY_BE_SAME_GROUP, 'Same name · #12'],
      ['amy', EVERYONE_GROUP, '#3'],
    ])
  })

  test('nobody alike: none', () => {
    const lonely = book([HERE, { id: 'amy', name: 'Amy Lo' }])
    expect(matchesFor(lonely)).toEqual([])
  })
})

describe('the list to choose the client to keep from', () => {
  const options = mergeOptions(BOOK, 'here', matchesFor(BOOK))

  test('never the client being merged, nor one archived', () => {
    const values = options.map((o) => o.value)
    expect(values).not.toContain('here')
    expect(values).not.toContain('gone')
  })

  test('the ones alike first, saying why, then everyone else A–Z', () => {
    expect(options.map((o) => [o.value, o.group, o.detail])).toEqual([
      ['namesake', MAY_BE_SAME_GROUP, 'Same name and address · #44'],
      ['older', MAY_BE_SAME_GROUP, 'Same name and mobile · #12'],
      ['amy', EVERYONE_GROUP, '#3'],
      ['zed', EVERYONE_GROUP, '#7'],
      ['tenant', EVERYONE_GROUP, '#20'],
    ])
    // Labelled as New Job's client picker labels them: where their sites
    // are, so two of a name are told apart.
    expect(options[1].label).toBe('Jane Nguyen — Morley')
  })

  test('found by number, bare or as the row shows it: all a row shows beyond the name and suburb', () => {
    const found = (query: string) =>
      orderedMatches(options, query).map((o) => o.value)
    expect(found('#12')).toEqual(['older'])
    expect(found('12')).toContain('older')
    expect(found('jane #12')).toEqual(['older'])
    expect(found('#3')).toEqual(['amy'])
    expect(found('7')).toContain('zed')
    // The client being merged is never there to find.
    expect(found('#31')).toEqual([])
  })

  test('with nobody alike, one list without headings', () => {
    const plain = mergeOptions(BOOK, 'here', [])
    expect(plain.map((o) => o.group)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    expect(plain.map((o) => o.value)).toEqual([
      'amy',
      'zed',
      'namesake',
      'older',
      'tenant',
    ])
  })
})

describe('the possible-duplicate line', () => {
  test('says what the two agree on, as the match rows word it', () => {
    expect(maybeSameLine('Jane Nguyen', ['mobile'])).toBe(
      'May be the same customer as Jane Nguyen: same mobile.',
    )
    expect(evidencePhrase(['name', 'mobile'])).toBe('same name and mobile')
    expect(evidencePhrase(['nameNear', 'email'])).toBe(
      'similar name, same email',
    )
    expect(evidencePhrase(['nameNear'])).toBe('similar name')
    expect(evidencePhrase(['site', 'landline'])).toBe('same address and number')
    expect(evidencePhrase(['name', 'site', 'mobile', 'email'])).toBe(
      'same name, address, mobile and email',
    )
    expect(sameAsDetail(['site'])).toBe('Same address')
  })

  test('names the other by number where the two are called the same, as a merge does; bare without the number or a name of its own', () => {
    expect(maybeSameName('Jane Nguyen', 'Jane Nguyen', 12)).toBe(
      'Jane Nguyen #12',
    )
    // Called the same however it is written.
    expect(maybeSameName('Jane Nguyen', 'jane nguyen', 12)).toBe(
      'jane nguyen #12',
    )
    expect(maybeSameName('Jane Nguyen', 'Jane Nguyen', undefined)).toBe(
      'Jane Nguyen',
    )
    expect(maybeSameName('Jane Nguyen', 'J. Nguyen', 52)).toBe('J. Nguyen')
    expect(
      maybeSameLine(maybeSameName('Jane Nguyen', 'Jane Nguyen', 12), [
        'name',
        'mobile',
      ]),
    ).toBe('May be the same customer as Jane Nguyen #12: same name and mobile.')
  })

  test('Merge… keeps the client there first', () => {
    const madeAt = 1_000_000
    // The other client from before: kept.
    expect(
      keepsByDefault({ _creationTime: madeAt }, { _creationTime: 5 }, madeAt),
    ).toBe('other')
    // This one from before, the other made by the booking.
    expect(
      keepsByDefault({ _creationTime: 5 }, { _creationTime: madeAt }, madeAt),
    ).toBe('here')
    // The other's own time not here yet: the line's. A client made well
    // before it is the older one; one made with it is the booking's.
    expect(keepsByDefault({ _creationTime: 5 }, undefined, madeAt)).toBe('here')
    expect(keepsByDefault({ _creationTime: madeAt }, null, madeAt)).toBe(
      'other',
    )
  })
})

describe('which lines a sheet draws', () => {
  const hint = (id: string, other: string) => ({
    _id: id,
    otherClientId: other,
  })
  const drawn = [hint('h1', 'b'), hint('h2', 'c')]

  test('each the server still lists between the same two clients, and each answered here', () => {
    const live = new Map([['h1', 'b']])
    expect(shownHints(drawn, live, new Set()).map((h) => h._id)).toEqual(['h1'])
    // Answered here: it stays, saying so, whatever the server lists.
    expect(
      shownHints(drawn, new Map(), new Set(['h2'])).map((h) => h._id),
    ).toEqual(['h2'])
  })

  test('one handed to a third client by a merge elsewhere goes: its id stays, but it pairs them with someone the line doesn’t name', () => {
    // B merged into D: settleHintsOnMerge keeps h1, now pairing with D.
    const live = new Map([
      ['h1', 'd'],
      ['h2', 'c'],
    ])
    expect(shownHints(drawn, live, new Set()).map((h) => h._id)).toEqual(['h2'])
  })
})

describe('when a sheet decides its lines', () => {
  const lines = [{ _id: 'h1' }]
  const active = {}

  test('not before the client draws', () => {
    expect(
      firstHintsNow({
        client: undefined,
        hints: lines,
        settled: false,
        waited: false,
      }),
    ).toBeNull()
    expect(
      firstHintsNow({
        client: null,
        hints: lines,
        settled: false,
        waited: true,
      }),
    ).toBeNull()
  })

  test('a client answered before its lines waits for them, a short while: each is its own subscription, answered in turn', () => {
    expect(
      firstHintsNow({
        client: active,
        hints: undefined,
        settled: false,
        waited: false,
      }),
    ).toBeNull()
    // They came in that time: drawn.
    expect(
      firstHintsNow({
        client: active,
        hints: lines,
        settled: false,
        waited: false,
      }),
    ).toBe(lines)
    // Too late: none this opening, so nothing is put in under a thumb.
    expect(
      firstHintsNow({
        client: active,
        hints: undefined,
        settled: false,
        waited: true,
      }),
    ).toBe(false)
    expect(HINTS_AFTER_DRAW_MS).toBeLessThanOrEqual(500)
  })

  test('nothing to wait for: none at once, where the lines aren’t read or were refused', () => {
    expect(
      firstHintsNow({
        client: active,
        hints: undefined,
        settled: true,
        waited: false,
      }),
    ).toBe(false)
  })

  test('an archived client has none, whatever the server lists', () => {
    expect(
      firstHintsNow({
        client: { archivedAt: 1 },
        hints: lines,
        settled: false,
        waited: false,
      }),
    ).toBe(false)
  })
})

describe('a name that agreed through a contact person, not the two clients’ own', () => {
  // Ray White Bayswater, whose property manager Sarah Lee rings from her own
  // mobile; Sarah Lee books her own home as a private customer, and New Job
  // said "Sarah Lee is a contact at Ray White Bayswater".
  const SARAH = '0491 570 162'
  const agency: Row = {
    id: 'ray',
    name: 'Ray White Bayswater',
    number: 5,
    business: true,
    contacts: [{ id: 'k_sarah', name: 'Sarah Lee', phone: SARAH }],
    sites: [
      {
        addressLine: '1 King William Street',
        suburb: 'Bayswater',
        postcode: '6053',
      },
    ],
  }
  const sarah: Row = {
    id: 'here',
    name: 'Sarah Lee',
    number: 40,
    phone: SARAH,
    sites: [
      { addressLine: '7 Rose Avenue', suburb: 'Maylands', postcode: '6051' },
    ],
  }

  test('Merge into… names the contact person, never “Same name” for an agency called nothing like her', () => {
    const directory = book([
      sarah,
      agency,
      { id: 'amy', name: 'Amy Lo', number: 3 },
    ])
    const index = buildMatchIndex(mergeBook(directory, 'here'), {
      areaCode: '08',
      ours: NO_OURS,
    })
    const matches = mergeMatches(
      index,
      { name: 'Sarah Lee', phone: SARAH },
      sarah.sites ?? [],
    )
    expect(
      mergeOptions(directory, 'here', matches).map((o) => [
        o.value,
        o.group,
        o.detail,
      ]),
    ).toEqual([
      [
        'ray',
        MAY_BE_SAME_GROUP,
        'Contact Sarah Lee: same name and mobile · #5',
      ],
      ['amy', EVERYONE_GROUP, '#3'],
    ])
  })

  test('the possible-duplicate line says whose contact, on either sheet', () => {
    const madeAt = 1_000_000
    const hint = { evidence: ['name', 'mobile'] as const, madeAt }
    // Sarah Lee's, the client the booking made.
    const onHers = hintThroughContact(
      { name: 'Sarah Lee', kind: 'person', _creationTime: madeAt },
      { name: 'Ray White Bayswater' },
      hint,
    )
    expect(maybeSameLine('Ray White Bayswater', hint.evidence, onHers)).toBe(
      'May be the same customer as Ray White Bayswater: Sarah Lee is a contact there, with the same mobile.',
    )
    // The agency's, there long before.
    const onTheirs = hintThroughContact(
      { name: 'Ray White Bayswater', kind: 'business', _creationTime: 5 },
      { name: 'Sarah Lee' },
      hint,
    )
    expect(maybeSameLine('Sarah Lee', hint.evidence, onTheirs)).toBe(
      'May be the same customer as Sarah Lee: Sarah Lee is a contact at Ray White Bayswater, with the same mobile.',
    )
    // A name only like the contact's, at their address too.
    const near = { evidence: ['nameNear', 'site', 'mobile'] as const, madeAt }
    expect(
      maybeSameLine(
        'Ray White Bayswater',
        near.evidence,
        hintThroughContact(
          { name: 'S Lee', kind: 'person', _creationTime: madeAt },
          { name: 'Ray White Bayswater', kind: 'business' },
          near,
        ),
      ),
    ).toBe(
      'May be the same customer as Ray White Bayswater: S Lee may be a contact there, with the same address and mobile.',
    )
    // A business the booking made, matched through the agency's contact:
    // the agency's, as the client made is called as typed.
    expect(
      hintThroughContact(
        { name: 'Sarah Lee', kind: 'business', _creationTime: madeAt },
        { name: 'Ray White Bayswater', kind: 'business' },
        hint,
      ),
    ).toEqual({ contact: 'Sarah Lee', exact: true, at: null })
  })

  test('the usual duplicate, and two people, say what they agree on as before', () => {
    const madeAt = 1_000_000
    const hint = { evidence: ['name', 'mobile'] as const, madeAt }
    // Called the same.
    expect(
      hintThroughContact(
        { name: 'Jane Nguyen', kind: 'person', _creationTime: madeAt },
        { name: 'Jane Nguyen' },
        hint,
      ),
    ).toBeNull()
    // Two people, one renamed since: a contact counts only on a business.
    expect(
      hintThroughContact(
        { name: 'Jane Smith', kind: 'person', _creationTime: madeAt },
        { name: 'Jane Nguyen', kind: 'person' },
        hint,
      ),
    ).toBeNull()
    expect(maybeSameLine('Jane Nguyen #12', hint.evidence, null)).toBe(
      'May be the same customer as Jane Nguyen #12: same name and mobile.',
    )
  })

  test('a business booked under a name like a person’s own says what they agree on, on both sheets: neither has a contact person', () => {
    const madeAt = 1_000_000
    for (const [person, business] of [
      // A household, by the person's rule.
      ['Tom Nguyen', 'J & T Nguyen'],
      // A sole trader saved as a business, by an initial.
      ['Bob Smith', 'B Smith'],
    ] as const) {
      // The person, a client for years, and the business booked past the
      // match with their mobile: the evidence the server's check keeps.
      const index = buildMatchIndex(
        book([{ id: 'person', name: person, phone: SARAH }]),
        { areaCode: '08', ours: NO_OURS },
      )
      const { candidates } = matchNewClient(index, {
        name: business,
        phone: SARAH,
      })
      expect(candidates.map((c) => c.clientId)).toEqual(['person'])
      const evidence = candidates[0].evidence.filter((e) =>
        ['name', 'nameNear', 'site', 'mobile', 'email', 'landline'].includes(e),
      )
      expect(evidence).toEqual(['nameNear', 'mobile'])
      const hint = { evidence, madeAt }
      // The person's sheet, there long before.
      expect(
        maybeSameLine(
          business,
          evidence,
          hintThroughContact(
            { name: person, kind: 'person', _creationTime: 5 },
            { name: business, kind: 'business' },
            hint,
          ),
        ),
      ).toBe(
        `May be the same customer as ${business}: similar name, same mobile.`,
      )
      // The business's, the client the booking made.
      expect(
        maybeSameLine(
          person,
          evidence,
          hintThroughContact(
            { name: business, kind: 'business', _creationTime: madeAt },
            { name: person, kind: 'person' },
            hint,
          ),
        ),
      ).toBe(
        `May be the same customer as ${person}: similar name, same mobile.`,
      )
    }
  })
})
