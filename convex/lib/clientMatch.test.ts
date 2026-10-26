import { describe, expect, test } from 'vitest'
import {
  MATCH_ROWS_MAX,
  NO_OURS,
  autoRule,
  buildMatchIndex,
  matchIndexFor,
  matchNewClient,
  matchNewSite,
  oursFields,
  oursFor,
  oursKeys,
  shownRows,
} from './clientMatch'
import type {
  Candidate,
  MatchClient,
  MatchContact,
  MatchDirectory,
  MatchResult,
  MatchSite,
  OursReader,
  OursSource,
  TypedClient,
} from './clientMatch'
import type { Id } from '../_generated/dataModel'

/**
 * "Is this caller already a client?" (lib/clientMatch.ts), case by case:
 * the domain cases of the plan's §2.11 first, then who counts as holding a
 * number, the business's and the team's own numbers, the tiers, and the
 * automatic rule a booking sent later is held to.
 * Numbers are from ACMA's ranges for fiction where they are written out.
 */

type Book = {
  clients: Array<MatchClient>
  sites: Array<MatchSite>
  contacts: Array<MatchContact>
}

type ClientSpec = Partial<Omit<MatchClient, '_id' | 'name'>> & {
  sites?: Array<
    | string
    | {
        addressLine: string
        suburb?: string
        postcode?: string
        siteContactName?: string
        siteContactPhone?: string
      }
  >
  contacts?: Array<{ name: string; phone?: string; email?: string }>
}

/** A client book built up a client at a time; ids in the order made. */
function newBook() {
  const book: Book = { clients: [], sites: [], contacts: [] }
  let next = 0
  const id = <T extends 'clients' | 'properties' | 'clientContacts'>(
    prefix: string,
  ) => `${prefix}${String(next++).padStart(3, '0')}` as Id<T>
  const add = (name: string, spec: ClientSpec = {}) => {
    const { sites = [], contacts = [], ...fields } = spec
    const clientId = id<'clients'>('c')
    book.clients.push({ _id: clientId, name, kind: 'person', ...fields })
    const siteIds = sites.map((site) => {
      const s = typeof site === 'string' ? { addressLine: site } : site
      const siteId = id<'properties'>('p')
      book.sites.push({
        _id: siteId,
        clientId,
        suburb: 'Bayswater',
        postcode: '6053',
        ...s,
      })
      return siteId
    })
    const contactIds = contacts.map((contact) => {
      const contactId = id<'clientContacts'>('k')
      book.contacts.push({ _id: contactId, clientId, ...contact })
      return contactId
    })
    return { clientId, siteIds, contactIds }
  }
  return { book, add }
}

/** A Perth business with no numbers of its own on any client. */
const PERTH = { areaCode: '08', ours: NO_OURS }

function match(
  book: MatchDirectory,
  typed: TypedClient,
  ours: OursSource = NO_OURS,
): MatchResult {
  return matchNewClient(buildMatchIndex(book, { ...PERTH, ours }), typed)
}

const at = (addressLine: string, suburb = 'Bayswater', postcode = '6053') => ({
  addressLine,
  suburb,
  postcode,
})

/** A candidate's tier and evidence, which is what most cases are about. */
const brief = (c: Candidate) => ({
  clientId: c.clientId,
  tier: c.tier,
  evidence: c.evidence,
})

const OFFICE = '08 9272 1234'
const RENTALS = 'rentals@raywhite.test'
const SARAH = '0491 570 110'

/** Ray White Bayswater, a business client with Sarah Lee as a contact. */
function agency(add: ReturnType<typeof newBook>['add']) {
  return add('Ray White Bayswater', {
    kind: 'business',
    phone: OFFICE,
    email: RENTALS,
    sites: ['12 Wattle St', '14 Wattle St'],
    contacts: [{ name: 'Sarah Lee', phone: SARAH }],
  })
}

