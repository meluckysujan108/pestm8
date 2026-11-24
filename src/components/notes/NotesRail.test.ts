import { describe, expect, test } from 'vitest'
import { offersEveryonesNotes } from './NotesRail'

/**
 * "Everyone's notes" lists the team's personal notes, which the server reads
 * only to the owner in Overview as himself (`godView` in
 * convex/lib/noteAccess.ts). Offered to anyone else, the folder would open
 * empty, and look like a fault.
 */
const owner = {
  role: 'owner' as const,
  actingAs: null,
  viewingAs: null,
  view: { mode: 'everyone' as const },
}
const someone = {
  membershipId: 'm2' as never,
  name: 'Kevin',
}

describe('who is offered Everyone’s notes', () => {
  test('the owner in Overview, as himself', () => {
    expect(offersEveryonesNotes(owner)).toBe(true)
  })

  test('not the owner in My jobs, or in someone’s account', () => {
    expect(offersEveryonesNotes({ ...owner, view: { mode: 'mine' } })).toBe(
      false,
    )
    expect(
      offersEveryonesNotes({
        ...owner,
        actingAs: someone,
        view: { mode: 'account' },
      }),
    ).toBe(false)
    expect(offersEveryonesNotes({ ...owner, viewingAs: someone })).toBe(false)
  })

  test('not a contractor or subcontractor, even in their own Overview', () => {
    expect(offersEveryonesNotes({ ...owner, role: 'contractor' })).toBe(false)
    expect(offersEveryonesNotes({ ...owner, role: 'subcontractor' })).toBe(
      false,
    )
  })

  test('not from a backend that sends no view', () => {
    expect(offersEveryonesNotes({ ...owner, view: undefined })).toBe(false)
    expect(offersEveryonesNotes({ ...owner, view: null })).toBe(false)
  })
})
