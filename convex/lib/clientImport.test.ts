import { describe, expect, test } from 'vitest'
import {
  checkImportClient,
  nameKey,
  phoneProblem,
  siteKey,
} from './clientImport'
import type { Id } from '../_generated/dataModel'
import type { ImportClient, ImportSite } from './clientImport'

/**
 * The rules a client import shares between the page and the server: when two
 * names or two addresses are the same one, and what a client must be to be
 * written. The page files a row as "Already in PestM8" or "Can't import" by
 * these, and the server refuses by them, so a difference between what these
 * say and what either side expects is a row promised and then refused.
 */

const WATTLE: ImportSite = {
  addressLine: '12 Wattle Street',
  suburb: 'Bayswater',
  state: 'WA',
  postcode: '6053',
}

function client(fields: Partial<ImportClient> = {}): ImportClient {
  return {
    key: 'c1',
    kind: 'person',
    name: 'J. Nguyen',
    sites: [WATTLE],
    ...fields,
  }
}

function refusal(fields: Partial<ImportClient>): string {
  const check = checkImportClient(client(fields))
  if (check.ok) throw new Error('expected a refusal')
  return check.reason
}

function accepted(fields: Partial<ImportClient> = {}): ImportClient {
  const check = checkImportClient(client(fields))
  if (!check.ok) throw new Error(`refused: ${check.reason}`)
  return check.client
}

describe('nameKey: the same client, however the file wrote the name', () => {
  test.each([
    ['J. Nguyen', 'j nguyen'],
    ['  J  NGUYEN ', 'J. Nguyen'],
    ['Smith & Sons', 'Smith and Sons'],
    ['Coastal Cafe Group Pty. Ltd.', 'coastal cafe group pty ltd'],
    ["O'Brien, Sean", 'O Brien Sean'],
  ])('"%s" is "%s"', (a, b) => {
    expect(nameKey(a)).toBe(nameKey(b))
  })

  test('different people stay different', () => {
    expect(nameKey('J. Nguyen')).not.toBe(nameKey('T. Nguyen'))
    expect(nameKey('Smith & Sons')).not.toBe(nameKey('Smith Sons'))
  })
})

describe('siteKey: the same house, however the file wrote the address', () => {
  const key = (addressLine: string, suburb = 'Bayswater', postcode = '6053') =>
    siteKey({ addressLine, suburb, postcode })

  test.each([
    '12 wattle st',
    '12 Wattle St.',
    '12  WATTLE   STREET',
    ' 12 Wattle Street ',
  ])('"%s" is 12 Wattle Street', (typed) => {
    expect(key(typed)).toBe(key('12 Wattle Street'))
  })

  test.each([
    ['Unit 2/14 Beach Road', '2/14 Beach Rd'],
    ['U 2 / 14 Beach Rd', '2/14 Beach Road'],
    ['Apt 3/7 Hill Crescent', '3/7 Hill Cr'],
    ['8 Swan Avenue', '8 Swan Av'],
    ['8 Swan Ave', '8 Swan Avenue'],
  ])('"%s" is "%s"', (a, b) => {
    expect(key(a)).toBe(key(b))
  })

  test('the suburb is compared like a name, and the postcode as written', () => {
    expect(key('12 Wattle St', 'BAYSWATER', ' 6053 ')).toBe(key('12 Wattle St'))
    expect(key('12 Wattle St', 'Bays Water')).not.toBe(key('12 Wattle St'))
  })

  test('another number, unit, street or postcode is another site', () => {
    expect(key('14 Wattle St')).not.toBe(key('12 Wattle St'))
    expect(key('2/14 Beach Rd')).not.toBe(key('3/14 Beach Rd'))
    expect(key('12 Wattle Rd')).not.toBe(key('12 Wattle St'))
    expect(key('12 Wattle St', 'Bayswater', '6054')).not.toBe(
      key('12 Wattle St'),
    )
  })
})

