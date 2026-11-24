import { ConvexError } from 'convex/values'
import { requireAuthUser } from './access'
import { factsFromMembership } from './membershipFacts'
import {
  canChooseView,
  capabilitiesOf,
  effectiveCapabilities,
  isAssignableRole,
  isSwitched,
  jobScope,
  mightChooseView,
  resolveActorForRead,
  resolveActorForWrite,
} from './capabilities'
import type { Id } from '../_generated/dataModel'
import type { QueryCtx, MutationCtx } from '../_generated/server'
import type {
  Capability,
  CapabilitySet,
  MembershipFacts,
  ReadActor,
  Role,
  RowScope,
  SwitchSession,
  ViewMode,
  WriteActor,
} from './capabilities'

/**
 * Who is calling, resolved once, from the database.
 *
 * `capabilities.ts` decides everything and reads nothing; this module reads
 * everything and decides nothing. Splitting them that way is what lets the
 * policy be unit-tested against hand-built facts, and it is why every function
 * here ends by handing rows to a pure function rather than branching on a role.
 *
 * It replaces `requireMembership`, `requireOwner` and `resolveViewScope` from
 * `lib/access.ts`, which between them returned a SINGLE membership row. One row
 * cannot express the thing this model is about: the human at the keyboard and
 * the account being worked in are different, and which of the two a decision
 * belongs to is the whole question.
 *
 * Deliberately `QueryCtx | MutationCtx` only. An action has no `ctx.db`, and a
 * write actor resolved in an action would be meaningless anyway — the write
 * happens later, in a different transaction, where the grant may no longer
 * hold. Every action in this codebase already delegates to an internal
 * query/mutation that gates; that stays true.
 */
export type Ctx = QueryCtx | MutationCtx

/**
 * Three membership slots:
 *
 * - `actor.real`   — the human. Audit, profile, licence, admin rights.
 * - `actor.acting` — the account being worked in. ONLY ever set by an
 *                    `accountSwitches` row. Write-bearing.
 * - `readScope`    — the account whose rows are being *read*.
 *
 * `readScope` is `acting` when switched and `real` otherwise: switching is
 * the only way to see through someone else's account. It was a third thing
 * while the old read-only "view as" (`memberships.viewingAsMembershipId`)
 * lasted, which is retired (schema.ts) and no longer read here. The stored
 * column must never come back as a way into `acting`: it was only ever leave
 * to look, never to write under someone else's name.
 */
export type ActorEnvelope = {
  actor: ReadActor
  readScope: MembershipFacts
  /** `effectiveCapabilities` — intersected across the switch, with the admin
   * capabilities already dropped. The authority for every permission check;
   * never re-derive from a role at a call site. */
  caps: CapabilitySet
  /** Which rows this caller may read: `jobScope` of `caps`, for the account
   * in `readScope`. */
  scope: RowScope
  /**
   * The rows the REAL person may read, ignoring any lens they are looking
   * through. The same object as `scope` unless they are switched.
   *
   * For pickers and anything else that offers a choice the caller will act on
   * themselves — attaching a note to a job, say. Offering the target's jobs
   * there would let someone select work they cannot touch, and the failure
   * would surface later as a refused write rather than an absent option.
   */
  realScope: RowScope
  /**
   * The rows a LIST should show: `scope`, narrowed to the caller's own work
   * when they have chosen My jobs on this device.
   *
   * Only the "my round" surfaces read this — the schedule, the dashboard,
   * analytics, the reports list. Anything that opens one record (a job, a
   * report, a client's history) reads `scope`, because a technician on site
   * needs the whole history of the house in front of them, not just the
   * visits that were theirs. And it is `scope` in every mutation: a view is
   * a choice about what to be shown, never about what is allowed, so no write
   * may be refused because of which view a screen was left in.
   */
  listScope: RowScope
  /** The view chosen on this device — My jobs ('mine') unless they picked
   * Overview. Always 'everyone' for anyone who cannot choose one
   * (`canChooseView`), whose one list is already everything they may see. */
  view: ViewMode
}

/** A write envelope: `readScope` is always the account being acted in. */
export type WriteEnvelope = Omit<ActorEnvelope, 'actor'> & {
  actor: WriteActor
}

