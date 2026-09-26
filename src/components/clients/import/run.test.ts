import { describe, expect, it } from 'vitest'
import {
  notImportedFileName,
  outcomeOf,
  rowsNotImported,
  sendBatches,
  toBatches,
} from './run'
import {
  IMPORT_BATCH_SITES,
  IMPORT_BATCH_SIZE,
} from '../../../../convex/lib/clientImport'
import type { ImportResult } from '../../../../convex/lib/clientImport'
import type { ReviewClient, ReviewSite } from '#/lib/clientImport/types'

const SITE: ReviewSite = {
  addressLine: '1 Main St',
  suburb: 'Perth',
  state: 'WA',
  postcode: '6000',
}

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

/** A client to batch: its place in the file, and how many sites. */
const withSites = (id: number, sites: number) => ({
  id,
  sites: Array.from({ length: sites }, () => SITE),
})

const ids = (batches: Array<Array<{ id: number }>>) =>
  batches.map((batch) => batch.map((c) => c.id))

describe('toBatches', () => {
  it('cuts one-site clients into batches of the server’s size, in order', () => {
    const batches = toBatches(
      Array.from({ length: 60 }, (_, i) => withSites(i, 1)),
    )
    expect(batches.map((b) => b.length)).toEqual([
      IMPORT_BATCH_SIZE,
      IMPORT_BATCH_SIZE,
      60 - 2 * IMPORT_BATCH_SIZE,
    ])
    expect(batches[1][0].id).toBe(IMPORT_BATCH_SIZE)
  })

  it('closes a batch early when its sites would pass the limit', () => {
    const batches = toBatches(
      [withSites(1, 3), withSites(2, 4), withSites(3, 2), withSites(4, 1)],
      { clients: 25, sites: 6 },
    )
    // 3 + 4 would be 7; 4 + 2 is 6, and one more would be 7.
    expect(ids(batches)).toEqual([[1], [2, 3], [4]])
  })

  it('never splits a client: one with more sites than a batch goes alone', () => {
    const batches = toBatches(
      [withSites(1, 1), withSites(2, 9), withSites(3, 1)],
      { clients: 25, sites: 5 },
    )
    expect(ids(batches)).toEqual([[1], [2], [3]])
  })

  it('stops at whichever limit comes first', () => {
    const batches = toBatches(
      Array.from({ length: 5 }, (_, i) => withSites(i, 1)),
      { clients: 2, sites: 100 },
    )
    expect(ids(batches)).toEqual([[0, 1], [2, 3], [4]])
  })

  it('keeps every multi-client batch inside the server’s site limit', () => {
    const clients = Array.from({ length: 300 }, (_, i) =>
      withSites(i, (i * 7) % 60),
    )
    const batches = toBatches(clients)
    for (const batch of batches) {
      const sites = batch.reduce((n, c) => n + c.sites.length, 0)
      expect(batch.length).toBeLessThanOrEqual(IMPORT_BATCH_SIZE)
      if (batch.length > 1) {
        expect(sites).toBeLessThanOrEqual(IMPORT_BATCH_SITES)
      }
    }
    expect(batches.flat().map((c) => c.id)).toEqual(clients.map((c) => c.id))
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
      { key: 'c5', name: 'Client c5', reason: 'No suburb.' },
    ])
    // Left out is the person's choice, not a failure: said apart.
    expect(outcome.leftOut).toEqual([{ key: 'c4', name: 'Client c4' }])
  })

  it('names a client the server turned away as already here, without saying it’s in PestM8', () => {
    const outcome = outcomeOf(
      [
        client('c1'),
        client('c2', { sites: [SITE, { ...SITE, addressLine: '2 Main St' }] }),
        client('c3'),
      ],
      [
        result('c1', 'created'),
        result('c2', 'skipped', { sitesSkipped: 2 }),
        result('c3', 'skipped', {
          reason: '1 Main St is already on Jo Bloggs',
        }),
      ],
    )
    expect(outcome.created).toBe(1)
    expect(outcome.skippedSites).toBe(3)
    expect(outcome.notImported).toEqual([
      {
        key: 'c2',
        name: 'Client c2',
        reason:
          'Its addresses are already on this client in PestM8, or earlier in this file',
      },
      // The server's own words, when it gives them.
      {
        key: 'c3',
        name: 'Client c3',
        reason: '1 Main St is already on Jo Bloggs',
      },
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
    // Not "Already in PestM8": the review said it wasn't, and the client
    // itself isn't — only its address is, or went in earlier in the file.
    expect(reasons.get(7)).toBe(
      'Its address is already on this client in PestM8, or earlier in this file',
    )
    // The client that went in whole keeps its rows out of the download.
    expect(reasons.has(1)).toBe(false)
    expect(reasons.has(2)).toBe(false)
  })

  it('lists a client that went in without a site the server turned away', () => {
    const reviewed = [
      client('c1', {
        rowNumbers: [1, 2],
        sites: [SITE, { ...SITE, addressLine: '2 Main St', note: 'Gate 4321' }],
      }),
      // A site the review knew was here, never sent: nothing was lost.
      client('c2', {
        rowNumbers: [3, 4],
        sites: [SITE, { ...SITE, addressLine: '9 High St', duplicate: true }],
      }),
    ]
    const { rowNumbers, reasons } = rowsNotImported(reviewed, [
      result('c1', 'created', { sitesCreated: 1, sitesSkipped: 1 }),
      result('c2', 'added', { sitesCreated: 1, sitesSkipped: 0 }),
    ])
    expect(rowNumbers).toEqual([1, 2])
    expect(reasons.get(2)).toBe(
      'An address was already here or earlier in this file — anything on its row (a note) didn’t come across',
    )
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
