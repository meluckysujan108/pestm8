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
      "Couldn't find Artadale in WA. Did you mean Attadale?",
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

  test('every client, a chunk at a time, with a count', async () => {
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
    expect(progress).toEqual([
      [100, 150],
      [150, 150],
    ])
  })
})
