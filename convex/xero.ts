import { ConvexError, v } from 'convex/values'
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server'
import { internal } from './_generated/api'
import {
  hasCapability,
  requireActor,
  requireCapability,
  requireWriteActor,
} from './lib/actor'
import { requireAuthUser } from './lib/access'
import { forSelf, recordAudit } from './lib/audit'
import { isSwitched } from './lib/capabilities'
import { hashInviteToken, newInviteToken } from './lib/inviteTokens'
import { displayNameOf } from './lib/membershipFacts'
import { memberName } from './lib/reportContext'
import {
  XERO_AUTHORIZE_URL,
  XERO_FINISH_TTL_MS,
  XERO_SCOPES,
  XERO_STATE_TTL_MS,
  XERO_TERMS_VERSION,
  maxOrgs,
  redirectUri,
  xeroClientId,
  xeroConfigured,
  xeroPaused,
} from './lib/xeroConfig'
import { XeroError, deleteConnection, getOrganisation } from './lib/xeroHttp'
import {
  LIVE_XERO_STATUSES,
  isLiveXero,
  requireConnectionHolder,
} from './lib/xeroHooks'
import { DEMO_PLAN } from './demo/shared'
import { linkOf, matchAfterConnect, matchStaleAfter } from './xeroMatch'
import { accessTokenFor, retireGrant } from './xeroTokens'
import { RECENT_SHOWN, WAITING_CAP } from './xeroSync'
import { xeroConnectionKind, xeroMatchState, xeroPauseReason } from './schema'
import type { Infer } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'
import type { ActionCtx, MutationCtx, QueryCtx } from './_generated/server'

/**
 * Connecting Xero (Release 1): the business's own organisation, connected by
 * the owner, and each contractor's or subcontractor's own ("My Xero").
 * Nothing here sends a client to Xero — the only calls are the sign-in, the
 * token exchange and refresh, `GET /Organisation`, and taking PestM8 back out
 * (`DELETE /connections`, revoke). A finished connect starts the match of the
 * organisation's contacts (Release 2, convex/xeroMatch.ts), which only reads;
 * sending is convex/xeroSync.ts (Release 3), whose progress `status` reports.
 * docs/xero.md is the runbook.
 *
 * ── How a connect runs ───────────────────────────────────────────────────
 *
 *  1. `startConnect` (action) mints the OAuth `state`; `beginConnect` checks
 *     who may connect what and stores only its hash, bound to the user AND
 *     membership that pressed the button.
 *  2. Xero sends the browser to `GET /xero/callback` (convex/xeroCallback.ts),
 *     which spends the state (`takeState`), swaps the code for tokens, picks
 *     the organisation, and stores a `pending` connection with a one-time
 *     finish token (`storeCallback`) — or refuses, in words the page knows.
 *  3. The settings page, signed in, hands the finish token to
 *     `finishConnect`, and `finish` connects it — only for the same signed-in
 *     person who started. A finish link that reaches anyone else is useless
 *     to them, and a Xero sign-in link someone else completes lands its
 *     finish token in THEIR browser, where the sender cannot finish it.
 *
 *     That is binding to the person, not to the browser: the state is not
 *     tied to the browser that pressed Connect. Someone who completes
 *     another person's Xero sign-in link and then hands back the address
 *     they landed on has given that person their organisation, as surely as
 *     sharing a Xero login would — Xero's own consent screen, which names
 *     PestM8 and the organisation, is the warning. Binding the state to the
 *     browser (a cookie set on the way to Xero, checked by the callback) is
 *     the fix if that ever matters more.
 *
 * ── Who may ──────────────────────────────────────────────────────────────
 *
 * The business kind is `business.manage` (the owner, never while switched).
 * The member kind is any non-owner, for themselves only: the owner's own
 * organisation IS the business's, so the owner has no "My Xero". Every
 * connected organisation receives the whole client book from Release 3
 * (decision of 2026-10-06), which is what the disclosure on the page says and
 * what the audit row records they were shown (`disclosure`).
 *
 * ── Errors the page words (src/components/xero/xeroCopy.ts) ──────────────
 *
 * XERO_NOT_CONFIGURED, XERO_DEMO, SWITCHED, NO_ACCESS, NOT_FOUND,
 * FINISH_EXPIRED, TAKEN — and the callback's `?xero=` codes, which are the
 * `Refusal`s below plus cancelled / failed / no_org / ambiguous_org /
 * expired.
 */

// ───────────────────────────────────────────────────────────────── shapes

const connectionStatus = v.union(
  v.literal('pending'),
  v.literal('connected'),
  v.literal('needs_reconnect'),
  v.literal('disconnected'),
)

/**
 * How sending to one organisation stands, for the Xero page and the hub
 * (convex/xeroSync.ts). Times are for the page to compare with its own
 * clock — a query mustn't read one.
 */
const syncView = v.object({
  counts: v.object({
    /** Clients that are a contact there. */
    inXero: v.number(),
    /** Waiting on Same or Different ("To check"). */
    review: v.number(),
    /** Left alone because Xero holds something else ("Different in Xero"). */
    different: v.number(),
    /** Not added, or their last change refused. */
    failed: v.number(),
    /** Archived or erased in Xero: no longer sent. */
    stopped: v.number(),
    /** Changes queued now, counted to 100: the page shows "99+" past 99. */
    waiting: v.number(),
  }),
  lastSentAt: v.union(v.number(), v.null()),
  /** Xero said to wait until then (its minute or day allowance, or an
   * outage); past it, nothing is held. */
  pausedUntil: v.union(v.number(), v.null()),
  pauseReason: v.union(xeroPauseReason, v.null()),
  /** Adding the book after Start syncing: clients that are a contact there
   * (`done`) of those it gets (`total`). Null once the walk is done. */
  backfill: v.union(
    v.null(),
    v.object({
      done: v.number(),
      total: v.number(),
      /** The day's allowance ran low: the walk waits until then. */
      heldUntil: v.union(v.number(), v.null()),
    }),
  ),
  /** The latest problems that still stand, newest first, at most five, one
   * per client: codes the page words (xeroCopy.ts), with the client to
   * open, and whether it is a contact there (a change refused, or something
   * left off one) or was never added. */
  recent: v.array(
    v.object({
      clientId: v.id('clients'),
      clientName: v.string(),
      code: v.string(),
      at: v.number(),
      inXero: v.boolean(),
    }),
  ),
  /** How many problems still stand, of the newest twenty kept: "The newest
   * 5 of {n}." */
  problems: v.number(),
})

/**
 * One connection as Settings is given it. A `returns` validator, like
 * `memberLicences.listView`: a later `...connection` in a handler, carrying
 * `grantId`, fails every call instead of reaching the page. Nothing of
 * `xeroGrants` is ever in it.
 */
