import type {
  ColumnMapping,
  ImportField,
  ImportSheet,
  SourceApp,
} from './types'

/**
 * Which column is which: the guess the Match step starts from, and what it
 * must have before Continue. The guess comes from the headings alone (and,
 * for addresses, a look at the values), from the exports of the apps a pest
 * business is most likely leaving — Jobber, ServiceM8, Tradify, Xero, MYOB,
 * GorillaDesk, Housecall Pro — and the plain sheet an owner keeps
 * themselves. Every guess is shown and can be changed.
 */

export const FIELD_LABELS: Record<ImportField, string> = {
  name: 'Client name',
  firstName: 'First name',
  lastName: 'Last name',
  company: 'Company',
  contactPerson: 'Contact person',
  isCompany: 'Is a company?',
  email: 'Email',
  phone: 'Phone',
  mobile: 'Mobile',
  abn: 'ABN',
  address: 'Full address (one column)',
  street: 'Street',
  street2: 'Street line 2',
  suburb: 'Suburb',
  state: 'State',
  postcode: 'Postcode',
  siteContactName: 'Site contact',
  siteContactPhone: "Site contact's phone",
  notes: 'Notes',
}

/** The Match step's dropdown, in the order a person thinks of a client. */
export const FIELD_ORDER: Array<ImportField> = [
  'name',
  'firstName',
  'lastName',
  'company',
  'contactPerson',
  'isCompany',
  'phone',
  'mobile',
  'email',
  'abn',
  'address',
  'street',
  'street2',
  'suburb',
  'state',
  'postcode',
  'siteContactName',
  'siteContactPhone',
  'notes',
]

/** A heading as compared: "Is Company?", "is_company" and "IsCompany" are
 * one, and so are MYOB's "A.B.N." and a plain "ABN". */
