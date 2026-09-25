import { describe, expect, it } from 'vitest'
import { needsLicence } from './needsLicence'
import type { Id } from '../../../convex/_generated/dataModel'

const me = 'm_me' as Id<'memberships'>
const kevin = 'm_kevin' as Id<'memberships'>

const member = (over: Partial<Parameters<typeof needsLicence>[0]> = {}) => ({
  _id: kevin,
  status: 'active',
  canManage: true,
  licenceNumber: undefined as string | undefined,
  ...over,
})

describe('a missing licence to badge', () => {
  it('is someone this viewer manages with no number', () => {
    expect(needsLicence(member(), me)).toBe(true)
  })

  it('counts a number of only spaces as missing', () => {
    expect(needsLicence(member({ licenceNumber: '  ' }), me)).toBe(true)
  })

  it('is not someone with a number', () => {
    expect(needsLicence(member({ licenceNumber: '1234' }), me)).toBe(false)
  })

  it('is the viewer themselves, whom nobody manages', () => {
    expect(needsLicence(member({ _id: me, canManage: false }), me)).toBe(true)
  })

  it('is not someone the viewer does not manage (the owner, another crew)', () => {
    expect(needsLicence(member({ canManage: false }), me)).toBe(false)
  })

  it('is not someone who has not joined', () => {
    expect(needsLicence(member({ status: 'invited' }), me)).toBe(false)
  })
})
