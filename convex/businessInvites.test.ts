/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import { hashInviteToken } from './lib/inviteTokens'
import { createActor, createBusiness, testApp } from '../test/harness'
import type { TestApp } from '../test/harness'

/**
 * Starting a business by invitation — the door for a new pest control company
 * while sign-up is invitation-only. Every test is the shape of a real
 * attempt: the owner-to-be opening their link, a forwarded copy, a technician
 * who has been let go trying the set-up form, a link opened again on the
 * office computer.
 */

beforeEach(() => {
  vi.stubEnv('SITE_URL', 'https://app.pestm8.test')
  vi.stubEnv('AUTH_INVITE_ONLY', 'on')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

async function issue(t: TestApp, email = 'Jo@JosPest.test') {
  const { url } = await t.action(internal.businessInvites.issue, {
    email,
    note: 'Jo, Bunbury',
  })
  const token = url.split('/start/')[1]
  expect(url.startsWith('https://app.pestm8.test/start/')).toBe(true)
  return token
}

const JO = { email: 'jo@jospest.test', name: 'Jo' }
const NEW_BUSINESS = {
  name: "Jo's Pest Control",
  state: 'WA',
  timezone: 'Australia/Perth',
}

describe('issuing a link', () => {
  test('is bound to the address, lower-cased, and only the hash is kept', async () => {
    const t = testApp()
    const token = await issue(t)

    const rows = await t.run((ctx) => ctx.db.query('businessInvites').collect())
    expect(rows).toHaveLength(1)
    expect(rows[0].email).toBe('jo@jospest.test')
    expect(rows[0].tokenHash).toBe(await hashInviteToken(token))
    expect(JSON.stringify(rows[0])).not.toContain(token)
  })

  test('a second link for the address replaces the first', async () => {
    const t = testApp()
    const first = await issue(t)
    const second = await issue(t)

    expect(
      (await t.action(api.businessInvites.preview, { token: first })).state,
    ).toBe('revoked')
    expect(
      (await t.action(api.businessInvites.preview, { token: second })).state,
    ).toBe('valid')
  })

  test('refuses an address that could never be delivered to', async () => {
    const t = testApp()
    await expect(
      t.action(internal.businessInvites.issue, { email: 'jo@jospest..test' }),
    ).rejects.toThrow(/INVALID_EMAIL/)
  })
})

describe('the link, before anyone signs in', () => {
  test('previews as live with a masked address, and nothing else', async () => {
    const t = testApp()
    const token = await issue(t)
    expect(await t.action(api.businessInvites.preview, { token })).toEqual({
      state: 'valid',
      emailHint: 'j*@jospest.test',
    })
  })

  test('a made-up token and an expired one say only that they are dead', async () => {
    const t = testApp()
    const token = await issue(t)
    await t.run(async (ctx) => {
      const row = await ctx.db.query('businessInvites').first()
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 })
    })

    expect(await t.action(api.businessInvites.preview, { token })).toEqual({
      state: 'expired',
      emailHint: null,
    })
    expect(
      await t.action(api.businessInvites.preview, { token: 'not-a-token' }),
    ).toEqual({ state: 'invalid', emailHint: null })
  })

  test('the sign-up gate lets through only the invited address', async () => {
    const t = testApp()
    const token = await issue(t)
    const tokenHash = await hashInviteToken(token)

    expect(
      await t.query(internal.businessInvites.checkForSignUp, {
        tokenHash,
        email: ' JO@jospest.test ',
      }),
    ).toEqual({ ok: true, code: '' })
    expect(
      await t.query(internal.businessInvites.checkForSignUp, {
        tokenHash,
        email: 'someone@else.test',
      }),
    ).toEqual({ ok: false, code: 'INVITE_EMAIL_MISMATCH' })
    expect(
      await t.query(internal.businessInvites.checkForSignUp, {
        tokenHash: await hashInviteToken('nope'),
        email: JO.email,
      }),
    ).toEqual({ ok: false, code: 'INVITE_INVALID' })
  })

  test('a team invitation token is not a business one, and the other way round', async () => {
    const t = testApp()
    const owner = await createActor(t, { email: 'terence@coastal.test' })
    const { businessId } = await createBusiness(t, owner)
    const { url } = await owner.as.action(api.invitations.create, {
      businessId,
      email: JO.email,
      role: 'subcontractor',
    })
    const teamHash = await hashInviteToken(url.split('/join/')[1])
    const startHash = await hashInviteToken(await issue(t))

    // Each gate answers "no such link" for the other's token, which is what
    // lets the sign-up hook ask one and then the other.
    expect(
      await t.query(internal.businessInvites.checkForSignUp, {
        tokenHash: teamHash,
        email: JO.email,
      }),
    ).toEqual({ ok: false, code: 'INVITE_INVALID' })
    expect(
      await t.query(internal.invitations.checkForSignUp, {
        tokenHash: startHash,
        email: JO.email,
      }),
    ).toEqual({ ok: false, code: 'INVITE_INVALID' })
  })
})

