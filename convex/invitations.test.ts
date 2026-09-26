/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import { INVITE_TTL_MS, inviteState, maskEmail } from './lib/inviteTokens'
import { createActor, createBusiness, testApp } from '../test/harness'

/**
 * The invitation rules, and specifically the hole they were written to close:
 * a membership used to be created for anyone whose signed-in email matched an
 * invitation, with no proof they controlled that address and no token at all.
 *
 * Every test here is the shape of a real attempt — a forwarded link, a second
 * person opening the same link, a link that sat in a text message too long.
 */

async function ownerWithBusiness(email = 'terence@coastalpest.test') {
  const t = testApp()
  const owner = await createActor(t, { email, name: 'Terence' })
  const { businessId } = await createBusiness(t, owner)
  return { t, owner, businessId }
}

describe('inviteState', () => {
  const now = 1_000_000

  test('a row with no token hash is legacy, never valid', () => {
    // Rows written before token invites existed. There is no link that opens
    // them, so they must not read as live invitations.
    expect(inviteState({ createdAt: now } as never, now)).toBe('legacy')
  })

  test('claimed, revoked and expired each beat valid', () => {
    const base = { tokenHash: 'h', expiresAt: now + 1000 }
    expect(inviteState(base, now)).toBe('valid')
    expect(inviteState({ ...base, claimedAt: now }, now)).toBe('claimed')
    expect(inviteState({ ...base, revokedAt: now }, now)).toBe('revoked')
    expect(inviteState({ ...base, expiresAt: now }, now)).toBe('expired')
    expect(inviteState(null, now)).toBe('invalid')
  })

  test('an old invitation someone joined through, or that was withdrawn, is not legacy', () => {
    // No token hash on either: rows from before token invites.
    expect(inviteState({ claimedAt: now }, now)).toBe('claimed')
    expect(inviteState({ revokedAt: now }, now)).toBe('revoked')
  })
})

describe('the pending list and old invitations', () => {
  /** Rows as the pre-token invite flow left them: no hash, no expiry. */
  async function withOldInvitations() {
    const { t, owner, businessId } = await ownerWithBusiness()
    const ownerId = (await t.run(async (ctx) =>
      ctx.db
        .query('memberships')
        .withIndex('by_user_business', (q) =>
          q.eq('userId', owner.userId).eq('businessId', businessId),
        )
        .unique(),
    ))!._id
    const old = (email: string, extra: { claimedAt?: number } = {}) =>
      t.run(async (ctx) =>
        ctx.db.insert('invitations', {
          businessId,
          email,
          role: 'subcontractor',
          invitedByMembershipId: ownerId,
          createdAt: 1,
          ...extra,
        }),
      )
    return {
      t,
      owner,
      businessId,
      joined: await old('joined@example.test', { claimedAt: 2 }),
      waiting: await old('waiting@example.test'),
    }
  }

  const pending = async (s: Awaited<ReturnType<typeof withOldInvitations>>) =>
    (
      await s.owner.as.query(api.invitations.listForBusiness, {
        businessId: s.businessId,
      })
    ).map((row) => [row.email, row.state])

  test('someone who already joined is not offered a new link', async () => {
    const s = await withOldInvitations()
    // Shown as pending with "New link", which then failed ALREADY_MEMBER.
    expect(await pending(s)).toEqual([['waiting@example.test', 'legacy']])
  })

  test('withdrawing an old invitation takes it off the list', async () => {
    const s = await withOldInvitations()
    await s.owner.as.mutation(api.invitations.revoke, {
      businessId: s.businessId,
      invitationId: s.waiting,
    })
    expect(await pending(s)).toEqual([])
  })

  test('an old invitation nobody used still turns into a working link', async () => {
    const s = await withOldInvitations()
    const { url } = await s.owner.as.action(api.invitations.regenerate, {
      businessId: s.businessId,
      invitationId: s.waiting,
    })
    expect(url).toContain('/join/')
    expect(await pending(s)).toEqual([['waiting@example.test', 'valid']])
  })
})

test('maskEmail shows enough to recognise, not enough to publish', () => {
  expect(maskEmail('kevin@kevinspest.com.au')).toBe('k****@kevinspest.com.au')
  expect(maskEmail('nonsense')).toBe('***')
})

