import { ConvexError, v } from 'convex/values'
import { components } from '../_generated/api'
import { internalMutation } from '../_generated/server'
import { authComponent } from '../auth'
import { writeEnvelopeForMember } from '../lib/actor'
import { forSelf, recordAudit } from '../lib/audit'
import {
  DEFAULT_GRANTS,
  NO_GRANTS,
  canManageMember,
  clampGrants,
  recomputeGrants,
} from '../lib/capabilities'
import { MEMBER_COLOURS, nextColour } from '../lib/colours'
import { todayKeyInZone } from '../lib/dates'
import { INVITE_TTL_MS } from '../lib/inviteTokens'
import { factsFromMembership } from '../lib/membershipFacts'
import {
  DEMO_BUSINESS_NAME,
  DEMO_PLAN,
  DEMO_STATE,
  DEMO_TIMEZONE,
  PLACEHOLDER_EMAIL_DOMAIN,
  at,
  demoBaseV,
  demoImagesV,
} from './shared'
import type { Infer } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import type { Grants, Role } from '../lib/capabilities'
import type { DemoBase } from './shared'

/**
 * The demo business and its people, written the way the app writes them: the
 * business as businesses.create makes it and the owner's Settings fill it in,
 * each person joining through an invitation redeemed as redeemByHash redeems
 * one, and every later change (role, team, toggles, licence, a departure) as
 * the mutation behind that screen leaves it, audit rows included.
 *
 * Nobody here is signed in, so each write is stamped as the member the record
 * says made it, and dated when they would have made it: the business opened
 * about six months ago and the team grew from there. Only `_creationTime`
 * says otherwise, which nothing can backdate.
 *
 * The three real people keep their own logins; the demo only adds a
 * membership for each, after all of theirs, so nobody's landing page moves
 * (businesses.listForUser keeps joining order and `/` opens the first).
 */

const HOUR = 60 * 60 * 1000

/** One per invitation that ever had a link: four claimed (everyone who
 * joined), four still pending or dead. The legacy row has none. */
const HASHES_NEEDED = 8

type Images = Infer<typeof demoImagesV>

type Person = { userId: string; name: string; email: string }

/** A day and a time of day in the demo's zone; see `at` in shared.ts. */
type When = (dayOffset: number, hh: number, mm?: number) => number

