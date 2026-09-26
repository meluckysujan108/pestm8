import { describe, expect, it } from 'vitest'
import { buildReview, recheckClient } from '#/lib/clientImport/build'
import { checkClientOffline } from '#/lib/clientImport/checks'
import { statusOf } from '#/lib/clientImport/convert'
import { applyDraft, blankSite, draftOf } from './draft'
import type {
  ExistingIndex,
  ReviewClient,
  ReviewSite,
} from '#/lib/clientImport/types'

const site = (addressLine: string, over: Partial<ReviewSite> = {}) => ({
  addressLine,
  suburb: 'Bayswater',
  state: 'WA',
  postcode: '6053',
  ...over,
})

const client: ReviewClient = {
  key: 'c1',
  rowNumbers: [1, 2, 3],
  kind: 'business',
  name: 'Harbour Strata',
  contactPerson: 'Mia Chen',
  sites: [
    site('12 Wattle St'),
    site('see notes', { suburb: '' }),
    site('7 Banksia Rd', { note: 'Gate 1234' }),
  ],
  issues: [
    { level: 'error', field: 'suburb', siteIndex: 1, message: 'No suburb.' },
    {
      level: 'warning',
      field: 'postcode',
      siteIndex: 2,
      message: 'Bayswater is usually 6053.',
    },
    { level: 'warning', field: 'email', message: 'No email.' },
  ],
  included: true,
}

describe('the edit sheet’s draft', () => {
  it('gives each site a stable id and remembers where it came from', () => {
    const draft = draftOf(client)
    expect(draft.sites.map((s) => [s.id, s.from])).toEqual([
      ['site-0', 0],
      ['site-1', 1],
      ['site-2', 2],
    ])
  })

  it('saved as it was, the client is the same, issues and all', () => {
    const saved = applyDraft(client, draftOf(client))
    expect(saved.sites).toEqual(client.sites)
    expect(saved.issues).toBe(client.issues)
    expect(saved.contactPerson).toBe('Mia Chen')
  })

  it('a site removed takes what was said about it with it, and the rest move up with their sites', () => {
    const draft = draftOf(client)
    const saved = applyDraft(client, {
      ...draft,
      sites: draft.sites.filter((s) => s.id !== 'site-1'),
    })
    expect(saved.sites.map((s) => s.addressLine)).toEqual([
      '12 Wattle St',
      '7 Banksia Rd',
    ])
    // "No suburb" was about the site removed, and goes. The Banksia Rd
    // warning was about site 2, which is now site 1, and moves with it.
    // The client's own stays.
    expect(
      saved.issues.map(({ message, siteIndex }) => [message, siteIndex]),
    ).toEqual([
      ['Bayswater is usually 6053.', 1],
      ['No email.', undefined],
    ])
    expect(saved.sites[1].note).toBe('Gate 1234')
  })

  it('a moved issue’s one-tap fix still puts right its own site', () => {
    const fixable: ReviewClient = {
      ...client,
      issues: [
        {
          level: 'warning',
          field: 'suburb',
          siteIndex: 2,
          message: 'Banksia Rd is in Morley.',
          fix: {
            label: 'Use Morley',
            apply: (c) => ({
              ...c,
              sites: c.sites.map((s, i) =>
                i === 2 ? { ...s, suburb: 'Morley' } : s,
              ),
            }),
          },
        },
      ],
    }
    const draft = draftOf(fixable)
    const saved = applyDraft(fixable, {
      ...draft,
      sites: draft.sites.filter((s) => s.id !== 'site-0'),
    })
    const [moved] = saved.issues
    expect(moved.siteIndex).toBe(1)
    const fixed = moved.fix!.apply(saved)
    expect(fixed.sites.map((s) => [s.addressLine, s.suburb])).toEqual([
      ['see notes', ''],
      ['7 Banksia Rd', 'Morley'],
    ])
    // And takes its own issue away, as before.
    expect(fixed.issues).toEqual([])
  })

  it('removing two sites moves the rest past both', () => {
    const draft = draftOf(client)
    const saved = applyDraft(client, {
      ...draft,
      sites: draft.sites.filter((s) => s.id === 'site-2'),
    })
    expect(saved.sites.map((s) => s.addressLine)).toEqual(['7 Banksia Rd'])
    expect(
      saved.issues.map(({ message, siteIndex }) => [message, siteIndex]),
    ).toEqual([
      ['Bayswater is usually 6053.', 0],
      ['No email.', undefined],
    ])
  })

  it('a site added keeps what was said about the others', () => {
    const draft = draftOf(client)
    const saved = applyDraft(client, {
      ...draft,
      sites: [...draft.sites, blankSite('new-1', 'WA')],
    })
    expect(saved.sites).toHaveLength(4)
    expect(saved.issues).toBe(client.issues)
  })

  it('a blank field is none, not an empty string', () => {
    const draft = draftOf(client)
    const saved = applyDraft(client, { ...draft, contactPerson: '  ' })
    expect('contactPerson' in saved).toBe(false)
  })
})

