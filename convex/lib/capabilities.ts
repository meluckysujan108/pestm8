import type { Doc, Id } from '../_generated/dataModel'

/**
 * The access model, as data and pure functions.
 *
 * Pure in the same sense as `lib/dates.ts`: no `convex/server`, no `ctx`, no
 * clock. Every time it needs "now" the caller passes it. That is what lets
 * `src/` import this module and gate a button with the same rule the server
 * enforces — today the policy is written twice, once here in `lib/access.ts`
 * and once by hand in role comparisons across the UI, and the two copies have
 * already drifted apart (the report-template screen renders an "Owners only"
 * wall over data the server hands to any member).
 *
 * The policy is a TABLE, not a chain of conditionals, and it is
 * `satisfies Record<Role, RolePolicy>`. Adding a role, or adding a capability,
 * is a type error until every cell has an explicit decision. There is no
 * default branch anywhere in this file, so nobody can inherit a permission
 * that was never written down.
 */

// ─────────────────────────────────────────────────────────── who someone is

export type Role = 'owner' | 'contractor' | 'subcontractor'
export type MemberStatus = 'active' | 'invited' | 'removed'

/** The four per-person toggles, in the owner's words:
 *  - `switchInto`      "can work in my account"
 *  - `clientDirectory` "can see all clients"
 *  - `prices`          "can see job prices"
 *  - `otherSchedules`  "can see everyone's schedule" (read-only) */
export type GrantKey =
  'switchInto' | 'clientDirectory' | 'prices' | 'otherSchedules'

/**
 * `switchInto` is an id, not a boolean, and that single choice carries the
 * whole rule that a grant belongs to the person who gave it.
 *
 * A boolean ("may switch into someone") survives a team move, so moving a
 * subcontractor between contractors would hand them read-write access to a
 * contractor who never agreed to it. An id names one contractor, and
 * `canSwitchInto` additionally requires that it still equals the
 * subcontractor's current parent. A team move therefore makes the grant inert
 * by construction, whether or not any cleanup code runs.
 */
export type Grants = {
  switchInto: Id<'memberships'> | null
  clientDirectory: boolean
  prices: boolean
  otherSchedules: boolean
}

/** Expiry is optional because the schema has no expiry column yet: a licence
 * with a number and no expiry reads as valid rather than as missing. */
export type Licence = { number?: string; expiresAt?: number }

/**
 * Everything this module may know about a person. A structural subset of the
 * membership document, so a test can build one by hand and the client can be
 * handed one without the whole row.
 */
export type MembershipFacts = {
  _id: Id<'memberships'>
  businessId: Id<'businesses'>
  role: Role
  status: MemberStatus
  /** The contractor a subcontractor belongs to. Null for owner and contractor.
   * "A contractor has a team" has no other representation. */
  parentMembershipId: Id<'memberships'> | null
  grants: Grants
  licence: Licence | null
}

/** What a roster is allowed to say about someone else. Deliberately not
 * `MembershipFacts`: grants, licence and status are management information,
 * and the roster query is read by every member. */
export type PersonCard = {
  _id: Id<'memberships'>
  role: Role
}

// ──────────────────────────────────────────────────────── acting as someone

/** A switch ends when the working day does. The real protection is that every
 * single write re-validates the grant; this only stops a forgotten switch
 * living on a shared phone overnight. */
export const SWITCH_TTL_MS = 12 * 60 * 60 * 1000

export type SwitchSession = {
  targetMembershipId: Id<'memberships'>
  startedAt: number
  expiresAt: number
}

export type SwitchFailure =
  | 'SWITCH_EXPIRED'
  | 'SWITCH_REVOKED'
  | 'SWITCH_TEAM_CHANGED'
  | 'SWITCH_TARGET_INACTIVE'
  | 'SWITCH_NOT_PERMITTED'
  | 'SWITCH_CHAINED'

/**
 * Who is here, in two halves.
 *
 * `real` is the human at the keyboard — their mentions, their audit trail,
 * their licence, their profile. `acting` is the account being worked in — whose
 * jobs these are, and whose name goes on what gets written. When nobody has
 * switched, the two are the same object.
 */
export type ReadActor = {
  real: MembershipFacts
  acting: MembershipFacts
  session: SwitchSession | null
  /** Set when a stored switch no longer validates and was dropped. Reads
   * continue as yourself; the banner uses this to say why. */
  degraded: SwitchFailure | null
}

declare const validatedForWrite: unique symbol

