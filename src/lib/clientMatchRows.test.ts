import { describe, expect, test } from 'vitest'
import {
  NO_OURS,
  buildMatchIndex,
  matchNewClient,
} from '../../convex/lib/clientMatch'
import { siteKey } from '../../convex/lib/contactKeys'
import { MAX_JOB_NOTES_LENGTH } from '../../convex/lib/jobNotes'
import {
  blurLine,
  bookingMatchRows,
  callerLine,
  carryAfter,
  dismissedOf,
  matchFooter,
  matchName,
  matchNotes,
  matchShownCounts,
  newClientRows,
  newSiteRows,
  openAddSite,
  openFromNewClient,
  ownSiteRows,
  planMatchFix,
  siteContactCarry,
  withCallerLine,
} from './clientMatchRows'
import type {
  FixState,
  MatchFix,
  MatchRow,
  MatchRowsContext,
  SiteDraft,
} from './clientMatchRows'
import type {
  MatchClient,
  MatchContact,
  MatchDirectory,
  MatchSite,
  TypedClient,
} from '../../convex/lib/clientMatch'
import type { Id } from '../../convex/_generated/dataModel'

/**
 * Is the caller already a client? The rows New Job shows at Book, the line
 * under Name, Phone or Email as the person moves on, and what each fix does
 * (the matching plan's §2.6–2.8), case by case over a small book. Numbers
 * are from ACMA's ranges for fiction.
 */

const JANE_MOBILE = '0491 570 156'
const OFFICE = '08 9272 1234'
const SARAH = '0491 570 110'
const FAMILY = '0491 570 159'
const MEI_LANDLINE = '08 9272 5555'

const cid = (id: string) => id as Id<'clients'>
const pid = (id: string) => id as Id<'properties'>

function client(
  id: string,
  name: string,
  extra: Partial<MatchClient> = {},
): MatchClient {
  return { _id: cid(id), name, kind: 'person', ...extra }
}

function site(
  id: string,
  clientId: string,
  addressLine: string,
  suburb = 'Bayswater',
  postcode = '6053',
  extra: Partial<MatchSite> = {},
): MatchSite {
  return {
    _id: pid(id),
    clientId: cid(clientId),
    addressLine,
    suburb,
    postcode,
    ...extra,
  }
}

/** The plan's seed, cut down: Jane with her own mobile and email at 12
 * Wattle St; Ray White Bayswater, whose office line an owner shares and
 * whose property manager rings from her own mobile; a family on one
 * mobile; Mei Chen on a landline of her own. */
function book(extra: Partial<MatchDirectory> = {}): MatchDirectory {
  const contacts: Array<MatchContact> = [
    {
      _id: 'k_sarah' as Id<'clientContacts'>,
      clientId: cid('c_ray'),
      name: 'Sarah Lee',
      phone: SARAH,
    },
  ]
  return {
    clients: [
      client('c_jane', 'Jane Nguyen', {
        phone: JANE_MOBILE,
        email: 'jane.nguyen@example.com',
      }),
      client('c_ray', 'Ray White Bayswater', {
        kind: 'business',
        phone: OFFICE,
        email: 'rentals@raywhite.example',
      }),
      client('c_tomlee', 'Tom Lee', { phone: OFFICE }),
      client('c_lisa', 'Lisa Tran', { phone: FAMILY }),
      client('c_tomtran', 'Tom Tran', { phone: FAMILY }),
      client('c_mei', 'Mei Chen', { phone: MEI_LANDLINE }),
      client('c_sam', 'Sam Wu', { status: 'inactive' }),
    ],
    sites: [
      site('p_jane', 'c_jane', '12 Wattle St'),
      site('p_ray1', 'c_ray', '1 King William St', 'Bayswater', '6053', {
        siteContactName: 'Priya Shah',
        siteContactPhone: '0491 570 313',
      }),
      site('p_ray2', 'c_ray', '3/12 Ocean Pde', 'Cottesloe', '6011'),
      site('p_tomlee', 'c_tomlee', '7 Rose Ave'),
      site('p_lisa', 'c_lisa', '4 Hay St', 'Perth', '6000'),
      site('p_tomtran', 'c_tomtran', '6 Hay St', 'Perth', '6000'),
      site('p_mei', 'c_mei', '9 Beaufort St', 'Perth', '6000'),
    ],
    contacts,
    ...extra,
  }
}

function ctxOf(
  directory: MatchDirectory = book(),
  verb: 'book' | 'open' = 'book',
): MatchRowsContext {
  return {
    index: buildMatchIndex(directory, { areaCode: '08', ours: NO_OURS }),
    contacts: directory.contacts ?? [],
    verb,
  }
}

const at = (addressLine: string, suburb = 'Bayswater', postcode = '6053') => ({
  addressLine,
  suburb,
  postcode,
})

/** What a row says, and its fixes' words. */
const said = (row: MatchRow) => ({
  label: row.label,
  message: row.message,
  fix: row.fix?.label,
  fix2: row.fix2?.label,
})

function rows(typed: TypedClient, ctx = ctxOf()) {
  return newClientRows(ctx, typed).map(said)
}

