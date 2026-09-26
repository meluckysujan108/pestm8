import { describe, expect, test } from 'vitest'
import { checkImportClient, siteKey } from '../../../convex/lib/clientImport'
import {
  buildReview,
  checkAcrossClients,
  duplicateSiteMessage,
  recheckClient,
} from './build'
import { importable, statusOf, toImportClient } from './convert'
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
  opts: {
    businessState?: string
    existing?: ExistingIndex
    sourceRows?: Array<number>
  } = {},
): Array<ReviewClient> {
  const mapping: ColumnMapping = columns.map(([, field]) => field)
  return buildReview(
    {
      fileName: 'clients.csv',
      headers: columns.map(([h]) => h),
      rows: rows.map((r) => columns.map((_, i) => r[i] ?? '')),
      ...(opts.sourceRows ? { sourceRows: opts.sourceRows } : {}),
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

  test("a row joins a client by any of its rows' email or phone, not only the first's", () => {
    const clients = review(PLAIN, [
      ['Acme Strata', '1 Hay St, Perth WA 6000', '', 'a@acme.com'],
      ['Acme Strata', '2 Hay St, Perth WA 6000', '08 9222 1111', 'a@acme.com'],
      ['Acme Strata', '3 Hay St, Perth WA 6000', '08 9222 1111'],
    ])
    expect(clients.map((c) => c.rowNumbers)).toEqual([[1, 2, 3]])
  })

  test('a row with the ids of two clients says they are one: the rows join the earlier', () => {
    const clients = review(PLAIN, [
      ['Jo', '1 Hay St, Perth WA 6000', '0412 345 678'],
      ['Jo', '2 Hay St, Perth WA 6000', '', 'jo@example.com'],
      ['Jo', '3 Hay St, Perth WA 6000', '0412 345 678', 'jo@example.com'],
      ['Jo', '4 Hay St, Perth WA 6000', '', 'jo@example.com'],
    ])
    expect(clients.map((c) => c.rowNumbers)).toEqual([[1, 2, 3, 4]])
    expect(clients[0]).toMatchObject({
      key: 'c1',
      phone: '0412 345 678',
      email: 'jo@example.com',
    })
  })

  test('the row that links two clients can come last', () => {
    const clients = review(PLAIN, [
      ['Acme Strata', '1 Hay St, Perth WA 6000', '', 'a@acme.com'],
      ['Acme Strata', '2 Hay St, Perth WA 6000', '08 9222 1111'],
      ['Acme Strata', '3 Hay St, Perth WA 6000', '08 9222 1111', 'a@acme.com'],
    ])
    expect(clients).toHaveLength(1)
    expect(clients[0]).toMatchObject({
      key: 'c1',
      rowNumbers: [1, 2, 3],
      phone: '08 9222 1111',
      email: 'a@acme.com',
    })
    expect(clients[0].sites).toHaveLength(3)
  })

  test('links found late join whole chains, and every client keeps its place and key', () => {
    const clients = review(PLAIN, [
      ['Acme Strata', '1 Hay St, Perth WA 6000', '', 'a@acme.com'],
      ['Ann Lee', '1 Rose St, Perth WA 6000', '0400 111 222'],
      ['Acme Strata', '2 Hay St, Perth WA 6000', '08 9222 1111'],
      ['Acme Strata', '3 Hay St, Perth WA 6000', '', 'b@acme.com'],
      ['Bob Lee', '2 Rose St, Perth WA 6000', '0400 333 444'],
      // Links the second and third Acme; then this links them to the first.
      ['Acme Strata', '4 Hay St, Perth WA 6000', '08 9222 1111', 'b@acme.com'],
      ['Acme Strata', '5 Hay St, Perth WA 6000', '08 9222 1111', 'a@acme.com'],
      ['Acme Strata', '6 Hay St, Perth WA 6000', '', 'b@acme.com'],
      ['Acme Strata', '7 Hay St, Perth WA 6000', '08 9999 0000'],
    ])
    expect(clients.map((c) => [c.key, c.rowNumbers])).toEqual([
      ['c1', [1, 3, 4, 6, 7, 8]],
      ['c2', [2]],
      ['c5', [5]],
      ['c9', [9]],
    ])
    // The earliest row's email and phone are the client's.
    expect(clients[0]).toMatchObject({
      email: 'a@acme.com',
      phone: '08 9222 1111',
    })
    expect(clients[0].sites.map((s) => s.addressLine)).toEqual([
      '1 Hay St',
      '2 Hay St',
      '3 Hay St',
      '4 Hay St',
      '5 Hay St',
      '6 Hay St',
    ])
  })

  test('rows with no email or phone join the first of their name that had none', () => {
    const clients = review(PLAIN, [
      ['Jo', '1 Hay St, Perth WA 6000'],
      ['Jo', '2 Hay St, Perth WA 6000', '0412 345 678'],
      ['Jo', '3 Hay St, Perth WA 6000'],
    ])
    expect(clients.map((c) => c.rowNumbers)).toEqual([[1, 3], [2]])
  })

  test('a phone written +61 and 04 is one number', () => {
    const clients = review(PLAIN, [
      ['Jane Citizen', '12 Wattle St, Bayswater WA 6053', '0412 345 678'],
      ['Jane Citizen', '9 Rose St, Bayswater WA 6053', '+61 412 345 678'],
    ])
    expect(clients.map((c) => c.rowNumbers)).toEqual([[1, 2]])
    expect(clients[0].sites).toHaveLength(2)
  })

  test('many rows of one name, each its own phone: each its own client', () => {
    const rows = Array.from({ length: 2000 }, (_, i) => [
      'Ray White',
      `${i + 1} Hay St, Perth WA 6000`,
      `0400 ${String(i).padStart(6, '0')}`,
    ])
    rows.push(['Ray White', '1 Beach Rd, Perth WA 6000', '0400 000 000'])
    const clients = review(PLAIN, rows)
    expect(clients).toHaveLength(2000)
    expect(clients[0].rowNumbers).toEqual([1, 2001])
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

  const PO_BOX =
    'A PO box isn’t a place to visit — use the property’s street address.'

  test.each([
    'PO Box 123',
    'P.O. Box 123',
    'P O Box 123',
    'POBox 123',
    'GPO Box 1',
    'Post Office Box 5',
    'Locked Bag 5',
    'Locked Mail Bag 5',
    'Private Bag 3',
  ])('%s is a warning, with no fix when it is the only site', (line) => {
    const [client] = review(SPLIT, [
      ['Jo', line, '', 'Bayswater', 'WA', '6053'],
    ])
    const warning = issue(client, PO_BOX)
    expect(warning).toMatchObject({
      level: 'warning',
      field: 'addressLine',
      siteIndex: 0,
    })
    expect(warning.fix).toBeUndefined()
    expect(statusOf(client)).toBe('warning')
  })

  test.each(['12 Post Office Rd', '3 Pottery Box Ct', '1 Lockyer St'])(
    '%s is a street',
    (line) => {
      const [client] = review(SPLIT, [
        ['Jo', line, '', 'Bayswater', 'WA', '6053'],
      ])
      expect(messages(client)).toEqual([])
    },
  )

  test('a PO box beside a street address: a fix that leaves it out', () => {
    const [client] = review(SPLIT, [
      ['Jo', 'PO Box 12', '', 'Bayswater', 'WA', '6053'],
      ['Jo', '1 Casuarina Dr', '', 'Nightcliff', 'NT', '810'],
    ])
    expect(client.sites).toHaveLength(2)
    const warning = issue(client, PO_BOX)
    expect(warning.fix?.label).toBe('Leave this site out')
    const fixed = recheckClient(warning.fix!.apply(client), opts)
    expect(fixed.sites).toEqual([
      expect.objectContaining({ addressLine: '1 Casuarina Dr' }),
    ])
    // What was said of the site after it moves down with it.
    expect(fixed.issues).toEqual([
      expect.objectContaining({
        level: 'fixed',
        siteIndex: 0,
        message: 'Postcode 810 → 0810',
      }),
    ])
    expect(statusOf(fixed)).toBe('fixed')
  })
})

describe('site notes', () => {
  test('a note longer than the server keeps: a warning, gone once shortened', () => {
    const note = 'Termite bait station check. '.repeat(250).trim()
    expect(note.length).toBe(6999)
    const client = one([['Jo', '1 Hay St, Perth WA 6000', '', '', note]])
    expect(client.sites[0].note).toBe(note)
    expect(issue(client, /^This note is/)).toMatchObject({
      level: 'warning',
      field: 'note',
      siteIndex: 0,
      message:
        'This note is 6,999 characters — only the first 5,000 come across.',
    })
    const shortened = recheckClient(
      { ...client, sites: [{ ...client.sites[0], note: note.slice(0, 5000) }] },
      opts,
    )
    expect(shortened.issues).toEqual([])
  })

  test('notes joined from two rows are judged together', () => {
    const half = 'x'.repeat(3000)
    const client = one([
      ['Jo', '1 Hay St, Perth WA 6000', '', '', half],
      ['Jo', '1 Hay Street, Perth WA 6000', '', '', `${half}y`],
    ])
    expect(messages(client, 'warning')).toEqual([
      'This note is 6,003 characters — only the first 5,000 come across.',
    ])
  })

  test('counted in whole characters, as the server cuts it: an emoji is one', () => {
    const ant = '🐜'
    const fits = one([
      ['Jo', '1 Hay St, Perth WA 6000', '', '', ant.repeat(5000)],
    ])
    expect(fits.issues).toEqual([])
    const over = one([
      ['Jo', '1 Hay St, Perth WA 6000', '', '', ant.repeat(5001)],
    ])
    expect(messages(over, 'warning')).toEqual([
      'This note is 5,001 characters — only the first 5,000 come across.',
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
    // A person's are kept, unsent, for a flip to Business.
    expect(toImportClient(person).sites[0]).not.toHaveProperty(
      'siteContactName',
    )
    expect(toImportClient(person).sites[0]).not.toHaveProperty(
      'siteContactPhone',
    )
    const flipped = recheckClient({ ...person, kind: 'business' }, opts)
    expect(toImportClient(flipped).sites[0]).toMatchObject({
      siteContactName: 'Tenant',
      siteContactPhone: '0433 222 111',
    })
  })

  const JOBBER: Array<[string, ImportField]> = [
    ['Display Name', 'name'],
    ['Company Name', 'company'],
    ['First Name', 'firstName'],
    ['Last Name', 'lastName'],
    ['Is Company?', 'isCompany'],
    ['Service Street 1', 'street'],
    ['Service City', 'suburb'],
    ['Service State', 'state'],
    ['Service Zip code', 'postcode'],
  ]

  test('"Is Company?" false beats a Company Name: the person, by their own name', () => {
    const agency = 'agency' as Id<'clients'>
    const clients = review(
      JOBBER,
      [
        [
          'Jane Smith',
          'Ray White Bayswater',
          'Jane',
          'Smith',
          'false',
          '12 Wattle St',
          'Bayswater',
          'WA',
          '6053',
        ],
        [
          'Tom Brown',
          'Ray White Bayswater',
          'Tom',
          'Brown',
          'false',
          '14 Wattle St',
          'Bayswater',
          'WA',
          '6053',
        ],
      ],
      {
        existing: {
          clientsByName: new Map([['ray white bayswater', agency]]),
          siteKeys: new Set(),
        },
      },
    )
    expect(clients.map((c) => [c.kind, c.name])).toEqual([
      ['person', 'Jane Smith'],
      ['person', 'Tom Brown'],
    ])
    expect(clients.map((c) => c.existingClientId)).toEqual([
      undefined,
      undefined,
    ])
  })

  test('"Is Company?" false with only a company: named after it all the same', () => {
    const [client] = review(JOBBER, [
      [
        '',
        'Ray White',
        '',
        '',
        'false',
        '12 Wattle St',
        'Bayswater',
        'WA',
        '6053',
      ],
    ])
    expect(client).toMatchObject({ kind: 'person', name: 'Ray White' })
    expect(messages(client, 'error')).toEqual([])
  })

  const XERO: Array<[string, ImportField]> = [
    ['*ContactName', 'name'],
    ['FirstName', 'firstName'],
    ['LastName', 'lastName'],
    ['SAAddressLine1', 'street'],
    ['SACity', 'suburb'],
    ['SARegion', 'state'],
    ['SAPostalCode', 'postcode'],
  ]

  test('a name that shares no word with its first and last is a business, and they its contact', () => {
    const [motel, coles] = review(XERO, [
      ['Bayview Motel', 'Bob', 'Jones', '1 Hay St', 'Perth', 'WA', '6000'],
      ['Coles Morley', 'Sue', 'Lee', '2 Hay St', 'Perth', 'WA', '6000'],
    ])
    expect(motel).toMatchObject({
      kind: 'business',
      name: 'Bayview Motel',
      contactPerson: 'Bob Jones',
    })
    expect(coles).toMatchObject({
      kind: 'business',
      name: 'Coles Morley',
      contactPerson: 'Sue Lee',
    })
  })

  test('"John & Mary Smith" beside John Smith is a person; the contact kept for a flip', () => {
    const [client] = review(XERO, [
      ['John & Mary Smith', 'John', 'Smith', '1 Hay St', 'Perth', 'WA', '6000'],
    ])
    expect(client).toMatchObject({ kind: 'person', name: 'John & Mary Smith' })
    expect(toImportClient(client)).not.toHaveProperty('contactPerson')
    const flipped = recheckClient({ ...client, kind: 'business' }, opts)
    expect(toImportClient(flipped).contactPerson).toBe('John Smith')
  })

  test('"Is Company?" false beats a name apart from its first and last', () => {
    const [client] = review(
      [...XERO, ['Is Company?', 'isCompany']],
      [
        [
          'Bayview Motel',
          'Bob',
          'Jones',
          '1 Hay St',
          'Perth',
          'WA',
          '6000',
          'No',
        ],
      ],
    )
    expect(client).toMatchObject({ kind: 'person', name: 'Bayview Motel' })
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

  test.each([
    ['61412345678', '0412 345 678'],
    ['+61 412 345 678', '0412 345 678'],
    ['0061 412 345 678', '0412 345 678'],
    ['61 8 9321 1234', '08 9321 1234'],
    ['+61 (0)8 9321 1234', '08 9321 1234'],
  ])('+61 as Excel leaves it, %j: written as dialled here', (cell, stored) => {
    const client = one([['Jo', ADDRESS, cell]])
    expect(client.phone).toBe(stored)
    expect(client.issues).toEqual([
      expect.objectContaining({
        level: 'fixed',
        field: 'phone',
        message: `Phone ${cell} → ${stored}`,
      }),
    ])
    const sent = checkImportClient(toImportClient(client))
    expect(sent.ok && sent.client.phone).toBe(stored)
  })

  test("another country's number is kept as it is", () => {
    const client = one([['Jo', ADDRESS, '+44 20 7946 0958']])
    expect(client.phone).toBe('+44 20 7946 0958')
    expect(client.issues).toEqual([])
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

  test("a site on another client says whose it is; the client's own doesn't", () => {
    const at = siteKey({
      addressLine: '1 Rose Street',
      suburb: 'Bayswater',
      postcode: '6053',
    })
    const withHolders: ExistingIndex = {
      clientsByName: new Map([['jane doe', 'jane' as Id<'clients'>]]),
      siteKeys: new Set([at]),
      siteHolders: new Map([[at, 'Jane Doe']]),
    }
    const [john, jane] = review(
      PLAIN,
      [
        ['John Smith', '1 Rose St, Bayswater WA 6053'],
        ['Jane Doe', '1 Rose St, Bayswater WA 6053', '0412 345 678'],
      ],
      { existing: withHolders },
    )
    expect(john.sites[0]).toMatchObject({ duplicate: true, heldBy: 'Jane Doe' })
    expect(duplicateSiteMessage(john.sites[0])).toBe(
      'Already in PestM8, on Jane Doe — this site is skipped',
    )
    expect(jane.sites[0].duplicate).toBe(true)
    expect(jane.sites[0].heldBy).toBeUndefined()
    expect(duplicateSiteMessage(jane.sites[0])).toBe(
      'Already in PestM8 — this site is skipped',
    )
    // Not sent, and gone once the address is changed.
    expect(toImportClient(john).sites).toEqual([])
    const moved = recheckClient(
      {
        ...john,
        sites: [{ ...john.sites[0], addressLine: '3 Rose St' }],
      },
      { businessState: 'WA', existing: withHolders },
    )
    expect(moved.sites[0]).not.toHaveProperty('heldBy')
    expect(moved.sites[0]).not.toHaveProperty('duplicate')
  })
})

describe('checks across clients', () => {
  const SAME = 'an address can only belong to one client in PestM8.'

  test('two clients at one address: the later one, with nothing else to send, is an error', () => {
    const clients = review(PLAIN, [
      ['Old Owner', '12 Wattle St, Bayswater WA 6053', '0412 345 678'],
      ['New Owner', '12 Wattle Street, Bayswater WA 6053', '0499 888 777'],
    ])
    const [old, owner] = clients
    expect(old.issues).toEqual([])
    expect(statusOf(old)).toBe('ready')
    expect(owner.issues).toEqual([
      expect.objectContaining({
        level: 'error',
        field: 'addressLine',
        siteIndex: 0,
        message: `Same address as Old Owner (row 2) — ${SAME}`,
      }),
    ])
    expect(statusOf(owner)).toBe('error')
  })

  test('a later client with another site to send: a warning on the shared one, its note named', () => {
    const [jane, trust] = review(PLAIN, [
      ['Jane Citizen', '12 Wattle Street, Bayswater WA 6053'],
      [
        'Citizen Family Trust',
        '12 Wattle Street, Bayswater WA 6053',
        '',
        '',
        'Gate code 4321',
      ],
      ['Citizen Family Trust', '9 Rose Street, Bayswater WA 6053'],
    ])
    expect(jane.issues).toEqual([])
    expect(trust.sites).toHaveLength(2)
    expect(trust.issues).toEqual([
      expect.objectContaining({
        level: 'warning',
        field: 'addressLine',
        siteIndex: 0,
        message:
          'Same address as Jane Citizen (row 2) — this site and its note will be skipped.',
      }),
    ])
    expect(statusOf(trust)).toBe('warning')
  })

  test('a client left out gives up its address', () => {
    const clients = review(PLAIN, [
      ['Old Owner', '12 Wattle St, Bayswater WA 6053', '0412 345 678'],
      ['New Owner', '12 Wattle St, Bayswater WA 6053', '0499 888 777'],
    ])
    const [old, owner] = checkAcrossClients([
      { ...clients[0], included: false },
      clients[1],
    ])
    expect(old.issues).toEqual([])
    expect(owner.issues).toEqual([])
    expect(statusOf(owner)).toBe('ready')
    // And takes it back when brought back in.
    const again = checkAcrossClients([{ ...old, included: true }, owner])
    expect(statusOf(again[1])).toBe('error')
  })

  test('a site already in PestM8 claims nothing, and is claimed by nothing', () => {
    const at = siteKey({
      addressLine: '12 Wattle St',
      suburb: 'Bayswater',
      postcode: '6053',
    })
    const clients = review(
      PLAIN,
      [
        ['Old Owner', '12 Wattle St, Bayswater WA 6053', '0412 345 678'],
        ['New Owner', '12 Wattle St, Bayswater WA 6053', '0499 888 777'],
      ],
      { existing: { clientsByName: new Map(), siteKeys: new Set([at]) } },
    )
    expect(clients.map(statusOf)).toEqual(['duplicate', 'duplicate'])
    expect(clients.flatMap((c) => c.issues)).toEqual([])
  })

  test('two clients the review keeps apart that would join one client in PestM8: a warning on each', () => {
    const john = 'john' as Id<'clients'>
    const clients = review(
      PLAIN,
      [
        ['John Smith', '1 Hay St, Perth WA 6000', '0412 345 678'],
        ['Ann Lee', '2 Hay St, Perth WA 6000'],
        ['John Smith', '3 Hay St, Perth WA 6000', '0499 888 777'],
      ],
      {
        existing: {
          clientsByName: new Map([['john smith', john]]),
          siteKeys: new Set(),
        },
      },
    )
    const [first, ann, second] = clients
    expect(first.existingClientId).toBe(john)
    expect(second.existingClientId).toBe(john)
    expect(messages(first)).toEqual([
      'Also matched: John Smith (row 4) — both would be added to the same client in PestM8. Leave one out if they’re different people.',
    ])
    expect(messages(second)).toEqual([
      'Also matched: John Smith (row 2) — both would be added to the same client in PestM8. Leave one out if they’re different people.',
    ])
    expect(issue(first, /^Also matched/)).toMatchObject({
      level: 'warning',
      field: 'name',
    })
    expect(ann.issues).toEqual([])
    // Left out, the other is on its own again.
    const [, , alone] = checkAcrossClients([
      { ...first, included: false },
      ann,
      second,
    ])
    expect(alone.issues).toEqual([])
  })

  test('many matched to one client: two named, the rest counted', () => {
    const john = 'john' as Id<'clients'>
    const clients = review(
      PLAIN,
      Array.from({ length: 4 }, (_, i) => [
        'John Smith',
        `${i + 1} Hay St, Perth WA 6000`,
        `0412 345 67${i}`,
      ]),
      {
        existing: {
          clientsByName: new Map([['john smith', john]]),
          siteKeys: new Set(),
        },
      },
    )
    expect(clients).toHaveLength(4)
    expect(messages(clients[0])).toEqual([
      'Also matched: John Smith (row 3), John Smith (row 4) and 1 more — all 4 would be added to the same client in PestM8. Leave out any that are different people.',
    ])
    expect(messages(clients[3])).toEqual([
      'Also matched: John Smith (row 2), John Smith (row 3) and 1 more — all 4 would be added to the same client in PestM8. Leave out any that are different people.',
    ])
  })

  test('idempotent with several issues on one client: the same clients back', () => {
    const clients = review(
      PLAIN,
      [
        ['John Smith', '12 Wattle St, Bayswater WA 6053', '0412 345 678'],
        ['John Smith', '12 Wattle St, Bayswater WA 6053', '0499 888 777'],
        ['John Smith', '5 Beach Rd, Scarborough WA 6019', '0499 888 777'],
      ],
      {
        existing: {
          clientsByName: new Map([['john smith', 'john' as Id<'clients'>]]),
          siteKeys: new Set(),
        },
      },
    )
    expect(clients[1].issues.map((i) => [i.field, i.siteIndex])).toEqual([
      ['name', undefined],
      ['addressLine', 0],
    ])
    const again = checkAcrossClients(clients)
    expect(again[0]).toBe(clients[0])
    expect(again[1]).toBe(clients[1])
  })

  test('idempotent: run again, nothing changes; after recheckClient, it puts its issues back', () => {
    const clients = review(PLAIN, [
      ['Old Owner', '12 Wattle St, Bayswater WA 6053', '0412 345 678'],
      ['New Owner', '12 Wattle St, Bayswater WA 6053', 'abc'],
    ])
    const again = checkAcrossClients(clients)
    expect(again[0]).toBe(clients[0])
    expect(again[1]).toBe(clients[1])
    expect(checkAcrossClients(again)[1].issues).toEqual(clients[1].issues)
    expect(messages(clients[1], 'error')).toEqual([
      'Phone “abc”: A phone number can only have digits, spaces, brackets and a +. Put a name or note somewhere else.',
      `Same address as Old Owner (row 2) — ${SAME}`,
    ])

    // One client alone can't know; the list, run again, does.
    const edited = recheckClient({ ...clients[1], phone: undefined }, opts)
    expect(edited.issues).toEqual([])
    const [, settled] = checkAcrossClients([clients[0], edited])
    expect(messages(settled)).toEqual([
      `Same address as Old Owner (row 2) — ${SAME}`,
    ])

    // Moved to another address, it goes.
    const moved = recheckClient(
      {
        ...settled,
        sites: [{ ...settled.sites[0], addressLine: '14 Wattle St' }],
      },
      opts,
    )
    const [, clear] = checkAcrossClients([clients[0], moved])
    expect(clear.issues).toEqual([])
  })

  test("a client that can't be imported yet claims nothing: a later one at the address keeps it", () => {
    const clients = review(PLAIN, [
      ['Landlord A', '12 Wattle St, Bayswater WA 6053', '12'],
      [
        'Tenant B',
        '12 Wattle St, Bayswater WA 6053',
        '0412 345 678',
        '',
        'Gate 4321',
      ],
      ['Tenant B', '9 Rose St, Bayswater WA 6053', '0412 345 678'],
    ])
    const [landlord, tenant] = clients
    expect(statusOf(landlord)).toBe('error')
    expect(importable(landlord)).toBe(false)
    // What the server does when sent only the tenant: both sites, and the
    // note, are the tenant's.
    expect(tenant.issues).toEqual([])
    expect(statusOf(tenant)).toBe('ready')
    expect(toImportClient(tenant).sites).toEqual([
      expect.objectContaining({
        addressLine: '12 Wattle St',
        note: 'Gate 4321',
      }),
      expect.objectContaining({ addressLine: '9 Rose St' }),
    ])

    // Fixed, the landlord is written first, and the tenant is told.
    const fix = issue(landlord, /^Phone “12”/).fix!
    const fixed = recheckClient(fix.apply(landlord), opts)
    const [claims, told] = checkAcrossClients([fixed, tenant])
    expect(claims.issues).toEqual([])
    expect(told.issues).toEqual([
      expect.objectContaining({
        level: 'warning',
        field: 'addressLine',
        siteIndex: 0,
        message:
          'Same address as Landlord A (row 2) — this site and its note will be skipped.',
      }),
    ])
    expect(statusOf(told)).toBe('warning')
    // Left out again, it gives the address back.
    const [, again] = checkAcrossClients([{ ...claims, included: false }, told])
    expect(again.issues).toEqual([])
  })

  test('an Excel-shortened phone on the earlier client: the later one goes in; fixed, the claim moves back', () => {
    const clients = review(PLAIN, [
      ['Jo Smith', '1 Rose St, Bayswater WA 6053', '4.12346E+08'],
      ['Mary Brown', '1 Rose St, Bayswater WA 6053', '0499 888 777'],
    ])
    const [jo, mary] = clients
    expect(statusOf(jo)).toBe('error')
    expect(mary.issues).toEqual([])
    expect(importable(mary)).toBe(true)
    expect(checkImportClient(toImportClient(mary)).ok).toBe(true)

    // Left out and brought back while still in error: still nothing claimed.
    const [out] = checkAcrossClients([{ ...jo, included: false }, mary])
    const [back, stillIn] = checkAcrossClients([
      { ...out, included: true },
      mary,
    ])
    expect(statusOf(back)).toBe('error')
    expect(stillIn).toBe(mary)

    // Fixed: Jo is sent, and Mary, with nothing else to send, can't be.
    const fixed = recheckClient(
      issue(jo, /Excel shortened this number/).fix!.apply(jo),
      opts,
    )
    const [sent, shut] = checkAcrossClients([fixed, mary])
    expect(importable(sent)).toBe(true)
    expect(messages(shut, 'error')).toEqual([
      `Same address as Jo Smith (row 2) — ${SAME}`,
    ])
    expect(importable(shut)).toBe(false)
  })

  test('a client shut out claims nothing: each after it is told of the one sent', () => {
    const [first, second, third] = review(PLAIN, [
      ['Old Owner', '12 Wattle St, Bayswater WA 6053', '0412 345 678'],
      ['New Owner', '12 Wattle St, Bayswater WA 6053', '0499 888 777'],
      ['Next Owner', '12 Wattle St, Bayswater WA 6053', '0455 666 777'],
    ])
    expect(first.issues).toEqual([])
    // Each later one is told of the first, the one that is sent.
    expect(messages(second)).toEqual([
      `Same address as Old Owner (row 2) — ${SAME}`,
    ])
    expect(messages(third)).toEqual([
      `Same address as Old Owner (row 2) — ${SAME}`,
    ])
  })

  test('two that would join one client in PestM8, one of them not sendable yet: said once both would be sent', () => {
    const john = 'john' as Id<'clients'>
    const existing: ExistingIndex = {
      clientsByName: new Map([['john smith', john]]),
      siteKeys: new Set(),
    }
    const [first, second] = review(
      PLAIN,
      [
        ['John Smith', '1 Hay St, Perth WA 6000', 'abc'],
        ['John Smith', '3 Hay St, Perth WA 6000', '0499 888 777'],
      ],
      { existing },
    )
    expect(messages(first).some((m) => m.startsWith('Also matched'))).toBe(
      false,
    )
    expect(second.issues).toEqual([])
    const fixed = recheckClient(
      issue(first, /^Phone “abc”/).fix!.apply(first),
      { businessState: 'WA', existing },
    )
    const [a, b] = checkAcrossClients([fixed, second])
    expect(messages(a)).toEqual([
      'Also matched: John Smith (row 3) — both would be added to the same client in PestM8. Leave one out if they’re different people.',
    ])
    expect(messages(b)).toEqual([
      'Also matched: John Smith (row 2) — both would be added to the same client in PestM8. Leave one out if they’re different people.',
    ])
  })

  test('rows named as the spreadsheet numbers them, title and blank rows counted', () => {
    const john = 'john' as Id<'clients'>
    const clients = review(
      PLAIN,
      [
        ['Old Owner', '12 Wattle St, Bayswater WA 6053', '0412 345 678'],
        ['John Smith', '1 Hay St, Perth WA 6000', '0400 111 222'],
        ['New Owner', '12 Wattle St, Bayswater WA 6053', '0499 888 777'],
        ['John Smith', '3 Hay St, Perth WA 6000', '0400 333 444'],
        ['Old Owner', '5 Beach Rd, Scarborough WA 6019', '0412 345 678'],
      ],
      {
        // A title row, the headings on row 3, a blank row after the second.
        sourceRows: [4, 5, 7, 8, 9],
        existing: {
          clientsByName: new Map([['john smith', john]]),
          siteKeys: new Set(),
        },
      },
    )
    const [old, first, owner, second] = clients
    // The download still goes by data row.
    expect(clients.map((c) => [c.key, c.rowNumbers, c.sheetRows])).toEqual([
      ['c1', [1, 5], [4, 9]],
      ['c2', [2], [5]],
      ['c3', [3], [7]],
      ['c4', [4], [8]],
    ])
    expect(old.issues).toEqual([])
    expect(messages(owner)).toEqual([
      `Same address as Old Owner (row 4) — ${SAME}`,
    ])
    expect(messages(first)).toEqual([
      'Also matched: John Smith (row 8) — both would be added to the same client in PestM8. Leave one out if they’re different people.',
    ])
    expect(messages(second)).toEqual([
      'Also matched: John Smith (row 5) — both would be added to the same client in PestM8. Leave one out if they’re different people.',
    ])

    // A client with no sheet rows (made by hand): its data row, plus 1.
    const { sheetRows: _rows, ...bare } = old
    const [, named] = checkAcrossClients([bare, { ...owner, issues: [] }])
    expect(messages(named)).toEqual([
      `Same address as Old Owner (row 2) — ${SAME}`,
    ])
  })
})

describe("two of one client's sites at one address", () => {
  const TOGETHER = 'Put them together'

  test('made so by an edit to the suburb: a warning, and a fix that joins them', () => {
    const [client] = review(PLAIN, [
      ['Jo', '1 Rose St, Bayswater WA 6053', '', '', 'Dog in yard'],
      ['Jo', '1 Rose St, Bayswatr WA 6053', '', '', 'Gate 4321'],
    ])
    expect(client.sites).toHaveLength(2)
    expect(client.issues).toEqual([])

    const edited = recheckClient(
      {
        ...client,
        sites: [client.sites[0], { ...client.sites[1], suburb: 'Bayswater' }],
      },
      opts,
    )
    const [same] = checkAcrossClients([edited])
    const warning = issue(same, /^Same address as site/)
    expect(warning).toMatchObject({
      level: 'warning',
      field: 'addressLine',
      siteIndex: 1,
      message:
        'Same address as site 1 — this site and its note will be skipped.',
    })
    expect(same.issues).toHaveLength(1)
    expect(statusOf(same)).toBe('warning')
    expect(checkAcrossClients([same])[0]).toBe(same)

    expect(warning.fix?.label).toBe(TOGETHER)
    const [joined] = checkAcrossClients([
      recheckClient(warning.fix!.apply(same), opts),
    ])
    expect(joined.sites).toEqual([
      expect.objectContaining({
        addressLine: '1 Rose St',
        suburb: 'Bayswater',
        note: 'Dog in yard\n\nGate 4321',
      }),
    ])
    expect(joined.issues).toEqual([])
    expect(statusOf(joined)).toBe('ready')
    expect(toImportClient(joined).sites).toHaveLength(1)
  })

  test('made so by a postcode fix: the site contact comes across, and what was said of a later site moves down', () => {
    const [client] = review(
      [
        ['Name', 'name'],
        ['Address', 'address'],
        ['Site contact', 'siteContactName'],
        ['Site phone', 'siteContactPhone'],
        ['Notes', 'notes'],
      ],
      [
        ['Wattle Strata Pty Ltd', '1 Rose St, Bayswater WA 6053'],
        [
          'Wattle Strata Pty Ltd',
          '1 Rose St, Bayswater WA 6035',
          'Caretaker Col',
          '0433 222 111',
        ],
        ['Wattle Strata Pty Ltd', '1 Casuarina Dr, Nightcliff NT 810'],
      ],
    )
    expect(client.sites).toHaveLength(3)
    const edited = recheckClient(
      {
        ...client,
        sites: client.sites.map((site, i) =>
          i === 1 ? { ...site, postcode: '6053' } : site,
        ),
      },
      opts,
    )
    const [same] = checkAcrossClients([edited])
    // No note on it, so none named.
    const warning = issue(
      same,
      'Same address as site 1 — this site will be skipped.',
    )
    const [joined] = checkAcrossClients([
      recheckClient(warning.fix!.apply(same), opts),
    ])
    expect(joined.sites).toHaveLength(2)
    expect(joined.sites[0]).toMatchObject({
      addressLine: '1 Rose St',
      postcode: '6053',
      siteContactName: 'Caretaker Col',
      siteContactPhone: '0433 222 111',
    })
    expect(joined.sites[0]).not.toHaveProperty('note')
    expect(joined.issues).toEqual([
      expect.objectContaining({
        level: 'fixed',
        siteIndex: 1,
        message: 'Postcode 810 → 0810',
      }),
    ])
    expect(statusOf(joined)).toBe('fixed')
  })

  test('an address an earlier client has: that client named, not the site', () => {
    const clients = review(PLAIN, [
      ['Old Owner', '1 Rose St, Bayswater WA 6053', '0412 345 678'],
      ['Jo', '1 Rose St, Bayswater WA 6053'],
      ['Jo', '9 Hay St, Perth WA 6000'],
      ['Jo', '1 Rose St, Bayswatr WA 6053'],
    ])
    const [old, jo] = clients
    expect(jo.sites).toHaveLength(3)
    const edited = recheckClient(
      {
        ...jo,
        sites: jo.sites.map((site, i) =>
          i === 2 ? { ...site, suburb: 'Bayswater' } : site,
        ),
      },
      opts,
    )
    const [, both] = checkAcrossClients([old, edited])
    const skipped =
      'Same address as Old Owner (row 2) — this site will be skipped.'
    expect(both.issues.map((i) => [i.siteIndex, i.message])).toEqual([
      [0, skipped],
      [2, skipped],
    ])
    // Old Owner left out, the address is Jo's, twice.
    const [, own] = checkAcrossClients([{ ...old, included: false }, edited])
    expect(own.issues.map((i) => [i.siteIndex, i.message])).toEqual([
      [2, 'Same address as site 1 — this site will be skipped.'],
    ])
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