describe('redeeming an invitation', () => {
  test('the invited person joins, and the link cannot be used twice', async () => {
    const { t, owner, businessId } = await ownerWithBusiness()

    const { url } = await owner.as.action(api.invitations.create, {
      businessId,
      email: 'Kevin@KevinsPest.test',
      role: 'subcontractor',
    })
    const token = url.split('/join/')[1]
    expect(token).toBeTruthy()

    const kevin = await createActor(t, { email: 'kevin@kevinspest.test' })
    const result = await kevin.as.action(api.invitations.redeem, { token })
    expect(result.businessId).toBe(businessId)

    const memberships = await t.run(async (ctx) =>
      ctx.db
        .query('memberships')
        .withIndex('by_user_business', (q) =>
          q.eq('userId', kevin.userId).eq('businessId', businessId),
        )
        .collect(),
    )
    expect(memberships).toHaveLength(1)
    expect(memberships[0].role).toBe('subcontractor')
    // A new member sees their own jobs and nothing else until the owner says
    // otherwise.
    expect(memberships[0].canViewAllJobs).toBe(false)

    // Single use: the same link in a group chat does not admit a second person.
    const someoneElse = await createActor(t, {
      email: 'kevin@kevinspest.test2',
    })
    await expect(
      someoneElse.as.action(api.invitations.redeem, { token }),
    ).rejects.toThrow(/INVITE_ALREADY_USED/)
  })

  test('a forwarded link cannot be redeemed by a different address', async () => {
    const { t, owner, businessId } = await ownerWithBusiness()
    const { url } = await owner.as.action(api.invitations.create, {
      businessId,
      email: 'kevin@kevinspest.test',
      role: 'subcontractor',
    })
    const token = url.split('/join/')[1]

    const stranger = await createActor(t, { email: 'stranger@example.test' })
    await expect(
      stranger.as.action(api.invitations.redeem, { token }),
    ).rejects.toThrow(/INVITE_EMAIL_MISMATCH/)

    const count = await t.run(
      async (ctx) => (await ctx.db.query('memberships').collect()).length,
    )
    expect(count).toBe(1) // the owner, and nobody else
  })

  test('an expired link is refused', async () => {
    const { t, owner, businessId } = await ownerWithBusiness()
    const { url, invitationId } = await owner.as.action(
      api.invitations.create,
      { businessId, email: 'kevin@kevinspest.test', role: 'subcontractor' },
    )
    const token = url.split('/join/')[1]

    await t.run(async (ctx) => {
      await ctx.db.patch(invitationId, { expiresAt: Date.now() - 1 })
    })

    const kevin = await createActor(t, { email: 'kevin@kevinspest.test' })
    await expect(
      kevin.as.action(api.invitations.redeem, { token }),
    ).rejects.toThrow(/INVITE_EXPIRED/)
  })

  test('a revoked link is refused', async () => {
    const { t, owner, businessId } = await ownerWithBusiness()
    const { url, invitationId } = await owner.as.action(
      api.invitations.create,
      { businessId, email: 'kevin@kevinspest.test', role: 'subcontractor' },
    )
    const token = url.split('/join/')[1]

    await owner.as.mutation(api.invitations.revoke, {
      businessId,
      invitationId,
    })

    const kevin = await createActor(t, { email: 'kevin@kevinspest.test' })
    await expect(
      kevin.as.action(api.invitations.redeem, { token }),
    ).rejects.toThrow(/INVITE_REVOKED/)
  })

  test('a made-up token is refused', async () => {
    const { t } = await ownerWithBusiness()
    const nobody = await createActor(t, { email: 'nobody@example.test' })
    await expect(
      nobody.as.action(api.invitations.redeem, { token: 'not-a-real-token' }),
    ).rejects.toThrow(/INVITE_INVALID/)
  })

  test('rejoining takes the role from the invitation, not from last time', async () => {
    const { t, owner, businessId } = await ownerWithBusiness()

    // Someone who was here before, with access granted, then removed.
    const kevin = await createActor(t, { email: 'kevin@kevinspest.test' })
    await t.run(async (ctx) => {
      await ctx.db.insert('memberships', {
        userId: kevin.userId,
        businessId,
        role: 'owner',
        canViewAllJobs: true,
        canViewOtherAccounts: true,
        colour: '#34C759',
        status: 'removed',
        createdAt: Date.now(),
      })
    })

    const { url } = await owner.as.action(api.invitations.create, {
      businessId,
      email: 'kevin@kevinspest.test',
      role: 'subcontractor',
    })
    await kevin.as.action(api.invitations.redeem, {
      token: url.split('/join/')[1],
    })

    const membership = await t.run(async (ctx) =>
      ctx.db
        .query('memberships')
        .withIndex('by_user_business', (q) =>
          q.eq('userId', kevin.userId).eq('businessId', businessId),
        )
        .unique(),
    )
    // Coming back must not restore what they used to hold.
    expect(membership?.status).toBe('active')
    expect(membership?.role).toBe('subcontractor')
    expect(membership?.canViewAllJobs).toBe(false)
    expect(membership?.canViewOtherAccounts).toBe(false)
  })
})