describe('the rows at Book (§2.7)', () => {
  test('Same, at one of the client’s sites: Book at it', () => {
    expect(rows({ name: 'Jane Nguyen', site: at('12 Wattle St') })).toEqual([
      {
        label: 'Already a client',
        message:
          '12 Wattle St, Bayswater is Jane Nguyen’s. Same name and address.',
        fix: 'Book at 12 Wattle St',
        fix2: undefined,
      },
    ])
    // With her mobile too, it says so.
    expect(
      rows({
        name: 'Jane Nguyen',
        phone: JANE_MOBILE,
        site: at('12 Wattle St'),
      })[0].message,
    ).toBe(
      '12 Wattle St, Bayswater is Jane Nguyen’s. Same name, address and mobile.',
    )
  })

  test('Same, a new address: Use her', () => {
    expect(
      rows({
        name: 'Jane Nguyen',
        phone: JANE_MOBILE,
        site: at('40 Coode St'),
      }),
    ).toEqual([
      {
        label: 'Already a client',
        message: 'Jane Nguyen, of Bayswater, has the same name and mobile.',
        fix: 'Use Jane Nguyen',
        fix2: undefined,
      },
    ])
  })

  test('Same, an address like one of theirs: Book at hers, or Add it as typed', () => {
    expect(
      rows({
        name: 'Jane Nguyen',
        phone: JANE_MOBILE,
        site: at('12 Watle St'),
      }),
    ).toEqual([
      {
        label: 'Already a client',
        message:
          'Jane Nguyen has the same name and mobile. 12 Watle St looks like Jane Nguyen’s 12 Wattle St, Bayswater.',
        fix: 'Book at 12 Wattle St',
        fix2: 'Add 12 Watle St',
      },
    ])
  })

  test('Same, through a contact person: Use the business', () => {
    expect(
      rows({ name: 'Sarah Lee', phone: SARAH, site: at('20 Walter Rd') }),
    ).toEqual([
      {
        label: 'Already a client',
        message:
          'Sarah Lee is a contact at Ray White Bayswater (2 sites). Same name and mobile.',
        fix: 'Use Ray White Bayswater',
        fix2: undefined,
      },
    ])
  })

  test('Same, a contact person at the business’s own site: the contact is named, as it is her name that agrees', () => {
    expect(
      rows({ name: 'Sarah Lee', phone: SARAH, site: at('1 King William St') }),
    ).toEqual([
      {
        label: 'Already a client',
        message:
          '1 King William St, Bayswater is Ray White Bayswater’s, and Sarah Lee is a contact there. Same name, address and mobile.',
        fix: 'Book at 1 King William St',
        fix2: undefined,
      },
    ])
    // The business's own name, at its site: as ever.
    expect(
      rows({ name: 'Ray White Bayswater', site: at('1 King William St') }),
    ).toEqual([
      {
        label: 'Already a client',
        message:
          '1 King William St, Bayswater is Ray White Bayswater’s. Same name and address.',
        fix: 'Book at 1 King William St',
        fix2: undefined,
      },
    ])
  })

  test('Same, a similar name: Use them under the name they are saved as', () => {
    const ctx = ctxOf({
      clients: [client('c_j', 'J Nguyen', { phone: JANE_MOBILE })],
      sites: [site('p_j', 'c_j', '12 Wattle St')],
      contacts: [],
    })
    expect(rows({ name: 'Jane Nguyen', phone: JANE_MOBILE }, ctx)).toEqual([
      {
        label: 'Already a client',
        message:
          'J Nguyen, of Bayswater, has a similar name and the same mobile.',
        fix: 'Use J Nguyen',
        fix2: undefined,
      },
    ])
  })

  test('Likely: the address under another name is “Already a site”, booked on its client', () => {
    expect(rows({ name: 'Tom Nguyen', site: at('12 Wattle St') })).toEqual([
      {
        label: 'Already a site',
        message:
          '12 Wattle St, Bayswater is Jane Nguyen’s. Same address, different name.',
        fix: 'Book on Jane Nguyen',
        fix2: undefined,
      },
    ])
  })

  test('Likely: her own mobile under another name is shown, never one tap away', () => {
    const [row] = newClientRows(ctxOf(), {
      name: 'Tom Nguyen',
      phone: JANE_MOBILE,
      site: at('40 Coode St'),
    })
    expect(said(row)).toEqual({
      label: 'Same mobile',
      message:
        '0491 570 156 is Jane Nguyen’s, of Bayswater. Same mobile, different name.',
      fix: 'Show them',
      fix2: undefined,
    })
    expect(row.fix).toEqual({
      kind: 'show',
      label: 'Show them',
      query: JANE_MOBILE,
    })
  })

  test('Likely: the name, and the street in that postcode', () => {
    expect(
      rows({ name: 'Jane Nguyen', site: at('12 Wattle St', 'Maylands') }),
    ).toEqual([
      {
        label: 'Already a client',
        message:
          'Jane Nguyen has the same name, and 12 Wattle St in Bayswater, the same postcode.',
        fix: 'Book at 12 Wattle St, Bayswater',
        fix2: undefined,
      },
    ])
  })

  test('Likely: the name, and a new number on a street like hers', () => {
    expect(
      rows({
        name: 'Jane Nguyen',
        phone: '0491 570 199',
        site: at('12 Watle St'),
      }),
    ).toEqual([
      {
        label: 'Already a client',
        message:
          'Jane Nguyen has the same name. 12 Watle St looks like Jane Nguyen’s 12 Wattle St, Bayswater.',
        fix: 'Book at 12 Wattle St',
        fix2: 'Add 12 Watle St',
      },
    ])
  })

  test('Likely: a known member of a family on one mobile', () => {
    expect(rows({ name: 'Lisa Tran', phone: FAMILY })).toEqual([
      {
        label: 'Already a client',
        message:
          'Lisa Tran, of Perth, has the same name. 0491 570 159 is on 2 clients.',
        fix: 'Use Lisa Tran',
        fix2: undefined,
      },
      // And the shared number beside it.
      {
        label: 'Shared number',
        message: '0491 570 159 is on 2 clients — Lisa Tran and 1 other.',
        fix: 'Show them',
        fix2: undefined,
      },
    ])
  })

  test('Likely: a site contact, the number’s kind said', () => {
    expect(rows({ name: 'Priya Shah', phone: '0491 570 313' })).toEqual([
      {
        label: 'Already a site',
        message:
          'Priya Shah is the site contact at 1 King William St, Bayswater (Ray White Bayswater’s). Same name and mobile.',
        fix: 'Book at 1 King William St',
        fix2: undefined,
      },
    ])
  })

  test('Likely: a landline agreeing only by initial and surname is shown, not one tap away', () => {
    const [row] = newClientRows(ctxOf(), {
      name: 'M Chen',
      phone: MEI_LANDLINE,
    })
    expect(said(row)).toEqual({
      label: 'Already a client',
      message: 'Mei Chen, of Perth, has a similar name and the same number.',
      fix: 'Show them',
      fix2: undefined,
    })
  })

  test('Maybe: the name alone, saying only what was typed is different', () => {
    expect(
      rows({
        name: 'Mei Chen',
        phone: '0491 570 111',
        site: at('9 Banksia Rd'),
      }),
    ).toEqual([
      {
        label: 'Same name',
        message:
          'Mei Chen, of Perth, has the same name, with a different mobile and address.',
        fix: 'Use Mei Chen',
        fix2: undefined,
      },
    ])
    // A landline is a number; nothing else typed, nothing called different.
    expect(rows({ name: 'Mei Chen', phone: '08 9272 0000' })[0].message).toBe(
      'Mei Chen, of Perth, has the same name, with a different number.',
    )
    expect(rows({ name: 'Mei Chen' })[0].message).toBe(
      'Mei Chen, of Perth, has the same name.',
    )
  })

  test('a Shared number alone stops nothing: Book books at once (FW9)', () => {
    expect(
      rows({ name: 'Kim Pham', phone: OFFICE, site: at('9 Banksia Rd') }),
    ).toEqual([])
    expect(rows({ name: 'Ann Bell', phone: FAMILY })).toEqual([])
  })

  test('a Shared number beside another row: Show them, and New site for the business holding it', () => {
    const shown = newClientRows(ctxOf(), {
      name: 'Jane Nguyen',
      phone: OFFICE,
      site: at('12 Wattle St'),
    })
    expect(shown.map(said)).toEqual([
      expect.objectContaining({ label: 'Already a client' }),
      {
        label: 'Shared number',
        message:
          '08 9272 1234 is on 2 clients — Ray White Bayswater and 1 other.',
        fix: 'Show them',
        fix2: 'New site for Ray White Bayswater',
      },
    ])
    expect(shown[1].fix2).toEqual({
      kind: 'use',
      label: 'New site for Ray White Bayswater',
      clientId: 'c_ray',
    })
  })

  test('names, never pronouns; “(inactive)” and “(archived)” after a name', () => {
    const all = [
      ...rows({
        name: 'Jane Nguyen',
        phone: JANE_MOBILE,
        site: at('12 Watle St'),
      }),
      ...rows({
        name: 'Tom Nguyen',
        phone: JANE_MOBILE,
        site: at('40 Coode St'),
      }),
      ...rows({ name: 'Sarah Lee', phone: SARAH }),
    ]
    for (const row of all) {
      expect(row.message).not.toMatch(
        /\b(her|his|hers|their|theirs|they|them)\b/i,
      )
    }
    expect(rows({ name: 'Sam Wu' })[0].fix).toBe('Use Sam Wu (inactive)')
    expect(
      matchName(client('c_x', 'Sam Wu', { archivedAt: 1, status: 'inactive' })),
    ).toBe('Sam Wu (archived)')
  })

  test('what is an inactive or archived client’s: the tag after it, never inside the possessive', () => {
    // Sam Wu, inactive, with two sites and his own mobile; Amy Lo, archived,
    // on a landline of her own and a line that is hers alone.
    const ctx = ctxOf({
      clients: [
        client('c_sam', 'Sam Wu', {
          status: 'inactive',
          phone: '0491 570 120',
        }),
        client('c_amy', 'Amy Lo', { archivedAt: 5, phone: '08 9272 7777' }),
        client('c_ray', 'Ray White Bayswater', {
          kind: 'business',
          archivedAt: 5,
          phone: OFFICE,
        }),
      ],
      sites: [
        site('p_sam', 'c_sam', '12 Wattle St', 'Morley', '6062'),
        site('p_sam2', 'c_sam', '14 Wattle St', 'Morley', '6062'),
        site('p_amy', 'c_amy', '4 Ash St', 'Morley', '6062'),
        site('p_ray', 'c_ray', '1 King William St', 'Bayswater', '6053', {
          siteContactName: 'Priya Shah',
          siteContactPhone: '0491 570 313',
        }),
      ],
      contacts: [],
    })
    const messages = [
      ...rows(
        { name: 'Tom Wu', site: at('12 Wattle St', 'Morley', '6062') },
        ctx,
      ),
      ...rows({ name: 'Tom Wu', phone: '0491 570 120' }, ctx),
      ...rows({ name: 'Priya Shah', phone: '0491 570 313' }, ctx),
    ].map((row) => row.message)
    expect(messages).toEqual([
      '12 Wattle St, Morley is Sam Wu’s (inactive). Same address, different name.',
      '0491 570 120 is Sam Wu’s (inactive), of Morley. Same mobile, different name.',
      'Priya Shah is the site contact at 1 King William St, Bayswater (Ray White Bayswater’s, archived). Same name and mobile.',
    ])
    expect(
      blurLine(ctx, 'phone', { name: 'Kim Pham', phone: '08 9272 7777' })?.text,
    ).toBe('08 9272 7777 is Amy Lo’s number (archived).')
    // Named with the tag first, the possessive after it has none.
    expect(
      rows(
        {
          name: 'Sam Wu',
          phone: '0491 570 120',
          site: at('12 Watle St', 'Morley', '6062'),
        },
        ctx,
      )[0].message,
    ).toBe(
      'Sam Wu (inactive) has the same name and mobile. 12 Watle St looks like Sam Wu’s 12 Wattle St, Morley.',
    )
    // The Name line's Choose, and New site for one like theirs.
    expect(blurLine(ctx, 'clientName', { name: 'Sam Wu' })).toEqual({
      text: 'Sam Wu (inactive), of Morley, is already a client.',
      fix: {
        kind: 'show',
        label: 'Choose Sam Wu’s site (inactive)',
        query: 'Sam Wu',
      },
    })
    expect(
      newSiteRows(ctx, cid('c_sam'), at('12 Watle St', 'Morley', '6062'))[0]
        .message,
    ).toBe(
      '12 Watle St looks like Sam Wu’s 12 Wattle St, Morley. Sam Wu is inactive.',
    )
    for (const message of messages) {
      expect(message).not.toMatch(/\)’s/)
    }
  })

  test('the copy keeps the house style: curly apostrophes, a spaced em dash', () => {
    const all = [
      ...rows({ name: 'Jane Nguyen', site: at('12 Wattle St') }),
      ...rows({ name: 'Jane Nguyen', phone: OFFICE, site: at('12 Wattle St') }),
    ]
    for (const row of all) expect(row.message).not.toMatch(/'/)
    expect(all.some((row) => row.message.includes(' — '))).toBe(true)
  })

  test('one row per client, three at most, then “And 2 more”; every one of them is in dismissed (FW17d)', () => {
    const directory: MatchDirectory = {
      clients: ['a', 'b', 'c', 'd', 'e'].map((x) =>
        client(`c_${x}`, `Owner ${x.toUpperCase()}`),
      ),
      sites: ['a', 'b', 'c', 'd', 'e'].map((x) =>
        site(`p_${x}`, `c_${x}`, '5 Ocean Pde', 'Cottesloe', '6011'),
      ),
      contacts: [],
    }
    const ctx = ctxOf(directory)
    const typed = {
      name: 'Kim Pham',
      site: at('5 Ocean Pde', 'Cottesloe', '6011'),
    }
    const shown = newClientRows(ctx, typed)
    expect(shown.map((r) => r.id)).toEqual([
      'match:c_a',
      'match:c_b',
      'match:c_c',
      'match:more',
    ])
    expect(said(shown[3])).toEqual({
      label: 'And 2 more',
      message: '2 other clients match part of what was typed.',
      fix: 'Show them',
      fix2: undefined,
    })
    expect(dismissedOf(matchNewClient(ctx.index, typed))).toEqual([
      'c_a',
      'c_b',
      'c_c',
      'c_d',
      'c_e',
    ])
  })

  test('answered at once, in the press: no “Checking…”', () => {
    const answer = newClientRows(ctxOf(), {
      name: 'Jane Nguyen',
      phone: JANE_MOBILE,
    })
    expect(Array.isArray(answer)).toBe(true)
  })
})

