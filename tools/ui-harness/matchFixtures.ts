/*
 * Client books for New Job's search and its check at Book (the matching
 * plan's M2 and M3): a small one built around the domain cases — a client
 * with her own email and mobile, an agency with a contact person whose
 * office number its owners share, a family sharing a mobile, someone on a
 * landline of her own, a client with no site yet — the same book cut short
 * at the directory's limit, and a synthetic one of 10,000 clients and
 * 11,000 sites, for timing the pickers on a real old iPhone. Each is
 * `clients.directory`'s answer for a business id of its own, so no other
 * specimen changes. The small book's numbers are from ACMA's ranges for
 * fiction.
 */

export const MATCH_BIZ = 'biz_match'
/** The small book, said to be past the directory's limit (`capped`). */
export const MATCH_CAPPED_BIZ = 'biz_match_capped'
export const TEN_K_BIZ = 'biz_10k'

const DAY = 86_400_000

function client(
  id: string,
  name: string,
  fields: Record<string, unknown>,
  daysAgo: number,
) {
  const at = Date.now() - daysAgo * DAY
  return {
    _id: id,
    _creationTime: at,
    name,
    kind: 'person',
    createdAt: at,
    ...fields,
  }
}

function site(
  id: string,
  clientId: string,
  addressLine: string,
  suburb: string,
  postcode: string,
  daysAgo: number,
  fields: Record<string, unknown> = {},
) {
  return {
    _id: id,
    clientId,
    addressLine,
    suburb,
    postcode,
    createdAt: Date.now() - daysAgo * DAY,
    ...fields,
  }
}

function matchDirectory() {
  return {
    clients: [
      // Added this week, by hand: in "Added recently", with its day.
      client(
        'c_jane',
        'Jane Nguyen',
        {
          phone: '0491 570 156',
          email: 'jane.nguyen@example.com',
          clientNumber: 2041,
        },
        2,
      ),
      client(
        'c_raywhite',
        'Ray White Bayswater',
        {
          kind: 'business',
          phone: '08 7010 1234',
          email: 'rentals@raywhite.example',
          clientNumber: 1302,
        },
        300,
      ),
      // An owner the agency books for, saved with the office's landline.
      client(
        'c_tomlee',
        'Tom Lee',
        { phone: '7010 1234', clientNumber: 1388 },
        200,
      ),
      // A family on one mobile.
      client(
        'c_lisa',
        'Lisa Tran',
        { phone: '0491 570 159', clientNumber: 1450 },
        150,
      ),
      client(
        'c_tom',
        'Tom Tran',
        { phone: '+61 491 570 159', clientNumber: 1451 },
        150,
      ),
      // No site yet: found by number, and New site for is the way on.
      client(
        'c_sam',
        'Sam Wu',
        { phone: '0491 570 157', email: 'sam.wu@example.com' },
        40,
      ),
      client(
        'c_harbour',
        'Harbourside Strata',
        { kind: 'business', phone: '08 7010 5500', clientNumber: 1101 },
        500,
      ),
      // On a landline of her own: whoever else rings from it is shown her,
      // never offered her in one tap.
      client(
        'c_mei',
        'Mei Chen',
        { phone: '08 7010 2222', clientNumber: 1460 },
        120,
      ),
    ],
    sites: [
      site('p_jane', 'c_jane', '12 Wattle St', 'Bayswater', '6053', 2),
      site(
        'p_rw1',
        'c_raywhite',
        '1 King William St',
        'Bayswater',
        '6053',
        300,
        {
          siteContactName: 'Priya Shah',
          siteContactPhone: '0491 570 313',
        },
      ),
      site('p_rw2', 'c_raywhite', '3/12 Ocean Pde', 'Cottesloe', '6011', 280),
      site('p_tomlee', 'c_tomlee', '7 Rose Ave', 'Bayswater', '6053', 200),
      site('p_lisa', 'c_lisa', '4 Hay St', 'Perth', '6000', 150),
      site('p_tom', 'c_tom', '6 Hay St', 'Perth', '6000', 150),
      site(
        'p_harbour',
        'c_harbour',
        '88 Adelaide Tce',
        'East Perth',
        '6004',
        500,
      ),
      site('p_mei', 'c_mei', '9 Beaufort St', 'Perth', '6000', 120),
    ],
    contacts: [
      {
        _id: 'k_sarah',
        clientId: 'c_raywhite',
        name: 'Sarah Lee',
        role: 'Property manager',
        phone: '0491 570 110',
        email: 'sarah.lee@raywhite.example',
      },
    ],
    contactsCapped: false,
    capped: false,
  }
}