// ────────────────────────────────────────────────────────────── loading rows

type ActorRows = {
  real: MembershipFacts
  realParent: MembershipFacts | null
  /** The switch target, and the session that claims it. Both null unless an
   * `accountSwitches` row applies to this request. */
  target: MembershipFacts | null
  session: SwitchSession | null
  /** The view chosen on this device — My jobs unless a `sessionViews` row
   * says Overview. Only read for someone who might choose one
   * (`mightChooseView`); the envelope decides whether it applies. */
  view: ViewMode
}

/**
 * Per-request memoisation.
 *
 * `requireActor` costs two component queries plus up to four table reads, and
 * several functions resolve access twice in one invocation today — `jobs.get`
 * does it at both :308 and :312, and `noteAccess.noteViewer` calls
 * `requireMembership` and then `resolveViewScope`, which calls it again. Left
 * unmemoised, the hottest query in the app doubles its cost on the day this
 * lands.
 *
 * Correctness matters more than cost: two resolutions inside one function must
 * not be able to disagree. A switch that lapses between them would otherwise
 * leave a mutation reading as one person and writing as another.
 *
 * Keyed on the ctx object, which Convex creates per invocation, and held
 * weakly — so an entry cannot outlive the request that made it, and nothing
 * leaks between callers sharing a warm isolate.
 */
const requestCache = new WeakMap<
  object,
  Map<string, Promise<ActorRows | null>>
>()

async function loadActorRows(
  ctx: Ctx,
  businessId: Id<'businesses'>,
): Promise<ActorRows | null> {
  let perCtx = requestCache.get(ctx)
  if (!perCtx) {
    perCtx = new Map()
    requestCache.set(ctx, perCtx)
  }
  const hit = perCtx.get(businessId)
  if (hit) return hit

  const pending = readActorRows(ctx, businessId)
  perCtx.set(businessId, pending)
  return pending
}

async function readActorRows(
  ctx: Ctx,
  businessId: Id<'businesses'>,
): Promise<ActorRows | null> {
  // Throws ConvexError('Unauthenticated') when there is no live session. It
  // also re-reads the Better Auth session row and checks it has not expired,
  // which is the check that makes offboarding work: `team.offboard` deletes a
  // removed person's sessions, and this is where that takes effect. And it
  // refuses an account without two-step sign-in (MFA_ENROLMENT_REQUIRED) —
  // see `requireAuthUser`.
  const user = await requireAuthUser(ctx)

  const membership = await ctx.db
    .query('memberships')
    .withIndex('by_user_business', (q) =>
      q.eq('userId', user._id).eq('businessId', businessId),
    )
    .unique()

  // One error for "not a member" and for "membership revoked", exactly as
  // before: a distinct message would confirm the business exists to a
  // non-member.
  if (!membership || membership.status !== 'active') return null

  const real = factsFromMembership(membership)

  const [realParent, switchRow, view] = await Promise.all([
    parentOf(ctx, real),
    findSwitch(ctx, businessId, real._id),
    // Nobody else has a view to load, so nobody else pays the read. Whether
    // it applies waits on their scope, which needs the parent above.
    mightChooseView(real)
      ? findView(ctx, businessId, real._id)
      : Promise.resolve<ViewMode>('everyone'),
  ])

  const target = switchRow ? await getMembership(ctx, switchRow.target) : null

  return {
    real,
    realParent,
    target,
    session: switchRow?.session ?? null,
    view,
  }
}

async function getMembership(
  ctx: Ctx,
  membershipId: Id<'memberships'>,
): Promise<MembershipFacts | null> {
  const doc = await ctx.db.get(membershipId)
  return doc ? factsFromMembership(doc) : null
}

async function parentOf(
  ctx: Ctx,
  m: MembershipFacts,
): Promise<MembershipFacts | null> {
  return m.parentMembershipId ? getMembership(ctx, m.parentMembershipId) : null
}