describe('a copy kept before emails and contact people were sent (`complete: false`)', () => {
  const old = () => {
    const { contacts: _contacts, ...rest } = book()
    return ctxOf(rest)
  }

  test('Same is capped at Likely, and still reads as the client it is, with Use', () => {
    const ctx = old()
    const result = matchNewClient(ctx.index, {
      name: 'Jane Nguyen',
      phone: JANE_MOBILE,
      site: at('40 Coode St'),
    })
    expect(result.candidates.map((c) => c.tier)).toEqual(['likely'])
    expect(
      rows(
        { name: 'Jane Nguyen', phone: JANE_MOBILE, site: at('40 Coode St') },
        ctx,
      ),
    ).toEqual([
      {
        label: 'Already a client',
        message: 'Jane Nguyen, of Bayswater, has the same name and mobile.',
        fix: 'Use Jane Nguyen',
        fix2: undefined,
      },
    ])
    expect(
      blurLine(ctx, 'phone', { name: 'Jane Nguyen', phone: JANE_MOBILE })?.fix
        ?.label,
    ).toBe('Book at 12 Wattle St')
  })

  test('an email is no evidence in it', () => {
    expect(
      rows({ name: 'Kim Pham', email: 'jane.nguyen@example.com' }, old()),
    ).toEqual([])
  })
})

