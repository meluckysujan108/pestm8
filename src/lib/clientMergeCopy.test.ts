import { describe, expect, test } from 'vitest'
import { ConvexError } from 'convex/values'
import { describeError } from '#/components/forms/describeError'
import {
  MERGE_CANCEL as XERO_MERGE_CANCEL,
  heldOutcomeCopy,
  mergeMovesList as xeroMergeMovesList,
  mergeXeroLines as xeroMergeXeroLines,
} from '#/components/xero/xeroCopy'
import {
  MAY_BE_SAME_GROUP,
  MERGE_CANCEL,
  MERGE_INTO_DESCRIPTION,
  NOT_THE_SAME_CANCEL,
  NOT_THE_SAME_ERROR_COPY,
  clientMergeErrorCopy,
  keepInsteadLabel,
  mergeConfirmText,
  mergeArchivedNote,
  mergeConfirmTitle,
  mergeIntoTitle,
  mergeMovesList,
  mergeNames,
  mergePairSummary,
  mergeRefusalStands,
  mergeXeroLines,
  mergedCopy,
  notTheSameSaved,
  notTheSameText,
  notTheSameTitle,
} from './clientMergeCopy'

/**
 * Merging on the client sheet, in words (the matching plan's M8): {B} goes
 * into {A}, who is kept. What moves and what happens in Xero are the Same
 * customer sheet's words, from one module.
 */
const B = 'J. Nguyen'
const A = 'Jane Nguyen'

const moves = (over: Partial<Parameters<typeof mergeMovesList>[0]> = {}) => ({
  properties: 0,
  jobs: 0,
  notes: 0,
  contacts: 0,
  ...over,
})

describe('what the pair says the merge does', () => {
  test('the preview’s counts, A’s details winning, and where B goes for good', () => {
    expect(
      mergePairSummary({
        from: B,
        into: A,
        preview: {
          moves: moves({ properties: 2, jobs: 14, notes: 3 }),
          xero: [],
        },
      }),
    ).toBe(
      '2 sites, 14 jobs and 3 notes move to Jane Nguyen. Jane Nguyen’s name, number and details stay, with J. Nguyen’s filling any blanks. J. Nguyen goes to the Recycle bin, and can’t be restored from there.',
    )
  })

  test('before the preview has counted, what moves is said without numbers', () => {
    expect(mergePairSummary({ from: B, into: A })).toBe(
      'J. Nguyen’s sites, jobs and notes move to Jane Nguyen. Jane Nguyen’s name, number and details stay, with J. Nguyen’s filling any blanks. J. Nguyen goes to the Recycle bin, and can’t be restored from there.',
    )
  })

  test('nothing to move: no line about moving', () => {
    expect(
      mergePairSummary({
        from: B,
        into: A,
        preview: { moves: moves(), xero: [] },
      }),
    ).toMatch(/^Jane Nguyen’s name, number and details stay/)
  })

  test('each organisation’s outcome, and nothing said of Xero where neither is in it', () => {
    const summary = mergePairSummary({
      from: B,
      into: A,
      preview: {
        moves: moves({ properties: 1 }),
        xero: [
          { orgName: 'Doyle Pest Services', outcome: 'takes_over' },
          { orgName: 'Pest M8', outcome: 'stays' },
          { orgName: 'Other', outcome: 'none' },
        ],
      },
    })
    expect(summary).toMatch(
      /from there\. In Doyle Pest Services, Jane Nguyen takes over J\. Nguyen’s contact\. J\. Nguyen’s own contact in Pest M8 stays in Xero\.$/,
    )
    expect(summary).not.toContain('Other')
    // The Xero sheet's "Xero keeps {A}’s contact." is about the contact the
    // card is for; here there may be none.
    expect(
      mergePairSummary({
        from: B,
        into: A,
        preview: { moves: moves(), xero: [] },
      }),
    ).not.toContain('Xero')
  })
})

describe('the confirm', () => {
  test('asks by name, says what moves, where B goes, and that it can’t be undone', () => {
    expect(mergeConfirmTitle(B, A)).toBe('Merge J. Nguyen into Jane Nguyen?')
    expect(
      mergeConfirmText({
        from: B,
        into: A,
        preview: { moves: moves({ properties: 1 }), xero: [] },
      }),
    ).toBe(
      '1 site moves to Jane Nguyen, and J. Nguyen goes to the Recycle bin. This can’t be undone.',
    )
    expect(
      mergeConfirmText({
        from: B,
        into: A,
        preview: {
          moves: moves({ jobs: 3, contacts: 1 }),
          xero: [{ orgName: 'Doyle Pest Services', outcome: 'stays' }],
        },
      }),
    ).toBe(
      '3 jobs and 1 contact move to Jane Nguyen, and J. Nguyen goes to the Recycle bin. This can’t be undone. J. Nguyen’s own contact in Doyle Pest Services stays in Xero.',
    )
    expect(
      mergeConfirmText({
        from: B,
        into: A,
        preview: { moves: moves(), xero: [] },
      }),
    ).toBe('J. Nguyen goes to the Recycle bin. This can’t be undone.')
  })

  test('its way out keeps the Xero sheet’s words: never “Keep client”, which reads as choosing one', () => {
    expect(MERGE_CANCEL).toBe('Don’t merge')
    expect(XERO_MERGE_CANCEL).toBe(MERGE_CANCEL)
  })
})

