/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api, components, internal } from './_generated/api'
import { requireActor } from './lib/actor'
import { dayKeyOf } from './lib/dates'
import {
  addSession,
  createActor,
  createBusiness,
  testApp,
} from '../test/harness'
import type { Id } from './_generated/dataModel'
import type { TestActor } from '../test/harness'

/**
 * The owner's view dropdown: God view, "Just my jobs", or someone's account.
 *
 * What is pinned here is the line the whole feature rests on: "Just my jobs"
 * narrows what a LIST shows him, and nothing else. Not a job he opens, not the
 * history of a client, and never what he may do.
 */

async function business() {
  const t = testApp()
  const terence = await createActor(t, {
    email: 'terence@coastalpest.test',
    name: 'Terence',
  })
  const { businessId, ownerMembershipId } = await createBusiness(t, terence)
  const kevin = await createActor(t, { email: 'kevin@kp.test', name: 'Kevin' })
  const jo = await createActor(t, { email: 'jo@jospest.test', name: 'Jo' })

  const now = Date.now()
  const ids = await t.run(async (ctx) => {
    const member = (userId: string, role: 'contractor' | 'subcontractor') =>
      ctx.db.insert('memberships', {
        userId,
        businessId,
        role,
        canViewAllJobs: false,
        colour: '#0ea5e9',
        status: 'active',
        createdAt: now,
      })
    const kevinId = await member(kevin.userId, 'subcontractor')
    const joId = await member(jo.userId, 'contractor')

    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'person',
      name: 'J. Nguyen',
      createdAt: now,
      updatedAt: now,
    })
    const propertyId = await ctx.db.insert('properties', {
      businessId,
      clientId,
      addressLine: '12 Wattle Street',
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
      createdAt: now,
    })
    const job = (assignedMembershipId: Id<'memberships'>, jobType: string) =>
      ctx.db.insert('jobs', {
        businessId,
        propertyId,
        assignedMembershipId,
        jobType,
        price: 19500,
        scheduledAt: now,
        durationMinutes: 60,
        status: 'booked',
        createdAt: now,
      })
    return {
      kevinId,
      joId,
      clientId,
      propertyId,
      ownerJobId: await job(ownerMembershipId, 'Owner visit'),
      kevinJobId: await job(kevinId, 'Kevin visit'),
    }
  })

  return {
    t,
    terence,
    kevin,
    jo,
    businessId,
    ownerMembershipId,
    today: dayKeyOf(now, 'Australia/Perth'),
    ...ids,
  }
}

type Fixture = Awaited<ReturnType<typeof business>>

const setView = (
  f: Fixture,
  actor: TestActor,
  view:
    | { kind: 'everyone' }
    | { kind: 'mine' }
    | { kind: 'account'; membershipId: Id<'memberships'> },
) => actor.as.mutation(api.views.set, { businessId: f.businessId, view })

const day = (f: Fixture, actor: TestActor) =>
  actor.as
    .query(api.jobs.listDay, { businessId: f.businessId, dayKey: f.today })
    .then((jobs) => jobs.map((j) => j.jobType).sort())

const viewMode = (f: Fixture, actor: TestActor) =>
  actor.as
    .query(api.access.me, { businessId: f.businessId })
    .then((me) => me.view?.mode ?? null)

