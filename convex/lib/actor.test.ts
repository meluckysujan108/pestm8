/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { ConvexError } from 'convex/values'
import { api } from '../_generated/api'
import {
  requireActor,
  requireCapability,
  requireWriteActor,
  sweepExpiredSwitches,
  teamOf,
} from './actor'
import { SWITCH_TTL_MS } from './capabilities'
import {
  addSession,
  createActor,
  createBusiness,
  testApp,
} from '../../test/harness'
import type { Id } from '../_generated/dataModel'
import type { TestActor, TestApp } from '../../test/harness'
import type { Grants, Role } from './capabilities'

/**
 * Resolving who is calling.
 *
 * `capabilities.test.ts` proves the policy refuses the right things given the
 * facts. This proves the facts are assembled from the database correctly — and
 * almost every test here is a way of getting that wrong that would still
 * compile, still pass the policy tests, and still look right in a diff.
 *
 * The recurring one: this codebase already ships a read-only "view as", and the
 * new model ships a read-write "switch". They resolve through the same function
 * and differ by one field. Confusing them promotes every existing read-only
 * grant into write access.
 */

type Fixture = Awaited<ReturnType<typeof scenario>>

async function scenario() {
  const t = testApp()
  const terence = await createActor(t, {
    email: 'terence@coastalpest.test',
    name: 'Terence',
  })
  const { businessId, ownerMembershipId } = await createBusiness(t, terence)

  const jo = await createActor(t, { email: 'jo@jospest.test', name: 'Jo' })
  const kevin = await createActor(t, { email: 'kevin@kp.test', name: 'Kevin' })
  const priya = await createActor(t, { email: 'priya@ex.test', name: 'Priya' })

  // Inserted directly rather than through invitations: nothing writes the
  // contractor role or a team yet, which is exactly the state this module has
  // to work in during the expand phase.
  const joId = await addMember(t, businessId, jo, 'contractor')
  const kevinId = await addMember(t, businessId, kevin, 'subcontractor', {
    parentMembershipId: joId,
  })
  const priyaId = await addMember(t, businessId, priya, 'subcontractor')

  return {
    t,
    businessId,
    terence,
    jo,
    kevin,
    priya,
    ownerMembershipId,
    joId,
    kevinId,
    priyaId,
  }
}

async function addMember(
  t: TestApp,
  businessId: Id<'businesses'>,
  actor: TestActor,
  role: Role,
  extra: {
    parentMembershipId?: Id<'memberships'>
    grants?: Grants
    canViewAllJobs?: boolean
    canViewOtherAccounts?: boolean
  } = {},
) {
  return t.run(async (ctx) =>
    ctx.db.insert('memberships', {
      userId: actor.userId,
      businessId,
      role,
      canViewAllJobs: extra.canViewAllJobs ?? false,
      canViewOtherAccounts: extra.canViewOtherAccounts,
      parentMembershipId: extra.parentMembershipId,
      grants: extra.grants,
      colour: '#0ea5e9',
      status: 'active',
      createdAt: Date.now(),
    }),
  )
}

/** Open a switch for one SESSION, the way the real mutation will. */
async function openSwitch(
  f: Fixture,
  actor: TestActor,
  realMembershipId: Id<'memberships'>,
  targetMembershipId: Id<'memberships'>,
  opts: { expiresAt?: number; businessId?: Id<'businesses'> } = {},
) {
  const now = Date.now()
  return f.t.run(async (ctx) =>
    ctx.db.insert('accountSwitches', {
      sessionId: actor.sessionId,
      businessId: opts.businessId ?? f.businessId,
      realMembershipId,
      targetMembershipId,
      startedAt: now,
      expiresAt: opts.expiresAt ?? now + SWITCH_TTL_MS,
    }),
  )
}

const read = (f: Fixture, actor: TestActor) =>
  actor.as.run((ctx) => requireActor(ctx, f.businessId))

const write = (f: Fixture, actor: TestActor) =>
  actor.as.run((ctx) => requireWriteActor(ctx, f.businessId))

