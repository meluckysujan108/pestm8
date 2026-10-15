/* Xero, as `xero.status`, `xero.memberStatus` and `xeroMatch.reviewPage`
 * answer it, for the Settings → Xero / My Xero specimens, their match pages
 * (Release 2) and the Team page's Xero line — and, for the match page's
 * error states, how its mutations refuse (`XERO_MUTATIONS`). Release 3 adds
 * the sending (`sync` on a view), the client sheet's lines
 * (`xeroSync.clientLines`) and an import's undo note (`xeroSync.importNote`).
 *
 * `xero.status` is keyed by business id, so each specimen asks for a
 * business of its own and gets one state: the real page, with one answer.
 * Shaped like `XeroView` in convex/xero.ts — read it, don't guess. */

import { ConvexError } from 'convex/values'

const HOUR = 60 * 60 * 1000

/** The businesses the specimens ask for, one state each. */
export const XERO_BIZ = {
  none: 'biz_xero_none',
  connected: 'biz_xero_connected',
  reconnect: 'biz_xero_reconnect',
  leftover: 'biz_xero_leftover',
  unconfigured: 'biz_xero_unconfigured',
  demo: 'biz_xero_demo',
  /** Two-step sign-in is off, which Connect needs. */
  twoStepOff: 'biz_xero_two_step_off',
  /** Never answers: the page's placeholder. */
  loading: 'biz_xero_loading',
  /** Connected, its contacts being read. */
  matchReading: 'biz_xero_match_reading',
  /** Connected, its contacts read and matched, some to check. */
  matchReady: 'biz_xero_match_ready',
  /** Connected, and the read of its contacts failed. */
  matchFailed: 'biz_xero_match_failed',
  /** Connected, matched, and every list empty but Matched. */
  matchClean: 'biz_xero_match_clean',
  /** A read past believing (its run died), and a My Xero never read. */
  matchStopped: 'biz_xero_match_stopped',
  /** Xero paused by PestM8 (no retry), and a My Xero over Xero's limit. */
  matchPaused: 'biz_xero_match_paused',
  /** Needs reconnecting, its last read failed for that; My Xero needs
   * reconnecting with its match in. */
  matchReconnect: 'biz_xero_match_reconnect',
  /** Matched, with a Matched list longer than one page. */
  matchPaged: 'biz_xero_match_paged',
  /** Matched, and every list refuses to load. */
  matchListFails: 'biz_xero_match_list_fails',
  /** Matched a week and more ago: Start syncing would be refused. */
  matchStale: 'biz_xero_match_stale',
  /** Syncing, the book still going in, with some to check, some
   * different, changes waiting and clients Xero refused. */
  syncing: 'biz_xero_syncing',
  /** Syncing, the book all in, nothing needing anyone. */
  synced: 'biz_xero_synced',
  /** Syncing, with PestM8's kill switch on. */
  syncPaused: 'biz_xero_sync_paused',
  /** Syncing, Xero's daily limit used up and the book's walk held. */
  syncDayLimit: 'biz_xero_sync_day_limit',
} as const

type Match = {
  state: 'reading' | 'ready' | 'failed'
  at: number
  linked: number
  review: number
  fresh: number
  different: number
  leads: number
  problem: string | null
  staleAfter: number | null
}

const READY: Match = {
  state: 'ready',
  at: Date.now() - 2 * HOUR,
  linked: 412,
  review: 4,
  fresh: 37,
  different: 1,
  leads: 6,
  problem: null,
  staleAfter: null,
}

/** A run reading now, believed for another ten minutes. */
const READING: Match = {
  ...READY,
  state: 'reading',
  at: Date.now(),
  linked: 0,
  review: 0,
  fresh: 0,
  different: 0,
  leads: 0,
  staleAfter: Date.now() + 10 * 60_000,
}

/** A run that stopped, and why. */
const failed = (problem: string): Match => ({
  ...READY,
  state: 'failed',
  linked: 0,
  review: 0,
  fresh: 0,
  different: 0,
  leads: 0,
  problem,
})