describe('the two names', () => {
  test('two clients called the same are told apart by their numbers', () => {
    expect(
      mergeNames(
        { name: 'Jane Nguyen', clientNumber: 31 },
        { name: 'JANE NGUYEN', clientNumber: 12 },
      ),
    ).toEqual({ from: 'Jane Nguyen #31', into: 'JANE NGUYEN #12' })
  })

  test('bare, so a possessive reads as one: never “Jane Nguyen (#12)’s”', () => {
    const { from, into } = mergeNames(
      { name: 'Jane Nguyen', clientNumber: 231 },
      { name: 'Jane Nguyen', clientNumber: 12 },
    )
    expect(mergedCopy(from, into)).toBe(
      'Merged — Jane Nguyen #231’s sites, jobs and notes are Jane Nguyen #12’s now, and Jane Nguyen #231 is in the Recycle bin.',
    )
    expect(mergePairSummary({ from, into })).not.toMatch(/\)’s/)
  })

  test('different names, or no numbers, as they are', () => {
    expect(
      mergeNames({ name: B, clientNumber: 31 }, { name: A, clientNumber: 12 }),
    ).toEqual({ from: B, into: A })
    expect(
      mergeNames(
        { name: A, clientNumber: null },
        { name: A, clientNumber: null },
      ),
    ).toEqual({ from: A, into: A })
  })

  test('the sheet’s headings', () => {
    expect(mergeIntoTitle(B)).toBe('Merge J. Nguyen into…')
    expect(keepInsteadLabel(B)).toBe('Keep J. Nguyen instead')
  })

  test('the list’s description claims no order: the heading says who may be the same customer, where anyone is', () => {
    expect(MERGE_INTO_DESCRIPTION).toBe('Choose the client to keep.')
    expect(MERGE_INTO_DESCRIPTION).not.toContain(
      MAY_BE_SAME_GROUP.toLowerCase(),
    )
    expect(MERGE_INTO_DESCRIPTION).not.toMatch(/first/)
  })
})

describe('a merge refused, by the preview or the merge', () => {
  const copy = clientMergeErrorCopy(B, A)
  const said = (code: string) => describeError(new ConvexError(code), copy)

  test('the same client', () => {
    expect(said('SAME_CLIENT')).toBe(
      'Could not merge: they’re the same client already. Close this and look again.',
    )
  })

  test('too big to move at once: the way round, or leave them', () => {
    expect(said('MERGE_TOO_BIG')).toBe(
      'Could not merge: J. Nguyen has more sites, contacts or notes than PestM8 can move at once. Keep J. Nguyen instead, or leave the two as they are.',
    )
  })

  test('a business into a person: make A a business, or the way round', () => {
    expect(said('KIND_MISMATCH')).toBe(
      'Could not merge: J. Nguyen is a business with contact people, an ABN or an office address, which Jane Nguyen — a person — can’t show. Make Jane Nguyen a business first, or keep J. Nguyen instead.',
    )
  })

  test('gone, archived or changed since it opened', () => {
    expect(said('NOT_FOUND')).toBe(
      'Could not merge: J. Nguyen or Jane Nguyen has been deleted, archived or changed since this opened. Close this and look again.',
    )
    expect(said('MERGED')).toBe(
      'Could not merge: J. Nguyen has already been merged into another client. Close this and look again.',
    )
  })

  test('archived before it opened: says so, never “since this opened”, and the way on', () => {
    const archived = clientMergeErrorCopy(B, A, A)
    // Nothing in the app restores one from archived, and the way round is
    // refused too: the way on is to leave the two be.
    expect(describeError(new ConvexError('NOT_FOUND'), archived)).toBe(
      'Could not merge: Jane Nguyen is archived, and an archived client can’t be merged. Close this and leave the two as they are.',
    )
  })

  test('no signal: nothing was changed', () => {
    expect(describeError(new Error('offline'), copy)).toBe(
      'Could not merge: this device is offline. Nothing was changed — try again when you have signal.',
    )
  })

  test('anything else', () => {
    expect(describeError(new Error('boom'), copy)).toBe(
      'Could not merge. Nothing was changed — check your signal and try again.',
    )
    expect(said('SWITCHED')).toBe(
      'Could not merge: switch back to your own account first, then try again.',
    )
  })

  test('a refusal that will stand greys Merge… out; one that may pass doesn’t', () => {
    for (const code of [
      'MERGE_TOO_BIG',
      'KIND_MISMATCH',
      'SAME_CLIENT',
      'MERGED',
      'NOT_FOUND',
      'NO_ACCESS',
      'SWITCHED',
    ]) {
      expect(mergeRefusalStands(code)).toBe(true)
    }
    expect(mergeRefusalStands(null)).toBe(false)
    expect(mergeRefusalStands('offline')).toBe(false)
    expect(mergeRefusalStands('SOMETHING_NEW')).toBe(false)
  })
})