describe('the domain cases', () => {
  test('an agency’s owners all carry its office number and rentals@: one Shared row, and Book books', () => {
    const { book, add } = newBook()
    const ray = agency(add)
    const owners = ['Ann Bell', 'Ben Cole', 'Cat Dunn', 'Dan Ely', 'Eve Ford']
      .map((name, i) =>
        add(name, {
          phone: OFFICE,
          email: RENTALS,
          sites: [`${i + 1} Elm St`],
        }),
      )
      .map((o) => o.clientId)

    const result = match(book, {
      name: 'Tom Lee',
      phone: OFFICE,
      email: RENTALS,
      site: at('9 New St'),
    })
    expect(result.candidates).toEqual([])
    // One row for the set of holders, with both keys; the business first.
    expect(result.shared).toEqual([
      {
        keys: [
          { field: 'phone', key: '0892721234', reason: 'many' },
          { field: 'email', key: RENTALS, reason: 'many' },
        ],
        clientIds: [ray.clientId, ...owners],
        businessClientId: ray.clientId,
      },
    ])
  })

  test('the first owner entered with the office landline: Shared, never a one-tap Use', () => {
    const { book, add } = newBook()
    const tom = add('Tom Lee', { phone: OFFICE, sites: ['1 Elm St'] })

    const result = match(book, { name: 'Sam Wu', phone: OFFICE })
    expect(result.candidates).toEqual([])
    expect(result.shared).toEqual([
      {
        keys: [{ field: 'phone', key: '0892721234', reason: 'landline' }],
        clientIds: [tom.clientId],
      },
    ])
  })

  test('the agency as one client, its property manager rings from her own mobile: Same, through the contact', () => {
    const { book, add } = newBook()
    const ray = agency(add)

    const [row] = match(book, { name: 'Sarah Lee', phone: SARAH }).candidates
    expect(brief(row)).toEqual({
      clientId: ray.clientId,
      tier: 'same',
      evidence: ['name', 'mobile'],
    })
    expect(row.contactId).toBe(ray.contactIds[0])
  })

  test('a tenant typed with the manager’s mobile: Shared, with New site for the agency', () => {
    const { book, add } = newBook()
    const ray = agency(add)

    const result = match(book, { name: 'Tom Lee', phone: SARAH })
    expect(result.candidates).toEqual([])
    expect(result.shared).toEqual([
      {
        keys: [{ field: 'phone', key: '0491570110', reason: 'business' }],
        clientIds: [ray.clientId],
        businessClientId: ray.clientId,
      },
    ])
  })

  test('the agency’s own site, a new owner: Likely, the address under another name', () => {
    const { book, add } = newBook()
    const ray = agency(add)

    const [row, ...rest] = match(book, {
      name: 'Tom Lee',
      site: at('12 Wattle Street'),
    }).candidates
    expect(rest).toEqual([])
    expect(brief(row)).toEqual({
      clientId: ray.clientId,
      tier: 'likely',
      evidence: ['site'],
    })
    expect(row.siteIds).toEqual([ray.siteIds[0]])
  })

  test('strata: the manager’s email on two units, a third unit typed: Shared only, units kept apart', () => {
    const { book, add } = newBook()
    const three = add('Kim Park', {
      email: 'strata@manager.test',
      sites: ['3/12 Ocean Pde'],
    })
    const five = add('Lee Quinn', {
      email: 'strata@manager.test',
      sites: ['5/12 Ocean Pde'],
    })
    add('Ocean Pde Strata', {
      kind: 'business',
      sites: ['Common Property 12 Ocean Pde'],
    })

    const result = match(book, {
      name: 'Max Roe',
      email: 'strata@manager.test',
      site: at('4/12 Ocean Pde'),
    })
    expect(result.candidates).toEqual([])
    expect(result.shared).toEqual([
      {
        keys: [{ field: 'email', key: 'strata@manager.test', reason: 'many' }],
        clientIds: [three.clientId, five.clientId],
      },
    ])
  })

  test('strata, common property: a new site for the strata client like its own is said, never added unasked', () => {
    const { book, add } = newBook()
    const strata = add('Ocean Pde Strata', {
      kind: 'business',
      sites: ['Common Property 12 Ocean Pde', '3/12 Ocean Pde'],
    })

    const [row, ...rest] = matchNewSite(
      buildMatchIndex(book, PERTH),
      strata.clientId,
      at('12 Ocean Pde'),
    ).candidates
    expect(rest).toEqual([])
    expect(brief(row)).toEqual({
      clientId: strata.clientId,
      tier: 'likely',
      evidence: ['addressNear'],
    })
    expect(row.nearSiteIds).toEqual([strata.siteIds[0]])
  })

  test('a family sharing a mobile, someone new: Shared', () => {
    const { book, add } = newBook()
    const jane = add('Jane Nguyen', { phone: '0412 345 678' })
    const tom = add('Tom Nguyen', { phone: '0412 345 678' })

    const result = match(book, { name: 'Lisa Nguyen', phone: '0412 345 678' })
    expect(result.candidates).toEqual([])
    expect(result.shared).toEqual([
      {
        keys: [{ field: 'phone', key: '0412345678', reason: 'many' }],
        clientIds: [jane.clientId, tom.clientId],
      },
    ])
  })

  test('a family sharing a mobile, a known member: Likely, the name with a shared number', () => {
    const { book, add } = newBook()
    const jane = add('Jane Nguyen', { phone: '0412 345 678' })
    add('Tom Nguyen', { phone: '0412 345 678' })

    const result = match(book, { name: 'Jane Nguyen', phone: '0412 345 678' })
    expect(result.candidates.map(brief)).toEqual([
      { clientId: jane.clientId, tier: 'likely', evidence: ['name', 'shared'] },
    ])
    expect(result.candidates[0].shared).toEqual([
      { field: 'phone', key: '0412345678', holders: 2 },
    ])
    // The number's own row stays: it is on someone else too.
    expect(result.shared).toHaveLength(1)
  })

  test('the husband rings with his own mobile from her address: Likely on her, the address with another name', () => {
    const { book, add } = newBook()
    const jane = add('Jane Nguyen', {
      phone: '0412 345 678',
      sites: ['12 Wattle St'],
    })
    // Tom is a client too, with the name alone: not shown beside a Likely.
    add('Tom Nguyen', { phone: '0412 345 678' })

    const result = match(book, {
      name: 'Tom Nguyen',
      phone: '0499 888 777',
      site: at('12 Wattle St'),
    })
    expect(result.candidates.map(brief)).toEqual([
      { clientId: jane.clientId, tier: 'likely', evidence: ['site'] },
    ])
  })

  test('a household import name and her own mobile: Same, a similar name', () => {
    const { book, add } = newBook()
    const household = add('Mr & Mrs J Nguyen', { phone: '0412 345 678' })

    expect(
      match(book, {
        name: 'Jane Nguyen',
        phone: '0412 345 678',
      }).candidates.map(brief),
    ).toEqual([
      {
        clientId: household.clientId,
        tier: 'same',
        evidence: ['nameNear', 'mobile'],
      },
    ])
  })

  test('a new number and a slip in the street: Likely, like one of her sites', () => {
    const { book, add } = newBook()
    const jane = add('Jane Nguyen', {
      phone: '0412 345 678',
      sites: ['12 Wattle St'],
    })

    const [row] = match(book, {
      name: 'Jane Nguyen',
      phone: '0499 888 777',
      site: at('12 Watle St'),
    }).candidates
    expect(brief(row)).toEqual({
      clientId: jane.clientId,
      tier: 'likely',
      evidence: ['name', 'addressNear'],
    })
    expect(row.nearSiteIds).toEqual([jane.siteIds[0]])
  })

  test('a sold house: Likely, and never automatic', () => {
    const { book, add } = newBook()
    const jane = add('Jane Nguyen', { sites: ['12 Wattle St'] })
    const typed = { name: 'Tom Lee', site: at('12 Wattle St') }

    const index = buildMatchIndex(book, PERTH)
    const [row] = matchNewClient(index, typed).candidates
    expect(brief(row)).toEqual({
      clientId: jane.clientId,
      tier: 'likely',
      evidence: ['site'],
    })
    expect(autoRule(index, row, typed)).toBe(false)
  })

  test('a common name, or a placeholder: nothing on the name', () => {
    const { book, add } = newBook()
    add('John Smith')
    add('John Smith')
    add('Smith, John')
    add('The Owner')

    expect(match(book, { name: 'John Smith' }).candidates).toEqual([])
    expect(match(book, { name: 'The Owner' }).candidates).toEqual([])
    expect(match(book, { name: 'the owner' }).candidates).toEqual([])
  })

  test('an owner-occupier or a cash sale: a placeholder, so nothing on the name', () => {
    const { book, add } = newBook()
    const occupier = add('The Owner/Occupier', { sites: ['9 Elm St'] })
    const owner = add('Owner Occupier', { phone: '0413 000 001' })
    add('Cash Sale')

    const bySite = { name: 'The Owner/Occupier', site: at('9 Elm St') }
    const index = buildMatchIndex(book, PERTH)
    const [atSite] = matchNewClient(index, bySite).candidates
    // The address is still a place; the name adds nothing to it.
    expect(brief(atSite)).toEqual({
      clientId: occupier.clientId,
      tier: 'likely',
      evidence: ['site'],
    })
    expect(autoRule(index, atSite, bySite)).toBe(false)

    const byPhone = { name: 'Owner Occupier', phone: '0413 000 001' }
    const [atPhone] = matchNewClient(index, byPhone).candidates
    expect(brief(atPhone)).toEqual({
      clientId: owner.clientId,
      tier: 'likely',
      evidence: ['mobile'],
    })
    expect(autoRule(index, atPhone, byPhone)).toBe(false)

    expect(match(book, { name: 'Cash Sale' }).candidates).toEqual([])
  })

  test('a number nobody answers is nobody’s', () => {
    const { book, add } = newBook()
    add('John Citizen', { phone: '0400 000 000', email: 'noemail@noemail.com' })

    expect(
      match(book, {
        name: 'Sam Wu',
        phone: '0400 000 000',
        email: 'noemail@noemail.com',
      }),
    ).toEqual({ candidates: [], shared: [], complete: true })
    // The name alone is still the name, and no more.
    expect(
      match(book, { name: 'John Citizen', phone: '0400000000' }).candidates.map(
        (c) => c.tier,
      ),
    ).toEqual(['maybe'])
  })

  test('an area code written apart from its number: two numbers stay two', () => {
    const { book, add } = newBook()
    // In a Sydney business: Jane's is a Perth number, Tom's a Sydney one.
    add('Jane Nguyen', { phone: '08/9345 6789' })
    const tom = add('Tom Lee', { phone: '(02) 9345 6789' })

    const index = buildMatchIndex(book, { areaCode: '02', ours: NO_OURS })
    const result = matchNewClient(index, {
      name: 'Tom Lee',
      phone: '9345 6789',
    })
    expect(result.shared).toEqual([])
    expect(result.candidates.map(brief)).toEqual([
      { clientId: tom.clientId, tier: 'same', evidence: ['name', 'landline'] },
    ])
  })

  test('the office’s own number on a client: nothing', () => {
    const { book, add } = newBook()
    const gave = add('Gave no number', { phone: '08 9272 0000' })
    const office = oursFor({
      business: { phone: '(08) 9272 0000' },
      seesTeam: false,
    })

    const typed = { name: 'Sam Wu', phone: '(08) 9272 0000' }
    expect(match(book, typed, office)).toEqual({
      candidates: [],
      shared: [],
      complete: true,
    })
    // Without it, the number reads as the client's own landline.
    expect(match(book, typed).shared.map((row) => row.clientIds)).toEqual([
      [gave.clientId],
    ])
  })

  test('(02) and (08) numbers with the same last eight digits: only the (08) one', () => {
    const { book, add } = newBook()
    add('Sydney Office', { phone: '(02) 9345 6789' })
    const perth = add('Perth Office', { phone: '(08) 9345 6789' })

    expect(
      match(book, {
        name: 'Perth Office',
        phone: '9345 6789',
      }).candidates.map(brief),
    ).toEqual([
      {
        clientId: perth.clientId,
        tier: 'same',
        evidence: ['name', 'landline'],
      },
    ])
  })
})