/** How sending to an organisation stands (`sync` on a view, Release 3). */
type Sync = {
  counts: {
    inXero: number
    review: number
    different: number
    failed: number
    stopped: number
    waiting: number
  }
  lastSentAt: number | null
  pausedUntil: number | null
  pauseReason: 'minute' | 'day' | 'server' | null
  backfill: { done: number; total: number; heldUntil: number | null } | null
  recent: Array<{
    clientId: string
    clientName: string
    code: string
    at: number
    inXero: boolean
  }>
  problems: number
}

/** Clients Xero refused, newest first: never added, a change to one in
 * Xero refused, one only left short. The first is a client the sheet can
 * open (`clients.get` answers one client whatever is asked). */
const RECENT = [
  {
    clientId: 'c_xero_failed',
    clientName: 'Subi Café Group',
    code: 'email_invalid',
    at: Date.now() - 20 * 60_000,
    inXero: false,
  },
  {
    clientId: 'c_xero_taken',
    clientName: 'John Smith',
    code: 'name_taken',
    at: Date.now() - 2 * HOUR,
    inXero: true,
  },
  {
    clientId: 'c_xero_accents',
    clientName: 'Zoë Brennan',
    code: 'email_not_ascii',
    at: Date.now() - 3 * HOUR,
    inXero: true,
  },
  {
    clientId: 'c_xero_web',
    clientName: 'Mosman Park Strata',
    code: 'website_invalid',
    at: Date.now() - 4 * HOUR,
    inXero: false,
  },
  {
    clientId: 'c_xero_gone',
    clientName: 'Leederville Noodle House Pty Ltd',
    code: 'contact_missing',
    at: Date.now() - 5 * HOUR,
    inXero: true,
  },
]

/** Under way: two-thirds of the book in, a few needing someone. */
const SYNCING: Sync = {
  counts: {
    inXero: 302,
    review: 4,
    different: 2,
    failed: 3,
    stopped: 1,
    // Counted live up to 100 (`WAITING_CAP`): "99+".
    waiting: 100,
  },
  lastSentAt: Date.now() - 40_000,
  pausedUntil: null,
  pauseReason: null,
  backfill: { done: 302, total: 449, heldUntil: null },
  recent: RECENT,
  // More than the five listed: "The newest 5 of 7."
  problems: 7,
}

/** The book all in, and nothing for anyone to do. */
const SYNCED: Sync = {
  counts: {
    inXero: 449,
    review: 0,
    different: 0,
    failed: 0,
    stopped: 0,
    waiting: 0,
  },
  lastSentAt: Date.now() - 10 * 60_000,
  pausedUntil: null,
  pauseReason: null,
  backfill: null,
  recent: [],
  problems: 0,
}

/** Started an hour after the match was read. */
const STARTED_AT = Date.now() - HOUR

function view(
  kind: 'business' | 'member',
  status: 'pending' | 'connected' | 'needs_reconnect' | 'disconnected',
  extra: Partial<{
    problem: { code: string; at: number } | null
    disconnectReason: string | null
    match: Match | null
    syncStartedAt: number | null
    sync: Sync | null
  }> = {},
) {
  return {
    connectionId: `xc_${kind}_${status}`,
    kind,
    tenantName:
      kind === 'business' ? 'Pest M8 Pest Control' : 'Doyle Pest Services',
    status,
    connectedAt: Date.now() - 26 * HOUR,
    connectedByName: kind === 'business' ? 'Terence Walsh' : 'Kevin Doyle',
    problem: null,
    shortCode: '!x7Kp2',
    disconnectReason: null,
    match: null as Match | null,
    syncStartedAt: null as number | null,
    sync: null as Sync | null,
    ...extra,
  }
}

/** A connection syncing since `STARTED_AT`, its match in. */
function syncingView(kind: 'business' | 'member', sync: Sync) {
  return view(kind, 'connected', {
    match:
      kind === 'business'
        ? READY
        : { ...READY, linked: 380, review: 1, fresh: 69, leads: 0 },
    syncStartedAt: STARTED_AT,
    sync,
  })
}

