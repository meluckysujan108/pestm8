/*
 * Two records for one customer, for the client sheet's Merge into… and its
 * possible-duplicate lines (the matching plan's M8): Jane Nguyen booked
 * yesterday as a new client past her own record from last year (the same
 * name and mobile), and past J. Nguyen's, who has her address (a similar
 * name at it, which the server's check counts too), at an address Tom
 * Brown has as well: someone else there, who is no hint and is in A–Z.
 * And Rita Brown, booked two days ago past an archived record of hers at
 * the same address, which a merge refuses. Harbourside Strata is a
 * business: kept as Jane would be, it is refused (`KIND_MISMATCH`), as the
 * server refuses a business into a person. Every hint is one the server's
 * check would write (`hintsOf`, convex/lib/findSame.ts: a person's own
 * number or email, or a name like theirs beside their address; never an
 * address under another name). Answered for business ids of their own, so
 * no other specimen changes: `MERGE_LOADING_BIZ` is the same book, with
 * the client list never answering. Numbers are from ACMA's ranges for
 * fiction.
 */

import { ConvexError } from 'convex/values'

export const MERGE_BIZ = 'biz_merge'

/** The same book, its client list still loading: Merge into…'s
 * placeholder. */
export const MERGE_LOADING_BIZ = 'biz_merge_loading'

/** The client the sheet opens on: the one the booking made. */
export const MERGE_NEW_JANE = 'mc_jane_new'

/** A client booked past an archived record of hers. */
export const MERGE_NEW_RITA = 'mc_rita_new'

const DAY = 86_400_000
const MOBILE = '0491 570 156'

function client(
  id: string,
  name: string,
  clientNumber: number,
  daysAgo: number,
  fields: Record<string, unknown> = {},
) {
  const at = Date.now() - daysAgo * DAY
  return {
    _id: id,
    _creationTime: at,
    businessId: MERGE_BIZ,
    name,
    kind: 'person',
    clientNumber,
    status: 'active',
    createdAt: at,
    ...fields,
  }
}

const CLIENTS = [
  client(MERGE_NEW_JANE, 'Jane Nguyen', 231, 1, {
    phone: MOBILE,
    email: 'jane.nguyen@example.com',
  }),
  client('mc_jane', 'Jane Nguyen', 12, 400, { phone: MOBILE }),
  client('mc_tom', 'Tom Brown', 40, 200, { phone: '0491 570 110' }),
  client('mc_jn', 'J. Nguyen', 52, 150),
  client('mc_amy', 'Amy Lo', 3, 500),
  client('mc_bea', 'Bea Archer', 7, 450),
  client('mc_harbour', 'Harbourside Strata', 18, 300, { kind: 'business' }),
  client('mc_old', 'Jane Nguyen', 5, 900, {
    phone: MOBILE,
    archivedAt: Date.now() - 100 * DAY,
  }),
  client(MERGE_NEW_RITA, 'Rita Brown', 60, 2, { phone: '0491 570 159' }),
  client('mc_rita_old', 'Rita Brown', 9, 800, {
    phone: '0491 570 159',
    archivedAt: Date.now() - 300 * DAY,
  }),
]

function site(
  id: string,
  clientId: string,
  addressLine: string,
  suburb: string,
  postcode: string,
  daysAgo: number,
) {
  return {
    _id: id,
    clientId,
    addressLine,
    suburb,
    postcode,
    state: 'WA',
    createdAt: Date.now() - daysAgo * DAY,
  }
}

const SITES = [
  site('ms_wattle', MERGE_NEW_JANE, '12 Wattle Street', 'Bayswater', '6053', 1),
  site('ms_banksia', 'mc_jane', '4 Banksia Road', 'Morley', '6062', 400),
  site('ms_tom', 'mc_tom', '12 Wattle Street', 'Bayswater', '6053', 200),
  site('ms_jn', 'mc_jn', '12 Wattle Street', 'Bayswater', '6053', 150),
  site('ms_amy', 'mc_amy', '9 Rokeby Road', 'Subiaco', '6008', 500),
  site('ms_bea', 'mc_bea', '3 Kent Street', 'Victoria Park', '6100', 450),
  site(
    'ms_harbour',
    'mc_harbour',
    '1 Mends Street',
    'South Perth',
    '6151',
    300,
  ),
  site('ms_rita', MERGE_NEW_RITA, '9 Elm Street', 'Inglewood', '6052', 2),
  site('ms_rita_old', 'mc_rita_old', '9 Elm Street', 'Inglewood', '6052', 800),
]

