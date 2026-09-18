import { describe, expect, test } from 'vitest'
import {
  displayNameOf,
  factsFromMembership,
  grantsFromMembership,
  licenceFromMembership,
} from './membershipFacts'
import { DEFAULT_GRANTS, capabilitiesOf } from './capabilities'
import type { Grants } from './capabilities'
import type { DataModel, Doc, Id } from '../_generated/dataModel'

type TableName = keyof DataModel
const id = <T extends TableName>(value: string) => value as Id<T>

const BUSINESS = id<'businesses'>('b_coastal')
const KEVIN = id<'memberships'>('m_kevin')
const JO = id<'memberships'>('m_jo')

/**
 * A membership row as it exists in production TODAY — none of the new columns,
 * because nothing has ever written them.
 */
function legacyRow(
  overrides: Partial<Doc<'memberships'>> = {},
): Doc<'memberships'> {
  return {
    _id: KEVIN,
    _creationTime: 0,
    userId: 'u_kevin',
    businessId: BUSINESS,
    role: 'subcontractor',
    canViewAllJobs: false,
    colour: '#0ea5e9',
    status: 'active',
    createdAt: 0,
    ...overrides,
  }
}

describe('reading a row written before the access model existed', () => {
  /**
   * The deploy-day question. The backend ships ahead of the frontend, so on
   * the day this lands there is no UI anywhere that could explain a change in
   * access or let anyone undo it. A technician who can suddenly no longer open
   * their client list has no recourse but to ring the owner.
   */
  test('keeps every member seeing what they see today', () => {
    const grants = grantsFromMembership(legacyRow())
    expect(grants.clientDirectory).toBe(true)
    expect(grants.prices).toBe(true)
  })

  /**
   * The escalation that would be invisible in a diff.
   *
   * `canViewOtherAccounts` grants a read-only "view as". `switchInto` grants
   * writing under someone else's name, up to and including finalising a
   * compliance certificate. The names are close enough that treating the old
   * flag as the new one looks like tidy migration code and is a silent
   * upgrade of every existing grant.
   */
  test('never turns the old read-only view-as flag into write access', () => {
    const grants = grantsFromMembership(
      legacyRow({ canViewOtherAccounts: true }),
    )
    expect(grants.switchInto).toBeNull()
  })

  test('carries the one flag that does map — read-only sight of other work', () => {
    expect(grantsFromMembership(legacyRow()).otherSchedules).toBe(false)
    expect(
      grantsFromMembership(legacyRow({ canViewAllJobs: true })).otherSchedules,
    ).toBe(true)
  })

  test('a legacy owner is still an owner', () => {
    const grants = grantsFromMembership(legacyRow({ role: 'owner' }))
    expect(grants).toEqual(DEFAULT_GRANTS.owner)
    expect(
      capabilitiesOf(factsFromMembership(legacyRow({ role: 'owner' })))[
        'business.manage'
      ],
    ).toBe(true)
  })

  test('nobody is on a team until somebody puts them on one', () => {
    expect(factsFromMembership(legacyRow()).parentMembershipId).toBeNull()
  })
})

describe('reading a row the new model has written', () => {
  const stored: Grants = {
    switchInto: JO,
    clientDirectory: false,
    prices: false,
    otherSchedules: true,
  }

  /**
   * Once the column is there it is the truth — including every `false` in it.
   * Falling back to the legacy defaults when a toggle happens to be off is how
   * a toggle the owner deliberately turned off comes back on by itself.
   */
  test('takes the stored toggles verbatim, offs included', () => {
    expect(grantsFromMembership(legacyRow({ grants: stored }))).toEqual(stored)
  })

  test('the stored toggles win over the legacy flags they replace', () => {
    const row = legacyRow({ grants: stored, canViewAllJobs: false })
    expect(grantsFromMembership(row).otherSchedules).toBe(true)
  })
})

describe('licence', () => {
  test('no number means no licence — regulated work is blocked', () => {
    expect(licenceFromMembership(legacyRow())).toBeNull()
  })

  /** Unknown is not expired. Every row in production has an unset expiry, so
   * reading absence as expiry would stop the whole business finalising. */
  test('a number with no expiry is a licence', () => {
    expect(
      licenceFromMembership(legacyRow({ licenceNumber: 'PMT-1' })),
    ).toEqual({ number: 'PMT-1', expiresAt: undefined })
  })

  test('carries the expiry when it is set', () => {
    const row = legacyRow({ licenceNumber: 'PMT-1', licenceExpiresOn: 42 })
    expect(licenceFromMembership(row)?.expiresAt).toBe(42)
  })
})

describe('display name', () => {
  /** A departed member renaming their login must not rewrite their name on
   * reports they signed and audit rows they caused. */
  test('the frozen snapshot beats the live user name', () => {
    expect(displayNameOf(legacyRow({ displayName: 'Kevin E' }), 'Hacker')).toBe(
      'Kevin E',
    )
  })

  test('falls back to the live name while no snapshot exists', () => {
    expect(displayNameOf(legacyRow(), 'Kevin Edgar')).toBe('Kevin Edgar')
  })
})
