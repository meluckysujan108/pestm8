import { expect, test } from '@playwright/test'
import { api, expectRejected, signUpActor, uniqueEmail } from './fixtures'

/**
 * ARCHITECTURE.md §6.5 — the access-control matrix.
 *
 * These are written before the features they guard (§6.1). A leak here is a
 * business-ending trust failure in a product whose selling point is that
 * subcontractors are independent, so these run against the Convex functions
 * directly rather than trusting the UI to hide anything.
 *
 * Job-scoped rows in the matrix are pending Phase 2 (jobs do not exist yet)
 * and are marked test.fixme so they fail loudly when unskipped rather than
 * silently passing.
 */

const PASSWORD = 'fixture-password-8823'

test.describe('tenant isolation', () => {
  test('a user cannot read a business they are not a member of', async () => {
    const owner = await signUpActor(uniqueEmail('owner'), PASSWORD, 'Terence')
    const outsider = await signUpActor(
      uniqueEmail('outsider'),
      PASSWORD,
      'Outsider',
    )

    const { slug, businessId } = await owner.client.mutation(
      api.businesses.create,
      { name: `Isolation ${Date.now()}`, state: 'WA', timezone: 'Australia/Perth' },
    )

    // A non-member gets null, identical to a slug that does not exist —
    // no existence leak.
    await expect(
      outsider.client.query(api.businesses.getBySlug, { slug }),
    ).resolves.toBeNull()

    await expect(
      outsider.client.query(api.businesses.getBySlug, {
        slug: 'definitely-not-a-real-business',
      }),
    ).resolves.toBeNull()

    // And membership-scoped reads are rejected outright.
    await expectRejected(
      () =>
        outsider.client.query(api.memberships.listForBusiness, { businessId }),
      'NO_ACCESS',
    )
  })

  test('an unauthenticated caller is rejected', async () => {
    const owner = await signUpActor(uniqueEmail('owner'), PASSWORD, 'Terence')
    const { businessId } = await owner.client.mutation(api.businesses.create, {
      name: `Unauth ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    })

    const { ConvexHttpClient } = await import('convex/browser')
    const anon = new ConvexHttpClient(process.env.VITE_CONVEX_URL!)

    await expectRejected(
      () => anon.query(api.memberships.listForBusiness, { businessId }),
      'UNAUTHENTICATED',
    )
  })

  test('direct URL to another tenant 404s', async ({ page }) => {
    const owner = await signUpActor(uniqueEmail('owner'), PASSWORD, 'Terence')
    const { slug } = await owner.client.mutation(api.businesses.create, {
      name: `Direct URL ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    })

    const outsiderEmail = uniqueEmail('outsider')
    await signUpActor(outsiderEmail, PASSWORD, 'Outsider')

    await page.goto('/login')
    await page.getByLabel('Email').fill(outsiderEmail)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()

    await page.goto(`/${slug}/dashboard`)
    await expect(page.getByText(/not found/i)).toBeVisible()
  })
})

test.describe('role boundaries', () => {
  test('a subcontractor cannot grant themselves access', async () => {
    const owner = await signUpActor(uniqueEmail('owner'), PASSWORD, 'Terence')
    const sub = await signUpActor(uniqueEmail('sub'), PASSWORD, 'Kevin')

    const { businessId } = await owner.client.mutation(api.businesses.create, {
      name: `Roles ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    })

    const subUserId = await sub.client.query(api.auth.getCurrentUser, {})
    const membershipId = await owner.client.mutation(api.memberships.invite, {
      businessId,
      userId: subUserId!._id,
      role: 'subcontractor',
    })

    await expectRejected(
      () =>
        sub.client.mutation(api.memberships.setCanViewAllJobs, {
          businessId,
          membershipId,
          canViewAllJobs: true,
        }),
      'NO_ACCESS',
    )

    await expectRejected(
      () =>
        sub.client.mutation(api.memberships.setRole, {
          businessId,
          membershipId,
          role: 'owner',
        }),
      'NO_ACCESS',
    )
  })

  test('the last owner cannot be demoted', async () => {
    const owner = await signUpActor(uniqueEmail('owner'), PASSWORD, 'Terence')

    const { businessId } = await owner.client.mutation(api.businesses.create, {
      name: `Last owner ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    })

    const members = await owner.client.query(api.memberships.listForBusiness, {
      businessId,
    })
    const ownerMembership = members.find((m) => m.role === 'owner')!

    await expect(
      owner.client.mutation(api.memberships.setRole, {
        businessId,
        membershipId: ownerMembership._id,
        role: 'subcontractor',
      }),
    ).rejects.toThrow(/LAST_OWNER/)
  })

  test('a subcontractor cannot set another member licence', async () => {
    const owner = await signUpActor(uniqueEmail('owner'), PASSWORD, 'Terence')
    const sub = await signUpActor(uniqueEmail('sub'), PASSWORD, 'Kevin')

    const { businessId } = await owner.client.mutation(api.businesses.create, {
      name: `Licence ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    })

    const subUser = await sub.client.query(api.auth.getCurrentUser, {})
    await owner.client.mutation(api.memberships.invite, {
      businessId,
      userId: subUser!._id,
      role: 'subcontractor',
    })

    const members = await owner.client.query(api.memberships.listForBusiness, {
      businessId,
    })
    const ownerMembership = members.find((m) => m.role === 'owner')!

    await expectRejected(
      () =>
        sub.client.mutation(api.memberships.setLicence, {
          businessId,
          membershipId: ownerMembership._id,
          licenceNumber: 'PMT-0000',
        }),
      'NO_ACCESS',
    )
  })
})

test.describe('multi-tenant membership', () => {
  test('switching business changes visible data with no bleed', async () => {
    const user = await signUpActor(uniqueEmail('multi'), PASSWORD, 'Terence')

    const a = await user.client.mutation(api.businesses.create, {
      name: `Alpha ${Date.now()}`,
      state: 'WA',
      timezone: 'Australia/Perth',
    })
    const b = await user.client.mutation(api.businesses.create, {
      name: `Beta ${Date.now()}`,
      state: 'QLD',
      timezone: 'Australia/Brisbane',
    })

    const businesses = await user.client.query(api.businesses.listForUser, {})
    expect(businesses.map((x) => x.businessId)).toEqual(
      expect.arrayContaining([a.businessId, b.businessId]),
    )

    const alphaMembers = await user.client.query(
      api.memberships.listForBusiness,
      { businessId: a.businessId },
    )
    const betaMembers = await user.client.query(api.memberships.listForBusiness, {
      businessId: b.businessId,
    })

    expect(alphaMembers).toHaveLength(1)
    expect(betaMembers).toHaveLength(1)
    expect(alphaMembers[0]._id).not.toBe(betaMembers[0]._id)
  })
})

// Phase 2 — jobs do not exist yet. Unskip alongside convex/jobs.ts.
test.describe('job visibility', () => {
  test.fixme('sub with canViewAllJobs=false cannot see another job', () => {})
  test.fixme('sub with canViewAllJobs=true reads but cannot edit', () => {})
  test.fixme('sub cannot invoice a job assigned to someone else', () => {})
  test.fixme('Xero push lands only in the assignee organisation', () => {})
})