function statusFor(businessId: string) {
  const base = {
    configured: true,
    paused: false,
    demo: false,
    switched: false,
    isOwner: true,
    twoStepOn: true,
    timezone: 'Australia/Perth',
    business: null as ReturnType<typeof view> | null,
    mine: null as ReturnType<typeof view> | null,
  }
  switch (businessId) {
    case XERO_BIZ.loading:
      return undefined
    case XERO_BIZ.unconfigured:
      return { ...base, configured: false }
    case XERO_BIZ.demo:
      return { ...base, demo: true }
    case XERO_BIZ.twoStepOff:
      return { ...base, twoStepOn: false }
    // Connected, as most connections are once their contacts have been read:
    // nothing left to check.
    case XERO_BIZ.connected:
      return {
        ...base,
        business: view('business', 'connected', {
          match: { ...READY, review: 0, different: 0, leads: 0 },
        }),
        mine: view('member', 'connected', {
          match: { ...READY, linked: 380, review: 0, different: 0, leads: 0 },
        }),
      }
    case XERO_BIZ.matchReading:
      return {
        ...base,
        business: view('business', 'connected', { match: READING }),
        mine: view('member', 'connected', { match: READING }),
      }
    case XERO_BIZ.matchReady:
      return {
        ...base,
        business: view('business', 'connected', { match: READY }),
        mine: view('member', 'connected', {
          match: {
            ...READY,
            linked: 380,
            review: 1,
            fresh: 69,
            different: 0,
            leads: 0,
          },
        }),
      }
    case XERO_BIZ.matchClean:
      return {
        ...base,
        business: view('business', 'connected', {
          match: { ...READY, review: 0, fresh: 0, different: 0, leads: 0 },
        }),
      }
    case XERO_BIZ.matchFailed:
      return {
        ...base,
        business: view('business', 'connected', { match: failed('busy') }),
        mine: view('member', 'connected', {
          match: failed('too_many_contacts'),
        }),
      }
    case XERO_BIZ.matchStopped:
      return {
        ...base,
        business: view('business', 'connected', {
          match: {
            ...READING,
            at: Date.now() - 20 * 60_000,
            staleAfter: Date.now() - 13 * 60_000,
          },
        }),
        mine: view('member', 'connected', { match: null }),
      }
    case XERO_BIZ.matchPaused:
      return {
        ...base,
        paused: true,
        business: view('business', 'connected', { match: failed('paused') }),
        mine: view('member', 'connected', { match: failed('rate_limited') }),
      }
    case XERO_BIZ.matchReconnect:
      return {
        ...base,
        business: view('business', 'needs_reconnect', {
          problem: { code: 'reconnect', at: Date.now() - HOUR },
          match: failed('reconnect'),
        }),
        mine: view('member', 'needs_reconnect', {
          problem: { code: 'reconnect', at: Date.now() - HOUR },
          match: { ...READY, linked: 380, review: 1, fresh: 69, leads: 0 },
        }),
      }
    case XERO_BIZ.matchPaged:
    case XERO_BIZ.matchListFails:
      return {
        ...base,
        business: view('business', 'connected', { match: READY }),
      }
    case XERO_BIZ.matchStale:
      return {
        ...base,
        business: view('business', 'connected', {
          match: { ...READY, at: Date.now() - 9 * 24 * HOUR },
        }),
      }
    case XERO_BIZ.syncing:
      return {
        ...base,
        business: syncingView('business', SYNCING),
        mine: syncingView('member', {
          ...SYNCING,
          counts: { ...SYNCING.counts, inXero: 120, review: 1, waiting: 100 },
          backfill: { done: 120, total: 449, heldUntil: null },
          recent: RECENT.slice(0, 1),
          problems: 1,
        }),
      }
    case XERO_BIZ.synced:
      return {
        ...base,
        business: syncingView('business', SYNCED),
        // Xero itself failing, so PestM8 waits a while.
        mine: syncingView('member', {
          ...SYNCED,
          counts: { ...SYNCED.counts, waiting: 3 },
          pausedUntil: Date.now() + 40 * 60_000,
          pauseReason: 'server',
        }),
      }
    case XERO_BIZ.syncPaused:
      return {
        ...base,
        paused: true,
        // Nothing to check, two different: the hub's third badge.
        business: syncingView('business', {
          ...SYNCED,
          counts: { ...SYNCED.counts, waiting: 12, different: 2 },
        }),
        mine: syncingView('member', SYNCED),
      }
    case XERO_BIZ.syncDayLimit:
      return {
        ...base,
        // The day's calls used up: everything waits.
        business: syncingView('business', {
          ...SYNCING,
          recent: [],
          problems: 0,
          counts: { ...SYNCING.counts, failed: 0, different: 0 },
          pausedUntil: Date.now() + 9 * HOUR,
          pauseReason: 'day',
          backfill: { done: 302, total: 449, heldUntil: Date.now() + 9 * HOUR },
        }),
        // Nearly used up: the book's walk waits, live changes go.
        mine: syncingView('member', {
          ...SYNCING,
          recent: [],
          problems: 0,
          counts: { ...SYNCING.counts, inXero: 120, review: 1, failed: 0 },
          backfill: {
            done: 120,
            total: 449,
            heldUntil: Date.now() + 50 * 60_000,
          },
        }),
      }
    case XERO_BIZ.reconnect:
      return {
        ...base,
        business: view('business', 'needs_reconnect', {
          problem: { code: 'reconnect', at: Date.now() - 3 * HOUR },
        }),
        mine: view('member', 'needs_reconnect', {
          problem: { code: 'reconnect', at: Date.now() - 3 * HOUR },
        }),
      }
    case XERO_BIZ.leftover:
      return {
        ...base,
        business: view('business', 'disconnected', {
          problem: { code: 'xero_side', at: Date.now() - HOUR },
          disconnectReason: 'by_hand',
        }),
      }
    // Everything else — the Team page's business (`BIZ`) among them — is set
    // up for Xero, with nothing connected.
    default:
      return base
  }
}