export const seed = internalMutation({
  args: {
    /** The business whose owner, contractor and subcontractor join the demo
     * with the same roles (Pest M8 on prod). */
    fromBusinessId: v.id('businesses'),
    images: demoImagesV,
    /** SHA-256 hex hashes of throwaway invite tokens, minted in the action
     * (mutation randomness is seeded). One per invitation that had a link,
     * the four claimed ones included: eight. */
    inviteTokenHashes: v.array(v.string()),
  },
  returns: demoBaseV,
  handler: async (
    ctx,
    { fromBusinessId, images, inviteTokenHashes },
  ): Promise<DemoBase> => {
    const source = await sourceTeam(ctx, fromBusinessId)
    const nextHash = await hashDealer(ctx, inviteTokenHashes)

    const timezone = DEMO_TIMEZONE
    // Read once, here: every later step dates from this, so a seed that runs
    // across midnight still agrees with itself about which day is today.
    const todayKey = todayKeyInZone(timezone)
    const when: When = (dayOffset, hh, mm = 0) =>
      at({ todayKey, timezone }, dayOffset, hh, mm)
    const now = Date.now()

    // ── The business, and its owner (businesses.create) ─────────────────
    const openedAt = when(-180, 8, 12)
    const businessId = await ctx.db.insert('businesses', {
      name: DEMO_BUSINESS_NAME,
      slug: await uniqueSlug(ctx, DEMO_BUSINESS_NAME),
      state: DEMO_STATE,
      timezone,
      abn: '51 824 753 556',
      subscriptionStatus: 'trialing',
      // Nothing in the app reads `plan`. It is what demo/cleanup checks
      // before deleting anything, so it goes on with the first write.
      plan: DEMO_PLAN,
      createdAt: openedAt,
    })
    const owner = await ctx.db.insert('memberships', {
      userId: source.owner.userId,
      businessId,
      role: 'owner',
      canViewAllJobs: true,
      grants: DEFAULT_GRANTS.owner,
      colour: MEMBER_COLOURS[0],
      status: 'active',
      createdAt: openedAt,
    })

    // Settings, the same morning: Branding saves its six fields together,
    // the logo is its own call, and the two report-only fields have no
    // screen at all (API only), so each is its own update and audit row.
    await updateBusiness(
      ctx,
      businessId,
      owner,
      {
        addressLine: '15 Guildford Road',
        suburb: 'Maylands',
        postcode: '6051',
        phone: '(08) 5550 4400',
        email: 'office@example.com',
        licenceNumber: 'PMT-4471',
      },
      when(-180, 8, 31),
    )
    await updateBusiness(
      ctx,
      businessId,
      owner,
      { logoStorageId: images.logo },
      when(-180, 8, 33),
    )
    await setLicence(ctx, owner, owner, 'TECH-7102', when(-180, 8, 36))
    await updateBusiness(
      ctx,
      businessId,
      owner,
      {
        tradingName: 'Swan River Pest Co',
        reportCopyEmail: 'reports@example.com',
      },
      when(-179, 19, 5),
    )

    // A link sent before links existed: no token, no expiry. The Team screen
    // shows it as "Old invitation — create a new link".
    await invite(ctx, businessId, owner, {
      email: 'old.invite@example.com',
      role: 'subcontractor',
      createdAt: when(-176, 10, 15),
    })

    // ── Riley: joined, worked, left 30 days ago ─────────────────────────
    // Written whole, departure included, before anyone else joins. Colours
    // are dealt over the people still on the team, so everyone after is
    // dealt what they hold today — the contractor red, the subcontractor
    // teal, Dana pink: the joining-order deal of the four who remain, which
    // is also what memberColoursV1 gives an older business. Riley keeps the
    // red they were dealt on joining, so their old jobs share a colour with
    // the contractor's, as a departed member's can.
    const riley = await placeholderUser(ctx, {
      name: 'Riley Cooper',
      email: `riley.cooper@${PLACEHOLDER_EMAIL_DOMAIN}`,
      signedUpAt: when(-170, 7, 2),
    })
    const former = await join(ctx, businessId, owner, riley, {
      invitedAt: when(-171, 16, 20),
      joinedAt: when(-170, 7, 3),
      tokenHash: nextHash(),
    })
    await remove(ctx, businessId, owner, former, when(-30, 17, 15))

    // ── The contractor ──────────────────────────────────────────────────
    // Invited the only way the Team screen can (as a subcontractor), then
    // promoted from their row. Their licence and phone are their own to set,
    // from Settings → Your details.
    const contractor = await join(ctx, businessId, owner, source.contractor, {
      invitedAt: when(-151, 18, 45),
      joinedAt: when(-150, 7, 40),
      tokenHash: nextHash(),
    })
    await setRoleContractor(ctx, owner, contractor, when(-150, 8, 5))
    await ctx.db.patch(contractor, { phone: '0491 578 957' }) // setProfile: no audit
    await setLicence(
      ctx,
      contractor,
      contractor,
      'TECH-8821',
      when(-150, 8, 21),
    )

    // ── The subcontractor, on the contractor's team ─────────────────────
    // No licence on purpose: a regulated report they finalise is refused
    // with HOLDER_LICENCE_MISSING, and their Team row shows the warning.
    const sub = await join(ctx, businessId, owner, source.subcontractor, {
      invitedAt: when(-121, 17, 30),
      joinedAt: when(-120, 6, 50),
      tokenHash: nextHash(),
    })
    // Only what a screen can set: "can work in my account" (grants.switchInto)
    // has no toggle anywhere, so the demo leaves it off rather than show a
    // state the app cannot produce.
    await assignTo(ctx, owner, sub, contractor, when(-120, 9, 15))

    // ── Dana: directly under the owner, sees the whole schedule ─────────
    const danaUser = await placeholderUser(ctx, {
      name: 'Dana Brooks',
      email: `dana.brooks@${PLACEHOLDER_EMAIL_DOMAIN}`,
      signedUpAt: when(-60, 7, 24),
    })
    const dana = await join(ctx, businessId, owner, danaUser, {
      invitedAt: when(-61, 15, 10),
      joinedAt: when(-60, 7, 25),
      tokenHash: nextHash(),
    })
    const danaGrants = await setGrants(
      ctx,
      owner,
      dana,
      { otherSchedules: true },
      when(-60, 12, 0),
    )
    if (!danaGrants.otherSchedules) {
      throw new Error(
        'demo: the whole-schedule grant did not survive clampGrants',
      )
    }
    await setLicence(ctx, owner, dana, 'TECH-9034', when(-60, 12, 2))

    // ── Invitations that never became anyone ────────────────────────────
    // Dead ones first: they are only in the audit trail and the table.
    await invite(ctx, businessId, owner, {
      email: 'late.reply@example.com',
      role: 'subcontractor',
      createdAt: when(-10, 11, 20),
      tokenHash: nextHash(),
    })
    const withdrawn = await invite(ctx, businessId, owner, {
      email: 'changed.mind@example.com',
      role: 'subcontractor',
      createdAt: when(-5, 9, 10),
      tokenHash: nextHash(),
    })
    await revokeInvitation(ctx, businessId, owner, withdrawn, when(-4, 8, 30))
    // The live two are timed from the moment of seeding, not a clock time:
    // what they show depends on hours left, and a day-anchored time could
    // land in the future. 70 hours old leaves two hours, which the Team
    // screen rounds up to "Expires in 1 day". The contractor one is an
    // API-only role; its join page would still say "Subcontractor".
    await invite(ctx, businessId, owner, {
      email: 'casual.helper@example.com',
      role: 'subcontractor',
      createdAt: now - 70 * HOUR,
      tokenHash: nextHash(),
    })
    await invite(ctx, businessId, owner, {
      email: 'new.tech@example.com',
      role: 'contractor',
      createdAt: now - 1 * HOUR,
      tokenHash: nextHash(),
    })

    // Not something the app writes. demo/cleanup deletes exactly the files
    // listed here, so it never has to work out which stored files are the
    // demo's by following references — a reference it missed would leave a
    // file behind, and one it followed wrongly could delete a real one.
    await recordAudit(ctx, forSelf(owner), {
      businessId,
      action: 'demo.seed',
      entityType: 'businesses',
      entityId: businessId,
      meta: { images: storageIdsOf(images) },
      at: now,
    })

    return {
      businessId,
      timezone,
      todayKey,
      members: { owner, contractor, sub, dana, former },
      images,
    }
  },
})

