import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildReview } from '#/lib/clientImport/build'
import { runOfflineChecks } from '#/lib/clientImport/checks'
import { autoMap, detectSource } from '#/lib/clientImport/columns'
import {
  importable,
  statusOf,
  toImportClient,
} from '#/lib/clientImport/convert'
import { readImportFile } from '#/lib/clientImport/read'
import { checkImportClient } from '../../../../convex/lib/clientImport'
import type { ReviewClient } from '#/lib/clientImport/types'

/**
 * The e2e fixtures (e2e/fixtures/imports), read the way the page reads
 * them. e2e/clientImport.spec.ts counts on each of these — the source it
 * names, the columns it matches, which clients can go in — and a browser run
 * is slow to say which one moved; this says it in a second.
 */

async function review(name: string) {
  const bytes = readFileSync(
    new URL(`../../../../e2e/fixtures/imports/${name}`, import.meta.url),
  )
  const sheet = await readImportFile(
    new File([bytes], name, { type: 'text/csv' }),
  )
  const mapping = autoMap(sheet)
  const built = buildReview(sheet, mapping, {
    // The e2e business is in WA.
    businessState: 'WA',
    existing: { clientsByName: new Map(), siteKeys: new Set() },
  })
  const clients = await runOfflineChecks(built, { businessState: 'WA' })
  const column = (header: string) => mapping[sheet.headers.indexOf(header)]
  const named = (clientName: string) =>
    clients.find((c) => c.name === clientName) as ReviewClient
  return { sheet, clients, column, named }
}

describe('jobber-clients.csv', () => {
  it('reads as Jobber, with the service address as the site', async () => {
    const { sheet, column } = await review('jobber-clients.csv')
    expect(detectSource(sheet.headers)).toBe('Jobber')
    expect(column('Service Street 1')).toBe('street')
    expect(column('Billing Street 1')).toBeNull()
  })

  it('makes the three clients the e2e expects', async () => {
    const { clients, named } = await review('jobber-clients.csv')
    expect(clients).toHaveLength(3)

    const jane = named('Jane Citizen')
    expect(jane.rowNumbers).toEqual([1, 2])
    expect(jane.sites.map((s) => s.addressLine)).toEqual([
      '12 Wattle Street',
      '7 Banksia Road',
    ])
    expect(jane.sites[0].note).toContain('Gate code 1234')

    const topEnd = named('Top End Holdings Pty Ltd')
    expect(topEnd.kind).toBe('business')
    expect(topEnd.contactPerson).toBe('Sam Lee')
    expect(topEnd.sites[0].postcode).toBe('0810')
    expect(topEnd.issues.map((i) => i.message)).toContain('Postcode 810 → 0810')

    const bob = named('Bob Walker')
    expect(statusOf(bob)).toBe('error')
    expect(importable(bob)).toBe(false)

    const going = clients.filter(importable)
    expect(going.map((c) => c.name)).toEqual([
      'Jane Citizen',
      'Top End Holdings Pty Ltd',
    ])
    // What the page sends, the server's own rules accept.
    for (const c of going) {
      expect(checkImportClient(toImportClient(c)).ok).toBe(true)
    }
    expect(going.flatMap((c) => c.sites)).toHaveLength(3)
  })
})

describe('xero-contacts.csv', () => {
  it('reads as Xero, with the street address and not the postal one', async () => {
    const { sheet, column } = await review('xero-contacts.csv')
    expect(detectSource(sheet.headers)).toBe('Xero')
    expect(column('SAAddressLine1')).toBe('street')
    expect(column('POAddressLine1')).toBeNull()
    expect(column('TaxNumber')).toBe('abn')
  })

  it('puts the ABN on the business, and both clients can go in', async () => {
    const { clients, named } = await review('xero-contacts.csv')
    const cafe = named('Harbourside Cafe')
    expect(cafe.kind).toBe('business')
    expect(cafe.abn).toBe('51824753556')
    expect(cafe.contactPerson).toBe('Mia Chen')
    expect(cafe.sites).toEqual([
      expect.objectContaining({
        addressLine: '8 Mews Road',
        suburb: 'Fremantle',
        postcode: '6160',
      }),
    ])
    expect(named('Priya Sharma').kind).toBe('person')
    expect(clients.filter(importable)).toHaveLength(2)
  })
})