/** The Team page's members, one Xero state each (`MEMBERS` in fixtures). */
function memberStatusFor(membershipId: string) {
  switch (membershipId) {
    case 'm_kev':
      return {
        status: 'connected',
        tenantName: 'Doyle Pest Services',
        connectedAt: Date.now() - 26 * HOUR,
      }
    case 'm_sam':
      return {
        status: 'needs_reconnect',
        tenantName: 'Nguyen Pest & Termite',
        connectedAt: Date.now() - 40 * 24 * HOUR,
      }
    default:
      return null
  }
}

/** One client on the match page, as `xeroMatch.reviewPage` gives it. */
function item(
  clientId: string,
  clientName: string,
  extra: Partial<{
    clientNumber: number
    clientPhone: string
    clientSuburb: string
    state: 'linked' | 'needs_review' | 'separate' | 'new'
    how: 'matched' | 'chosen' | 'created'
    xeroName: string
    decidedAt: number
    decidedByYou: boolean
    candidate: {
      contactId: string
      name: string
      email?: string
      phone?: string
      place?: string
      accountNumber?: string
      reason:
        | 'account_number_only'
        | 'email_only'
        | 'name_only'
        | 'name_shared'
        | 'contested'
        | 'unlinked'
    }
  }> = {},
) {
  return { clientId, clientName, state: 'new', decidedByYou: false, ...extra }
}

