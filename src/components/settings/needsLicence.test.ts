import { describe, expect, it } from 'vitest'
import { canSetLicence, needsLicence } from './needsLicence'
import type { LicenceViewer } from './needsLicence'
import type { Id } from '../../../convex/_generated/dataModel'

const me = 'm_me' as Id<'memberships'>
const kevin = 'm_kevin' as Id<'memberships'>

const owner: LicenceViewer = { membershipId: me, role: 'owner' }
const contractor: LicenceViewer = { membershipId: me, role: 'contractor' }

const member = (over: Partial<Parameters<typeof needsLicence>[0]> = {}) => ({
  _id: kevin,
  status: 'active',
  canManage: true,
  licenceNumber: undefined as string | undefined,
  ...over,
})

describe('a missing licence to badge', () => {
  it('is someone this viewer manages with no number', () => {
    expect(needsLicence(member(), contractor)).toBe(true)
  })

  it('counts a number of only spaces as missing', () => {
    expect(needsLicence(member({ licenceNumber: '  ' }), contractor)).toBe(true)
  })

  it('is not someone with a number', () => {
    expect(needsLicence(member({ licenceNumber: '1234' }), contractor)).toBe(
      false,
    )
  })

  it('is the viewer themselves, whom nobody manages', () => {
    expect(
      needsLicence(member({ _id: me, canManage: false }), contractor),
    ).toBe(true)
  })

  it('is not someone a contractor does not manage (the owner, another crew)', () => {
    expect(needsLicence(member({ canManage: false }), contractor)).toBe(false)
  })

  // `memberships.setLicence` takes the owner's word for anyone's number, so
  // one the owner does not manage (another owner) is still his to type in.
  it('is anyone at all for the owner, who may set every number', () => {
    expect(needsLicence(member({ canManage: false }), owner)).toBe(true)
  })

  it('is not someone who has not joined', () => {
    expect(needsLicence(member({ status: 'invited' }), owner)).toBe(false)
  })
})

describe('who may type in a licence number', () => {
  it('is the owner, for anyone', () => {
    expect(canSetLicence({ _id: kevin }, owner)).toBe(true)
  })

  it('is everyone else only for themselves', () => {
    expect(canSetLicence({ _id: me }, contractor)).toBe(true)
    expect(canSetLicence({ _id: kevin }, contractor)).toBe(false)
  })
})