describe('who is calling', () => {
  test('a member resolves to themselves, twice over', async () => {
    const f = await scenario()
    const env = await read(f, f.kevin)

    expect(env.actor.real._id).toBe(f.kevinId)
    expect(env.actor.acting._id).toBe(f.kevinId)
    expect(env.readScope._id).toBe(f.kevinId)
    expect(env.actor.session).toBeNull()
    expect(env.viewingAsLegacy).toBe(false)
  })

  /** Same opaque error for both, on purpose: telling a stranger that the
   * business exists is itself a disclosure. */
  test('a stranger and a removed member get the same refusal', async () => {
    const f = await scenario()
    const stranger = await createActor(f.t, { email: 'nobody@ex.test' })

    await expect(read(f, stranger)).rejects.toThrow('NO_ACCESS')

    await f.t.run((ctx) => ctx.db.patch(f.kevinId, { status: 'removed' }))
    await expect(read(f, f.kevin)).rejects.toThrow('NO_ACCESS')
  })

  test('no session at all is unauthenticated, not unauthorised', async () => {
    const f = await scenario()
    await expect(
      f.t.run((ctx) => requireActor(ctx, f.businessId)),
    ).rejects.toThrow('Unauthenticated')
  })

  /**
   * Two resolutions inside one request must not be able to disagree — several
   * functions resolve access twice today, and a switch lapsing between the two
   * would leave one mutation reading as one person and writing as another.
   */
  test('resolves once per request', async () => {
    const f = await scenario()
    // Compared inside the run: `t.run` clones what it returns, so object
    // identity does not survive the boundary.
    const shared = await f.kevin.as.run(async (ctx) => {
      const a = await requireActor(ctx, f.businessId)
      const b = await requireActor(ctx, f.businessId)
      return a.actor.real === b.actor.real
    })
    expect(shared).toBe(true)
  })
})

describe('the legacy read-only view-as', () => {
  /**
   * THE trap this module is shaped around.
   *
   * `viewingAsMembershipId` grants looking. If it were resolved into `acting`,
   * every holder would silently gain the right to write in that account and to
   * be recorded as the author of what they wrote — an install-wide privilege
   * upgrade, invisible in a diff, arriving first in the destructive paths.
   */
  test('never becomes the account being acted in', async () => {
    const f = await scenario()
    await f.t.run((ctx) =>
      ctx.db.patch(f.ownerMembershipId, { viewingAsMembershipId: f.kevinId }),
    )

    const env = await read(f, f.terence)
    expect(env.readScope._id).toBe(f.kevinId)
    expect(env.actor.acting._id).toBe(f.ownerMembershipId)
    expect(env.viewingAsLegacy).toBe(true)

    const w = await write(f, f.terence)
    expect(w.actor.acting._id).toBe(f.ownerMembershipId)
  })

  /**
   * The point of the feature is "show me what Kevin sees". Scoping it by the
   * VIEWER's capabilities would show an owner — who can see everything — the
   * whole business, which is not a wrong answer to the question so much as the
   * feature not working at all.
   */
  test('scopes to what the target sees, not to what the viewer can see', async () => {
    const f = await scenario()
    await f.t.run((ctx) =>
      ctx.db.patch(f.ownerMembershipId, { viewingAsMembershipId: f.kevinId }),
    )

    const env = await read(f, f.terence)
    expect(env.scope).toEqual({ kind: 'own', membershipId: f.kevinId })

    // And without the selection, the same owner sees everything.
    await f.t.run((ctx) =>
      ctx.db.patch(f.ownerMembershipId, { viewingAsMembershipId: undefined }),
    )
    expect((await read(f, f.terence)).scope).toEqual({ kind: 'business' })
  })

  test('is ignored without the old grant, and honoured with it', async () => {
    const f = await scenario()
    await f.t.run((ctx) =>
      ctx.db.patch(f.priyaId, { viewingAsMembershipId: f.kevinId }),
    )
    expect((await read(f, f.priya)).readScope._id).toBe(f.priyaId)

    await f.t.run((ctx) =>
      ctx.db.patch(f.priyaId, { canViewOtherAccounts: true }),
    )
    expect((await read(f, f.priya)).readScope._id).toBe(f.kevinId)
  })

  /** Owner invisibility does not depend on the new model being switched on. */
  test('can never be pointed at the owner', async () => {
    const f = await scenario()
    await f.t.run((ctx) =>
      ctx.db.patch(f.priyaId, {
        canViewOtherAccounts: true,
        viewingAsMembershipId: f.ownerMembershipId,
      }),
    )
    expect((await read(f, f.priya)).readScope._id).toBe(f.priyaId)
  })

  /** Fails open, deliberately: a stale selection should stop taking effect,
   * not break the page mid-shift. */
  test('falls back silently when the target is gone', async () => {
    const f = await scenario()
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.ownerMembershipId, {
        viewingAsMembershipId: f.kevinId,
      })
      await ctx.db.patch(f.kevinId, { status: 'removed' })
    })

    const env = await read(f, f.terence)
    expect(env.readScope._id).toBe(f.ownerMembershipId)
    expect(env.actor.degraded).toBeNull()
  })
})