const xeroView = v.object({
  connectionId: v.id('xeroConnections'),
  kind: xeroConnectionKind,
  tenantName: v.string(),
  status: connectionStatus,
  connectedAt: v.union(v.number(), v.null()),
  /** Who connected it, as attribution prints a member's name. */
  connectedByName: v.string(),
  /** A code the page words (xeroCopy.ts): reconnect, xero_side, org_gone. */
  problem: v.union(v.object({ code: v.string(), at: v.number() }), v.null()),
  /** For "Open in Xero" links, once `GET /Organisation` has answered. */
  shortCode: v.union(v.string(), v.null()),
  /** Only meaningful when `status` is `disconnected`. */
  disconnectReason: v.union(v.string(), v.null()),
  /**
   * How matching its contacts stands (convex/xeroMatch.ts): null until a
   * match is first asked for — which connecting does in the same write, so
   * a connected connection with none was connected before matching existed.
   * `fresh` is the clients Xero will get as new contacts — nothing matched,
   * or Different — `different` the Different ones among them, and `leads`
   * those waiting for their first job. `problem` is a code the page words
   * (xeroCopy.ts). `staleAfter`, while reading: when the page should call
   * the read stopped and offer Check Xero again, because the run reading it
   * has died without saying so (`xeroMatch.matchStaleAfter`) — a time the
   * page compares with its own clock, since a query mustn't read one.
   */
  match: v.union(
    v.null(),
    v.object({
      state: xeroMatchState,
      at: v.number(),
      linked: v.number(),
      review: v.number(),
      fresh: v.number(),
      different: v.number(),
      leads: v.number(),
      problem: v.union(v.string(), v.null()),
      staleAfter: v.union(v.number(), v.null()),
    }),
  ),
  /** When Start syncing was pressed (Release 3): null before, when nothing
   * is sent to this organisation. */
  syncStartedAt: v.union(v.number(), v.null()),
  /** How sending stands (convex/xeroSync.ts), once started. */
  sync: v.union(v.null(), syncView),
})

export type XeroView = Infer<typeof xeroView>
export type XeroSyncView = Infer<typeof syncView>

const statusView = v.object({
  /** False on a deployment without the Xero app's keys (e2e, local). */
  configured: v.boolean(),
  /** The kill switch, `XERO_SYNC_PAUSED=on`. */
  paused: v.boolean(),
  /** The demo business, which may never connect a real Xero. */
  demo: v.boolean(),
  /** Working in someone else's account: nothing here may be changed. */
  switched: v.boolean(),
  /** The real person is the owner, who has the business's Xero and no
   * "My Xero". */
  isOwner: v.boolean(),
  /** Whether the signed-in person has two-step sign-in on, which connecting
   * Xero needs (`requireTwoStep`). */
  twoStepOn: v.boolean(),
  timezone: v.string(),
  /** The business's Xero — only for whoever may manage the business. */
  business: v.union(xeroView, v.null()),
  /** The caller's own Xero — only for a non-owner. */
  mine: v.union(xeroView, v.null()),
})

const memberStatusView = v.union(
  v.object({
    status: v.union(
      v.literal('pending'),
      v.literal('connected'),
      v.literal('needs_reconnect'),
    ),
    tenantName: v.string(),
    connectedAt: v.union(v.number(), v.null()),
  }),
  v.null(),
)

type Kind = Infer<typeof xeroConnectionKind>

/** Why the callback turned an organisation away; the `?xero=` code. */
export type Refusal =
  'demo' | 'different_org' | 'business_org' | 'member_org' | 'taken' | 'org_cap'

/** What the audit row says the person was shown before connecting: the
 * whole client book goes to the organisation they choose. Bump it when the
 * disclosure on the page changes what it promises. */
const DISCLOSURE = 'whole_book_v1'

/** How many times a release or an organisation read is tried before it
 * gives up. Each wait doubles from a minute, so about half an hour in all. */
const MAX_ATTEMPTS = 5

// ──────────────────────────────────────────────────────────────── reading

/**
 * Whether the signed-in person has two-step sign-in on.
 *
 * Connecting Xero asks for it. Registering PestM8 with Xero meant agreeing to
 * Xero's minimum security requirements, which include strong sign-in for
 * whoever links an organisation — and two-step sign-in is optional in PestM8
 * (lib/mfa.ts). Someone holding only a password should not be able to pour
 * the client book into a Xero organisation, so Connect needs it on, and
 * finishing checks again in case it was switched off in between. Nothing
 * else in the app changes: everyone else keeps their choice.
 */
async function twoStepOn(ctx: QueryCtx | MutationCtx): Promise<boolean> {
  const user = await requireAuthUser(ctx)
  return user.twoFactorEnabled === true
}

async function requireTwoStep(ctx: QueryCtx | MutationCtx): Promise<void> {
  if (!(await twoStepOn(ctx))) {
    throw new ConvexError('XERO_TWO_STEP_REQUIRED')
  }
}

async function businessOf(
  ctx: QueryCtx | MutationCtx,
  businessId: Id<'businesses'>,
): Promise<Doc<'businesses'>> {
  const business = await ctx.db.get('businesses', businessId)
  if (!business) throw new ConvexError('NOT_FOUND')
  return business
}

/** The newest of each live status, then the newest disconnected one: what
 * Settings shows. At most one business-kind row is live per business, so the
 * scans that pass over member rows stop almost at once. */
async function businessConnection(
  ctx: QueryCtx | MutationCtx,
  businessId: Id<'businesses'>,
  { liveOnly }: { liveOnly: boolean },
): Promise<Doc<'xeroConnections'> | null> {
  const newest = async (which: Doc<'xeroConnections'>['status']) =>
    ctx.db
      .query('xeroConnections')
      .withIndex('by_business_and_status', (q) =>
        q.eq('businessId', businessId).eq('status', which),
      )
      .order('desc')
      .filter((q) => q.eq(q.field('kind'), 'business'))
      .first()

  const live = (await Promise.all(LIVE_XERO_STATUSES.map(newest))).filter(
    (row): row is Doc<'xeroConnections'> => row !== null,
  )
  if (live.length > 0) {
    return live.reduce((a, b) => (b._creationTime > a._creationTime ? b : a))
  }
  return liveOnly ? null : newest('disconnected')
}

/** A member's own connection in this business: the live one if there is
 * one, else (unless `liveOnly`) the newest they ever made. */
async function memberConnection(
  ctx: QueryCtx | MutationCtx,
  membershipId: Id<'memberships'>,
  { liveOnly }: { liveOnly: boolean },
): Promise<Doc<'xeroConnections'> | null> {
  const rows = await ctx.db
    .query('xeroConnections')
    .withIndex('by_membership', (q) => q.eq('membershipId', membershipId))
    .order('desc')
    .take(50)
  const mine = rows.filter((row) => row.kind === 'member')
  const live = mine.find(isLiveXero)
  if (live) return live
  return liveOnly ? null : (mine.at(0) ?? null)
}

/** The name attribution prints for whoever connected it: the frozen
 * `displayName` once there is one, else the live Better Auth name. */
async function nameOfMember(
  ctx: QueryCtx,
  membershipId: Id<'memberships'>,
): Promise<string> {
  const member = await ctx.db.get('memberships', membershipId)
  if (!member) return 'Unknown'
  if (member.displayName) return member.displayName
  return displayNameOf(
    member,
    (await memberName(ctx, member.userId)) || undefined,
  )
}

