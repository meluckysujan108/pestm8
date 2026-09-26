import { afterEach, describe, expect, test, vi } from 'vitest'
import { siteKey } from '../../../convex/lib/clientImport'
import { buildReview, recheckClient } from './build'
import { checkClientOffline, runOfflineChecks } from './checks'
import { statusOf } from './convert'
import type { ExistingIndex, ReviewClient } from './types'

const NONE: ExistingIndex = { clientsByName: new Map(), siteKeys: new Set() }
const opts = { businessState: 'WA', existing: NONE }

function clients(
  addresses: Array<string>,
  existing: ExistingIndex = NONE,
): Array<ReviewClient> {
  return buildReview(
    {
      fileName: 'clients.csv',
      headers: ['Name', 'Address'],
      rows: addresses.map((a, i) => [`Client ${i + 1}`, a]),
    },
    ['name', 'address'],
    { businessState: 'WA', existing },
  )
}

const messages = (client: ReviewClient) => client.issues.map((i) => i.message)

describe('checkClientOffline', () => {
  test("a postcode that isn't the suburb's: a warning, with its fix", async () => {
    const [client] = clients(['12 Walcott St, Mount Lawley WA 6000'])
    const checked = await checkClientOffline(client, { businessState: 'WA' })
    expect(checked.issues).toEqual([
      expect.objectContaining({
        level: 'warning',
        field: 'postcode',
        siteIndex: 0,
        message: "Mount Lawley's postcode is usually 6050.",
        fix: expect.objectContaining({ label: 'Use 6050' }),
      }),
    ])
    expect(statusOf(checked)).toBe('warning')

    const fixed = checked.issues[0].fix!.apply(checked)
    expect(fixed.sites[0].postcode).toBe('6050')
    expect(fixed.issues).toEqual([])
    const again = await checkClientOffline(recheckClient(fixed, opts), {
      businessState: 'WA',
    })
    expect(again.issues).toEqual([])
    expect(statusOf(again)).toBe('ready')
  })

  test('outside the work area, and a misspelt suburb', async () => {
    const [darwin, typo] = clients([
      '12 East Point Rd, Fannie Bay NT 0820',
      '1 Main St, Artadale WA 6156',
    ])
    expect(
      messages(await checkClientOffline(darwin, { businessState: 'WA' })),
    ).toEqual(['This address is in NT — outside WA, where you work.'])
    const checked = await checkClientOffline(typo, { businessState: 'WA' })
    expect(messages(checked)).toEqual([
      'Could not find Artadale in WA. Did you mean Attadale?',
    ])
    expect(checked.issues[0]).toMatchObject({ field: 'suburb', siteIndex: 0 })
  })

  test('run again, the warnings are replaced, not piled up', async () => {
    const [client] = clients(['12 Walcott St, Mount Lawley WA 6000'])
    const once = await checkClientOffline(client, { businessState: 'WA' })
    const twice = await checkClientOffline(once, { businessState: 'WA' })
    expect(messages(twice)).toEqual(messages(once))
    expect(twice.issues).toHaveLength(1)
  })

  test('a clean client comes back as it was', async () => {
    const [client] = clients(['12 Walcott St, Mount Lawley WA 6050'])
    expect(await checkClientOffline(client, { businessState: 'WA' })).toBe(
      client,
    )
  })

  test('a site already in PestM8 is not checked', async () => {
    const existing: ExistingIndex = {
      clientsByName: new Map(),
      siteKeys: new Set([
        siteKey({
          addressLine: '12 Walcott St',
          suburb: 'Mount Lawley',
          postcode: '6000',
        }),
      ]),
    }
    const [client] = clients(['12 Walcott St, Mount Lawley WA 6000'], existing)
    const checked = await checkClientOffline(client, { businessState: 'WA' })
    expect(checked.issues).toEqual([])
    expect(statusOf(checked)).toBe('duplicate')
  })

  test("a bad postcode is said once, by the review's own error", async () => {
    const [client] = clients(['1 Hay St, Perth WA 60001'])
    const checked = await checkClientOffline(client, { businessState: 'WA' })
    expect(checked.issues.filter((i) => i.level === 'error')).toHaveLength(1)
  })

  test('recheckClient keeps the warnings while the address is unchanged', async () => {
    const [client] = clients(['12 Walcott St, Mount Lawley WA 6000'])
    const checked = await checkClientOffline(client, { businessState: 'WA' })

    const renamed = recheckClient({ ...checked, name: 'Jo Bloggs' }, opts)
    expect(messages(renamed)).toEqual([
      "Mount Lawley's postcode is usually 6050.",
    ])

    const moved = recheckClient(
      {
        ...checked,
        sites: [{ ...checked.sites[0], postcode: '6050' }],
      },
      opts,
    )
    expect(moved.issues).toEqual([])
  })
})