describe('New site for {client}', () => {
  test('the chosen client already has the address: Book at this site', () => {
    expect(
      newSiteRows(ctxOf(), cid('c_jane'), at('12 Wattle St')).map(said),
    ).toEqual([
      {
        label: 'Already has this site',
        message: 'Jane Nguyen already has 12 Wattle St, Bayswater.',
        fix: 'Book at this site',
        fix2: undefined,
      },
    ])
  })

  test('one like it: Book at it, or Add it as typed, after which it isn’t asked again', () => {
    expect(
      newSiteRows(ctxOf(), cid('c_jane'), at('12 Watle St')).map(said),
    ).toEqual([
      {
        label: 'Already has this site',
        message:
          '12 Watle St looks like Jane Nguyen’s 12 Wattle St, Bayswater.',
        fix: 'Book at 12 Wattle St',
        fix2: 'Add 12 Watle St',
      },
    ])
    expect(
      newSiteRows(ctxOf(), cid('c_jane'), at('12 Watle St'), {
        clientId: cid('c_jane'),
        siteKey: siteKey(at('12 Watle St')),
      }),
    ).toEqual([])
  })

  test('another client holding the address is no row: the person chose the client', () => {
    expect(newSiteRows(ctxOf(), cid('c_ray'), at('12 Wattle St'))).toEqual([])
  })
})

describe('the check by client mode (`bookingMatchRows`)', () => {
  test('nothing is checked at an existing site', () => {
    expect(bookingMatchRows(ctxOf(), { mode: 'existing' })).toEqual([])
  })

  test('a new client and a new site are; New site for with no client chosen yet is not', () => {
    expect(
      bookingMatchRows(ctxOf(), {
        mode: 'new',
        typed: { name: 'Jane Nguyen', site: at('12 Wattle St') },
      }),
    ).toHaveLength(1)
    expect(
      bookingMatchRows(ctxOf(), {
        mode: 'site',
        clientId: cid('c_jane'),
        site: at('12 Wattle St'),
        added: null,
      }),
    ).toHaveLength(1)
    expect(
      bookingMatchRows(ctxOf(), {
        mode: 'site',
        clientId: null,
        site: at('12 Wattle St'),
        added: null,
      }),
    ).toEqual([])
  })
})

describe('Clients → New client: every fix is Open {client}', () => {
  const ctx = ctxOf(book(), 'open')
  const typedAt = (addressLine: string, suburb = 'Bayswater') => ({
    addressLine,
    suburb,
    state: 'WA',
    postcode: '6053',
  })
  const OPEN_JANE = {
    kind: 'open',
    label: 'Open Jane Nguyen',
    clientId: 'c_jane',
  }

  test('one fix a row, and the same from a row and from a line', () => {
    const [newAddress] = newClientRows(ctx, {
      name: 'Jane Nguyen',
      phone: JANE_MOBILE,
      site: at('40 Coode St'),
    })
    expect(newAddress.fix).toEqual(OPEN_JANE)
    expect(newAddress.fix2).toBeUndefined()
    expect(blurLine(ctx, 'clientName', { name: 'Jane Nguyen' })?.fix).toEqual(
      OPEN_JANE,
    )
    expect(
      blurLine(ctx, 'phone', { name: 'Jane Nguyen', phone: JANE_MOBILE })?.fix,
    ).toEqual(OPEN_JANE)
  })

  test('as it is tapped: Add property on the address typed then, unless none is, or it is theirs already', () => {
    // Tapped from the line under Name, before any address: her sheet as it
    // is, not an empty Add property.
    expect(
      openAddSite(ctx.index, cid('c_jane'), typedAt('', '')),
    ).toBeUndefined()
    expect(
      openAddSite(ctx.index, cid('c_jane'), typedAt('  ', 'Bayswater')),
    ).toBeUndefined()
    // Her own address, typed by the tap (written another way, even): it is
    // on her sheet already, and nothing is added.
    expect(
      openAddSite(ctx.index, cid('c_jane'), typedAt('12 Wattle Street')),
    ).toBeUndefined()
    // A new one: Add property holds it.
    expect(
      openAddSite(ctx.index, cid('c_jane'), typedAt('40 Coode St')),
    ).toEqual(typedAt('40 Coode St'))
    // Someone else's address is new to her.
    expect(
      openAddSite(ctx.index, cid('c_jane'), typedAt('7 Rose Ave')),
    ).toEqual(typedAt('7 Rose Ave'))
  })

  /** What is typed in New client as Open is tapped. */
  const typedAs = (
    name: string,
    phone: string,
    addressLine: string,
    { email = '', suburb = 'Bayswater' } = {},
  ) => ({ name, phone, email, ...typedAt(addressLine, suburb) })
  const open = (
    fix: MatchFix | undefined,
    typed: ReturnType<typeof typedAs>,
  ) => {
    if (fix?.kind !== 'open') throw new Error(`not an Open: ${fix?.kind}`)
    return openFromNewClient(ctx.index, ctx.contacts, fix, typed)
  }

  test('a row or line that only shows who the caller may be: their sheet as it is, and New client kept as typed', () => {
    // Her mobile under another name: "Same mobile, different name."
    const typed = typedAs('Sam Wu', JANE_MOBILE, '4 Birch St')
    const [row] = newClientRows(ctx, { ...typed, site: at('4 Birch St') })
    expect(row.label).toBe('Same mobile')
    expect(row.fix).toEqual({ ...OPEN_JANE, onDetails: true })
    expect(open(row.fix, typed)).toEqual({ keepDraft: true })
    // So too the line under Phone, and a landline agreeing only by an
    // initial, as a row and as a line.
    expect(
      blurLine(ctx, 'phone', { name: 'Sam Wu', phone: JANE_MOBILE })?.fix,
    ).toEqual({ ...OPEN_JANE, onDetails: true })
    const OPEN_MEI = {
      kind: 'open',
      label: 'Open Mei Chen',
      clientId: 'c_mei',
      onDetails: true,
    }
    expect(
      newClientRows(ctx, { name: 'M Chen', phone: MEI_LANDLINE })[0].fix,
    ).toEqual(OPEN_MEI)
    expect(
      blurLine(ctx, 'phone', { name: 'M Chen', phone: MEI_LANDLINE })?.fix,
    ).toEqual(OPEN_MEI)
    // Her name agreeing: it is her, and Add property holds the address.
    expect(
      blurLine(ctx, 'phone', { name: 'Jane Nguyen', phone: JANE_MOBILE })?.fix,
    ).toEqual(OPEN_JANE)
  })

  test('a business’s new site has the caller as its site contact, as New site for does in New Job', () => {
    // The agency's office line, typed by its tenant.
    const line = blurLine(ctx, 'phone', { name: 'Kim Pham', phone: OFFICE })
    expect(line?.fix).toEqual({
      kind: 'open',
      label: 'Open Ray White Bayswater',
      clientId: 'c_ray',
    })
    const office = typedAs('Kim Pham', OFFICE, '9 Banksia Rd', {
      suburb: 'Morley',
    })
    // The office line is the agency's own: only her name is carried.
    expect(open(line?.fix, office)).toEqual({
      addSite: {
        ...typedAt('9 Banksia Rd', 'Morley'),
        siteContactName: 'Kim Pham',
        siteContactPhone: '',
      },
      keepDraft: false,
    })
    // Her own mobile typed by the tap: that too.
    expect(open(line?.fix, { ...office, phone: '0491 570 199' })).toEqual({
      addSite: {
        ...typedAt('9 Banksia Rd', 'Morley'),
        siteContactName: 'Kim Pham',
        siteContactPhone: '0491 570 199',
      },
      keepDraft: false,
    })
    // An email of hers goes nowhere: New client keeps it all.
    expect(
      open(line?.fix, { ...office, email: 'kim.pham@example.com' }).keepDraft,
    ).toBe(true)
  })

  test('what was typed goes only when all of it is theirs or went with the open', () => {
    // Her name, mobile and own address: it is her, and nothing more.
    expect(
      open(
        OPEN_JANE as MatchFix,
        typedAs('Jane Nguyen', JANE_MOBILE, '12 Wattle St'),
      ),
    ).toEqual({ keepDraft: false })
    // A new address of hers: in Add property.
    expect(
      open(OPEN_JANE as MatchFix, {
        ...typedAs('Jane Nguyen', JANE_MOBILE, '40 Coode St'),
        email: 'Jane.Nguyen@example.com',
      }),
    ).toEqual({
      addSite: {
        ...typedAt('40 Coode St'),
        siteContactName: '',
        siteContactPhone: '',
      },
      keepDraft: false,
    })
    // A number not hers, or another name, would be lost: kept.
    expect(
      open(
        OPEN_JANE as MatchFix,
        typedAs('Jane Nguyen', '0491 570 199', '12 Wattle St'),
      ).keepDraft,
    ).toBe(true)
    expect(
      open(OPEN_JANE as MatchFix, typedAs('Tom Nguyen', JANE_MOBILE, ''))
        .keepDraft,
    ).toBe(true)
  })
})