describe('claiming the link', () => {
  test('binds it to the invited account, and to no one else after', async () => {
    const t = testApp()
    const token = await issue(t)
    const jo = await createActor(t, JO)

    expect(await jo.as.action(api.businessInvites.claim, { token })).toEqual({
      slug: null,
    })

    // The same link in a group chat opens nothing for anyone else.
    const other = await createActor(t, { email: 'kev@kevpest.test' })
    await expect(
      other.as.action(api.businessInvites.claim, { token }),
    ).rejects.toThrow(/INVITE_ALREADY_USED/)
    expect((await t.action(api.businessInvites.preview, { token })).state).toBe(
      'claimed',
    )
  })

  test('a forwarded link will not bind to the wrong address', async () => {
    const t = testApp()
    const token = await issue(t)
    const other = await createActor(t, { email: 'kev@kevpest.test' })
    await expect(
      other.as.action(api.businessInvites.claim, { token }),
    ).rejects.toThrow(/INVITE_EMAIL_MISMATCH/)
    // Still Jo's to use.
    expect((await t.action(api.businessInvites.preview, { token })).state).toBe(
      'valid',
    )
  })

  test('opening it again as the same account carries on', async () => {
    const t = testApp()
    const token = await issue(t)
    const jo = await createActor(t, JO)
    await jo.as.action(api.businessInvites.claim, { token })

    // Set-up not done yet: back to set-up.
    expect(await jo.as.action(api.businessInvites.claim, { token })).toEqual({
      slug: null,
    })

    // Business made: straight to it.
    const { slug } = await jo.as.mutation(api.businesses.create, NEW_BUSINESS)
    expect(await jo.as.action(api.businessInvites.claim, { token })).toEqual({
      slug,
    })
  })

  test('needs a signed-in account', async () => {
    const t = testApp()
    const token = await issue(t)
    await expect(
      t.action(api.businessInvites.claim, { token }),
    ).rejects.toThrow(/Unauthenticated/)
  })

  test('an expired link cannot be claimed, but a claim outlives the expiry', async () => {
    const t = testApp()
    const late = await issue(t, 'late@late.test')
    const token = await issue(t)
    const jo = await createActor(t, JO)
    await jo.as.action(api.businessInvites.claim, { token })

    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('businessInvites').collect()) {
        await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 })
      }
    })

    const lateActor = await createActor(t, { email: 'late@late.test' })
    await expect(
      lateActor.as.action(api.businessInvites.claim, { token: late }),
    ).rejects.toThrow(/INVITE_EXPIRED/)
    // Jo claimed in time; setting up tomorrow still works.
    await expect(
      jo.as.mutation(api.businesses.create, NEW_BUSINESS),
    ).resolves.toMatchObject({ slug: 'jo-s-pest-control' })
  })
})