/** How sending stands, once started. */
async function syncSummaryOf(
  ctx: QueryCtx,
  connection: Doc<'xeroConnections'>,
  sync: Doc<'xeroSyncState'> | null,
): Promise<Pick<XeroView, 'syncStartedAt' | 'sync'>> {
  if (connection.syncStartedAt === undefined || !sync) {
    return { syncStartedAt: connection.syncStartedAt ?? null, sync: null }
  }
  // Live, rather than the tally a drain last wrote: the page shows a change
  // waiting the moment it is made.
  const waiting = (
    await ctx.db
      .query('xeroOutbox')
      .withIndex('by_connection_and_dueAt', (q) =>
        q.eq('connectionId', connection._id),
      )
      .take(WAITING_CAP)
  ).length
  const counts = sync.counts ?? {
    inXero: 0,
    review: 0,
    different: 0,
    failed: 0,
    stopped: 0,
    waiting: 0,
  }
  // Only what still stands: a problem put right since — the client
  // corrected and sent, or tried again and taken — is no longer its link's,
  // and goes; and a client is listed once, for its newest.
  const standing: XeroSyncView['recent'] = []
  const listed = new Set<Id<'clients'>>()
  for (const problem of sync.recent ?? []) {
    if (listed.has(problem.clientId)) continue
    listed.add(problem.clientId)
    const client = await ctx.db.get('clients', problem.clientId)
    // A client gone since, or in the bin, is nothing to open.
    if (!client || client.deletedAt !== undefined) continue
    const link = await linkOf(
      ctx,
      connection.businessId,
      connection.tenantId,
      problem.clientId,
    )
    if (link?.problem?.code !== problem.code) continue
    standing.push({
      clientId: problem.clientId,
      clientName: client.name,
      code: problem.code,
      at: problem.at,
      inXero: link.state === 'linked' && link.xeroContactId !== undefined,
    })
  }
  const match = sync.match
  return {
    syncStartedAt: connection.syncStartedAt,
    sync: {
      counts: { ...counts, waiting },
      lastSentAt: sync.lastSentAt ?? null,
      pausedUntil: sync.pausedUntil ?? null,
      pauseReason: sync.pauseReason ?? null,
      // Matched or added, of matched or added plus still to add — the
      // match's own counts, which every link move keeps true.
      backfill:
        sync.backfillDoneAt === undefined
          ? {
              done: match?.linked ?? counts.inXero,
              total: (match?.linked ?? counts.inXero) + (match?.fresh ?? 0),
              heldUntil: sync.backfillHeldUntil ?? null,
            }
          : null,
      recent: standing.slice(0, RECENT_SHOWN),
      problems: standing.length,
    },
  }
}

async function viewOf(
  ctx: QueryCtx,
  connection: Doc<'xeroConnections'>,
): Promise<XeroView> {
  // Its own row, not the connection's: a run's writes land there.
  const sync = await ctx.db
    .query('xeroSyncState')
    .withIndex('by_connection', (q) => q.eq('connectionId', connection._id))
    .first()
  const match = sync?.match
  const staleAfter = sync ? matchStaleAfter(sync) : null
  return {
    ...(await syncSummaryOf(ctx, connection, sync)),
    connectionId: connection._id,
    kind: connection.kind,
    tenantName: connection.tenantName,
    status: connection.status,
    connectedAt: connection.connectedAt ?? null,
    connectedByName: await nameOfMember(ctx, connection.membershipId),
    problem: connection.problem ?? null,
    shortCode: connection.shortCode ?? null,
    disconnectReason: connection.disconnectReason ?? null,
    match: match
      ? {
          state: match.state,
          at: match.at,
          linked: match.linked,
          review: match.review,
          fresh: match.fresh,
          different: match.different,
          leads: match.leads,
          problem: match.problem ?? null,
          staleAfter,
        }
      : null,
  }
}

/**
 * What the Xero pages and the Settings rows read.
 *
 * `business` only for whoever holds `business.manage` — the owner, and not
 * while switched — and `mine` only for a non-owner, who has a "My Xero".
 * A disconnected connection is still returned (the newest one), so the page
 * can say why it stopped — "remove PestM8 in Xero" when the release at Xero
 * could not run. Never a field of the grant.
 */
export const status = query({
  args: { businessId: v.id('businesses') },
  returns: statusView,
  handler: async (ctx, { businessId }) => {
    const env = await requireActor(ctx, businessId)
    const business = await businessOf(ctx, businessId)
    const isOwner = env.actor.real.role === 'owner'

    const own = hasCapability(env, 'business.manage')
      ? await businessConnection(ctx, businessId, { liveOnly: false })
      : null
    const mine = isOwner
      ? null
      : await memberConnection(ctx, env.actor.real._id, { liveOnly: false })

    return {
      configured: xeroConfigured(),
      paused: xeroPaused(),
      demo: business.plan === DEMO_PLAN,
      switched: isSwitched(env.actor),
      isOwner,
      twoStepOn: await twoStepOn(ctx),
      timezone: business.timezone,
      business: own ? await viewOf(ctx, own) : null,
      mine: mine ? await viewOf(ctx, mine) : null,
    }
  },
})

/**
 * One member's own Xero, for the owner's Team screen: read-only, and only
 * whether it is connected and to what. Null when they have none, or only
 * disconnected ones. Owner only (`business.manage`) — a member's books are
 * not a contractor's to look into, any more than their licences are.
 */
export const memberStatus = query({
  args: {
    businessId: v.id('businesses'),
    membershipId: v.id('memberships'),
  },
  returns: memberStatusView,
  handler: async (ctx, { businessId, membershipId }) => {
    const env = await requireActor(ctx, businessId)
    requireCapability(env, 'business.manage')
    const member = await ctx.db.get('memberships', membershipId)
    if (!member || member.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    const connection = await memberConnection(ctx, membershipId, {
      liveOnly: true,
    })
    if (!connection || connection.status === 'disconnected') return null
    return {
      status: connection.status,
      tenantName: connection.tenantName,
      connectedAt: connection.connectedAt ?? null,
    }
  },
})

// ─────────────────────────────────────────────────────────── connecting

/**
 * Where "Connect Xero" sends the browser. The state is minted here, in an
 * action, for the reason lib/inviteTokens.ts gives (a mutation's randomness
 * is replayable), and only its hash is stored.
 */
export const startConnect = action({
  args: { businessId: v.id('businesses'), kind: xeroConnectionKind },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, { businessId, kind }): Promise<{ url: string }> => {
    if (!xeroConfigured()) throw new ConvexError('XERO_NOT_CONFIGURED')

    const state = newInviteToken()
    await ctx.runMutation(internal.xero.beginConnect, {
      businessId,
      kind,
      stateHash: await hashInviteToken(state),
    })

    // encodeURIComponent rather than URLSearchParams, which writes a space as
    // `+`: Xero's sign-in reads the scope list space-separated, and `%20` is
    // the spelling every OAuth server agrees on.
    const params: Array<[string, string]> = [
      ['response_type', 'code'],
      ['client_id', xeroClientId()],
      ['redirect_uri', redirectUri()],
      ['scope', XERO_SCOPES],
      ['state', state],
    ]
    const search = params
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&')
    return { url: `${XERO_AUTHORIZE_URL}?${search}` }
  },
})

/**
 * Who may connect what, decided before anyone is sent to Xero, and the state
 * that carries the decision through the sign-in.
 *
 * Their own live connection makes this a reconnect: the same row comes back
 * to life, with its links and its Start syncing, and the organisation must
 * come back unchanged (`different_org`). A `pending` one is not reconnected
 * but retired: it was never finished, so nothing depends on it, and holding
 * them to whichever organisation they chose last time — when they came back
 * precisely because that went wrong — would refuse the retry for an hour.
 * Its release at Xero waits until the connect starting now is over, so it
 * cannot delete a Xero connection the retry is about to reuse.
 */