/**
 * A `ReadActor` that came from `resolveActorForWrite`, and can only have come
 * from there.
 *
 * The brand exists because the dangerous mistake is quiet: a mutation author
 * reaches for the resolver they already used for reads, that one falls back to
 * `real` when a switch has ended, and the write is then stamped with the wrong
 * author — the exact failure the fail-closed path was written to prevent. The
 * type makes that call not compile.
 */
export type WriteActor = ReadActor & { readonly [validatedForWrite]: true }

export type WriteActorResult =
  { ok: true; actor: WriteActor } | { ok: false; reason: SwitchFailure }

export function isSwitched(actor: ReadActor): boolean {
  return actor.session !== null && actor.acting._id !== actor.real._id
}

/** Why a stored switch is no longer usable, or null if it still is. */
function switchFailure(
  real: MembershipFacts,
  target: MembershipFacts | null,
  session: SwitchSession,
  now: number,
): SwitchFailure | null {
  if (!target) return 'SWITCH_NOT_PERMITTED'
  if (session.expiresAt <= now) return 'SWITCH_EXPIRED'
  if (target.status !== 'active') return 'SWITCH_TARGET_INACTIVE'

  const decision = switchDecision(real, target, { chained: false })
  if (decision.ok) return null

  // Distinguish the two the banner can explain from the ones it cannot.
  if (decision.reason === 'NOT_IN_TEAM') return 'SWITCH_TEAM_CHANGED'
  if (decision.reason === 'NOT_GRANTED') return 'SWITCH_REVOKED'
  return 'SWITCH_NOT_PERMITTED'
}

/**
 * Reads fail OPEN. A revoked grant should drop you back to your own schedule,
 * not break the page — the behaviour the read-only "view as" already had. The
 * difference is that the fallback is now reported rather than silent.
 */
export function resolveActorForRead(
  real: MembershipFacts,
  target: MembershipFacts | null,
  session: SwitchSession | null,
  now: number,
): ReadActor {
  if (!session) return { real, acting: real, session: null, degraded: null }

  const failure = switchFailure(real, target, session, now)
  if (failure || !target) {
    return {
      real,
      acting: real,
      session: null,
      degraded: failure ?? 'SWITCH_NOT_PERMITTED',
    }
  }
  return { real, acting: target, session, degraded: null }
}

/**
 * Writes fail CLOSED, and are a separate function rather than a flag, so that
 * "resolve the actor" on a mutation cannot silently mean "fall back to me".
 */
export function resolveActorForWrite(
  real: MembershipFacts,
  target: MembershipFacts | null,
  session: SwitchSession | null,
  now: number,
): WriteActorResult {
  if (!session) {
    const actor: ReadActor = {
      real,
      acting: real,
      session: null,
      degraded: null,
    }
    return { ok: true, actor: actor as WriteActor }
  }

  const failure = switchFailure(real, target, session, now)
  if (failure || !target)
    return { ok: false, reason: failure ?? 'SWITCH_NOT_PERMITTED' }

  const actor: ReadActor = { real, acting: target, session, degraded: null }
  return { ok: true, actor: actor as WriteActor }
}

// ───────────────────────────────────────────────────────────── capabilities

/**
 * One entry per genuine decision, not per function — the gallery mutations all
 * ask the same question, and so do the template writes.
 *
 * Row scope ("which jobs exist for me") is deliberately absent: that is a set,
 * not a boolean, and lives in `RowScope`.
 */
export type Capability =
  | 'business.manage'
  | 'templates.manage'
  | 'team.manage'
  | 'clients.manage'
  | 'jobs.dispatch'
  | 'prices.see'
  | 'clients.directory'
  | 'schedules.seeOthers'
  | 'accounts.switch'

export type Decision = 'always' | 'never' | { byGrant: GrantKey }
export type RolePolicy = Record<Capability, Decision>

/**
 * The table. Everything else in this file reads it.
 *
 * `'never'` is load-bearing: a `never` cell cannot be granted by anyone,
 * including the owner, because the grant is never consulted for it. That is
 * what makes "a contractor can only give away what they hold" a property of
 * the code rather than a convention.
 *
 * `jobs.dispatch` is `'always'` for everyone on purpose. A subcontractor
 * booking their own return visit is the model's "full control of your own
 * account"; who they may book it ONTO is `canDispatchTo`'s job, and expressing
 * the ceiling once there beats a flat `never` that also forbids the obvious.
 */
