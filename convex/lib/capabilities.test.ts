import { describe, expect, test } from 'vitest'
import {
  DEFAULT_GRANTS,
  NO_GRANTS,
  ROLE_POLICY,
  beginSwitch,
  canBookOnto,
  canChooseView,
  canDispatchTo,
  canEditJob,
  canFinaliseReport,
  canManageMember,
  canSetLicence,
  canSwitchInto,
  capabilitiesOf,
  clampGrants,
  clientScope,
  effectiveCapabilities,
  isInScope,
  isSwitched,
  jobScope,
  licenceStatus,
  mergeDraft,
  recomputeGrants,
  resolveActorForRead,
  resolveActorForWrite,
  switchTargets,
  writeAttribution,
} from './capabilities'
import type {
  Capability,
  Grants,
  MembershipFacts,
  ReadActor,
  ReportFacts,
  Role,
  SwitchSession,
} from './capabilities'
import type { DataModel, Id } from '../_generated/dataModel'

type TableName = keyof DataModel

/**
 * The access model, tested as the attempts it exists to refuse.
 *
 * Every escalation case here is one somebody actually tried to talk their way
 * through during review: laundering a toggle through a switch, keeping a grant
 * across a team move, writing as someone after the switch ended, finding the
 * owner by elimination, signing a certificate under another person's licence.
 */

const id = <T extends TableName>(value: string) => value as Id<T>

const OWNER = id<'memberships'>('m_owner')
const CONTRACTOR = id<'memberships'>('m_contractor')
const CONTRACTOR_2 = id<'memberships'>('m_contractor2')
const KEVIN = id<'memberships'>('m_kevin')
const PRIYA = id<'memberships'>('m_priya')
const OUTSIDER = id<'memberships'>('m_outsider')
const BUSINESS = id<'businesses'>('b_coastal')
const OTHER_BUSINESS = id<'businesses'>('b_other')

function member(
  _id: Id<'memberships'>,
  role: Role,
  overrides: Partial<MembershipFacts> = {},
): MembershipFacts {
  return {
    _id,
    businessId: BUSINESS,
    role,
    status: 'active',
    parentMembershipId: null,
    grants: DEFAULT_GRANTS[role],
    licence: { number: 'PMT-1234' },
    ...overrides,
  }
}

const owner = () => member(OWNER, 'owner')
const contractor = () => member(CONTRACTOR, 'contractor')
const sub = (overrides: Partial<MembershipFacts> = {}) =>
  member(KEVIN, 'subcontractor', {
    parentMembershipId: CONTRACTOR,
    ...overrides,
  })

/** Not switched. */
function self(m: MembershipFacts): ReadActor {
  return { real: m, acting: m, session: null, degraded: null }
}

/** Switched, having already passed the door. */
function switched(real: MembershipFacts, acting: MembershipFacts): ReadActor {
  return {
    real,
    acting,
    session: beginSwitch(acting._id, Date.now()),
    degraded: null,
  }
}

const grants = (overrides: Partial<Grants> = {}): Grants => ({
  ...NO_GRANTS,
  ...overrides,
})

describe('the policy table', () => {
  test('decides every capability for every role, with no fallthrough', () => {
    const capabilities = Object.keys(ROLE_POLICY.owner) as Array<Capability>
    for (const role of ['owner', 'contractor', 'subcontractor'] as const) {
      for (const capability of capabilities) {
        expect(ROLE_POLICY[role][capability]).toBeDefined()
      }
    }
  })

  test('a subcontractor can never hold an admin capability, however generous the grants', () => {
    const generous = sub({
      grants: grants({
        clientDirectory: true,
        prices: true,
        otherSchedules: true,
        switchInto: CONTRACTOR,
      }),
    })
    const caps = capabilitiesOf(generous, contractor())
    expect(caps['team.manage']).toBe(false)
    expect(caps['business.manage']).toBe(false)
    expect(caps['templates.manage']).toBe(false)
    expect(caps['clients.manage']).toBe(false)
  })

  test('a subcontractor can book their own next visit, and nobody else', () => {
    const actor = self(sub())
    expect(capabilitiesOf(actor.real, contractor())['jobs.dispatch']).toBe(true)
    expect(canDispatchTo(actor, sub())).toBe(true)
    expect(
      canDispatchTo(
        actor,
        member(PRIYA, 'subcontractor', { parentMembershipId: CONTRACTOR }),
      ),
    ).toBe(false)
    expect(canDispatchTo(actor, contractor())).toBe(false)
  })
})