describe('the owner chooses what his lists show', () => {
  test('God view is the default, and shows everyone', async () => {
    const f = await business()
    expect(await viewMode(f, f.terence)).toBe('everyone')
    expect(await day(f, f.terence)).toEqual(['Kevin visit', 'Owner visit'])
  })

  test('"Just my jobs" narrows the schedule to his own', async () => {
    const f = await business()
    await setView(f, f.terence, { kind: 'mine' })

    expect(await viewMode(f, f.terence)).toBe('mine')
    expect(await day(f, f.terence)).toEqual(['Owner visit'])

    const load = await f.terence.as.query(api.jobs.monthTeamLoad, {
      businessId: f.businessId,
      monthKey: f.today.slice(0, 7),
    })
    expect(load.map((row) => row.membershipId)).toEqual([f.ownerMembershipId])

    // The existing "these figures cover your own jobs" notice keys on this.
    const summary = await f.terence.as.query(api.dashboard.summary, {
      businessId: f.businessId,
    })
    expect(summary?.scope).toBe('assignee')
  })

  /**
   * The line the feature rests on. Standing at a house, the technician needs
   * its whole history — including the visits that were not his.
   */
  test('but anything he opens is whole: a job, a property’s history', async () => {
    const f = await business()
    await setView(f, f.terence, { kind: 'mine' })

    const job = await f.terence.as.query(api.jobs.get, {
      businessId: f.businessId,
      jobId: f.kevinJobId,
    })
    expect(job?.jobType).toBe('Kevin visit')

    const history = await f.terence.as.query(api.properties.jobHistory, {
      businessId: f.businessId,
      propertyId: f.propertyId,
    })
    expect(history.map((j) => j.jobType).sort()).toEqual([
      'Kevin visit',
      'Owner visit',
    ])
  })

  test('and it never narrows what he may do', async () => {
    const f = await business()
    await setView(f, f.terence, { kind: 'mine' })

    // Resolved inside a mutation, the view is not applied at all.
    const inMutation = await f.terence.as.run((ctx) =>
      requireActor(ctx, f.businessId),
    )
    expect(inMutation.listScope).toEqual({ kind: 'business' })

    await f.terence.as.mutation(api.jobs.complete, {
      businessId: f.businessId,
      jobId: f.kevinJobId,
    })
    const job = await f.t.run((ctx) => ctx.db.get(f.kevinJobId))
    expect(job?.status).toBe('completed')
  })

  test('in a query, the view narrows the list scope and not the record scope', async () => {
    const f = await business()
    await setView(f, f.terence, { kind: 'mine' })

    const env = await f.terence.as.query((ctx) =>
      requireActor(ctx, f.businessId),
    )
    expect(env.listScope).toEqual({
      kind: 'own',
      membershipId: f.ownerMembershipId,
    })
    expect(env.scope).toEqual({ kind: 'business' })
    expect(env.view).toBe('mine')
  })

  test('God view again brings everyone back', async () => {
    const f = await business()
    await setView(f, f.terence, { kind: 'mine' })
    await setView(f, f.terence, { kind: 'everyone' })

    expect(await viewMode(f, f.terence)).toBe('everyone')
    expect(await day(f, f.terence)).toEqual(['Kevin visit', 'Owner visit'])
    const rows = await f.t.run((ctx) => ctx.db.query('sessionViews').collect())
    expect(rows).toEqual([])
  })
})

