/// <reference types="vite/client" />
import { beforeAll, describe, expect, test } from 'vitest'
import { api, components, internal } from '../_generated/api'
import { DEFAULT_GRANTS, NO_GRANTS, recomputeGrants } from '../lib/capabilities'
import { MEMBER_COLOURS } from '../lib/colours'
import { addDaysToKey, dayKeyOf } from '../lib/dates'
import {
  INVITE_TTL_MS,
  hashInviteToken,
  inviteState,
  newInviteToken,
} from '../lib/inviteTokens'
import { factsFromMembership } from '../lib/membershipFacts'
import { createActor } from '../../test/harness'
import { demoImages, demoSource, runDemoSteps } from '../../test/demoFixture'
import {
  DEMO_BUSINESS_NAME,
  DEMO_PLAN,
  PLACEHOLDER_EMAIL_DOMAIN,
} from './shared'
import type { DemoRun } from '../../test/demoFixture'
import type { TestActor, TestApp } from '../../test/harness'
import type { Doc, Id } from '../_generated/dataModel'
import type { MemberKey } from './shared'

/**
 * The demo's first step: the business, its five people and their invitations.
 *
 * What matters is that the app cannot tell these rows from ones it wrote
 * itself — the Team screen, the pickers, switching and the landing page all
 * read them — so most of this runs the app's own queries over the result, and
 * the last block builds the same team through the app's public mutations and
 * compares the two row for row.
 */

const DAY = 24 * 60 * 60 * 1000
const SLUG = 'demo-swan-river-pest-co-sample-data'
const KEYS: Array<MemberKey> = ['owner', 'former', 'contractor', 'sub', 'dana']

function freshHashes() {
  return Promise.all(
    Array.from({ length: 8 }, () => hashInviteToken(newInviteToken())),
  )
}

async function rowsOf(t: TestApp, businessId: Id<'businesses'>) {
  return t.run(async (ctx) => ({
    business: await ctx.db.get(businessId),
    members: await ctx.db
      .query('memberships')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect(),
    invitations: await ctx.db
      .query('invitations')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect(),
    audit: await ctx.db
      .query('auditLog')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect(),
  }))
}

type Rows = Awaited<ReturnType<typeof rowsOf>>

function memberOf(rows: Rows, id: Id<'memberships'>): Doc<'memberships'> {
  const row = rows.members.find((m) => m._id === id)
  if (!row) throw new Error(`no membership ${id}`)
  return row
}

async function userById(t: TestApp, userId: string) {
  return t.run(
    async (ctx): Promise<{ _id: string; email: string; name: string } | null> =>
      ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: 'user',
        where: [{ field: '_id', value: userId }],
      }),
  )
}

async function credentialOf(
  t: TestApp,
  model: 'account' | 'session',
  userId: string,
) {
  return t.run(async (ctx): Promise<unknown> =>
    ctx.runQuery(components.betterAuth.adapter.findOne, {
      model,
      where: [{ field: 'userId', value: userId }],
    }),
  )
}

