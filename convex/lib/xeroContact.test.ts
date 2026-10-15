import { describe, expect, test } from 'vitest'
import {
  CONTACT_PERSONS_ON_MATCHED,
  FIELD_KEYS,
  MAX_CONTACT_PERSONS,
  XERO_CLEARS_WITH_EMPTY,
  buildUpdateBatch,
  diff,
  eligibility,
  fieldHash,
  fieldHashes,
  fieldProblems,
  fieldsFromXero,
  isBlank,
  nextHashes,
  ownedFields,
  payloadProblems,
  sanitiseName,
  splitPersonName,
  suffixNames,
  toXeroCreate,
  toXeroUpdate,
} from './xeroContact'
import type { Doc, Id } from '../_generated/dataModel'
import type {
  ContactInput,
  FieldKey,
  Fields,
  LinkHashes,
  LinkLike,
} from './xeroContact'
import type { XeroContactFull } from './xeroHttp'

const CONTACT_ID = '6d3c1b2a-0000-4000-8000-000000000001'

function client(over: Partial<Doc<'clients'>> = {}): Doc<'clients'> {
  return {
    _id: 'client1' as Id<'clients'>,
    _creationTime: 0,
    businessId: 'business1' as Id<'businesses'>,
    kind: 'person',
    name: 'John Smith',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

function input(
  clientOver: Partial<Doc<'clients'>> = {},
  over: Partial<ContactInput> = {},
): ContactInput {
  return {
    client: client(clientOver),
    primary: null,
    others: [],
    oldestSite: null,
    businessState: 'WA',
    ...over,
  }
}

const SITE = {
  addressLine: '12 Casuarina Drive',
  suburb: 'Nightcliff',
  state: 'NT',
  postcode: '0810',
}

/** A contact as Xero would hold it: four phones (most empty), a blank PO box
 * before the street address, as `GET /Contacts` really sends them. */
function xeroContact(over: Partial<XeroContactFull> = {}): XeroContactFull {
  return {
    ContactID: CONTACT_ID,
    Name: 'John Smith',
    ContactStatus: 'ACTIVE',
    EmailAddress: '',
    Phones: [
      { PhoneType: 'DDI', PhoneNumber: '', PhoneAreaCode: '' },
      { PhoneType: 'DEFAULT', PhoneNumber: '', PhoneAreaCode: '' },
      { PhoneType: 'FAX', PhoneNumber: '', PhoneAreaCode: '' },
      { PhoneType: 'MOBILE', PhoneNumber: '', PhoneAreaCode: '' },
    ],
    Addresses: [
      { AddressType: 'POBOX', City: '', Region: '', PostalCode: '' },
      { AddressType: 'STREET', City: '', Region: '', PostalCode: '' },
    ],
    ContactPersons: [],
    ...over,
  }
}

const link = (over: Partial<LinkLike> = {}): LinkLike => ({
  state: 'linked',
  xeroContactId: CONTACT_ID,
  how: 'matched',
  ...over,
})

describe('the constants the Demo Company gate decides', () => {
  test('start conservative: no people on matched contacts, "" never sent', () => {
    expect(CONTACT_PERSONS_ON_MATCHED).toBe(false)
    expect(XERO_CLEARS_WITH_EMPTY).toBe(false)
    expect(MAX_CONTACT_PERSONS).toBe(5)
  })
})

describe('eligibility', () => {
  test('a client that is gone, binned or archived is never sent', () => {
    expect(eligibility(null, link())).toBe('gone')
    expect(eligibility(input({ deletedAt: 1 }), link())).toBe('binned')
    expect(eligibility(input({ archivedAt: 1 }), link())).toBe('archived')
  })

  test('the bin wins over anything Xero says', () => {
    expect(eligibility(input({ deletedAt: 1 }), link({ state: 'gdpr' }))).toBe(
      'binned',
    )
  })

  test('archived in Xero or a GDPR request stops it', () => {
    expect(eligibility(input(), link({ state: 'archived_in_xero' }))).toBe(
      'stopped',
    )
    expect(eligibility(input(), link({ state: 'gdpr' }))).toBe('stopped')
  })

  test('a question for the holder waits on them', () => {
    const review: LinkLike = { state: 'needs_review' }
    expect(eligibility(input(), review)).toBe('review')
    expect(eligibility(input({ status: 'lead' }), review)).toBe('review')
  })

  test('a linked client is updated, even once it is a lead again', () => {
    expect(eligibility(input(), link())).toBe('update')
    expect(eligibility(input({ status: 'lead' }), link())).toBe('update')
    expect(eligibility(input({ status: 'inactive' }), link())).toBe('update')
  })

  test('a failed update is an update; a failed create is a create', () => {
    expect(eligibility(input(), link({ state: 'failed' }))).toBe('update')
    expect(
      eligibility(input(), { state: 'failed', xeroContactId: undefined }),
    ).toBe('create')
  })

  test('a lead with no contact waits for its first booking', () => {
    for (const row of [null, { state: 'new' }, { state: 'separate' }]) {
      expect(
        eligibility(input({ status: 'lead' }), row as LinkLike | null),
      ).toBe('lead')
    }
  })

  test('anyone else with no contact yet is created, inactive included', () => {
    for (const status of [undefined, 'active', 'inactive'] as const) {
      expect(eligibility(input({ status }), null)).toBe('create')
      expect(eligibility(input({ status }), { state: 'new' })).toBe('create')
      expect(eligibility(input({ status }), { state: 'separate' })).toBe(
        'create',
      )
    }
  })
})

describe('sanitiseName', () => {
  test('trims, collapses spaces, takes out markup and control characters', () => {
    expect(sanitiseName('  John\t  Smith \n')).toBe('John Smith')
    expect(sanitiseName('Acme <b>Pest</b> Co')).toBe('Acme b Pest /b Co')
    expect(sanitiseName('Zero​Width\u0007Bell')).toBe('ZeroWidth Bell')
  })

  test('at most 230 characters, leaving room for a suffix', () => {
    expect(sanitiseName('a'.repeat(400))).toHaveLength(230)
    expect(sanitiseName(`${'b '.repeat(116)}cc`)).toHaveLength(229)
  })

  test('never cuts a character in half', () => {
    const name = `${'a'.repeat(229)}😀`
    const out = sanitiseName(name)
    expect(out).toBe('a'.repeat(229))
    expect(() => encodeURIComponent(out)).not.toThrow()
  })

  test('nothing left is nothing', () => {
    expect(sanitiseName(' <> ')).toBe('')
  })
})

describe('splitPersonName', () => {
  test.each([
    ['John Smith', { first: 'John', last: 'Smith' }],
    ['Mary Jane  Watson', { first: 'Mary Jane', last: 'Watson' }],
    ['Madonna', { first: 'Madonna' }],
    ['  ', { first: '' }],
    ['Jan van der Berg', { first: 'Jan van der', last: 'Berg' }],
  ])('%j → %j', (name, split) => {
    expect(splitPersonName(name)).toEqual(split)
  })
})

describe('suffixNames', () => {
  test('the suburb, then the client number', () => {
    expect(suffixNames('John Smith', 'Nightcliff', 1916)).toEqual([
      'John Smith (Nightcliff)',
      'John Smith #1916',
    ])
  })

  test('a suburb in capitals or lower case reads in title case', () => {
    expect(suffixNames('John Smith', 'NIGHTCLIFF')[0]).toBe(
      'John Smith (Nightcliff)',
    )
    expect(suffixNames('A', 'mount lawley')[0]).toBe('A (Mount Lawley)')
    expect(suffixNames('A', "O'CONNOR")[0]).toBe("A (O'Connor)")
    expect(suffixNames('A', 'McKinnon')[0]).toBe('A (McKinnon)')
  })

  test('skips what there is nothing to go on for', () => {
    expect(suffixNames('John Smith', '  ', 7)).toEqual(['John Smith #7'])
    expect(suffixNames('John Smith', 'Nightcliff')).toEqual([
      'John Smith (Nightcliff)',
    ])
    expect(suffixNames('John Smith')).toEqual([])
    expect(suffixNames('John Smith', undefined, 1.5)).toEqual([])
  })

  test('the name is sanitised; brackets in a suburb are dropped', () => {
    expect(suffixNames(' <John>  Smith ', 'Ascot (WA)', 3)).toEqual([
      'John Smith (Ascot WA)',
      'John Smith #3',
    ])
  })

  test('fits 255 by cutting the name, never the suffix', () => {
    const [byPlace, byNumber] = suffixNames('x'.repeat(300), 'Y'.repeat(80), 42)
    expect(byPlace.length).toBeLessThanOrEqual(255)
    expect(byPlace.endsWith(` (Y${'y'.repeat(59)})`)).toBe(true)
    expect(byNumber).toBe(`${'x'.repeat(230)} #42`)
  })
})

describe('ownedFields', () => {
  const creating = { creating: true, xeroPoboxBlank: true }
  const updating = { creating: false, xeroPoboxBlank: false }

  test('a person: their name, email, mobile, oldest site and number', () => {
    const fields = ownedFields(
      input(
        {
          name: 'John  Smith',
          email: ' john@example.com ',
          phone: '0412345678',
          clientNumber: 1916,
        },
        { oldestSite: SITE },
      ),
      creating,
    )
    const site = {
      line1: '12 Casuarina Drive',
      city: 'Nightcliff',
      region: 'NT',
      postcode: '0810',
      country: 'Australia',
    }
    expect(fields).toEqual({
      name: 'John Smith',
      person: { first: 'John', last: 'Smith' },
      email: 'john@example.com',
      phoneDefault: '',
      phoneMobile: { areaCode: '', number: '0412 345 678' },
      street: site,
      pobox: site,
      accountNumber: '1916',
    })
    // A person has no ABN or people of its own in Xero.
    expect('taxNumber' in fields).toBe(false)
    expect('persons' in fields).toBe(false)
  })

  test('a person’s PO box only when creating or while Xero’s is blank', () => {
    const person = input({}, { oldestSite: SITE })
    expect('pobox' in ownedFields(person, updating)).toBe(false)
    expect(
      ownedFields(person, { creating: false, xeroPoboxBlank: true }).pobox,
    ).toMatchObject({ city: 'Nightcliff' })
    expect(ownedFields(person, updating).street).toMatchObject({
      city: 'Nightcliff',
    })
  })

  test('a person with no site has a blank street address', () => {
    const fields = ownedFields(input(), creating)
    expect(fields.street).toBe('')
    expect(fields.pobox).toBe('')
  })

  test.each([
    [
      '(08) 9123 4567',
      { phoneDefault: { areaCode: '08', number: '9123 4567' } },
    ],
    [
      '0291234567 ext 2',
      { phoneDefault: { areaCode: '02', number: '9123 4567 ext 2' } },
    ],
    [
      '+61 412 345 678',
      { phoneMobile: { areaCode: '', number: '0412 345 678' } },
    ],
    ['412345678', { phoneMobile: { areaCode: '', number: '0412 345 678' } }],
    [
      '+44 20 7946 0958',
      { phoneDefault: { areaCode: '', number: '+44 20 7946 0958' } },
    ],
    [
      '1300  123 456',
      { phoneDefault: { areaCode: '', number: '1300 123 456' } },
    ],
  ])('phone %j goes in its slot', (phone, slot) => {
    const fields = ownedFields(input({ phone }), creating)
    expect({
      phoneDefault: fields.phoneDefault,
      phoneMobile: fields.phoneMobile,
    }).toEqual({ phoneDefault: '', phoneMobile: '', ...slot })
  })

  test('a local number gets the business’s own area code', () => {
    const local = { phone: '9123 4567' }
    expect(ownedFields(input(local), creating).phoneDefault).toEqual({
      areaCode: '08',
      number: '9123 4567',
    })
    expect(
      ownedFields(input(local, { businessState: 'NSW' }), creating)
        .phoneDefault,
    ).toEqual({ areaCode: '02', number: '9123 4567' })
  })

  test('no phone: both slots PestM8’s, both blank', () => {
    const fields = ownedFields(input({ phone: '  ' }), creating)
    expect(fields.phoneDefault).toBe('')
    expect(fields.phoneMobile).toBe('')
  })

  const business = (over: Partial<Doc<'clients'>> = {}) =>
    input(
      {
        kind: 'business',
        name: 'Acme Property Pty Ltd',
        email: 'office@acme.com.au',
        abn: '51824753556',
        addressLine: 'Level 2, 100 St Georges Tce',
        suburb: 'Perth',
        state: 'WA',
        postcode: '6000',
        clientNumber: 42,
        ...over,
      },
      {
        primary: { name: 'Sue Brown', email: 'sue@acme.com.au' },
        others: [
          { name: 'Accounts Team', email: 'accounts@acme.com.au' },
          { name: 'Bob', email: undefined },
        ],
        oldestSite: SITE,
      },
    )

  test('a business: its head office, ABN, contact person and people', () => {
    const office = {
      line1: 'Level 2, 100 St Georges Tce',
      city: 'Perth',
      region: 'WA',
      postcode: '6000',
      country: 'Australia',
    }
    expect(ownedFields(business(), updating)).toEqual({
      name: 'Acme Property Pty Ltd',
      person: { first: 'Sue', last: 'Brown' },
      email: 'office@acme.com.au',
      phoneDefault: '',
      phoneMobile: '',
      pobox: office,
      street: office,
      taxNumber: '51 824 753 556',
      accountNumber: '42',
      persons: [
        { first: 'Accounts', last: 'Team', email: 'accounts@acme.com.au' },
        { first: 'Bob', last: '', email: '' },
      ],
    })
  })

  test('a business with no head office sends no address — never a site', () => {
    for (const office of [
      { addressLine: undefined, suburb: undefined, state: undefined },
      // An older edit form saved a State on its own: that is no address.
      { addressLine: ' ', suburb: '', state: 'WA', postcode: '6000' },
    ]) {
      const fields = ownedFields(business(office), creating)
      expect(fields.pobox).toBe('')
      expect(fields.street).toBe('')
    }
  })

  test('a business with no email uses its contact person’s', () => {
    expect(ownedFields(business({ email: undefined }), creating).email).toBe(
      'sue@acme.com.au',
    )
    // A person's email is their own or none.
    expect(
      ownedFields(
        input({}, { primary: { name: 'X', email: 'x@y.com' } }),
        creating,
      ).email,
    ).toBe('')
  })

  test('a business with no ABN or contact person: those are blank', () => {
    const fields = ownedFields(
      input({ kind: 'business', name: 'Acme' }, { primary: null }),
      creating,
    )
    expect(fields.taxNumber).toBe('')
    expect(fields.person).toBe('')
    expect(fields.persons).toEqual([])
  })

  test('every one of a business’s people is kept; the cap is the body’s', () => {
    const others = Array.from({ length: 7 }, (_, i) => ({
      name: `Person ${i + 1}`,
    }))
    const fields = ownedFields(
      input({ kind: 'business', name: 'Acme' }, { others }),
      creating,
    )
    expect(fields.persons).toHaveLength(7)
  })

  test('nameless people are dropped; an email Xero would refuse is left off', () => {
    const fields = ownedFields(
      input(
        { kind: 'business', name: 'Acme' },
        {
          others: [
            { name: '  ', email: 'nobody@acme.com' },
            { name: 'Jürgen Müller', email: 'jürgen@müller.de' },
          ],
        },
      ),
      creating,
    )
    expect(fields.persons).toEqual([
      { first: 'Jürgen', last: 'Müller', email: '' },
    ])
  })

  test('no client number: AccountNumber is not PestM8’s', () => {
    expect('accountNumber' in ownedFields(input(), creating)).toBe(false)
  })

  test('an email with non-ASCII letters is not PestM8’s, and says so', () => {
    const umlaut = input({ email: 'jürgen@example.com' })
    expect('email' in ownedFields(umlaut, creating)).toBe(false)
    expect(fieldProblems(umlaut)).toEqual(['email_not_ascii'])
    expect(fieldProblems(input({ email: 'john@example.com' }))).toEqual([])
  })

  test('a name with nothing left once sanitised is a problem', () => {
    expect(fieldProblems(input({ name: '<>' }))).toEqual(['name_invalid'])
  })
})

describe('fieldHash', () => {
  test('every blank hashes alike', () => {
    const blank = fieldHash('')
    for (const value of [
      undefined,
      null,
      '   ',
      [],
      {},
      { line1: '', city: '' },
      [{ first: '', last: '' }],
    ]) {
      expect(fieldHash(value)).toBe(blank)
    }
  })

  test('canonical: key order and blank members do not matter', () => {
    expect(fieldHash({ a: 'x', b: 'y' })).toBe(fieldHash({ b: 'y', a: 'x' }))
    expect(fieldHash({ a: 'x', b: '' })).toBe(fieldHash({ a: 'x' }))
    expect(fieldHash({ a: { c: '1', d: '' } })).toBe(
      fieldHash({ a: { c: '1' } }),
    )
  })

  test('a different value is a different hash; the same is the same', () => {
    expect(fieldHash('a@x.com')).toBe(fieldHash('a@x.com'))
    expect(fieldHash('a@x.com')).not.toBe(fieldHash('A@x.com'))
    expect(fieldHash('x')).not.toBe(fieldHash(''))
    expect(fieldHash([{ first: 'A' }, { first: 'B' }])).not.toBe(
      fieldHash([{ first: 'B' }, { first: 'A' }]),
    )
    expect(typeof fieldHash('x')).toBe('string')
  })

  test('fieldHashes hashes only the fields present', () => {
    expect(fieldHashes({ name: 'A', email: '' })).toEqual({
      name: fieldHash('A'),
      email: fieldHash(''),
    })
  })

  test('isBlank', () => {
    expect(isBlank(' ')).toBe(true)
    expect(isBlank({ number: '', areaCode: '' })).toBe(true)
    expect(isBlank({ number: '1' })).toBe(false)
    expect(isBlank(0)).toBe(false)
  })
})

describe('fieldsFromXero', () => {
  test('reads every field into the canonical shapes', () => {
    const fields = fieldsFromXero(
      xeroContact({
        Name: ' John  Smith ',
        FirstName: 'John',
        LastName: 'Smith',
        EmailAddress: 'john@example.com',
        TaxNumber: '51 824 753 556',
        AccountNumber: '1916',
        Phones: [
          { PhoneType: 'DDI', PhoneNumber: '9000 0000', PhoneAreaCode: '08' },
          {
            PhoneType: 'DEFAULT',
            PhoneNumber: '9123 4567',
            PhoneAreaCode: '08',
          },
          { PhoneType: 'FAX', PhoneNumber: '' },
          {
            PhoneType: 'MOBILE',
            PhoneNumber: '0412 345 678',
            PhoneAreaCode: '',
          },
        ],
        Addresses: [
          {
            AddressType: 'POBOX',
            AddressLine1: 'PO Box 1',
            City: 'Perth',
            Region: 'WA',
            PostalCode: '6000',
            Country: 'Australia',
          },
          { AddressType: 'STREET', Country: 'Australia' },
        ],
        ContactPersons: [
          { FirstName: 'Sue', LastName: 'Brown', EmailAddress: 'sue@x.com' },
          { FirstName: '', LastName: '' },
        ],
      }),
    )
    expect(fields).toEqual({
      name: 'John Smith',
      person: { first: 'John', last: 'Smith' },
      email: 'john@example.com',
      phoneDefault: { areaCode: '08', number: '9123 4567' },
      phoneMobile: { areaCode: '', number: '0412 345 678' },
      pobox: {
        line1: 'PO Box 1',
        line2: '',
        line3: '',
        line4: '',
        city: 'Perth',
        region: 'WA',
        postcode: '6000',
        country: 'Australia',
      },
      // A country on its own is not an address.
      street: '',
      taxNumber: '51 824 753 556',
      accountNumber: '1916',
      persons: [{ first: 'Sue', last: 'Brown', email: 'sue@x.com' }],
    })
  })

  test('an empty contact is every field blank', () => {
    const fields = fieldsFromXero(xeroContact({ Name: 'X' }))
    for (const key of FIELD_KEYS) {
      if (key !== 'name') expect(isBlank(fields[key])).toBe(true)
    }
  })

  test('a contact created from PestM8’s fields reads back as the same', () => {
    const ours = ownedFields(
      input(
        {
          kind: 'business',
          name: 'Acme',
          email: 'a@acme.com',
          phone: '08 9123 4567',
          abn: '51824753556',
          addressLine: '1 Hay St',
          suburb: 'Perth',
          state: 'WA',
          postcode: '6000',
          clientNumber: 9,
        },
        {
          primary: { name: 'Sue Brown' },
          others: [{ name: 'Bob Jones', email: 'bob@acme.com' }],
        },
      ),
      { creating: true, xeroPoboxBlank: true },
    )
    // What Xero would hold after the create: the body, as a contact.
    const body = toXeroCreate('Acme', ours) as Partial<XeroContactFull>
    const read = fieldsFromXero(xeroContact({ ...body, ContactID: CONTACT_ID }))
    for (const key of FIELD_KEYS) {
      expect([key, fieldHash(read[key])]).toEqual([key, fieldHash(ours[key])])
    }
  })
})

describe('diff', () => {
  const ours: Fields = {
    name: 'John Smith',
    email: 'john@new.com',
    phoneMobile: { areaCode: '', number: '0412 345 678' },
    phoneDefault: '',
    accountNumber: '1916',
  }

  test('creating sends everything PestM8 owns that has something in it', () => {
    const { send, different } = diff(ours, null, null)
    expect(send).toEqual({
      name: 'John Smith',
      email: 'john@new.com',
      phoneMobile: { areaCode: '', number: '0412 345 678' },
      accountNumber: '1916',
    })
    expect(different).toEqual([])
  })

  test('creating ignores anything a link holds from an earlier try', () => {
    const stale: LinkHashes = { sent: fieldHashes(ours), seen: {} }
    expect(Object.keys(diff(ours, stale, null).send)).toEqual([
      'name',
      'email',
      'phoneMobile',
      'accountNumber',
    ])
  })

  test('unchanged since last sent: nothing to send, so no call', () => {
    const xero: Fields = { ...ours, email: 'bookkeeper@x.com' }
    const settled: LinkHashes = {
      sent: fieldHashes(ours),
      seen: fieldHashes(xero),
    }
    expect(diff(ours, settled, xero)).toEqual({ send: {}, different: [] })
  })

  test('a matched contact with no record only has its blanks filled', () => {
    const xero: Fields = {
      name: 'J Smith',
      email: 'accounts@smith.com',
      phoneMobile: '',
      phoneDefault: { areaCode: '08', number: '9000 0000' },
      accountNumber: '',
    }
    const { send, different } = diff(ours, { how: 'matched' }, xero)
    // Linking never overwrites: Name and email stay the bookkeeper's.
    expect(send).toEqual({
      phoneMobile: ours.phoneMobile,
      accountNumber: '1916',
    })
    expect(different).toEqual([])
  })

  const before: Fields = { ...ours, email: 'john@old.com' }
  const sentBefore: LinkHashes = {
    how: 'created',
    sent: fieldHashes(before),
    seen: fieldHashes(before),
  }

  test('PestM8 changed it and Xero still holds what was seen: send', () => {
    expect(diff(ours, sentBefore, before)).toEqual({
      send: { email: 'john@new.com' },
      different: [],
    })
  })

  test('PestM8 changed it and Xero is blank there: send', () => {
    expect(diff(ours, sentBefore, { ...before, email: '' })).toEqual({
      send: { email: 'john@new.com' },
      different: [],
    })
  })

  test('PestM8 changed it, but so did Xero: left alone, reported', () => {
    const xero = { ...before, email: 'billing@smith.com' }
    expect(diff(ours, sentBefore, xero)).toEqual({
      send: {},
      different: ['email'],
    })
  })

  test('Xero already holds PestM8’s new value: nothing to send', () => {
    expect(
      diff(ours, sentBefore, { ...before, email: 'john@new.com' }),
    ).toEqual({ send: {}, different: [] })
  })

  test('PestM8 cleared it: never sent as ""; reported while Xero has one', () => {
    const cleared = { ...before, email: '' }
    expect(diff(cleared, sentBefore, before)).toEqual({
      send: {},
      different: ['email'],
    })
    expect(diff(cleared, sentBefore, { ...before, email: '' })).toEqual({
      send: {},
      different: [],
    })
  })

  test('AccountNumber only ever fills a blank on an update', () => {
    const renumbered = { ...before, accountNumber: '2000' }
    // Xero still holds what PestM8 sent, but the bookkeeper's numbering wins.
    expect(diff(renumbered, sentBefore, before).send).toEqual({})
    expect(diff(renumbered, sentBefore, before).different).toEqual([])
    expect(
      diff(renumbered, sentBefore, { ...before, accountNumber: ' ' }).send,
    ).toEqual({ accountNumber: '2000' })
  })

  const people = [{ first: 'Bob', last: 'Jones', email: 'bob@acme.com' }]
  const withPeople: Fields = { name: 'Acme', persons: people }

  test('people go only to a contact PestM8 created', () => {
    const xero: Fields = { name: 'Acme', persons: [] }
    expect(diff(withPeople, { how: 'matched' }, xero).send).toEqual({})
    expect(diff(withPeople, { how: 'chosen', sent: {} }, xero)).toEqual({
      send: {},
      different: [],
    })
    expect(diff(withPeople, { how: 'created' }, xero).send).toEqual({
      persons: people,
    })
  })

  test('a field PestM8 does not own is never compared', () => {
    const xero: Fields = { name: 'John Smith', pobox: { line1: 'PO Box 9' } }
    const result = diff({ name: 'John Smith' }, sentBefore, xero)
    expect(result).toEqual({ send: {}, different: [] })
  })

  test('a field missing from Xero’s side reads as blank', () => {
    expect(diff({ email: 'a@b.com' }, { sent: {} }, {}).send).toEqual({
      email: 'a@b.com',
    })
  })
})

describe('nextHashes', () => {
  test('after a create, every owned field is settled, blanks included', () => {
    const ours: Fields = { name: 'John Smith', email: '', accountNumber: '7' }
    const result = diff(ours, null, null)
    const answer: Fields = { name: 'John Smith (Nightcliff)', email: '' }
    expect(nextHashes(ours, null, result, answer)).toEqual({
      sent: fieldHashes(ours),
      seen: {
        name: fieldHash('John Smith (Nightcliff)'),
        email: fieldHash(''),
        accountNumber: fieldHash(''),
      },
    })
  })

  test('a different field keeps its record, so it stays different', () => {
    const before = { email: 'old@x.com' }
    const record: LinkHashes = {
      sent: fieldHashes(before),
      seen: fieldHashes(before),
    }
    const ours = { email: 'new@x.com' }
    const xero = { email: 'bookkeeper@x.com' }
    const result = diff(ours, record, xero)
    expect(result.different).toEqual(['email'])
    expect(nextHashes(ours, record, result, xero)).toEqual({
      sent: record.sent,
      seen: record.seen,
    })
  })

  test('a record of what was seen, with nothing on record as sent (a forced resync): a value the bookkeeper changed since is not taken as the baseline', () => {
    const record: LinkHashes = {
      seen: { email: fieldHash('old@x.com'), name: fieldHash('A') },
    }
    const ours = { email: 'old@x.com', name: 'A' }
    const xero = { email: 'accounts@x.com', name: 'A' }
    const result = diff(ours, record, xero)
    expect(result).toEqual({ send: {}, different: [] })
    const next = nextHashes(ours, record, result, xero)
    expect(next).toEqual({
      sent: { email: fieldHash('old@x.com'), name: fieldHash('A') },
      seen: { email: fieldHash('old@x.com'), name: fieldHash('A') },
    })
    // So PestM8's next change to it is Different, not sent over it.
    expect(
      diff({ email: 'new@x.com', name: 'A' }, next, xero).different,
    ).toEqual(['email'])
  })

  test('fields neither side changed keep their record', () => {
    const record: LinkHashes = {
      sent: { name: fieldHash('A'), email: fieldHash('a@x.com') },
      seen: { name: fieldHash('A'), email: fieldHash('A@X.COM') },
    }
    const ours = { name: 'A', email: 'a@x.com' }
    const xero = { name: 'A', email: 'A@X.COM' }
    expect(nextHashes(ours, record, diff(ours, record, xero), xero)).toEqual({
      sent: record.sent,
      seen: record.seen,
    })
  })

  /** One pass of the sync over one contact: compare, "send" (Xero takes
   * what is sent as is), and settle the record. */
  function pass(ours: Fields, record: LinkHashes, xero: Fields) {
    const result = diff(ours, record, xero)
    const after = { ...xero, ...result.send }
    const hashes = nextHashes(ours, record, result, after)
    return { result, after, record: { ...record, ...hashes } }
  }

  test('a matched contact: blanks filled, then PestM8’s later edits sent', () => {
    let xero: Fields = { name: 'Acme', email: 'accounts@acme.com', street: '' }
    let ours: Fields = {
      name: 'Acme',
      email: 'office@acme.com',
      street: { line1: '1 Hay St', city: 'Perth' },
    }
    let record: LinkHashes = { how: 'matched' }

    // The first look fills the blank street and settles the rest.
    let step = pass(ours, record, xero)
    expect(step.result).toEqual({
      send: { street: ours.street },
      different: [],
    })
    ;({ after: xero, record } = step)

    // Nothing changed: nothing sent.
    expect(pass(ours, record, xero).result).toEqual({ send: {}, different: [] })

    // PestM8's email changes, and Xero still has what it had at the link.
    ours = { ...ours, email: 'hello@acme.com' }
    step = pass(ours, record, xero)
    expect(step.result.send).toEqual({ email: 'hello@acme.com' })
  })

  test('a bookkeeper’s edit is never taken for PestM8’s', () => {
    const ours: Fields = { email: 'a@x.com' }
    let record: LinkHashes = { how: 'created' }
    let xero: Fields = {}
    ;({ after: xero, record } = pass(ours, record, xero))

    // The bookkeeper changes it; PestM8 has not: nothing sent, nothing moved.
    xero = { email: 'billing@x.com' }
    const quiet = pass(ours, record, xero)
    expect(quiet.result).toEqual({ send: {}, different: [] })
    expect(quiet.record.seen).toEqual(record.seen)

    // PestM8 changes it later: Xero's is not what PestM8 left, so different.
    const changed = pass({ email: 'b@x.com' }, quiet.record, xero)
    expect(changed.result).toEqual({ send: {}, different: ['email'] })

    // "Send PestM8's details": seen moves to Xero's value, and it goes.
    const overwritten: LinkHashes = {
      ...changed.record,
      seen: { ...changed.record.seen, email: fieldHash(xero.email) },
    }
    expect(pass({ email: 'b@x.com' }, overwritten, xero).result.send).toEqual({
      email: 'b@x.com',
    })
  })
})

describe('toXeroCreate', () => {
  test('the Name given, and only what has something in it', () => {
    const ours = ownedFields(
      input(
        {
          name: 'John Smith',
          email: '',
          phone: '0412 345 678',
          clientNumber: 1916,
        },
        { oldestSite: SITE },
      ),
      { creating: true, xeroPoboxBlank: true },
    )
    const site = {
      AddressLine1: '12 Casuarina Drive',
      City: 'Nightcliff',
      Region: 'NT',
      PostalCode: '0810',
      Country: 'Australia',
    }
    expect(toXeroCreate('John Smith (Nightcliff)', ours)).toEqual({
      Name: 'John Smith (Nightcliff)',
      FirstName: 'John',
      LastName: 'Smith',
      AccountNumber: '1916',
      Phones: [{ PhoneType: 'MOBILE', PhoneNumber: '0412 345 678' }],
      Addresses: [
        { AddressType: 'POBOX', ...site },
        { AddressType: 'STREET', ...site },
      ],
    })
  })

  test('a business: ABN, landline, people at most five and off the emails', () => {
    const others = Array.from({ length: 7 }, (_, i) => ({
      name: `Person ${i + 1}`,
      email: `p${i + 1}@acme.com`,
    }))
    const ours = ownedFields(
      input(
        {
          kind: 'business',
          name: 'Acme',
          abn: '51824753556',
          phone: '08 9123 4567',
        },
        { others },
      ),
      { creating: true, xeroPoboxBlank: true },
    )
    const body = toXeroCreate('Acme', ours) as Record<string, unknown>
    expect(body.TaxNumber).toBe('51 824 753 556')
    expect(body.Phones).toEqual([
      { PhoneType: 'DEFAULT', PhoneNumber: '9123 4567', PhoneAreaCode: '08' },
    ])
    expect(body.ContactPersons).toEqual(
      others.slice(0, 5).map((other, i) => ({
        FirstName: 'Person',
        LastName: String(i + 1),
        EmailAddress: other.email,
        IncludeInEmails: false,
      })),
    )
    expect(payloadProblems(ours, null)).toEqual(['persons_full'])
    const five = (ours.persons as Array<unknown>).slice(0, 5)
    expect(payloadProblems({ persons: five }, null)).toEqual([])
    expect(payloadProblems({ persons: [] }, null)).toEqual([])
  })

  test('never sends what PestM8 does not own', () => {
    const body = toXeroCreate('A', { name: 'A' }) as Record<string, unknown>
    expect(body).toEqual({ Name: 'A' })
    for (const field of [
      'ContactID',
      'ContactNumber',
      'IsCustomer',
      'ContactStatus',
      'BankAccountDetails',
    ]) {
      expect(field in body).toBe(false)
    }
  })
})

describe('toXeroUpdate (merge-safe)', () => {
  const phones = [
    { PhoneType: 'DDI', PhoneNumber: '9000 1111', PhoneAreaCode: '08' },
    {
      PhoneType: 'DEFAULT',
      PhoneNumber: '9123 4567',
      PhoneAreaCode: '08',
      PhoneCountryCode: '61',
    },
    { PhoneType: 'FAX', PhoneNumber: '9000 2222', PhoneAreaCode: '08' },
    { PhoneType: 'MOBILE', PhoneNumber: '0400 000 000', PhoneAreaCode: '' },
  ]
  const pobox = {
    AddressType: 'POBOX',
    AddressLine1: 'PO Box 77',
    City: 'Perth',
    Region: 'WA',
    PostalCode: '6849',
    Country: 'Australia',
    AttentionTo: 'Accounts',
  }
  const street = {
    AddressType: 'STREET',
    AddressLine1: '1 Old Rd',
    City: 'Perth',
    Region: 'WA',
    PostalCode: '6000',
    Country: 'Australia',
  }
  const current = xeroContact({
    Phones: phones,
    Addresses: [pobox, street],
    ContactPersons: [
      {
        FirstName: 'Accounts',
        LastName: 'Payable',
        EmailAddress: 'accounts@acme.com',
        IncludeInEmails: true,
      },
    ],
  })

  test('a MOBILE change keeps DEFAULT, DDI and FAX as Xero holds them', () => {
    const body = toXeroUpdate(
      CONTACT_ID,
      { phoneMobile: { areaCode: '', number: '0412 345 678' } },
      current,
    )
    expect(body).toEqual({
      ContactID: CONTACT_ID,
      Phones: [
        phones[0],
        phones[1],
        phones[2],
        { PhoneType: 'MOBILE', PhoneNumber: '0412 345 678' },
      ],
    })
  })

  test('a DEFAULT change keeps the MOBILE; a missing slot is added', () => {
    const body = toXeroUpdate(
      CONTACT_ID,
      { phoneDefault: { areaCode: '02', number: '9999 8888' } },
      xeroContact({ Phones: [phones[3]] }),
    ) as Record<string, unknown>
    expect(body.Phones).toEqual([
      phones[3],
      { PhoneType: 'DEFAULT', PhoneNumber: '9999 8888', PhoneAreaCode: '02' },
    ])
  })

  test('a STREET change keeps the PO box, its attention line included', () => {
    const body = toXeroUpdate(
      CONTACT_ID,
      {
        street: {
          line1: '9 New St',
          city: 'Subiaco',
          region: 'WA',
          postcode: '6008',
          country: 'Australia',
        },
      },
      current,
    )
    expect(body).toEqual({
      ContactID: CONTACT_ID,
      Addresses: [
        pobox,
        {
          AddressType: 'STREET',
          AddressLine1: '9 New St',
          City: 'Subiaco',
          Region: 'WA',
          PostalCode: '6008',
          Country: 'Australia',
        },
      ],
    })
  })

  test('a PO box change keeps who it is for (AttentionTo): the bookkeeper’s, never PestM8’s', () => {
    const body = toXeroUpdate(
      CONTACT_ID,
      {
        pobox: {
          line1: 'PO Box 99',
          city: 'Subiaco',
          region: 'WA',
          postcode: '6904',
          country: 'Australia',
        },
      },
      current,
    )
    expect(body).toEqual({
      ContactID: CONTACT_ID,
      Addresses: [
        {
          AddressType: 'POBOX',
          AddressLine1: 'PO Box 99',
          City: 'Subiaco',
          Region: 'WA',
          PostalCode: '6904',
          Country: 'Australia',
          AttentionTo: 'Accounts',
        },
        street,
      ],
    })
  })

  test('the people PestM8 adds join the bookkeeper’s, who stay', () => {
    const body = toXeroUpdate(
      CONTACT_ID,
      { persons: [{ first: 'Bob', last: 'Jones', email: 'bob@acme.com' }] },
      current,
    ) as Record<string, unknown>
    expect(body.ContactPersons).toEqual([
      {
        FirstName: 'Accounts',
        LastName: 'Payable',
        EmailAddress: 'accounts@acme.com',
        IncludeInEmails: true,
      },
      {
        FirstName: 'Bob',
        LastName: 'Jones',
        EmailAddress: 'bob@acme.com',
        IncludeInEmails: false,
      },
    ])
  })

  test('a person Xero has is updated in place: by email, else by name', () => {
    const held = xeroContact({
      ContactPersons: [
        {
          FirstName: 'Robert',
          LastName: 'Jones',
          EmailAddress: 'BOB@acme.com',
          IncludeInEmails: true,
        },
        { FirstName: 'Sue', LastName: 'Brown', EmailAddress: 'old@acme.com' },
      ],
    })
    const body = toXeroUpdate(
      CONTACT_ID,
      {
        persons: [
          { first: 'Bob', last: 'Jones', email: 'bob@acme.com' },
          { first: 'sue', last: 'brown', email: 'sue@acme.com' },
        ],
      },
      held,
    ) as Record<string, unknown>
    expect(body.ContactPersons).toEqual([
      {
        FirstName: 'Bob',
        LastName: 'Jones',
        EmailAddress: 'bob@acme.com',
        IncludeInEmails: true,
      },
      { FirstName: 'sue', LastName: 'brown', EmailAddress: 'sue@acme.com' },
    ])
  })

  test('at most five: PestM8’s newest go first, never the bookkeeper’s', () => {
    const bookkeepers = Array.from({ length: 4 }, (_, i) => ({
      FirstName: 'Book',
      LastName: `Keeper${i}`,
      EmailAddress: `bk${i}@acme.com`,
    }))
    const held = xeroContact({ ContactPersons: bookkeepers })
    const mine = [
      { first: 'New', last: 'One', email: 'n1@acme.com' },
      { first: 'New', last: 'Two', email: 'n2@acme.com' },
    ]
    const body = toXeroUpdate(CONTACT_ID, { persons: mine }, held) as Record<
      string,
      Array<unknown>
    >
    expect(body.ContactPersons).toHaveLength(5)
    expect(body.ContactPersons.slice(0, 4)).toEqual(bookkeepers)
    expect(body.ContactPersons[4]).toMatchObject({
      EmailAddress: 'n1@acme.com',
    })
    expect(payloadProblems({ persons: mine }, held)).toEqual(['persons_full'])
    expect(payloadProblems({ persons: mine.slice(0, 1) }, held)).toEqual([])

    // Xero already full of its own: none of PestM8's fit, none of Xero's go.
    const full = xeroContact({
      ContactPersons: [...bookkeepers, { FirstName: 'Fifth' }],
    })
    const none = toXeroUpdate(CONTACT_ID, { persons: mine }, full) as Record<
      string,
      Array<unknown>
    >
    expect(none.ContactPersons).toEqual(full.ContactPersons)
  })

  test('only the fields sent; the arrays only when one of theirs is', () => {
    const body = toXeroUpdate(
      CONTACT_ID,
      {
        name: 'Acme',
        email: 'a@acme.com',
        person: { first: 'Sue', last: 'Brown' },
      },
      current,
    )
    expect(body).toEqual({
      ContactID: CONTACT_ID,
      Name: 'Acme',
      EmailAddress: 'a@acme.com',
      FirstName: 'Sue',
      LastName: 'Brown',
    })
  })

  test('a blank is never sent while "" is unproven', () => {
    const body = toXeroUpdate(
      CONTACT_ID,
      {
        email: '',
        person: { first: 'Madonna', last: '' },
        phoneMobile: '',
        street: '',
        persons: [],
      },
      current,
    )
    expect(body).toEqual({ ContactID: CONTACT_ID, FirstName: 'Madonna' })
  })
})

describe('buildUpdateBatch', () => {
  test('wraps updates that each name their contact', () => {
    const one = toXeroUpdate(CONTACT_ID, { name: 'A' }, xeroContact())
    const two = { ContactID: '6d3c1b2a-0000-4000-8000-000000000002', Name: 'B' }
    expect(buildUpdateBatch([one, two])).toEqual({ Contacts: [one, two] })
  })

  test.each([
    ['no ContactID', { Name: 'A' }],
    ['a blank one', { ContactID: '  ', Name: 'A' }],
    [
      'Xero’s “no contact”',
      { ContactID: '00000000-0000-0000-0000-000000000000' },
    ],
    ['not a string', { ContactID: 7 }],
  ])('throws on an element with %s', (_why, element) => {
    expect(() =>
      buildUpdateBatch([{ ContactID: CONTACT_ID }, element]),
    ).toThrow('ContactID')
  })

  test('throws on the same contact twice', () => {
    expect(() =>
      buildUpdateBatch([{ ContactID: CONTACT_ID }, { ContactID: CONTACT_ID }]),
    ).toThrow('twice')
  })
})

/** Every FieldKey has a home in `FIELD_KEYS`, once. */
test('FIELD_KEYS lists every field once', () => {
  const keys: Array<FieldKey> = [
    'name',
    'person',
    'email',
    'phoneDefault',
    'phoneMobile',
    'pobox',
    'street',
    'taxNumber',
    'accountNumber',
    'persons',
  ]
  expect([...FIELD_KEYS].sort()).toEqual([...keys].sort())
})