describe('runOfflineChecks', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('never asks the network — the street lookup is a fair-use service', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    await runOfflineChecks(
      clients([
        '12 Walcott St, Mount Lawley WA 6000',
        '1 Zyxwv St, Zyxwvton WA 6050',
        '12 East Point Rd, Fannie Bay NT 0820',
      ]),
      { businessState: 'WA' },
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  test('every client, with a count that ends at the total', async () => {
    const addresses = Array.from({ length: 150 }, (_, i) =>
      i % 2 === 0
        ? `${i + 1} Walcott St, Mount Lawley WA 6000`
        : `${i + 1} Walcott St, Mount Lawley WA 6050`,
    )
    const progress: Array<[number, number]> = []
    const checked = await runOfflineChecks(clients(addresses), {
      businessState: 'WA',
      onProgress: (done, total) => progress.push([done, total]),
    })
    expect(checked).toHaveLength(150)
    expect(checked.filter((c) => statusOf(c) === 'warning')).toHaveLength(75)
    expect(checked.filter((c) => statusOf(c) === 'ready')).toHaveLength(75)
    expect(progress.at(-1)).toEqual([150, 150])
    for (const [i, [done, total]] of progress.entries()) {
      expect(total).toBe(150)
      expect(done).toBeGreaterThan(i === 0 ? 0 : progress[i - 1][0])
    }
  })

  /** Ten Mount Lawley clients, half with its postcode wrong, and the WA
   * table loaded, so a check waits on nothing but itself. */
  async function ten() {
    const list = clients(
      Array.from(
        { length: 10 },
        (_, i) => `${i + 1} Walcott St, Mount Lawley WA 60${i % 2 ? 50 : 60}`,
      ),
    )
    await checkClientOffline(list[0], { businessState: 'WA' })
    return list
  }

  /** A clock that moves on `step` ms each time it is looked at. */
  function clockOf(step: number) {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => (now += step))
  }

  test('a breath whenever 12 ms have gone by, by the clock and not a count', async () => {
    const list = await ten()
    // 5 ms a look: the third client after a breath takes it past 12.
    clockOf(5)
    const progress: Array<[number, number]> = []
    const checked = await runOfflineChecks(list, {
      businessState: 'WA',
      onProgress: (done, total) => progress.push([done, total]),
    })
    expect(checked).toHaveLength(10)
    expect(progress).toEqual([
      [3, 10],
      [6, 10],
      [9, 10],
      [10, 10],
    ])

    // A suburb the tables don't have is slow to check: 20 ms a client is a
    // breath after every one.
    vi.restoreAllMocks()
    clockOf(20)
    progress.length = 0
    await runOfflineChecks(list.slice(0, 3), {
      businessState: 'WA',
      onProgress: (done, total) => progress.push([done, total]),
    })
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ])
  })

  test('the page gets its turn at each breath, and a quick run needs none', async () => {
    const list = await ten()
    clockOf(20)
    let doneWhenPageRan = -1
    const progress: Array<number> = []
    setTimeout(() => (doneWhenPageRan = progress.length), 0)
    await runOfflineChecks(list, {
      businessState: 'WA',
      onProgress: (done) => progress.push(done),
    })
    expect(doneWhenPageRan).toBe(1)

    // The clock stands still: all ten in one go, one count at the end, and
    // the page's turn comes after.
    vi.restoreAllMocks()
    vi.spyOn(performance, 'now').mockReturnValue(0)
    doneWhenPageRan = -1
    progress.length = 0
    setTimeout(() => (doneWhenPageRan = progress.length), 0)
    await runOfflineChecks(list, {
      businessState: 'WA',
      onProgress: (done) => progress.push(done),
    })
    expect(progress).toEqual([10])
    expect(doneWhenPageRan).toBe(-1)
  })

  test('stops at the next breath once the result is no longer wanted', async () => {
    const list = await ten()
    clockOf(20)
    const progress: Array<number> = []
    const checked = await runOfflineChecks(list, {
      businessState: 'WA',
      onProgress: (done) => progress.push(done),
      stopped: () => progress.length >= 2,
    })
    expect(checked).toHaveLength(2)
    // No count after it stopped: it never got to the end.
    expect(progress).toEqual([1, 2])
  })

  test('nothing to check: no count, nothing back', async () => {
    const progress: Array<number> = []
    expect(
      await runOfflineChecks([], {
        businessState: 'WA',
        onProgress: (done) => progress.push(done),
      }),
    ).toEqual([])
    expect(progress).toEqual([])
  })
})