/**
 * The open switch for THIS session, if it belongs to this business.
 *
 * A session can hold at most one switch, but a person can belong to more than
 * one business. A row opened in business A reaching a request for business B is
 * IGNORED — not refused, and not reported as degraded. Refusing would break
 * business B entirely for anyone with a switch open in A; reporting it would
 * raise a banner in a business the switch has nothing to do with. Ignoring is
 * the only behaviour that leaves the other business working normally, and it
 * costs nothing in safety: `canSwitchInto` refuses a cross-business target, so
 * a switch can never legitimately span the two.
 */
async function findSwitch(
  ctx: Ctx,
  businessId: Id<'businesses'>,
  realMembershipId: Id<'memberships'>,
): Promise<{ target: Id<'memberships'>; session: SwitchSession } | null> {
  const sessionId = await currentSessionId(ctx)
  if (!sessionId) return null

  /**
   * Collected, not `.unique()`. Nothing in the schema enforces one row per
   * session, and `.unique()` THROWS on a second — which would not fail open or
   * closed, it would lock that session out of every business in the app, with a
   * raw runtime error and no way for the user to clear it. A duplicate is a bug
   * in the lifecycle mutation; it must not become an outage for the person
   * holding the phone. Newest wins, which is the one they last asked for.
   */
  const rows = await ctx.db
    .query('accountSwitches')
    .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
    .collect()

  const candidates = rows
    .filter((r) => r.businessId === businessId)
    // Creation order breaks the tie: two rows written in the same millisecond
    // carry the same `startedAt`, and "newest wins" has to mean something
    // definite even then — otherwise which account someone lands in depends on
    // an unstable sort.
    .sort(
      (a, b) => b.startedAt - a.startedAt || b._creationTime - a._creationTime,
    )

  // Indexing would type as non-optional and be `undefined` at runtime.
  if (candidates.length === 0) return null
  const row = candidates[0]

  // The row names the membership it was opened for, and applies to that one
  // only. Re-derived rather than trusted, like everything else here. It is
  // not what keeps an earlier stint's switch away: a person removed and
  // later invited back gets the SAME membership id (`invitations.redeem`
  // makes the old row active again), so a surviving row would pass this.
  // None survives: removing someone, or their leaving, deletes every switch
  // naming them, either way round (`offboard` in team.ts).
  if (row.realMembershipId !== realMembershipId) return null

  return {
    target: row.targetMembershipId,
    session: {
      targetMembershipId: row.targetMembershipId,
      startedAt: row.startedAt,
      expiresAt: row.expiresAt,
    },
  }
}

/**
 * The view chosen on THIS device, by the same rules as `findSwitch`: keyed by
 * session, ignored when it belongs to another business, and re-checked against
 * the membership it was chosen for. Someone removed and later re-added gets
 * the same membership back, so what keeps their previous stint's view from
 * them is that removing them deletes it (`offboard` in team.ts), not this
 * check. Newest wins if a bug ever leaves two.
 *
 * No row is My jobs: every device starts on the person's own round, and
 * Overview is chosen (`views.set` writes an 'everyone' row).
 *
 * Without a session there is no device to remember a choice for, and
 * `views.set` refuses one — so a view there could never be changed, and a
 * list narrowed for good would hide work with no way back. Such a request
 * sees everything it may.
 */
async function findView(
  ctx: Ctx,
  businessId: Id<'businesses'>,
  realMembershipId: Id<'memberships'>,
): Promise<ViewMode> {
  const sessionId = await currentSessionId(ctx)
  if (!sessionId) return 'everyone'

  const rows = await ctx.db
    .query('sessionViews')
    .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
    .collect()

  const row = rows
    .filter(
      (r) =>
        r.businessId === businessId && r.realMembershipId === realMembershipId,
    )
    .sort(
      (a, b) => b.updatedAt - a.updatedAt || b._creationTime - a._creationTime,
    )
    .at(0)

  return row ? row.mode : 'mine'
}

