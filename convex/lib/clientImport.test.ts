import { describe, expect, test } from 'vitest'
import {
  MAX_IMPORT_NOTE,
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

  // A false match files one person's sites under another, so a letter that
  // differs only by its accent still makes a different name.
  test.each([
    ['Hans Müller', 'Hans Möller'],
    ['Trần Thị Lê', 'Trân Thị Lý'],
    ['Lê Thị Hà', 'Lý Thị Hồ'],
    ['Nguyễn Văn Hùng', 'Nguyễn Văn Hưng'],
    ['Nguyễn Văn An', 'Nguyen Van An'],
    ['王伟', '李娜'],
  ])('"%s" is not "%s"', (a, b) => {
    expect(nameKey(a)).not.toBe(nameKey(b))
  })

  test('keeps the letters of every script, and their accents', () => {
    expect(nameKey('  José  GARCÍA ')).toBe('josé garcía')
    expect(nameKey('Trần Thị Lê')).toBe('trần thị lê')
    expect(nameKey('王伟')).toBe('王伟')
    expect(nameKey('Ольга Петрова')).toBe('ольга петрова')
  })

  test('the same accented name, composed or decomposed, is one name', () => {
    const composed = 'Nguyễn Thị Hương'.normalize('NFC')
    const decomposed = composed.normalize('NFD')
    expect(decomposed).not.toBe(composed)
    expect(nameKey(decomposed)).toBe(nameKey(composed))
    expect(nameKey('Mu\u0308ller')).toBe(nameKey('Müller'))
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

  // "Unit 3, 12" is how the app's own address field writes "Unit 3 12" or
  // "U3 12", and how Xero's two street lines join.
  test.each([
    'Unit 3, 12 Smith Street',
    'Unit 3 12 Smith St',
    'unit 3,12 Smith St',
    'U3/12 Smith St',
    'U3 12 Smith St',
    'U. 3, 12 Smith St',
    'Apt. 3 / 12 Smith St',
    'Apartment 3, 12 Smith St',
    'Flat 3, 12 Smith St',
  ])('"%s" is 3/12 Smith St', (typed) => {
    expect(key(typed)).toBe(key('3/12 Smith St'))
  })

  test('a unit with a letter, and a unit on a numbered range', () => {
    expect(key('Unit 3A, 12 Smith St')).toBe(key('3a/12 Smith St'))
    expect(key('Unit 3, 12-14 Smith St')).toBe(key('3/12-14 Smith St'))
  })

  test('a unit word is only a unit word at the start, before a number', () => {
    expect(key('12 Flat Rock Rd')).not.toBe(key('12 Rock Rd'))
    expect(key('12 Flat Rock Rd')).toBe(key('12 Flat Rock Road'))
    expect(key('Flat Rock Rd')).not.toBe(key('Rock Rd'))
    expect(key('4 Unity Pl')).not.toBe(key('4 Pl'))
    // With no second number, there is nothing to fold.
    expect(key('Unit 3 Smith St')).toBe(key('3 Smith St'))
    expect(key('Unit 3 Smith St')).not.toBe(key('3/12 Smith St'))
  })

  test.each([
    ['5 Banksia Crt', '5 Banksia Court'],
    ['5 Banksia Ct', '5 Banksia Crt'],
    ['5 Ocean Bvd', '5 Ocean Boulevard'],
    ['5 Ocean Bvde', '5 Ocean Blvd'],
    ['5 The Boulevarde', '5 The Boulevard'],
    ['5 Kings Gdns', '5 Kings Gardens'],
    ['5 Lakes Pkwy', '5 Lakes Parkway'],
    ['5 Lakes Pwy', '5 Lakes Parkway'],
    ['5 Marri Dve', '5 Marri Drive'],
    ['5 Marri Drv', '5 Marri Dr'],
    ['5 Hill Crs', '5 Hill Crescent'],
    ['5 Hill Cresc', '5 Hill Cres'],
    ['5 River Terr', '5 River Terrace'],
    ['5 Palm Gve', '5 Palm Grove'],
    ['5 Marine Espl', '5 Marine Esplanade'],
    ['5 Kwinana Fwy', '5 Kwinana Freeway'],
    ['5 Sea Prom', '5 Sea Promenade'],
    ['5 Hilltop App', '5 Hilltop Approach'],
    ['5 Bush Rtt', '5 Bush Retreat'],
    ['5 City Hts', '5 City Heights'],
    ['5 Gum Rdge', '5 Gum Ridge'],
  ])('"%s" is "%s"', (a, b) => {
    expect(key(a)).toBe(key(b))
  })

  test('each street type stays itself', () => {
    const types = [
      'St',
      'Rd',
      'Ave',
      'Dr',
      'Ct',
      'Cres',
      'Pl',
      'Pde',
      'Hwy',
      'Fwy',
      'Tce',
      'Cl',
      'Ln',
      'Blvd',
      'Cct',
      'Gr',
      'Gdns',
      'Pkwy',
      'Way',
      'Sq',
      'Esp',
      'Prom',
      'App',
      'Rtt',
      'Hts',
      'Rdge',
    ]
    const keys = new Set(types.map((type) => key(`5 Hill ${type}`)))
    expect(keys.size).toBe(types.length)
  })

  test('the suburb is compared like a name, with Mount, Port and Point as Mt and Pt', () => {
    expect(key('12 Wattle St', 'BAYSWATER', ' 6053 ')).toBe(key('12 Wattle St'))
    expect(key('12 Wattle St', 'Bays Water')).not.toBe(key('12 Wattle St'))
    expect(key('7 Walcott St', 'Mt Lawley', '6050')).toBe(
      key('7 Walcott St', 'Mount Lawley', '6050'),
    )
    expect(key('7 Walcott St', 'MT. LAWLEY', '6050')).toBe(
      key('7 Walcott St', 'Mount Lawley', '6050'),
    )
    expect(key('7 Anderson St', 'Pt Hedland', '6721')).toBe(
      key('7 Anderson St', 'Port Hedland', '6721'),
    )
    expect(key('7 Anderson St', 'PT. HEDLAND', '6721')).toBe(
      key('7 Anderson St', 'port hedland', '6721'),
    )
    // "Pt" is written for Point as well as Port.
    expect(key('3 Sneydes Rd', 'Pt Cook', '3030')).toBe(
      key('3 Sneydes Rd', 'Point Cook', '3030'),
    )
    expect(key('3 Sneydes Rd', 'Pt. Cook', '3030')).toBe(
      key('3 Sneydes Rd', 'POINT COOK', '3030'),
    )
    // Only as a word of its own.
    expect(key('7 Walcott St', 'Mtlawley', '6050')).not.toBe(
      key('7 Walcott St', 'Mount Lawley', '6050'),
    )
    expect(key('7 Lake Rd', 'Mountain Creek', '4557')).not.toBe(
      key('7 Lake Rd', 'Mt Creek', '4557'),
    )
    // Other suburbs stay other suburbs.
    expect(key('7 Anderson St', 'Pt Hedland', '6721')).not.toBe(
      key('7 Anderson St', 'South Hedland', '6721'),
    )
  })

  test('a three-digit postcode is the four-digit one it lost its 0 from', () => {
    const nightcliff = (postcode: string) =>
      siteKey({
        addressLine: '6/79 Progress Drive',
        suburb: 'Nightcliff',
        postcode,
      })
    expect(nightcliff('810')).toBe(nightcliff('0810'))
    expect(nightcliff(' 810 ')).toBe(nightcliff('0810'))
    expect(nightcliff('0810')).not.toBe(nightcliff('0820'))
    expect(nightcliff('81')).not.toBe(nightcliff('0081'))
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
    expect(site.note).toHaveLength(MAX_IMPORT_NOTE)
    // A blank note is no note.
    expect(accepted({ sites: [{ ...WATTLE, note: '  ' }] }).sites[0]).toEqual(
      WATTLE,
    )
  })

  test('a note is cut by whole characters, never through an emoji', () => {
    const noteOf = (note: string) =>
      accepted({ sites: [{ ...WATTLE, note }] }).sites[0].note!
    const ant = '🐜' // two UTF-16 units, one character
    const cut = noteOf(`${'x'.repeat(MAX_IMPORT_NOTE - 1)}${ant}${ant} more`)
    expect(cut).toBe(`${'x'.repeat(MAX_IMPORT_NOTE - 1)}${ant}`)
    expect(Array.from(cut)).toHaveLength(MAX_IMPORT_NOTE)
    // No half of a pair left at the end.
    expect(/[\uD800-\uDBFF]$/.test(cut)).toBe(false)
    // At the limit exactly, nothing is cut, however many units it takes.
    const full = ant.repeat(MAX_IMPORT_NOTE)
    expect(noteOf(full)).toBe(full)
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