describe('switching into an account', () => {
  test('the owner works inside a subcontractor account', async () => {
    const f = await scenario()
    await openSwitch(f, f.terence, f.ownerMembershipId, f.kevinId)

    const env = await read(f, f.terence)
    expect(env.actor.real._id).toBe(f.ownerMembershipId)
    expect(env.actor.acting._id).toBe(f.kevinId)
    expect(env.readScope._id).toBe(f.kevinId)
    expect(env.viewingAsLegacy).toBe(false)

    const w = await write(f, f.terence)
    expect(w.actor.acting._id).toBe(f.kevinId)
  })

  /** The rule that makes switching safe to offer: you switch back to
   * administer. Otherwise a switch is a way to keep your powers while wearing
   * someone else's name. */
  test('administration drops while switched', async () => {
    const f = await scenario()
    expect((await read(f, f.terence)).caps['team.manage']).toBe(true)

    await openSwitch(f, f.terence, f.ownerMembershipId, f.kevinId)
    const env = await read(f, f.terence)
    expect(env.caps['team.manage']).toBe(false)
    expect(() => requireCapability(env, 'team.manage')).toThrow(ConvexError)
  })

  /**
   * Keyed by session, not by person — so the switch on the office iPad does not
   * follow them to the phone in their pocket. With writes attributed to the
   * account, that is how the wrong name ends up on a report.
   */
  test('belongs to one device, not to the person', async () => {
    const f = await scenario()
    await openSwitch(f, f.terence, f.ownerMembershipId, f.kevinId)
    const phone = await addSession(f.t, f.terence)

    expect((await read(f, f.terence)).actor.acting._id).toBe(f.kevinId)
    expect((await read(f, phone)).actor.acting._id).toBe(f.ownerMembershipId)
  })

  /**
   * Reads fail open and writes fail closed, and the asymmetry is the whole
   * point: a read that falls back shows you your own schedule; a write that
   * falls back stamps your name on a document meant to carry someone else's.
   */
  test('an expired switch degrades a read and refuses a write', async () => {
    const f = await scenario()
    await openSwitch(f, f.terence, f.ownerMembershipId, f.kevinId, {
      expiresAt: Date.now() - 1,
    })

    const env = await read(f, f.terence)
    expect(env.actor.acting._id).toBe(f.ownerMembershipId)
    expect(env.actor.degraded).toBe('SWITCH_EXPIRED')

    await expect(write(f, f.terence)).rejects.toThrow('SWITCH_EXPIRED')
  })

  /** The grant is re-derived on every request, so revoking it takes effect on
   * the next one whether or not anything deletes the switch row. */
  test('a revoked grant ends the switch without anyone cleaning up', async () => {
    const f = await scenario()
    await f.t.run((ctx) =>
      ctx.db.patch(f.kevinId, {
        grants: {
          switchInto: f.joId,
          clientDirectory: false,
          prices: false,
          otherSchedules: false,
        },
      }),
    )
    await openSwitch(f, f.kevin, f.kevinId, f.joId)
    expect((await read(f, f.kevin)).actor.acting._id).toBe(f.joId)

    await f.t.run((ctx) =>
      ctx.db.patch(f.kevinId, {
        grants: {
          switchInto: null,
          clientDirectory: false,
          prices: false,
          otherSchedules: false,
        },
      }),
    )
    const env = await read(f, f.kevin)
    expect(env.actor.acting._id).toBe(f.kevinId)
    expect(env.actor.degraded).toBe('SWITCH_REVOKED')
    await expect(write(f, f.kevin)).rejects.toThrow('SWITCH_REVOKED')
  })

  /** Moving someone to another team makes the grant inert by construction —
   * `switchInto` names the contractor who gave it. */
  test('a team move ends it too', async () => {
    const f = await scenario()
    await f.t.run((ctx) =>
      ctx.db.patch(f.kevinId, {
        grants: {
          switchInto: f.joId,
          clientDirectory: false,
          prices: false,
          otherSchedules: false,
        },
      }),
    )
    await openSwitch(f, f.kevin, f.kevinId, f.joId)

    await f.t.run((ctx) =>
      ctx.db.patch(f.kevinId, { parentMembershipId: f.priyaId }),
    )
    expect((await read(f, f.kevin)).actor.degraded).toBe('SWITCH_TEAM_CHANGED')
  })

  /**
   * A person can belong to more than one business. A switch open in one must
   * not refuse or annotate requests in the other — refusing would break that
   * business outright, and a banner there would be about nothing.
   */
  test('a switch in another business is ignored, not reported', async () => {
    const f = await scenario()
    const other = await createBusiness(f.t, f.terence, 'Inland Pest')
    await openSwitch(f, f.terence, f.ownerMembershipId, f.kevinId)

    const env = await f.terence.as.run((ctx) =>
      requireActor(ctx, other.businessId),
    )
    expect(env.actor.acting._id).toBe(other.ownerMembershipId)
    expect(env.actor.degraded).toBeNull()
    expect(env.viewingAsLegacy).toBe(false)
  })

  /** You cannot be looking through one person's eyes while working in
   * another's account. */
  test('wins over a stale legacy selection', async () => {
    const f = await scenario()
    await f.t.run((ctx) =>
      ctx.db.patch(f.ownerMembershipId, { viewingAsMembershipId: f.priyaId }),
    )
    await openSwitch(f, f.terence, f.ownerMembershipId, f.kevinId)

    const env = await read(f, f.terence)
    expect(env.readScope._id).toBe(f.kevinId)
    expect(env.viewingAsLegacy).toBe(false)
  })

  /** A switch must not launder a toggle: intersecting is what stops someone
   * acquiring sight of the whole schedule by borrowing an account that has it. */
  test('does not widen what the real person may see', async () => {
    const f = await scenario()
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.kevinId, {
        parentMembershipId: f.joId,
        grants: {
          switchInto: f.joId,
          clientDirectory: false,
          prices: false,
          otherSchedules: false,
        },
      })
      await ctx.db.patch(f.joId, {
        grants: {
          switchInto: null,
          clientDirectory: true,
          prices: true,
          otherSchedules: true,
        },
      })
    })
    await openSwitch(f, f.kevin, f.kevinId, f.joId)

    const env = await read(f, f.kevin)
    expect(env.actor.acting._id).toBe(f.joId)
    expect(env.caps['schedules.seeOthers']).toBe(false)
    expect(env.caps['prices.see']).toBe(false)
  })
})