export const ROLE_POLICY = {
  owner: {
    'business.manage': 'always',
    'templates.manage': 'always',
    'team.manage': 'always',
    'clients.manage': 'always',
    'jobs.dispatch': 'always',
    'prices.see': 'always',
    'clients.directory': 'always',
    'schedules.seeOthers': 'always',
    'accounts.switch': 'always',
  },
  contractor: {
    'business.manage': 'never',
    'templates.manage': 'never',
    'team.manage': 'always', // own team only — canManageMember
    'clients.manage': 'always',
    'jobs.dispatch': 'always', // own team only — canDispatchTo
    'prices.see': { byGrant: 'prices' },
    'clients.directory': { byGrant: 'clientDirectory' },
    'schedules.seeOthers': { byGrant: 'otherSchedules' },
    'accounts.switch': 'always', // downward, into their own team
  },
  subcontractor: {
    'business.manage': 'never',
    'templates.manage': 'never',
    'team.manage': 'never',
    'clients.manage': 'never',
    'jobs.dispatch': 'always', // onto themselves only — canDispatchTo
    'prices.see': { byGrant: 'prices' },
    'clients.directory': { byGrant: 'clientDirectory' },
    'schedules.seeOthers': { byGrant: 'otherSchedules' },
    'accounts.switch': { byGrant: 'switchInto' }, // upward, one contractor
  },
} satisfies Record<Role, RolePolicy>

/** Everything an admin action needs. Named because these are exactly the
 * capabilities a switch does not carry — see `effectiveCapabilities`. */
const ADMIN_CAPABILITIES = [
  'business.manage',
  'templates.manage',
  'team.manage',
  'clients.manage',
] as const satisfies ReadonlyArray<Capability>

const ALL_CAPABILITIES = Object.keys(
  ROLE_POLICY.owner,
) as ReadonlyArray<Capability>

export type CapabilitySet = Readonly<Record<Capability, boolean>>

function decide(decision: Decision, grants: Grants): boolean {
  if (decision === 'always') return true
  if (decision === 'never') return false
  const value = grants[decision.byGrant]
  return decision.byGrant === 'switchInto' ? value !== null : value === true
}

/**
 * What one person holds in their own right.
 *
 * `parent` matters: a subcontractor's grants are clamped to their contractor's
 * on every read, so a contractor whose own "see prices" is later turned off
 * cannot leave a subcontractor behind still seeing them. Doing it here rather
 * than in a cleanup mutation means there is no window where the two disagree.
 */
export function capabilitiesOf(
  m: MembershipFacts,
  parent: MembershipFacts | null = null,
): CapabilitySet {
  const policy = ROLE_POLICY[m.role]
  const parentCaps =
    m.role === 'subcontractor' && parent ? capabilitiesOf(parent) : null

  const out = {} as Record<Capability, boolean>
  for (const capability of ALL_CAPABILITIES) {
    const held = decide(policy[capability], m.grants)
    // A ceiling, not an inheritance: it can only ever take a grant away.
    out[capability] =
      held &&
      (parentCaps === null ||
        isCeilinged(capability) === false ||
        parentCaps[capability])
  }
  return out
}

/** The three data toggles a contractor may pass down. Admin capabilities are
 * role-inherent and not subject to the parent's grants. */
function isCeilinged(capability: Capability): boolean {
  return (
    capability === 'prices.see' ||
    capability === 'clients.directory' ||
    capability === 'schedules.seeOthers'
  )
}

/**
 * What the person at the keyboard may actually do right now.
 *
 * Two rules, and the difference between them is the whole design:
 *
 *  - Data toggles INTERSECT. Whether you may see prices is a fact about you,
 *    not about the account you are standing in, so a switch can never be used
 *    to launder one.
 *  - Admin capabilities are dropped entirely while switched. Switching is for
 *    doing someone's work, not for administering the business as them; without
 *    this a subcontractor in their contractor's account could grant themselves
 *    anything.
 *
 * Row scope is the deliberate exception and is not computed here: it comes
 * wholly from `acting`, because the entire point of switching is to work on
 * that account's jobs. See `jobScope`.
 */