describe('the line under a field as it is left (§2.6)', () => {
  const line = (
    field: 'clientName' | 'phone' | 'email',
    typed: TypedClient,
    ctx = ctxOf(),
  ) => {
    const found = blurLine(ctx, field, typed)
    return (
      found && {
        text: found.text,
        fix: found.fix?.label,
        fix2: found.fix2?.label,
      }
    )
  }

  test('her mobile, her name agreeing: who has it, and Book at her one site', () => {
    expect(line('phone', { name: 'Jane Nguyen', phone: JANE_MOBILE })).toEqual({
      text: 'Jane Nguyen, of Bayswater, has this mobile.',
      fix: 'Book at 12 Wattle St',
      fix2: undefined,
    })
    // Before a name is typed, or under another: the same words, with Show
    // them rather than a one-tap Use.
    expect(line('phone', { phone: JANE_MOBILE })).toEqual({
      text: 'Jane Nguyen, of Bayswater, has this mobile.',
      fix: 'Show them',
      fix2: undefined,
    })
    expect(
      line('email', { name: 'Jane Nguyen', email: 'Jane.Nguyen@example.com' }),
    ).toEqual({
      text: 'Jane Nguyen, of Bayswater, has this email.',
      fix: 'Book at 12 Wattle St',
      fix2: undefined,
    })
  })

  test('a contact person’s mobile: the business, and choose among its sites', () => {
    expect(line('phone', { name: 'Sarah Lee', phone: SARAH })).toEqual({
      text: 'Sarah Lee, a contact at Ray White Bayswater, has this mobile.',
      fix: 'Choose Ray White Bayswater’s site',
      fix2: undefined,
    })
  })

  test('a client with no site yet: New site for them', () => {
    const ctx = ctxOf({
      clients: [client('c_sam', 'Sam Wu', { phone: '0491 570 158' })],
      sites: [],
      contacts: [],
    })
    expect(
      line('phone', { name: 'Sam Wu', phone: '0491 570 158' }, ctx),
    ).toEqual({
      text: 'Sam Wu has this mobile.',
      fix: 'New site for Sam Wu',
      fix2: undefined,
    })
  })

  test('a landline on one client, the name not agreeing: whose number, Show them only', () => {
    expect(line('phone', { name: 'Kim Pham', phone: MEI_LANDLINE })).toEqual({
      text: '08 9272 5555 is Mei Chen’s number.',
      fix: 'Show them',
      fix2: undefined,
    })
  })

  test('a number on several clients: how many, Show them, and New site for the business', () => {
    expect(line('phone', { name: 'Kim Pham', phone: OFFICE })).toEqual({
      text: '08 9272 1234 is on 2 clients — Ray White Bayswater and 1 other.',
      fix: 'Show them',
      fix2: 'New site for Ray White Bayswater',
    })
    // A contact's mobile under another name: the agency's, not the caller's.
    expect(line('phone', { name: 'Tom Lee', phone: SARAH })).toEqual({
      text: '0491 570 110 is Sarah Lee’s, a contact at Ray White Bayswater.',
      fix: 'Show them',
      fix2: 'New site for Ray White Bayswater',
    })
  })

  test('the name: one client, choose their site, or Use them once an address is typed; two, Show them; a placeholder or three, nothing', () => {
    // Left before the address, as the form's order has it: one of her sites
    // is chosen, whatever how many she has.
    expect(line('clientName', { name: 'Jane Nguyen' })).toEqual({
      text: 'Jane Nguyen, of Bayswater, is already a client.',
      fix: 'Choose Jane Nguyen’s site',
      fix2: undefined,
    })
    expect(line('clientName', { name: 'Ray White Bayswater' })).toEqual({
      text: 'Ray White Bayswater, of Bayswater, is already a client.',
      fix: 'Choose Ray White Bayswater’s site',
      fix2: undefined,
    })
    // An address typed already: Use her, as at Book.
    expect(
      line('clientName', { name: 'Jane Nguyen', site: at('40 Coode St') }),
    ).toEqual({
      text: 'Jane Nguyen, of Bayswater, is already a client.',
      fix: 'Use Jane Nguyen',
      fix2: undefined,
    })
    // No site of theirs to choose: a new one for them.
    const siteLess = ctxOf({
      clients: [client('c_sam', 'Sam Wu')],
      sites: [],
      contacts: [],
    })
    expect(line('clientName', { name: 'Sam Wu' }, siteLess)).toEqual({
      text: 'Sam Wu is already a client.',
      fix: 'New site for Sam Wu',
      fix2: undefined,
    })
    const two = ctxOf({
      clients: [client('c_1', 'John Smith'), client('c_2', 'John Smith')],
      sites: [],
      contacts: [],
    })
    expect(line('clientName', { name: 'John Smith' }, two)).toEqual({
      text: '2 clients are called John Smith.',
      fix: 'Show them',
      fix2: undefined,
    })
    const three = ctxOf({
      clients: ['c_1', 'c_2', 'c_3'].map((id) => client(id, 'John Smith')),
      sites: [],
      contacts: [],
    })
    expect(line('clientName', { name: 'John Smith' }, three)).toBeNull()
    expect(
      line(
        'clientName',
        { name: 'The Owner' },
        ctxOf({
          clients: [client('c_o', 'The Owner')],
          sites: [],
          contacts: [],
        }),
      ),
    ).toBeNull()
  })

  test('nobody has it: no line', () => {
    expect(
      line('phone', { name: 'Kim Pham', phone: '0491 570 199' }),
    ).toBeNull()
    expect(line('email', { email: 'nobody@example.com' })).toBeNull()
    expect(line('phone', { phone: '' })).toBeNull()
  })

  test('the business’s own number and the team’s: no line, no row', () => {
    const directory = book({
      clients: [
        ...book().clients,
        client('c_office', 'Kevin Doyle', { phone: '08 7010 9000' }),
        client('c_team', 'Arthur Wellard', { phone: '0491 570 006' }),
      ],
    })
    const ctx: MatchRowsContext = {
      index: buildMatchIndex(directory, {
        areaCode: '08',
        ours: { phones: ['08 7010 9000', '0491 570 006'], emails: [] },
      }),
      contacts: directory.contacts ?? [],
      verb: 'book',
    }
    expect(
      blurLine(ctx, 'phone', { name: 'Kim Pham', phone: '08 7010 9000' }),
    ).toBeNull()
    expect(
      newClientRows(ctx, { name: 'Kim Pham', phone: '0491 570 006' }),
    ).toEqual([])
  })
})

