import { describe, expect, test } from 'vitest'
import {
  FIELD_LABELS,
  FIELD_ORDER,
  autoMap,
  detectSource,
  isKnownHeading,
  mappingProblems,
} from './columns'
import type { ColumnMapping, ImportField, ImportSheet } from './types'

function sheet(
  headers: Array<string>,
  rows: Array<Array<string>> = [],
): ImportSheet {
  return {
    fileName: 'clients.csv',
    headers,
    rows: rows.map((r) => headers.map((_, i) => r[i] ?? '')),
  }
}

/** The mapping as heading → field, for readable expectations. */
function mapped(s: ImportSheet): Record<string, ImportField> {
  const mapping = autoMap(s)
  const out: Record<string, ImportField> = {}
  s.headers.forEach((h, i) => {
    const field = mapping[i]
    if (field) out[h] = field
  })
  return out
}

const JOBBER = [
  'J-ID',
  'Display Name',
  'Title',
  'First Name',
  'Last Name',
  'Company Name',
  'Is Company?',
  'Main Phone #s',
  'Mobile Phone #s',
  'E-mails',
  'Billing Street 1',
  'Billing Street 2',
  'Billing City',
  'Billing State',
  'Billing Zip code',
  'Service Street 1',
  'Service Street 2',
  'Service City',
  'Service State',
  'Service Zip code',
  'Client Notes',
]

const XERO = [
  '*ContactName',
  'EmailAddress',
  'FirstName',
  'LastName',
  'POAttentionTo',
  'POAddressLine1',
  'POAddressLine2',
  'POCity',
  'PORegion',
  'POPostalCode',
  'POCountry',
  'SAAttentionTo',
  'SAAddressLine1',
  'SAAddressLine2',
  'SACity',
  'SARegion',
  'SAPostalCode',
  'SACountry',
  'PhoneNumber',
  'MobileNumber',
  'TaxNumber',
]

const MYOB = [
  'Co./Last Name',
  'First Name',
  'Card ID',
  'Card Status',
  'Addr 1 - Line 1',
  '           - Line 2',
  '           - City',
  '           - State',
  '           - Postcode',
  '           - Phone # 1',
  '           - Email',
  '           - Contact Name',
  'Addr 2 - Line 1',
  '           - Line 2',
  '           - City',
  '           - State',
  '           - Postcode',
  'Notes',
  'A.B.N.',
]

const GORILLADESK = [
  'Bill To Name',
  'First Name',
  'Last Name',
  'Company',
  'Customer Type',
  'Billing Address',
  'Billing City',
  'Billing State',
  'Billing Zip',
  'Location Address',
  'Location City',
  'Location State',
  'Location Zip',
  'Phone',
  'Mobile',
  'Email',
  'Top Note',
  'Location Notes',
]

describe('detectSource', () => {
  test.each([
    ['Jobber', JOBBER],
    ['Xero', XERO],
    ['MYOB', MYOB],
    ['GorillaDesk', GORILLADESK],
    [
      'ServiceM8',
      ['name', 'abn_number', 'address_street', 'Contact First', 'Contact Last'],
    ],
    [
      'Housecall Pro',
      ['First Name', 'Last Name', 'Display name', 'Service address', 'Email'],
    ],
    [
      'Tradify',
      ['Customer Name', 'Physical Address', 'Physical Suburb', 'Email'],
    ],
  ])('%s', (app, headers) => {
    expect(detectSource(headers)).toBe(app)
  })

  test("a plain sheet is nobody's", () => {
    expect(detectSource(['Full name', 'Address', 'Phone', 'Notes'])).toBe(null)
    expect(detectSource([])).toBe(null)
  })

  test('one weak sign is not enough', () => {
    expect(detectSource(['Display name', 'Address', 'Phone'])).toBe(null)
    expect(detectSource(['Name', 'Billing Street', 'Billing City'])).toBe(null)
    expect(detectSource(['Name', 'TaxNumber'])).toBe(null)
  })

  test("Xero's import template, with its required-column stars", () => {
    expect(detectSource(['*ContactName', 'EmailAddress'])).toBe('Xero')
  })
})

