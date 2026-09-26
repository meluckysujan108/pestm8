import { describe, expect, test } from 'vitest'
import { licenceFixFor } from './LicenceNotice'
import type { Id } from '../../../convex/_generated/dataModel'

const jo = 'm_jo' as Id<'memberships'>
const kev = 'm_kev' as Id<'memberships'>

describe('licenceFixFor — who can add a missing licence, as the draft is opened', () => {
  test('the author fixes their own, right there', () => {
    expect(
      licenceFixFor({
        template: 'termiteManagementCert',
        author: { _id: jo },
        callerMembershipId: jo,
        viewerIsOwner: true,
      }),
    ).toBe('self')
  })

  test('the owner, on someone else’s report, goes to their Team page', () => {
    expect(
      licenceFixFor({
        template: 'timberPestInspection',
        author: { _id: kev, licenceNumber: '  ' },
        callerMembershipId: jo,
        viewerIsOwner: true,
      }),
    ).toBe('team')
  })

  test('anyone else is told to ask the owner', () => {
    expect(
      licenceFixFor({
        template: 'custom',
        author: { _id: kev },
        callerMembershipId: jo,
        viewerIsOwner: false,
      }),
    ).toBe('owner')
  })

  test('nothing to say when the form does not need one, or it is there', () => {
    // A plain service report finalises without a licence.
    expect(
      licenceFixFor({
        template: 'serviceReport',
        author: { _id: jo },
        callerMembershipId: jo,
        viewerIsOwner: true,
      }),
    ).toBeNull()
    expect(
      licenceFixFor({
        template: 'termiteManagementCert',
        author: { _id: jo, licenceNumber: 'PMT 004512' },
        callerMembershipId: jo,
        viewerIsOwner: true,
      }),
    ).toBeNull()
    expect(
      licenceFixFor({
        template: 'termiteManagementCert',
        author: null,
        callerMembershipId: jo,
        viewerIsOwner: true,
      }),
    ).toBeNull()
  })
})