// ─────────────────────────────────────────────────────────────── source

/**
 * The owner, contractor and subcontractor to copy, with their logins.
 *
 * Exactly one of each, or nothing: a guess at which of two contractors was
 * meant would put the wrong person's login inside the demo.
 */
async function sourceTeam(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
): Promise<Record<Role, Person>> {
  const business = await ctx.db.get(businessId)
  if (!business) {
    throw new ConvexError('DEMO_SOURCE_TEAM: no business with that id')
  }
  if (business.plan === DEMO_PLAN) {
    throw new ConvexError(
      `DEMO_SOURCE_TEAM: ${business.slug} is itself a demo; name the real business`,
    )
  }

  const active = (
    await ctx.db
      .query('memberships')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect()
  ).filter((m) => m.status === 'active')
  const ofRole = (role: Role) => active.filter((m) => m.role === role)
  const [owners, contractors, subs] = [
    ofRole('owner'),
    ofRole('contractor'),
    ofRole('subcontractor'),
  ]
  if (owners.length !== 1 || contractors.length !== 1 || subs.length !== 1) {
    throw new ConvexError(
      `DEMO_SOURCE_TEAM: the demo copies exactly one active owner, contractor ` +
        `and subcontractor; ${business.slug} has ${owners.length}, ` +
        `${contractors.length} and ${subs.length}`,
    )
  }

  // Every membership row is resolved to its login on the Team screen, the
  // pickers and the schedule filter, none of which survive a missing one.
  const person = async (m: Doc<'memberships'>): Promise<Person> => {
    const user = await authComponent.getAnyUserById(ctx, m.userId)
    if (!user) {
      throw new ConvexError(
        `DEMO_SOURCE_TEAM: the ${m.role}'s login (${m.userId}) does not exist`,
      )
    }
    return { userId: user._id, name: user.name, email: user.email }
  }
  const team = {
    owner: await person(owners[0]),
    contractor: await person(contractors[0]),
    subcontractor: await person(subs[0]),
  }
  // Two rows for one person in one business lock them out of it
  // (by_user_business is read with .unique()).
  if (new Set(Object.values(team).map((p) => p.userId)).size !== 3) {
    throw new ConvexError('DEMO_SOURCE_TEAM: one login holds two of the roles')
  }
  return team
}