describe('who holds a number or an email', () => {
  test('a site contact’s number is never counted as anyone’s', () => {
    const { book, add } = newBook()
    const jane = add('Jane Nguyen', { phone: '0412 345 678' })
    add('Ray White Bayswater', {
      kind: 'business',
      sites: [
        {
          addressLine: '12 Wattle St',
          siteContactName: 'Pat Tenant',
          siteContactPhone: '0412 345 678',
        },
      ],
    })

    // Jane alone holds it: a mobile, not a shared one.
    const result = match(book, { name: 'Sam Wu', phone: '0412 345 678' })
    expect(result.candidates.map(brief)).toEqual([
      { clientId: jane.clientId, tier: 'likely', evidence: ['mobile'] },
    ])
    expect(result.shared).toEqual([])
  })

  test('a site contact’s number and name: Likely, a suggestion on the site', () => {
    const { book, add } = newBook()
    const ray = add('Ray White Bayswater', {
      kind: 'business',
      sites: [
        {
          addressLine: '12 Wattle St',
          siteContactName: 'Tom Lee',
          siteContactPhone: '0491 570 110',
        },
      ],
    })

    const [row] = match(book, {
      name: 'Tom Lee',
      phone: '0491570110',
    }).candidates
    expect(brief(row)).toEqual({
      clientId: ray.clientId,
      tier: 'likely',
      evidence: ['siteContact'],
    })
    expect(row.siteContactSiteIds).toEqual(ray.siteIds)
    // Another name with that number is nothing.
    expect(match(book, { name: 'Sam Wu', phone: '0491570110' })).toEqual({
      candidates: [],
      shared: [],
      complete: true,
    })
  })

  test('a person client’s contacts are not counted, a business client’s are', () => {
    const { book, add } = newBook()
    add('Jane Nguyen', { contacts: [{ name: 'Tom Nguyen', phone: SARAH }] })
    expect(
      match(book, { name: 'Tom Nguyen', phone: SARAH }).candidates,
    ).toEqual([])

    const ray = agency(add)
    expect(
      match(book, { name: 'Sarah Lee', phone: SARAH }).candidates.map(
        (c) => c.clientId,
      ),
    ).toEqual([ray.clientId])
  })

  test('the business’s and the team’s fields are left out, a contact’s too', () => {
    const { book, add } = newBook()
    add('Owner’s mate', {
      phone: '0412 000 111',
      email: 'terence@pestm8.test',
    })
    add('Agency', {
      kind: 'business',
      contacts: [{ name: 'Office', phone: '0412 000 111' }],
    })
    const owner = oursFor({
      self: { phone: '0412 000 111', email: 'Terence@PestM8.test' },
      seesTeam: false,
    })

    expect(
      match(
        book,
        {
          name: 'Terence',
          phone: '0412 000 111',
          email: 'terence@pestm8.test',
        },
        owner,
      ),
    ).toEqual({ candidates: [], shared: [], complete: true })
  })

  test('a landline with the name agreeing is Same; a business’s line with its own name is too', () => {
    const { book, add } = newBook()
    const tom = add('Tom Lee', { phone: '08 9272 5555' })
    const ray = agency(add)

    expect(
      match(book, { name: 'Tom Lee', phone: '08 9272 5555' }).candidates.map(
        brief,
      ),
    ).toEqual([
      { clientId: tom.clientId, tier: 'same', evidence: ['name', 'landline'] },
    ])
    expect(
      match(book, {
        name: 'Ray White Bayswater',
        phone: OFFICE,
      }).candidates.map(brief),
    ).toEqual([
      { clientId: ray.clientId, tier: 'same', evidence: ['name', 'landline'] },
    ])
    // A shorter name for the business is similar.
    expect(
      match(book, { name: 'Ray White', phone: OFFICE }).candidates.map(brief),
    ).toEqual([
      {
        clientId: ray.clientId,
        tier: 'same',
        evidence: ['nameNear', 'landline'],
      },
    ])
  })

  test('a line number is always shared, even on one client', () => {
    const { book, add } = newBook()
    const bunnings = add('Bunnings Morley', {
      kind: 'business',
      phone: '1300 123 456',
    })

    const result = match(book, { name: 'Bunnings Morley', phone: '1300123456' })
    expect(result.candidates.map(brief)).toEqual([
      {
        clientId: bunnings.clientId,
        tier: 'likely',
        evidence: ['name', 'shared'],
      },
    ])
    expect(result.shared).toEqual([
      {
        keys: [{ field: 'phone', key: 'line:1300123456', reason: 'line' }],
        clientIds: [bunnings.clientId],
        businessClientId: bunnings.clientId,
      },
    ])
  })

  test('a placeholder or a name on three clients gives no name evidence beside a number', () => {
    const { book, add } = newBook()
    const smith = add('John Smith', { phone: '0412 111 111' })
    add('John Smith')
    add('John Smith')
    const owner = add('The Owner', { phone: '0412 222 222' })

    expect(
      match(book, { name: 'John Smith', phone: '0412 111 111' }).candidates.map(
        brief,
      ),
    ).toEqual([
      { clientId: smith.clientId, tier: 'likely', evidence: ['mobile'] },
    ])
    expect(
      match(book, { name: 'The Owner', phone: '0412 222 222' }).candidates.map(
        brief,
      ),
    ).toEqual([
      { clientId: owner.clientId, tier: 'likely', evidence: ['mobile'] },
    ])
  })

  test('one row per set of holders', () => {
    const { book, add } = newBook()
    const a = add('Ann Bell', { phone: OFFICE, email: RENTALS })
    const b = add('Ben Cole', { phone: OFFICE, email: RENTALS })
    const c = add('Cat Dunn', { email: RENTALS })

    const result = match(book, {
      name: 'Tom Lee',
      phone: OFFICE,
      email: RENTALS,
    })
    expect(result.shared.map((row) => row.clientIds)).toEqual([
      [a.clientId, b.clientId],
      [a.clientId, b.clientId, c.clientId],
    ])
  })
})