describe('row scope', () => {
  test('the owner sees the business; a subcontractor sees their own', async () => {
    const f = await scenario()
    expect((await read(f, f.terence)).scope).toEqual({ kind: 'business' })
    expect((await read(f, f.priya)).scope).toEqual({
      kind: 'own',
      membershipId: f.priyaId,
    })
  })

  test('a contractor without the schedule toggle sees their team', async () => {
    const f = await scenario()
    await f.t.run((ctx) =>
      ctx.db.patch(f.joId, {
        grants: {
          switchInto: null,
          clientDirectory: true,
          prices: true,
          otherSchedules: false,
        },
      }),
    )

    const env = await read(f, f.jo)
    expect(env.scope.kind).toBe('team')
    expect(
      env.scope.kind === 'team' ? [...env.scope.membershipIds].sort() : [],
    ).toEqual([f.joId, f.kevinId].sort())
  })
})

describe('the team index', () => {
  test('returns the children of one contractor, and no one else', async () => {
    const f = await scenario()
    const team = await f.t.run((ctx) => teamOf(ctx, f.businessId, f.joId))
    expect(team.map((m) => m._id)).toEqual([f.kevinId])
  })

  test('leaves out people who have been removed', async () => {
    const f = await scenario()
    await f.t.run((ctx) => ctx.db.patch(f.kevinId, { status: 'removed' }))
    expect(await f.t.run((ctx) => teamOf(ctx, f.businessId, f.joId))).toEqual(
      [],
    )
  })
})