export const beginConnect = internalMutation({
  args: {
    businessId: v.id('businesses'),
    kind: xeroConnectionKind,
    stateHash: v.string(),
  },
  handler: async (ctx, { businessId, kind, stateHash }): Promise<null> => {
    const env = await requireWriteActor(ctx, businessId)
    if (isSwitched(env.actor)) throw new ConvexError('SWITCHED')
    if (kind === 'business') {
      requireCapability(env, 'business.manage')
    } else if (env.actor.real.role === 'owner') {
      // The owner's organisation is the business's: "Business → Xero".
      throw new ConvexError('NO_ACCESS')
    }
    if (!xeroConfigured()) throw new ConvexError('XERO_NOT_CONFIGURED')

    const business = await businessOf(ctx, businessId)
    if (business.plan === DEMO_PLAN) throw new ConvexError('XERO_DEMO')
    await requireTwoStep(ctx)

    const real = env.actor.real
    const member = await ctx.db.get('memberships', real._id)
    if (!member) throw new ConvexError('NO_ACCESS')
    const now = Date.now()

    const live = await holderLive(ctx, businessId, kind, real._id)
    let reconnect: Doc<'xeroConnections'> | null = null
    for (const connection of live) {
      if (connection.status === 'pending') {
        // Released only once the connect starting now is over, one way or
        // the other. Choosing the same organisation again at Xero reuses
        // the same Xero connection, and a release running in the minute
        // they are at Xero would delete it from under the new one; by the
        // time this runs, a new connection on it counts as holding it.
        await retire(ctx, connection, 'unfinished', now, {
          releaseAfterMs: XERO_STATE_TTL_MS + XERO_FINISH_TTL_MS,
        })
      } else if (
        !reconnect ||
        connection._creationTime > reconnect._creationTime
      ) {
        reconnect = connection
      }
    }

    // One Connect in flight per person and kind: pressing it again replaces
    // the last, so an older tab coming back from Xero lands on "expired"
    // rather than racing the newer one.
    const inFlight = await ctx.db
      .query('xeroOAuthStates')
      .withIndex('by_expiresAt', (q) => q.gt('expiresAt', now))
      .take(500)
    for (const row of inFlight) {
      if (
        row.usedAt === undefined &&
        row.membershipId === real._id &&
        row.businessId === businessId &&
        row.kind === kind
      ) {
        await ctx.db.delete('xeroOAuthStates', row._id)
      }
    }

    await ctx.db.insert('xeroOAuthStates', {
      stateHash,
      userId: member.userId,
      membershipId: real._id,
      businessId,
      kind,
      ...(reconnect ? { reconnectConnectionId: reconnect._id } : {}),
      termsVersion: XERO_TERMS_VERSION,
      createdAt: now,
      expiresAt: now + XERO_STATE_TTL_MS,
    })
    return null
  },
})

/** The live connections whose holder this is: the business's own for the
 * business kind, this member's own for theirs. */
async function holderLive(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  kind: Kind,
  membershipId: Id<'memberships'>,
): Promise<Array<Doc<'xeroConnections'>>> {
  if (kind === 'member') {
    const rows = await ctx.db
      .query('xeroConnections')
      .withIndex('by_membership', (q) => q.eq('membershipId', membershipId))
      .collect()
    return rows.filter((row) => row.kind === 'member' && isLiveXero(row))
  }
  const rows = await liveInBusiness(ctx, businessId)
  return rows.filter((row) => row.kind === 'business')
}

/** Every live connection in a business. A handful at most: one per person
 * who connected, and one for the business. */
async function liveInBusiness(
  ctx: QueryCtx | MutationCtx,
  businessId: Id<'businesses'>,
): Promise<Array<Doc<'xeroConnections'>>> {
  const groups = await Promise.all(
    LIVE_XERO_STATUSES.map((live) =>
      ctx.db
        .query('xeroConnections')
        .withIndex('by_business_and_status', (q) =>
          q.eq('businessId', businessId).eq('status', live),
        )
        .collect(),
    ),
  )
  return groups.flat()
}

/** Stops a connection nobody finished and schedules taking PestM8 back out
 * of Xero for it — the sweep's work, or done early by a new Connect. */
async function retire(
  ctx: MutationCtx,
  connection: Doc<'xeroConnections'>,
  reason: 'unfinished',
  now: number,
  { releaseAfterMs = 0 }: { releaseAfterMs?: number } = {},
): Promise<void> {
  await ctx.db.patch('xeroConnections', connection._id, {
    status: 'disconnected',
    disconnectReason: reason,
    disconnectedAt: now,
  })
  await ctx.scheduler.runAfter(releaseAfterMs, internal.xero.releaseAtXero, {
    connectionId: connection._id,
  })
}

/**
 * Spends a state, once. Unknown or already spent reads the same as one that
 * never existed — the callback then sends the browser to the app's front
 * door, saying nothing about which. An expired one is spent too, and named,
 * so the page can say "that took too long, try again".
 */
export const takeState = internalMutation({
  args: { stateHash: v.string() },
  handler: async (
    ctx,
    { stateHash },
  ): Promise<
    | {
        outcome: 'ok'
        stateId: Id<'xeroOAuthStates'>
        businessId: Id<'businesses'>
        slug: string
        kind: Kind
        membershipId: Id<'memberships'>
        reconnectConnectionId?: Id<'xeroConnections'>
        /** The organisation a reconnect must come back with, so the callback
         * can pick it out of everything this Xero user has connected. */
        reconnectTenantId?: string
      }
    | { outcome: 'expired'; slug: string; kind: Kind }
    | { outcome: 'unknown' }
  > => {
    const state = await ctx.db
      .query('xeroOAuthStates')
      .withIndex('by_stateHash', (q) => q.eq('stateHash', stateHash))
      .first()
    if (!state || state.usedAt !== undefined) return { outcome: 'unknown' }

    const business = await ctx.db.get('businesses', state.businessId)
    if (!business) return { outcome: 'unknown' }

    const now = Date.now()
    await ctx.db.patch('xeroOAuthStates', state._id, { usedAt: now })
    if (state.expiresAt <= now) {
      return { outcome: 'expired', slug: business.slug, kind: state.kind }
    }

    const reconnect = state.reconnectConnectionId
      ? await ctx.db.get('xeroConnections', state.reconnectConnectionId)
      : null
    return {
      outcome: 'ok',
      stateId: state._id,
      businessId: state.businessId,
      slug: business.slug,
      kind: state.kind,
      membershipId: state.membershipId,
      ...(state.reconnectConnectionId
        ? { reconnectConnectionId: state.reconnectConnectionId }
        : {}),
      ...(reconnect ? { reconnectTenantId: reconnect.tenantId } : {}),
    }
  },
})

const grantFields = {
  xeroUserId: v.string(),
  accessCipher: v.string(),
  accessExpiresAt: v.number(),
  refreshCipher: v.string(),
  scopes: v.array(v.string()),
}

/**
 * The token set Xero just issued, on the one row for this Xero user.
 *
 * Done first, before anything can refuse: a new consent supersedes the
 * user's earlier tokens at Xero whatever PestM8 makes of it, so leaving the
 * old ciphertexts in place would strand every other connection this Xero user
 * has — in this business or any other. Clears a refresh in flight too: that
 * one is spending a token the consent has just replaced, and its result must
 * not land on top of this one (`storeRefreshed` checks the lease).
 */
async function upsertGrant(
  ctx: MutationCtx,
  grant: {
    xeroUserId: string
    accessCipher: string
    accessExpiresAt: number
    refreshCipher: string
    scopes: Array<string>
  },
  { insert }: { insert: boolean },
): Promise<Id<'xeroGrants'> | null> {
  const now = Date.now()
  const existing = await ctx.db
    .query('xeroGrants')
    .withIndex('by_xeroUserId', (q) => q.eq('xeroUserId', grant.xeroUserId))
    .first()
  if (existing) {
    await ctx.db.patch('xeroGrants', existing._id, {
      accessCipher: grant.accessCipher,
      accessExpiresAt: grant.accessExpiresAt,
      refreshCipher: grant.refreshCipher,
      scopes: grant.scopes,
      refreshedAt: now,
      status: 'active',
      deadAt: undefined,
      refreshLease: undefined,
    })
    return existing._id
  }
  if (!insert) return null
  return ctx.db.insert('xeroGrants', {
    ...grant,
    refreshedAt: now,
    status: 'active',
  })
}