describe('checkImportClient: what a client must be to be written', () => {
  test('a name, trimmed, with its spaces collapsed — and not blank or too long', () => {
    expect(accepted({ name: '  J.   Nguyen ' }).name).toBe('J. Nguyen')
    expect(refusal({ name: '   ' })).toBe('No client name.')
    expect(refusal({ name: 'x'.repeat(201) })).toBe('The name is too long.')
  })

  test('at least one site, each with a street, a suburb, a state and a four-digit postcode', () => {
    expect(refusal({ sites: [] })).toBe(
      'No address — a client needs at least one site.',
    )
    expect(refusal({ sites: [{ ...WATTLE, addressLine: ' ' }] })).toBe(
      'A site has no street address.',
    )
    expect(refusal({ sites: [{ ...WATTLE, suburb: '' }] })).toBe(
      'No suburb for 12 Wattle Street.',
    )
    expect(
      refusal({ sites: [{ ...WATTLE, state: 'Western Australia' }] }),
    ).toBe('No Australian state for 12 Wattle Street.')
    expect(refusal({ sites: [{ ...WATTLE, postcode: '810' }] })).toBe(
      'The postcode for 12 Wattle Street is not four digits.',
    )
    expect(refusal({ sites: [{ ...WATTLE, postcode: '6O53' }] })).toBe(
      'The postcode for 12 Wattle Street is not four digits.',
    )
  })

  test('a site is stored tidied: trimmed, the state in capitals, a note capped', () => {
    const [site] = accepted({
      sites: [
        {
          addressLine: ' 12  Wattle Street ',
          suburb: ' Bayswater ',
          state: ' wa ',
          postcode: ' 6053 ',
          note: `  Gate code 1234 ${'x'.repeat(6000)}`,
        },
      ],
    }).sites
    expect(site).toMatchObject({
      addressLine: '12 Wattle Street',
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
    })
    expect(site.note?.startsWith('Gate code 1234')).toBe(true)
    expect(site.note).toHaveLength(5000)
    // A blank note is no note.
    expect(accepted({ sites: [{ ...WATTLE, note: '  ' }] }).sites[0]).toEqual(
      WATTLE,
    )
  })

  test('a site contact belongs to a business client, and their phone must be one', () => {
    const withContact = {
      ...WATTLE,
      siteContactName: ' Priya Shah ',
      siteContactPhone: ' 0400 111 222 ',
    }
    expect(
      accepted({ kind: 'business', sites: [withContact] }).sites[0],
    ).toMatchObject({
      siteContactName: 'Priya Shah',
      siteContactPhone: '0400 111 222',
    })
    // A person is who is on site; theirs are dropped rather than refused —
    // even one that isn't a phone number, as it is never stored.
    const [personSite] = accepted({ sites: [withContact] }).sites
    expect(personSite.siteContactName).toBeUndefined()
    expect(personSite.siteContactPhone).toBeUndefined()
    expect(
      accepted({ sites: [{ ...WATTLE, siteContactPhone: 'ring the office' }] })
        .sites[0],
    ).toEqual(WATTLE)

    for (const siteContactPhone of ['ring the office', 'x21']) {
      expect(
        refusal({
          kind: 'business',
          sites: [{ ...WATTLE, siteContactPhone }],
        }),
      ).toBe(
        "The site contact's phone for 12 Wattle Street is not a phone number.",
      )
    }
  })

  test('an email that can be sent to, stored with its domain in lower case', () => {
    expect(accepted({ email: ' Jo@Nguyen.COM.AU ' }).email).toBe(
      'Jo@nguyen.com.au',
    )
    expect(refusal({ email: 'jo@' })).toBe('jo@ is not an email address.')
    expect(refusal({ email: 'jo nguyen@gmail.com' })).toBe(
      'jo nguyen@gmail.com is not an email address.',
    )
  })

  test('a phone that can be dialled; a warning-level one is kept as written', () => {
    expect(accepted({ phone: ' 0412 345 678 ' }).phone).toBe('0412 345 678')
    // Missing its area code: the page warns, the server keeps it.
    expect(accepted({ phone: '9335 1000' }).phone).toBe('9335 1000')
    expect(refusal({ phone: 'mobile 0412' })).toBe(
      'mobile 0412 is not a phone number.',
    )
    expect(refusal({ phone: '1234' })).toBe('1234 is not a phone number.')
    // An extension is kept with its number; on its own it is refused, not
    // thrown — `checkPhone` passes it, and storing it would throw.
    expect(accepted({ phone: '08 9335 1000 ext 21' }).phone).toBe(
      '08 9335 1000 ext 21',
    )
    expect(refusal({ phone: 'x21' })).toBe('x21 is not a phone number.')
  })

  test('phoneProblem: what checkPhone refuses, and what storing would', () => {
    expect(phoneProblem('0412 345 678')).toBeNull()
    expect(phoneProblem('9335 1000')).toBeNull()
    expect(phoneProblem('mobile 0412')).toMatch(/only have digits/)
    expect(phoneProblem('1234')).toBe('That is too short for a phone number.')
    expect(phoneProblem('x21')).toBe('That is too short for a phone number.')
  })

  test('a business’s ABN must pass the ATO check, and is stored as digits', () => {
    expect(accepted({ kind: 'business', abn: '51 824 753 556' }).abn).toBe(
      '51824753556',
    )
    expect(refusal({ kind: 'business', abn: '51 824 753 557' })).toBe(
      'The ABN does not pass the ATO check.',
    )
    // A person has no ABN: one in the file is dropped, never refused.
    expect(accepted({ abn: '51 824 753 557' }).abn).toBeUndefined()
  })

  test('a contact person is a business’s only', () => {
    expect(
      accepted({ kind: 'business', contactPerson: ' Jan Morris ' })
        .contactPerson,
    ).toBe('Jan Morris')
    expect(accepted({ contactPerson: 'Jan Morris' }).contactPerson).toBe(
      undefined,
    )
    expect(
      accepted({ kind: 'business', contactPerson: '  ' }).contactPerson,
    ).toBeUndefined()
  })

  test('keeps the page’s key and the existing client it names', () => {
    const existingClientId = 'k57abc' as Id<'clients'>
    const out = accepted({ key: 'c7', existingClientId })
    expect(out.key).toBe('c7')
    expect(out.existingClientId).toBe(existingClientId)
  })

  test('leaves out what was not given, rather than storing blanks', () => {
    expect(
      accepted({ phone: ' ', email: '', abn: ' ', contactPerson: '' }),
    ).toEqual({ key: 'c1', kind: 'person', name: 'J. Nguyen', sites: [WATTLE] })
  })
})
