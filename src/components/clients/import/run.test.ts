import { describe, expect, it } from 'vitest'
import {
  notImportedFileName,
  outcomeOf,
  rowsNotImported,
  sendBatches,
  toBatches,
} from './run'
import type { ImportResult } from '../../../../convex/lib/clientImport'
import type { ReviewClient } from '#/lib/clientImport/types'

function client(key: string, over: Partial<ReviewClient> = {}): ReviewClient {
  return {
    key,
    rowNumbers: [Number(key.slice(1))],
    kind: 'person',
    name: `Client ${key}`,
    sites: [
      {
        addressLine: '1 Main St',
        suburb: 'Perth',
        state: 'WA',
        postcode: '6000',
      },
    ],
    issues: [],
    included: true,
    ...over,
  }
}

function result(
  key: string,
  status: ImportResult['status'],
  over: Partial<ImportResult> = {},
): ImportResult {
  return {
    key,
    status,
    sitesCreated: status === 'created' || status === 'added' ? 1 : 0,
    sitesSkipped: status === 'skipped' ? 1 : 0,
    notesCreated: 0,
    ...over,
  }
}

describe('toBatches', () => {
  it('cuts the clients into batches of the server’s size, in order', () => {
    const batches = toBatches(Array.from({ length: 60 }, (_, i) => i))
    expect(batches.map((b) => b.length)).toEqual([25, 25, 10])
    expect(batches[1][0]).toBe(25)
  })

  it('makes no batch of nothing', () => {
    expect(toBatches([])).toEqual([])
  })
})

describe('sendBatches', () => {
  it('sends one batch after another and says where it got to', async () => {
    const sent: Array<Array<number>> = []
    const landed: Array<number> = []
    const at = await sendBatches(
      [[1, 2], [3], [4]],
      0,
      async (batch) => {
        sent.push(batch)
        return batch.map((n) => n * 10)
      },
      (index) => landed.push(index),
    )
    expect(at).toBe(3)
    expect(sent).toEqual([[1, 2], [3], [4]])
    expect(landed).toEqual([0, 1, 2])
  })

  it('stops at a failure, and a retry carries on from there without re-sending', async () => {
    const batches = [[1], [2], [3]]
    const sent: Array<number> = []
    let landedUpTo = 0
    let fail = true
    const send = async (batch: Array<number>) => {
      if (batch[0] === 2 && fail) {
        fail = false
        throw new Error('Connection lost')
      }
      sent.push(batch[0])
      return batch
    }
    const note = (index: number) => {
      landedUpTo = index + 1
    }

    await expect(sendBatches(batches, 0, send, note)).rejects.toThrow(
      'Connection lost',
    )
    expect(landedUpTo).toBe(1)

    const at = await sendBatches(batches, landedUpTo, send, note)
    expect(at).toBe(3)
    // Batch 1 went once, never twice.
    expect(sent).toEqual([1, 2, 3])
  })

  it('stops between batches when asked, leaving the rest unsent', async () => {
    let calls = 0
    const at = await sendBatches(
      [[1], [2], [3]],
      0,
      async (batch) => {
        calls += 1
        return batch
      },
      () => undefined,
      () => calls >= 1,
    )
    expect(at).toBe(1)
    expect(calls).toBe(1)
  })
})

describe('outcomeOf', () => {
  it('counts what went in, what was already here and what didn’t go', () => {
    const review = [
      client('c1', {
        sites: [
          {
            addressLine: '1 Main St',
            suburb: 'Perth',
            state: 'WA',
            postcode: '6000',
          },
          {
            addressLine: '2 Main St',
            suburb: 'Perth',
            state: 'WA',
            postcode: '6000',
            duplicate: true,
          },
        ],
      }),
      client('c2'),
      client('c3'),
      client('c4', { included: false }),
      client('c5', {
        issues: [
          {
            level: 'error',
            field: 'suburb',
            siteIndex: 0,
            message: 'No suburb.',
          },
        ],
      }),
      client('c6', {
        sites: [
          {
            addressLine: '9 High St',
            suburb: 'Perth',
            state: 'WA',
            postcode: '6000',
            duplicate: true,
          },
        ],
      }),
    ]
    const results = [
      result('c1', 'created', { notesCreated: 1 }),
      result('c2', 'added', { sitesCreated: 2 }),
      result('c3', 'failed', {
        reason: 'The ABN does not pass the ATO check.',
      }),
    ]

    const outcome = outcomeOf(review, results)
    expect(outcome.created).toBe(1)
    expect(outcome.added).toBe(1)
    expect(outcome.sites).toBe(3)
    expect(outcome.notes).toBe(1)
    // c1's duplicate site, never sent, and all of c6.
    expect(outcome.skippedSites).toBe(2)
    expect(outcome.notImported).toEqual([
      {
        key: 'c3',
        name: 'Client c3',
        reason: 'The ABN does not pass the ATO check.',
      },
      { key: 'c4', name: 'Client c4', reason: 'Left out' },
      { key: 'c5', name: 'Client c5', reason: 'No suburb.' },
    ])
  })

  it('names the clients an import that stopped early never sent', () => {
    const outcome = outcomeOf(
      [client('c1'), client('c2')],
      [result('c1', 'created')],
    )
    expect(outcome.notImported).toEqual([
      {
        key: 'c2',
        name: 'Client c2',
        reason: 'Not sent — the import stopped before this one',
      },
    ])
  })
})

describe('rowsNotImported', () => {
  const review = [
    client('c1', { rowNumbers: [1, 2] }),
    client('c3', { included: false }),
    client('c4', {
      issues: [{ level: 'error', field: 'name', message: 'No client name.' }],
    }),
    client('c5', {
      sites: [
        {
          addressLine: '9 High St',
          suburb: 'Perth',
          state: 'WA',
          postcode: '6000',
          duplicate: true,
        },
      ],
    }),
  ]

  it('before the import: every row that won’t be sent, with why', () => {
    const { rowNumbers, reasons } = rowsNotImported(review)
    expect(rowNumbers).toEqual([3, 4, 5])
    expect(reasons.get(3)).toBe('Left out')
    expect(reasons.get(4)).toBe('No client name.')
    expect(reasons.get(5)).toBe('Already in PestM8')
  })

  it('after it: also the ones the server refused or found already here', () => {
    const withMore = [...review, client('c6'), client('c7')]
    const { rowNumbers, reasons } = rowsNotImported(withMore, [
      result('c1', 'created'),
      result('c6', 'failed', {
        reason: 'x21 is not a phone number.',
      }),
      result('c7', 'skipped'),
    ])
    expect(rowNumbers).toEqual([3, 4, 5, 6, 7])
    expect(reasons.get(6)).toBe('x21 is not a phone number.')
    expect(reasons.get(7)).toBe('Already in PestM8')
    // The client that went in keeps its rows out of the download.
    expect(reasons.has(1)).toBe(false)
    expect(reasons.has(2)).toBe(false)
  })
})

describe('notImportedFileName', () => {
  it('names the download after the file it came from', () => {
    expect(notImportedFileName('Jobber clients.csv')).toBe(
      'Jobber clients-not-imported.csv',
    )
    expect(notImportedFileName('contacts.xlsx')).toBe(
      'contacts-not-imported.csv',
    )
    expect(notImportedFileName('.csv')).toBe('clients-not-imported.csv')
  })
})