describe('who a booking may go onto', () => {
  test('the owner books anyone, himself included', () => {
    for (const assignee of [OWNER, CONTRACTOR, KEVIN, PRIYA]) {
      expect(canBookOnto(owner(), assignee)).toBe(true)
    }
  })

  test('anyone else books themselves and nobody else — the owner least of all', () => {
    // The case the pickers exist for: once the owner is on everyone's roster,
    // a form that offered him to a subcontractor would be refused on submit.
    expect(canBookOnto(sub(), KEVIN)).toBe(true)
    expect(canBookOnto(sub(), OWNER)).toBe(false)
    expect(canBookOnto(sub(), PRIYA)).toBe(false)
    expect(canBookOnto(sub(), CONTRACTOR)).toBe(false)
  })

  test('a contractor is held to the same rule the mutations still enforce, not to canDispatchTo', () => {
    const priya = member(PRIYA, 'subcontractor', {
      parentMembershipId: CONTRACTOR,
    })
    expect(canDispatchTo(self(contractor()), priya)).toBe(true)
    expect(canBookOnto(contractor(), PRIYA)).toBe(false)
    expect(canBookOnto(contractor(), CONTRACTOR)).toBe(true)
  })
})

describe('who chooses a view', () => {
  test('the owner, and nobody else yet', () => {
    expect(canChooseView(owner())).toBe(true)
    expect(canChooseView(contractor())).toBe(false)
    expect(canChooseView(sub())).toBe(false)
  })
})

describe('a grant never outruns the person who gave it', () => {
  test("a subcontractor loses prices when their contractor's prices are turned off", () => {
    const kevin = sub({ grants: grants({ prices: true }) })
    const stingy = member(CONTRACTOR, 'contractor', {
      grants: grants({ prices: false }),
    })

    expect(capabilitiesOf(kevin, contractor())['prices.see']).toBe(true)
    // No cleanup mutation runs in between — the ceiling is applied on read, so
    // the two can never disagree.
    expect(capabilitiesOf(kevin, stingy)['prices.see']).toBe(false)
  })

  test('a contractor cannot grant what they do not hold', () => {
    const stingy = member(CONTRACTOR, 'contractor', {
      grants: grants({ prices: false, clientDirectory: true }),
    })
    const clamped = clampGrants(
      self(stingy),
      sub(),
      grants({ prices: true, clientDirectory: true, otherSchedules: true }),
    )
    expect(clamped.prices).toBe(false)
    expect(clamped.clientDirectory).toBe(true)
    expect(clamped.otherSchedules).toBe(false)
  })

  test('"can work in my account" can only ever name the current contractor', () => {
    // The owner tries to point Kevin at a contractor he does not belong to.
    // Allowed to persist, it would lie dormant and then activate on a later
    // team move.
    const clamped = clampGrants(
      self(owner()),
      sub(),
      grants({ switchInto: CONTRACTOR_2 }),
    )
    expect(clamped.switchInto).toBeNull()

    const legitimate = clampGrants(
      self(owner()),
      sub(),
      grants({ switchInto: CONTRACTOR }),
    )
    expect(legitimate.switchInto).toBe(CONTRACTOR)
  })

  test('moving someone to another team drops the grant they were given', () => {
    const moved = sub({
      parentMembershipId: CONTRACTOR_2,
      grants: grants({ switchInto: CONTRACTOR, prices: true }),
    })
    const newParent = member(CONTRACTOR_2, 'contractor')
    expect(recomputeGrants(moved, newParent).switchInto).toBeNull()
  })

  test('being removed drops everything', () => {
    const gone = sub({ status: 'removed', grants: grants({ prices: true }) })
    expect(recomputeGrants(gone, contractor())).toEqual(NO_GRANTS)
  })
})