export function effectiveCapabilities(
  actor: ReadActor,
  realParent: MembershipFacts | null = null,
  actingParent: MembershipFacts | null = null,
): CapabilitySet {
  const realCaps = capabilitiesOf(actor.real, realParent)
  if (!isSwitched(actor)) return realCaps

  const actingCaps = capabilitiesOf(actor.acting, actingParent)
  const out = {} as Record<Capability, boolean>
  for (const capability of ALL_CAPABILITIES) {
    out[capability] = (
      ADMIN_CAPABILITIES as ReadonlyArray<Capability>
    ).includes(capability)
      ? false
      : realCaps[capability] && actingCaps[capability]
  }
  return out
}

export function can(caps: CapabilitySet, capability: Capability): boolean {
  return caps[capability]
}

// ───────────────────────────────────────────────────────────────── row scope

/**
 * Whose rows exist for this actor.
 *
 * Taken from `acting`, never intersected — a helper switched in to finish a
 * colleague's report has to be able to see that colleague's jobs, or switching
 * does nothing. What it does NOT widen is the data toggles above, which are
 * exactly the things that would leak sideways out of the account: prices, the
 * client book, other people's schedules.
 *
 * The owner is not excluded from anyone's scope. Hiding the owner's JOBS would
 * leave their van invisible on a shared calendar and drop their work out of
 * every revenue total; the owner is hidden as a PERSON instead — see
 * `displayPerson` and `peopleVisibleTo`.
 */
export type RowScope =
  | { kind: 'business' }
  | { kind: 'team'; membershipIds: ReadonlyArray<Id<'memberships'>> }
  | { kind: 'own'; membershipId: Id<'memberships'> }

/** `caps` must be the result of `effectiveCapabilities`, so the intersected
 * value of "can see everyone's schedule" is the only one available here. */
export function jobScope(
  caps: CapabilitySet,
  acting: MembershipFacts,
  team: ReadonlyArray<MembershipFacts>,
): RowScope {
  if (acting.role === 'owner' || caps['schedules.seeOthers']) {
    return { kind: 'business' }
  }
  if (acting.role === 'contractor') {
    return {
      kind: 'team',
      membershipIds: [
        acting._id,
        ...team
          .filter((m) => m.parentMembershipId === acting._id)
          .map((m) => m._id),
      ],
    }
  }
  return { kind: 'own', membershipId: acting._id }
}

/**
 * The same question as `isInScope`, asked of a report.
 *
 * Separate rather than shared, because the column differs: a job is scoped by
 * who it is assigned to, a report by who authored it. A structural helper
 * taking `{ membershipId }` would let either be passed where the other was
 * meant and type-check perfectly — and the day a report gains an assignee, the
 * wrong column would silently start deciding who can read compliance records.
 */
export function reportScope(
  scope: RowScope,
  report: { authorMembershipId: Id<'memberships'> },
): boolean {
  if (scope.kind === 'business') return true
  if (scope.kind === 'own') {
    return report.authorMembershipId === scope.membershipId
  }
  return scope.membershipIds.includes(report.authorMembershipId)
}

export function isInScope(
  scope: RowScope,
  row: { assignedMembershipId: Id<'memberships'> },
): boolean {
  if (scope.kind === 'business') return true
  if (scope.kind === 'own') {
    return row.assignedMembershipId === scope.membershipId
  }
  return scope.membershipIds.includes(row.assignedMembershipId)
}

/** The whole client book, or only clients reachable from a job in scope. */
export function clientScope(caps: CapabilitySet): 'directory' | 'assigned' {
  return caps['clients.directory'] ? 'directory' : 'assigned'
}

export function canEditJob(
  actor: ReadActor,
  job: { assignedMembershipId: Id<'memberships'> },
  team: ReadonlyArray<MembershipFacts> = [],
): boolean {
  const acting = actor.acting
  if (acting.role === 'owner') return true
  if (job.assignedMembershipId === acting._id) return true
  // Read reach has never implied write reach, and "can see everyone's
  // schedule" is explicitly read-only. Only a contractor's own team is theirs
  // to edit.
  return (
    acting.role === 'contractor' &&
    team.some(
      (m) =>
        m._id === job.assignedMembershipId &&
        m.parentMembershipId === acting._id,
    )
  )
}

/** Who this actor may put work onto. A subcontractor may book their own next
 * visit, and nobody else's. */
export function canDispatchTo(
  actor: ReadActor,
  assignee: MembershipFacts,
): boolean {
  const acting = actor.acting
  if (assignee.status !== 'active') return false
  if (assignee.businessId !== acting.businessId) return false
  if (assignee._id === acting._id) return true
  if (acting.role === 'owner') return true
  return (
    acting.role === 'contractor' && assignee.parentMembershipId === acting._id
  )
}