describe('creating a business, invitation-only', () => {
  test('is refused without a claimed link — the technician who was let go', async () => {
    const t = testApp()
    const exTech = await createActor(t, { email: 'kev@kevpest.test' })

    expect(await exTech.as.query(api.businessInvites.setupAccess, {})).toEqual({
      canCreate: false,
    })
    await expect(
      exTech.as.mutation(api.businesses.create, NEW_BUSINESS),
    ).rejects.toThrow(/BUSINESS_INVITE_REQUIRED/)
    expect(
      await t.run((ctx) => ctx.db.query('businesses').collect()),
    ).toHaveLength(0)
  })

  test('a claim makes exactly one business, and is then spent', async () => {
    const t = testApp()
    const token = await issue(t)
    const jo = await createActor(t, JO)
    await jo.as.action(api.businessInvites.claim, { token })

    expect(await jo.as.query(api.businessInvites.setupAccess, {})).toEqual({
      canCreate: true,
    })
    const { businessId } = await jo.as.mutation(
      api.businesses.create,
      NEW_BUSINESS,
    )

    const row = await t.run((ctx) => ctx.db.query('businessInvites').first())
    expect(row?.businessId).toBe(businessId)
    expect(row?.usedAt).toBeTypeOf('number')

    await expect(
      jo.as.mutation(api.businesses.create, { ...NEW_BUSINESS, name: 'Two' }),
    ).rejects.toThrow(/BUSINESS_INVITE_REQUIRED/)
    expect(await jo.as.query(api.businessInvites.setupAccess, {})).toEqual({
      canCreate: false,
    })
  })

  test('revoking a claim before it is used shuts the door again', async () => {
    const t = testApp()
    const token = await issue(t)
    const jo = await createActor(t, JO)
    await jo.as.action(api.businessInvites.claim, { token })

    expect(
      await t.mutation(internal.businessInvites.revoke, {
        email: 'JO@jospest.test',
      }),
    ).toEqual({ revoked: 1 })
    await expect(
      jo.as.mutation(api.businesses.create, NEW_BUSINESS),
    ).rejects.toThrow(/BUSINESS_INVITE_REQUIRED/)
    await expect(
      jo.as.action(api.businessInvites.claim, { token }),
    ).rejects.toThrow(/INVITE_REVOKED/)
  })

  test('reissuing to an address that has claimed withdraws the claim — never two businesses', async () => {
    const t = testApp()
    const first = await issue(t)
    const jo = await createActor(t, JO)
    await jo.as.action(api.businessInvites.claim, { token: first })

    // "I lost the link" — a new one goes out, and Jo opens it too.
    const second = await issue(t)
    await expect(
      jo.as.action(api.businessInvites.claim, { token: first }),
    ).rejects.toThrow(/INVITE_REVOKED/)
    await jo.as.action(api.businessInvites.claim, { token: second })

    await jo.as.mutation(api.businesses.create, NEW_BUSINESS)
    await expect(
      jo.as.mutation(api.businesses.create, { ...NEW_BUSINESS, name: 'Two' }),
    ).rejects.toThrow(/BUSINESS_INVITE_REQUIRED/)
  })

  test('an owner starting a second business needs a link of their own too', async () => {
    const t = testApp()
    const owner = await createActor(t, { email: 'terence@coastal.test' })
    await createBusiness(t, owner)
    await expect(
      owner.as.mutation(api.businesses.create, NEW_BUSINESS),
    ).rejects.toThrow(/BUSINESS_INVITE_REQUIRED/)

    const token = await issue(t, 'terence@coastal.test')
    await owner.as.action(api.businessInvites.claim, { token })
    await expect(
      owner.as.mutation(api.businesses.create, NEW_BUSINESS),
    ).resolves.toMatchObject({ slug: 'jo-s-pest-control' })
  })

  test('a used link names nobody, and reopening it goes to the business only while still in it', async () => {
    const t = testApp()
    const token = await issue(t)
    const jo = await createActor(t, JO)
    await jo.as.action(api.businessInvites.claim, { token })
    const { businessId, slug } = await jo.as.mutation(
      api.businesses.create,
      NEW_BUSINESS,
    )

    expect(await t.action(api.businessInvites.preview, { token })).toEqual({
      state: 'used',
      emailHint: null,
    })
    expect(await jo.as.action(api.businessInvites.claim, { token })).toEqual({
      slug,
    })

    // No longer in it: the link is simply spent.
    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query('memberships')
        .withIndex('by_business', (q) => q.eq('businessId', businessId))
        .first()
      await ctx.db.patch(membership!._id, { status: 'removed' })
    })
    await expect(
      jo.as.action(api.businessInvites.claim, { token }),
    ).rejects.toThrow(/INVITE_ALREADY_USED/)

    // And revoking the address later leaves the record of it alone.
    expect(
      await t.mutation(internal.businessInvites.revoke, { email: JO.email }),
    ).toEqual({ revoked: 0 })
  })

  test('claiming waits for two-step sign-in where that is compulsory', async () => {
    vi.stubEnv('AUTH_MFA_REQUIRED', 'on')
    const t = testApp()
    const token = await issue(t)
    const jo = await createActor(t, { ...JO, twoFactorEnabled: false })
    await expect(
      jo.as.action(api.businessInvites.claim, { token }),
    ).rejects.toThrow(/MFA_ENROLMENT_REQUIRED/)
    await expect(
      jo.as.query(api.businessInvites.setupAccess, {}),
    ).rejects.toThrow(/MFA_ENROLMENT_REQUIRED/)
    // Still Jo's once set up.
    expect((await t.action(api.businessInvites.preview, { token })).state).toBe(
      'valid',
    )
  })

  test('the issuer can see what each link became', async () => {
    const t = testApp()
    const token = await issue(t)
    const jo = await createActor(t, JO)
    await jo.as.action(api.businessInvites.claim, { token })
    await jo.as.mutation(api.businesses.create, NEW_BUSINESS)

    expect(await t.query(internal.businessInvites.list, {})).toMatchObject([
      {
        email: 'jo@jospest.test',
        note: 'Jo, Bunbury',
        state: 'used',
        business: "Jo's Pest Control (/jo-s-pest-control)",
      },
    ])
  })
})

