/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { internal } from '../_generated/api'
import {
  createActor,
  createBusiness,
  joinBusiness,
  testApp,
} from '../../test/harness'
import { DEFAULT_GRANTS, NO_GRANTS } from '../lib/capabilities'
import { grantsFromMembership } from '../lib/membershipFacts'

/**
 * A business as prod could hold it before the old view settings were
 * retired: the owner with the old column, Kevin a legacy row with no
 * `grants` of his own and "Can view all jobs" on, Priya with `grants`, the
 * old "Can view other accounts" and a leftover "view as" selection.
 */
async function setup() {
  const t = testApp()
  const terence = await createActor(t, { email: 'terence@coastal.test' })
  const kevin = await createActor(t, { email: 'kevin@coastal.test' })
  const priya = await createActor(t, { email: 'priya@coastal.test' })
  const { businessId, ownerMembershipId } = await createBusiness(t, terence)
  const kevinId = await joinBusiness(
    t,
    terence,
    kevin,
    businessId,
    'subcontractor',
  )
  const priyaId = await joinBusiness(
    t,
    terence,
    priya,
    businessId,
    'subcontractor',
  )
  await t.run(async (ctx) => {
    await ctx.db.patch(ownerMembershipId, {
      grants: DEFAULT_GRANTS.owner,
      canViewAllJobs: true,
    })
    await ctx.db.patch(kevinId, { grants: undefined, canViewAllJobs: true })
    await ctx.db.patch(priyaId, {
      grants: { ...NO_GRANTS, prices: true },
      canViewAllJobs: false,
      canViewOtherAccounts: true,
      viewingAsMembershipId: kevinId,
    })
  })
  const rows = () =>
    t.run(async (ctx) => ({
      owner: await ctx.db.get(ownerMembershipId),
      kevin: await ctx.db.get(kevinId),
      priya: await ctx.db.get(priyaId),
    }))
  return { t, rows }
}

describe('retiring the old view settings', () => {
  test('counts what is due, and a dry run writes nothing', async () => {
    const s = await setup()
    expect(
      await s.t.query(internal.migrations.viewSettingsV1.remaining, {}),
    ).toMatchObject({
      due: 3,
      withoutGrants: 1,
      viewOtherAccountsOn: 1,
      viewingAsSet: 1,
      isDone: true,
    })

    const before = await s.rows()
    expect(
      await s.t.mutation(internal.migrations.viewSettingsV1.run, {
        dryRun: true,
      }),
    ).toMatchObject({ dryRun: true, changed: 3, grantsWritten: 1 })
    expect(await s.rows()).toEqual(before)
  })

  test('clears the three columns and changes nobody’s access', async () => {
    const s = await setup()
    const before = await s.rows()
    const access = {
      owner: grantsFromMembership(before.owner!),
      kevin: grantsFromMembership(before.kevin!),
      priya: grantsFromMembership(before.priya!),
    }

    expect(
      await s.t.mutation(internal.migrations.viewSettingsV1.run, {}),
    ).toMatchObject({ changed: 3, grantsWritten: 1, isDone: true })

    const after = await s.rows()
    for (const row of [after.owner, after.kevin, after.priya]) {
      expect(row?.canViewAllJobs).toBeUndefined()
      expect(row?.canViewOtherAccounts).toBeUndefined()
      expect(row?.viewingAsMembershipId).toBeUndefined()
      expect(row?.grants).toBeDefined()
    }
    // Kevin's legacy "Can view all jobs" is now his own grant, and the
    // others keep the grants they had, exactly.
    expect(after.kevin?.grants?.otherSchedules).toBe(true)
    expect(grantsFromMembership(after.owner!)).toEqual(access.owner)
    expect(grantsFromMembership(after.kevin!)).toEqual(access.kevin)
    expect(grantsFromMembership(after.priya!)).toEqual(access.priya)
    expect(after.priya?.grants).toEqual(before.priya?.grants)

    expect(
      await s.t.query(internal.migrations.viewSettingsV1.remaining, {}),
    ).toMatchObject({
      due: 0,
    })
    expect(
      await s.t.mutation(internal.migrations.viewSettingsV1.run, {}),
    ).toMatchObject({ changed: 0 })
  })

  test('a rollback puts the old column back from grants', async () => {
    const s = await setup()
    await s.t.mutation(internal.migrations.viewSettingsV1.run, {})
    expect(
      await s.t.mutation(
        internal.migrations.viewSettingsV1.restoreForRollback,
        {},
      ),
    ).toMatchObject({ restored: 3, isDone: true })

    const after = await s.rows()
    expect(after.owner?.canViewAllJobs).toBe(true)
    expect(after.kevin?.canViewAllJobs).toBe(true)
    expect(after.priya?.canViewAllJobs).toBe(false)
  })
})