describe('the panel’s foot and its notes', () => {
  const BOOK = { anyway: 'Book anyway', adds: 'client' } as const
  const foot = (typed: TypedClient, ctx = ctxOf()) =>
    matchFooter(newClientRows(ctx, typed), BOOK)

  test('match rows alone: Use it, Use one, a new client or a new site', () => {
    // Her name and mobile: Use Jane Nguyen.
    expect(foot({ name: 'Jane Nguyen', phone: JANE_MOBILE })).toBe(
      'Use it, or press Book anyway to add a new client.',
    )
    const use = { fix: { kind: 'use' as const } }
    const bookAt = { fix: { kind: 'bookAt' as const } }
    expect(matchFooter([use, bookAt], BOOK)).toBe(
      'Use one, or press Book anyway to add a new client.',
    )
    expect(matchFooter([use], { anyway: 'Book anyway', adds: 'site' })).toBe(
      'Use it, or press Book anyway to add a new site.',
    )
    // Clients → New client: the fix opens the client.
    expect(
      matchFooter(
        newClientRows(ctxOf(book(), 'open'), {
          name: 'Jane Nguyen',
          phone: JANE_MOBILE,
        }),
        { anyway: 'Save anyway', adds: 'client' },
      ),
    ).toBe('Open it, or press Save anyway to add a new client.')
    // One row that can be used beside one that only shows: "it".
    expect(matchFooter([use, { fix: { kind: 'show' as const } }], BOOK)).toBe(
      'Use it, or press Book anyway to add a new client.',
    )
  })

  test('rows that only show who it may be, with no Use among them: Check who it is', () => {
    // Her email under another name: Show them, never a one-tap Use.
    const sameEmail = newClientRows(ctxOf(), {
      name: 'Tom Nguyen',
      email: 'jane.nguyen@example.com',
      site: at('40 Coode St'),
    })
    expect(sameEmail.map((row) => row.fix?.kind)).toEqual(['show'])
    expect(matchFooter(sameEmail, BOOK)).toBe(
      'Check who it is, or press Book anyway to add a new client.',
    )
    // A landline agreeing only by initial and surname: the same.
    expect(foot({ name: 'M Chen', phone: MEI_LANDLINE })).toBe(
      'Check who it is, or press Book anyway to add a new client.',
    )
    // No fix at all (Clients → New client with nowhere to open the client).
    expect(matchFooter([{}], { anyway: 'Save anyway', adds: 'client' })).toBe(
      'Check who it is, or press Save anyway to add a new client.',
    )
  })

  test('where they were found, when that may be behind or cut short', () => {
    const base = {
      behind: false,
      asOf: null,
      timezone: 'Australia/Perth',
      today: '2026-11-01',
      capped: false,
      contactsCapped: false,
    }
    expect(matchNotes(base)).toEqual([])
    // 9:42am in Perth on 1 Nov 2026.
    const asOf = Date.UTC(2026, 10, 1, 1, 42)
    expect(matchNotes({ ...base, behind: true, asOf })).toEqual([
      'From the clients on this phone, updated 9:42am.',
    ])
    expect(matchNotes({ ...base, capped: true, contactsCapped: true })).toEqual(
      ['Only the newest 8,000 clients are on this phone.'],
    )
    expect(matchNotes({ ...base, contactsCapped: true })).toEqual([
      'Not every contact person is on this phone.',
    ])
  })

  test('what a press found, as counts only', () => {
    expect(
      matchShownCounts(
        newClientRows(ctxOf(), {
          name: 'Jane Nguyen',
          phone: OFFICE,
          site: at('12 Wattle St'),
        }),
      ),
    ).toEqual({ same: 1, likely: 0, maybe: 0, shared: 1 })
  })
})