describe('creating a business, off invitation-only', () => {
  test('anyone signed in may, as before — dev and e2e rely on it', async () => {
    vi.stubEnv('AUTH_INVITE_ONLY', '')
    const t = testApp()
    const someone = await createActor(t, { email: 'dev@dev.test' })
    expect(await someone.as.query(api.businessInvites.setupAccess, {})).toEqual(
      { canCreate: true },
    )
    await expect(
      someone.as.mutation(api.businesses.create, NEW_BUSINESS),
    ).resolves.toMatchObject({ slug: 'jo-s-pest-control' })
  })

  test('a claim held anyway is still spent, so the issuer’s list stays true', async () => {
    vi.stubEnv('AUTH_INVITE_ONLY', '')
    const t = testApp()
    const token = await issue(t)
    const jo = await createActor(t, JO)
    await jo.as.action(api.businessInvites.claim, { token })
    await jo.as.mutation(api.businesses.create, NEW_BUSINESS)
    expect((await t.query(internal.businessInvites.list, {}))[0].state).toBe(
      'used',
    )
  })
})

describe('slugs', () => {
  test('a business never takes a path the app owns', async () => {
    vi.stubEnv('AUTH_INVITE_ONLY', '')
    const t = testApp()
    const someone = await createActor(t, { email: 'dev@dev.test' })
    for (const [name, slug] of [
      ['Start', 'start-2'],
      ['Join', 'join-2'],
      ['Two Step', 'two-step-2'],
      ['Login', 'login-2'],
    ]) {
      const created = await someone.as.mutation(api.businesses.create, {
        ...NEW_BUSINESS,
        name,
      })
      expect(created.slug).toBe(slug)
    }
  })
})

describe('set-up progress', () => {
  async function jo(t: TestApp) {
    const token = await issue(t)
    const actor = await createActor(t, JO)
    await actor.as.action(api.businessInvites.claim, { token })
    const created = await actor.as.mutation(api.businesses.create, {
      ...NEW_BUSINESS,
      withSetup: true,
    })
    return { actor, ...created }
  }

  test('a business made by the flow resumes where its owner left off', async () => {
    const t = testApp()
    const { actor, businessId } = await jo(t)

    const step = async () =>
      (await actor.as.query(api.businesses.listForUser, {}))[0].setupStep

    expect(await step()).toBe('brand')
    await actor.as.mutation(api.businesses.setSetup, {
      businessId,
      step: 'team',
      team: 'solo',
    })
    expect(await step()).toBe('team')
    const stored = await t.run((ctx) => ctx.db.get(businessId))
    expect(stored?.setup).toMatchObject({ step: 'team', team: 'solo' })

    await actor.as.mutation(api.businesses.setSetup, {
      businessId,
      finished: true,
    })
    expect(await step()).toBeNull()

    // Finished is finished: a stale tab cannot open it again.
    await actor.as.mutation(api.businesses.setSetup, {
      businessId,
      step: 'brand',
    })
    expect(await step()).toBeNull()
  })

  test('a business not made by the flow has nothing to resume', async () => {
    vi.stubEnv('AUTH_INVITE_ONLY', '')
    const t = testApp()
    const someone = await createActor(t, { email: 'dev@dev.test' })
    const { businessId } = await someone.as.mutation(
      api.businesses.create,
      NEW_BUSINESS,
    )
    expect(
      (await someone.as.query(api.businesses.listForUser, {}))[0].setupStep,
    ).toBeNull()

    await someone.as.mutation(api.businesses.setSetup, {
      businessId,
      step: 'team',
    })
    const stored = await t.run((ctx) => ctx.db.get(businessId))
    expect(stored?.setup).toBeUndefined()
  })

  test('only the owner moves it, and only the owner is sent back to it', async () => {
    const t = testApp()
    const { actor, businessId } = await jo(t)
    const { url } = await actor.as.action(api.invitations.create, {
      businessId,
      email: 'kev@kevpest.test',
      role: 'subcontractor',
    })
    const kev = await createActor(t, { email: 'kev@kevpest.test' })
    await kev.as.action(api.invitations.redeem, {
      token: url.split('/join/')[1],
    })

    expect(
      (await kev.as.query(api.businesses.listForUser, {}))[0].setupStep,
    ).toBeNull()
    await expect(
      kev.as.mutation(api.businesses.setSetup, { businessId, finished: true }),
    ).rejects.toThrow(/NO_ACCESS/)

    // Nor anyone from outside the business.
    const stranger = await createActor(t, { email: 'stranger@else.test' })
    await expect(
      stranger.as.mutation(api.businesses.setSetup, {
        businessId,
        finished: true,
      }),
    ).rejects.toThrow()
    const stored = await t.run((ctx) => ctx.db.get(businessId))
    expect(stored?.setup?.finishedAt).toBeUndefined()
  })
})