describe('the door into another account', () => {
  test('a subcontractor needs both the grant and the current parent', () => {
    const granted = sub({ grants: grants({ switchInto: CONTRACTOR }) })
    expect(canSwitchInto(self(granted), contractor())).toEqual({ ok: true })

    const ungranted = sub()
    expect(canSwitchInto(self(ungranted), contractor())).toEqual({
      ok: false,
      reason: 'NOT_GRANTED',
    })

    // Same grant, different team: inert.
    const moved = sub({
      parentMembershipId: CONTRACTOR_2,
      grants: grants({ switchInto: CONTRACTOR }),
    })
    expect(canSwitchInto(self(moved), contractor())).toEqual({
      ok: false,
      reason: 'NOT_IN_TEAM',
    })
  })

  test('a contractor reaches their own team and nobody else', () => {
    const mine = member(PRIYA, 'subcontractor', {
      parentMembershipId: CONTRACTOR,
    })
    const theirs = member(PRIYA, 'subcontractor', {
      parentMembershipId: CONTRACTOR_2,
    })
    expect(canSwitchInto(self(contractor()), mine)).toEqual({ ok: true })
    expect(canSwitchInto(self(contractor()), theirs)).toEqual({
      ok: false,
      reason: 'NOT_IN_TEAM',
    })
  })

  test('the owner is never a target, for anyone', () => {
    expect(canSwitchInto(self(contractor()), owner())).toEqual({
      ok: false,
      reason: 'OWNER_NOT_SWITCHABLE',
    })
    expect(canSwitchInto(self(owner()), owner())).toEqual({
      ok: false,
      reason: 'SELF',
    })
  })

  test('no chaining: you cannot hop from the account you are already in', () => {
    const inKevin = switched(contractor(), sub())
    const priya = member(PRIYA, 'subcontractor', {
      parentMembershipId: CONTRACTOR,
    })
    expect(canSwitchInto(inKevin, priya)).toEqual({
      ok: false,
      reason: 'NO_CHAINING',
    })
  })

  test('never across businesses, never into someone removed', () => {
    const foreign = member(OUTSIDER, 'subcontractor', {
      businessId: OTHER_BUSINESS,
      parentMembershipId: CONTRACTOR,
    })
    expect(canSwitchInto(self(owner()), foreign)).toEqual({
      ok: false,
      reason: 'CROSS_BUSINESS',
    })
    expect(canSwitchInto(self(owner()), sub({ status: 'removed' }))).toEqual({
      ok: false,
      reason: 'TARGET_INACTIVE',
    })
  })

  test('the switch menu offers exactly what the door would accept', () => {
    const people = [
      owner(),
      contractor(),
      sub(),
      member(PRIYA, 'subcontractor', { parentMembershipId: CONTRACTOR_2 }),
    ]
    const targets = switchTargets(self(contractor()), people)
    expect(targets.map((p) => p._id)).toEqual([KEVIN])
  })
})