/**
 * The Better Auth session id for this request.
 *
 * It rides in the JWT as a custom claim — `@convex-dev/better-auth` adds
 * `sessionId: session.id` to every token it mints — and its value is the `_id`
 * of the row in the component's own `session` table. Reading it here is not a
 * trick: the library's own `getAuthUser` looks the session up by exactly this
 * claim.
 *
 * Typed `JSONValue | undefined` through `UserIdentity`'s index signature, so it
 * is narrowed rather than cast. It names a row in a COMPONENT's table, which is
 * a different id namespace from this app's — hence `v.string()` in the schema
 * and no `ctx.db.normalizeId` here; there is nothing in this deployment to
 * validate it against.
 */
export async function currentSessionId(ctx: Ctx): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity()
  const sessionId = identity?.sessionId
  return typeof sessionId === 'string' ? sessionId : null
}

/**
 * A contractor's team, by index rather than by scanning the business and
 * filtering in memory — which is both slower and, per the note on the index in
 * schema.ts, how an owner row gets included by accident.
 *
 * Only loaded when it can change an answer. `jobScope` consults the team for
 * exactly one case: a contractor who cannot already see everyone's schedule.
 * For the owner and for every subcontractor the list is unused, so this stays
 * off the hot path entirely rather than costing a read on every request.
 */
export async function teamOf(
  ctx: Ctx,
  businessId: Id<'businesses'>,
  parentMembershipId: Id<'memberships'>,
): Promise<ReadonlyArray<MembershipFacts>> {
  const rows = await ctx.db
    .query('memberships')
    .withIndex('by_business_parent', (q) =>
      q
        .eq('businessId', businessId)
        .eq('parentMembershipId', parentMembershipId),
    )
    .collect()

  return rows.filter((m) => m.status === 'active').map(factsFromMembership)
}

// ───────────────────────────────────────────────────────────────── resolving

async function envelope(
  ctx: Ctx,
  businessId: Id<'businesses'>,
  rows: ActorRows,
  actor: ReadActor,
): Promise<ActorEnvelope> {
  const switched = isSwitched(actor)

  /**
   * What the person could see standing in their own account. It decides
   * whether they get a view to choose (`canChooseView`), and it is `scope`
   * itself whenever they are looking through nobody else's eyes — computed
   * once, so that case costs no second team read.
   */
  const realCaps = capabilitiesOf(rows.real, rows.realParent)
  const realScope = jobScope(
    realCaps,
    rows.real,
    await teamFor(ctx, businessId, rows.real, realCaps),
  )
  const choosesView = canChooseView(realScope)

  /**
   * My jobs is in force when it is this device's view and nothing outranks
   * it. A switch does: inside someone else's account you see what that
   * account sees, and the chosen view resumes when you switch back.
   */
  const ownView = !switched && rows.view === 'mine' && choosesView

  /**
   * A live switch is the only lens: inside someone else's account you read
   * what that account may read. A switch that was attempted and dropped
   * (`actor.degraded`) is not a switch, so it reads as the real person. The
   * stored "view as" selection is retired (schema.ts) and deliberately not
   * consulted, whatever a row still holds.
   */
  const readScope = switched ? actor.acting : rows.real
  const readScopeParent = switched
    ? await parentOf(ctx, actor.acting)
    : rows.realParent

  const caps = effectiveCapabilities(
    actor,
    rows.realParent,
    switched ? readScopeParent : null,
  )

  // Looking through nobody's eyes, the person's own scope IS the scope:
  // unswitched, `caps` are exactly `realCaps` (`effectiveCapabilities`), and
  // a second team lookup would be a read on every request to answer a
  // question already answered.
  //
  // Switched, scope is `caps` — the intersection, so a subcontractor who
  // cannot see everyone's schedule does not acquire it by switching into
  // someone who can.
  const looking = readScope._id !== rows.real._id
  const scope = looking
    ? jobScope(caps, readScope, await teamFor(ctx, businessId, readScope, caps))
    : realScope

  return {
    actor,
    readScope,
    caps,
    scope,
    realScope,
    // Queries only — see `listScope` on the envelope type. `isMutation` is the
    // same test `now` uses, and it is structural: a query's database has no
    // `insert`, so no mutation can be handed a narrowed list scope.
    listScope:
      ownView && !isMutation(ctx)
        ? { kind: 'own', membershipId: rows.real._id }
        : scope,
    view: choosesView ? rows.view : 'everyone',
  }
}

