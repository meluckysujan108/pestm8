import { describe, expect, test } from 'vitest'
import {
  MERGE_CANCEL,
  MERGE_NOT_YOURS,
  keepBothTitle,
  mergeConfirmBody,
  mergeErrorCopy,
  mergeOptionCopy,
  mergeUnavailableCopy,
  mergeXeroLines,
  openClientLabel,
} from './xeroCopy'

/**
 * The words of the Same customer sheet and the held card
 * (src/components/xero/SameCustomerSheet.tsx, MatchCard.tsx): {B} is the
 * card's client, merged into {A}, who has the Xero contact.
 */
const B = 'Coastal Property Group'
const A = 'Coastal Property Management'

const moves = { properties: 2, jobs: 14, notes: 3, contacts: 1 }

describe('what a merge does in Xero, organisation by organisation', () => {
  test('A takes B’s contact over where A has none; B’s stays in Xero where A has its own; nothing is said where B has none', () => {
    expect(
      mergeXeroLines(B, A, [
        { orgName: 'Pest M8 Pest Control', outcome: 'none' },
        { orgName: 'Doyle Pest Services', outcome: 'takes_over' },
        { orgName: 'Bloggs Bookkeeping', outcome: 'stays' },
      ]),
    ).toBe(
      ` In Doyle Pest Services, ${A} takes over ${B}’s contact. ${B}’s own contact in Bloggs Bookkeeping stays in Xero.`,
    )
  })

  test('the option and its confirm say it, after what moves', () => {
    const preview = {
      moves,
      xero: [
        { orgName: 'Doyle Pest Services', outcome: 'takes_over' as const },
      ],
    }
    expect(mergeOptionCopy({ from: B, into: A, preview })).toBe(
      `2 sites, 14 jobs, 3 notes and 1 contact move to ${A}; ${B} goes to the Recycle bin. Xero keeps ${A}’s contact. In Doyle Pest Services, ${A} takes over ${B}’s contact.`,
    )
    expect(mergeConfirmBody({ from: B, into: A, preview })).toBe(
      `2 sites, 14 jobs, 3 notes and 1 contact move to ${A}, and ${B} goes to the Recycle bin. This can’t be undone. Xero keeps ${A}’s contact. In Doyle Pest Services, ${A} takes over ${B}’s contact.`,
    )
  })
})

describe('the merge confirm', () => {
  test('its way out is not “Keep both”, the sheet’s own second answer, which it saves nothing of', () => {
    expect(MERGE_CANCEL).toBe('Don’t merge')
    expect(keepBothTitle(A).startsWith(MERGE_CANCEL)).toBe(false)
    expect(MERGE_CANCEL.startsWith('Keep both')).toBe(false)
  })

  test('too big to merge points at the sheet’s Keep both by its name, not at the confirm’s way out', () => {
    expect(mergeErrorCopy(B, A).MERGE_TOO_BIG).toBe(
      `Could not merge: ${B} has more sites, contacts or notes than PestM8 can move at once. Choose Keep both, use ${A}’s Xero contact instead.`,
    )
  })

  test('a business into a person says what would be hidden, and the ways on', () => {
    expect(mergeErrorCopy(B, A).KIND_MISMATCH).toBe(
      `Could not merge: ${B} is a business with contact people, an ABN or an office address, which ${A} — a person — can’t show. Make ${A} a business first, or choose Keep both, use ${A}’s Xero contact.`,
    )
  })
})

describe('the Merge option, when the preview already says no', () => {
  test('a refusal that will stand is said in the option’s place', () => {
    expect(mergeUnavailableCopy('MERGE_TOO_BIG', B, A)).toBe(
      `${B} has more sites, contacts or notes than PestM8 can move at once.`,
    )
    expect(mergeUnavailableCopy('KIND_MISMATCH', B, A)).toBe(
      `${B} is a business with contact people, an ABN or an office address, which ${A} — a person — can’t show. Make ${A} a business first.`,
    )
    for (const code of ['NOT_FOUND', 'SAME_CLIENT', 'MERGED']) {
      expect(mergeUnavailableCopy(code, B, A)).toBe(
        `${B} or ${A} has changed since the page opened. Reload this page and look again.`,
      )
    }
    expect(mergeUnavailableCopy('NO_ACCESS', B, A)).toBe(MERGE_NOT_YOURS)
  })

  test('one that may pass (no signal, anything unforeseen) leaves the option to be tried', () => {
    expect(mergeUnavailableCopy(null, B, A)).toBeNull()
    expect(mergeUnavailableCopy('offline', B, A)).toBeNull()
    expect(mergeUnavailableCopy('SOMETHING_NEW', B, A)).toBeNull()
  })
})

describe('the held card', () => {
  test('its link to B’s sheet says what it does: opens it, for everyone', () => {
    expect(openClientLabel(B)).toBe(`Open ${B}`)
  })
})