describe('autoMap', () => {
  test('Jobber: the service address, never the billing one', () => {
    const s = sheet(JOBBER, [
      [
        '1',
        'Jo Bloggs',
        '',
        'Jo',
        'Bloggs',
        '',
        'false',
        '08 9271 1234',
        '0412 345 678',
        'jo@example.com',
        'PO Box 1',
        '',
        'Perth',
        'WA',
        '6000',
        '12 Wattle St',
        '',
        'Bayswater',
        'WA',
        '6053',
        'Dog',
      ],
    ])
    expect(mapped(s)).toEqual({
      'Display Name': 'name',
      'First Name': 'firstName',
      'Last Name': 'lastName',
      'Company Name': 'company',
      'Is Company?': 'isCompany',
      'Main Phone #s': 'phone',
      'Mobile Phone #s': 'mobile',
      'E-mails': 'email',
      'Service Street 1': 'street',
      'Service Street 2': 'street2',
      'Service City': 'suburb',
      'Service State': 'state',
      'Service Zip code': 'postcode',
      'Client Notes': 'notes',
    })
  })

  const xeroRow = (sa: boolean) => [
    'Wattle Strata Pty Ltd',
    'office@wattle.com.au',
    'Jo',
    'Bloggs',
    '',
    'PO Box 99',
    '',
    'Perth',
    'WA',
    '6000',
    'Australia',
    '',
    sa ? '12 Wattle St' : '',
    '',
    sa ? 'Bayswater' : '',
    sa ? 'WA' : '',
    sa ? '6053' : '',
    '',
    '08 9271 1234',
    '',
    '51 824 753 556',
  ]

  test('Xero: the street address (SA), with ContactName as the client', () => {
    expect(mapped(sheet(XERO, [xeroRow(true)]))).toEqual({
      '*ContactName': 'name',
      EmailAddress: 'email',
      FirstName: 'firstName',
      LastName: 'lastName',
      SAAddressLine1: 'street',
      SAAddressLine2: 'street2',
      SACity: 'suburb',
      SARegion: 'state',
      SAPostalCode: 'postcode',
      PhoneNumber: 'phone',
      MobileNumber: 'mobile',
      TaxNumber: 'abn',
    })
  })

  test('Xero: every SA cell empty, so the postal address (PO) it is', () => {
    const m = mapped(sheet(XERO, [xeroRow(false), xeroRow(false)]))
    expect(m).toMatchObject({
      POAddressLine1: 'street',
      POAddressLine2: 'street2',
      POCity: 'suburb',
      PORegion: 'state',
      POPostalCode: 'postcode',
    })
    expect(m.SAAddressLine1).toBeUndefined()
    expect(m.SACity).toBeUndefined()
  })

  test('MYOB: the first address, the company-or-surname column', () => {
    const m = autoMap(
      sheet(MYOB, [['Smith', 'Jo', '*None', 'N', '12 Wattle St']]),
    )
    expect(m).toEqual([
      'lastName',
      'firstName',
      null,
      null,
      'street',
      'street2',
      'suburb',
      'state',
      'postcode',
      'phone',
      'email',
      'contactPerson',
      null,
      null,
      null,
      null,
      null,
      'notes',
      'abn',
    ])
  })

  test('GorillaDesk: the location, and its notes over the top note', () => {
    const s = sheet(GORILLADESK, [
      [
        'Jo Bloggs',
        'Jo',
        'Bloggs',
        '',
        'Residential',
        '1 Hay St',
        'Perth',
        'WA',
        '6000',
        '12 Wattle St',
        'Bayswater',
        'WA',
        '6053',
      ],
    ])
    expect(mapped(s)).toEqual({
      'Bill To Name': 'name',
      'First Name': 'firstName',
      'Last Name': 'lastName',
      Company: 'company',
      'Customer Type': 'isCompany',
      'Location Address': 'street',
      'Location City': 'suburb',
      'Location State': 'state',
      'Location Zip': 'postcode',
      Phone: 'phone',
      Mobile: 'mobile',
      Email: 'email',
      'Location Notes': 'notes',
    })
  })

  test('a plain sheet: Full name / Address / Phone / Notes', () => {
    const s = sheet(
      ['Full name', 'Address', 'Phone', 'Notes'],
      [
        ['Jo Bloggs', '12 Wattle St, Bayswater WA 6053', '0412 345 678', ''],
        ['Ann Lee', '3 Beach Rd\nScarborough WA 6019', '', 'Gate code'],
      ],
    )
    expect(autoMap(s)).toEqual(['name', 'address', 'phone', 'notes'])
    expect(mappingProblems(autoMap(s))).toEqual([])
  })

  test('an "Address" column beside a "Suburb" column holds streets', () => {
    const s = sheet(
      ['Name', 'Address', 'Suburb', 'Postcode'],
      [['Jo', '12 Wattle St', 'Bayswater', '6053']],
    )
    expect(autoMap(s)).toEqual(['name', 'street', 'suburb', 'postcode'])
  })

  test('a street column holding whole addresses, with no suburb, is one column', () => {
    const s = sheet(
      ['Display name', 'Service address', 'Email'],
      [
        ['Jo', '12 Wattle St, Bayswater WA 6053', ''],
        ['Ann', '3 Beach Rd, Scarborough WA 6019', ''],
      ],
    )
    expect(autoMap(s)).toEqual(['name', 'address', 'email'])
    const streets = sheet(
      ['Name', 'Street address'],
      [['Jo', '12 Wattle St, Bayswater WA 6053']],
    )
    expect(autoMap(streets)).toEqual(['name', 'address'])
  })

  test('only a billing address: used, as there is nothing else', () => {
    const s = sheet(
      ['Name', 'Billing Street', 'Billing City', 'Billing Postcode'],
      [['Jo', '12 Wattle St', 'Bayswater', '6053']],
    )
    expect(autoMap(s)).toEqual(['name', 'street', 'suburb', 'postcode'])
  })

  test('"Contact name" is the person to ask for, outside Xero', () => {
    const s = sheet(['Company', 'Contact name', 'Site address'])
    expect(autoMap(s)).toEqual(['company', 'contactPerson', 'address'])
  })

  test('each field claimed once; the rest left for the person', () => {
    const s = sheet(['Name', 'Client name', 'Phone', 'Telephone', 'Colour'])
    // "Client name" beats "Name" when both are there, and "Phone" beats
    // "Telephone".
    expect(autoMap(s)).toEqual([null, 'name', 'phone', null, null])
  })
})

