/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import {
  createActor,
  createBusiness,
  joinBusiness,
  testApp,
} from '../../test/harness'
import { buildMatchIndex, matchNewClient } from './clientMatch'
import { oursOf } from './ours'
import type { Id } from '../_generated/dataModel'

/**
 * The business's and the team's own numbers and emails, as the server reads
 * them for its own check when a booking saves (lib/ours.ts): every active
 * member's, whoever is booking. The directory never reads these
 * (clientDirectory.test.ts holds it to that).
 */

describe('oursOf', () => {
  test('the business’s phone, email and copy address, and every active member’s phone and sign-in email', async () => {
    const t = testApp()
    const owner = await createActor(t, { email: 'terence@coastal.test' })
    const { businessId, ownerMembershipId } = await createBusiness(t, owner)
    const kevin = await createActor(t, { email: 'kevin@coastal.test' })
    const kevinId = await joinBusiness(
      t,
      owner,
      kevin,
      businessId,
      'subcontractor',
    )
    const former = await createActor(t, { email: 'former@coastal.test' })
    await t.run(async (ctx) => {
      await ctx.db.patch(businessId, {
        phone: '(08) 9272 0000',
        email: 'office@coastal.test',
        reportCopyEmail: 'copies@coastal.test',
      })
      await ctx.db.patch(ownerMembershipId, { phone: '0412 000 111' })
      await ctx.db.patch(kevinId, { phone: '0433 222 333' })
      // Someone who has left: their number is nobody's in particular now.
      await ctx.db.insert('memberships', {
        userId: former.userId,
        businessId,
        role: 'subcontractor',
        canViewAllJobs: false,
        colour: '#000000',
        status: 'removed',
        phone: '0499 000 999',
        createdAt: Date.now(),
      })
    })

    const { areaCode, ours } = await t.run((ctx) => oursOf(ctx, businessId))
    expect(areaCode).toBe('08')
    expect([...ours.phones].sort()).toEqual([
      '(08) 9272 0000',
      '0412 000 111',
      '0433 222 333',
    ])
    expect([...ours.emails].sort()).toEqual([
      'copies@coastal.test',
      'kevin@coastal.test',
      'office@coastal.test',
      'terence@coastal.test',
    ])

    // What the server's check leaves out: Kevin's mobile on a client is the
    // team's, not the client's.
    const book = {
      clients: [
        {
          _id: 'c1' as Id<'clients'>,
          name: 'Kevin’s cousin',
          kind: 'person' as const,
          phone: '0433222333',
        },
      ],
      sites: [],
      contacts: [],
    }
    expect(
      matchNewClient(buildMatchIndex(book, { areaCode, ours }), {
        name: 'Sam Wu',
        phone: '0433 222 333',
      }).candidates,
    ).toEqual([])
  })
})