function directory() {
  return {
    clients: CLIENTS.map((c) => ({
      _id: c._id,
      _creationTime: c._creationTime,
      name: c.name,
      kind: c.kind,
      clientNumber: c.clientNumber,
      status: c.status,
      createdAt: c.createdAt,
      ...('phone' in c ? { phone: c.phone } : {}),
      ...('email' in c ? { email: c.email } : {}),
      ...('archivedAt' in c ? { archivedAt: c.archivedAt } : {}),
    })),
    sites: SITES.map(({ state: _state, ...s }) => s),
    contacts: [],
    capped: false,
  }
}

/** The new Jane's open hints, newest first: her own record, by name and
 * mobile, and J. Nguyen, a similar name at her address. */
function hintsFor(clientId: string) {
  const now = Date.now()
  // Rita's archived record: Merge… greyed out, saying why.
  if (clientId === MERGE_NEW_RITA) {
    return [
      {
        _id: 'mh_rita',
        otherClientId: 'mc_rita_old',
        otherName: 'Rita Brown',
        evidence: ['name', 'site', 'mobile'],
        madeAt: now - 2 * DAY,
      },
    ]
  }
  if (clientId !== MERGE_NEW_JANE) return []
  return [
    {
      _id: 'mh_jane',
      otherClientId: 'mc_jane',
      otherName: 'Jane Nguyen',
      evidence: ['name', 'mobile'],
      madeAt: now - DAY,
    },
    {
      _id: 'mh_jn',
      otherClientId: 'mc_jn',
      otherName: 'J. Nguyen',
      evidence: ['nameNear', 'site'],
      madeAt: now - DAY - 60_000,
    },
  ]
}

/** What merging one into the other would move (`clientMerge.mergePreview`):
 * the new Jane has her one site and its job; her old record has years of
 * them, and her Xero contact. */
function previewFor(args: { fromClientId: string; intoClientId: string }) {
  const of = (id: string) => CLIENTS.find((row) => row._id === id)
  const side = (id: string) => {
    const c = of(id)
    return { name: c?.name ?? 'Client', clientNumber: c?.clientNumber ?? null }
  }
  // A business into a person: refused, as the server refuses it.
  if (
    of(args.fromClientId)?.kind === 'business' &&
    of(args.intoClientId)?.kind === 'person'
  ) {
    throw new ConvexError('KIND_MISMATCH')
  }
  // An archived client, either way round: refused as one gone.
  const archived = (id: string) => {
    const c = of(id)
    return c !== undefined && 'archivedAt' in c
  }
  if (archived(args.fromClientId) || archived(args.intoClientId)) {
    throw new ConvexError('NOT_FOUND')
  }
  const fromOld = args.fromClientId === 'mc_jane'
  return {
    from: side(args.fromClientId),
    into: side(args.intoClientId),
    moves: fromOld
      ? {
          properties: 1,
          jobs: 14,
          recurrences: 1,
          notes: 3,
          contacts: 0,
          reports: 6,
        }
      : {
          properties: 1,
          jobs: 1,
          recurrences: 0,
          notes: 0,
          contacts: 0,
          reports: 0,
        },
    xero: fromOld
      ? [{ orgName: 'Pest M8 Pest Control', outcome: 'takes_over' }]
      : [],
  }
}

function businessOf(args: unknown): string | undefined {
  return (args as { businessId?: string } | undefined)?.businessId
}

export function resolveMergeFixture(fn: string, args: unknown): unknown {
  const business = businessOf(args)
  if (business !== MERGE_BIZ && business !== MERGE_LOADING_BIZ) {
    return undefined
  }
  const clientId = (args as { clientId?: string }).clientId ?? ''
  switch (fn) {
    case 'clients:get':
      return CLIENTS.find((c) => c._id === clientId) ?? null
    case 'clients:directory':
      // Never answering, rather than undefined, which would fall through to
      // the demo business's list.
      return business === MERGE_LOADING_BIZ
        ? new Promise(() => {})
        : directory()
    case 'properties:listByClient':
      return SITES.filter((s) => s.clientId === clientId).map((s) => ({
        ...s,
        businessId: MERGE_BIZ,
      }))
    case 'clientContacts:list':
      return []
    case 'clients:summary':
      return {
        properties: SITES.filter((s) => s.clientId === clientId).map((s) => ({
          _id: s._id,
          addressLine: s.addressLine,
          suburb: s.suburb,
        })),
        series: [],
        visits: [],
        capped: false,
      }
    case 'clientMatchHints:forClient':
      return hintsFor(clientId)
    case 'clientMerge:mergePreview':
      return previewFor(args as { fromClientId: string; intoClientId: string })
    default:
      return undefined
  }
}