describe('the business’s and the team’s own numbers', () => {
  const business = {
    phone: '(08) 9272 0000',
    email: 'office@coastal.test',
    reportCopyEmail: 'copies@coastal.test',
  }
  const owner = { phone: '0412 000 111', email: 'terence@coastal.test' }
  const kevin = { phone: '0433 222 333', email: 'kevin@coastal.test' }
  /** The roster as the owner's phone holds it: every member's details. */
  const roster: NonNullable<OursReader['team']> = [
    { ...owner, status: 'active' },
    { phone: '0433 444 555', email: 'jo.private@gmail.test', status: 'active' },
    { ...kevin, status: 'active' },
    // Someone who has left: their number is nobody's in particular now.
    { phone: '0499 000 999', email: 'former@coastal.test', status: 'removed' },
    { phone: '0499 000 888', email: 'invited@coastal.test', status: 'invited' },
  ]

  test('someone who manages the team leaves out the business’s and every active member’s', () => {
    expect(
      oursFor({ business, self: owner, seesTeam: true, team: roster }),
    ).toEqual({
      phones: [
        '(08) 9272 0000',
        '0412 000 111',
        '0412 000 111',
        '0433 444 555',
        '0433 222 333',
      ],
      emails: [
        'office@coastal.test',
        'copies@coastal.test',
        'terence@coastal.test',
        'terence@coastal.test',
        'jo.private@gmail.test',
        'kevin@coastal.test',
      ],
    })
  })

  test('anyone else’s never include another member’s, even with a whole roster passed', () => {
    const forKevin = oursFor({
      business,
      self: kevin,
      seesTeam: false,
      team: roster,
    })
    expect(forKevin).toEqual({
      phones: ['(08) 9272 0000', '0433 222 333'],
      emails: [
        'office@coastal.test',
        'copies@coastal.test',
        'kevin@coastal.test',
      ],
    })
    const others = roster.filter((m) => m.email !== kevin.email)
    for (const member of others) {
      expect(forKevin.phones).not.toContain(member.phone)
      expect(forKevin.emails).not.toContain(member.email)
    }
    // Nor with a phone that holds nothing yet.
    expect(oursFor({ seesTeam: false })).toEqual(NO_OURS)
    expect(
      oursFor({ business: null, self: null, seesTeam: true, team: null }),
    ).toEqual(NO_OURS)
  })

  test('a field is marked however the number or email was written', () => {
    const ours = oursKeys(
      oursFor({ business, self: owner, seesTeam: true, team: roster }),
      '08',
    )
    const marks = (row: { phone?: string; email?: string }) =>
      oursFields(ours, row, '08')

    expect(marks({ phone: '0412 345 678', email: 'jane@example.com' })).toBe(
      undefined,
    )
    // The office's landline without its area code, as typed in Perth.
    expect(marks({ phone: '9272 0000' })).toEqual(['phone'])
    expect(
      marks({ phone: '+61 412 000 111', email: 'Terence@Coastal.test' }),
    ).toEqual(['phone', 'email'])
    expect(marks({ email: 'copies@coastal.test' })).toEqual(['email'])
    // One of two numbers is enough to leave the field out whole.
    expect(marks({ phone: '0412 999 888 / 08 9272 0000' })).toEqual(['phone'])
    // The same digits in another state are someone else's.
    expect(marks({ phone: '(02) 9272 0000' })).toBe(undefined)
    expect(marks({ phone: '0499 000 999', email: 'former@coastal.test' })).toBe(
      undefined,
    )
  })

  test('on a subcontractor’s phone another member’s number counts as the client’s; on a manager’s it is left out', () => {
    const { book, add } = newBook()
    const cousin = add('Jo’s cousin', { phone: '0433 444 555' })
    const typed = { name: 'Sam Wu', phone: '0433444555' }

    const forKevin = oursFor({
      business,
      self: kevin,
      seesTeam: false,
      team: roster,
    })
    expect(match(book, typed, forKevin).candidates.map(brief)).toEqual([
      { clientId: cousin.clientId, tier: 'likely', evidence: ['mobile'] },
    ])
    const forOwner = oursFor({
      business,
      self: owner,
      seesTeam: true,
      team: roster,
    })
    expect(match(book, typed, forOwner)).toEqual({
      candidates: [],
      shared: [],
      complete: true,
    })
  })
})