describe('done', () => {
  test('the kept client’s sheet says what the Xero card says', () => {
    expect(mergedCopy(B, A)).toBe(
      'Merged — J. Nguyen’s sites, jobs and notes are Jane Nguyen’s now, and J. Nguyen is in the Recycle bin.',
    )
    expect(
      heldOutcomeCopy('merge', { client: B, holder: A, contact: 'Jane N' }),
    ).toBe(mergedCopy(B, A))
  })

  test('the Xero sheet reads the same helpers, not copies of them', () => {
    expect(xeroMergeMovesList).toBe(mergeMovesList)
    expect(xeroMergeXeroLines).toBe(mergeXeroLines)
  })
})

describe('the possible-duplicate line', () => {
  test('a line whose other client is archived says why Merge… is greyed out', () => {
    expect(mergeArchivedNote('Jane Nguyen #5')).toBe(
      'Jane Nguyen #5 is archived, and an archived client can’t be merged.',
    )
  })

  test('Not the same, saved: said under the line, which stays', () => {
    expect(notTheSameSaved('Tom Brown')).toBe(
      'Saved — not the same customer as Tom Brown.',
    )
  })
})

describe('Not the same, asked first', () => {
  test('names the other as the line does, says what stays and goes, that it can’t be brought back, and the way to merge them still', () => {
    expect(notTheSameTitle('Jane Nguyen #12')).toBe(
      'Not the same customer as Jane Nguyen #12?',
    )
    expect(notTheSameText(true)).toBe(
      'Both clients stay as they are, and this goes from both their sheets, for everyone. It can’t be brought back, but Details → Merge into… can still merge them.',
    )
    // The way out keeps the question: never “Cancel”.
    expect(NOT_THE_SAME_CANCEL).toBe('Keep it')
  })

  test('never promises Merge into… for a client it can’t merge: one archived, or one whose record isn’t there', () => {
    expect(notTheSameText(false)).toBe(
      'Both clients stay as they are, and this goes from both their sheets, for everyone. It can’t be brought back.',
    )
    expect(notTheSameText(false)).not.toMatch(/Merge into/)
  })
})

describe('Not the same, refused', () => {
  test('fails fast with no signal, and says so', () => {
    expect(describeError(new Error('offline'), NOT_THE_SAME_ERROR_COPY)).toBe(
      'Could not save: this device is offline. Try again when you have signal.',
    )
    expect(
      describeError(new ConvexError('NOT_FOUND'), NOT_THE_SAME_ERROR_COPY),
    ).toBe(
      'Could not save: this has changed since you opened it. Close it and look again.',
    )
  })
})

describe('the copy rules', () => {
  test('curly apostrophes, spaced em dashes, never a straight quote', () => {
    const all = [
      mergePairSummary({ from: B, into: A }),
      mergeConfirmText({
        from: B,
        into: A,
        preview: {
          moves: moves({ properties: 1 }),
          xero: [{ orgName: 'Org', outcome: 'takes_over' }],
        },
      }),
      mergedCopy(B, A),
      mergeArchivedNote(A),
      notTheSameSaved(A),
      notTheSameTitle(A),
      notTheSameText(true),
      notTheSameText(false),
      NOT_THE_SAME_CANCEL,
      MERGE_INTO_DESCRIPTION,
      ...Object.values(clientMergeErrorCopy(B, A)),
      ...Object.values(clientMergeErrorCopy(B, A, A)),
      ...Object.values(NOT_THE_SAME_ERROR_COPY),
    ]
    for (const words of all) {
      expect(words).not.toMatch(/['"]/)
      expect(words).not.toMatch(/\S—|—\S/)
      // Signal, not connection.
      expect(words).not.toMatch(/connection/i)
    }
  })
})