/**
 * Hands out the action's hashes one at a time. Each must be a SHA-256 the
 * table has never seen: by_token_hash is read with .unique(), so a repeat
 * would break redeeming for both rows, and a real row's hash would tie the
 * demo to someone's live link.
 */
async function hashDealer(ctx: MutationCtx, hashes: Array<string>) {
  if (hashes.length < HASHES_NEEDED) {
    throw new ConvexError(
      `DEMO_INVITE_HASHES: ${HASHES_NEEDED} needed, ${hashes.length} given`,
    )
  }
  if (new Set(hashes).size !== hashes.length) {
    throw new ConvexError('DEMO_INVITE_HASHES: a hash is repeated')
  }
  for (const tokenHash of hashes) {
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) {
      throw new ConvexError('DEMO_INVITE_HASHES: not a SHA-256 hex digest')
    }
    const taken = await ctx.db
      .query('invitations')
      .withIndex('by_token_hash', (q) => q.eq('tokenHash', tokenHash))
      .first()
    if (taken) throw new ConvexError('DEMO_INVITE_HASHES: a hash is in use')
  }
  const left = [...hashes]
  return () => {
    const next = left.shift()
    if (next === undefined) throw new Error('demo: ran out of invite hashes')
    return next
  }
}

// ──────────────────────────────────────────────────── people who cannot sign in

/**
 * A Better Auth user with no account and no session: a name the roster can
 * resolve, and nothing anyone can sign in with.
 *
 * Reused when a demo already made them (a second demo alongside the first):
 * the email is unique in the component. But only while it is still ours. The
 * domain cannot receive mail, yet sign-up never checks that, so a row with an
 * account or a session belongs to whoever signed up as it, and handing them a
 * membership would let a stranger into the demo.
 */
async function placeholderUser(
  ctx: MutationCtx,
  {
    name,
    email,
    signedUpAt,
  }: { name: string; email: string; signedUpAt: number },
): Promise<Person> {
  const existing: { _id: string; name: string; email: string } | null =
    await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'user',
      where: [{ field: 'email', value: email }],
    })
  if (existing) {
    for (const model of ['account', 'session'] as const) {
      const credential: unknown = await ctx.runQuery(
        components.betterAuth.adapter.findOne,
        { model, where: [{ field: 'userId', value: existing._id }] },
      )
      if (credential) {
        throw new ConvexError(
          `DEMO_PLACEHOLDER_TAKEN: ${email} has a ${model}, so someone can sign in as it`,
        )
      }
    }
    return { userId: existing._id, name: existing.name, email: existing.email }
  }

  // As test/harness.ts makes one, minus the session.
  const created: { _id: string } = await ctx.runMutation(
    components.betterAuth.adapter.create,
    {
      input: {
        model: 'user',
        data: {
          name,
          email,
          emailVerified: false,
          createdAt: signedUpAt,
          updatedAt: signedUpAt,
        },
      },
    },
  )
  return { userId: created._id, name, email }
}