const ALL_ON: Grants = {
  switchInto: null,
  clientDirectory: true,
  prices: true,
  otherSchedules: true,
}
const ALL_OFF: Grants = {
  switchInto: null,
  clientDirectory: false,
  prices: false,
  otherSchedules: false,
}

describe('a contractor is a ceiling on their own team', () => {
  /**
   * The rule that dies most quietly. Nothing in the envelope looks wrong when
   * the parent row is simply not loaded — every capability is still computed,
   * just against one membership instead of two — and a stale grant on the
   * subcontractor then outlives the contractor's own access being cut.
   *
   * This test exists because deleting the parent lookup altogether left the
   * first twenty-two tests here passing.
   */
  test('a subcontractor cannot keep a grant their contractor has lost', async () => {
    const f = await scenario()
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.joId, { grants: ALL_OFF })
      await ctx.db.patch(f.kevinId, { grants: ALL_ON })
    })

    const env = await read(f, f.kevin)
    expect(env.caps['prices.see']).toBe(false)
    expect(env.caps['clients.directory']).toBe(false)
    expect(env.caps['schedules.seeOthers']).toBe(false)
  })

  test('and keeps the ones their contractor still holds', async () => {
    const f = await scenario()
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.joId, { grants: ALL_ON })
      await ctx.db.patch(f.kevinId, { grants: ALL_ON })
    })
    expect((await read(f, f.kevin)).caps['prices.see']).toBe(true)
  })

  /** The ceiling has to be applied to the ACCOUNT being worked in, not only to
   * the person doing the working. */
  test('the ceiling still applies to the account being switched into', async () => {
    const f = await scenario()
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.joId, { grants: ALL_OFF })
      await ctx.db.patch(f.kevinId, { grants: ALL_ON })
    })
    await openSwitch(f, f.terence, f.ownerMembershipId, f.kevinId)

    expect((await read(f, f.terence)).caps['prices.see']).toBe(false)
  })
})

describe('a write never inherits the read-only view-as', () => {
  /**
   * `acting` was only ever half the path. `scope` is the row filter a mutation
   * author is actually offered, so a write envelope carrying the target's scope
   * turns the ordinary gate — refuse anything out of scope — into permission
   * over every row the TARGET can see, with the write attributed to the caller.
   */
  test('the write envelope scopes to the writer, not to who they are watching', async () => {
    const f = await scenario()
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.priyaId, {
        canViewOtherAccounts: true,
        viewingAsMembershipId: f.kevinId,
      })
      // Jo as well: a subcontractor's sight is ceilinged by their contractor's,
      // so without this Kevin would not have business scope to inherit.
      await ctx.db.patch(f.joId, { grants: ALL_ON })
      await ctx.db.patch(f.kevinId, { grants: ALL_ON })
    })

    // Reading, she sees through Kevin's eyes — business-wide, because that is
    // what Kevin can see.
    const r = await read(f, f.priya)
    expect(r.readScope._id).toBe(f.kevinId)
    expect(r.scope).toEqual({ kind: 'business' })

    // Writing, she is nobody but herself.
    const w = await write(f, f.priya)
    expect(w.actor.acting._id).toBe(f.priyaId)
    expect(w.readScope._id).toBe(f.priyaId)
    expect(w.scope).toEqual({ kind: 'own', membershipId: f.priyaId })
    expect(w.viewingAsLegacy).toBe(false)
  })
})

