import { describe, expect, test } from 'vitest'
import { deleteWords, purgeWords, restoreFailed } from './deleteWords'
import type { DeletableReport } from './deleteWords'

const draft: DeletableReport = {
  status: 'draft',
  templateName: 'Service Report',
  clientName: 'J. Nguyen',
  suburb: 'Bayswater',
}
const signed: DeletableReport = {
  ...draft,
  status: 'finalised',
  reportNumber: 12,
}

describe('moving a report to Deleted', () => {
  test('a draft says what it always has', () => {
    const words = deleteWords(draft)
    expect(words.title).toBe('Delete this draft?')
    expect(words.body).toBe(
      'Service Report for J. Nguyen, Bayswater. It waits in Deleted for 30 days, with its photos, then it is gone.',
    )
    expect(words.caution).toBeUndefined()
    expect([words.confirm, words.cancel]).toEqual([
      'Delete draft',
      'Keep draft',
    ])
  })

  test('a signed report is named by its number, and says where it goes and what stays sent', () => {
    const words = deleteWords(signed)
    expect(words.title).toBe('Delete report #12?')
    expect(words.body).toBe(
      'Service Report for J. Nguyen, Bayswater. It waits in Deleted for 30 days, then it’s gone. Anything already emailed stays in the inboxes it went to.',
    )
    // The record-keeping caution, and the correction as the other way.
    expect(words.caution).toMatch(/record the law requires you to keep/)
    expect(words.caution).toMatch(/issue a correction instead/)
    expect([words.confirm, words.cancel]).toEqual([
      'Delete report',
      'Keep report',
    ])
    expect(words.failed.NO_ACCESS).toMatch(/only the business owner/)
  })

  test('one of several versions says they all go', () => {
    expect(deleteWords({ ...signed, version: 3 }).body).toContain(
      'Every version of #12 goes with it.',
    )
    // The replaced first version is the same document.
    expect(deleteWords({ ...signed, replaced: true }).body).toContain(
      'Every version of #12 goes with it.',
    )
    expect(
      deleteWords({ ...signed, version: 2, correcting: true }).body,
    ).toContain(
      'Every version of #12 goes with it, and the correction being drafted.',
    )
    expect(deleteWords({ ...signed, correcting: true }).body).toContain(
      'The correction being drafted goes with it.',
    )
  })

  test('a report locked before numbers existed, or with no client, still reads', () => {
    const words = deleteWords({
      ...signed,
      reportNumber: undefined,
      clientName: '',
      version: 2,
    })
    expect(words.title).toBe('Delete this report?')
    expect(words.body).toMatch(
      /^Service Report, Bayswater\. Every version of it goes with it\./,
    )
  })
})

describe('deleting for good', () => {
  test('a draft keeps its words', () => {
    expect(purgeWords(draft).title).toBe('Delete this draft for good?')
    expect(purgeWords(draft).failed.offline).toMatch(/offline/)
  })

  test('a signed report says what goes with it and that it cannot be undone', () => {
    expect(purgeWords(signed)).toMatchObject({
      title: 'Delete report #12 for good?',
      body: 'The report, with its PDF, photos and email history, is gone, and it can’t be undone. Anything already emailed stays in the inboxes it went to.',
      confirm: 'Delete for good',
    })
    expect(purgeWords({ ...signed, version: 2 }).body).toMatch(
      /^Every version of #12, with its PDFs, photos and email history, is gone/,
    )
    expect(purgeWords({ ...signed, correcting: true }).body).toContain(
      'So is the correction being drafted.',
    )
  })
})

test('restoring says why it could not', () => {
  expect(restoreFailed(draft).ORIGINAL_DELETED).toMatch(
    /Restore that report first/,
  )
  expect(restoreFailed(signed).NO_ACCESS).toMatch(/only the business owner/)
  expect(restoreFailed(signed).default).toMatch(/the report/)
  expect(restoreFailed(draft).default).toMatch(/the draft/)
})