describe('tiers and order', () => {
  test('a name alone is Maybe, and only when nothing stronger turned up', () => {
    const { book, add } = newBook()
    const first = add('Jane Nguyen', { sites: ['1 Elm St'] })
    const second = add('Jane Nguyen', { sites: ['2 Elm St'] })

    expect(match(book, { name: 'Jane Nguyen' }).candidates.map(brief)).toEqual([
      { clientId: first.clientId, tier: 'maybe', evidence: ['name'] },
      { clientId: second.clientId, tier: 'maybe', evidence: ['name'] },
    ])
    expect(
      match(book, {
        name: 'Jane Nguyen',
        site: at('2 Elm St'),
      }).candidates.map(brief),
    ).toEqual([
      { clientId: second.clientId, tier: 'same', evidence: ['name', 'site'] },
    ])
  })

  test('the name with the street in that postcode, another suburb: Likely', () => {
    const { book, add } = newBook()
    const jane = add('Jane Nguyen', {
      sites: [{ addressLine: '12 Wattle St', suburb: 'Bayswater' }],
    })

    const [row] = match(book, {
      name: 'Jane Nguyen',
      site: at('12 Wattle St', 'Embleton'),
    }).candidates
    expect(brief(row)).toEqual({
      clientId: jane.clientId,
      tier: 'likely',
      evidence: ['name', 'street'],
    })
    expect(row.streetSiteIds).toEqual(jane.siteIds)
  })

  test('Same, then Likely; then more evidence; then the newest booking; then client id', () => {
    const { book, add } = newBook()
    const site = add('Ann Bell', { sites: ['12 Wattle St'] })
    const mobile = add('Ben Cole', { phone: '0412 345 678' })
    const same = add('Jane Nguyen', { email: 'jane@example.com' })
    const both = add('Cat Dunn', {
      phone: '0499 888 777',
      sites: ['12 Wattle St'],
    })
    const typed = {
      name: 'Jane Nguyen',
      phone: '0412 345 678 / 0499 888 777',
      email: 'jane@example.com',
      site: at('12 Wattle St'),
    }

    const index = buildMatchIndex(book, PERTH)
    expect(
      matchNewClient(index, typed).candidates.map((c) => c.clientId),
    ).toEqual([same.clientId, both.clientId, site.clientId, mobile.clientId])
    // Ben was booked last week, Ann never: Ben first among equals.
    const lastBookedAt = new Map([[mobile.clientId, 1_700_000_000_000]])
    expect(
      matchNewClient(index, typed, { lastBookedAt }).candidates.map(
        (c) => c.clientId,
      ),
    ).toEqual([same.clientId, both.clientId, mobile.clientId, site.clientId])
  })

  test('the same book in any order gives the same answer', () => {
    const { book, add } = newBook()
    agency(add)
    add('Jane Nguyen', { phone: '0412 345 678', sites: ['3 Elm St'] })
    add('Tom Nguyen', { phone: '0412 345 678', sites: ['12 Wattle St'] })
    add('Mr & Mrs J Nguyen', { email: 'nguyen@example.com' })
    add('Ann Bell', { phone: OFFICE })
    const typed = {
      name: 'Jane Nguyen',
      phone: `0412 345 678 / ${OFFICE} / ${SARAH}`,
      email: 'nguyen@example.com',
      site: at('12 Wattle St'),
    }

    const reversed: Book = {
      clients: [...book.clients].reverse(),
      sites: [...book.sites].reverse(),
      contacts: [...book.contacts].reverse(),
    }
    const one = match(book, typed)
    expect(one.candidates.length).toBeGreaterThan(2)
    expect(match(reversed, typed)).toEqual(one)
  })

  test('at most three rows shown, the rest counted', () => {
    expect(MATCH_ROWS_MAX).toBe(3)
    expect(shownRows(['a', 'b', 'c', 'd', 'e'])).toEqual({
      shown: ['a', 'b', 'c'],
      more: 2,
    })
    expect(shownRows(['a'])).toEqual({ shown: ['a'], more: 0 })
  })

  test('a copy kept before emails and contacts were sent: no email evidence, and nothing above Likely', () => {
    const { book, add } = newBook()
    const jane = add('Jane Nguyen', {
      phone: '0412 345 678',
      email: 'jane@example.com',
    })
    const old: MatchDirectory = { clients: book.clients, sites: book.sites }

    const index = buildMatchIndex(old, PERTH)
    expect(index.complete).toBe(false)
    expect(
      matchNewClient(index, {
        name: 'Sam Wu',
        email: 'jane@example.com',
      }).candidates,
    ).toEqual([])
    const typed = { name: 'Jane Nguyen', phone: '0412 345 678' }
    const [row] = matchNewClient(index, typed).candidates
    expect(brief(row)).toEqual({
      clientId: jane.clientId,
      tier: 'likely',
      evidence: ['name', 'mobile'],
    })
    expect(autoRule(index, row, typed)).toBe(false)
    // As the server reads it, the same is Same.
    expect(match(book, typed).candidates[0].tier).toBe('same')
  })

  test('archived and inactive clients are still found', () => {
    const { book, add } = newBook()
    const archived = add('Jane Nguyen', {
      phone: '0412 345 678',
      archivedAt: 1,
    })
    const inactive = add('Tom Lee', {
      phone: '0491 570 110',
      status: 'inactive',
    })

    expect(
      match(book, { name: 'Jane Nguyen', phone: '0412345678' }).candidates.map(
        (c) => c.clientId,
      ),
    ).toEqual([archived.clientId])
    expect(
      match(book, { name: 'Tom Lee', phone: '0491570110' }).candidates.map(
        (c) => c.clientId,
      ),
    ).toEqual([inactive.clientId])
  })

  test('one index per directory answer, and per set of numbers left out', () => {
    const { book, add } = newBook()
    add('Jane Nguyen', { phone: '0412 000 111' })
    const index = matchIndexFor(book, PERTH)
    expect(matchIndexFor(book, PERTH)).toBe(index)
    expect(matchIndexFor({ ...book }, PERTH)).not.toBe(index)
    expect(
      matchIndexFor(book, { areaCode: '02', ours: NO_OURS }).areaCode,
    ).toBe('02')

    // The roster arriving, or changing, builds a new one; the same numbers
    // in another order or form are the same.
    const ours = { phones: ['0412 000 111', '9272 0000'], emails: [] }
    const left = matchIndexFor(book, { ...PERTH, ours })
    expect(left.phones.has('0412000111')).toBe(false)
    expect(
      matchIndexFor(book, {
        ...PERTH,
        ours: { phones: ['(08) 9272 0000', '+61 412 000 111'], emails: [] },
      }),
    ).toBe(left)
    expect(matchIndexFor(book, PERTH).phones.has('0412000111')).toBe(true)
  })
})

