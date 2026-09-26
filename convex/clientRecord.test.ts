/// <reference types="vite/client" />
import { describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import {
  clientNumberFromText,
  normaliseTags,
  statusFromText,
  tagsFromText,
} from './lib/clientRecord'
import type { Id } from './_generated/dataModel'
import type { ImportClient } from './lib/clientImport'

/**
 * A client's number, status and tags: numbered on the way in whichever way
 * it comes (the form, an import), never two with one number, and the three
 * editable afterwards.
 */

async function setup() {
  const t = testApp()
  const owner = await createActor(t, { email: 'terence@coastal.test' })
  const { businessId } = await createBusiness(t, owner)
  return { t, owner, businessId }
}

type Setup = Awaited<ReturnType<typeof setup>>

let street = 0
async function newClient(s: Setup, fields: Record<string, unknown> = {}) {
  street++
  const propertyId = await s.owner.as.mutation(api.properties.create, {
    businessId: s.businessId,
    clientName: `Client ${street}`,
    addressLine: `${street} Marine Parade`,
    suburb: 'Cottesloe',
    state: 'WA',
    postcode: '6011',
    ...fields,
  })
  return s.t.run(async (ctx) => {
    const property = await ctx.db.get(propertyId)
    return (await ctx.db.get(property!.clientId))!
  })
}

async function importClients(s: Setup, clients: Array<ImportClient>) {
  const importId = await s.owner.as.mutation(api.clientImports.start, {
    businessId: s.businessId,
    fileName: 'clients.csv',
  })
  return s.owner.as.mutation(api.clientImports.addBatch, {
    businessId: s.businessId,
    importId,
    clients,
  })
}

const numbersOf = (s: Setup) =>
  s.t.run(async (ctx) =>
    (await ctx.db.query('clients').collect()).map((c) => [
      c.name,
      c.clientNumber,
    ]),
  )

function imported(
  key: string,
  name: string,
  fields: Partial<ImportClient> = {},
): ImportClient {
  return {
    key,
    kind: 'person',
    name,
    sites: [
      {
        addressLine: `${key} Wattle Street`,
        suburb: 'Bayswater',
        state: 'WA',
        postcode: '6053',
      },
    ],
    ...fields,
  }
}

describe('client numbers', () => {
  test('a new client gets the next number, from 1', async () => {
    const s = await setup()
    const a = await newClient(s)
    const b = await newClient(s)
    expect([a.clientNumber, b.clientNumber]).toEqual([1, 2])
  })

  test('an import keeps its numbers, and the next client follows the highest', async () => {
    const s = await setup()
    await importClients(s, [
      imported('1', 'Alan', { clientNumber: 1928 }),
      imported('2', 'Kayleen', { clientNumber: 7 }),
    ])
    const next = await newClient(s)
    expect(next.clientNumber).toBe(1929)
  })

  test('a number already taken gets the next free one instead', async () => {
    const s = await setup()
    await newClient(s, { clientName: 'Jane Doe' })
    await importClients(s, [
      imported('1', 'Alan', { clientNumber: 1 }),
      imported('2', 'Riley', { clientNumber: 5 }),
      imported('3', 'Russell', { clientNumber: 5 }),
    ])
    expect(await numbersOf(s)).toEqual([
      ['Jane Doe', 1],
      ['Alan', 2],
      ['Riley', 5],
      ['Russell', 6],
    ])
  })

  test('the backfill numbers older clients after the highest, oldest first', async () => {
    const s = await setup()
    await s.t.run(async (ctx) => {
      for (const name of ['Old One', 'Old Two']) {
        await ctx.db.insert('clients', {
          businessId: s.businessId,
          kind: 'person',
          name,
          createdAt: 0,
          updatedAt: 0,
        })
      }
    })
    await importClients(s, [imported('1', 'Alan', { clientNumber: 40 })])
    vi.useFakeTimers()
    await s.t.mutation(internal.migrations.clientNumbersV1.backfillAll, {
      cursor: null,
    })
    await s.t.finishAllScheduledFunctions(vi.runAllTimers)
    vi.useRealTimers()
    expect(await numbersOf(s)).toEqual([
      ['Old One', 41],
      ['Old Two', 42],
      ['Alan', 40],
    ])
  })

  test('changed by hand, but never to another client’s', async () => {
    const s = await setup()
    const a = await newClient(s)
    const b = await newClient(s)
    const update = (clientId: Id<'clients'>, clientNumber: number) =>
      s.owner.as.mutation(api.clients.update, {
        businessId: s.businessId,
        clientId,
        clientNumber,
      })
    await update(b._id, 500)
    await expect(update(a._id, 500)).rejects.toThrow('CLIENT_NUMBER_TAKEN')
    await expect(update(a._id, 1.5)).rejects.toThrow('INVALID_CLIENT_NUMBER')
    expect(await numbersOf(s)).toEqual([
      [a.name, 1],
      [b.name, 500],
    ])
  })
})

describe('status and tags', () => {
  test('set on a new client, an import, and an edit', async () => {
    const s = await setup()
    const lead = await newClient(s, {
      status: 'lead',
      tags: [' Real estate ', 'real estate', 'GPC'],
    })
    expect(lead).toMatchObject({ status: 'lead', tags: ['Real estate', 'GPC'] })

    await importClients(s, [
      imported('1', 'Alan', { status: 'inactive', tags: ['Rodents'] }),
    ])
    const alan = await s.t.run(async (ctx) =>
      (await ctx.db.query('clients').collect()).find((c) => c.name === 'Alan'),
    )
    expect(alan).toMatchObject({ status: 'inactive', tags: ['Rodents'] })

    await s.owner.as.mutation(api.clients.update, {
      businessId: s.businessId,
      clientId: lead._id,
      status: 'active',
      tags: [],
    })
    const after = await s.t.run((ctx) => ctx.db.get(lead._id))
    expect(after?.status).toBe('active')
    expect(after?.tags).toBeUndefined()
  })

  test('too many tags, or one too long, is refused', async () => {
    const s = await setup()
    const a = await newClient(s)
    const update = (tags: Array<string>) =>
      s.owner.as.mutation(api.clients.update, {
        businessId: s.businessId,
        clientId: a._id,
        tags,
      })
    await expect(
      update(Array.from({ length: 21 }, (_, i) => `t${i}`)),
    ).rejects.toThrow('TOO_MANY_TAGS')
    await expect(update(['x'.repeat(41)])).rejects.toThrow('TAG_TOO_LONG')
  })
})

describe('reading them from a spreadsheet', () => {
  test.each([
    ['1916', 1916],
    ['#1916', 1916],
    ['1916.0', 1916],
    ['0', null],
    ['12a', null],
    ['', null],
  ])('number %s → %s', (text, n) => {
    expect(clientNumberFromText(text)).toBe(n)
  })

  test.each([
    ['Active', 'active'],
    ['Prospect', 'lead'],
    ['Lead', 'lead'],
    ['Archived', 'inactive'],
    ['Inactive', 'inactive'],
    ['Maybe', null],
  ])('status %s → %s', (text, status) => {
    expect(statusFromText(text)).toBe(status)
  })

  test('tags split on commas and semicolons, kept once', () => {
    expect(
      normaliseTags(tagsFromText('GPC, Rodents; gpc |Real  estate')),
    ).toEqual(['GPC', 'Rodents', 'Real estate'])
  })
})