/** The team, loaded only when it can change the answer: `jobScope` consults it
 * for exactly one case, a contractor who cannot already see every schedule. */
async function teamFor(
  ctx: Ctx,
  businessId: Id<'businesses'>,
  member: MembershipFacts,
  caps: CapabilitySet,
): Promise<ReadonlyArray<MembershipFacts>> {
  return member.role === 'contractor' && !caps['schedules.seeOthers']
    ? teamOf(ctx, businessId, member._id)
    : []
}

/**
 * The caller, for a READ.
 *
 * Fails open on a switch that no longer validates: the switch is dropped, the
 * request continues as the real person, and `actor.degraded` says why so the
 * banner can explain it. A revoked grant should return you to your own account,
 * not to an error page halfway through a shift.
 */
export async function requireActor(
  ctx: Ctx,
  businessId: Id<'businesses'>,
): Promise<ActorEnvelope> {
  const rows = await loadActorRows(ctx, businessId)
  if (!rows) throw new ConvexError('NO_ACCESS')

  const actor = resolveActorForRead(
    rows.real,
    rows.target,
    rows.session,
    now(ctx),
  )
  return envelope(ctx, businessId, rows, actor)
}

/**
 * The caller, for a WRITE. The only place a `WriteActor` is ever produced.
 *
 * Fails CLOSED where the read resolver fails open, and the difference is the
 * point. A read that quietly falls back to your own account shows you your own
 * schedule; a write that quietly falls back stamps your name on a document
 * meant to carry someone else's, after the authority to write it has gone.
 *
 * The brand on `WriteActor` is what stops the other resolver being used here by
 * mistake — `writeAttribution` will not accept a `ReadActor`, so reaching for
 * the wrong one is a compile error rather than a silently mis-attributed row.
 */
export async function requireWriteActor(
  ctx: Ctx,
  businessId: Id<'businesses'>,
): Promise<WriteEnvelope> {
  const rows = await loadActorRows(ctx, businessId)
  if (!rows) throw new ConvexError('NO_ACCESS')

  const result = resolveActorForWrite(
    rows.real,
    rows.target,
    rows.session,
    now(ctx),
  )
  if (!result.ok) throw new ConvexError(result.reason)

  const env = await envelope(ctx, businessId, rows, result.actor)
  return { ...env, actor: result.actor }
}

/**
 * A member's write envelope, for code that runs with nobody signed in: the
 * demo seeder (convex/demo), which writes as the member each record says
 * wrote it. Built by the same `envelope` a request uses, from that member's
 * own row, exactly as `requireWriteActor` would find them on a device with no
 * switch and no chosen view.
 *
 * Only for internal functions. Handing one to a public function would let a
 * caller write as anyone, which is the whole of what `requireWriteActor`
 * exists to prevent.
 */
export async function writeEnvelopeForMember(
  ctx: MutationCtx,
  membershipId: Id<'memberships'>,
): Promise<WriteEnvelope> {
  const membership = await ctx.db.get(membershipId)
  if (!membership || membership.status !== 'active') {
    throw new ConvexError('NO_ACCESS')
  }
  const real = factsFromMembership(membership)
  const rows: ActorRows = {
    real,
    realParent: await parentOf(ctx, real),
    target: null,
    session: null,
    view: 'everyone',
  }
  const result = resolveActorForWrite(real, null, null, Date.now())
  if (!result.ok) throw new ConvexError(result.reason)
  const env = await envelope(ctx, membership.businessId, rows, result.actor)
  return { ...env, actor: result.actor }
}

/**
 * The clock, read only where it is allowed to be read.
 *
 * Convex's own guidance is blunt: do not read the wall clock inside a query. A
 * query is not re-run because time passed, so a result derived from `Date.now()`
 * can be stale anyway — and, more expensively here, a wall-clock read reduces
 * query-cache reuse. This function is on the path of roughly eighty queries, so
 * making all of them uncacheable to check one timestamp is a bad trade.
 *
 * So the expiry is enforced where it counts and where the clock is permitted:
 * in mutations, which always run fresh, and which fail CLOSED. A forgotten
 * switch on a shared phone cannot write anything after twelve hours, whatever
 * any subscription still on screen believes.
 *
 * Reads treat the session as unexpired (`0`) and converge instead through
 * `sweepExpiredSwitches` deleting the row — Convex's recommended shape for
 * time-based state: materialise it with a scheduled mutation rather than
 * computing it per read. The window that leaves is up to an hour of continued
 * *reading* on a twelve-hour timer, which is immaterial to what the TTL is for.
 * None of this touches the real protection: the grant itself is re-derived from
 * live rows on every single request, with no clock involved.
 */
