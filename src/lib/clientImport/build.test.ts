import { describe, expect, test } from 'vitest'
import { checkImportClient, siteKey } from '../../../convex/lib/clientImport'
import { buildReview, recheckClient } from './build'
import { statusOf, toImportClient } from './convert'
import type { Id } from '../../../convex/_generated/dataModel'
import type {
  ColumnMapping,
  ExistingIndex,
  ImportField,
  ReviewClient,
  ReviewIssue,
} from './types'

const NONE: ExistingIndex = { clientsByName: new Map(), siteKeys: new Set() }

/** A sheet from rows of heading → value, mapped by the headings' fields. */
function review(
  columns: Array<[string, ImportField | null]>,
  rows: Array<Array<string>>,
  opts: { businessState?: string; existing?: ExistingIndex } = {},
): Array<ReviewClient> {
  const mapping: ColumnMapping = columns.map(([, field]) => field)
  return buildReview(
    {
      fileName: 'clients.csv',
      headers: columns.map(([h]) => h),
      rows: rows.map((r) => columns.map((_, i) => r[i] ?? '')),
    },
    mapping,
    {
      businessState: opts.businessState ?? 'WA',
      existing: opts.existing ?? NONE,
    },
  )
}

const PLAIN: Array<[string, ImportField]> = [
  ['Name', 'name'],
  ['Address', 'address'],
  ['Phone', 'phone'],
  ['Email', 'email'],
  ['Notes', 'notes'],
]

function one(rows: Array<Array<string>>, opts = {}): ReviewClient {
  const clients = review(PLAIN, rows, opts)
  expect(clients).toHaveLength(1)
  return clients[0]
}

const messages = (client: ReviewClient, level?: ReviewIssue['level']) =>
  client.issues.filter((i) => !level || i.level === level).map((i) => i.message)

function issue(client: ReviewClient, text: string | RegExp): ReviewIssue {
  const found = client.issues.find((i) =>
    typeof text === 'string' ? i.message === text : text.test(i.message),
  )
  if (!found) {
    throw new Error(
      `no issue ${String(text)} in ${messages(client).join(' / ')}`,
    )
  }
  return found
}

const opts = { businessState: 'WA', existing: NONE }