describe('when a switch stops being valid', () => {
  /**
   * The banner would have said "your switch ended, you are back in your own
   * account" while the server served a third person's rows — the one left over
   * in the legacy column from some earlier session.
   */
  test('it returns you to yourself, not to a stale view-as selection', async () => {
    const f = await scenario()
    await f.t.run((ctx) =>
      ctx.db.patch(f.ownerMembershipId, { viewingAsMembershipId: f.priyaId }),
    )
    await openSwitch(f, f.terence, f.ownerMembershipId, f.kevinId, {
      expiresAt: Date.now() - 1,
    })

    const env = await read(f, f.terence)
    expect(env.actor.degraded).toBe('SWITCH_EXPIRED')
    // Back to Terence — NOT to Priya, whom the legacy column still names.
    expect(env.readScope._id).toBe(f.ownerMembershipId)
    expect(env.viewingAsLegacy).toBe(false)

    await expect(write(f, f.terence)).rejects.toThrow('SWITCH_EXPIRED')
  })
})

describe('switch rows that should not exist', () => {
  /** A duplicate is a bug in the lifecycle mutation. It must not become an
   * outage for the person holding the phone — `.unique()` would have thrown and
   * locked that session out of every business in the app. */
  test('two rows for one session do not lock anyone out', async () => {
    const f = await scenario()
    await openSwitch(f, f.terence, f.ownerMembershipId, f.priyaId)
    await openSwitch(f, f.terence, f.ownerMembershipId, f.kevinId)

    const env = await read(f, f.terence)
    expect(env.actor.acting._id).toBe(f.kevinId)
  })

  /** Someone removed and re-invited gets a NEW membership id; a row left from
   * their previous stint must not still apply. */
  test('a row opened for a different membership is ignored', async () => {
    const f = await scenario()
    await openSwitch(f, f.terence, f.joId, f.kevinId)

    const env = await read(f, f.terence)
    expect(env.actor.acting._id).toBe(f.ownerMembershipId)
    expect(env.actor.degraded).toBeNull()
  })

  test('the sweep clears the expired ones and leaves the rest', async () => {
    const f = await scenario()
    await openSwitch(f, f.terence, f.ownerMembershipId, f.kevinId, {
      expiresAt: Date.now() - 1,
    })
    const live = await addSession(f.t, f.jo)
    await openSwitch(f, live, f.joId, f.kevinId)

    expect(await f.t.run((ctx) => sweepExpiredSwitches(ctx))).toBe(1)
    expect(
      await f.t.run((ctx) => ctx.db.query('accountSwitches').collect()),
    ).toHaveLength(1)
  })
})

describe('read scope while switched', () => {
  /** Asserting the capability set is not the same as asserting what comes
   * back: `scope` is what the queries actually filter on. */
  test('is the account being worked in, narrowed to what both may see', async () => {
    const f = await scenario()
    await openSwitch(f, f.terence, f.ownerMembershipId, f.priyaId)

    expect((await read(f, f.terence)).scope).toEqual({
      kind: 'own',
      membershipId: f.priyaId,
    })
  })

  test('a switch into someone with wider sight does not widen it', async () => {
    const f = await scenario()
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.kevinId, {
        grants: { ...ALL_OFF, switchInto: f.joId },
      })
      await ctx.db.patch(f.joId, { grants: ALL_ON })
    })
    await openSwitch(f, f.kevin, f.kevinId, f.joId)

    const env = await read(f, f.kevin)
    expect(env.actor.acting._id).toBe(f.joId)
    expect(env.scope.kind).toBe('team')
    expect(
      env.scope.kind === 'team' ? [...env.scope.membershipIds].sort() : [],
    ).toEqual([f.joId, f.kevinId].sort())
  })
})

describe('the legacy view-as, at the edges', () => {
  test('never reaches across businesses', async () => {
    const f = await scenario()
    const other = await createBusiness(f.t, f.jo, 'Inland Pest')
    await f.t.run((ctx) =>
      ctx.db.patch(f.ownerMembershipId, {
        viewingAsMembershipId: other.ownerMembershipId,
      }),
    )
    expect((await read(f, f.terence)).readScope._id).toBe(f.ownerMembershipId)
  })

  test('is ignored when it points at someone who was removed', async () => {
    const f = await scenario()
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.priyaId, {
        canViewOtherAccounts: true,
        viewingAsMembershipId: f.kevinId,
      })
      await ctx.db.patch(f.kevinId, { status: 'removed' })
    })
    expect((await read(f, f.priya)).readScope._id).toBe(f.priyaId)
  })
})