// ──────────────────────────────────────────────────────────── team authority

/**
 * Who may change someone's access. Always computed on the REAL person: a grant
 * must never be reachable through a switch. (`effectiveCapabilities` already
 * drops `team.manage` while switched; this is the second of the two locks.)
 */
export function canManageMember(
  actor: ReadActor,
  target: MembershipFacts,
): boolean {
  if (isSwitched(actor)) return false
  const real = actor.real
  if (real.businessId !== target.businessId) return false
  if (target._id === real._id) return false
  // The owner account is the key to the business and is not administered from
  // inside the app by anyone, including itself.
  if (target.role === 'owner') return false
  if (real.role === 'owner') return true
  return (
    real.role === 'contractor' &&
    target.role === 'subcontractor' &&
    target.parentMembershipId === real._id
  )
}

/**
 * The most this granter may give this target — arithmetic, not a review step.
 *
 * `switchInto` may only ever name the target's CURRENT contractor. Allowing any
 * contractor would let an inert grant sit on a row until a later team move
 * quietly activated it.
 */
export function grantCeiling(
  actor: ReadActor,
  target: MembershipFacts,
): Grants {
  const granterCaps = capabilitiesOf(actor.real)
  return {
    switchInto: target.parentMembershipId,
    clientDirectory: granterCaps['clients.directory'],
    prices: granterCaps['prices.see'],
    otherSchedules: granterCaps['schedules.seeOthers'],
  }
}

export function clampGrants(
  actor: ReadActor,
  target: MembershipFacts,
  requested: Grants,
): Grants {
  const ceiling = grantCeiling(actor, target)
  return {
    switchInto:
      requested.switchInto !== null &&
      ceiling.switchInto !== null &&
      requested.switchInto === ceiling.switchInto
        ? requested.switchInto
        : null,
    clientDirectory: requested.clientDirectory && ceiling.clientDirectory,
    prices: requested.prices && ceiling.prices,
    otherSchedules: requested.otherSchedules && ceiling.otherSchedules,
  }
}

export const NO_GRANTS: Grants = {
  switchInto: null,
  clientDirectory: false,
  prices: false,
  otherSchedules: false,
}

export const DEFAULT_GRANTS = {
  owner: {
    switchInto: null,
    clientDirectory: true,
    prices: true,
    otherSchedules: true,
  },
  contractor: {
    switchInto: null,
    clientDirectory: true,
    prices: true,
    // A contractor seeing the whole schedule is the normal case for someone
    // dispatching work; leaving it off by default made a subcontractor's
    // reach potentially wider than their own contractor's.
    otherSchedules: true,
  },
  subcontractor: NO_GRANTS,
} satisfies Record<Role, Grants>

/**
 * The single invariant the lifecycle has to maintain: a member's grants must
 * be valid for their CURRENT role, parent and status. Rejoining, moving team,
 * changing role and being removed are all the same question, so they are all
 * this one function rather than four that can disagree.
 */
export function recomputeGrants(
  member: MembershipFacts,
  parent: MembershipFacts | null,
): Grants {
  if (member.status !== 'active') return NO_GRANTS
  if (member.role !== 'subcontractor') {
    return { ...member.grants, switchInto: null }
  }

  const parentCaps = parent ? capabilitiesOf(parent) : null
  return {
    // Only ever the current contractor, and only if it is still a real one.
    switchInto:
      parent && member.parentMembershipId === parent._id
        ? member.grants.switchInto === parent._id
          ? parent._id
          : null
        : null,
    clientDirectory:
      member.grants.clientDirectory &&
      (parentCaps?.['clients.directory'] ?? false),
    prices: member.grants.prices && (parentCaps?.['prices.see'] ?? false),
    otherSchedules:
      member.grants.otherSchedules &&
      (parentCaps?.['schedules.seeOthers'] ?? false),
  }
}

// ───────────────────────────────────────────────────────────────── switching

export type SwitchRefusal =
  | 'NO_CHAINING'
  | 'OWNER_NOT_SWITCHABLE'
  | 'SELF'
  | 'TARGET_INACTIVE'
  | 'CROSS_BUSINESS'
  | 'NOT_IN_TEAM'
  | 'NOT_GRANTED'

export type SwitchDecision = { ok: true } | { ok: false; reason: SwitchRefusal }