const FIRST = [
  'Jane',
  'Tom',
  'Lisa',
  'Sam',
  'Priya',
  'Arthur',
  'Beatrice',
  'Nadia',
  'Kevin',
  'Harriet',
  'Josh',
  'Ann',
  'Mei',
  'Raj',
  'Olivia',
  'Liam',
  'Zara',
  'Aaron',
  'Bea',
  'Kim',
]
const LAST = [
  'Nguyen',
  'Lee',
  'Tran',
  'Wu',
  'Shah',
  'Wellard',
  'Byford',
  'Smith',
  'Doyle',
  'Cole',
  'Harbour',
  'Kowalski',
  'Chen',
  'Patel',
  'Brown',
  'Murphy',
  'Hussain',
  'Old',
  'Morris',
  'Vilay',
]
const STREETS = [
  'Wattle St',
  'Hay St',
  'Rose Ave',
  'Ocean Pde',
  'King William St',
  'Adelaide Tce',
  'Beaufort St',
  'Walter Rd',
  'Coode St',
  'Kalinda Way',
]
const SUBURBS: Array<[string, string]> = [
  ['Bayswater', '6053'],
  ['Perth', '6000'],
  ['Cottesloe', '6011'],
  ['East Perth', '6004'],
  ['Morley', '6062'],
  ['Subiaco', '6008'],
  ['Leederville', '6007'],
  ['Scarborough', '6019'],
]

let tenK: ReturnType<typeof matchDirectory> | null = null

/** 10,000 clients and 11,000 sites, the same each time: every tenth client
 * has a second site, every fifth an email, one in 25 is a business with a
 * contact person. Made once per page load. */
function tenKDirectory() {
  if (tenK) return tenK
  const clients: Array<Record<string, unknown>> = []
  const sites: Array<Record<string, unknown>> = []
  const contacts: Array<Record<string, unknown>> = []
  for (let i = 0; i < 10_000; i++) {
    const name = `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]} ${i}`
    const business = i % 25 === 0
    const id = `c_${i}`
    clients.push(
      client(
        id,
        business ? `${LAST[i % LAST.length]} Holdings ${i}` : name,
        {
          ...(business ? { kind: 'business' } : {}),
          phone: `04${String(91_000_000 + i).padStart(8, '0')}`,
          ...(i % 5 === 0 ? { email: `client${i}@example.com` } : {}),
          clientNumber: 1000 + i,
        },
        400 + (i % 300),
      ),
    )
    const [suburb, postcode] = SUBURBS[i % SUBURBS.length]
    const count = i % 10 === 0 ? 2 : 1
    for (let s = 0; s < count; s++) {
      sites.push(
        site(
          `p_${i}_${s}`,
          id,
          `${(i % 200) + 1 + s} ${STREETS[(i + s) % STREETS.length]}`,
          suburb,
          postcode,
          400 + (i % 300),
        ),
      )
    }
    if (business) {
      contacts.push({
        _id: `k_${i}`,
        clientId: id,
        name: `${FIRST[(i + 3) % FIRST.length]} ${LAST[(i + 7) % LAST.length]}`,
        phone: `04${String(92_000_000 + i).padStart(8, '0')}`,
      })
    }
  }
  tenK = {
    clients: clients as ReturnType<typeof matchDirectory>['clients'],
    sites: sites as ReturnType<typeof matchDirectory>['sites'],
    contacts: contacts as ReturnType<typeof matchDirectory>['contacts'],
    contactsCapped: false,
    capped: false,
  }
  return tenK
}

/** `clients.directory` for the two businesses here, or undefined for any
 * other. */
export function resolveMatch(fn: string, args: unknown): unknown {
  if (fn !== 'clients:directory') return undefined
  const businessId = (args as { businessId?: string } | undefined)?.businessId
  if (businessId === MATCH_BIZ) return matchDirectory()
  if (businessId === MATCH_CAPPED_BIZ) {
    return { ...matchDirectory(), capped: true }
  }
  if (businessId === TEN_K_BIZ) return tenKDirectory()
  return undefined
}