describe('switching never widens what the person may know', () => {
  test('a subcontractor without prices still cannot see prices in their contractor account', () => {
    const kevin = sub({ grants: grants({ switchInto: CONTRACTOR }) })
    const actor = switched(kevin, contractor())
    expect(effectiveCapabilities(actor, contractor(), null)['prices.see']).toBe(
      false,
    )
  })

  test("the client book is one business's: everyone holds it, whatever the old toggle says", () => {
    // `clientDirectory` is retired, not merely defaulted on: a row that still
    // stores `false` must not narrow anything.
    const kevin = sub({ grants: grants({ switchInto: CONTRACTOR }) })
    expect(kevin.grants.clientDirectory).toBe(false)
    expect(clientScope(capabilitiesOf(kevin, contractor()))).toBe('directory')

    const stingy = member(CONTRACTOR, 'contractor', {
      grants: grants({ clientDirectory: false }),
    })
    const caps = effectiveCapabilities(switched(kevin, stingy), stingy, null)
    expect(caps['clients.directory']).toBe(true)
    expect(clientScope(caps)).toBe('directory')
  })

  test('admin actions are dropped entirely while switched, in both directions', () => {
    const intoSub = switched(contractor(), sub())
    expect(effectiveCapabilities(intoSub)['team.manage']).toBe(false)
    expect(effectiveCapabilities(intoSub)['clients.manage']).toBe(false)

    const upward = switched(
      sub({ grants: grants({ switchInto: CONTRACTOR }) }),
      contractor(),
    )
    expect(
      effectiveCapabilities(upward, contractor(), null)['team.manage'],
    ).toBe(false)
  })

  test('a switched person cannot change access, so a grant cannot be laundered', () => {
    const upward = switched(
      sub({ grants: grants({ switchInto: CONTRACTOR }) }),
      contractor(),
    )
    const priya = member(PRIYA, 'subcontractor', {
      parentMembershipId: CONTRACTOR,
    })
    expect(canManageMember(upward, priya)).toBe(false)
  })

  test('but the jobs of the account you are in ARE visible — that is the point', () => {
    const kevin = sub({ grants: grants({ switchInto: CONTRACTOR }) })
    const actor = switched(kevin, contractor())
    const team = [
      sub(),
      member(PRIYA, 'subcontractor', { parentMembershipId: CONTRACTOR }),
    ]
    const scope = jobScope(
      effectiveCapabilities(actor, contractor(), null),
      actor.acting,
      team,
    )
    expect(scope.kind).toBe('team')
    expect(isInScope(scope, { assignedMembershipId: PRIYA })).toBe(true)
  })
})

describe('a switch that ends mid-task', () => {
  const expired: SwitchSession = {
    targetMembershipId: CONTRACTOR,
    startedAt: 0,
    expiresAt: 1_000,
  }

  test('reads fall back to your own account, and say why', () => {
    const kevin = sub({ grants: grants({ switchInto: CONTRACTOR }) })
    const actor = resolveActorForRead(kevin, contractor(), expired, 2_000)
    expect(actor.acting._id).toBe(kevin._id)
    expect(actor.degraded).toBe('SWITCH_EXPIRED')
  })

  test('writes refuse outright rather than silently becoming yours', () => {
    const kevin = sub({ grants: grants({ switchInto: CONTRACTOR }) })
    const result = resolveActorForWrite(kevin, contractor(), expired, 2_000)
    expect(result).toEqual({ ok: false, reason: 'SWITCH_EXPIRED' })
  })

  test('a revoked toggle ends the switch on the next write', () => {
    const revoked = sub() // grant removed
    const live = beginSwitch(CONTRACTOR, 1_000)
    const result = resolveActorForWrite(revoked, contractor(), live, 1_500)
    expect(result).toEqual({ ok: false, reason: 'SWITCH_REVOKED' })
  })

  test('a team move ends the switch on the next write', () => {
    const moved = sub({
      parentMembershipId: CONTRACTOR_2,
      grants: grants({ switchInto: CONTRACTOR }),
    })
    const live = beginSwitch(CONTRACTOR, 1_000)
    const result = resolveActorForWrite(moved, contractor(), live, 1_500)
    expect(result).toEqual({ ok: false, reason: 'SWITCH_TEAM_CHANGED' })
  })

  test('a removed target ends the switch', () => {
    const kevin = sub({ grants: grants({ switchInto: CONTRACTOR }) })
    const live = beginSwitch(CONTRACTOR, 1_000)
    const result = resolveActorForWrite(
      kevin,
      member(CONTRACTOR, 'contractor', { status: 'removed' }),
      live,
      1_500,
    )
    expect(result).toEqual({ ok: false, reason: 'SWITCH_TARGET_INACTIVE' })
  })
})

