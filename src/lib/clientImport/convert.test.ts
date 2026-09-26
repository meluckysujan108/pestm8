import { describe, expect, test } from 'vitest'
import { siteKey } from '../../../convex/lib/clientImport'
import {
  importable,
  indexExisting,
  statusOf,
  summarise,
  toImportClient,
} from './convert'
import type { Id } from '../../../convex/_generated/dataModel'
import type { ReviewClient, ReviewIssue, ReviewSite } from './types'

const SITE: ReviewSite = {
  addressLine: '12 Wattle St',
  suburb: 'Bayswater',
  state: 'WA',
  postcode: '6053',
}

function client(over: Partial<ReviewClient> = {}): ReviewClient {
  return {
    key: 'c1',
    rowNumbers: [1],
    kind: 'person',
    name: 'Jo Bloggs',
    sites: [SITE],
    issues: [],
    included: true,
    ...over,
  }
}

const issue = (
  level: ReviewIssue['level'],
  siteIndex?: number,
): ReviewIssue => ({
  level,
  field: siteIndex === undefined ? 'phone' : 'postcode',
  ...(siteIndex === undefined ? {} : { siteIndex }),
  message: level,
})

describe('statusOf', () => {
  test('the worst issue, in the order types.ts gives', () => {
    expect(statusOf(client())).toBe('ready')
    expect(statusOf(client({ issues: [issue('fixed')] }))).toBe('fixed')
    expect(
      statusOf(client({ issues: [issue('fixed'), issue('warning')] })),
    ).toBe('warning')
    expect(
      statusOf(client({ issues: [issue('warning'), issue('error')] })),
    ).toBe('error')
  })

  test('every site already here, between an error and a warning', () => {
    const here = { ...SITE, duplicate: true }
    expect(
      statusOf(client({ sites: [here], issues: [issue('warning')] })),
    ).toBe('duplicate')
    expect(statusOf(client({ sites: [here], issues: [issue('error')] }))).toBe(
      'error',
    )
    // One of two here: the other still goes.
    expect(statusOf(client({ sites: [here, SITE] }))).toBe('ready')
  })

  test("an issue about a site that isn't sent doesn't count", () => {
    const here = { ...SITE, duplicate: true }
    expect(
      statusOf(client({ sites: [here, SITE], issues: [issue('error', 0)] })),
    ).toBe('ready')
    expect(
      statusOf(client({ sites: [here, SITE], issues: [issue('error', 1)] })),
    ).toBe('error')
  })

  test('no sites at all is not "already here"', () => {
    expect(statusOf(client({ sites: [] }))).toBe('ready')
  })
})

test('importable: kept in, and neither an error nor already here', () => {
  expect(importable(client())).toBe(true)
  expect(importable(client({ issues: [issue('warning')] }))).toBe(true)
  expect(importable(client({ included: false }))).toBe(false)
  expect(importable(client({ issues: [issue('error')] }))).toBe(false)
  expect(importable(client({ sites: [{ ...SITE, duplicate: true }] }))).toBe(
    false,
  )
})

describe('toImportClient', () => {
  test("drops sites already here, blanks, and the review's own fields", () => {
    const sent = toImportClient(
      client({
        name: '  Jo Bloggs ',
        phone: ' ',
        email: 'jo@example.com',
        contactPerson: 'Ann',
        abn: '51824753556',
        sites: [
          { ...SITE, duplicate: true },
          {
            addressLine: ' 14 Wattle St ',
            suburb: 'Bayswater',
            state: 'wa',
            postcode: '6053',
            siteContactName: 'Col',
            note: '  ',
          },
        ],
        issues: [issue('fixed')],
      }),
    )
    expect(sent).toEqual({
      key: 'c1',
      kind: 'person',
      name: 'Jo Bloggs',
      email: 'jo@example.com',
      sites: [
        {
          addressLine: '14 Wattle St',
          suburb: 'Bayswater',
          state: 'WA',
          postcode: '6053',
        },
      ],
    })
    // toEqual lets an undefined field pass as a missing one; Convex doesn't.
    expect(Object.keys(sent).sort()).toEqual([
      'email',
      'key',
      'kind',
      'name',
      'sites',
    ])
    expect(Object.keys(sent.sites[0]).sort()).toEqual([
      'addressLine',
      'postcode',
      'state',
      'suburb',
    ])
  })

  test('a business keeps its contact, ABN, site contacts and the client it joins', () => {
    const id = 'client1' as Id<'clients'>
    const sent = toImportClient(
      client({
        kind: 'business',
        name: 'Wattle Strata',
        contactPerson: 'Ann Lee',
        abn: '51824753556',
        existingClientId: id,
        sites: [
          {
            ...SITE,
            siteContactName: 'Col',
            siteContactPhone: '0433 222 111',
            note: 'Gate code 1234',
          },
        ],
      }),
    )
    expect(sent).toMatchObject({
      contactPerson: 'Ann Lee',
      abn: '51824753556',
      existingClientId: id,
      sites: [
        {
          siteContactName: 'Col',
          siteContactPhone: '0433 222 111',
          note: 'Gate code 1234',
        },
      ],
    })
  })
})

test('indexExisting: names and sites, archived clients left out', () => {
  const index = indexExisting(
    [
      { _id: 'a' as Id<'clients'>, name: 'Jo Bloggs' },
      { _id: 'b' as Id<'clients'>, name: 'JO  BLOGGS' },
      { _id: 'c' as Id<'clients'>, name: 'Old & Co', archivedAt: 1 },
      { _id: 'd' as Id<'clients'>, name: '  ' },
    ],
    [
      {
        addressLine: '12 Wattle Street',
        suburb: 'Bayswater',
        postcode: '6053',
      },
    ],
  )
  expect([...index.clientsByName]).toEqual([['jo bloggs', 'a']])
  expect(
    index.siteKeys.has(
      siteKey({
        addressLine: '12 wattle st',
        suburb: 'BAYSWATER',
        postcode: '6053',
      }),
    ),
  ).toBe(true)
})

test('summarise: a count per status, and all', () => {
  expect(
    summarise([
      client(),
      client({ issues: [issue('error')] }),
      client({ issues: [issue('error')], included: false }),
      client({ sites: [{ ...SITE, duplicate: true }] }),
      client({ issues: [issue('fixed')] }),
    ]),
  ).toEqual({ all: 5, error: 2, duplicate: 1, warning: 0, fixed: 1, ready: 1 })
})