// ────────────────────────────────────────────────────────── the app's writes

/** businesses.ts's slugify, which it does not export. */
export function slugOfName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

/** businesses.create's slug: slugify, then -2, -3… until free. */
async function uniqueSlug(ctx: MutationCtx, name: string): Promise<string> {
  const base = slugOfName(name)
  if (!base) throw new ConvexError('INVALID_NAME')

  let slug = base
  let n = 1
  while (
    await ctx.db
      .query('businesses')
      .withIndex('by_slug', (q) => q.eq('slug', slug))
      .unique()
  ) {
    slug = `${base}-${++n}`
  }
  return slug
}

type BusinessFields = Partial<
  Omit<Doc<'businesses'>, '_id' | '_creationTime' | 'slug' | 'createdAt'>
>

/** businesses.update: the defined fields, and one audit row naming them. */
async function updateBusiness(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  owner: Id<'memberships'>,
  patch: BusinessFields,
  now: number,
) {
  // Arguments reach a function through convexToJson, which sorts an object's
  // keys, so the list the app records is alphabetical whatever order the
  // screen sent them in.
  const fields = Object.fromEntries(
    Object.entries(patch as Record<string, unknown>)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )
  if (Object.keys(fields).length === 0) return
  await ctx.db.patch(businessId, fields)
  await recordAudit(ctx, forSelf(owner), {
    businessId,
    action: 'business.update',
    entityType: 'businesses',
    entityId: businessId,
    meta: { fields: Object.keys(fields) },
    at: now,
  })
}

/** invitations.store (or, with no hash, the retired inviteByEmail): the row
 * and its 'invitation.create'. Always the owner: the Team screen's Invite is
 * theirs. */
async function invite(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  owner: Id<'memberships'>,
  {
    email,
    role,
    createdAt,
    tokenHash,
  }: {
    email: string
    role: 'subcontractor' | 'contractor'
    createdAt: number
    tokenHash?: string
  },
): Promise<Id<'invitations'>> {
  const address = email.trim().toLowerCase()
  const invitationId = await ctx.db.insert('invitations', {
    businessId,
    email: address,
    role,
    invitedByMembershipId: owner,
    createdAt,
    ...(tokenHash === undefined
      ? {}
      : { tokenHash, expiresAt: createdAt + INVITE_TTL_MS }),
  })
  await recordAudit(ctx, forSelf(owner), {
    businessId,
    action: 'invitation.create',
    entityType: 'invitations',
    entityId: invitationId,
    meta: { email: address, role },
    at: createdAt,
  })
  return invitationId
}

/** invitations.revoke. */
async function revokeInvitation(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  owner: Id<'memberships'>,
  invitationId: Id<'invitations'>,
  now: number,
) {
  const invitation = await ctx.db.get(invitationId)
  if (!invitation) throw new Error('demo: invitation vanished')
  await ctx.db.patch(invitationId, { revokedAt: now })
  await recordAudit(ctx, forSelf(owner), {
    businessId,
    action: 'invitation.revoke',
    entityType: 'invitations',
    entityId: invitationId,
    meta: { email: invitation.email },
    at: now,
  })
}

/**
 * The owner sends a link and `person` redeems it: invitations.store, then
 * redeemByHash's insert, claim and 'invitation.redeem'. Everyone joins as a
 * subcontractor, because that is the only role the Team screen invites as.
 */