describe('grouping rows into clients', () => {
  const JOBBER: Array<[string, ImportField]> = [
    ['Display Name', 'name'],
    ['First Name', 'firstName'],
    ['Last Name', 'lastName'],
    ['Company Name', 'company'],
    ['Is Company?', 'isCompany'],
    ['Main Phone #s', 'phone'],
    ['E-mails', 'email'],
    ['Service Street 1', 'street'],
    ['Service City', 'suburb'],
    ['Service State', 'state'],
    ['Service Zip code', 'postcode'],
    ['Client Notes', 'notes'],
  ]

  test("Jobber's row per property: one client, two sites", () => {
    const clients = review(JOBBER, [
      [
        'Jo Bloggs',
        'Jo',
        'Bloggs',
        '',
        'false',
        '0412 345 678',
        'jo@example.com',
        '12 Wattle St',
        'Bayswater',
        'WA',
        '6053',
        'Dog in yard',
      ],
      [
        'Jo Bloggs',
        'Jo',
        'Bloggs',
        '',
        'false',
        '0412 345 678',
        'jo@example.com',
        '5 Beach Rd',
        'Scarborough',
        'WA',
        '6019',
        '',
      ],
      [
        'Ann Lee',
        'Ann',
        'Lee',
        '',
        'false',
        '0400 111 222',
        '',
        '1 Hay St',
        'Perth',
        'WA',
        '6000',
        '',
      ],
    ])
    expect(clients).toHaveLength(2)
    const [jo, ann] = clients
    expect(jo).toMatchObject({
      key: 'c1',
      rowNumbers: [1, 2],
      kind: 'person',
      name: 'Jo Bloggs',
      phone: '0412 345 678',
      email: 'jo@example.com',
      included: true,
      sites: [
        {
          addressLine: '12 Wattle St',
          suburb: 'Bayswater',
          state: 'WA',
          postcode: '6053',
          note: 'Dog in yard',
        },
        {
          addressLine: '5 Beach Rd',
          suburb: 'Scarborough',
          state: 'WA',
          postcode: '6019',
        },
      ],
    })
    expect(jo.issues).toEqual([])
    expect(statusOf(jo)).toBe('ready')
    expect(ann).toMatchObject({ key: 'c3', rowNumbers: [3] })
  })

  test('the same name with different contacts is two clients', () => {
    const clients = review(PLAIN, [
      ['John Smith', '1 Hay St, Perth WA 6000', '0412 345 678'],
      ['John Smith', '2 Hay St, Perth WA 6000', '0499 888 777'],
      ['John Smith', '3 Hay St, Perth WA 6000', '0412 345 678'],
    ])
    expect(clients.map((c) => c.rowNumbers)).toEqual([[1, 3], [2]])
  })

  test('one house on two rows is one site, its notes joined', () => {
    const client = one([
      ['Jo Bloggs', '12 Wattle Street, Bayswater WA 6053', '', '', 'Dog'],
      [
        'Jo Bloggs',
        '12 wattle st, Bayswater WA 6053',
        '',
        '',
        'Gate code 1234',
      ],
    ])
    expect(client.sites).toHaveLength(1)
    expect(client.sites[0].note).toBe('Dog\n\nGate code 1234')
  })

  test('rows with no name are each their own client, and an error', () => {
    const clients = review(PLAIN, [
      ['', '1 Hay St, Perth WA 6000'],
      ['', '2 Hay St, Perth WA 6000'],
    ])
    expect(clients).toHaveLength(2)
    expect(messages(clients[0], 'error')).toEqual(['No client name.'])
    expect(statusOf(clients[0])).toBe('error')
  })

  test('"N/A", "-" and the like are blanks, not values', () => {
    const client = one([
      ['Jo Bloggs', '1 Hay St, Perth WA 6000', '-', 'N/A', 'none'],
    ])
    expect(client.phone).toBeUndefined()
    expect(client.email).toBeUndefined()
    expect(client.sites[0].note).toBeUndefined()
    expect(client.issues).toEqual([])
  })

  test('a row with no address is a client that cannot be imported', () => {
    const client = one([['Jo Bloggs', '', '0412 345 678']])
    expect(client.sites).toEqual([])
    expect(messages(client, 'error')).toEqual([
      'No address — a client needs at least one site.',
    ])
    expect(statusOf(client)).toBe('error')
  })
})