/**
 * The only door into someone else's account.
 *
 * One hop. Chaining would let A reach C through B, using an account C opened
 * only to B. The owner is never a target for anyone, including another owner.
 *
 * Going up (a subcontractor into their contractor) needs the grant AND the
 * current parent to agree. Going down (a contractor into their own team, the
 * owner into anyone) is what the role means and needs no toggle.
 */
function switchDecision(
  real: MembershipFacts,
  target: MembershipFacts,
  opts: { chained: boolean },
): SwitchDecision {
  if (opts.chained) return { ok: false, reason: 'NO_CHAINING' }
  if (target.businessId !== real.businessId) {
    return { ok: false, reason: 'CROSS_BUSINESS' }
  }
  if (target._id === real._id) return { ok: false, reason: 'SELF' }
  if (target.role === 'owner')
    return { ok: false, reason: 'OWNER_NOT_SWITCHABLE' }
  if (target.status !== 'active')
    return { ok: false, reason: 'TARGET_INACTIVE' }

  if (real.role === 'owner') return { ok: true }

  if (real.role === 'contractor') {
    return target.parentMembershipId === real._id
      ? { ok: true }
      : { ok: false, reason: 'NOT_IN_TEAM' }
  }

  // Subcontractor, upward, to their own contractor only.
  if (target.role !== 'contractor') return { ok: false, reason: 'NOT_IN_TEAM' }
  if (real.parentMembershipId !== target._id) {
    return { ok: false, reason: 'NOT_IN_TEAM' }
  }
  return real.grants.switchInto === target._id
    ? { ok: true }
    : { ok: false, reason: 'NOT_GRANTED' }
}

export function canSwitchInto(
  actor: ReadActor,
  target: MembershipFacts,
): SwitchDecision {
  return switchDecision(actor.real, target, { chained: isSwitched(actor) })
}

export function switchTargets(
  actor: ReadActor,
  people: ReadonlyArray<MembershipFacts>,
): ReadonlyArray<MembershipFacts> {
  return people.filter((person) => canSwitchInto(actor, person).ok)
}

export function beginSwitch(
  targetMembershipId: Id<'memberships'>,
  now: number,
): SwitchSession {
  return {
    targetMembershipId,
    startedAt: now,
    expiresAt: now + SWITCH_TTL_MS,
  }
}

// ─────────────────────────────────────────────────────────────  attribution

/**
 * "X on behalf of Y", pinned down.
 *
 * `authorMembershipId` is the ACCOUNT: the work belongs to whoever's account it
 * was done in, which is what lets a helper finish a colleague's report without
 * rewriting its authorship. `actorMembershipId` is the HUMAN who pressed the
 * button. `onBehalfOfMembershipId` appears only when those differ.
 */
export type WriteAttribution = {
  authorMembershipId: Id<'memberships'>
  actorMembershipId: Id<'memberships'>
  onBehalfOfMembershipId?: Id<'memberships'>
}

/** Takes a branded `WriteActor`, so there is no way to attribute a write whose
 * switch was never validated. */
export function writeAttribution(actor: WriteActor): WriteAttribution {
  return isSwitched(actor)
    ? {
        authorMembershipId: actor.acting._id,
        actorMembershipId: actor.real._id,
        onBehalfOfMembershipId: actor.acting._id,
      }
    : {
        authorMembershipId: actor.acting._id,
        actorMembershipId: actor.real._id,
      }
}

// ───────────────────────────────────────────────────── people & invisibility

/**
 * Owner invisibility hides the PERSON, never the RECORD, and never the WORK.
 *
 * The owner does not appear in team lists, assignee pickers, @mention lists,
 * switch menus or activity trails. But their jobs stay on the shared calendar
 * (otherwise everyone else double-books the van the owner is driving) and in
 * revenue totals, and the compliance documents they signed stay readable — see
 * `displayPerson`, which renders them as the business rather than removing
 * them.
 */
export function isVisiblePerson(
  actor: ReadActor,
  person: MembershipFacts | PersonCard,
): boolean {
  if (actor.acting.role === 'owner') return true
  return person.role !== 'owner'
}

export function peopleVisibleTo<T extends MembershipFacts | PersonCard>(
  actor: ReadActor,
  people: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return people.filter((person) => isVisiblePerson(actor, person))
}

export function peopleAssignableBy(
  actor: ReadActor,
  people: ReadonlyArray<MembershipFacts>,
): ReadonlyArray<MembershipFacts> {
  return people.filter((person) => canDispatchTo(actor, person))
}

