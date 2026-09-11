import { expect, test } from '@playwright/test'
import {
  FIXTURE_PASSWORD,
  api,
  expectRejected,
  setupBusinessWithSub,
  signUpActor,
  uniqueEmail,
} from './fixtures'

const DAY = 24 * 60 * 60 * 1000

/** Adds a second subcontractor to a `setupBusinessWithSub` business. */
async function addSecondSub(
  s: Awaited<ReturnType<typeof setupBusinessWithSub>>,
  label: string,
) {
  const sub2 = await signUpActor(
    uniqueEmail(`sub2-${label}`),
    FIXTURE_PASSWORD,
    'Priya',
  )
  const sub2User = await sub2.client.query(api.auth.getCurrentUser, {})
  const sub2MembershipId = await s.owner.client.mutation(
    api.memberships.invite,
    {
      businessId: s.businessId,
      userId: sub2User._id,
      role: 'subcontractor',
    },
  )
  await sub2.client.mutation(api.memberships.accept, {
    businessId: s.businessId,
  })
  return { sub2, sub2MembershipId }
}

test('an owner can view as any subcontractor, scoping their own reads to that subcontractor', async () => {
  const s = await setupBusinessWithSub('viewas-owner')

  // A job assigned to the sub, not visible to the owner's default "business"
  // scope distinction — but we can prove the scope actually switched by
  // checking dashboard.summary's own `scope` field before and after.
  const before = await s.owner.client.query(api.dashboard.summary, {
    businessId: s.businessId,
  })
  expect(before?.scope).toBe('business')

  await s.owner.client.mutation(api.memberships.setViewingAs, {
    businessId: s.businessId,
    targetMembershipId: s.subMembershipId,
  })

  const after = await s.owner.client.query(api.dashboard.summary, {
    businessId: s.businessId,
  })
  // The sub has no canViewAllJobs by default, so viewing as them narrows scope.
  expect(after?.scope).toBe('assignee')

  await s.owner.client.mutation(api.memberships.setViewingAs, {
    businessId: s.businessId,
    targetMembershipId: undefined,
  })
  const restored = await s.owner.client.query(api.dashboard.summary, {
    businessId: s.businessId,
  })
  expect(restored?.scope).toBe('business')
})

test('an ungranted subcontractor cannot view as anyone', async () => {
  const s = await setupBusinessWithSub('viewas-ungranted')
  const { sub2MembershipId } = await addSecondSub(s, 'ungranted')

  await expectRejected(
    () =>
      s.sub.client.mutation(api.memberships.setViewingAs, {
        businessId: s.businessId,
        targetMembershipId: sub2MembershipId,
      }),
    'NO_ACCESS',
  )
  await expectRejected(
    () =>
      s.sub.client.mutation(api.memberships.setViewingAs, {
        businessId: s.businessId,
        targetMembershipId: s.ownerMembershipId,
      }),
    'NO_ACCESS',
  )
})

test('a granted subcontractor can view as another subcontractor but never the owner', async () => {
  const s = await setupBusinessWithSub('viewas-granted')
  const { sub2, sub2MembershipId } = await addSecondSub(s, 'granted')

  await s.owner.client.mutation(api.memberships.setCanViewOtherAccounts, {
    businessId: s.businessId,
    membershipId: s.subMembershipId,
    canViewOtherAccounts: true,
  })

  // Allowed: granted sub -> other sub.
  await s.sub.client.mutation(api.memberships.setViewingAs, {
    businessId: s.businessId,
    targetMembershipId: sub2MembershipId,
  })
  const scope = await s.sub.client.query(api.viewAs.getViewScope, {
    businessId: s.businessId,
  })
  expect(scope.viewingAs?.membershipId).toBe(sub2MembershipId)

  // Rejected: granted sub -> owner, unconditionally, even with the toggle on.
  await expectRejected(
    () =>
      s.sub.client.mutation(api.memberships.setViewingAs, {
        businessId: s.businessId,
        targetMembershipId: s.ownerMembershipId,
      }),
    'NO_ACCESS',
  )

  // The other sub, not granted, still cannot view as anyone.
  await expectRejected(
    () =>
      sub2.client.mutation(api.memberships.setViewingAs, {
        businessId: s.businessId,
        targetMembershipId: s.subMembershipId,
      }),
    'NO_ACCESS',
  )
})