describe('what goes with the booking (§2.8, C10)', () => {
  const jane = client('c_jane', 'Jane Nguyen', { phone: JANE_MOBILE })
  const ray = client('c_ray', 'Ray White Bayswater', {
    kind: 'business',
    phone: OFFICE,
  })
  const contacts = [{ clientId: 'c_ray', name: 'Sarah Lee', phone: SARAH }]

  test('only what differs: the name and number, the number alone, or nothing', () => {
    expect(
      callerLine({ name: 'Tom Nguyen', phone: '0499 888 777' }, jane, [], '08'),
    ).toBe('Caller: Tom Nguyen, 0499 888 777')
    expect(
      callerLine(
        { name: 'Jane Nguyen', phone: '0499 888 777' },
        jane,
        [],
        '08',
      ),
    ).toBe('Caller’s number: 0499 888 777')
    expect(callerLine({ name: 'Tom Nguyen', phone: '' }, jane, [], '08')).toBe(
      'Caller: Tom Nguyen',
    )
    expect(
      callerLine(
        { name: 'Jane Nguyen', phone: '+61 491 570 156' },
        jane,
        [],
        '08',
      ),
    ).toBeNull()
    // A contact person of the business is theirs already.
    expect(
      callerLine({ name: 'Sarah Lee', phone: SARAH }, ray, contacts, '08'),
    ).toBeNull()
  })

  test('first in Notes, never twice, never past the notes’ limit', () => {
    expect(withCallerLine('', 'Caller: Tom Lee')).toBe('Caller: Tom Lee')
    expect(withCallerLine('Ring first.', 'Caller: Tom Lee')).toBe(
      'Caller: Tom Lee\nRing first.',
    )
    expect(
      withCallerLine('Caller: Tom Lee\nRing first.', 'Caller: Tom Lee'),
    ).toBe('Caller: Tom Lee\nRing first.')
    const full = 'x'.repeat(MAX_JOB_NOTES_LENGTH - 5)
    expect(withCallerLine(full, 'Caller: Tom Lee')).toBe(full)
    expect(withCallerLine('Ring first.', null)).toBe('Ring first.')
  })

  test('a business’s new site: the caller as its site contact, not head office', () => {
    expect(
      siteContactCarry(
        { name: 'Tom Lee', phone: '0491 570 120' },
        ray,
        contacts,
        '08',
      ),
    ).toEqual({ siteContactName: 'Tom Lee', siteContactPhone: '0491 570 120' })
    expect(
      siteContactCarry(
        { name: 'Ray White Bayswater', phone: OFFICE },
        ray,
        contacts,
        '08',
      ),
    ).toEqual({ siteContactName: '', siteContactPhone: '' })
    // Its own name shortened is still its own, by the test the caller's
    // line uses: "similar name", never a site contact called Ray White.
    expect(
      siteContactCarry(
        { name: 'Ray White', phone: '0491 570 120' },
        ray,
        contacts,
        '08',
      ),
    ).toEqual({ siteContactName: '', siteContactPhone: '0491 570 120' })
    // Nor its property manager, who is its contact already.
    expect(
      siteContactCarry(
        { name: 'Sarah Lee', phone: SARAH },
        ray,
        contacts,
        '08',
      ),
    ).toEqual({ siteContactName: '', siteContactPhone: '' })
  })
})

describe('what a fix does (`planMatchFix`)', () => {
  const ctx = ctxOf()
  const typedSite = (addressLine: string, suburb = 'Bayswater'): SiteDraft => ({
    addressLine,
    suburb,
    state: 'WA',
    postcode: '6053',
    siteContactName: '',
    siteContactPhone: '',
    addressCheck: 'typed',
  })
  const state = (over: Partial<FixState> = {}): FixState => ({
    mode: 'new',
    person: { name: 'Tom Nguyen', phone: '0499 888 777' },
    site: typedSite('40 Coode St'),
    notes: '',
    callerLine: null,
    index: ctx.index,
    contacts: ctx.contacts,
    ...over,
  })
  const use = (clientId: string): MatchFix => ({
    kind: 'use',
    label: 'Use',
    clientId: cid(clientId),
  })

  test('Use carries the address typed to a new site for them, and the caller to Notes', () => {
    expect(planMatchFix(use('c_jane'), state())).toEqual({
      to: 'site',
      clientId: 'c_jane',
      site: typedSite('40 Coode St'),
      notes: 'Caller: Tom Nguyen, 0499 888 777',
      callerLine: 'Caller: Tom Nguyen, 0499 888 777',
      added: null,
    })
  })

  test('Use at an address that is theirs books at that site instead', () => {
    expect(
      planMatchFix(use('c_jane'), state({ site: typedSite('12 Wattle St') })),
    ).toEqual({
      to: 'existing',
      propertyId: 'p_jane',
      notes: 'Caller: Tom Nguyen, 0499 888 777',
      callerLine: 'Caller: Tom Nguyen, 0499 888 777',
    })
  })

  test('the fix under Name, by the address typed as it is tapped: her own site chosen, never a blank new site beside it', () => {
    // Left before any address, as the form's order has it: the Property
    // picker with her name, which lists her site and ends in New site for
    // her (clientSearch.ts `namedClient`).
    const early = blurLine(ctx, 'clientName', { name: 'Jane Nguyen' })?.fix
    expect(early).toEqual({
      kind: 'show',
      label: 'Choose Jane Nguyen’s site',
      query: 'Jane Nguyen',
    })
    // Tapped with still no address: the picker, and nothing else changes.
    expect(planMatchFix(early!, state({ site: typedSite('', '') }))).toEqual({
      to: 'picker',
      query: 'Jane Nguyen',
    })

    // With an address typed by the time Name is left: Use, as at Book.
    const later = blurLine(ctx, 'clientName', {
      name: 'Jane Nguyen',
      site: at('40 Coode St'),
    })?.fix
    expect(later).toEqual({
      kind: 'use',
      label: 'Use Jane Nguyen',
      clientId: 'c_jane',
      choose: 'Jane Nguyen',
    })
    // A new address: a new site there, not a booking at 12 Wattle St.
    expect(planMatchFix(later!, state())).toMatchObject({
      to: 'site',
      clientId: 'c_jane',
      site: typedSite('40 Coode St'),
    })
    // At hers: booked there.
    expect(
      planMatchFix(later!, state({ site: typedSite('12 Wattle St') })),
    ).toMatchObject({ to: 'existing', propertyId: 'p_jane' })
    // The address gone again by the tap: her site is chosen, not a blank
    // New site for her that would make a second 12 Wattle St.
    expect(planMatchFix(later!, state({ site: typedSite('', '') }))).toEqual({
      to: 'picker',
      query: 'Jane Nguyen',
    })
    // At Book, Use is as it always was: a blank address is no picker there.
    expect(
      planMatchFix(use('c_jane'), state({ site: typedSite('', '') })),
    ).toMatchObject({ to: 'site', clientId: 'c_jane' })
  })

  test('a change of course says who rang afresh: the earlier fix’s line is replaced, never stacked', () => {
    // Book on Ray White Bayswater first, the caller's whole line in Notes.
    const first = planMatchFix(
      {
        kind: 'bookAt',
        label: 'Book on Ray White Bayswater',
        clientId: cid('c_ray'),
        propertyId: pid('p_ray1'),
      },
      state({
        person: { name: 'Tom Lee', phone: '0491 570 120' },
        notes: 'Ring first.',
      }),
    )
    expect(first).toEqual({
      to: 'existing',
      propertyId: 'p_ray1',
      notes: 'Caller: Tom Lee, 0491 570 120\nRing first.',
      callerLine: 'Caller: Tom Lee, 0491 570 120',
    })
    if (first?.to !== 'existing') throw new Error('unreachable')
    // Then Tom Lee's own record: only the number differs from his.
    const second = planMatchFix(
      use('c_tomlee'),
      state({
        person: { name: 'Tom Lee', phone: '0491 570 120' },
        notes: first.notes,
        callerLine: first.callerLine,
      }),
    )
    expect(second).toMatchObject({
      to: 'site',
      notes: 'Caller’s number: 0491 570 120\nRing first.',
      callerLine: 'Caller’s number: 0491 570 120',
    })
    // Then onto a business's new site: the caller is its site contact, and
    // the line goes.
    if (second?.to !== 'site') throw new Error('unreachable')
    expect(
      planMatchFix(
        use('c_ray'),
        state({
          person: { name: 'Tom Lee', phone: '0491 570 120' },
          notes: second.notes,
          callerLine: second.callerLine,
        }),
      ),
    ).toMatchObject({ notes: 'Ring first.', callerLine: null })
    // A line the person has edited since is theirs: it stays.
    expect(
      planMatchFix(
        use('c_jane'),
        state({
          notes: 'Caller: Tom Lee, 0491 570 120 (her son)\nRing first.',
          callerLine: 'Caller: Tom Lee, 0491 570 120',
        }),
      ),
    ).toMatchObject({
      notes:
        'Caller: Tom Nguyen, 0499 888 777\nCaller: Tom Lee, 0491 570 120 (her son)\nRing first.',
    })
  })

  test('onto a business, the caller is the new site’s site contact, and Notes are left alone', () => {
    expect(planMatchFix(use('c_ray'), state({ notes: 'Ring first.' }))).toEqual(
      {
        to: 'site',
        clientId: 'c_ray',
        site: {
          ...typedSite('40 Coode St'),
          siteContactName: 'Tom Nguyen',
          siteContactPhone: '0499 888 777',
        },
        notes: 'Ring first.',
        callerLine: null,
        added: null,
      },
    )
  })

  test('Book at, Book on: that site, with the caller in Notes', () => {
    expect(
      planMatchFix(
        {
          kind: 'bookAt',
          label: 'Book on Ray White Bayswater',
          clientId: cid('c_ray'),
          propertyId: pid('p_ray1'),
        },
        state({ person: { name: 'Tom Lee', phone: '0491 570 120' } }),
      ),
    ).toEqual({
      to: 'existing',
      propertyId: 'p_ray1',
      notes: 'Caller: Tom Lee, 0491 570 120',
      callerLine: 'Caller: Tom Lee, 0491 570 120',
    })
  })

  test('Add marks the address as seen, and in New site for leaves it as typed', () => {
    const add: MatchFix = { kind: 'add', label: 'Add', clientId: cid('c_jane') }
    expect(
      planMatchFix(add, state({ site: typedSite('12 Watle St') })),
    ).toMatchObject({
      to: 'site',
      clientId: 'c_jane',
      added: { clientId: 'c_jane', siteKey: siteKey(at('12 Watle St')) },
    })
    expect(
      planMatchFix(
        add,
        state({
          mode: 'site',
          person: null,
          site: typedSite('12 Watle St'),
          notes: 'Gate 4411.',
        }),
      ),
    ).toEqual({
      to: 'site',
      clientId: 'c_jane',
      site: typedSite('12 Watle St'),
      notes: 'Gate 4411.',
      callerLine: null,
      added: { clientId: 'c_jane', siteKey: siteKey(at('12 Watle St')) },
    })
  })

  test('Show them opens the picker with what was typed; nothing else changes, the new client kept for its tab', () => {
    const plan = planMatchFix(
      { kind: 'show', label: 'Show them', query: JANE_MOBILE },
      state(),
    )
    expect(plan).toEqual({ to: 'picker', query: JANE_MOBILE })
    // No plan names the typed new client: the New client tab brings it back.
    for (const fix of [use('c_jane'), use('c_ray')]) {
      const made = planMatchFix(fix, state())
      expect(Object.keys(made ?? {})).not.toContain('newClient')
    }
  })
})