describe('who gets the credit and who gets the blame', () => {
  test('the work belongs to the account, the action to the human', () => {
    const result = resolveActorForWrite(
      contractor(),
      sub(),
      beginSwitch(KEVIN, 1_000),
      1_500,
    )
    if (!result.ok) throw new Error('expected the switch to validate')

    expect(writeAttribution(result.actor)).toEqual({
      authorMembershipId: KEVIN,
      actorMembershipId: CONTRACTOR,
      onBehalfOfMembershipId: KEVIN,
    })
  })

  test('unswitched, there is nobody to be on behalf of', () => {
    const result = resolveActorForWrite(contractor(), null, null, 1_000)
    if (!result.ok) throw new Error('expected an unswitched actor')
    expect(
      writeAttribution(result.actor).onBehalfOfMembershipId,
    ).toBeUndefined()
  })
})

describe('the owner is a person like anyone else', () => {
  test("the owner's jobs stay in everyone's scope, so nobody double-books them", () => {
    const actor = self(
      member(PRIYA, 'subcontractor', {
        grants: grants({ otherSchedules: true }),
      }),
    )
    const scope = jobScope(effectiveCapabilities(actor), actor.acting, [])
    expect(scope.kind).toBe('business')
    expect(isInScope(scope, { assignedMembershipId: OWNER })).toBe(true)
  })

  test('visible is not enterable: nobody works inside the owner account', () => {
    const kevin = sub({ grants: grants({ switchInto: CONTRACTOR }) })
    expect(canSwitchInto(self(kevin), owner())).toEqual({
      ok: false,
      reason: 'OWNER_NOT_SWITCHABLE',
    })
    expect(canSwitchInto(self(contractor()), owner()).ok).toBe(false)
  })

  test('nor administrable, even by a contractor who manages a team', () => {
    expect(canManageMember(self(contractor()), owner())).toBe(false)
  })
})

describe('finalising a compliance document', () => {
  const regulated: ReportFacts = {
    _id: id<'reports'>('r_1'),
    businessId: BUSINESS,
    authorMembershipId: KEVIN,
    status: 'draft',
    regulated: true,
  }
  const internal: ReportFacts = { ...regulated, regulated: false }

  test('a helper may fill a regulated draft but not sign it', () => {
    const actor = switched(contractor(), sub())
    const decision = canFinaliseReport(actor, regulated, { holder: sub() }, 0)
    expect(decision).toEqual({ ok: false, reason: 'SWITCHED_REGULATED' })
  })

  test('the licence holder signing it themselves is fine', () => {
    const decision = canFinaliseReport(
      self(sub()),
      regulated,
      { holder: sub() },
      0,
    )
    expect(decision).toEqual({ ok: true })
  })

  test('an internal report can still be finalised while switched', () => {
    const actor = switched(contractor(), sub())
    expect(canFinaliseReport(actor, internal, { holder: sub() }, 0)).toEqual({
      ok: true,
    })
  })

  test('a regulated document cannot be signed without a licence', () => {
    const unlicensed = sub({ licence: null })
    expect(
      canFinaliseReport(self(unlicensed), regulated, { holder: unlicensed }, 0),
    ).toEqual({ ok: false, reason: 'HOLDER_LICENCE_MISSING' })
  })

  test('nor with an expired one', () => {
    const lapsed = sub({ licence: { number: 'PMT-1', expiresAt: 500 } })
    expect(
      canFinaliseReport(self(lapsed), regulated, { holder: lapsed }, 1_000),
    ).toEqual({ ok: false, reason: 'HOLDER_LICENCE_EXPIRED' })
  })

  test('a certificate naming someone else cannot be finalised — not even with their licence valid', () => {
    // Kevin authors, names the owner as technician, and draws the signature.
    // The owner's licence is current, which is exactly why this has to fail:
    // it would print the owner's name and licence over Kevin's signature.
    const decision = canFinaliseReport(
      self(sub()),
      regulated,
      { holder: sub(), named: [owner()] },
      1_000,
    )
    expect(decision).toEqual({ ok: false, reason: 'TECHNICIAN_NOT_SIGNER' })
  })

  test('every person the certificate names counts, not only the first', () => {
    // A termite certificate names its installer AND its certifying installer,
    // each beside their own licence. Naming yourself once and the owner the
    // second time is still his licence on your signature.
    expect(
      canFinaliseReport(
        self(sub()),
        regulated,
        { holder: sub(), named: [sub(), owner()] },
        1_000,
      ),
    ).toEqual({ ok: false, reason: 'TECHNICIAN_NOT_SIGNER' })
  })

  test('naming yourself is the way through, for the owner as much as anyone', () => {
    const ownerReport = { ...regulated, authorMembershipId: OWNER }
    expect(
      canFinaliseReport(
        self(owner()),
        ownerReport,
        { holder: owner(), named: [owner()] },
        1_000,
      ),
    ).toEqual({ ok: true })
  })

  test('an internal report may still name anyone', () => {
    expect(
      canFinaliseReport(
        self(sub()),
        internal,
        { holder: sub(), named: [owner()] },
        1_000,
      ),
    ).toEqual({ ok: true })
  })

  test('licence status reads a bare number as valid, since expiry is not recorded yet', () => {
    expect(licenceStatus({ number: 'PMT-1' }, 10_000)).toBe('valid')
    expect(licenceStatus(null, 0)).toBe('missing')
    expect(licenceStatus({}, 0)).toBe('missing')
  })
})