/** To check: one of each reason, the PestM8 client above the contact. */
const TO_CHECK = [
  item('c_jan', 'Jan Morris', {
    state: 'needs_review',
    clientNumber: 118,
    clientPhone: '0412 345 678',
    clientSuburb: 'Nightcliff',
    candidate: {
      contactId: 'x_jan',
      name: 'Morris, Janet',
      email: 'jan.morris@bigpond.com',
      phone: '0412 345 678',
      place: 'Darwin',
      reason: 'email_only',
    },
  }),
  item('c_coastal', 'Coastal Property Group', {
    state: 'needs_review',
    clientNumber: 42,
    clientPhone: '08 9335 1200',
    clientSuburb: 'Fremantle',
    candidate: {
      contactId: 'x_coastal',
      name: 'Coastal Property Management Pty Ltd',
      email: 'accounts@coastalpropertymanagement.com.au',
      phone: '08 9335 1200',
      place: 'Fremantle',
      accountNumber: '0042',
      reason: 'account_number_only',
    },
  }),
  item('c_sam', 'Sam Nguyen', {
    state: 'needs_review',
    clientNumber: 207,
    clientSuburb: 'Morley',
    candidate: {
      contactId: 'x_sam',
      name: 'Sam Nguyen',
      phone: '0400 111 222',
      place: 'Perth',
      reason: 'name_shared',
    },
  }),
  item('c_bayview', 'Bayview Strata', {
    state: 'needs_review',
    clientNumber: 64,
    clientSuburb: 'Applecross',
    candidate: {
      contactId: 'x_bayview',
      name: 'Bayview Strata',
      email: 'admin@bayviewstrata.com.au',
      place: 'Applecross',
      reason: 'contested',
    },
  }),
]

const MATCHED = [
  item('c_terence', 'Terence Walsh', {
    state: 'linked',
    how: 'matched',
    clientNumber: 1,
    xeroName: 'Terence Walsh',
  }),
  item('c_harbour', 'Harbour Café', {
    state: 'linked',
    how: 'chosen',
    clientNumber: 23,
    xeroName: 'Harbour Cafe Pty Ltd',
    decidedAt: Date.now() - 3 * HOUR,
    decidedByYou: true,
  }),
  item('c_lee', 'Lee Anderson', {
    state: 'linked',
    how: 'matched',
    clientNumber: 31,
    xeroName: 'Anderson, Lee',
  }),
  item('c_stjohn', 'St John’s Primary School', {
    state: 'linked',
    how: 'matched',
    clientNumber: 58,
    xeroName: 'St John’s Primary School',
  }),
  // Added by PestM8 once syncing: no Unlink.
  item('c_morris', 'Jan Morris', {
    state: 'linked',
    how: 'created',
    clientNumber: 118,
    xeroName: 'Jan Morris (Nightcliff)',
  }),
]

const NEW = [
  item('c_mia', 'Mia Torres', {
    clientNumber: 301,
    clientSuburb: 'Scarborough',
  }),
  item('c_ridge', 'Ridgeway Childcare Centre', {
    clientNumber: 302,
    clientSuburb: 'Joondalup',
  }),
  item('c_kim', 'Kim Pham', { clientNumber: 305, clientSuburb: 'Balga' }),
]

const DIFFERENT = [
  item('c_rob', 'Rob Kelly', {
    state: 'separate',
    clientNumber: 77,
    clientSuburb: 'Midland',
    decidedAt: Date.now() - 5 * HOUR,
    decidedByYou: true,
    candidate: {
      contactId: 'x_rob',
      name: 'Robert Kelly',
      place: 'Bunbury',
      reason: 'name_only',
    },
  }),
  item('c_dana', 'Dana Whitfield', {
    state: 'separate',
    clientNumber: 91,
    clientSuburb: 'Subiaco',
    decidedAt: Date.now() - 6 * HOUR,
    decidedByYou: true,
    candidate: {
      contactId: 'x_dana',
      name: 'Whitfield Holdings',
      reason: 'unlinked',
    },
  }),
]