describe('the demo team', () => {
  let run: DemoRun
  let rows: Rows
  let now: number
  beforeAll(async () => {
    run = await runDemoSteps('team')
    rows = await rowsOf(run.t, run.base.businessId)
    now = Date.now()
  })
  const member = (key: MemberKey) => memberOf(rows, run.base.members[key])
  const dayOf = (ts: number) => dayKeyOf(ts, run.base.timezone)
  const daysAgo = (n: number) => addDaysToKey(run.base.todayKey, -n)

  test('the business is what businesses.create and Settings leave', async () => {
    const { business } = rows
    expect(business).toMatchObject({
      name: DEMO_BUSINESS_NAME,
      slug: SLUG,
      state: 'WA',
      timezone: 'Australia/Perth',
      abn: '51 824 753 556',
      subscriptionStatus: 'trialing',
      plan: DEMO_PLAN,
      addressLine: '15 Guildford Road',
      suburb: 'Maylands',
      postcode: '6051',
      phone: '(08) 5550 4400',
      email: 'office@example.com',
      licenceNumber: 'PMT-4471',
      logoStorageId: run.base.images.logo,
      tradingName: 'Swan River Pest Co',
      reportCopyEmail: 'reports@example.com',
    })
    // Policies left at their defaults, and no counters: businesses.create
    // sets neither, and the later steps own them.
    for (const unset of [
      'requireReportToComplete',
      'allowTechnicianRecipients',
      'reportBrandName',
      'website',
      'nextJobNumber',
      'nextReportNumber',
      'stripeCustomerId',
    ]) {
      expect(business).not.toHaveProperty(unset)
    }
    expect(dayOf(business!.createdAt)).toBe(daysAgo(180))
    // Today in Perth when it ran — or yesterday, if the test has since
    // crossed Perth midnight (CI runs at any hour).
    expect([run.base.todayKey, addDaysToKey(run.base.todayKey, 1)]).toContain(
      dayOf(now),
    )

    // One row per update the Settings screens make. The field names arrive
    // sorted, as a real call's arguments do.
    const updates = rows.audit
      .filter((row) => row.action === 'business.update')
      .sort((a, b) => a.at - b.at)
    expect(updates.map((row) => row.meta)).toEqual([
      {
        fields: [
          'addressLine',
          'email',
          'licenceNumber',
          'phone',
          'postcode',
          'suburb',
        ],
      },
      { fields: ['logoStorageId'] },
      { fields: ['reportCopyEmail', 'tradingName'] },
    ])
    for (const row of updates) {
      expect(row.actorMembershipId).toBe(run.base.members.owner)
      expect(row.entityId).toBe(run.base.businessId)
    }

    // The shell's own read: the logo resolves, the owner is the owner.
    const shell = await run.owner.as.query(api.businesses.getBySlug, {
      slug: SLUG,
    })
    expect(shell?.logoUrl).toBeTruthy()
    expect(shell?.membership.role).toBe('owner')
    expect(shell?.membership.licenceNumber).toBe('TECH-7102')
  })

  test('people are in joining order, with the colours the app deals', () => {
    const byCreation = [...rows.members].sort(
      (a, b) => a._creationTime - b._creationTime,
    )
    expect(byCreation.map((m) => m._id)).toEqual(
      KEYS.map((key) => run.base.members[key]),
    )
    const joined = byCreation.map((m) => m.createdAt)
    expect(joined).toEqual([...joined].sort((a, b) => a - b))
    expect(byCreation.map((m) => dayOf(m.createdAt))).toEqual(
      [180, 170, 150, 120, 60].map(daysAgo),
    )

    expect(member('owner').colour).toBe('#0A84FF')
    expect(member('contractor').colour).toBe('#DC2626')
    expect(member('sub').colour).toBe(MEMBER_COLOURS[2]) // teal
    expect(member('dana').colour).toBe(MEMBER_COLOURS[3]) // pink
    // Dealt when they joined, before anyone else; kept after leaving.
    expect(member('former').colour).toBe(MEMBER_COLOURS[1])

    expect(member('owner').userId).toBe(run.owner.userId)
    expect(member('contractor').userId).toBe(run.contractor.userId)
    expect(member('sub').userId).toBe(run.sub.userId)

    expect(member('owner').role).toBe('owner')
    expect(member('contractor').role).toBe('contractor')
    for (const key of ['sub', 'dana', 'former'] as const) {
      expect(member(key).role).toBe('subcontractor')
    }

    // Redeeming freezes the joiner's name; businesses.create does not.
    expect(member('owner')).not.toHaveProperty('displayName')
    expect(member('contractor').displayName).toBe('Kevin')
    expect(member('sub').displayName).toBe('Priya')
    expect(member('dana').displayName).toBe('Dana Brooks')
    expect(member('former').displayName).toBe('Riley Cooper')
  })

  test('grants hold the invariants every reader relies on', () => {
    for (const m of rows.members) {
      // Absent `grants` takes the legacy fallback, which no app path writes.
      expect(m.grants).toBeDefined()
      expect(m.canViewAllJobs).toBe(m.grants?.otherSchedules)
      // Optional fields are omitted, never null (the schema has no v.null()).
      expect(Object.values(m)).not.toContain(null)
    }

    expect(member('owner').grants).toEqual(DEFAULT_GRANTS.owner)
    // What redeem-then-setRole leaves: nothing, not DEFAULT_GRANTS.contractor.
    expect(member('contractor').grants).toEqual(NO_GRANTS)
    expect(member('contractor')).not.toHaveProperty('parentMembershipId')

    const sub = member('sub')
    const contractor = member('contractor')
    expect(sub.parentMembershipId).toBe(contractor._id)
    expect(sub.grants).toEqual({ ...NO_GRANTS, switchInto: contractor._id })
    // Stable under the rule assignTo and setRole re-derive with.
    expect(
      recomputeGrants(
        factsFromMembership(sub),
        factsFromMembership(contractor),
      ),
    ).toEqual(sub.grants)

    const dana = member('dana')
    expect(dana).not.toHaveProperty('parentMembershipId')
    expect(dana.grants).toEqual({ ...NO_GRANTS, otherSchedules: true })

    expect(member('owner').licenceNumber).toBe('TECH-7102')
    expect(contractor.licenceNumber).toBe('TECH-8821')
    expect(contractor.phone).toBe('0491 578 957')
    expect(dana.licenceNumber).toBe('TECH-9034')
    // So the subcontractor's regulated reports stop at HOLDER_LICENCE_MISSING.
    expect(sub).not.toHaveProperty('licenceNumber')
  })

  test('switching goes where the grants say, in the app', async () => {
    const { businessId, members } = run.base
    const targets = async (who: TestActor) =>
      (await who.as.query(api.accountSwitches.targets, { businessId }))
        .map((row) => row.membershipId)
        .sort()

    expect(await targets(run.owner)).toEqual(
      [members.contractor, members.sub, members.dana].sort(),
    )
    expect(await targets(run.contractor)).toEqual([members.sub])
    // Upward, on the grant the contractor gave.
    expect(await targets(run.sub)).toEqual([members.contractor])
  })

  test('the former technician is removed, and off every team list', async () => {
    const former = member('former')
    expect(former).toMatchObject({
      status: 'removed',
      removedByMembershipId: run.base.members.owner,
      canViewAllJobs: false,
      canViewOtherAccounts: false,
      grants: NO_GRANTS,
    })
    expect(former).not.toHaveProperty('viewingAsMembershipId')
    expect(dayOf(former.removedAt!)).toBe(daysAgo(30))

    const removal = rows.audit.filter(
      (row) => row.action === 'membership.remove',
    )
    expect(removal).toHaveLength(1)
    expect(removal[0]).toMatchObject({
      actorMembershipId: run.base.members.owner,
      entityType: 'memberships',
      entityId: former._id,
      at: former.removedAt,
    })
    expect(removal[0].meta).toEqual({
      reassignedJobs: 0,
      reassignedRecurrences: 0,
      transferredDrafts: 0,
      sessionsRevoked: true,
    })

    const { businessId } = run.base
    const active = KEYS.filter((key) => key !== 'former')
      .map((key) => run.base.members[key])
      .sort()
    const roster = await run.owner.as.query(api.memberships.listForBusiness, {
      businessId,
    })
    expect(roster.map((row) => row._id).sort()).toEqual(active)
    expect(roster.find((row) => row._id === run.base.members.dana)?.name).toBe(
      'Dana Brooks',
    )
    const team = await run.owner.as.query(api.team.roster, { businessId })
    expect(team.map((row) => row._id).sort()).toEqual(active)
  })

  test('invitations: one of each state, the claimed ones matching who joined', async () => {
    const states = rows.invitations
      .map((row) => `${row.email} ${inviteState(row, now)}`)
      .sort()
    expect(states).toEqual(
      [
        `riley.cooper@${PLACEHOLDER_EMAIL_DOMAIN} claimed`,
        'kevin@coastal.test claimed',
        'priya@coastal.test claimed',
        `dana.brooks@${PLACEHOLDER_EMAIL_DOMAIN} claimed`,
        'old.invite@example.com legacy',
        'late.reply@example.com expired',
        'changed.mind@example.com revoked',
        'casual.helper@example.com valid',
        'new.tech@example.com valid',
      ].sort(),
    )

    for (const row of rows.invitations) {
      expect(row.invitedByMembershipId).toBe(run.base.members.owner)
      expect(row.role).toBe(
        row.email === 'new.tech@example.com' ? 'contractor' : 'subcontractor',
      )
      if (row.tokenHash === undefined) {
        expect(row).not.toHaveProperty('expiresAt')
      } else {
        expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/)
        expect(row.expiresAt).toBe(row.createdAt + INVITE_TTL_MS)
      }
    }
    const hashes = rows.invitations.flatMap((row) =>
      row.tokenHash ? [row.tokenHash] : [],
    )
    expect(new Set(hashes).size).toBe(8)

    // Each claimed row is how its member got in.
    for (const key of ['former', 'contractor', 'sub', 'dana'] as const) {
      const m = member(key)
      const claimed = rows.invitations.filter(
        (row) => row.claimedMembershipId === m._id,
      )
      expect(claimed).toHaveLength(1)
      expect(claimed[0]).toMatchObject({
        claimedByUserId: m.userId,
        claimedAt: m.createdAt,
      })
      const user = await userById(run.t, m.userId)
      expect(claimed[0].email).toBe(user?.email.toLowerCase())
    }

    // The Team screen's pending list, and the labels it would draw.
    const pending = await run.owner.as.query(api.invitations.listForBusiness, {
      businessId: run.base.businessId,
    })
    expect(pending.map((row) => [row.email, row.state])).toEqual([
      ['new.tech@example.com', 'valid'],
      ['casual.helper@example.com', 'valid'],
      ['old.invite@example.com', 'legacy'],
    ])
    const daysLeft = (row: (typeof pending)[number]) =>
      Math.ceil((row.expiresAt! - now) / DAY)
    expect(daysLeft(pending[0])).toBe(3)
    expect(daysLeft(pending[1])).toBe(1)

    // No live invitation for anyone already here (store refuses it).
    const activeEmails = await Promise.all(
      rows.members
        .filter((m) => m.status === 'active')
        .map(async (m) => (await userById(run.t, m.userId))?.email),
    )
    for (const row of pending) expect(activeEmails).not.toContain(row.email)
  })

  test('each invitation has the audit rows its mutations write', () => {
    const auditFor = (id: string, action: string) =>
      rows.audit.filter((row) => row.entityId === id && row.action === action)

    for (const row of rows.invitations) {
      const created = auditFor(row._id, 'invitation.create')
      expect(created).toHaveLength(1)
      expect(created[0]).toMatchObject({
        actorMembershipId: run.base.members.owner,
        entityType: 'invitations',
        at: row.createdAt,
        meta: { email: row.email, role: row.role },
      })
      const redeemed = auditFor(row._id, 'invitation.redeem')
      if (row.claimedMembershipId) {
        expect(redeemed).toHaveLength(1)
        expect(redeemed[0]).toMatchObject({
          actorMembershipId: row.claimedMembershipId,
          at: row.claimedAt,
          meta: { email: row.email, role: 'subcontractor' },
        })
      } else {
        expect(redeemed).toHaveLength(0)
      }
      const revoked = auditFor(row._id, 'invitation.revoke')
      expect(revoked).toHaveLength(row.revokedAt === undefined ? 0 : 1)
      if (row.revokedAt !== undefined) {
        expect(revoked[0]).toMatchObject({
          at: row.revokedAt,
          meta: { email: row.email },
        })
      }
    }
  })

  test('history is in the past, as yourself, and colour-picks are untouched', () => {
    for (const row of rows.audit) {
      expect(row.at).toBeLessThanOrEqual(now)
      expect(row).not.toHaveProperty('onBehalfOfMembershipId')
    }
    // memberColoursV1 skips a business with one of these; the seed deals
    // colours and never picks them.
    expect(rows.audit.map((row) => row.action)).not.toContain(
      'membership.setColour',
    )

    const actions = rows.audit.map((row) => row.action).sort()
    expect(actions).toEqual(
      [
        ...Array<string>(3).fill('business.update'),
        ...Array<string>(9).fill('invitation.create'),
        ...Array<string>(4).fill('invitation.redeem'),
        'invitation.revoke',
        ...Array<string>(3).fill('membership.setLicence'),
        'membership.setRole',
        'membership.assignTo',
        ...Array<string>(2).fill('membership.setGrants'),
        'membership.remove',
        'demo.seed',
      ].sort(),
    )
  })

  test('the placeholder people have a name and no way to sign in', async () => {
    for (const key of ['former', 'dana'] as const) {
      const user = await userById(run.t, member(key).userId)
      expect(user?.email.endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`)).toBe(true)
      expect(await credentialOf(run.t, 'account', user!._id)).toBeNull()
      expect(await credentialOf(run.t, 'session', user!._id)).toBeNull()
    }
    // The real people were not signed out of anything.
    for (const person of [run.owner, run.contractor, run.sub]) {
      expect(await credentialOf(run.t, 'session', person.userId)).not.toBeNull()
    }
  })

  test('nobody lands somewhere new', async () => {
    for (const person of [run.owner, run.contractor, run.sub]) {
      const mine = await person.as.query(api.businesses.listForUser, {})
      expect(mine.map((row) => row.businessId)).toEqual([
        run.fromBusinessId,
        run.base.businessId,
      ])
    }
  })

  test('demo.seed names every stored file, for cleanup', () => {
    const marker = rows.audit.filter((row) => row.action === 'demo.seed')
    expect(marker).toHaveLength(1)
    expect(marker[0]).toMatchObject({
      actorMembershipId: run.base.members.owner,
      entityType: 'businesses',
      entityId: run.base.businessId,
    })
    const { images } = run.base
    const stored = [
      images.logo,
      ...Object.values(images.signatures),
      ...images.photos.map((photo) => photo.storageId),
    ]
    const listed = (marker[0].meta as { images: Array<string> }).images
    expect([...listed].sort()).toEqual([...stored].sort())
    expect(new Set(listed).size).toBe(listed.length)
  })
})

describe('running it again', () => {
  test('a second demo gets the -2 slug and shares the placeholder people', async () => {
    const source = await demoSource()
    const images = await demoImages(source.t)
    const hashes = await freshHashes()
    const args = { fromBusinessId: source.fromBusinessId, images }

    const first = await source.t.mutation(internal.demo.team.seed, {
      ...args,
      inviteTokenHashes: hashes,
    })
    // The same links twice would make by_token_hash's .unique() throw.
    await expect(
      source.t.mutation(internal.demo.team.seed, {
        ...args,
        inviteTokenHashes: hashes,
      }),
    ).rejects.toThrow(/DEMO_INVITE_HASHES/)
    await expect(
      source.t.mutation(internal.demo.team.seed, {
        ...args,
        inviteTokenHashes: hashes.slice(0, 7),
      }),
    ).rejects.toThrow(/DEMO_INVITE_HASHES/)

    const second = await source.t.mutation(internal.demo.team.seed, {
      ...args,
      inviteTokenHashes: await freshHashes(),
    })
    const slugs = await source.t.run(async (ctx) => [
      (await ctx.db.get(first.businessId))?.slug,
      (await ctx.db.get(second.businessId))?.slug,
    ])
    expect(slugs).toEqual([SLUG, `${SLUG}-2`])

    const userIds = (base: typeof first) =>
      source.t.run(async (ctx) =>
        Promise.all(
          [base.members.former, base.members.dana].map(
            async (id) => (await ctx.db.get(id))?.userId,
          ),
        ),
      )
    expect(await userIds(second)).toEqual(await userIds(first))

    // Both demos after the real business, in the order they were made.
    const mine = await source.owner.as.query(api.businesses.listForUser, {})
    expect(mine.map((row) => row.businessId)).toEqual([
      source.fromBusinessId,
      first.businessId,
      second.businessId,
    ])
  })

  test('a placeholder someone has signed up as is not reused', async () => {
    const source = await demoSource()
    await createActor(source.t, {
      email: `dana.brooks@${PLACEHOLDER_EMAIL_DOMAIN}`,
      name: 'Not Dana',
    })
    await expect(
      source.t.mutation(internal.demo.team.seed, {
        fromBusinessId: source.fromBusinessId,
        images: await demoImages(source.t),
        inviteTokenHashes: await freshHashes(),
      }),
    ).rejects.toThrow(/DEMO_PLACEHOLDER_TAKEN/)
  })
})

describe('the source business', () => {
  async function seedFrom(source: Awaited<ReturnType<typeof demoSource>>) {
    return source.t.mutation(internal.demo.team.seed, {
      fromBusinessId: source.fromBusinessId,
      images: await demoImages(source.t),
      inviteTokenHashes: await freshHashes(),
    })
  }

  test('with a second active contractor, nothing is guessed', async () => {
    const source = await demoSource()
    const extra = await createActor(source.t, { email: 'second@coastal.test' })
    await source.t.run(async (ctx) => {
      await ctx.db.insert('memberships', {
        userId: extra.userId,
        businessId: source.fromBusinessId,
        role: 'contractor',
        canViewAllJobs: false,
        grants: NO_GRANTS,
        colour: MEMBER_COLOURS[3],
        status: 'active',
        createdAt: Date.now(),
      })
    })
    await expect(seedFrom(source)).rejects.toThrow(/DEMO_SOURCE_TEAM/)
  })

  test('with its subcontractor gone, it is refused', async () => {
    const source = await demoSource()
    await source.t.run(async (ctx) => {
      const row = await ctx.db
        .query('memberships')
        .withIndex('by_user_business', (q) =>
          q
            .eq('userId', source.sub.userId)
            .eq('businessId', source.fromBusinessId),
        )
        .unique()
      await ctx.db.patch(row!._id, { status: 'removed' })
    })
    await expect(seedFrom(source)).rejects.toThrow(/DEMO_SOURCE_TEAM/)
  })

  test('a demo cannot be the source of another', async () => {
    const source = await demoSource()
    const base = await seedFrom(source)
    await expect(
      source.t.mutation(internal.demo.team.seed, {
        fromBusinessId: base.businessId,
        images: base.images,
        inviteTokenHashes: await freshHashes(),
      }),
    ).rejects.toThrow(/DEMO_SOURCE_TEAM/)
  })
})

// ──────────────────────────────────────── against the app's own mutations

const FREE_KEYS = new Set([
  'name',
  'slug',
  'abn',
  'addressLine',
  'suburb',
  'postcode',
  'phone',
  'email',
  'licenceNumber',
  'tradingName',
  'reportCopyEmail',
  'displayName',
  'userId',
  'businessId',
  'logoStorageId',
  'claimedByUserId',
  'tokenHash',
  'createdAt',
  'removedAt',
  'claimedAt',
  'revokedAt',
  'expiresAt',
  'at',
  'from',
  'to',
])

/** The same five people, made through the public API by signed-in users. */
async function appMadeTeam(t: TestApp, logo: Id<'_storage'>) {
  const actor = (name: string) =>
    createActor(t, { email: `${name}@reference.test`, name })
  const owner = await actor('owner')
  const leaver = await actor('leaver')
  const contractor = await actor('contractor')
  const sub = await actor('sub')
  const whole = await actor('whole')

  const { businessId } = await owner.as.mutation(api.businesses.create, {
    name: 'Reference Pest',
    state: 'WA',
    timezone: 'Australia/Perth',
    abn: '51 824 753 556',
  })
  const idOf = async (person: TestActor) => {
    const row = await t.run(async (ctx) =>
      ctx.db
        .query('memberships')
        .withIndex('by_user_business', (q) =>
          q.eq('userId', person.userId).eq('businessId', businessId),
        )
        .unique(),
    )
    if (!row) throw new Error(`${person.email} is not a member`)
    return row._id
  }
  const join = async (person: TestActor) => {
    const { url } = await owner.as.action(api.invitations.create, {
      businessId,
      email: person.email,
      role: 'subcontractor',
    })
    await person.as.action(api.invitations.redeem, {
      token: url.split('/join/')[1],
    })
    return idOf(person)
  }

  // The owner's Settings, in the order the demo writes them.
  const ownerId = await idOf(owner)
  await owner.as.mutation(api.businesses.update, {
    businessId,
    addressLine: '1 Test Street',
    suburb: 'Maylands',
    postcode: '6051',
    phone: '(08) 5550 0000',
    email: 'office@example.org',
    licenceNumber: 'PMT-1',
  })
  await owner.as.mutation(api.businesses.update, {
    businessId,
    logoStorageId: logo,
  })
  await owner.as.mutation(api.memberships.setLicence, {
    businessId,
    membershipId: ownerId,
    licenceNumber: 'TECH-1',
  })
  await owner.as.mutation(api.businesses.update, {
    businessId,
    tradingName: 'Reference',
    reportCopyEmail: 'copies@example.org',
  })

  const formerId = await join(leaver)
  await owner.as.mutation(api.team.remove, {
    businessId,
    membershipId: formerId,
  })

  const contractorId = await join(contractor)
  await owner.as.mutation(api.memberships.setRole, {
    businessId,
    membershipId: contractorId,
    role: 'contractor',
  })
  await contractor.as.mutation(api.memberships.setProfile, {
    businessId,
    membershipId: contractorId,
    phone: '0491 570 000',
  })
  await contractor.as.mutation(api.memberships.setLicence, {
    businessId,
    membershipId: contractorId,
    licenceNumber: 'TECH-2',
  })

  const subId = await join(sub)
  await owner.as.mutation(api.team.assignTo, {
    businessId,
    membershipId: subId,
    parentMembershipId: contractorId,
  })
  await contractor.as.mutation(api.memberships.setGrants, {
    businessId,
    membershipId: subId,
    grants: { ...NO_GRANTS, switchInto: contractorId },
  })

  const danaId = await join(whole)
  await owner.as.mutation(api.memberships.setGrants, {
    businessId,
    membershipId: danaId,
    grants: { ...NO_GRANTS, otherSchedules: true },
  })
  await owner.as.mutation(api.memberships.setLicence, {
    businessId,
    membershipId: danaId,
    licenceNumber: 'TECH-3',
  })

  await owner.as.action(api.invitations.create, {
    businessId,
    email: 'pending@example.org',
    role: 'contractor',
  })
  const { invitationId } = await owner.as.action(api.invitations.create, {
    businessId,
    email: 'withdrawn@example.org',
    role: 'subcontractor',
  })
  await owner.as.mutation(api.invitations.revoke, { businessId, invitationId })

  const ids: Record<MemberKey, Id<'memberships'>> = {
    owner: ownerId,
    former: formerId,
    contractor: contractorId,
    sub: subId,
    dana: danaId,
  }
  return { businessId, ids }
}

describe('against the same team made through the app', () => {
  let demo: Rows
  let app: Rows
  let demoWho: Map<string, string>
  let appWho: Map<string, string>
  beforeAll(async () => {
    const run = await runDemoSteps('team')
    const ref = await appMadeTeam(run.t, run.base.images.logo)
    demo = await rowsOf(run.t, run.base.businessId)
    app = await rowsOf(run.t, ref.businessId)
    demoWho = new Map(KEYS.map((key) => [run.base.members[key], key]))
    appWho = new Map(KEYS.map((key) => [ref.ids[key], key]))
  })

  /** A row with its ids and times replaced by what they stand for. */
  function shape(value: unknown, who: Map<string, string>, key = ''): unknown {
    if (typeof value === 'string' && who.has(value)) return who.get(value)
    if (Array.isArray(value)) return value.map((item) => shape(item, who))
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([k]) => k !== '_id' && k !== '_creationTime')
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, shape(v, who, k)]),
      )
    }
    // Names, contact details, times and foreign ids only have to be present
    // and of the same kind; everything else must be equal.
    return FREE_KEYS.has(key) ? typeof value : value
  }

  test('the business has the same fields, plus the cleanup marker', () => {
    const business = shape(demo.business, demoWho) as Record<string, unknown>
    expect(business.plan).toBe(DEMO_PLAN)
    delete business.plan
    expect(business).toEqual(shape(app.business, appWho))
  })

  test('each person is the same row the app would have written', () => {
    for (const key of KEYS) {
      const find = (rows: Rows, who: Map<string, string>) =>
        shape(
          rows.members.find((m) => who.get(m._id) === key),
          who,
        )
      expect(find(demo, demoWho), key).toEqual(find(app, appWho))
    }
  })

  test('invitations in each state have the same fields', () => {
    const byState = (rows: Rows, who: Map<string, string>) => {
      const out = new Map<string, unknown>()
      for (const row of rows.invitations) {
        out.set(inviteState(row, row.createdAt + 1), shape(row, who))
      }
      return out
    }
    const demoStates = byState(demo, demoWho)
    const appStates = byState(app, appWho)
    for (const [state, row] of appStates) {
      expect(demoStates.get(state), state).toEqual(row)
    }
  })

  test('the audit trail says the same things in the same words', () => {
    const lines = (rows: Rows, who: Map<string, string>) =>
      new Set(
        rows.audit
          .filter((row) => row.action !== 'demo.seed')
          .map((row) =>
            JSON.stringify(
              shape(
                {
                  action: row.action,
                  entityType: row.entityType,
                  actor: row.actorMembershipId,
                  target: row.entityType === 'memberships' ? row.entityId : '',
                  onBehalf: row.onBehalfOfMembershipId ?? null,
                  meta: row.meta as unknown,
                },
                who,
              ),
            ),
          ),
      )
    expect(lines(demo, demoWho)).toEqual(lines(app, appWho))
  })
})