describe('what a fix leaves waiting (`carryAfter`)', () => {
  const shown = carryAfter(
    carryAfter(null, { on: 'fix', line: 'Caller: Tom Nguyen, 0499 888 777' }),
    { on: 'show' },
  )

  test('a Show them waits on a choice in the picker it opened, keeping the line put in Notes', () => {
    expect(carryAfter(null, { on: 'show' })).toEqual({ line: null, pick: true })
    expect(shown).toEqual({
      line: 'Caller: Tom Nguyen, 0499 888 777',
      pick: true,
    })
    // Chosen there: the fix it stands for, done.
    expect(carryAfter(shown, { on: 'fix', line: null })).toEqual({
      line: null,
      pick: false,
    })
    // Handed over to New site for's own picker (several clients with no
    // site): still waiting.
    expect(carryAfter(shown, { on: 'mode', to: 'other', handOver: true })).toBe(
      shown,
    )
  })

  test('only while that picker is open: shut with nothing chosen, or the mode changed by hand, a later choice is the person’s own', () => {
    // So a client chosen later in New site for, by hand, never has the
    // address typed in New client put over the one typed there.
    expect(carryAfter(shown, { on: 'dismissed' })).toEqual({
      line: 'Caller: Tom Nguyen, 0499 888 777',
      pick: false,
    })
    expect(carryAfter(shown, { on: 'mode', to: 'other' })).toEqual({
      line: 'Caller: Tom Nguyen, 0499 888 777',
      pick: false,
    })
    // Nothing was waiting: nothing changes.
    const fixed = { line: 'Caller: Tom Lee', pick: false }
    expect(carryAfter(fixed, { on: 'dismissed' })).toBe(fixed)
    expect(carryAfter(null, { on: 'dismissed' })).toBeNull()
    // Back to New client: nothing is carried at all.
    expect(carryAfter(shown, { on: 'mode', to: 'new' })).toBeNull()
  })
})

describe('Add property on a client’s sheet (`ownSiteRows`)', () => {
  const sites = [
    {
      _id: pid('p_jane'),
      addressLine: '12 Wattle St',
      suburb: 'Bayswater',
      postcode: '6053',
    },
  ]
  test('one of theirs, or one like it: Already has this site', () => {
    expect(ownSiteRows('Jane Nguyen', sites, at('12 Wattle Street'))).toEqual([
      {
        id: 'match:own-site',
        label: 'Already has this site',
        message: 'Jane Nguyen already has 12 Wattle St, Bayswater.',
        site: sites[0],
      },
    ])
    expect(
      ownSiteRows('Jane Nguyen', sites, at('12 Watle St'))[0].message,
    ).toBe('12 Watle St looks like Jane Nguyen’s 12 Wattle St, Bayswater.')
    expect(ownSiteRows('Jane Nguyen', sites, at('40 Coode St'))).toEqual([])
    expect(ownSiteRows('Jane Nguyen', sites, at(''))).toEqual([])
  })
})