export function peopleMentionableBy<T extends MembershipFacts | PersonCard>(
  actor: ReadActor,
  people: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return peopleVisibleTo(actor, people)
}

/**
 * How to name someone on a record others can see.
 *
 * An owner-authored site note keeps its gate code visible to the tech standing
 * at the gate; it is simply signed by the business. The membership id is
 * withheld as well, because an id that resolves to nobody on the roster is a
 * reliable way to pick the owner out.
 *
 * REGULATED DOCUMENTS ARE EXEMPT. A certificate names the licensed person who
 * signed it, always — see `technicianDisplay`. Substituting the business name
 * there would produce an invalid document, which is the opposite of protecting
 * anyone.
 */
export function displayPerson(
  actor: ReadActor,
  person: Pick<MembershipFacts, '_id' | 'role'>,
  names: { personName: string; businessName: string },
): {
  membershipId: Id<'memberships'> | null
  name: string
  anonymised: boolean
} {
  if (isVisiblePerson(actor, person)) {
    return {
      membershipId: person._id,
      name: names.personName,
      anonymised: false,
    }
  }
  return { membershipId: null, name: names.businessName, anonymised: true }
}

/** The name a compliance document prints. Never anonymised, for anyone. */
export function technicianDisplay(names: { personName: string }): string {
  return names.personName
}

/** The owner is always selectable as the technician on a report: in a business
 * this size they are usually the principal licence holder. */
export function isSelectableAsTechnician(person: MembershipFacts): boolean {
  return person.status === 'active'
}

// ───────────────────────────────────────────────────────────────── licences

export type LicenceStatus = 'valid' | 'missing' | 'expired'

export function licenceStatus(
  licence: Licence | null,
  now: number,
): LicenceStatus {
  if (!licence?.number) return 'missing'
  if (licence.expiresAt !== undefined && licence.expiresAt <= now) {
    return 'expired'
  }
  return 'valid'
}

/**
 * A licence belongs to the person who holds it. This is the one edit that is
 * refused while switched no matter what else is allowed: it is the credential
 * the regulator relies on, and it prints on documents the holder signs.
 */
export function canSetLicence(
  actor: ReadActor,
  target: MembershipFacts,
): boolean {
  if (isSwitched(actor)) return false
  if (target._id === actor.real._id) return true
  return canManageMember(actor, target)
}

/** Name and phone always edit the real person: someone working in a colleague's
 * account who opens Settings is editing themselves. */
export function profileEditTarget(actor: ReadActor): Id<'memberships'> {
  return actor.real._id
}

// ───────────────────────────────────────────────────────── reports & drafts

/**
 * Which kind of document a report is, taken from the schema's own union rather
 * than written out again — so adding a template is a compile error in the table
 * below until someone decides whether it carries a legal attestation.
 */
export type ReportTemplate = Doc<'reports'>['template']

/**
 * Whether finalising this document is an act of certification.
 *
 * A table, like `ROLE_POLICY`, and `satisfies` for the same reason: there is no
 * default branch, so a new template cannot inherit an answer nobody gave.
 *
 * The three built-ins are the AS 4349.3 inspection, the AS 3660.2 termite
 * certificate and the APVMA treatment record — documents that carry a licensed
 * person's attestation. The service report does not; it is the everyday record
 * of a visit.
 *
 * `custom` is true, and that is a deliberately cautious answer rather than an
 * accurate one. "Editing" a built-in clones it (`customTemplates.cloneBuiltin`),
 * legal basis and all, so a custom template may be a termite certificate in
 * everything but name — and nothing stored tells the two apart: the clone does
 * not record what it came from, and `reports.legalBasis` is a client-supplied
 * string, so it cannot be trusted to decide this.
 *
 * The two ways to be wrong are not symmetric. Wrongly unregulated means a
 * compliance certificate finalised under a licence its holder did not press the
 * button for — the precise harm this exists to prevent. Wrongly regulated means
 * someone switches back to their own account to press Finalise. So: cautious
 * until a template can state what it is.
 */
const REGULATED_TEMPLATE = {
  treatmentRecord: true,
  timberPestInspection: true,
  termiteManagementCert: true,
  serviceReport: false,
  custom: true,
} satisfies Record<ReportTemplate, boolean>

export function isRegulatedTemplate(template: ReportTemplate): boolean {
  return REGULATED_TEMPLATE[template]
}