test('a revoked grant silently falls back to your own view rather than erroring', async () => {
  const s = await setupBusinessWithSub('viewas-revoked')
  const { sub2MembershipId } = await addSecondSub(s, 'revoked')

  await s.owner.client.mutation(api.memberships.setCanViewOtherAccounts, {
    businessId: s.businessId,
    membershipId: s.subMembershipId,
    canViewOtherAccounts: true,
  })
  await s.sub.client.mutation(api.memberships.setViewingAs, {
    businessId: s.businessId,
    targetMembershipId: sub2MembershipId,
  })

  // Revoke the grant without ever calling setViewingAs again.
  await s.owner.client.mutation(api.memberships.setCanViewOtherAccounts, {
    businessId: s.businessId,
    membershipId: s.subMembershipId,
    canViewOtherAccounts: false,
  })

  const scope = await s.sub.client.query(api.viewAs.getViewScope, {
    businessId: s.businessId,
  })
  expect(scope.viewingAs).toBeNull()

  // Reads still work — they just silently reflect the sub's own scope again.
  const summary = await s.sub.client.query(api.dashboard.summary, {
    businessId: s.businessId,
  })
  expect(summary).not.toBeNull()
})

test('canEdit always reflects the real caller, never the viewed-as person', async () => {
  const s = await setupBusinessWithSub('viewas-canedit')
  const { sub2, sub2MembershipId } = await addSecondSub(s, 'canedit')

  // A job assigned to sub2 — sub2 can edit it, the original sub cannot.
  const jobId = await s.owner.client.mutation(api.jobs.create, {
    businessId: s.businessId,
    propertyId: s.propertyId,
    assignedMembershipId: sub2MembershipId,
    jobType: 'General Pest Control',
    price: 20000,
    scheduledAt: Date.now() + DAY,
    durationMinutes: 60,
  })

  await s.owner.client.mutation(api.memberships.setCanViewOtherAccounts, {
    businessId: s.businessId,
    membershipId: s.subMembershipId,
    canViewOtherAccounts: true,
  })
  await s.sub.client.mutation(api.memberships.setViewingAs, {
    businessId: s.businessId,
    targetMembershipId: sub2MembershipId,
  })

  // Viewing as sub2, the original sub can now SEE sub2's job...
  const seenViaViewAs = await s.sub.client.query(api.jobs.get, {
    businessId: s.businessId,
    jobId,
  })
  expect(seenViaViewAs).not.toBeNull()
  // ...but canEdit still reflects the REAL caller (sub), who cannot edit it.
  expect(seenViaViewAs?.canEdit).toBe(false)

  // Confirm sub2 themself (the real assignee) does see canEdit: true.
  const seenBySub2 = await sub2.client.query(api.jobs.get, {
    businessId: s.businessId,
    jobId,
  })
  expect(seenBySub2?.canEdit).toBe(true)
})

test('a subcontractor can only edit their own profile phone number', async () => {
  const s = await setupBusinessWithSub('viewas-profile')

  await s.sub.client.mutation(api.memberships.setProfile, {
    businessId: s.businessId,
    membershipId: s.subMembershipId,
    phone: '0400 555 111',
  })
  const members = await s.owner.client.query(api.memberships.listForBusiness, {
    businessId: s.businessId,
  })
  expect(members.find((m) => m._id === s.subMembershipId)?.phone).toBe(
    '0400 555 111',
  )

  await expectRejected(
    () =>
      s.sub.client.mutation(api.memberships.setProfile, {
        businessId: s.businessId,
        membershipId: s.ownerMembershipId,
        phone: '0400 000 000',
      }),
    'NO_ACCESS',
  )
})
