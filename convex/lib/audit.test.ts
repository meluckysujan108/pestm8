/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { forSelf, recordAudit } from './audit'
import { createActor, createBusiness, testApp } from '../../test/harness'

/**
 * The audit trail, and the one rule that keeps it honest: every row is written
 * in one place, so "who did this" cannot be answered differently in eighteen
 * of them.
 */

const sources: Record<string, string> = import.meta.glob('../**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
})

describe('one writer', () => {
  /**
   * A structural guard, not a tidiness one. The moment someone can work inside
   * another person's account, an audit row has two halves — the human and the
   * account — and a hand-written insert records only one of them. It does not
   * fail; it writes down that the wrong person did something, in the log a
   * compliance dispute would be settled from.
   *
   * `auditLog.ts` claimed to be the single writer in its own docstring while
   * eighteen mutations inserted rows by hand, so a comment is demonstrably not
   * enough to keep this true.
   */
  test('nothing inserts an audit row except lib/audit.ts', () => {
    const offenders = Object.entries(sources)
      // This file's own glob key is './audit.ts' — it is the writer.
      .filter(([path]) => path !== './audit.ts')
      .filter(([path]) => !path.includes('.test.'))
      .filter(([, src]) => src.includes("db.insert('auditLog'"))
      .map(([path]) => path)

    expect(offenders).toEqual([])
  })
})

describe('what a row says about who did it', () => {
  async function fixture() {
    const t = testApp()
    const owner = await createActor(t, { email: 'terence@coastal.test' })
    const { businessId, ownerMembershipId } = await createBusiness(t, owner)
    return { t, businessId, ownerMembershipId }
  }

  const rowsOf = (t: Awaited<ReturnType<typeof fixture>>['t']) =>
    t.run((ctx) => ctx.db.query('auditLog').collect())

  /**
   * Absent, not null, and not a self-reference. Present has to mean something
   * happened — every row written before switching existed has this field
   * missing, and they all mean "they were working as themselves".
   */
  test('acting as yourself leaves the second half unwritten', async () => {
    const f = await fixture()
    await f.t.run((ctx) =>
      recordAudit(ctx, forSelf(f.ownerMembershipId), {
        businessId: f.businessId,
        action: 'licence.set',
        entityType: 'memberships',
        entityId: f.ownerMembershipId,
      }),
    )

    const [row] = await rowsOf(f.t)
    expect(row.actorMembershipId).toBe(f.ownerMembershipId)
    expect(row.onBehalfOfMembershipId).toBeUndefined()
    expect('onBehalfOfMembershipId' in row).toBe(false)
  })

  /** The shape `writeAttribution(actor)` already returns, so the day switching
   * lands these call sites change by one argument and no more. */
  test('acting in someone else’s account records both people', async () => {
    const f = await fixture()
    const kevin = await f.t.run((ctx) =>
      ctx.db.insert('memberships', {
        userId: 'u_kevin',
        businessId: f.businessId,
        role: 'subcontractor',
        canViewAllJobs: false,
        colour: '#0ea5e9',
        status: 'active',
        createdAt: 0,
      }),
    )

    await f.t.run((ctx) =>
      recordAudit(
        ctx,
        {
          actorMembershipId: f.ownerMembershipId,
          onBehalfOfMembershipId: kevin,
        },
        {
          businessId: f.businessId,
          action: 'report.finalise',
          entityType: 'reports',
          entityId: 'r_1',
        },
      ),
    )

    const [row] = await rowsOf(f.t)
    expect(row.actorMembershipId).toBe(f.ownerMembershipId)
    expect(row.onBehalfOfMembershipId).toBe(kevin)
  })

  /** The row has to be able to share a timestamp with the write it describes;
   * several callers pass the `now` they already computed. */
  test('a caller can pin the time to the change it describes', async () => {
    const f = await fixture()
    await f.t.run((ctx) =>
      recordAudit(ctx, forSelf(f.ownerMembershipId), {
        businessId: f.businessId,
        action: 'business.update',
        entityType: 'businesses',
        entityId: f.businessId,
        at: 1234,
      }),
    )
    expect((await rowsOf(f.t))[0].at).toBe(1234)
  })
})
