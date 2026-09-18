import { ConvexError } from 'convex/values'
import { authComponent } from '../auth'
import { factsFromMembership } from './membershipFacts'
import {
  capabilitiesOf,
  effectiveCapabilities,
  isAssignableRole,
  isSwitched,
  jobScope,
  resolveActorForRead,
  resolveActorForWrite,
} from './capabilities'
import type { Doc, Id } from '../_generated/dataModel'
import type { QueryCtx, MutationCtx } from '../_generated/server'
import type {
  Capability,
  CapabilitySet,
  MembershipFacts,
  ReadActor,
  Role,
  RowScope,
  SwitchSession,
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
 * Three membership slots, not two, and the third is the reason this type
 * exists rather than `ReadActor` being returned directly.
 *
 * - `actor.real`   — the human. Audit, profile, licence, admin rights.
 * - `actor.acting` — the account being worked in. ONLY ever set by an
 *                    `accountSwitches` row. Write-bearing.
 * - `readScope`    — the account whose rows are being *read*.
 *
 * `readScope` and `acting` are the same thing once switching is the only way
 * to see someone else's data. They are not the same thing today, because the
 * app already ships a read-only "view as" (`memberships.viewingAsMembershipId`)
 * that must keep working through the expand phase.
 *
 * Folding that legacy column into `acting` would compile, pass every existing
 * test, and silently hand every current holder of `canViewOtherAccounts` the
 * right to WRITE in the account they were only ever allowed to look at —
 * including authorship of what they wrote. Keeping it in a third field is what
 * makes that upgrade impossible rather than merely unintended.
 */
export type ActorEnvelope = {
  actor: ReadActor
  readScope: MembershipFacts
  /** `effectiveCapabilities` — intersected across the switch, with the admin
   * capabilities already dropped. The authority for every permission check;
   * never re-derive from a role at a call site. */
  caps: CapabilitySet
  /** Which rows this caller may read. See `scopeCapsFor` for why this is not
   * simply derived from `caps`. */
  scope: RowScope
  /**
   * The rows the REAL person may read, ignoring any lens they are looking
   * through. The same object as `scope` unless they are switched or viewing as
   * someone.
   *
   * For pickers and anything else that offers a choice the caller will act on
   * themselves — attaching a note to a job, say. Offering the target's jobs
   * there would let someone select work they cannot touch, and the failure
   * would surface later as a refused write rather than an absent option.
   */
  realScope: RowScope
  /** True when `readScope` came from the legacy read-only view-as rather than
   * from a switch. Read access only — never let this reach a write path. */
  viewingAsLegacy: boolean
}

/**
 * A write envelope never carries a legacy read scope.
 *
 * `readScope` on a write envelope is always the account being acted in, and
 * `viewingAsLegacy` is always false. Without that, the read-only view-as would
 * reach a mutation through the back door: not as `acting` — which is guarded —
 * but as `scope`, the one row filter a mutation author is offered. A gate as
 * ordinary as `if (!isInScope(env.scope, job)) throw` would then pass for every
 * job the *target* can see, and the write would land attributed to the caller.
 *
 * The invariant is "the legacy column never reaches a write path", and `acting`
 * was only ever half of that path.
 */
export type WriteEnvelope = Omit<ActorEnvelope, 'actor' | 'viewingAsLegacy'> & {
  actor: WriteActor
  readonly viewingAsLegacy: false
}

// ────────────────────────────────────────────────────────────── loading rows

type ActorRows = {
  real: MembershipFacts
  realParent: MembershipFacts | null
  /** The switch target, and the session that claims it. Both null unless an
   * `accountSwitches` row applies to this request. */
  target: MembershipFacts | null
  session: SwitchSession | null
  /** The legacy read-only view-as target, if the stored selection still
   * validates under the OLD rule. Never feeds `acting`. */
  legacyTarget: MembershipFacts | null
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
  // removed person's sessions, and this is where that takes effect.
  const user = await authComponent.getAuthUser(ctx)

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

  const [realParent, switchRow, legacyTarget] = await Promise.all([
    parentOf(ctx, real),
    findSwitch(ctx, businessId, real._id),
    legacyViewAsTarget(ctx, membership),
  ])

  const target = switchRow ? await getMembership(ctx, switchRow.target) : null

  return {
    real,
    realParent,
    target,
    session: switchRow?.session ?? null,
    legacyTarget,
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

  // The row names the membership it was opened for. A person who is removed
  // and later rejoins gets a NEW membership id, so a surviving row from the
  // previous stint would otherwise still apply to them. Re-derived rather than
  // trusted, like everything else here.
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
 * The legacy read-only "view as" selection, re-derived against the CURRENT
 * state of both memberships rather than trusted from the stored column.
 *
 * Fails open on purpose, and that is inherited behaviour, not a new choice: a
 * stale selection (grant revoked, target removed) should stop taking effect,
 * not break the page. The rule is the old one deliberately — this is a feature
 * on its way out, and re-implementing it in terms of the new grants would
 * change who it applies to during the very window it exists to keep stable.
 */
async function legacyViewAsTarget(
  ctx: Ctx,
  caller: Doc<'memberships'>,
): Promise<MembershipFacts | null> {
  if (!caller.viewingAsMembershipId) return null

  const target = await ctx.db.get(caller.viewingAsMembershipId)
  if (!target) return null
  if (target.businessId !== caller.businessId) return null
  if (target.status !== 'active') return null
  if (target._id === caller._id) return null
  // The owner is never a view-as target, whatever else is true.
  if (target.role === 'owner') return null
  if (caller.role !== 'owner' && caller.canViewOtherAccounts !== true) {
    return null
  }

  return factsFromMembership(target)
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

/**
 * Which capabilities decide READ SCOPE — which is not always the same set that
 * decides permissions, and conflating the two breaks the older feature.
 *
 * Switching intersects: a subcontractor who cannot see everyone's schedule must
 * not acquire that by switching into someone who can. `caps` is already the
 * intersection, so scope uses it directly.
 *
 * The legacy read-only view-as does the opposite, and must. Its entire purpose
 * is "show me what Kevin sees". Scoping it by the viewer's own capabilities
 * would mean an owner — who can see everything — viewing as Kevin and being
 * shown the whole business, which is not a narrower answer to the wrong
 * question, it is the feature not working at all. So scope comes from the
 * target's own capabilities, exactly as `jobVisibility(target)` computes it
 * today.
 *
 * The two rules agree whenever nobody is viewing or switching, which is every
 * request in production right now.
 */
function scopeCapsFor(
  actor: ReadActor,
  caps: CapabilitySet,
  readScope: MembershipFacts,
  readScopeParent: MembershipFacts | null,
): CapabilitySet {
  if (isSwitched(actor)) return caps
  if (readScope._id === actor.real._id) return caps
  return capabilitiesOf(readScope, readScopeParent)
}

async function envelope(
  ctx: Ctx,
  businessId: Id<'businesses'>,
  rows: ActorRows,
  actor: ReadActor,
  { forWrite }: { forWrite: boolean },
): Promise<ActorEnvelope> {
  const switched = isSwitched(actor)

  /**
   * Three-way precedence, and the middle case is the one that is easy to miss.
   *
   * A live switch wins: you cannot be looking through one person's eyes while
   * working in another's account.
   *
   * A switch that was ATTEMPTED and dropped returns you to yourself — not to
   * whatever stale view-as selection happens to be sitting on your membership
   * row. Falling through to the legacy target would have the banner say "your
   * switch into Kevin ended, you are back in your own account" while the server
   * quietly served Priya's rows.
   *
   * Only with no switch in play at all does the legacy selection apply. And
   * never on a write.
   */
  const legacyTarget = forWrite || actor.degraded ? null : rows.legacyTarget
  const readScope = switched ? actor.acting : (legacyTarget ?? rows.real)
  const readScopeParent = switched
    ? await parentOf(ctx, actor.acting)
    : legacyTarget
      ? await parentOf(ctx, legacyTarget)
      : rows.realParent

  const caps = effectiveCapabilities(
    actor,
    rows.realParent,
    switched ? readScopeParent : null,
  )

  const scopeCaps = scopeCapsFor(actor, caps, readScope, readScopeParent)
  const scope = jobScope(
    scopeCaps,
    readScope,
    await teamFor(ctx, businessId, readScope, scopeCaps),
  )

  // Only computed when it can differ. Looking through nobody's eyes, the
  // person's own scope IS the scope, and a second team lookup would be a
  // read on every request to answer a question nobody asked.
  const looking = readScope._id !== rows.real._id
  const realCaps = capabilitiesOf(rows.real, rows.realParent)
  const realScope = looking
    ? jobScope(
        realCaps,
        rows.real,
        await teamFor(ctx, businessId, rows.real, realCaps),
      )
    : scope

  return {
    actor,
    readScope,
    caps,
    scope,
    realScope,
    viewingAsLegacy: !switched && looking,
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
  return envelope(ctx, businessId, rows, actor, { forWrite: false })
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

  const env = await envelope(ctx, businessId, rows, result.actor, {
    forWrite: true,
  })
  return { ...env, actor: result.actor, viewingAsLegacy: false }
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