/** The Matched list's second page, after "Show more". */
const MATCHED_MORE = [
  item('c_vu', 'Thanh Vu', {
    state: 'linked',
    how: 'matched',
    clientNumber: 61,
    xeroName: 'Vu, Thanh',
  }),
  item('c_oakwood', 'Oakwood Aged Care', {
    state: 'linked',
    how: 'chosen',
    clientNumber: 66,
    xeroName: 'Oakwood Aged Care Ltd',
    decidedAt: Date.now() - 26 * HOUR,
  }),
]

function reviewPageFor(args: {
  businessId: string
  filter: string
  paginationOpts?: { cursor: string | null }
}) {
  if (args.businessId === XERO_BIZ.loading) return undefined
  if (args.businessId === XERO_BIZ.matchListFails) {
    throw new Error('[harness] the list refused to load')
  }
  if (args.businessId === XERO_BIZ.matchPaged && args.filter === 'matched') {
    return args.paginationOpts?.cursor === 'page2'
      ? { page: MATCHED_MORE, isDone: true, continueCursor: 'end' }
      : { page: MATCHED, isDone: false, continueCursor: 'page2' }
  }
  const clean = args.businessId === XERO_BIZ.matchClean
  const page =
    args.filter === 'review'
      ? clean
        ? []
        : TO_CHECK
      : args.filter === 'matched'
        ? MATCHED
        : args.filter === 'new'
          ? clean
            ? []
            : NEW
          : clean
            ? []
            : DIFFERENT
  return { page, isDone: true, continueCursor: 'end' }
}

/** One client's place in one organisation (`xeroSync.clientLines`). */
export type XeroLineFixture = {
  connectionId: string
  kind: 'business' | 'member'
  orgName: string
  state:
    | 'in_xero'
    | 'waiting'
    | 'lead'
    | 'to_check'
    | 'archived'
    | 'gdpr'
    | 'different'
    | 'failed'
    | 'not_yet'
  lastSentAt: number | null
  different: Array<string>
  problemCode: string | null
  candidateName: string | null
  openUrl: string | null
  canOverwrite: boolean
}

const OPEN_URL =
  'https://go.xero.com/organisationlogin/default.aspx?shortcode=!x7Kp2&redirecturl=/Contacts/View/7d1c3f2a-0000-4000-8000-000000000001'

/** A line in the business's organisation, in one state. */
export function xeroLine(
  state: XeroLineFixture['state'],
  extra: Partial<XeroLineFixture> = {},
): XeroLineFixture {
  return {
    connectionId: `xc_business_${state}`,
    kind: 'business',
    orgName: 'Pest M8 Pest Control',
    state,
    lastSentAt: null,
    different: [],
    problemCode: null,
    candidateName: null,
    openUrl: null,
    // The owner looking: theirs to send over Xero's.
    canOverwrite: state === 'different',
    ...extra,
  }
}

/** Every state a client's line can be in, for the sheet's rows at once.
 * `canEditClient` false: someone who can't change clients is looking (a
 * subcontractor on their own Xero). */