async function join(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  owner: Id<'memberships'>,
  person: Person,
  {
    invitedAt,
    joinedAt,
    tokenHash,
  }: { invitedAt: number; joinedAt: number; tokenHash: string },
): Promise<Id<'memberships'>> {
  if (!(invitedAt < joinedAt && joinedAt < invitedAt + INVITE_TTL_MS)) {
    throw new Error('demo: a link redeemed outside its 72 hours')
  }
  const invitationId = await invite(ctx, businessId, owner, {
    email: person.email,
    role: 'subcontractor',
    createdAt: invitedAt,
    tokenHash,
  })

  const email = person.email.toLowerCase()
  const members = await ctx.db
    .query('memberships')
    .withIndex('by_business', (q) => q.eq('businessId', businessId))
    .collect()
  const displayName = person.name.trim()
  const membershipId = await ctx.db.insert('memberships', {
    userId: person.userId,
    businessId,
    role: 'subcontractor',
    canViewAllJobs: false,
    grants: NO_GRANTS,
    ...(displayName ? { displayName } : {}),
    colour: nextColour(
      members.filter((m) => m.status !== 'removed').map((m) => m.colour),
    ),
    status: 'active',
    createdAt: joinedAt,
  })

  await ctx.db.patch(invitationId, {
    claimedAt: joinedAt,
    claimedByUserId: person.userId,
    claimedMembershipId: membershipId,
  })
  await recordAudit(ctx, forSelf(membershipId), {
    businessId,
    action: 'invitation.redeem',
    entityType: 'invitations',
    entityId: invitationId,
    meta: { email, role: 'subcontractor' },
    at: joinedAt,
  })
  return membershipId
}

async function membership(ctx: MutationCtx, id: Id<'memberships'>) {
  const row = await ctx.db.get(id)
  if (!row) throw new Error('demo: membership vanished')
  return row
}

/** memberships.setLicence: by the owner for anyone, or by the holder. */
async function setLicence(
  ctx: MutationCtx,
  by: Id<'memberships'>,
  target: Id<'memberships'>,
  value: string,
  now: number,
) {
  const row = await membership(ctx, target)
  const licenceNumber = value.trim().slice(0, 64)
  const previous = row.licenceNumber
  await ctx.db.patch(target, { licenceNumber })
  if (previous !== licenceNumber) {
    await recordAudit(ctx, forSelf(by), {
      businessId: row.businessId,
      action: 'membership.setLicence',
      entityType: 'memberships',
      entityId: target,
      meta: { from: previous ?? '', to: licenceNumber },
      at: now,
    })
  }
}

/**
 * memberships.setRole to contractor. The grants are re-derived, not carried
 * across or topped up, so an app-made contractor holds NO_GRANTS: sees their
 * own team's work, and no prices, until the owner turns something on.
 */
async function setRoleContractor(
  ctx: MutationCtx,
  owner: Id<'memberships'>,
  target: Id<'memberships'>,
  now: number,
) {
  const row = await membership(ctx, target)
  const becoming = {
    ...factsFromMembership(row),
    role: 'contractor' as const,
    parentMembershipId: null,
  }
  const roleGrants = recomputeGrants(becoming, null)
  await ctx.db.patch(target, {
    role: 'contractor',
    parentMembershipId: undefined,
    grants: roleGrants,
    canViewAllJobs: roleGrants.otherSchedules,
  })
  await recordAudit(ctx, forSelf(owner), {
    businessId: row.businessId,
    action: 'membership.setRole',
    entityType: 'memberships',
    entityId: target,
    meta: { role: 'contractor' },
    at: now,
  })
}