describe('New site for a chosen client', () => {
  test('the client already has the address: Same; another client holding it is not a match', () => {
    const { book, add } = newBook()
    const jane = add('Jane Nguyen', { sites: ['12 Wattle Street'] })
    const ray = agency(add)
    const index = buildMatchIndex(book, PERTH)

    expect(
      matchNewSite(index, jane.clientId, at('12 wattle st')).candidates.map(
        brief,
      ),
    ).toEqual([{ clientId: jane.clientId, tier: 'same', evidence: ['site'] }])
    // Ray White's 14 Wattle St is nothing to Jane.
    expect(
      matchNewSite(index, jane.clientId, at('14 Wattle St')).candidates,
    ).toEqual([])
    expect(
      matchNewSite(index, ray.clientId, at('12 Watle St')).candidates.map(
        brief,
      ),
    ).toEqual([
      { clientId: ray.clientId, tier: 'likely', evidence: ['addressNear'] },
    ])
  })

  test('another street type, or a Lot or Shop number, is another site', () => {
    const { book, add } = newBook()
    const ray = add('Ray White Bayswater', {
      kind: 'business',
      sites: ['12 Wattle St', 'Shop 3, 12 Ocean Pde', 'Lot 5 Smith Rd'],
    })
    const index = buildMatchIndex(book, PERTH)
    for (const typed of [
      '12 Wattle Ct',
      '12 Wattle Pl',
      '3 Ocean Pde',
      '12 Ocean Pde',
      '5 Smith Rd',
    ]) {
      expect(
        matchNewSite(index, ray.clientId, at(typed)).candidates,
        typed,
      ).toEqual([])
    }
  })
})