export const EVERY_XERO_LINE: Array<{
  title: string
  line: XeroLineFixture
  canEditClient?: boolean
}> = [
  {
    title: 'In Xero',
    line: xeroLine('in_xero', {
      lastSentAt: Date.now() - 2 * HOUR,
      openUrl: OPEN_URL,
    }),
  },
  {
    title: 'In Xero, before Start syncing (matched)',
    line: xeroLine('in_xero', { openUrl: OPEN_URL }),
  },
  { title: 'Waiting', line: xeroLine('waiting', { openUrl: OPEN_URL }) },
  { title: 'Lead', line: xeroLine('lead') },
  {
    title: 'To check',
    line: xeroLine('to_check', { candidateName: 'Subi Cafe Pty Ltd' }),
  },
  {
    title: 'Different',
    line: xeroLine('different', {
      lastSentAt: Date.now() - 26 * HOUR,
      different: ['email', 'phoneMobile'],
      openUrl: OPEN_URL,
    }),
  },
  {
    title: 'Different, contact people',
    line: xeroLine('different', {
      lastSentAt: Date.now() - 26 * HOUR,
      different: ['persons'],
      openUrl: OPEN_URL,
    }),
  },
  {
    // Cleared in PestM8: nothing blank is sent, so no Send PestM8’s
    // details.
    title: 'Different, a detail cleared here',
    line: xeroLine('different', {
      lastSentAt: Date.now() - 26 * HOUR,
      different: ['email'],
      openUrl: OPEN_URL,
      canOverwrite: false,
    }),
  },
  {
    title: 'Failed',
    line: xeroLine('failed', { problemCode: 'email_invalid' }),
  },
  {
    title: 'Failed, seen by a subcontractor',
    line: xeroLine('failed', {
      kind: 'member',
      orgName: 'Doyle Pest Services',
      problemCode: 'email_invalid',
      canOverwrite: false,
    }),
    canEditClient: false,
  },
  {
    title: 'Not found in Xero (tried again later)',
    line: xeroLine('failed', { problemCode: 'name_unread' }),
  },
  {
    title: 'In Xero, its email left out',
    line: xeroLine('in_xero', {
      lastSentAt: Date.now() - 5 * 60_000,
      problemCode: 'email_not_ascii',
      openUrl: OPEN_URL,
    }),
  },
  { title: 'Archived', line: xeroLine('archived', { openUrl: OPEN_URL }) },
  { title: 'Privacy', line: xeroLine('gdpr') },
  { title: 'Not reached', line: xeroLine('not_yet') },
]

/** Two organisations on one client: the business's, then the person's own
 * — each row then names its organisation. */
export const TWO_XERO_LINES: Array<XeroLineFixture> = [
  xeroLine('in_xero', { lastSentAt: Date.now() - 2 * HOUR, openUrl: OPEN_URL }),
  xeroLine('waiting', {
    connectionId: 'xc_member_waiting',
    kind: 'member',
    orgName: 'Doyle Pest Services',
  }),
]

/** The client sheet's lines, by client: the sample client is in the
 * business's Xero; the one Recent problems opens was refused. */
function clientLinesFor(args: { clientId: string }) {
  switch (args.clientId) {
    case 'c1':
      return [
        xeroLine('in_xero', {
          lastSentAt: Date.now() - 2 * HOUR,
          openUrl: OPEN_URL,
        }),
      ]
    case 'c_xero_failed':
      return [xeroLine('failed', { problemCode: 'email_invalid' })]
    default:
      return []
  }
}

export const XERO_FIXTURES: Record<string, (args: never) => unknown> = {
  'xero:status': (args: { businessId: string }) => statusFor(args.businessId),
  'xero:memberStatus': (args: { membershipId: string }) =>
    memberStatusFor(args.membershipId),
  'xeroMatch:reviewPage': (args: { businessId: string; filter: string }) =>
    reviewPageFor(args),
  'xeroSync:clientLines': (args: { clientId: string }) => clientLinesFor(args),
  // Three of the import's clients have reached Xero.
  'xeroSync:importNote': () => ({ inXero: 3 }),
}

/**
 * How the match page's mutations answer, where a specimen needs them to
 * refuse: Same on Bayview Strata, whose contact another client already has
 * (CONTACT_TAKEN), and Unlink on St John's, matched to nothing any more by
 * the time it is confirmed. Match again puts a client back To check.
 */
export const XERO_MUTATIONS: Record<string, (args: never) => unknown> = {
  'xeroMatch:decide': (args: { clientId: string; choice: string }) => {
    if (args.clientId === 'c_bayview' && args.choice === 'same') {
      throw new ConvexError('CONTACT_TAKEN')
    }
    return null
  },
  'xeroMatch:unlink': (args: { clientId: string }) => {
    if (args.clientId === 'c_stjohn') throw new ConvexError('NOT_FOUND')
    return null
  },
  'xeroMatch:reopen': () => 'needs_review',
}

/** Queries answered live — through the Convex client, as a paginated list
 * reads them — rather than only through React Query. */
export const XERO_LIVE = new Set(['xeroMatch:reviewPage'])