describe('a licence belongs to its holder', () => {
  test('nobody edits it while working in someone else’s account', () => {
    const actor = switched(contractor(), sub())
    expect(canSetLicence(actor, sub())).toBe(false)
  })

  test('you may set your own, and the owner may correct anyone’s', () => {
    expect(canSetLicence(self(sub()), sub())).toBe(true)
    expect(canSetLicence(self(owner()), sub())).toBe(true)
    expect(canSetLicence(self(sub()), contractor())).toBe(false)
  })
})

describe('two people on one draft', () => {
  const base = { batch: 'B-1', dilution: '50ml' }

  test('edits to different fields both survive', () => {
    // The holder fills section 3 while a helper fills section 5.
    const server = { ...base, batch: 'B-2' }
    const incoming = { ...base, dilution: '60ml' }
    const merged = mergeDraft(base, server, incoming)
    expect(merged).toEqual({
      ok: true,
      data: { batch: 'B-2', dilution: '60ml' },
      conflicts: [],
    })
  })

  test('only a genuine clash on the same field is refused', () => {
    const server = { ...base, batch: 'B-2' }
    const incoming = { ...base, batch: 'B-3' }
    const merged = mergeDraft(base, server, incoming)
    expect(merged).toEqual({ ok: false, conflicts: ['batch'] })
  })

  test('agreeing on the same new value is not a clash', () => {
    const server = { ...base, batch: 'B-2' }
    const incoming = { ...base, batch: 'B-2' }
    expect(mergeDraft(base, server, incoming).ok).toBe(true)
  })

  test('clearing a field is an edit like any other', () => {
    const incoming = { batch: 'B-1' } // dilution deliberately removed
    const merged = mergeDraft(base, base, incoming)
    expect(merged.ok && merged.data).toEqual({ batch: 'B-1' })
  })
})

describe('editing jobs', () => {
  test('seeing everyone’s schedule never means editing it', () => {
    const nosy = self(
      member(PRIYA, 'subcontractor', {
        parentMembershipId: CONTRACTOR,
        grants: grants({ otherSchedules: true }),
      }),
    )
    expect(canEditJob(nosy, { assignedMembershipId: KEVIN })).toBe(false)
    expect(canEditJob(nosy, { assignedMembershipId: PRIYA })).toBe(true)
  })

  test('a contractor edits their own team’s work', () => {
    const team = [sub()]
    expect(
      canEditJob(self(contractor()), { assignedMembershipId: KEVIN }, team),
    ).toBe(true)
    expect(
      canEditJob(self(contractor()), { assignedMembershipId: PRIYA }, [
        member(PRIYA, 'subcontractor', { parentMembershipId: CONTRACTOR_2 }),
      ]),
    ).toBe(false)
  })

  test('switched, you edit as the account you are in', () => {
    const actor = switched(contractor(), sub())
    expect(isSwitched(actor)).toBe(true)
    expect(canEditJob(actor, { assignedMembershipId: KEVIN })).toBe(true)
  })
})