describe('the automatic rule, for a booking sent later', () => {
  function rule(
    book: MatchDirectory,
    typed: TypedClient,
    opts?: Parameters<typeof autoRule>[3],
  ) {
    const index = buildMatchIndex(book, PERTH)
    const row = matchNewClient(index, typed).candidates.at(0)
    if (!row) throw new Error('nothing matched')
    return { row, auto: autoRule(index, row, typed, opts) }
  }

  test('the exact name and her own mobile, or the exact name and address: moved', () => {
    const { book, add } = newBook()
    add('Jane Nguyen', { phone: '0412 345 678', sites: ['12 Wattle St'] })
    expect(rule(book, { name: 'Jane Nguyen', phone: '0412345678' }).auto).toBe(
      true,
    )
    expect(
      rule(book, { name: 'jane nguyen', site: at('12 Wattle Street') }).auto,
    ).toBe(true)
    // A lead is still served.
    book.clients[0].status = 'lead'
    expect(rule(book, { name: 'Jane Nguyen', phone: '0412345678' }).auto).toBe(
      true,
    )
  })

  test('(a) the street in another suburb only: not moved', () => {
    const { book, add } = newBook()
    add('Jane Nguyen', { sites: ['12 Wattle St'] })
    const { row, auto } = rule(book, {
      name: 'Jane Nguyen',
      phone: '0499 888 777',
      site: at('12 Wattle St', 'Embleton'),
    })
    expect(row.evidence).toEqual(['name', 'street'])
    expect(auto).toBe(false)
  })

  test('(b) a placeholder, a one-word or a shared name: not moved', () => {
    const owner = newBook()
    owner.add('The Owner', { sites: ['12 Wattle St'] })
    expect(
      rule(owner.book, { name: 'The Owner', site: at('12 Wattle St') }).auto,
    ).toBe(false)

    const oneWord = newBook()
    oneWord.add('Bunnings', { kind: 'business', phone: '0412 345 678' })
    const one = rule(oneWord.book, { name: 'Bunnings', phone: '0412345678' })
    expect(one.row.tier).toBe('same')
    expect(one.auto).toBe(false)

    const twice = newBook()
    twice.add('Jane Nguyen', { sites: ['12 Wattle St'] })
    twice.add('Jane Nguyen', { sites: ['3 Elm St'] })
    const shared = rule(twice.book, {
      name: 'Jane Nguyen',
      site: at('12 Wattle St'),
    })
    expect(shared.row.tier).toBe('same')
    expect(shared.auto).toBe(false)
  })

  test('(b) a title and a surname is a one-word name: not moved', () => {
    const { book, add } = newBook()
    add('Mrs Smith', { phone: '0412 555 666', sites: ['5 Elm St'] })
    add('Mr & Mrs Brown', { sites: ['7 Elm St'] })
    add('Dr Lee', { email: 'drlee@example.com' })

    for (const typed of [
      { name: 'Mrs Smith', site: at('5 Elm St') },
      { name: 'Mrs Smith', phone: '0412 555 666' },
      { name: 'Mr & Mrs Brown', site: at('7 Elm St') },
      { name: 'Dr Lee', email: 'drlee@example.com' },
    ]) {
      const { row, auto } = rule(book, typed)
      // Still the same customer to a person looking at the sheet.
      expect(row.tier, typed.name).toBe('same')
      expect(auto, typed.name).toBe(false)
    }
    // Two words of name, with a title too: moved.
    add('Mrs Jane Smith', { phone: '0412 777 888' })
    expect(
      rule(book, { name: 'Mrs Jane Smith', phone: '0412 777 888' }).auto,
    ).toBe(true)
  })

  test('(c) an inactive or archived client: not moved', () => {
    const inactive = newBook()
    inactive.add('Jane Nguyen', {
      phone: '0412 345 678',
      status: 'inactive',
    })
    expect(
      rule(inactive.book, { name: 'Jane Nguyen', phone: '0412345678' }).auto,
    ).toBe(false)

    const archived = newBook()
    archived.add('Jane Nguyen', { phone: '0412 345 678', archivedAt: 1 })
    expect(
      rule(archived.book, { name: 'Jane Nguyen', phone: '0412345678' }).auto,
    ).toBe(false)
  })

  test('(d) a number two clients hold: not moved', () => {
    const { book, add } = newBook()
    add('Jane Nguyen', { phone: '0412 345 678' })
    add('Tom Nguyen', { phone: '0412 345 678' })
    const { row, auto } = rule(book, {
      name: 'Jane Nguyen',
      phone: '0412345678',
    })
    expect(row.evidence).toEqual(['name', 'shared'])
    expect(auto).toBe(false)
  })

  test('a landline, a contact person’s name, or a similar name is not enough', () => {
    const landline = newBook()
    landline.add('Tom Lee', { phone: '08 9272 5555' })
    const byLandline = rule(landline.book, {
      name: 'Tom Lee',
      phone: '08 9272 5555',
    })
    expect(byLandline.row.tier).toBe('same')
    expect(byLandline.auto).toBe(false)

    const contact = newBook()
    agency(contact.add)
    const byContact = rule(contact.book, { name: 'Sarah Lee', phone: SARAH })
    expect(byContact.row.tier).toBe('same')
    expect(byContact.auto).toBe(false)

    const near = newBook()
    near.add('Mr & Mrs J Nguyen', { phone: '0412 345 678' })
    expect(
      rule(near.book, { name: 'Jane Nguyen', phone: '0412345678' }).auto,
    ).toBe(false)
  })

  test('not one booked past, nor the one this resend was moved onto', () => {
    const { book, add } = newBook()
    const jane = add('Jane Nguyen', { phone: '0412 345 678' })
    const typed = { name: 'Jane Nguyen', phone: '0412345678' }
    expect(rule(book, typed, { dismissed: [jane.clientId] }).auto).toBe(false)
    expect(rule(book, typed, { applied: jane.clientId }).auto).toBe(false)
  })

  test('New site for a client: its own site at the exact address, and nothing like it', () => {
    const { book, add } = newBook()
    const jane = add('Jane Nguyen', { sites: ['12 Wattle St'] })
    const index = buildMatchIndex(book, PERTH)

    const [exact] = matchNewSite(
      index,
      jane.clientId,
      at('12 Wattle Street'),
    ).candidates
    expect(exact.siteIds).toEqual(jane.siteIds)
    expect(autoRule(index, exact, {}, { mode: 'site' })).toBe(true)
    expect(
      autoRule(index, exact, {}, { mode: 'site', dismissed: [jane.clientId] }),
    ).toBe(false)

    const [near] = matchNewSite(
      index,
      jane.clientId,
      at('12 Watle St'),
    ).candidates
    expect(autoRule(index, near, {}, { mode: 'site' })).toBe(false)
  })
})