/**
 * The callback's tokens, when it ends without a connection (no
 * organisation chosen, or Xero failing half-way). Only onto a grant that
 * already exists — see `upsertGrant` for why it must — and never a new one:
 * a grant nothing uses would only be kept alive by the nightly refresh for
 * nothing. Returns the grant, or null when there was none.
 */
export const keepGrant = internalMutation({
  args: grantFields,
  handler: async (ctx, grant): Promise<Id<'xeroGrants'> | null> =>
    upsertGrant(ctx, grant, { insert: false }),
})

/**
 * What the callback found, stored — or refused, in the order the page
 * explains them:
 *
 *  - `demo`: the demo business never holds a real Xero.
 *  - `different_org`: a reconnect has to bring back the organisation it had;
 *    a connection's organisation never changes (links and history are keyed
 *    on it). Connecting another one is disconnect, then connect.
 *  - `business_org`: a member chose the business's own organisation, which
 *    is the owner's to connect, and already is.
 *  - `member_org`: the owner chose an organisation a member holds here.
 *  - `taken`: anyone else here already holds it — one live connection per
 *    organisation per business, or two would race to write the same book.
 *  - `org_cap`: an organisation new to this deployment, with Xero's limit
 *    for the app already reached (`maxOrgs`). Xero would refuse its API
 *    calls; PestM8 says so first.
 *
 * Accepted, the connection is `pending` (a reconnect keeps its status) until
 * the person who started it finishes it, signed in, with the token the
 * callback hands their browser.
 */