/** team.assignTo: onto a contractor's team, grants re-derived under them. */
async function assignTo(
  ctx: MutationCtx,
  by: Id<'memberships'>,
  target: Id<'memberships'>,
  parentId: Id<'memberships'>,
  now: number,
) {
  const env = await writeEnvelopeForMember(ctx, by)
  const row = await membership(ctx, target)
  const parent = await membership(ctx, parentId)
  if (
    !canManageMember(env.actor, factsFromMembership(row)) ||
    row.role !== 'subcontractor' ||
    parent.businessId !== row.businessId ||
    parent.status !== 'active' ||
    parent.role !== 'contractor'
  ) {
    throw new Error('demo: team.assignTo would refuse this')
  }

  const moved = { ...factsFromMembership(row), parentMembershipId: parent._id }
  const nextGrants = recomputeGrants(moved, factsFromMembership(parent))
  await ctx.db.patch(target, {
    parentMembershipId: parent._id,
    grants: nextGrants,
    canViewAllJobs: nextGrants.otherSchedules,
  })
  await recordAudit(ctx, forSelf(by), {
    businessId: row.businessId,
    action: 'membership.assignTo',
    entityType: 'memberships',
    entityId: target,
    meta: { parentMembershipId: parent._id, grants: nextGrants },
    at: now,
  })
}

/**
 * memberships.setGrants as the Team row calls it: what is in effect now with
 * the change applied, clamped to what `by` may give. Returns what survived.
 */
async function setGrants(
  ctx: MutationCtx,
  by: Id<'memberships'>,
  target: Id<'memberships'>,
  change: Partial<Grants>,
  now: number,
): Promise<Grants> {
  const env = await writeEnvelopeForMember(ctx, by)
  const row = await membership(ctx, target)
  const facts = factsFromMembership(row)
  if (!canManageMember(env.actor, facts)) {
    throw new Error('demo: setGrants would refuse this')
  }

  const clamped = clampGrants(env.actor, facts, { ...facts.grants, ...change })
  await ctx.db.patch(target, {
    grants: clamped,
    canViewAllJobs: clamped.otherSchedules,
  })
  await recordAudit(ctx, forSelf(by), {
    businessId: row.businessId,
    action: 'membership.setGrants',
    entityType: 'memberships',
    entityId: target,
    meta: { grants: clamped },
    at: now,
  })
  return clamped
}

/**
 * team.remove, as offboard leaves the row and its audit entry.
 *
 * Not offboard itself: it signs a user with no other active membership out
 * of every device, and hands work around. Here there is nothing to hand
 * round (the jobs step has not run), and a placeholder has no session to
 * end — the meta records what offboard would have found at this point.
 */
async function remove(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  owner: Id<'memberships'>,
  target: Id<'memberships'>,
  now: number,
) {
  const row = await membership(ctx, target)
  await ctx.db.patch(target, {
    status: 'removed',
    removedAt: now,
    removedByMembershipId: owner,
    canViewAllJobs: false,
    canViewOtherAccounts: false,
    viewingAsMembershipId: undefined,
    grants: NO_GRANTS,
  })

  const elsewhere = await ctx.db
    .query('memberships')
    .withIndex('by_user', (q) => q.eq('userId', row.userId))
    .collect()
  const stillMemberElsewhere = elsewhere.some(
    (m) => m._id !== target && m.status === 'active',
  )
  await recordAudit(ctx, forSelf(owner), {
    businessId,
    action: 'membership.remove',
    entityType: 'memberships',
    entityId: target,
    // offboard also writes `reassignedTo`, undefined when nothing needed a
    // new owner, which Convex drops from the stored object.
    meta: {
      reassignedJobs: 0,
      reassignedRecurrences: 0,
      transferredDrafts: 0,
      sessionsRevoked: !stillMemberElsewhere,
    },
    at: now,
  })
}

/** Every file the seed stored: what demo/cleanup deletes. */
function storageIdsOf(images: Images): Array<Id<'_storage'>> {
  const { signatures } = images
  return [
    images.logo,
    signatures.owner,
    signatures.contractor,
    signatures.sub,
    signatures.dana,
    signatures.client,
    ...images.photos.map((photo) => photo.storageId),
  ]
}