describe('removing a site keeps what the review can’t say again', () => {
  const NONE: ExistingIndex = { clientsByName: new Map(), siteKeys: new Set() }
  const opts = { businessState: 'WA', existing: NONE }
  const STATE_GUESS =
    "“Westen Aust” isn't a state — used WA, from the postcode."

  /** Jane Citizen, with a site whose State the file got wrong, and another. */
  function jane(rows: Array<Array<string>>): ReviewClient {
    const clients = buildReview(
      {
        fileName: 'clients.csv',
        headers: ['Name', 'Street', 'Suburb', 'State', 'Postcode'],
        rows,
      },
      ['name', 'street', 'suburb', 'state', 'postcode'],
      opts,
    )
    expect(clients).toHaveLength(1)
    return clients[0]
  }
  const BAYSWATER = [
    'Jane Citizen',
    '12 Wattle St',
    'Bayswater',
    'Westen Aust',
    '6053',
  ]
  const MORLEY = ['Jane Citizen', '4 Rose St', 'Morley', 'WA', '6062']

  /** The sheet's Save, as the page settles it. */
  async function save(before: ReviewClient, keep: (id: string) => boolean) {
    const draft = draftOf(before)
    const edited = applyDraft(before, {
      ...draft,
      sites: draft.sites.filter((s) => keep(s.id)),
    })
    return checkClientOffline(recheckClient(edited, opts), opts)
  }

  const stateGuesses = (c: ReviewClient) =>
    c.issues
      .filter((i) => i.message === STATE_GUESS)
      .map((i) => [i.level, i.siteIndex])

  it('the state guess about the site that stays is still said, and the client still needs a look', async () => {
    const before = jane([BAYSWATER, MORLEY])
    expect(stateGuesses(before)).toEqual([['warning', 0]])
    expect(statusOf(before)).toBe('warning')

    // Morley removed; Bayswater is untouched.
    const after = await save(before, (id) => id !== 'site-1')
    expect(after.sites.map((s) => s.suburb)).toEqual(['Bayswater'])
    expect(stateGuesses(after)).toEqual([['warning', 0]])
    expect(statusOf(after)).toBe('warning')
  })

  it('moves up with its site when a site above it is removed', async () => {
    const before = jane([MORLEY, BAYSWATER])
    expect(stateGuesses(before)).toEqual([['warning', 1]])

    const after = await save(before, (id) => id !== 'site-0')
    expect(after.sites.map((s) => s.suburb)).toEqual(['Bayswater'])
    expect(stateGuesses(after)).toEqual([['warning', 0]])
    expect(statusOf(after)).toBe('warning')

    // And still goes once the state is changed from the one it guessed:
    // its test sees the site where it now is.
    const draft = draftOf(after)
    const changed = recheckClient(
      applyDraft(after, {
        ...draft,
        sites: draft.sites.map((s) => ({ ...s, state: 'NSW' })),
      }),
      opts,
    )
    expect(stateGuesses(changed)).toEqual([])
  })
})
