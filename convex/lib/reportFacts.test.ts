import { describe, expect, test } from 'vitest'
import { reportFactsFrom } from './reportFacts'
import {
  DEFAULT_GRANTS,
  canFinaliseReport,
  isRegulatedTemplate,
  reportScope,
  resolveActorForRead,
} from './capabilities'
import type {
  MembershipFacts,
  ReportTemplate,
  Role,
  RowScope,
  SwitchSession,
} from './capabilities'
import type { DataModel, Doc, Id } from '../_generated/dataModel'

type TableName = keyof DataModel
const id = <T extends TableName>(v: string) => v as Id<T>

const BUSINESS = id<'businesses'>('b_coastal')
const KEVIN = id<'memberships'>('m_kevin')
const JO = id<'memberships'>('m_jo')

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

function report(
  template: ReportTemplate,
  overrides: Partial<Doc<'reports'>> = {},
): Doc<'reports'> {
  return {
    _id: id<'reports'>('r_1'),
    _creationTime: 0,
    businessId: BUSINESS,
    propertyId: id<'properties'>('p_1'),
    authorMembershipId: KEVIN,
    template,
    templateVersion: 1,
    legalBasis: 'whatever the client sent',
    status: 'draft',
    data: {},
    photoIds: [],
    createdAt: 0,
    ...overrides,
  }
}

const session = (target: Id<'memberships'>): SwitchSession => ({
  targetMembershipId: target,
  startedAt: 0,
  expiresAt: 1_000_000,
})

describe('which documents are certificates', () => {
  test('the three that carry an attestation', () => {
    expect(isRegulatedTemplate('timberPestInspection')).toBe(true)
    expect(isRegulatedTemplate('termiteManagementCert')).toBe(true)
    expect(isRegulatedTemplate('treatmentRecord')).toBe(true)
  })

  test('the everyday record of a visit does not', () => {
    expect(isRegulatedTemplate('serviceReport')).toBe(false)
  })

  /**
   * "Editing" a built-in clones it, legal basis and all, and nothing stored
   * says what it was cloned from. A clone of the termite certificate is a
   * termite certificate; treating custom as unregulated would let exactly that
   * document through the one gate that stops a licence being borrowed.
   */
  test('a custom template is assumed to be one, because a clone is indistinguishable', () => {
    expect(isRegulatedTemplate('custom')).toBe(true)
  })

  /** Derived from the template, never from the report's own `legalBasis` —
   * that column is a client-supplied string. */
  test('the facts ignore what the client called it', () => {
    const facts = reportFactsFrom(
      report('serviceReport', { legalBasis: 'AS 3660.2-2017' }),
    )
    expect(facts.regulated).toBe(false)
  })

  test('and read the rest straight off the row', () => {
    const facts = reportFactsFrom(report('termiteManagementCert'))
    expect(facts).toEqual({
      _id: id<'reports'>('r_1'),
      businessId: BUSINESS,
      authorMembershipId: KEVIN,
      status: 'draft',
      regulated: true,
    })
  })
})

describe('signing under someone else’s licence', () => {
  // Kevin is on Jo's team — without that the switch itself would not validate
  // and every case below would refuse for the wrong reason.
  const kevin = member(KEVIN, 'subcontractor', { parentMembershipId: JO })
  const jo = member(JO, 'contractor')

  /** The whole reason switching is safe to offer: a helper may fill the form
   * in, and the licence holder presses the button. */
  test('a certificate cannot be finalised from inside the holder’s account', () => {
    const actor = resolveActorForRead(jo, kevin, session(KEVIN), 0)
    const decision = canFinaliseReport(
      actor,
      reportFactsFrom(report('termiteManagementCert')),
      { holder: kevin },
      0,
    )
    expect(decision).toEqual({ ok: false, reason: 'SWITCHED_REGULATED' })
  })

  test('nor can a cloned one, which is the same document under another name', () => {
    const actor = resolveActorForRead(jo, kevin, session(KEVIN), 0)
    const decision = canFinaliseReport(
      actor,
      reportFactsFrom(report('custom')),
      { holder: kevin },
      0,
    )
    expect(decision).toEqual({ ok: false, reason: 'SWITCHED_REGULATED' })
  })

  /** The rule is about certification, not about switching. Ordinary paperwork
   * is exactly what helping someone with their account is for. */
  test('an everyday service report still can be', () => {
    const actor = resolveActorForRead(jo, kevin, session(KEVIN), 0)
    const decision = canFinaliseReport(
      actor,
      reportFactsFrom(report('serviceReport')),
      { holder: kevin },
      0,
    )
    expect(decision).toEqual({ ok: true })
  })

  test('and the holder can finalise their own certificate', () => {
    const actor = resolveActorForRead(kevin, null, null, 0)
    const decision = canFinaliseReport(
      actor,
      reportFactsFrom(report('termiteManagementCert')),
      { holder: kevin },
      0,
    )
    expect(decision).toEqual({ ok: true })
  })

  /** Being unswitched is not enough — the licence has to be real. */
  test('but not without a licence to sign it with', () => {
    const unlicensed = member(KEVIN, 'subcontractor', {
      parentMembershipId: JO,
      licence: null,
    })
    const actor = resolveActorForRead(unlicensed, null, null, 0)
    const decision = canFinaliseReport(
      actor,
      reportFactsFrom(report('termiteManagementCert')),
      { holder: unlicensed },
      0,
    )
    expect(decision).toEqual({ ok: false, reason: 'HOLDER_LICENCE_MISSING' })
  })
})

describe('which reports someone may read', () => {
  const own: RowScope = { kind: 'own', membershipId: KEVIN }
  const team: RowScope = { kind: 'team', membershipIds: [JO, KEVIN] }

  test('scopes by who wrote it, not by who a job was assigned to', () => {
    expect(reportScope(own, { authorMembershipId: KEVIN })).toBe(true)
    expect(reportScope(own, { authorMembershipId: JO })).toBe(false)
    expect(reportScope(team, { authorMembershipId: JO })).toBe(true)
    expect(reportScope({ kind: 'business' }, { authorMembershipId: JO })).toBe(
      true,
    )
  })
})