describe('which roles may be handed out', () => {
  /**
   * The owner account is the key to the business and there is exactly one. The
   * invite paths already refused it; `setRole` did not, so an owner could
   * promote someone into a second, equally invisible owner — a state the model
   * has no way to represent (whose roster hides whom?).
   */
  test('nobody can be promoted to owner', async () => {
    const f = await scenario()
    await expect(
      f.terence.as.mutation(api.memberships.setRole, {
        businessId: f.businessId,
        membershipId: f.priyaId,
        role: 'owner',
      }),
    ).rejects.toThrow('OWNER_INVITE_FORBIDDEN')
  })

  /**
   * The column exists before the code that fills it — expand before migrate —
   * but nothing yet assigns a team. A contractor minted today would hold
   * business-wide `team.manage` with no team to scope it to.
   */
  test('nor to contractor, until a contractor can have a team', async () => {
    const f = await scenario()
    await expect(
      f.terence.as.mutation(api.memberships.setRole, {
        businessId: f.businessId,
        membershipId: f.priyaId,
        role: 'contractor',
      }),
    ).rejects.toThrow('ROLE_NOT_ASSIGNABLE')
  })

  test('the role people actually get still works', async () => {
    const f = await scenario()
    await f.terence.as.mutation(api.memberships.setRole, {
      businessId: f.businessId,
      membershipId: f.priyaId,
      role: 'subcontractor',
    })
    const row = await f.t.run((ctx) => ctx.db.get(f.priyaId))
    expect(row?.role).toBe('subcontractor')
  })
})

describe('administering the business', () => {
  /** The capability, not the role, is the gate now — and for an owner with
   * nobody switched they are the same answer, which is what makes this slice
   * safe to ship. */
  test('a subcontractor is refused, an owner is not', async () => {
    const f = await scenario()
    await expect(
      f.priya.as.mutation(api.memberships.setRole, {
        businessId: f.businessId,
        membershipId: f.kevinId,
        role: 'subcontractor',
      }),
    ).rejects.toThrow('NO_ACCESS')

    await expect(
      f.priya.as.query(api.invitations.listForBusiness, {
        businessId: f.businessId,
      }),
    ).rejects.toThrow('NO_ACCESS')
  })

  /**
   * The rule that makes switching safe to offer: you switch back to
   * administer. Without it, "work in Kevin's account" would also mean "keep
   * every owner power while wearing Kevin's name".
   */
  test('an owner working inside someone’s account cannot administer', async () => {
    const f = await scenario()
    await openSwitch(f, f.terence, f.ownerMembershipId, f.kevinId)

    await expect(
      f.terence.as.mutation(api.memberships.setRole, {
        businessId: f.businessId,
        membershipId: f.priyaId,
        role: 'subcontractor',
      }),
    ).rejects.toThrow('NO_ACCESS')
  })
})

describe('the owner is not on anyone else’s roster', () => {
  /**
   * `memberships.listForBusiness` feeds six screens — the schedule filter bar,
   * the assignee picker, the job detail sheet, both note surfaces and Team
   * settings — and returned every member's name, email, licence number and
   * phone to anyone who asked. It is also what a switch-target list would be
   * built from, so it would have inherited the leak directly.
   */
  test('a subcontractor’s roster does not contain them', async () => {
    const f = await scenario()
    const roster = await f.priya.as.query(api.memberships.listForBusiness, {
      businessId: f.businessId,
    })
    expect(roster.map((m) => m._id)).not.toContain(f.ownerMembershipId)
    expect(roster.map((m) => m.role)).not.toContain('owner')
  })

  test('nor a contractor’s', async () => {
    const f = await scenario()
    const roster = await f.jo.as.query(api.memberships.listForBusiness, {
      businessId: f.businessId,
    })
    expect(roster.map((m) => m._id)).not.toContain(f.ownerMembershipId)
  })

  test('the owner still sees everyone, including themselves', async () => {
    const f = await scenario()
    const roster = await f.terence.as.query(api.memberships.listForBusiness, {
      businessId: f.businessId,
    })
    expect(roster.map((m) => m._id).sort()).toEqual(
      [f.ownerMembershipId, f.joId, f.kevinId, f.priyaId].sort(),
    )
  })

  /**
   * Hides the person, not the work. Switched into a subcontractor, the owner
   * is looking through eyes that cannot see them — including at their own
   * row, which is the point: the disguise has to hold from the inside, or the
   * first thing anyone does with a borrowed account is check.
   */
  test('and cannot see themselves while working in someone else’s account', async () => {
    const f = await scenario()
    await openSwitch(f, f.terence, f.ownerMembershipId, f.kevinId)

    const roster = await f.terence.as.query(api.memberships.listForBusiness, {
      businessId: f.businessId,
    })
    expect(roster.map((m) => m._id)).not.toContain(f.ownerMembershipId)
  })
})