function now(ctx: Ctx): number {
  return isMutation(ctx) ? Date.now() : 0
}

function isMutation(ctx: Ctx): ctx is MutationCtx {
  return 'insert' in ctx.db
}

/**
 * Assert a capability, or refuse with the same opaque error as every other
 * access failure.
 *
 * Always reads `env.caps`, which is `effectiveCapabilities` — already
 * intersected across the switch, with the admin capabilities forced to false
 * while switched. That last part is the rule that makes switching safe to offer
 * at all: a subcontractor who switches into their contractor must not inherit
 * the right to manage the team, and an owner working inside someone's account
 * must switch back before administering anything.
 *
 * Takes the envelope rather than a role because a role comparison at a call
 * site cannot know any of that.
 */
export function requireCapability(
  env: ActorEnvelope,
  capability: Capability,
): void {
  if (!env.caps[capability]) throw new ConvexError('NO_ACCESS')
}

export function hasCapability(
  env: ActorEnvelope,
  capability: Capability,
): boolean {
  return env.caps[capability]
}

/**
 * Whether this caller's lists show the whole business — the owner in his
 * own view, or anyone who may see every schedule — rather than one person's
 * or one team's work.
 *
 * One definition for `access.me` and the lists that page on it
 * (`jobs.listPage`, `jobs.listCounts`): the app picks which job list to
 * read from `access.me`, and the two must never disagree about which one
 * answers. Both read it through `requireActor`, so a view chosen or a
 * switch started re-runs them together.
 */
export function listsEverything(
  env: Pick<ActorEnvelope, 'listScope'>,
): boolean {
  return env.listScope.kind === 'business'
}

/**
 * Refuse to hand out a role the app cannot yet support, or must never hand out
 * at all. See `ASSIGNABLE_ROLES`.
 *
 * Keeps the existing error for the owner case: `OWNER_INVITE_FORBIDDEN` is
 * already what the invite paths throw and what the UI knows how to say.
 */
export function requireAssignableRole(role: Role): void {
  if (role === 'owner') throw new ConvexError('OWNER_INVITE_FORBIDDEN')
  if (!isAssignableRole(role)) throw new ConvexError('ROLE_NOT_ASSIGNABLE')
}

/**
 * Drop this request's cached resolution.
 *
 * The memo is what makes resolving twice in one function cheap and consistent,
 * and inside a mutation that is exactly what makes it a trap: patch a
 * membership or a switch row, resolve again, and you are handed the state from
 * before your own write. Reads are gates, so they run before the write and are
 * unaffected — but a mutation that changes access and then re-checks it must
 * say so here.
 *
 * Deliberately explicit rather than automatic. Clearing the cache on every
 * write would throw away the saving on the common path, where a mutation writes
 * a job and never re-gates.
 */
export function invalidateActor(ctx: Ctx): void {
  requestCache.delete(ctx)
}

/**
 * Delete switches that have run past their twelve hours.
 *
 * This is the other half of not reading the clock in a query (see `now`): reads
 * treat a stored switch as live, so the row going away is what ends it for
 * them. Writes do not wait for this — they check the timestamp themselves and
 * refuse — so nothing here is load-bearing for safety. It is what keeps a read
 * from lingering after a switch has aged out, and it stops the table growing
 * without bound.
 */
export async function sweepExpiredSwitches(ctx: MutationCtx): Promise<number> {
  const expired = await ctx.db
    .query('accountSwitches')
    .filter((q) => q.lte(q.field('expiresAt'), Date.now()))
    .collect()

  for (const row of expired) await ctx.db.delete(row._id)
  return expired.length
}