describe('Australian addresses', () => {
  const SPLIT: Array<[string, ImportField]> = [
    ['Name', 'name'],
    ['Street', 'street'],
    ['Street 2', 'street2'],
    ['Suburb', 'suburb'],
    ['State', 'state'],
    ['Postcode', 'postcode'],
  ]

  test('an NT postcode that lost its 0: 810 → 0810', () => {
    const [client] = review(SPLIT, [
      ['Jo', '1 Casuarina Dr', '', 'Nightcliff', 'NT', '810'],
    ])
    expect(client.sites[0].postcode).toBe('0810')
    expect(client.issues).toEqual([
      expect.objectContaining({
        level: 'fixed',
        field: 'postcode',
        siteIndex: 0,
        message: 'Postcode 810 → 0810',
      }),
    ])
    expect(statusOf(client)).toBe('fixed')
  })

  test('an ACT one, with no state given: the postcode says ACT', () => {
    const [client] = review(SPLIT, [
      ['Jo', '1 Main St', '', 'Acton', '', '200'],
    ])
    expect(client.sites[0]).toMatchObject({ postcode: '0200', state: 'ACT' })
    expect(messages(client, 'fixed')).toEqual([
      'Postcode 200 → 0200',
      'No state in the file — used ACT, from the postcode.',
    ])
  })

  test('a 3-digit postcode that would be no NT or ACT one is an error', () => {
    const [client] = review(SPLIT, [
      ['Jo', '1 Main St', '', 'Perth', 'WA', '600'],
    ])
    expect(client.sites[0].postcode).toBe('600')
    expect(messages(client, 'error')).toEqual([
      `Postcode “600” isn't 4 digits.`,
    ])
  })

  test.each([
    ['Western Australia', 'WA'],
    ['W.A.', 'WA'],
    ['Qld', 'QLD'],
    ['Vic.', 'VIC'],
    ['N.S.W', 'NSW'],
    ['Tas', 'TAS'],
    ['Northern Territory', 'NT'],
    ['Australian Capital Territory', 'ACT'],
    ['south australia', 'SA'],
  ])('state "%s" is %s', (written, code) => {
    const [client] = review(SPLIT, [
      ['Jo', '1 Main St', '', 'Town', written, ''],
    ])
    expect(client.sites[0].state).toBe(code)
    expect(messages(client).some((m) => m.includes('state'))).toBe(false)
  })

  test("no state: from the postcode, else the business's own", () => {
    const [fromPostcode] = review(SPLIT, [
      ['Jo', '1 Main St', '', 'Parramatta', '', '2150'],
    ])
    expect(fromPostcode.sites[0].state).toBe('NSW')
    expect(messages(fromPostcode, 'fixed')).toEqual([
      'No state in the file — used NSW, from the postcode.',
    ])
    const [fromBusiness] = review(
      SPLIT,
      [['Jo', '1 Main St', '', 'Bayswater', '', '']],
      { businessState: 'WA' },
    )
    expect(fromBusiness.sites[0].state).toBe('WA')
    expect(messages(fromBusiness, 'fixed')).toEqual([
      'No state in the file — used WA.',
    ])
  })

  test('a state that is not one is a warning, and a guess', () => {
    const [client] = review(SPLIT, [
      ['Jo', '1 Main St', '', 'Bayswater', 'Westralia', '6053'],
    ])
    expect(client.sites[0].state).toBe('WA')
    expect(messages(client, 'warning')).toEqual([
      "“Westralia” isn't a state — used WA, from the postcode.",
    ])
  })

  test('street line 2 joins the first with a comma', () => {
    const [client] = review(SPLIT, [
      ['Jo', 'Unit 3', '12 Wattle St', 'Bayswater', 'WA', '6053'],
    ])
    expect(client.sites[0].addressLine).toBe('Unit 3, 12 Wattle St')
  })

  test.each([
    '12 Wattle St, Bayswater WA 6053',
    '12 Wattle St\nBayswater WA 6053',
    '12 Wattle St\r\nBayswater WA 6053\r\nAustralia',
    '12 Wattle St, Bayswater, WA, 6053',
    '12 Wattle St, Bayswater, Western Australia, 6053',
    '12 Wattle St, Bayswater 6053 WA',
    '12 Wattle St, BAYSWATER W.A. 6053, Australia',
  ])('one-column address %j', (address) => {
    const client = one([['Jo', address]])
    expect(client.sites[0]).toMatchObject({
      addressLine: '12 Wattle St',
      suburb: expect.stringMatching(/^bayswater$/i),
      state: 'WA',
      postcode: '6053',
    })
    expect(messages(client, 'error')).toEqual([])
  })

  test('South Australia keeps its Australia; Australia after a postcode goes', () => {
    const spelt = one([
      ['Jo', '1 King William St, Adelaide, South Australia, 5000'],
    ])
    expect(spelt.sites[0]).toMatchObject({
      addressLine: '1 King William St',
      suburb: 'Adelaide',
      state: 'SA',
      postcode: '5000',
    })
    const country = one([
      ['Jo', '1 King William St, Adelaide SA 5000 Australia'],
    ])
    expect(country.sites[0]).toMatchObject({
      suburb: 'Adelaide',
      state: 'SA',
      postcode: '5000',
    })
  })

  test('a five-digit postcode is taken as the postcode, and an error', () => {
    const client = one([['Jo', '12 Wattle St, Bayswater WA 60530']])
    expect(client.sites[0]).toMatchObject({
      suburb: 'Bayswater',
      postcode: '60530',
    })
    expect(messages(client, 'error')).toEqual([
      `Postcode “60530” isn't 4 digits.`,
    ])
  })

  test('one-column address with a unit and an NT postcode missing its 0', () => {
    const client = one([['Jo', 'Unit 3, 12 Trower Rd, Casuarina NT 810']])
    expect(client.sites[0]).toMatchObject({
      addressLine: 'Unit 3, 12 Trower Rd',
      suburb: 'Casuarina',
      state: 'NT',
      postcode: '0810',
    })
  })

  test('Mount Victoria keeps its Victoria', () => {
    const client = one([['Jo', '12 Station St, Mount Victoria NSW 2786']])
    expect(client.sites[0]).toMatchObject({
      suburb: 'Mount Victoria',
      state: 'NSW',
    })
    const noState = one([['Jo', '12 Station St, Mount Victoria 2786']])
    expect(noState.sites[0]).toMatchObject({
      suburb: 'Mount Victoria',
      state: 'NSW',
    })
  })

  test('no comma before the suburb: an error, the line kept whole, a fix offered', () => {
    const client = one([['Jo', '12 Wattle St Bayswater WA 6053']])
    expect(client.sites[0]).toMatchObject({
      addressLine: '12 Wattle St Bayswater',
      suburb: '',
      state: 'WA',
      postcode: '6053',
    })
    const error = issue(client, /Couldn't tell the street from the suburb/)
    expect(error).toMatchObject({ level: 'error', siteIndex: 0 })
    expect(error.message).toBe(
      "Couldn't tell the street from the suburb in “12 Wattle St Bayswater” — edit it.",
    )
    // Said once, not again as "No suburb".
    expect(messages(client, 'error')).toHaveLength(1)
    expect(statusOf(client)).toBe('error')

    expect(error.fix?.label).toBe('Use 12 Wattle St, Bayswater')
    const fixed = recheckClient(error.fix!.apply(client), opts)
    expect(fixed.sites[0]).toMatchObject({
      addressLine: '12 Wattle St',
      suburb: 'Bayswater',
    })
    expect(messages(fixed, 'error')).toEqual([])
  })

  test('no fix is guessed where the street could stop in several places', () => {
    const client = one([['Jo', '5 St Kilda Rd St Kilda VIC 3182']])
    const error = issue(client, /Couldn't tell the street/)
    expect(error.fix).toBeUndefined()
  })

  test('once the suburb is typed in, the error goes', () => {
    const client = one([['Jo', '12 Wattle St Bayswater WA 6053']])
    const edited = recheckClient(
      {
        ...client,
        sites: [
          {
            ...client.sites[0],
            addressLine: '12 Wattle St',
            suburb: 'Bayswater',
          },
        ],
      },
      opts,
    )
    expect(messages(edited, 'error')).toEqual([])
    const stillBlank = recheckClient(
      {
        ...client,
        sites: [{ ...client.sites[0], addressLine: '12 Wattle St' }],
      },
      opts,
    )
    expect(messages(stillBlank, 'error')).toEqual(['No suburb.'])
  })

  test('a suburb column beside a one-column address that holds only the street', () => {
    const [client] = review(
      [
        ['Name', 'name'],
        ['Address', 'address'],
        ['Suburb', 'suburb'],
        ['Postcode', 'postcode'],
      ],
      [['Jo', 'Unit 3, 12 Wattle St', 'Bayswater', '6053']],
    )
    expect(client.sites[0]).toMatchObject({
      addressLine: 'Unit 3, 12 Wattle St',
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
    })
  })

  test('the blanks that stop a site', () => {
    const [client] = review(SPLIT, [['Jo', '', '', '', 'WA', '6053']])
    expect(messages(client, 'error')).toEqual([
      'No street address.',
      'No suburb.',
    ])
  })
})

describe('the name, and person or business', () => {
  const COLUMNS: Array<[string, ImportField]> = [
    ['Name', 'name'],
    ['First', 'firstName'],
    ['Last', 'lastName'],
    ['Company', 'company'],
    ['Contact', 'contactPerson'],
    ['Address', 'address'],
  ]
  const ADDRESS = '1 Hay St, Perth WA 6000'

  test.each([
    'Wattle Strata Pty Ltd',
    'Wattle P/L',
    'Smith Family Trust',
    'City of Bayswater Council',
    'Bayswater Primary School',
    'Owners Corporation 1234',
    'Body Corporate of 5 Beach Rd',
    'Harcourts Real Estate',
    'Smith Holdings',
    'Smith & Co',
    'St Mary’s Church',
    'Perth Bowls Club',
    'Ace Pest Services',
  ])('%s is a business', (name) => {
    const [client] = review(COLUMNS, [[name, '', '', '', '', ADDRESS]])
    expect(client.kind).toBe('business')
    expect(client.name).toBe(name)
  })

  test('a plain name is a person', () => {
    const [client] = review(COLUMNS, [['Jo Bloggs', '', '', '', '', ADDRESS]])
    expect(client.kind).toBe('person')
    expect(client.contactPerson).toBeUndefined()
  })

  test('first and last names make a person', () => {
    const [client] = review(COLUMNS, [['', 'Jo', 'Bloggs', '', '', ADDRESS]])
    expect(client).toMatchObject({ kind: 'person', name: 'Jo Bloggs' })
  })

  test('a name the file splits into first and last is a person, whatever it sounds like', () => {
    const [client] = review(COLUMNS, [
      ['Jane Church', 'Jane', 'Church', '', '', ADDRESS],
    ])
    expect(client.kind).toBe('person')
  })

  test('a company column makes a business, its person the contact', () => {
    const [client] = review(COLUMNS, [
      ['', 'Jo', 'Bloggs', 'Wattle Bakery', '', ADDRESS],
    ])
    expect(client).toMatchObject({
      kind: 'business',
      name: 'Wattle Bakery',
      contactPerson: 'Jo Bloggs',
    })
  })

  test('a contact person column wins over first and last', () => {
    const [client] = review(COLUMNS, [
      ['', 'Jo', 'Bloggs', 'Wattle Bakery', 'Ann Lee', ADDRESS],
    ])
    expect(client.contactPerson).toBe('Ann Lee')
  })

  test('a name column beside a company column is the contact', () => {
    const [client] = review(COLUMNS, [
      ['Jo Bloggs', '', '', 'Wattle Bakery', '', ADDRESS],
    ])
    expect(client).toMatchObject({
      kind: 'business',
      name: 'Wattle Bakery',
      contactPerson: 'Jo Bloggs',
    })
  })

  test("a business whose name is its person's has no separate contact", () => {
    const [client] = review(COLUMNS, [
      ['Jo Bloggs', 'Jo', 'Bloggs', 'Jo Bloggs', '', ADDRESS],
    ])
    expect(client.kind).toBe('business')
    expect(client.contactPerson).toBeUndefined()
  })

  test('"Is a company?" saying no beats a name that sounds like one', () => {
    for (const flag of ['false', 'No', 'Residential', 'Individual']) {
      const [client] = review(
        [
          ['Name', 'name'],
          ['Is Company?', 'isCompany'],
          ['Address', 'address'],
        ],
        [['Smith Family Trust', flag, ADDRESS]],
      )
      expect(client.kind).toBe('person')
    }
  })

  test('"Is a company?" set, and a "Commercial" customer type', () => {
    for (const flag of ['true', 'Yes', 'Commercial', 'TRUE']) {
      const [client] = review(
        [
          ['Name', 'name'],
          ['Is Company?', 'isCompany'],
          ['Address', 'address'],
        ],
        [['Wattle Bakery', flag, ADDRESS]],
      )
      expect(client.kind).toBe('business')
    }
  })

  test("MYOB's Co./Last Name with no first name is a company", () => {
    const columns: Array<[string, ImportField]> = [
      ['Co./Last Name', 'lastName'],
      ['First Name', 'firstName'],
      ['Address', 'address'],
    ]
    const [company, person] = review(columns, [
      ['Wattle Bakery', '', ADDRESS],
      ['Smith', 'Jo', '2 Hay St, Perth WA 6000'],
    ])
    expect(company).toMatchObject({ kind: 'business', name: 'Wattle Bakery' })
    expect(person).toMatchObject({ kind: 'person', name: 'Jo Smith' })
  })

  test("site contacts are a business's only", () => {
    const columns: Array<[string, ImportField]> = [
      ['Name', 'name'],
      ['Address', 'address'],
      ['Site contact', 'siteContactName'],
      ['Site phone', 'siteContactPhone'],
    ]
    const [business, person] = review(columns, [
      ['Wattle Strata Pty Ltd', ADDRESS, 'Caretaker Col', '433222111'],
      ['Jo Bloggs', '2 Hay St, Perth WA 6000', 'Tenant', '0433 222 111'],
    ])
    expect(business.sites[0]).toMatchObject({
      siteContactName: 'Caretaker Col',
      siteContactPhone: '0433 222 111',
    })
    expect(messages(business, 'fixed')).toEqual([
      'Phone 433222111 → 0433 222 111',
    ])
    expect(person.sites[0].siteContactName).toBeUndefined()
    expect(person.sites[0].siteContactPhone).toBeUndefined()
  })
})

describe('phone numbers', () => {
  const PHONES: Array<[string, ImportField]> = [
    ['Name', 'name'],
    ['Address', 'address'],
    ['Phone', 'phone'],
    ['Mobile', 'mobile'],
  ]
  const ADDRESS = '1 Hay St, Perth WA 6000'

  test("a mobile's lost 0 goes back", () => {
    const client = one([['Jo', ADDRESS, '412345678']])
    expect(client.phone).toBe('0412 345 678')
    expect(client.issues).toEqual([
      expect.objectContaining({
        level: 'fixed',
        field: 'phone',
        message: 'Phone 412345678 → 0412 345 678',
      }),
    ])
  })

  test("and a landline's", () => {
    const client = one([['Jo', ADDRESS, '892711234']])
    expect(client.phone).toBe('08 9271 1234')
  })

  test('the mobile is the one kept', () => {
    const [client] = review(PHONES, [
      ['Jo', ADDRESS, '08 9271 1234', '0412 345 678'],
    ])
    expect(client.phone).toBe('0412 345 678')
  })

  test("unless it can't be dialled and the other can", () => {
    const [client] = review(PHONES, [
      ['Jo', ADDRESS, '08 9271 1234', 'call Jo'],
    ])
    expect(client.phone).toBe('08 9271 1234')
  })

  test('several numbers in one cell: the first', () => {
    const client = one([['Jo', ADDRESS, '0412 345 678, 08 9271 1234']])
    expect(client.phone).toBe('0412 345 678')
    expect(messages(client, 'fixed')).toEqual([
      '2 numbers in the file — kept the first.',
    ])
  })

  test('a number with letters in: an error, and a fix that leaves it out', () => {
    const client = one([['Jo', ADDRESS, '0412 345 678 (Jo)']])
    const error = issue(client, /^Phone “0412 345 678 \(Jo\)”/)
    expect(error.level).toBe('error')
    expect(error.fix?.label).toBe('Leave the phone out')
    const fixed = recheckClient(error.fix!.apply(client), opts)
    expect(fixed.phone).toBeUndefined()
    expect(statusOf(fixed)).toBe('ready')
  })

  test('an extension on its own: an error, as the server refuses one', () => {
    const client = one([['Jo', ADDRESS, 'x21']])
    const error = issue(
      client,
      'Phone “x21”: That is too short for a phone number.',
    )
    expect(error.level).toBe('error')
    expect(error.fix?.label).toBe('Leave the phone out')
    expect(checkImportClient(toImportClient(client)).ok).toBe(false)
    // As a mobile, the landline beside it is used instead.
    const [both] = review(PHONES, [['Jo', ADDRESS, '08 9271 1234', 'x21']])
    expect(both.phone).toBe('08 9271 1234')
  })

  test('a local number with no area code: a warning, with it as the fix', () => {
    const client = one([['Jo', ADDRESS, '9271 1234']])
    const warning = issue(client, /Missing the area code/)
    expect(warning.level).toBe('warning')
    expect(warning.fix?.label).toBe('Use 08 9271 1234')
    expect(statusOf(client)).toBe('warning')
  })

  test('Excel exponents: written out when whole, an error when digits were lost', () => {
    const whole = one([['Jo', ADDRESS, '4.12345678E+08']])
    expect(whole.phone).toBe('0412 345 678')
    const lost = one([['Jo', ADDRESS, '4.12346E+08']])
    expect(lost.phone).toBe('4.12346E+08')
    const error = issue(lost, /Excel shortened this number/)
    expect(error).toMatchObject({ level: 'error', field: 'phone' })
    expect(error.fix?.label).toBe('Leave the phone out')
  })
})

describe('emails and ABNs', () => {
  const ADDRESS = '1 Hay St, Perth WA 6000'

  test('several emails: the first, and saying so', () => {
    for (const cell of [
      'jo@example.com; accounts@example.com',
      'jo@example.com, accounts@example.com',
      'jo@example.com accounts@example.com',
      'Jo Bloggs <jo@example.com>, <accounts@example.com>',
    ]) {
      const client = one([['Jo', ADDRESS, '', cell]])
      expect(client.email).toBe('jo@example.com')
      expect(messages(client, 'fixed')).toEqual([
        '2 emails in the file — kept the first, jo@example.com.',
      ])
    }
  })

  test('a typo in a common domain: a warning with the fix', () => {
    const client = one([['Jo', ADDRESS, '', 'jo@gmial.com']])
    const warning = issue(client, /did you mean/)
    expect(warning).toMatchObject({ level: 'warning', field: 'email' })
    expect(warning.fix?.label).toBe('Use jo@gmail.com')
    const fixed = recheckClient(warning.fix!.apply(client), opts)
    expect(fixed.email).toBe('jo@gmail.com')
    expect(fixed.issues).toEqual([])
  })

  test('an address that can never be delivered to: an error', () => {
    const client = one([['Jo', ADDRESS, '', 'jo@gmail']])
    const error = issue(client, /^Email “jo@gmail”/)
    expect(error.level).toBe('error')
    expect(error.fix?.label).toBe('Leave the email out')
  })

  const ABN: Array<[string, ImportField]> = [
    ['Company', 'company'],
    ['Name', 'name'],
    ['Address', 'address'],
    ['ABN', 'abn'],
  ]

  test("a business's ABN, spaced or as Excel's number", () => {
    for (const abn of [
      '51 824 753 556',
      '51824753556',
      'ABN: 51 824 753 556',
      '5.1824753556E+10',
    ]) {
      const [client] = review(ABN, [['Wattle Bakery', '', ADDRESS, abn]])
      expect(client.abn).toBe('51824753556')
      expect(messages(client, 'error')).toEqual([])
    }
  })

  test('an ABN that fails the ATO check: an error with a fix', () => {
    const [client] = review(ABN, [
      ['Wattle Bakery', '', ADDRESS, '51 824 753 557'],
    ])
    const error = issue(client, /ATO's check/)
    expect(error).toMatchObject({ level: 'error', field: 'abn' })
    expect(error.fix?.label).toBe('Leave the ABN out')
    const fixed = recheckClient(error.fix!.apply(client), opts)
    expect(fixed.abn).toBeUndefined()
    expect(statusOf(fixed)).toBe('ready')
  })

  test('a real ABN says a business, whatever the name', () => {
    const [client] = review(ABN, [['', 'Jo Bloggs', ADDRESS, '51 824 753 556']])
    expect(client).toMatchObject({
      kind: 'business',
      name: 'Jo Bloggs',
      abn: '51824753556',
    })
  })

  test('a person with an ABN: left out, saying so, with a way back', () => {
    const columns: Array<[string, ImportField]> = [
      ['Name', 'name'],
      ['Is Company?', 'isCompany'],
      ['Address', 'address'],
      ['ABN', 'abn'],
    ]
    const [client] = review(columns, [
      ['Jo Bloggs', 'false', ADDRESS, '51 824 753 556'],
    ])
    expect(client.kind).toBe('person')
    expect(client.abn).toBeUndefined()
    const note = issue(client, /a person has none/)
    expect(note).toMatchObject({ level: 'fixed', field: 'abn' })
    expect(note.message).toBe(
      'Left out the ABN 51 824 753 556 — a person has none.',
    )

    const business = recheckClient(note.fix!.apply(client), opts)
    expect(business).toMatchObject({ kind: 'business', abn: '51824753556' })
    expect(business.issues).toEqual([])
  })

  test("an ABN that isn't one doesn't make a business", () => {
    const [client] = review(ABN, [['', 'Jo Bloggs', ADDRESS, '1234']])
    expect(client.kind).toBe('person')
    expect(messages(client, 'fixed')).toEqual([
      'Left out the ABN 1234 — a person has none.',
    ])
  })
})

describe('what PestM8 already holds', () => {
  const clientId = 'client1' as Id<'clients'>
  const existing: ExistingIndex = {
    clientsByName: new Map([['wattle strata pty ltd', clientId]]),
    siteKeys: new Set([
      siteKey({
        addressLine: '12 Wattle Street',
        suburb: 'Bayswater',
        postcode: '6053',
      }),
    ]),
  }

  test('a site already here is flagged, and a client of the same name found', () => {
    const clients = review(
      PLAIN,
      [
        ['Wattle Strata P/L', '12 Wattle St, Bayswater WA 6053'],
        ['Wattle Strata P/L', '14 Wattle St, Bayswater WA 6053'],
        ['Jo Bloggs', '12 wattle st., BAYSWATER WA 6053'],
      ],
      { existing },
    )
    expect(clients).toHaveLength(2)
    const [strata, jo] = clients
    // "P/L" is not "Pty Ltd" to nameKey: a different name.
    expect(strata.existingClientId).toBeUndefined()
    expect(strata.sites.map((s) => s.duplicate ?? false)).toEqual([true, false])
    expect(statusOf(strata)).toBe('ready')
    expect(jo.sites[0].duplicate).toBe(true)
    expect(statusOf(jo)).toBe('duplicate')
  })

  test('a client of the same name gets new sites added', () => {
    const [client] = review(
      PLAIN,
      [['Wattle Strata Pty. Ltd.', '14 Wattle St, Bayswater WA 6053']],
      { existing },
    )
    expect(client.existingClientId).toBe(clientId)
    expect(toImportClient(client).existingClientId).toBe(clientId)
  })

  test('a renamed client is matched again, or not', () => {
    const [client] = review(
      PLAIN,
      [['Jo', '14 Wattle St, Bayswater WA 6053']],
      {
        existing,
      },
    )
    expect(client.existingClientId).toBeUndefined()
    const renamed = recheckClient(
      { ...client, name: 'Wattle Strata Pty Ltd' },
      {
        businessState: 'WA',
        existing,
      },
    )
    expect(renamed.existingClientId).toBe(clientId)
    const back = recheckClient(
      { ...renamed, name: 'Jo' },
      { businessState: 'WA', existing },
    )
    expect(back.existingClientId).toBeUndefined()
  })
})

describe('recheckClient', () => {
  test('a note of what was fixed stays while the field holds that value', () => {
    const client = one([['Jo', '1 Casuarina Dr, Nightcliff NT 810']])
    expect(messages(client, 'fixed')).toEqual(['Postcode 810 → 0810'])
    const again = recheckClient(client, opts)
    expect(messages(again, 'fixed')).toEqual(['Postcode 810 → 0810'])
    const edited = recheckClient(
      { ...client, sites: [{ ...client.sites[0], postcode: '0820' }] },
      opts,
    )
    expect(messages(edited)).toEqual([])
  })

  test('an edit that breaks something shows it', () => {
    const client = one([['Jo', '1 Hay St, Perth WA 6000']])
    const edited = recheckClient(
      { ...client, email: 'jo@', phone: 'abc' },
      opts,
    )
    expect(edited.issues.map((i) => [i.level, i.field])).toEqual([
      ['error', 'phone'],
      ['error', 'email'],
    ])
  })
})

describe('what is sent', () => {
  test("a reviewed client passes the server's own rules", () => {
    const [client] = review(
      [
        ['Company', 'company'],
        ['Contact', 'contactPerson'],
        ['Mobile', 'mobile'],
        ['Email', 'email'],
        ['ABN', 'abn'],
        ['Address', 'address'],
        ['Site contact', 'siteContactName'],
        ['Site phone', 'siteContactPhone'],
        ['Notes', 'notes'],
      ],
      [
        [
          'Wattle Strata Pty Ltd',
          'Jo Bloggs',
          '412345678',
          'office@wattle.com.au',
          '51824753556',
          '12 Wattle St, Bayswater WA 6053',
          'Col',
          '0433 222 111',
          'Gate code 1234',
        ],
      ],
    )
    const sent = toImportClient(client)
    expect(sent).toEqual({
      key: 'c1',
      kind: 'business',
      name: 'Wattle Strata Pty Ltd',
      contactPerson: 'Jo Bloggs',
      phone: '0412 345 678',
      email: 'office@wattle.com.au',
      abn: '51824753556',
      sites: [
        {
          addressLine: '12 Wattle St',
          suburb: 'Bayswater',
          state: 'WA',
          postcode: '6053',
          siteContactName: 'Col',
          siteContactPhone: '0433 222 111',
          note: 'Gate code 1234',
        },
      ],
    })
    expect(checkImportClient(sent).ok).toBe(true)
  })
})