describe('two people on one draft', () => {
  async function draft() {
    const f = await scenario()
    const propertyId = await f.t.run(async (ctx) => {
      const clientId = await ctx.db.insert('clients', {
        businessId: f.businessId,
        kind: 'person',
        name: 'J. Nguyen',
        createdAt: 0,
        updatedAt: 0,
      })
      return ctx.db.insert('properties', {
        businessId: f.businessId,
        clientId,
        addressLine: '12 Wattle Street',
        suburb: 'Bayswater',
        state: 'WA',
        postcode: '6053',
        createdAt: 0,
      })
    })
    const reportId = await f.t.run((ctx) =>
      ctx.db.insert('reports', {
        businessId: f.businessId,
        propertyId,
        authorMembershipId: f.kevinId,
        template: 'serviceReport',
        legalBasis: 'APVMA',
        status: 'draft',
        data: { findings: 'ants under sink' },
        photoIds: [],
        createdAt: 0,
      }),
    )
    return { ...f, reportId }
  }

  const save = (
    f: Awaited<ReturnType<typeof draft>>,
    data: Record<string, unknown>,
    base?: Record<string, unknown>,
  ) =>
    f.kevin.as.mutation(api.reports.saveDraft, {
      businessId: f.businessId,
      reportId: f.reportId,
      data,
      ...(base ? { base } : {}),
    })

  const stored = (f: Awaited<ReturnType<typeof draft>>) =>
    f.t.run(async (ctx) => (await ctx.db.get(f.reportId))?.data)

  /**
   * The everyday case once someone can work in another person's account: a
   * helper fills in one section while the holder answers another. Before this,
   * whichever autosave landed second erased the other's answers — with no
   * error, and no copy of the lost text anywhere but that form.
   */
  test('both keep their answers', async () => {
    const f = await draft()
    const base = { findings: 'ants under sink' }

    // The holder, on their phone, adds a recommendation.
    await save(f, { ...base, recommendation: 'bait stations' }, base)
    // The helper, on the laptop, had loaded the same base and adds a risk.
    await save(f, { ...base, risk: 'pets on site' }, base)

    expect(await stored(f)).toEqual({
      findings: 'ants under sink',
      recommendation: 'bait stations',
      risk: 'pets on site',
    })
  })

  /** The same answer edited two different ways is the one case that genuinely
   * needs a person, so it is refused rather than guessed at. */
  test('the same answer, changed two ways, is refused', async () => {
    const f = await draft()
    const base = { findings: 'ants under sink' }

    await save(f, { findings: 'ants under sink, treated' }, base)
    await expect(
      save(f, { findings: 'German cockroaches' }, base),
    ).rejects.toThrow('DRAFT_CONFLICT')

    // And the first person's answer is still there, untouched.
    expect(await stored(f)).toEqual({ findings: 'ants under sink, treated' })
  })

  test('clearing an answer is an edit like any other', async () => {
    const f = await draft()
    const base = { findings: 'ants under sink', risk: 'pets on site' }
    await f.t.run((ctx) => ctx.db.patch(f.reportId, { data: base }))

    await save(f, { findings: 'ants under sink' }, base)
    expect(await stored(f)).toEqual({ findings: 'ants under sink' })
  })

  /**
   * The deployed client does not send a base, and must keep working exactly as
   * it does now — otherwise this ships ahead of the frontend and every autosave
   * in the field starts failing.
   */
  test('a client that sends no base still replaces, as it always has', async () => {
    const f = await draft()
    await save(f, { findings: 'replaced wholesale' })
    expect(await stored(f)).toEqual({ findings: 'replaced wholesale' })
  })
})