export const storeCallback = internalMutation({
  args: {
    stateId: v.id('xeroOAuthStates'),
    ...grantFields,
    tenantId: v.string(),
    tenantName: v.string(),
    xeroConnectionId: v.string(),
    finishHash: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { outcome: 'refused'; reason: Refusal; grantId: Id<'xeroGrants'> }
    | {
        outcome: 'pending'
        connectionId: Id<'xeroConnections'>
        slug: string
        kind: Kind
      }
  > => {
    const grantId = await upsertGrant(
      ctx,
      {
        xeroUserId: args.xeroUserId,
        accessCipher: args.accessCipher,
        accessExpiresAt: args.accessExpiresAt,
        refreshCipher: args.refreshCipher,
        scopes: args.scopes,
      },
      { insert: true },
    )
    // Inserting always returns an id; narrowed for the type.
    if (!grantId) throw new ConvexError('XERO_GRANT_UNSTORED')

    const state = await ctx.db.get('xeroOAuthStates', args.stateId)
    if (!state || state.usedAt === undefined || state.connectionId) {
      throw new ConvexError('STATE_GONE')
    }
    const business = await businessOf(ctx, state.businessId)
    const refuse = (reason: Refusal) =>
      ({ outcome: 'refused', reason, grantId }) as const

    if (business.plan === DEMO_PLAN) return refuse('demo')

    const prior = state.reconnectConnectionId
      ? await ctx.db.get('xeroConnections', state.reconnectConnectionId)
      : null
    const reconnect = prior && isLiveXero(prior) ? prior : null
    if (reconnect && reconnect.tenantId !== args.tenantId) {
      return refuse('different_org')
    }

    const here = (await liveInBusiness(ctx, state.businessId)).filter(
      (row) => row.tenantId === args.tenantId && row._id !== reconnect?._id,
    )
    if (
      state.kind === 'member' &&
      here.some((row) => row.kind === 'business')
    ) {
      return refuse('business_org')
    }
    if (
      state.kind === 'business' &&
      here.some((row) => row.kind === 'member')
    ) {
      return refuse('member_org')
    }
    if (here.length > 0) return refuse('taken')

    if (!reconnect && (await overOrgCap(ctx, args.tenantId))) {
      return refuse('org_cap')
    }

    const now = Date.now()
    let connectionId: Id<'xeroConnections'>
    if (reconnect) {
      connectionId = reconnect._id
      await ctx.db.patch('xeroConnections', reconnect._id, {
        grantId,
        xeroConnectionId: args.xeroConnectionId,
        tenantName: args.tenantName,
      })
      // Reconnected through another Xero login (or after the connection was
      // removed in Xero and made afresh): the row no longer points at the
      // sign-in and Xero connection it had, so let go of them as a
      // disconnect would — as far as nothing else uses them.
      if (
        reconnect.grantId !== grantId ||
        reconnect.xeroConnectionId !== args.xeroConnectionId
      ) {
        await ctx.scheduler.runAfter(0, internal.xero.releaseReplaced, {
          grantId: reconnect.grantId,
          xeroConnectionId: reconnect.xeroConnectionId,
        })
      }
    } else {
      connectionId = await ctx.db.insert('xeroConnections', {
        businessId: state.businessId,
        membershipId: state.membershipId,
        kind: state.kind,
        grantId,
        tenantId: args.tenantId,
        tenantName: args.tenantName,
        xeroConnectionId: args.xeroConnectionId,
        status: 'pending',
        createdAt: now,
      })
    }

    await ctx.db.patch('xeroOAuthStates', state._id, {
      finishHash: args.finishHash,
      finishExpiresAt: now + XERO_FINISH_TTL_MS,
      connectionId,
    })
    return {
      outcome: 'pending',
      connectionId,
      slug: business.slug,
      kind: state.kind,
    }
  },
})

/**
 * True when this organisation would be one too many for the app: held by no
 * live connection anywhere, while the distinct organisations held already
 * reach `maxOrgs()`. Xero counts organisations, not connections, so one
 * organisation shared by two businesses counts once.
 */
async function overOrgCap(
  ctx: MutationCtx,
  tenantId: string,
): Promise<boolean> {
  const holders = ctx.db
    .query('xeroConnections')
    .withIndex('by_tenant', (q) => q.eq('tenantId', tenantId))
  for await (const row of holders) {
    if (isLiveXero(row)) return false
  }

  const cap = maxOrgs()
  const tenants = new Set<string>()
  for (const live of LIVE_XERO_STATUSES) {
    const rows = ctx.db
      .query('xeroConnections')
      .withIndex('by_status_and_createdAt', (q) => q.eq('status', live))
    for await (const row of rows) {
      tenants.add(row.tenantId)
      if (tenants.size >= cap) return true
    }
  }
  return false
}

/** How many live connections, in any business, hold this Xero connection.
 * The callback deletes one it is refusing only when none does. */
export const liveOnXeroConnection = internalQuery({
  args: { xeroConnectionId: v.string() },
  handler: async (ctx, { xeroConnectionId }): Promise<number> =>
    countLive(
      ctx.db
        .query('xeroConnections')
        .withIndex('by_xeroConnectionId', (q) =>
          q.eq('xeroConnectionId', xeroConnectionId),
        ),
    ),
})

async function countLive(
  rows: AsyncIterable<Doc<'xeroConnections'>>,
  except?: Id<'xeroConnections'>,
): Promise<number> {
  let count = 0
  for await (const row of rows) {
    if (row._id !== except && isLiveXero(row)) count += 1
  }
  return count
}

// ─────────────────────────────────────────────────────────── finishing

/**
 * The page's half of a connect: the finish token the callback put in the
 * address bar, from the person who started it, signed in.
 */
export const finishConnect = action({
  args: { businessId: v.id('businesses'), token: v.string() },
  returns: v.object({ tenantName: v.string() }),
  handler: async (
    ctx,
    { businessId, token },
  ): Promise<{ tenantName: string }> => {
    if (!xeroConfigured()) throw new ConvexError('XERO_NOT_CONFIGURED')
    return ctx.runMutation(internal.xero.finish, {
      businessId,
      finishHash: await hashInviteToken(token),
    })
  },
})

/**
 * Connects what the callback stored — for the same Better Auth user AND the
 * same membership that pressed Connect, or nobody (NO_ACCESS). The token
 * alone proves only that a browser came back from Xero; the session proves
 * whose browser it is.
 *
 * Re-checks that no one else here took the organisation in the minutes
 * between (TAKEN). A reconnect keeps its row, its links and its Start
 * syncing; `connectedAt` becomes now, the start of this sign-in.
 *
 * Then reads the organisation's contacts and matches the client book to them
 * (convex/xeroMatch.ts) — unless this connection finished a match in the
 * last week, as a quick reconnect after a lapsed sign-in has.
 */
export const finish = internalMutation({
  args: { businessId: v.id('businesses'), finishHash: v.string() },
  handler: async (
    ctx,
    { businessId, finishHash },
  ): Promise<{ tenantName: string }> => {
    const env = await requireWriteActor(ctx, businessId)
    if (isSwitched(env.actor)) throw new ConvexError('SWITCHED')

    const now = Date.now()
    const state = await ctx.db
      .query('xeroOAuthStates')
      .withIndex('by_finishHash', (q) => q.eq('finishHash', finishHash))
      .first()
    if (
      !state ||
      state.businessId !== businessId ||
      state.finishedAt !== undefined ||
      state.finishExpiresAt === undefined ||
      state.finishExpiresAt <= now ||
      !state.connectionId
    ) {
      throw new ConvexError('FINISH_EXPIRED')
    }

    const real = env.actor.real
    const member = await ctx.db.get('memberships', real._id)
    if (
      !member ||
      state.userId !== member.userId ||
      state.membershipId !== real._id
    ) {
      throw new ConvexError('NO_ACCESS')
    }
    if (state.kind === 'business') requireCapability(env, 'business.manage')
    // Switched off while they were at Xero: refused like a start would be.
    await requireTwoStep(ctx)

    // Retired in the meantime — a newer Connect, or the sweep.
    const connection = await ctx.db.get('xeroConnections', state.connectionId)
    if (
      !connection ||
      connection.businessId !== businessId ||
      !isLiveXero(connection)
    ) {
      throw new ConvexError('FINISH_EXPIRED')
    }

    const others = (await liveInBusiness(ctx, businessId)).filter(
      (row) =>
        row.tenantId === connection.tenantId && row._id !== connection._id,
    )
    if (others.length > 0) throw new ConvexError('TAKEN')

    const reconnect = state.reconnectConnectionId !== undefined
    await ctx.db.patch('xeroConnections', connection._id, {
      status: 'connected',
      connectedAt: now,
      problem: undefined,
      termsVersion: state.termsVersion,
    })
    await ctx.db.patch('xeroOAuthStates', state._id, { finishedAt: now })

    await recordAudit(ctx, forSelf(real._id), {
      businessId,
      action: reconnect ? 'xero.reconnect' : 'xero.connect',
      entityType: 'xeroConnections',
      entityId: connection._id,
      meta: {
        tenantName: connection.tenantName,
        kind: connection.kind,
        termsVersion: state.termsVersion,
        disclosure: DISCLOSURE,
      },
      at: now,
    })

    // Its short code (for "Open in Xero") and the name as Xero now spells it.
    await ctx.scheduler.runAfter(0, internal.xero.fetchOrganisation, {
      connectionId: connection._id,
    })
    // Which client is which of its contacts. Reads only (Release 2).
    await matchAfterConnect(ctx, connection)
    // Syncing already (a reconnect): what waited while it could not send
    // goes now.
    if (connection.syncStartedAt !== undefined) {
      await ctx.scheduler.runAfter(0, internal.xeroSync.drain, {
        connectionId: connection._id,
      })
    }
    return { tenantName: connection.tenantName }
  },
})

// ─────────────────────────────────────────────────────── disconnecting

/**
 * Disconnect, by its holder (`requireConnectionHolder`). PestM8 stops; what
 * was already copied stays in Xero, and changes still waiting to go there
 * are dropped (`xeroSync.dropOutbox`). The row is kept — the record of who
 * connected what, and when — and the release at Xero is scheduled. Already
 * disconnected is a no-op, so a double tap is not an error.
 */
export const disconnect = mutation({
  args: {
    businessId: v.id('businesses'),
    connectionId: v.id('xeroConnections'),
  },
  returns: v.null(),
  handler: async (ctx, { businessId, connectionId }) => {
    const env = await requireWriteActor(ctx, businessId)
    // Named, ahead of the holder check, so a switched owner is told to switch
    // back rather than that they may not.
    if (isSwitched(env.actor)) throw new ConvexError('SWITCHED')
    const connection = await requireConnectionHolder(
      ctx,
      env,
      await ctx.db.get('xeroConnections', connectionId),
      businessId,
    )
    if (!isLiveXero(connection)) return null

    const now = Date.now()
    await ctx.db.patch('xeroConnections', connection._id, {
      status: 'disconnected',
      disconnectReason: 'by_hand',
      disconnectedAt: now,
      disconnectedByMembershipId: env.actor.real._id,
    })
    await recordAudit(ctx, forSelf(env.actor.real._id), {
      businessId,
      action: 'xero.disconnect',
      entityType: 'xeroConnections',
      entityId: connection._id,
      meta: {
        reason: 'by_hand',
        tenantName: connection.tenantName,
        kind: connection.kind,
      },
      at: now,
    })
    await ctx.scheduler.runAfter(0, internal.xero.releaseAtXero, {
      connectionId: connection._id,
    })
    // What was waiting to go there no longer will, in batches of its own.
    await ctx.scheduler.runAfter(0, internal.xeroSync.dropOutbox, {
      connectionId: connection._id,
    })
    return null
  },
})

/** What a release at Xero may touch, counted when it runs. */
type ReleaseFacts = {
  grantId: Id<'xeroGrants'>
  grantStatus: 'active' | 'dead' | 'gone'
  xeroConnectionId: string
  /** Live rows, in any business, on the same Xero connection. */
  otherLiveOnSameXeroConnection: number
  /** Live rows, in any business, on the same grant. */
  liveOnGrant: number
}

async function releaseFacts(
  ctx: QueryCtx,
  {
    grantId,
    xeroConnectionId,
    except,
  }: {
    grantId: Id<'xeroGrants'>
    xeroConnectionId: string
    except?: Id<'xeroConnections'>
  },
): Promise<ReleaseFacts> {
  const grant = await ctx.db.get('xeroGrants', grantId)
  return {
    grantId,
    grantStatus: grant ? grant.status : 'gone',
    xeroConnectionId,
    otherLiveOnSameXeroConnection: await countLive(
      ctx.db
        .query('xeroConnections')
        .withIndex('by_xeroConnectionId', (q) =>
          q.eq('xeroConnectionId', xeroConnectionId),
        ),
      except,
    ),
    liveOnGrant: await countLive(
      ctx.db
        .query('xeroConnections')
        .withIndex('by_grant', (q) => q.eq('grantId', grantId)),
      except,
    ),
  }
}

/**
 * What releasing a disconnected connection at Xero may touch. Null when
 * there is nothing to release: the row is gone, or live again.
 */
export const forRelease = internalQuery({
  args: { connectionId: v.id('xeroConnections') },
  handler: async (ctx, { connectionId }): Promise<ReleaseFacts | null> => {
    const connection = await ctx.db.get('xeroConnections', connectionId)
    if (!connection || isLiveXero(connection)) return null
    return releaseFacts(ctx, {
      grantId: connection.grantId,
      xeroConnectionId: connection.xeroConnectionId,
      except: connection._id,
    })
  },
})

/** The same, for a sign-in and Xero connection a reconnect moved off
 * (`releaseReplaced`), which no row of its own points at any more. */
export const forReleaseOf = internalQuery({
  args: { grantId: v.id('xeroGrants'), xeroConnectionId: v.string() },
  handler: async (ctx, args): Promise<ReleaseFacts> => releaseFacts(ctx, args),
})

/**
 * Takes PestM8 back out of Xero for a disconnected connection, as far as
 * nothing else still needs it (`release`).
 */
export const releaseAtXero = internalAction({
  args: {
    connectionId: v.id('xeroConnections'),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, { connectionId, attempt = 0 }): Promise<null> => {
    const info = await ctx.runQuery(internal.xero.forRelease, { connectionId })
    if (!info) return null
    await release(ctx, info, {
      connectionId,
      attempt,
      retry: (delayMs) =>
        ctx.scheduler.runAfter(delayMs, internal.xero.releaseAtXero, {
          connectionId,
          attempt: attempt + 1,
        }),
    })
    return null
  },
})

/**
 * A reconnect that came back through a different Xero login (the owner's
 * bookkeeper's, say) moves its connection onto that login's sign-in and Xero
 * connection (`storeCallback`). The ones it left are released here as a
 * disconnect's would be — or nothing would ever take them out of Xero, and
 * the old sign-in would stay able to reach the organisation.
 */
export const releaseReplaced = internalAction({
  args: {
    grantId: v.id('xeroGrants'),
    xeroConnectionId: v.string(),
    attempt: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { grantId, xeroConnectionId, attempt = 0 },
  ): Promise<null> => {
    const info = await ctx.runQuery(internal.xero.forReleaseOf, {
      grantId,
      xeroConnectionId,
    })
    await release(ctx, info, {
      connectionId: null,
      attempt,
      retry: (delayMs) =>
        ctx.scheduler.runAfter(delayMs, internal.xero.releaseReplaced, {
          grantId,
          xeroConnectionId,
          attempt: attempt + 1,
        }),
    })
    return null
  },
})

/**
 * Takes PestM8 back out of Xero, as far as nothing else still needs it:
 *
 *  1. `DELETE /connections/{id}` only when no live row, in ANY business,
 *     holds the same Xero connection: one Xero user connecting one
 *     organisation to two businesses is one connection at Xero. Looked at
 *     again once the token is in hand — getting one can take seconds, and a
 *     consent to the same organisation landing meanwhile reuses the very
 *     connection id.
 *  2. Revoke the sign-in only when no live row anywhere uses the grant:
 *     revoking takes out every organisation that Xero user connected. Done
 *     even when the DELETE gave up, since it takes this connection out too —
 *     a release that gives up must not leave a sign-in nothing uses behind
 *     (the keep-alive retires any that still slip through).
 *
 * Busy, rate-limited or down: the whole release is tried again, up to
 * MAX_ATTEMPTS. When PestM8 could not take this connection out of Xero in
 * the end — the sign-in is dead, or the DELETE gave up and the sign-in could
 * not be revoked — the connection carries `xero_side`, and the page tells
 * its holder to remove PestM8 in Xero → Settings → Connected apps.
 */
async function release(
  ctx: ActionCtx,
  info: ReleaseFacts,
  {
    connectionId,
    attempt,
    retry,
  }: {
    /** Null for a reconnect's leftovers, which have no row to explain. */
    connectionId: Id<'xeroConnections'> | null
    attempt: number
    retry: (delayMs: number) => Promise<unknown>
  },
): Promise<void> {
  // Gone: an earlier release revoked it, which took this connection out of
  // Xero with it.
  if (info.grantStatus === 'gone') return
  const leftInXero = async () => {
    if (!connectionId) return
    await ctx.runMutation(internal.xero.setProblem, {
      connectionId,
      code: 'xero_side',
    })
  }
  const subject = connectionId
    ? `connection ${connectionId}`
    : `replaced grant ${info.grantId}`

  if (info.grantStatus === 'dead') {
    // Not if another business holds the same connection: removing PestM8
    // there in Xero would take it from them too.
    if (info.otherLiveOnSameXeroConnection === 0) await leftInXero()
    if (info.liveOnGrant === 0) {
      await ctx.runMutation(internal.xero.dropGrant, { grantId: info.grantId })
    }
    return
  }

  // Held by someone else is as good as out: it is theirs now.
  let out = info.otherLiveOnSameXeroConnection > 0
  if (!out) {
    try {
      await withToken(ctx, info.grantId, async (token) => {
        const held: number = await ctx.runQuery(
          internal.xero.liveOnXeroConnection,
          { xeroConnectionId: info.xeroConnectionId },
        )
        if (held === 0) await deleteConnection(token, info.xeroConnectionId)
      })
      out = true
    } catch (error) {
      const retried = await retryLater(error, {
        what: 'release',
        subject,
        attempt,
        retry,
      })
      if (retried) return
    }
  }

  if (info.liveOnGrant === 0) {
    const retired = await retireGrant(ctx, info.grantId)
    if (retired === 'busy') {
      const retried = await retryLater(new ConvexError('XERO_BUSY'), {
        what: 'release',
        subject,
        attempt,
        retry,
      })
      if (retried) return
    }
    if (retired === 'revoked') out = true
  }

  if (!out) await leftInXero()
}

/** One call with this grant's access token, and once more with a freshly
 * refreshed one if Xero answers 401 to the first. */
async function withToken<T>(
  ctx: ActionCtx,
  grantId: Id<'xeroGrants'>,
  call: (token: string) => Promise<T>,
): Promise<T> {
  const token = await accessTokenFor(ctx, grantId)
  try {
    return await call(token)
  } catch (error) {
    if (!(error instanceof XeroError) || error.classified.kind !== 'refresh') {
      throw error
    }
    return call(await accessTokenFor(ctx, grantId, { forceRefresh: true }))
  }
}

/**
 * After a release or an organisation read failed: schedules another try
 * when Xero said "not now" (busy lease, rate limit, outage) and tries are
 * left, each wait doubling from a minute. True when it did; otherwise it
 * logs that it gave up, and the caller decides what giving up leaves behind.
 */
async function retryLater(
  error: unknown,
  {
    what,
    subject,
    attempt,
    retry,
  }: {
    what: 'release' | 'organisation'
    subject: string
    attempt: number
    retry: (delayMs: number) => Promise<unknown>
  },
): Promise<boolean> {
  const waitMs = retryAfter(error, Date.now())
  if (waitMs !== null && attempt + 1 < MAX_ATTEMPTS) {
    await retry(Math.max(waitMs, 60_000 * 2 ** attempt))
    return true
  }
  console.error(`xero: ${what} for ${subject} gave up: ${describe(error)}`)
  return false
}

/** How long to wait before trying again, or null when trying again cannot
 * help (the sign-in is dead, the keys are wrong, Xero said no). */
function retryAfter(error: unknown, now: number): number | null {
  if (error instanceof ConvexError) {
    return error.data === 'XERO_BUSY' || error.data === 'XERO_RETRY'
      ? 30_000
      : null
  }
  if (error instanceof XeroError) {
    const classified = error.classified
    if (classified.kind === 'retry') return classified.afterMs
    if (classified.kind === 'pause') return Math.max(classified.until - now, 0)
    return null
  }
  return null
}

/** An error, as a log line may carry it: Xero's classification or our own
 * code, never a token (no helper puts one in a message). */
function describe(error: unknown): string {
  if (error instanceof XeroError) {
    return `${error.message} (${JSON.stringify(error.classified)})`
  }
  if (error instanceof ConvexError) return String(error.data)
  return error instanceof Error ? error.message : String(error)
}

/** Something about this connection the page should explain (xeroCopy.ts). */
export const setProblem = internalMutation({
  args: { connectionId: v.id('xeroConnections'), code: v.string() },
  handler: async (ctx, { connectionId, code }): Promise<null> => {
    const connection = await ctx.db.get('xeroConnections', connectionId)
    if (!connection) return null
    await ctx.db.patch('xeroConnections', connectionId, {
      problem: { code, at: Date.now() },
    })
    return null
  },
})

/**
 * Forgets a grant, only while no live connection uses it — checked here, in
 * the transaction that deletes it, because a consent may have put it back to
 * work since the caller looked. Disconnected rows keep pointing at it; they
 * are never used to reach Xero again.
 */
export const dropGrant = internalMutation({
  args: { grantId: v.id('xeroGrants') },
  handler: async (ctx, { grantId }): Promise<{ dropped: boolean }> => {
    const grant = await ctx.db.get('xeroGrants', grantId)
    if (!grant) return { dropped: false }
    const inUse = await countLive(
      ctx.db
        .query('xeroConnections')
        .withIndex('by_grant', (q) => q.eq('grantId', grantId)),
    )
    if (inUse > 0) return { dropped: false }
    await ctx.db.delete('xeroGrants', grantId)
    return { dropped: true }
  },
})

// ──────────────────────────────────────────────────────── organisation

/** What a call about this connection needs: no ciphertext. */
export const forOrganisation = internalQuery({
  args: { connectionId: v.id('xeroConnections') },
  handler: async (
    ctx,
    { connectionId },
  ): Promise<{ grantId: Id<'xeroGrants'>; tenantId: string } | null> => {
    const connection = await ctx.db.get('xeroConnections', connectionId)
    if (!connection || !isLiveXero(connection)) return null
    return { grantId: connection.grantId, tenantId: connection.tenantId }
  },
})

/**
 * The organisation's name as Xero now spells it, and its short code, for
 * "Open in Xero" links. Cosmetic in Release 1, so a failure is tried again
 * a few times and then only logged — except Xero refusing this organisation
 * to a sign-in it otherwise accepts (a 403: PestM8 was removed from it in
 * Xero, or the connection went from under it), which nothing PestM8 retries
 * will mend: the connection then needs reconnecting (`orgGone`), and the
 * page says so rather than showing Connected.
 */
export const fetchOrganisation = internalAction({
  args: {
    connectionId: v.id('xeroConnections'),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, { connectionId, attempt = 0 }): Promise<null> => {
    const target = await ctx.runQuery(internal.xero.forOrganisation, {
      connectionId,
    })
    if (!target) return null
    try {
      const organisation = await withToken(ctx, target.grantId, (token) =>
        getOrganisation(token, target.tenantId),
      )
      await ctx.runMutation(internal.xero.setOrganisation, {
        connectionId,
        tenantName: organisation.name,
        ...(organisation.shortCode
          ? { shortCode: organisation.shortCode }
          : {}),
      })
    } catch (error) {
      const retried = await retryLater(error, {
        what: 'organisation',
        subject: `connection ${connectionId}`,
        attempt,
        retry: (delayMs) =>
          ctx.scheduler.runAfter(delayMs, internal.xero.fetchOrganisation, {
            connectionId,
            attempt: attempt + 1,
          }),
      })
      if (
        !retried &&
        error instanceof XeroError &&
        error.classified.kind === 'reconnect'
      ) {
        await ctx.runMutation(internal.xero.orgGone, { connectionId })
      }
    }
    return null
  },
})

/** Xero no longer lets this connection's sign-in reach its organisation:
 * reconnect needed, worded as `org_gone`. Only a working connection is
 * changed; one already waiting on a reconnect says so already. */
export const orgGone = internalMutation({
  args: { connectionId: v.id('xeroConnections') },
  handler: async (ctx, { connectionId }): Promise<null> => {
    const connection = await ctx.db.get('xeroConnections', connectionId)
    if (connection?.status !== 'connected') return null
    await ctx.db.patch('xeroConnections', connectionId, {
      status: 'needs_reconnect',
      problem: { code: 'org_gone', at: Date.now() },
    })
    return null
  },
})

export const setOrganisation = internalMutation({
  args: {
    connectionId: v.id('xeroConnections'),
    tenantName: v.string(),
    shortCode: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { connectionId, tenantName, shortCode },
  ): Promise<null> => {
    const connection = await ctx.db.get('xeroConnections', connectionId)
    if (!connection) return null
    const name = tenantName.trim()
    await ctx.db.patch('xeroConnections', connectionId, {
      ...(name ? { tenantName: name } : {}),
      ...(shortCode ? { shortCode } : {}),
    })
    return null
  },
})

// ──────────────────────────────────────────────────────────────── upkeep

/** States are kept an hour past expiry, so a late callback still finds its
 * row and says "expired" rather than "unknown". */
const STATE_KEEP_MS = 60 * 60 * 1000
/** A `pending` connection older than this was never finished: the finish
 * token it was waiting on has expired. */
const UNFINISHED_AFTER_MS = XERO_FINISH_TTL_MS

/**
 * Hourly (crons.ts): forgets spent and abandoned states, and retires
 * connections nobody finished — taking PestM8 back out of Xero for them,
 * because the person did choose an organisation at Xero's sign-in and Xero
 * counts it against the app until it is removed.
 */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ states: number; unfinished: number }> => {
    const now = Date.now()

    const states = await ctx.db
      .query('xeroOAuthStates')
      .withIndex('by_expiresAt', (q) => q.lt('expiresAt', now - STATE_KEEP_MS))
      .take(200)
    for (const state of states) {
      await ctx.db.delete('xeroOAuthStates', state._id)
    }

    const unfinished = await ctx.db
      .query('xeroConnections')
      .withIndex('by_status_and_createdAt', (q) =>
        q.eq('status', 'pending').lt('createdAt', now - UNFINISHED_AFTER_MS),
      )
      .take(50)
    for (const connection of unfinished) {
      await retire(ctx, connection, 'unfinished', now)
    }

    return { states: states.length, unfinished: unfinished.length }
  },
})

/**
 * For whoever is looking after the deployment:
 * `npx convex run xero:inspect '{"connectionId": "…"}'`. The connection, and
 * how its sign-in stands — never a token or ciphertext.
 */
export const inspect = internalQuery({
  args: { connectionId: v.id('xeroConnections') },
  handler: async (ctx, { connectionId }) => {
    const connection = await ctx.db.get('xeroConnections', connectionId)
    if (!connection) return null
    const grant = await ctx.db.get('xeroGrants', connection.grantId)
    return {
      connection,
      grant: grant
        ? {
            _id: grant._id,
            xeroUserId: grant.xeroUserId,
            status: grant.status,
            deadAt: grant.deadAt ?? null,
            refreshedAt: grant.refreshedAt,
            accessExpiresAt: grant.accessExpiresAt,
            scopes: grant.scopes,
            refreshing: grant.refreshLease
              ? { until: grant.refreshLease.until }
              : null,
          }
        : null,
    }
  },
})