export type ReportFacts = {
  _id: Id<'reports'>
  businessId: Id<'businesses'>
  authorMembershipId: Id<'memberships'>
  status: 'draft' | 'finalised'
  /** Whether the document carries a legal attestation — an AS 4349.3
   * inspection, an AS 3660.2 certificate, an APVMA treatment record. */
  regulated: boolean
}

export function canEditReport(actor: ReadActor, report: ReportFacts): boolean {
  if (report.status !== 'draft') return false
  if (report.businessId !== actor.acting.businessId) return false
  if (report.authorMembershipId === actor.acting._id) return true
  return actor.acting.role === 'owner'
}

export type FinaliseRefusal =
  | 'NOT_EDITABLE'
  | 'SWITCHED_REGULATED'
  | 'HOLDER_LICENCE_MISSING'
  | 'HOLDER_LICENCE_EXPIRED'
  | 'TECHNICIAN_LICENCE_MISSING'
  | 'TECHNICIAN_LICENCE_EXPIRED'

export type FinaliseDecision =
  { ok: true } | { ok: false; reason: FinaliseRefusal }

/**
 * Finalising is where a draft becomes an assertion somebody is accountable for.
 *
 * A helper working in someone's account may fill the whole form, but on a
 * regulated document the licence holder presses the button themselves. The
 * alternative — allowing it — produces a certificate stating that the account
 * holder attested to work another person did, under that holder's licence
 * number. That is what licence-lending looks like to an insurer.
 *
 * Every licensed identity the document will print is checked, not just the
 * account holder: the form's technician field can name somebody else, and that
 * is the name and licence the PDF carries.
 */
export function canFinaliseReport(
  actor: ReadActor,
  report: ReportFacts,
  people: { holder: MembershipFacts; technician?: MembershipFacts | null },
  now: number,
): FinaliseDecision {
  if (!canEditReport(actor, report))
    return { ok: false, reason: 'NOT_EDITABLE' }
  if (report.regulated && isSwitched(actor)) {
    return { ok: false, reason: 'SWITCHED_REGULATED' }
  }
  if (!report.regulated) return { ok: true }

  const holder = licenceStatus(people.holder.licence, now)
  if (holder === 'missing')
    return { ok: false, reason: 'HOLDER_LICENCE_MISSING' }
  if (holder === 'expired')
    return { ok: false, reason: 'HOLDER_LICENCE_EXPIRED' }

  if (people.technician && people.technician._id !== people.holder._id) {
    const tech = licenceStatus(people.technician.licence, now)
    if (tech === 'missing') {
      return { ok: false, reason: 'TECHNICIAN_LICENCE_MISSING' }
    }
    if (tech === 'expired') {
      return { ok: false, reason: 'TECHNICIAN_LICENCE_EXPIRED' }
    }
  }
  return { ok: true }
}

/**
 * Two people on one draft.
 *
 * `reports.data` is replaced wholesale on every autosave, so the holder filling
 * section 3 while a helper fills section 5 would have one of them silently
 * overwrite the other. Switching makes that an everyday workflow rather than a
 * freak event.
 *
 * Merging per key rather than refusing outright is what keeps a technician
 * under a house from losing a filled form: their answers are for different
 * fields, so both survive. Only a genuine clash — the same field changed on
 * both sides since the client last loaded — is refused, and then the caller
 * can show the two values for that one field.
 */
export type DraftMerge =
  | { ok: true; data: Record<string, unknown>; conflicts: [] }
  | { ok: false; conflicts: ReadonlyArray<string> }

export function mergeDraft(
  base: Record<string, unknown>,
  server: Record<string, unknown>,
  incoming: Record<string, unknown>,
): DraftMerge {
  const conflicts: Array<string> = []
  const merged: Record<string, unknown> = { ...server }

  for (const key of Object.keys(incoming)) {
    const changedHere = !sameValue(incoming[key], base[key])
    if (!changedHere) continue
    const changedThere = !sameValue(server[key], base[key])
    if (changedThere && !sameValue(server[key], incoming[key])) {
      conflicts.push(key)
      continue
    }
    merged[key] = incoming[key]
  }

  // A key the client deliberately cleared is an edit like any other.
  for (const key of Object.keys(base)) {
    if (key in incoming) continue
    if (!sameValue(server[key], base[key])) continue
    delete merged[key]
  }

  return conflicts.length > 0
    ? { ok: false, conflicts }
    : { ok: true, data: merged, conflicts: [] }
}

/** Structural equality, good enough for form answers (JSON-shaped values). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return JSON.stringify(a) === JSON.stringify(b)
}