describe('the reports library and notes follow the same line', () => {
  async function withReports(f: Fixture) {
    const now = Date.now()
    return f.t.run(async (ctx) => {
      const report = (authorMembershipId: Id<'memberships'>) =>
        ctx.db.insert('reports', {
          businessId: f.businessId,
          propertyId: f.propertyId,
          authorMembershipId,
          template: 'serviceReport',
          legalBasis: 'APVMA',
          status: 'draft',
          data: {},
          photoIds: [],
          createdAt: now,
          updatedAt: now,
        })
      return {
        ownerReport: await report(f.ownerMembershipId),
        kevinReport: await report(f.kevinId),
      }
    })
  }

  /** The list, its search and its counts must agree, or the rail says 2
   * over a list of 1. */
  test('"Just my jobs" narrows the library to what he wrote, counts included', async () => {
    const f = await business()
    const { ownerReport, kevinReport } = await withReports(f)
    await setView(f, f.terence, { kind: 'mine' })

    const page = await f.terence.as.query(api.reports.list, {
      businessId: f.businessId,
      filter: 'all',
      paginationOpts: { numItems: 20, cursor: null },
    })
    expect(page.page.map((r) => r._id)).toEqual([ownerReport])

    const counts = await f.terence.as.query(api.reports.counts, {
      businessId: f.businessId,
    })
    expect(counts.all).toBe(1)

    // But the report he opens is whole, whoever wrote it.
    const opened = await f.terence.as.query(api.reports.get, {
      businessId: f.businessId,
      reportId: kevinReport,
    })
    expect(opened?._id).toBe(kevinReport)
  })

  /**
   * A view is what he is shown, not what he may do: a note on Kevin's job,
   * opened in "Just my jobs", is exactly as editable as in God view. Only the
   * attach-to-job picker — a list — narrows.
   */
  test('a note on someone else’s job stays editable; only the job picker narrows', async () => {
    const f = await business()
    // Inserted directly, as noteAccess.test.ts does: `notes.create` needs the
    // prosemirror component, and what is under test is who may edit it.
    const noteId = await f.t.run((ctx) =>
      ctx.db.insert('notes', {
        businessId: f.businessId,
        authorMembershipId: f.kevinId,
        lastEditedByMembershipId: f.kevinId,
        jobId: f.kevinJobId,
        title: 'Gate code',
        preview: '',
        plainText: 'Gate code 4421',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    )
    await setView(f, f.terence, { kind: 'mine' })

    const note = await f.terence.as.query(api.notes.get, {
      businessId: f.businessId,
      noteId,
    })
    expect(note?.canEdit).toBe(true)

    const offered = await f.terence.as.query(api.notes.jobOptions, {
      businessId: f.businessId,
      now: Date.now(),
    })
    expect(offered.map((j) => j._id)).toEqual([f.ownerJobId])
  })
})

describe('a view belongs to one sign-in', () => {
  test('his phone can sit on his own jobs while the office machine shows everyone', async () => {
    const f = await business()
    const office = await addSession(f.t, f.terence)
    await setView(f, f.terence, { kind: 'mine' })

    expect(await day(f, f.terence)).toEqual(['Owner visit'])
    expect(await day(f, office)).toEqual(['Kevin visit', 'Owner visit'])
    expect(await viewMode(f, office)).toBe('everyone')
  })

  /** Ids come back when someone is removed and re-added; a view must not. */
  test('a row chosen under another membership, or in another business, is ignored', async () => {
    const f = await business()
    const other = await createBusiness(f.t, f.terence, 'Other Pest')
    await f.t.run(async (ctx) => {
      await ctx.db.insert('sessionViews', {
        sessionId: f.terence.sessionId,
        businessId: f.businessId,
        realMembershipId: f.kevinId,
        mode: 'mine',
        updatedAt: Date.now(),
      })
      await ctx.db.insert('sessionViews', {
        sessionId: f.terence.sessionId,
        businessId: other.businessId,
        realMembershipId: other.ownerMembershipId,
        mode: 'mine',
        updatedAt: Date.now(),
      })
    })
    expect(await viewMode(f, f.terence)).toBe('everyone')
    expect(await day(f, f.terence)).toEqual(['Kevin visit', 'Owner visit'])
  })

  test('someone who does not get the dropdown is unaffected by a row naming them', async () => {
    const f = await business()
    await f.t.run((ctx) =>
      ctx.db.insert('sessionViews', {
        sessionId: f.jo.sessionId,
        businessId: f.businessId,
        realMembershipId: f.joId,
        mode: 'mine',
        updatedAt: Date.now(),
      }),
    )
    const env = await f.jo.as.query((ctx) => requireActor(ctx, f.businessId))
    expect(env.view).toBe('everyone')
    expect(env.listScope).toEqual(env.scope)
    expect(await viewMode(f, f.jo)).toBeNull()
  })

  test('ended sign-ins lose their view on the sweep; live ones keep it', async () => {
    const f = await business()
    const office = await addSession(f.t, f.terence)
    await setView(f, f.terence, { kind: 'mine' })
    await setView(f, office, { kind: 'mine' })

    // The office machine signs out.
    await f.t.run((ctx) =>
      ctx.runMutation(components.betterAuth.adapter.deleteMany, {
        input: {
          model: 'session',
          where: [{ field: '_id', value: office.sessionId }],
        },
        paginationOpts: { numItems: 10, cursor: null },
      }),
    )

    const { deleted } = await f.t.mutation(internal.views.sweepEnded, {})
    expect(deleted).toBe(1)
    const rows = await f.t.run((ctx) => ctx.db.query('sessionViews').collect())
    expect(rows.map((r) => r.sessionId)).toEqual([f.terence.sessionId])
  })
})

describe('someone else’s account, from the same dropdown', () => {
  test('lists everyone he may work in — even while he is in one of them', async () => {
    const f = await business()
    await setView(f, f.terence, { kind: 'account', membershipId: f.kevinId })

    const options = await f.terence.as.query(api.views.options, {
      businessId: f.businessId,
    })
    expect(options?.accounts.map((a) => a.membershipId).sort()).toEqual(
      [f.kevinId, f.joId].sort(),
    )
    expect(options?.me.membershipId).toBe(f.ownerMembershipId)
  })

  test('picking Kevin is a real switch: his day, the banner, the audit', async () => {
    const f = await business()
    await setView(f, f.terence, { kind: 'account', membershipId: f.kevinId })

    expect(await viewMode(f, f.terence)).toBe('account')
    expect(await day(f, f.terence)).toEqual(['Kevin visit'])
    const me = await f.terence.as.query(api.access.me, {
      businessId: f.businessId,
    })
    expect(me.actingAs?.membershipId).toBe(f.kevinId)
  })

  test('Kevin to Jo is one step, recorded as leaving one and entering the other', async () => {
    const f = await business()
    await setView(f, f.terence, { kind: 'account', membershipId: f.kevinId })
    await setView(f, f.terence, { kind: 'account', membershipId: f.joId })

    const me = await f.terence.as.query(api.access.me, {
      businessId: f.businessId,
    })
    expect(me.actingAs?.membershipId).toBe(f.joId)

    const audit = await f.t.run((ctx) => ctx.db.query('auditLog').collect())
    expect(audit.map((a) => [a.action, a.entityId])).toEqual([
      ['switch.start', f.kevinId],
      ['switch.stop', f.kevinId],
      ['switch.start', f.joId],
    ])
    const switches = await f.t.run((ctx) =>
      ctx.db.query('accountSwitches').collect(),
    )
    expect(switches).toHaveLength(1)
  })

  test('the account menu’s own switch still refuses to chain', async () => {
    const f = await business()
    await setView(f, f.terence, { kind: 'account', membershipId: f.kevinId })
    await expect(
      f.terence.as.mutation(api.accountSwitches.start, {
        businessId: f.businessId,
        targetMembershipId: f.joId,
      }),
    ).rejects.toThrow('NO_CHAINING')
  })

  /** "Switch back" returns him to the view he left, not to God view. */
  test('switching back resumes "Just my jobs"', async () => {
    const f = await business()
    await setView(f, f.terence, { kind: 'mine' })
    await setView(f, f.terence, { kind: 'account', membershipId: f.kevinId })
    await f.terence.as.mutation(api.accountSwitches.stop, {
      businessId: f.businessId,
    })

    expect(await viewMode(f, f.terence)).toBe('mine')
    expect(await day(f, f.terence)).toEqual(['Owner visit'])
  })

  test('God view from inside an account closes the switch', async () => {
    const f = await business()
    await setView(f, f.terence, { kind: 'account', membershipId: f.kevinId })
    await setView(f, f.terence, { kind: 'everyone' })

    const me = await f.terence.as.query(api.access.me, {
      businessId: f.businessId,
    })
    expect(me.actingAs).toBeNull()
    expect(await day(f, f.terence)).toEqual(['Kevin visit', 'Owner visit'])
  })

  test('a report he starts inside Kevin’s account does not vanish', async () => {
    const f = await business()
    await setView(f, f.terence, { kind: 'account', membershipId: f.kevinId })

    const reportId = await f.terence.as.mutation(api.reports.create, {
      businessId: f.businessId,
      propertyId: f.propertyId,
      template: 'serviceReport',
      legalBasis: 'APVMA',
      data: {},
    })
    const report = await f.terence.as.query(api.reports.get, {
      businessId: f.businessId,
      reportId,
    })
    expect(report?._id).toBe(reportId)

    const atProperty = await f.terence.as.query(api.reports.listByProperty, {
      businessId: f.businessId,
      propertyId: f.propertyId,
    })
    expect(atProperty.map((r) => r._id)).toContain(reportId)
  })
})

describe('rolling the frontend back', () => {
  test('clearAll returns every device to God view', async () => {
    const f = await business()
    await setView(f, f.terence, { kind: 'mine' })
    const { deleted } = await f.t.mutation(internal.views.clearAll, {})
    expect(deleted).toBe(1)
    expect(await day(f, f.terence)).toEqual(['Kevin visit', 'Owner visit'])
  })
})

describe('who may choose', () => {
  test('nobody but the owner', async () => {
    const f = await business()
    await expect(setView(f, f.jo, { kind: 'mine' })).rejects.toThrow(
      'NO_ACCESS',
    )
    expect(
      await f.jo.as.query(api.views.options, { businessId: f.businessId }),
    ).toBeNull()
  })

  test('and never into the owner, another business or someone who has left', async () => {
    const f = await business()
    const other = await createBusiness(f.t, f.jo, 'Jo’s Other Pest')
    await f.t.run((ctx) => ctx.db.patch(f.joId, { status: 'removed' }))

    for (const membershipId of [
      f.ownerMembershipId,
      other.ownerMembershipId,
      f.joId,
    ]) {
      await expect(
        setView(f, f.terence, { kind: 'account', membershipId }),
      ).rejects.toThrow('NOT_FOUND')
    }
  })

  /** A refused switch leaves him where he was — the transaction is one. */
  test('a refused switch changes nothing', async () => {
    const f = await business()
    await setView(f, f.terence, { kind: 'account', membershipId: f.kevinId })
    await expect(
      setView(f, f.terence, {
        kind: 'account',
        membershipId: f.ownerMembershipId,
      }),
    ).rejects.toThrow('NOT_FOUND')

    const me = await f.terence.as.query(api.access.me, {
      businessId: f.businessId,
    })
    expect(me.actingAs?.membershipId).toBe(f.kevinId)
  })
})

describe('the older read-only "view as"', () => {
  test('a choice made in the dropdown outranks, and clears, a leftover one', async () => {
    const f = await business()
    await f.t.run((ctx) =>
      ctx.db.patch(f.ownerMembershipId, { viewingAsMembershipId: f.kevinId }),
    )
    // Leftover: he is looking through Kevin's eyes.
    expect(await day(f, f.terence)).toEqual(['Kevin visit'])

    await setView(f, f.terence, { kind: 'mine' })
    expect(await day(f, f.terence)).toEqual(['Owner visit'])
    const row = await f.t.run((ctx) => ctx.db.get(f.ownerMembershipId))
    expect(row?.viewingAsMembershipId).toBeUndefined()
  })
})

describe('offboarding', () => {
  test('removing someone removes any view they had chosen', async () => {
    const f = await business()
    // Only the owner can choose today; the row is inserted directly, as it
    // would exist once the choice is widened to contractors.
    await f.t.run((ctx) =>
      ctx.db.insert('sessionViews', {
        sessionId: f.jo.sessionId,
        businessId: f.businessId,
        realMembershipId: f.joId,
        mode: 'mine',
        updatedAt: Date.now(),
      }),
    )
    await f.terence.as.mutation(api.team.remove, {
      businessId: f.businessId,
      membershipId: f.joId,
    })
    const rows = await f.t.run((ctx) => ctx.db.query('sessionViews').collect())
    expect(rows).toEqual([])
  })
})