function normalise(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// ---------------------------------------------------------------- source

/**
 * The headings that give an app's export away. A strong one alone is enough
 * ("J-ID" is Jobber's and nobody else's); a weak one needs another beside it
 * ("Display name" alone is any spreadsheet). A file matching several apps
 * goes to the one it matches best. Tradify's are a best guess, as its
 * export has changed more than once.
 */
const SOURCE_MARKERS: Array<
  [SourceApp, { strong: Array<string>; weak: Array<string> }]
> = [
  [
    'Xero',
    {
      strong: ['contactname*', 'saaddressline1', 'poaddressline1'],
      weak: ['taxnumber', 'saregion', 'poregion'],
    },
  ],
  [
    'MYOB',
    { strong: ['colastname', 'cardid', 'a.b.n.', 'cardstatus'], weak: [] },
  ],
  [
    'Jobber',
    {
      strong: ['iscompany', 'jid'],
      weak: ['billingstreet', 'billingstreet1', 'servicestreet1'],
    },
  ],
  [
    'GorillaDesk',
    { strong: ['topnote', 'billtoname'], weak: ['locationnotes'] },
  ],
  [
    'ServiceM8',
    { strong: ['abnnumber', 'contactfirst'], weak: ['contactlast'] },
  ],
  ['Housecall Pro', { strong: [], weak: ['displayname', 'serviceaddress'] }],
  [
    'Tradify',
    {
      strong: [],
      weak: [
        'physicaladdress',
        'physicaladdressline1',
        'physicalstreet',
        'physicalsuburb',
        'physicalcity',
        'physicalpostcode',
      ],
    },
  ],
]

/** The forms of a heading a marker can name: normalised, and — for the
 * markers whose punctuation is the tell — as written ("*ContactName" is
 * Xero's required-column star; "A.B.N." is MYOB's). */
function headerForms(header: string): Array<string> {
  const lower = header.trim().toLowerCase()
  const forms = [normalise(header), lower]
  if (lower.startsWith('*')) forms.push(`${normalise(header)}*`)
  return forms
}

export function detectSource(headers: Array<string>): SourceApp | null {
  const present = new Set(headers.flatMap(headerForms))
  let best: SourceApp | null = null
  let bestScore = 0
  for (const [app, { strong, weak }] of SOURCE_MARKERS) {
    const score =
      2 * strong.filter((m) => present.has(m)).length +
      weak.filter((m) => present.has(m)).length
    if (score >= 2 && score > bestScore) {
      best = app
      bestScore = score
    }
  }
  return best
}

// ---------------------------------------------------------------- mapping

/**
 * Headings for each field, best first, normalised. Kept disjoint: a heading
 * names one field, so which field claims a column never depends on order.
 * The address fields are separate (below), because which set of them to use
 * is decided as a set.
 */
const SYNONYMS: Record<
  Exclude<
    ImportField,
    'address' | 'street' | 'street2' | 'suburb' | 'state' | 'postcode'
  >,
  Array<string>
> = {
  name: [
    'clientname',
    'customername',
    'name',
    'fullname',
    'displayname',
    'billtoname',
    'accountname',
    'client',
    'customer',
  ],
  firstName: [
    'firstname',
    'givenname',
    'first',
    'fname',
    'contactfirst',
    'contactfirstname',
  ],
  lastName: [
    'lastname',
    'surname',
    'familyname',
    'last',
    'lname',
    // MYOB's "Co./Last Name": a company's name, or a person's surname beside
    // their first name. build.ts reads one with no first name as a company.
    'colastname',
    'contactlast',
    'contactlastname',
  ],
  company: [
    'company',
    'companyname',
    'business',
    'businessname',
    'organisation',
    'organization',
    'organisationname',
    'organizationname',
    'tradingname',
  ],
  contactPerson: [
    'contactperson',
    'primarycontact',
    'contact',
    'contactname',
    'attention',
    'attn',
  ],
  isCompany: [
    'iscompany',
    'isbusiness',
    'clienttype',
    'customertype',
    'accounttype',
    'type',
  ],
  email: [
    'email',
    'emailaddress',
    'emails',
    'emailaddresses',
    'email1',
    'primaryemail',
    'mainemail',
    'contactemail',
  ],
  mobile: [
    'mobile',
    'mobilephone',
    'mobilenumber',
    'mobilephones',
    'mobileno',
    'mob',
    'cell',
    'cellphone',
    'contactmobile',
  ],
  phone: [
    'phone',
    'phonenumber',
    'mainphone',
    'mainphones',
    'telephone',
    'tel',
    'ph',
    'phone1',
    'homephone',
    'homephones',
    'homenumber',
    'workphone',
    'workphones',
    'worknumber',
    'businessphone',
    'landline',
    'contactphone',
    'primaryphone',
  ],
  abn: ['abn', 'abnnumber', 'australianbusinessnumber', 'taxnumber'],
  siteContactName: [
    'sitecontact',
    'sitecontactname',
    'onsitecontact',
    'onsitecontactname',
    'locationcontact',
    'locationcontactname',
    'tenant',
    'tenantname',
    'occupant',
    'occupantname',
  ],
  siteContactPhone: [
    'sitecontactphone',
    'sitecontactnumber',
    'sitecontactmobile',
    'onsitecontactphone',
    'sitephone',
    'sitemobile',
    'locationphone',
    'locationcontactphone',
    'tenantphone',
    'tenantmobile',
    'occupantphone',
  ],
  notes: [
    'sitenotes',
    'locationnotes',
    'propertynotes',
    'servicenotes',
    'notes',
    'note',
    'topnote',
    'clientnotes',
    'customernotes',
    'comments',
    'comment',
    'specialinstructions',
    'instructions',
  ],
}

type AddressField =
  'address' | 'street' | 'street2' | 'suburb' | 'state' | 'postcode'

const ADDRESS_FIELDS: Array<AddressField> = [
  'street',
  'street2',
  'address',
  'suburb',
  'state',
  'postcode',
]

/** An address field's own words, which a set's prefix goes in front of:
 * Jobber's "Service Street 1", Xero's "SAAddressLine1", GorillaDesk's
 * "Location City", MYOB's "Addr 1 - Line 1". */
const ADDRESS_WORDS: Record<AddressField, Array<string>> = {
  street: [
    'street',
    'street1',
    'streetaddress',
    'streetline1',
    'addressline1',
    'address1',
    'addressline',
    'addr1line1',
    'line1',
  ],
  street2: ['street2', 'streetline2', 'addressline2', 'address2', 'line2'],
  address: ['address', 'fulladdress'],
  suburb: [
    'suburb',
    'city',
    'town',
    'locality',
    'suburbtown',
    'suburbcity',
    'towncity',
    'citysuburb',
  ],
  state: ['state', 'region', 'province', 'stateprovince', 'stateterritory'],
  postcode: [
    'postcode',
    'postalcode',
    'zip',
    'zipcode',
    'pcode',
    'postcodezip',
  ],
}

/** Where the work is: a site's, the property's, the service address. */
const SITE_PREFIXES = [
  'service',
  'site',
  'property',
  'location',
  'physical',
  'job',
  'jobsite',
  'premises',
  'sa',
]

/** Where the invoice goes: never the site when a site address is there. */
const BILLING_PREFIXES = [
  'billing',
  'bill',
  'billto',
  'postal',
  'po',
  'mailing',
]

type AddressSet = Partial<Record<AddressField, number>>

function addressHeadings(
  prefixes: Array<string>,
): Record<AddressField, Array<string>> {
  const out = {} as Record<AddressField, Array<string>>
  for (const field of ADDRESS_FIELDS) {
    out[field] = prefixes.flatMap((p) =>
      ADDRESS_WORDS[field].map((w) => `${p}${w}`),
    )
  }
  return out
}

const SITE_HEADINGS = addressHeadings(SITE_PREFIXES)
const PLAIN_HEADINGS = addressHeadings([''])
const BILLING_HEADINGS = addressHeadings(BILLING_PREFIXES)

/** The leftmost column with the first heading of `names` that one has, and
 * not already claimed. Leftmost, because MYOB repeats "- City" for each of
 * its addresses and the first is the main one. */
function claim(
  keys: Array<string>,
  names: Array<string>,
  taken: Set<number>,
): number | undefined {
  for (const name of names) {
    const i = keys.findIndex((k, index) => k === name && !taken.has(index))
    if (i !== -1) return i
  }
  return undefined
}

function claimSet(
  keys: Array<string>,
  headings: Array<Record<AddressField, Array<string>>>,
  taken: Set<number>,
): AddressSet {
  const set: AddressSet = {}
  const mine = new Set(taken)
  for (const field of ADDRESS_FIELDS) {
    for (const names of headings) {
      const i = claim(keys, names[field], mine)
      if (i !== undefined) {
        set[field] = i
        mine.add(i)
        break
      }
    }
  }
  return set
}

function columnHasValues(sheet: ImportSheet, column: number | undefined) {
  return column !== undefined && sheet.rows.some((row) => row[column]?.trim())
}

/** Whether a column holds whole addresses ("12 Wattle St, Bayswater WA
 * 6053") rather than streets: most of its values end in a postcode or
 * name a state. */
function holdsWholeAddresses(sheet: ImportSheet, column: number): boolean {
  const values = sheet.rows
    .slice(0, 50)
    .map((row) => row[column]?.trim() ?? '')
    .filter(Boolean)
  if (values.length === 0) return false
  const whole = values.filter(
    (v) =>
      /\b\d{3,4}\s*(?:,?\s*australia)?$/i.test(v) ||
      /[\s,](?:nsw|vic|qld|wa|sa|tas|nt|act)\b/i.test(v),
  )
  return whole.length * 2 > values.length
}

export function autoMap(sheet: ImportSheet): ColumnMapping {
  const keys = sheet.headers.map(normalise)
  const mapping: ColumnMapping = sheet.headers.map(() => null)
  const taken = new Set<number>()
  const source = detectSource(sheet.headers)

  const put = (field: ImportField, column: number | undefined) => {
    if (column === undefined) return
    mapping[column] = field
    taken.add(column)
  }

  // Xero's ContactName is the client — a business or a person — and its
  // FirstName/LastName are the person to ask for. Everywhere else "Contact
  // name" is that person.
  const synonyms = { ...SYNONYMS }
  if (source === 'Xero') {
    synonyms.name = ['contactname', ...SYNONYMS.name]
    synonyms.contactPerson = SYNONYMS.contactPerson.filter(
      (s) => s !== 'contactname',
    )
  }

  // The address first, and as a set: whether it is the site's or the
  // invoice's is one decision for all its columns, never one per column.
  const primary = claimSet(keys, [SITE_HEADINGS, PLAIN_HEADINGS], taken)
  const billing = claimSet(keys, [BILLING_HEADINGS], taken)
  const primaryUsed =
    columnHasValues(sheet, primary.street) ||
    columnHasValues(sheet, primary.address)
  const billingHas =
    billing.street !== undefined || billing.address !== undefined
  // Billing and postal columns are the invoice's, and never the site's while
  // the file has a site address. Only when every site address is blank — a
  // Xero export whose SA* columns were never filled in — is the postal one
  // all there is.
  const chosen = !primaryUsed && billingHas ? billing : primary
  for (const field of ADDRESS_FIELDS) put(field, chosen[field])

  // A column headed as the street that holds whole addresses, with no suburb
  // column beside it, is the one-column kind — Housecall Pro's "Service
  // address". And the other way round: an "Address" column next to a
  // "Suburb" column holds streets.
  if (chosen.street !== undefined && chosen.suburb === undefined) {
    if (holdsWholeAddresses(sheet, chosen.street)) {
      mapping[chosen.street] = 'address'
      if (chosen.street2 !== undefined) mapping[chosen.street2] = null
    }
  }
  if (
    chosen.address !== undefined &&
    chosen.suburb !== undefined &&
    chosen.street === undefined &&
    !holdsWholeAddresses(sheet, chosen.address)
  ) {
    mapping[chosen.address] = 'street'
  }

  for (const field of Object.keys(synonyms) as Array<keyof typeof synonyms>) {
    put(field, claim(keys, synonyms[field], taken))
  }
  return mapping
}

// ---------------------------------------------------------------- problems

/** What stops Continue, as sentences for the Match step. */
export function mappingProblems(mapping: ColumnMapping): Array<string> {
  const problems: Array<string> = []
  const has = (field: ImportField) => mapping.includes(field)

  if (
    !has('name') &&
    !has('company') &&
    !has('firstName') &&
    !has('lastName')
  ) {
    problems.push(
      "Choose the column with the client's name — or the first and last names, or the company.",
    )
  }
  if (!has('address') && !has('street')) {
    problems.push(
      'Choose the column with the address — the street and suburb, or one column holding the whole address.',
    )
  } else if (!has('address') && !has('suburb')) {
    problems.push(
      'Choose the suburb column too — a street alone is not an address. Or, if one column holds the whole address, choose “Full address” for it.',
    )
  }

  const seen = new Set<ImportField>()
  const twice = new Set<ImportField>()
  for (const field of mapping) {
    if (field === null) continue
    if (seen.has(field)) twice.add(field)
    seen.add(field)
  }
  for (const field of FIELD_ORDER) {
    if (twice.has(field)) {
      problems.push(
        `“${FIELD_LABELS[field]}” is chosen for more than one column — choose it for one only.`,
      )
    }
  }
  return problems
}