describe('isKnownHeading', () => {
  test('a heading autoMap has a field for, however it is written', () => {
    for (const heading of [
      'Client Name',
      'NAME',
      'Suburb',
      'E-mails',
      'Service Street 1',
      'SAAddressLine1',
      'Co./Last Name',
      '*ContactName',
      'Billing Zip code',
    ]) {
      expect(isKnownHeading(heading), heading).toBe(true)
    }
  })

  test('a title, a heading of its own, or a client’s details is not', () => {
    for (const cell of [
      '',
      'Client list 2024',
      'Cust',
      'Addr',
      'Sub',
      'PC',
      'Jane Smith',
      '1 A St',
      'Bayswater',
      'WA',
      '6053',
      '0412 345 678',
    ]) {
      expect(isKnownHeading(cell), cell).toBe(false)
    }
  })

  test('every column autoMap maps in an app’s export has a known heading', () => {
    for (const headers of [JOBBER, XERO, MYOB, GORILLADESK]) {
      const mapping = autoMap(sheet(headers))
      const unknown = headers.filter(
        (h, i) => mapping[i] !== null && !isKnownHeading(h),
      )
      expect(unknown).toEqual([])
    }
  })
})

describe('mappingProblems', () => {
  const problems = (mapping: ColumnMapping) => mappingProblems(mapping)

  test('a name and an address are enough', () => {
    expect(problems(['name', 'address'])).toEqual([])
    expect(problems(['company', 'street', 'suburb'])).toEqual([])
    expect(problems(['firstName', 'lastName', 'address'])).toEqual([])
    expect(problems(['lastName', 'address'])).toEqual([])
  })

  test('no name', () => {
    expect(problems(['phone', 'address'])).toEqual([
      "Choose the column with the client's name — or the first and last names, or the company.",
    ])
  })

  test('no address, or a street with no suburb', () => {
    expect(problems(['name', 'suburb'])[0]).toMatch(/column with the address/)
    expect(problems(['name', 'street', 'postcode'])[0]).toMatch(
      /suburb column too/,
    )
    // A one-column address doesn't need the rest.
    expect(problems(['name', 'address', null])).toEqual([])
  })

  test('a field chosen twice', () => {
    expect(problems(['name', 'address', 'phone', 'phone'])).toEqual([
      '“Phone” is chosen for more than one column — choose it for one only.',
    ])
  })
})

test('every field has a label and a place in the dropdown', () => {
  expect(new Set(FIELD_ORDER).size).toBe(FIELD_ORDER.length)
  expect([...FIELD_ORDER].sort()).toEqual(Object.keys(FIELD_LABELS).sort())
  expect(FIELD_LABELS.address).toBe('Full address (one column)')
})