describe('creating an invitation', () => {
  test('owner access cannot be invited', async () => {
    const { owner, businessId } = await ownerWithBusiness()
    await expect(
      owner.as.action(api.invitations.create, {
        businessId,
        email: 'someone@example.test',
        role: 'owner',
      }),
    ).rejects.toThrow(/OWNER_INVITE_FORBIDDEN/)
  })

  test('a subcontractor cannot invite anyone', async () => {
    const { t, owner, businessId } = await ownerWithBusiness()
    const kevin = await createActor(t, { email: 'kevin@kevinspest.test' })
    const { url } = await owner.as.action(api.invitations.create, {
      businessId,
      email: 'kevin@kevinspest.test',
      role: 'subcontractor',
    })
    await kevin.as.action(api.invitations.redeem, {
      token: url.split('/join/')[1],
    })

    await expect(
      kevin.as.action(api.invitations.create, {
        businessId,
        email: 'mate@example.test',
        role: 'subcontractor',
      }),
    ).rejects.toThrow(/NO_ACCESS/)
  })

  test('re-inviting the same address kills the previous link', async () => {
    const { t, owner, businessId } = await ownerWithBusiness()
    const first = await owner.as.action(api.invitations.create, {
      businessId,
      email: 'kevin@kevinspest.test',
      role: 'subcontractor',
    })
    const second = await owner.as.action(api.invitations.create, {
      businessId,
      email: 'kevin@kevinspest.test',
      role: 'subcontractor',
    })

    const kevin = await createActor(t, { email: 'kevin@kevinspest.test' })
    await expect(
      kevin.as.action(api.invitations.redeem, {
        token: first.url.split('/join/')[1],
      }),
    ).rejects.toThrow(/INVITE_REVOKED/)

    await expect(
      kevin.as.action(api.invitations.redeem, {
        token: second.url.split('/join/')[1],
      }),
    ).resolves.toMatchObject({ businessId })
  })

  test('expiry is set, and the plain token is never stored', async () => {
    const { t, owner, businessId } = await ownerWithBusiness()
    const { url, invitationId } = await owner.as.action(
      api.invitations.create,
      { businessId, email: 'kevin@kevinspest.test', role: 'subcontractor' },
    )
    const token = url.split('/join/')[1]

    const row = await t.run(async (ctx) => ctx.db.get(invitationId))
    expect(row?.expiresAt).toBeGreaterThan(Date.now())
    expect(row?.expiresAt).toBeLessThanOrEqual(Date.now() + INVITE_TTL_MS)
    // A database read must not yield a working link.
    expect(JSON.stringify(row)).not.toContain(token)
  })
})

describe('preview', () => {
  test('shows the business and a masked address for a live link', async () => {
    const { t, owner, businessId } = await ownerWithBusiness()
    const { url } = await owner.as.action(api.invitations.create, {
      businessId,
      email: 'kevin@kevinspest.test',
      role: 'subcontractor',
    })

    const anyone = await createActor(t, { email: 'anyone@example.test' })
    const preview = await anyone.as.action(api.invitations.preview, {
      token: url.split('/join/')[1],
    })
    expect(preview).toMatchObject({
      state: 'valid',
      businessName: 'Coastal Pest',
      roleLabel: 'Subcontractor',
      emailHint: 'k****@kevinspest.test',
    })
  })

  test('tells a bad token nothing about the business', async () => {
    const { t } = await ownerWithBusiness()
    const anyone = await createActor(t, { email: 'anyone@example.test' })
    const preview = await anyone.as.action(api.invitations.preview, {
      token: 'wrong',
    })
    expect(preview).toEqual({
      state: 'invalid',
      businessName: null,
      roleLabel: null,
      emailHint: null,
    })
  })
})

describe('the retired email-match claim', () => {
  test('claimInvitations creates nothing, even with a matching address', async () => {
    const { t, owner, businessId } = await ownerWithBusiness()
    await owner.as.action(api.invitations.create, {
      businessId,
      email: 'kevin@kevinspest.test',
      role: 'subcontractor',
    })

    // This is the whole attack: register the invited address, then let the app
    // hand you the membership on the next visit to "/".
    const squatter = await createActor(t, { email: 'kevin@kevinspest.test' })
    await expect(
      squatter.as.mutation(api.memberships.claimInvitations, {}),
    ).resolves.toEqual([])

    const memberships = await t.run(async (ctx) =>
      ctx.db.query('memberships').collect(),
    )
    expect(memberships).toHaveLength(1) // the owner only
  })
})
