/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api, components } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { docFromPlainText } from './lib/richText'
import {
  IMPORT_BATCH_SITES,
  IMPORT_BATCH_SIZE,
  UNDO_STUCK_MS,
} from './lib/clientImport'
import type { Doc, Id } from './_generated/dataModel'
import type { ImportClient, ImportSite } from './lib/clientImport'
import type { TestActor } from '../test/harness'

/**
 * Bringing a client list across: who may, what a batch writes, and what Undo
 * takes back.
 *
 * The risks are in both directions. An import that changes a client already
 * here, or writes a site twice, corrupts a book the business has kept for
 * years. An Undo that deletes a site with a job on it leaves the job pointing
 * at nothing, and one that reaches past the import's own rows deletes
 * somebody's real client.
 *
 * The business: Terence owns it, Jo is a contractor, Kevin a subcontractor.
 */

const DAY = 24 * 60 * 60 * 1000

afterEach(() => {
  vi.useRealTimers()
})

async function setup() {
  const t = testApp()
  const terence = await createActor(t, {
    email: 'terence@coastal.test',
    name: 'Terence',
  })
  const { businessId, ownerMembershipId } = await createBusiness(t, terence)
  const jo = await createActor(t, { email: 'jo@coastal.test', name: 'Jo' })
  const kevin = await createActor(t, {
    email: 'kevin@coastal.test',
    name: 'Kevin',
  })
  const [joId, kevinId] = await t.run(async (ctx) => {
    const member = (userId: string, role: 'contractor' | 'subcontractor') =>
      ctx.db.insert('memberships', {
        userId,
        businessId,
        role,
        canViewAllJobs: false,
        colour: '#0ea5e9',
        status: 'active',
        createdAt: Date.now(),
      })
    return [
      await member(jo.userId, 'contractor'),
      await member(kevin.userId, 'subcontractor'),
    ] as const
  })
  return { t, businessId, terence, ownerMembershipId, jo, joId, kevin, kevinId }
}

type Setup = Awaited<ReturnType<typeof setup>>

function site(addressLine: string, fields: Partial<ImportSite> = {}) {
  return {
    addressLine,
    suburb: 'Bayswater',
    state: 'WA',
    postcode: '6053',
    ...fields,
  }
}

function person(
  key: string,
  name: string,
  sites: Array<ImportSite>,
  fields: Partial<ImportClient> = {},
): ImportClient {
  return { key, kind: 'person', name, sites, ...fields }
}

async function start(s: Setup, actor: TestActor) {
  return actor.as.mutation(api.clientImports.start, {
    businessId: s.businessId,
    fileName: 'clients.csv',
    source: 'Jobber',
  })
}

async function importAs(
  s: Setup,
  actor: TestActor,
  clients: Array<ImportClient>,
) {
  const importId = await start(s, actor)
  const results = await actor.as.mutation(api.clientImports.addBatch, {
    businessId: s.businessId,
    importId,
    clients,
  })
  return { importId, results }
}

/** Asks for an undo and lets every step of it run. */
async function undoAll(
  s: Setup,
  actor: TestActor,
  importId: Id<'clientImports'>,
) {
  vi.useFakeTimers()
  await actor.as.mutation(api.clientImports.undo, {
    businessId: s.businessId,
    importId,
  })
  await s.t.finishAllScheduledFunctions(vi.runAllTimers)
  vi.useRealTimers()
}

/** A client already in the book, with its one site at 12 Wattle Street. */
async function alreadyHere(
  s: Setup,
  fields: Partial<Doc<'clients'>> = {},
  businessId = s.businessId,
) {
  return s.t.run(async (ctx) => {
    const now = Date.now()
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'person',
      name: 'J. Nguyen',
      phone: '0412 345 678',
      email: 'j@nguyen.test',
      createdAt: now,
      updatedAt: now,
      ...fields,
    })
    const propertyId = await ctx.db.insert('properties', {
      businessId,
      clientId,
      addressLine: '12 Wattle Street',
      suburb: 'Bayswater',
      state: 'WA',
      postcode: '6053',
      createdAt: now,
    })
    return { clientId, propertyId }
  })
}

function everything(s: Setup) {
  return s.t.run(async (ctx) => ({
    clients: await ctx.db.query('clients').collect(),
    properties: await ctx.db.query('properties').collect(),
    clientContacts: await ctx.db.query('clientContacts').collect(),
    notes: await ctx.db.query('notes').collect(),
  }))
}

function sitesOf(s: Setup, clientId: Id<'clients'>) {
  return s.t.run((ctx) =>
    ctx.db
      .query('properties')
      .withIndex('by_client', (q) => q.eq('clientId', clientId))
      .collect(),
  )
}

/** A note's body, as the editor would open it; null once it is purged. */
async function body(s: Setup, noteId: Id<'notes'>) {
  const snapshot = await s.t.run((ctx) =>
    ctx.runQuery(components.prosemirrorSync.lib.getSnapshot, { id: noteId }),
  )
  return snapshot.content
}

/** Undo steps scheduled and not yet run. */
async function pendingSteps(s: Setup) {
  const jobs = await s.t.run((ctx) =>
    ctx.db.system.query('_scheduled_functions').collect(),
  )
  return jobs.filter(
    (job) => job.name.includes('undoStep') && job.state.kind === 'pending',
  ).length
}

/**
 * Types into a note as the editor does: each edit is sent as it is typed,
 * and the whole note saved once typing stops — `saved: false` is the moment
 * in between. `text` is what the note says after the edit, under its title.
 */
async function type(
  who: TestActor,
  note: Doc<'notes'>,
  text: string,
  { saved = true } = {},
) {
  const version = (await who.as.query(api.notesSync.latestVersion, {
    id: note._id,
  }))!
  await who.as.mutation(api.notesSync.submitSteps, {
    id: note._id,
    version,
    clientId: who.userId,
    steps: [
      JSON.stringify({
        stepType: 'replace',
        from: 1,
        to: 1,
        slice: { content: [{ type: 'text', text }] },
      }),
    ],
  })
  if (!saved) return
  await who.as.mutation(api.notesSync.submitSnapshot, {
    id: note._id,
    version: version + 1,
    content: JSON.stringify(docFromPlainText(`${note.title}\n${text}`)),
  })
}

function row<T extends 'clients' | 'properties' | 'clientImports'>(
  s: Setup,
  id: Id<T>,
) {
  return s.t.run((ctx) => ctx.db.get(id))
}

describe('who may import', () => {
  test('the owner and a contractor may; a subcontractor may not', async () => {
    const s = await setup()

    const byOwner = await importAs(s, s.terence, [
      person('c1', 'Mary Brown', [site('1 Rose Street')]),
    ])
    expect(byOwner.results[0].status).toBe('created')

    const byContractor = await importAs(s, s.jo, [
      person('c1', 'Bob Lee', [site('3 Rose Street')]),
    ])
    expect(byContractor.results[0].status).toBe('created')

    await expect(start(s, s.kevin)).rejects.toThrow(/NO_ACCESS/)
    await expect(
      s.kevin.as.mutation(api.clientImports.addBatch, {
        businessId: s.businessId,
        importId: byOwner.importId,
        clients: [person('c1', 'Sue Park', [site('5 Rose Street')])],
      }),
    ).rejects.toThrow(/NO_ACCESS/)
  })

  test('only the person who started an import adds to it', async () => {
    const s = await setup()
    const importId = await start(s, s.terence)

    // Not even the owner into a contractor's: it is the importer's Undo that
    // answers for what is in it.
    await expect(
      s.jo.as.mutation(api.clientImports.addBatch, {
        businessId: s.businessId,
        importId,
        clients: [person('c1', 'Bob Lee', [site('3 Rose Street')])],
      }),
    ).rejects.toThrow(/NO_ACCESS/)

    // Another business's import, through this business: not found.
    const rival = await createActor(s.t, { email: 'rival@other.test' })
    const other = await createBusiness(s.t, rival, 'Other Pest')
    const theirs = await rival.as.mutation(api.clientImports.start, {
      businessId: other.businessId,
      fileName: 'theirs.csv',
    })
    await expect(
      s.terence.as.mutation(api.clientImports.addBatch, {
        businessId: s.businessId,
        importId: theirs,
        clients: [],
      }),
    ).rejects.toThrow(/NOT_FOUND/)

    expect((await everything(s)).clients).toEqual([])
  })

  test('refuses a batch larger than the page sends', async () => {
    const s = await setup()
    const importId = await start(s, s.terence)
    const clients = Array.from({ length: IMPORT_BATCH_SIZE + 1 }, (_, i) =>
      person(`c${i}`, `Client ${i}`, [site(`${i + 1} Rose Street`)]),
    )
    await expect(
      s.terence.as.mutation(api.clientImports.addBatch, {
        businessId: s.businessId,
        importId,
        clients,
      }),
    ).rejects.toThrow(/BATCH_TOO_LARGE/)
    expect((await everything(s)).clients).toEqual([])
  })

  test('a batch of clients carries at most IMPORT_BATCH_SITES sites; one client may carry more on its own', async () => {
    const s = await setup()
    const importId = await start(s, s.terence)
    const sites = (n: number, street: string) =>
      Array.from({ length: n }, (_, i) => site(`${i + 1} ${street}`))

    // Two clients, one site over: not a batch the page makes.
    await expect(
      s.terence.as.mutation(api.clientImports.addBatch, {
        businessId: s.businessId,
        importId,
        clients: [
          person('c1', 'Mary Brown', sites(IMPORT_BATCH_SITES, 'Rose Street')),
          person('c2', 'Bob Lee', sites(1, 'Hill Road')),
        ],
      }),
    ).rejects.toThrow(/BATCH_TOO_LARGE/)
    expect((await everything(s)).properties).toEqual([])

    // At the limit, it lands.
    const atLimit = await s.terence.as.mutation(api.clientImports.addBatch, {
      businessId: s.businessId,
      importId,
      clients: [
        person('c1', 'Mary Brown', sites(IMPORT_BATCH_SITES - 1, 'Rose St')),
        person('c2', 'Bob Lee', sites(1, 'Hill Road')),
      ],
    })
    expect(atLimit.map((r) => r.status)).toEqual(['created', 'created'])

    // A property manager with 300 sites is one client, sent on its own.
    const big = await s.terence.as.mutation(api.clientImports.addBatch, {
      businessId: s.businessId,
      importId,
      clients: [person('c3', 'Strata Co', sites(300, 'Beach Road'))],
    })
    expect(big).toMatchObject([{ status: 'created', sitesCreated: 300 }])
  })

  test('names the file sensibly, whatever the page sends', async () => {
    const s = await setup()
    const blank = await s.terence.as.mutation(api.clientImports.start, {
      businessId: s.businessId,
      fileName: '   ',
      source: '  ',
    })
    const long = await s.terence.as.mutation(api.clientImports.start, {
      businessId: s.businessId,
      fileName: ` ${'a'.repeat(300)}.csv `,
    })
    const stored = await row(s, blank)
    expect(stored).toMatchObject({
      fileName: 'Spreadsheet',
      createdByMembershipId: s.ownerMembershipId,
      clients: 0,
      sites: 0,
      notes: 0,
      skipped: 0,
      failed: 0,
    })
    // A blank source is no source, not an empty chip on the page.
    expect(stored).not.toHaveProperty('source')
    expect((await row(s, long))?.fileName).toHaveLength(200)

    const audit = await s.t.run((ctx) =>
      ctx.db
        .query('auditLog')
        .withIndex('by_entity', (q) =>
          q.eq('entityType', 'clientImports').eq('entityId', blank),
        )
        .collect(),
    )
    expect(audit).toMatchObject([
      { action: 'clients.import', actorMembershipId: s.ownerMembershipId },
    ])
  })
})

describe('what a batch writes', () => {
  test('refuses the rows that break the rules, each with its reason, and writes the rest', async () => {
    const s = await setup()
    const { importId, results } = await importAs(s, s.terence, [
      person('ok', 'Mary Brown', [site('1 Rose Street')]),
      person('noName', '  ', [site('2 Rose Street')]),
      person('noSites', 'Bob Lee', []),
      person('postcode', 'Sue Park', [
        site('4 Rose Street', { postcode: '810' }),
      ]),
      person('email', 'Ali Khan', [site('6 Rose Street')], { email: 'ali@' }),
      {
        key: 'abn',
        kind: 'business',
        name: 'Coastal Cafe Group',
        abn: '51 824 753 557',
        sites: [site('8 Rose Street')],
      },
      // Only an extension: `checkPhone` sets it aside and passes the number,
      // but storing it would throw. Refused like any other row, not the
      // batch (`phoneProblem`).
      person('phone', 'Tom Wu', [site('10 Rose Street')], { phone: 'x21' }),
    ])

    expect(results.map((r) => [r.key, r.status, r.reason])).toEqual([
      ['ok', 'created', undefined],
      ['noName', 'failed', 'No client name.'],
      ['noSites', 'failed', 'No address — a client needs at least one site.'],
      [
        'postcode',
        'failed',
        'The postcode for 4 Rose Street is not four digits.',
      ],
      ['email', 'failed', 'ali@ is not an email address.'],
      ['abn', 'failed', 'The ABN does not pass the ATO check.'],
      ['phone', 'failed', 'x21 is not a phone number.'],
    ])
    for (const failed of results.slice(1)) {
      expect(failed).toMatchObject({
        sitesCreated: 0,
        sitesSkipped: 0,
        notesCreated: 0,
      })
      expect(failed.clientId).toBeUndefined()
    }

    const all = await everything(s)
    expect(all.clients.map((c) => c.name)).toEqual(['Mary Brown'])
    expect(all.properties.map((p) => p.addressLine)).toEqual(['1 Rose Street'])
    expect(await row(s, importId)).toMatchObject({
      clients: 1,
      sites: 1,
      notes: 0,
      skipped: 0,
      failed: 6,
    })
  })

  test('stores a business as the rules tidied it, with its contact person as the primary contact', async () => {
    const s = await setup()
    const { importId, results } = await importAs(s, s.terence, [
      {
        key: 'c1',
        kind: 'business',
        name: ' Coastal  Cafe Group ',
        abn: '51 824 753 556',
        contactPerson: ' Jan Morris ',
        email: 'Accounts@Coastal.COM.AU',
        phone: '08 9335 1000',
        sites: [
          site(' 88 Marine Parade ', {
            suburb: 'Cottesloe',
            state: 'wa',
            postcode: '6011',
            siteContactName: 'Priya Shah',
            siteContactPhone: '0400 111 222',
          }),
        ],
      },
    ])
    const clientId = results[0].clientId!

    expect(await row(s, clientId)).toMatchObject({
      kind: 'business',
      name: 'Coastal Cafe Group',
      abn: '51824753556',
      email: 'Accounts@coastal.com.au',
      phone: '08 9335 1000',
      importId,
    })
    const all = await everything(s)
    expect(all.clientContacts).toMatchObject([
      { clientId, name: 'Jan Morris', isPrimary: true },
    ])
    const [property] = await sitesOf(s, clientId)
    expect(property).toMatchObject({
      addressLine: '88 Marine Parade',
      suburb: 'Cottesloe',
      state: 'WA',
      postcode: '6011',
      siteContactName: 'Priya Shah',
      siteContactPhone: '0400 111 222',
      importId,
    })
    // Nobody entered it in a form, so nothing says how it was entered.
    expect(property.addressCheck).toBeUndefined()
  })

  test('a person gets no contact person and no ABN, whatever the file had', async () => {
    const s = await setup()
    const { results } = await importAs(s, s.terence, [
      person('c1', 'Mary Brown', [site('1 Rose Street')], {
        contactPerson: 'Jan Morris',
        abn: '51 824 753 556',
      }),
    ])
    expect((await row(s, results[0].clientId!))?.abn).toBeUndefined()
    expect((await everything(s)).clientContacts).toEqual([])
  })

  test('skips a site already here, however it is written, and the same site twice in one file', async () => {
    const s = await setup()
    await alreadyHere(s)

    const { importId, results } = await importAs(s, s.terence, [
      person('c1', 'Mary Brown', [
        site('12 wattle st.'), // already here
        site('14 Wattle St'),
        site('14 Wattle Street'), // the same, twice in one client
      ]),
      // Mary's new site again, under someone else: already here by now.
      person('c2', 'Bob Lee', [site('14 WATTLE ST')]),
      // Same street, another postcode: another place.
      person('c3', 'Sue Park', [
        site('12 Wattle Street', { suburb: 'Morley', postcode: '6062' }),
      ]),
    ])

    expect(results).toMatchObject([
      { key: 'c1', status: 'created', sitesCreated: 1, sitesSkipped: 2 },
      { key: 'c2', status: 'skipped', sitesCreated: 0, sitesSkipped: 1 },
      { key: 'c3', status: 'created', sitesCreated: 1, sitesSkipped: 0 },
    ])
    expect(results[1].clientId).toBeUndefined()

    const all = await everything(s)
    expect(all.clients.map((c) => c.name).sort()).toEqual([
      'J. Nguyen',
      'Mary Brown',
      'Sue Park',
    ])
    expect(await sitesOf(s, results[0].clientId!)).toMatchObject([
      { addressLine: '14 Wattle St' },
    ])
    expect(await row(s, importId)).toMatchObject({
      clients: 2,
      sites: 2,
      skipped: 3,
      failed: 0,
    })
  })

  test('knows a site saved with a three-digit postcode, as NT sites were before four digits were asked for', async () => {
    const s = await setup()
    const existing = await s.t.run(async (ctx) => {
      const now = Date.now()
      const clientId = await ctx.db.insert('clients', {
        businessId: s.businessId,
        kind: 'person',
        name: 'Old Client',
        createdAt: now,
        updatedAt: now,
      })
      await ctx.db.insert('properties', {
        businessId: s.businessId,
        clientId,
        addressLine: '3 Casuarina Drive',
        suburb: 'Nightcliff',
        state: 'NT',
        postcode: '810',
        createdAt: now,
      })
      return clientId
    })
    const darwin = { suburb: 'Nightcliff', state: 'NT', postcode: '0810' }

    const { results } = await importAs(s, s.terence, [
      person('c1', 'Old Client', [site('3 Casuarina Dr', darwin)], {
        existingClientId: existing,
      }),
      person('c2', 'New Client', [
        site('3 Casuarina Drive', darwin),
        site('5 Casuarina Drive', darwin),
      ]),
    ])

    expect(results).toMatchObject([
      { key: 'c1', status: 'skipped', sitesCreated: 0, sitesSkipped: 1 },
      { key: 'c2', status: 'created', sitesCreated: 1, sitesSkipped: 1 },
    ])
    const all = await everything(s)
    expect(
      all.properties.map((p) => [p.addressLine, p.postcode]).sort(),
    ).toEqual([
      ['3 Casuarina Drive', '810'],
      ['5 Casuarina Drive', '0810'],
    ])
  })

  test('adds new sites to a client already here, and changes nothing about it', async () => {
    const s = await setup()
    const here = await alreadyHere(s)
    const before = await row(s, here.clientId)

    const { importId, results } = await importAs(s, s.jo, [
      person(
        'c1',
        'j  nguyen',
        [site('12 Wattle Street'), site('3 Hill Road')],
        {
          existingClientId: here.clientId,
          phone: '0499 999 999',
          email: 'someone@else.test',
        },
      ),
    ])

    expect(results).toMatchObject([
      {
        status: 'added',
        clientId: here.clientId,
        sitesCreated: 1,
        sitesSkipped: 1,
      },
    ])
    expect(await row(s, here.clientId)).toEqual(before)
    const sites = await sitesOf(s, here.clientId)
    expect(sites.map((p) => [p.addressLine, p.importId])).toEqual([
      ['12 Wattle Street', undefined],
      ['3 Hill Road', importId],
    ])
    // It made no client, so it counts none.
    expect(await row(s, importId)).toMatchObject({ clients: 0, sites: 1 })
  })

  test('makes a new client when the one it names is not the same: renamed, archived, or another business’s', async () => {
    const s = await setup()
    const renamed = await alreadyHere(s, { name: 'Jo Nguyen' })
    const archived = await alreadyHere(s, {
      name: 'Mary Brown',
      archivedAt: Date.now(),
    })
    const rival = await createActor(s.t, { email: 'rival@other.test' })
    const other = await createBusiness(s.t, rival, 'Other Pest')
    const theirs = await alreadyHere(s, { name: 'Bob Lee' }, other.businessId)

    const { results } = await importAs(s, s.terence, [
      person('c1', 'J. Nguyen', [site('1 Hill Road')], {
        existingClientId: renamed.clientId,
      }),
      person('c2', 'Mary Brown', [site('2 Hill Road')], {
        existingClientId: archived.clientId,
      }),
      person('c3', 'Bob Lee', [site('3 Hill Road')], {
        existingClientId: theirs.clientId,
      }),
    ])

    expect(results.map((r) => r.status)).toEqual([
      'created',
      'created',
      'created',
    ])
    for (const [result, notThis] of [
      [results[0], renamed],
      [results[1], archived],
      [results[2], theirs],
    ] as const) {
      expect(result.clientId).not.toBe(notThis.clientId)
      expect(await sitesOf(s, notThis.clientId)).toHaveLength(1)
    }
  })

  test('a name that differs only by an accent is someone else', async () => {
    const s = await setup()
    const moller = await alreadyHere(s, { name: 'Hans Möller' })
    const le = await alreadyHere(s, { name: 'Lê Thị Hà' })
    const blank = await alreadyHere(s, { name: '?' })

    const { results } = await importAs(s, s.terence, [
      person('c1', 'Hans Müller', [site('1 Hill Road')], {
        existingClientId: moller.clientId,
      }),
      person('c2', 'Lý Thị Hồ', [site('2 Hill Road')], {
        existingClientId: le.clientId,
      }),
      // Punctuation alone has no name to match on.
      person('c3', '-', [site('3 Hill Road')], {
        existingClientId: blank.clientId,
      }),
      // The same name, decomposed as macOS writes it, is the same client.
      person('c4', 'Hans Möller'.normalize('NFD'), [site('4 Hill Road')], {
        existingClientId: moller.clientId,
      }),
    ])

    expect(results.map((r) => r.status)).toEqual([
      'created',
      'created',
      'created',
      'added',
    ])
    expect(results[0].clientId).not.toBe(moller.clientId)
    expect(results[1].clientId).not.toBe(le.clientId)
    expect(results[2].clientId).not.toBe(blank.clientId)
    expect(results[3].clientId).toBe(moller.clientId)
    expect(
      (await sitesOf(s, moller.clientId)).map((p) => p.addressLine),
    ).toEqual(['12 Wattle Street', '4 Hill Road'])
    expect(await sitesOf(s, le.clientId)).toHaveLength(1)
  })

  test('makes a site’s note a pinned, shared note on that site, written by the importer', async () => {
    const s = await setup()
    const { importId, results } = await importAs(s, s.jo, [
      person('c1', 'Mary Brown', [
        site('1 Rose Street', { note: 'Gate code 1234\r\nDog in the yard' }),
        site('3 Rose Street'),
      ]),
    ])
    expect(results[0]).toMatchObject({ sitesCreated: 2, notesCreated: 1 })

    const clientId = results[0].clientId!
    const [noted] = await sitesOf(s, clientId)
    const { notes } = await everything(s)
    expect(notes).toHaveLength(1)
    const [note] = notes
    expect(note).toMatchObject({
      businessId: s.businessId,
      propertyId: noted._id,
      clientId,
      authorMembershipId: s.joId,
      lastEditedByMembershipId: s.joId,
      title: '1 Rose Street',
      pinnedAt: expect.any(Number),
    })
    expect(note.visibility).toBeUndefined()
    expect(note.jobId).toBeUndefined()
    expect(note.plainText).toContain('Gate code 1234')
    expect(note.plainText).toContain('Dog in the yard')
    expect(note.plainText).not.toContain('\r')
    // The body the editor opens: the address as its heading, each line of
    // the cell a paragraph of its own.
    const doc = JSON.parse((await body(s, note._id))!)
    expect(doc.content.map((block: { type: string }) => block.type)).toEqual([
      'heading',
      'paragraph',
      'paragraph',
    ])

    // Shared: a subcontractor opening the site reads it there.
    const onSite = await s.kevin.as.query(api.notes.listForProperty, {
      businessId: s.businessId,
      propertyId: noted._id,
    })
    expect(onSite.site.map((n) => n._id)).toEqual([note._id])

    expect(await row(s, importId)).toMatchObject({ notes: 1 })
  })
})

describe('undo', () => {
  test('takes back what nobody has worked on, and keeps what someone has', async () => {
    const s = await setup()
    const here = await alreadyHere(s)
    const hereBefore = await row(s, here.clientId)

    const { importId, results } = await importAs(s, s.terence, [
      {
        key: 'plain',
        kind: 'business',
        name: 'Coastal Cafe Group',
        contactPerson: 'Jan Morris',
        sites: [site('1 Rose Street', { note: 'Gate code 1234' })],
      },
      person('job', 'Bob Lee', [site('3 Rose Street')]),
      person('report', 'Sue Park', [site('5 Rose Street')]),
      person('series', 'Ali Khan', [site('7 Rose Street')]),
      person('note', 'Priya Shah', [
        site('9 Rose Street', { note: 'Side gate' }),
        site('11 Rose Street'),
      ]),
      person('contact', 'Tom Wu', [site('13 Rose Street')]),
      person('existing', 'J. Nguyen', [site('3 Hill Road')], {
        existingClientId: here.clientId,
      }),
    ])
    const id = (key: string) => results.find((r) => r.key === key)!.clientId!
    const firstSite = async (key: string) => (await sitesOf(s, id(key)))[0]

    // Worked on since: a job, a report, a repeating series, a note someone
    // wrote on the site, and a contact someone added to the client.
    const worked = {
      job: (await firstSite('job'))._id,
      report: (await firstSite('report'))._id,
      series: (await firstSite('series'))._id,
      note: (await firstSite('note'))._id,
    }
    await s.t.run(async (ctx) => {
      const now = Date.now()
      await ctx.db.insert('jobs', {
        businessId: s.businessId,
        propertyId: worked.job,
        assignedMembershipId: s.ownerMembershipId,
        jobType: 'General Pest Control',
        price: 20000,
        scheduledAt: now + DAY,
        durationMinutes: 60,
        status: 'pending',
        createdAt: now,
      })
      await ctx.db.insert('reports', {
        businessId: s.businessId,
        propertyId: worked.report,
        authorMembershipId: s.ownerMembershipId,
        template: 'serviceReport',
        templateVersion: 1,
        legalBasis: 'APVMA',
        data: {},
        photoIds: [],
        status: 'draft',
        createdAt: now,
      })
      await ctx.db.insert('recurrences', {
        businessId: s.businessId,
        propertyId: worked.series,
        assignedMembershipId: s.ownerMembershipId,
        intervalCount: 3,
        intervalUnit: 'month',
        jobType: 'General Pest Control',
        price: 20000,
        anchorDate: now + 90 * DAY,
        active: true,
      })
      await ctx.db.insert('notes', {
        businessId: s.businessId,
        authorMembershipId: s.kevinId,
        lastEditedByMembershipId: s.kevinId,
        propertyId: worked.note,
        clientId: id('note'),
        title: 'Dog',
        preview: '',
        plainText: 'Dog\n',
        createdAt: now + 1000,
        updatedAt: now + 1000,
      })
      await ctx.db.insert('clientContacts', {
        businessId: s.businessId,
        clientId: id('contact'),
        name: 'Accounts',
        createdAt: now + 1000,
      })
    })

    const importsNote = (await everything(s)).notes.find(
      (n) => n.title === '1 Rose Street',
    )!
    expect(await body(s, importsNote._id)).not.toBeNull()

    await undoAll(s, s.terence, importId)
    const all = await everything(s)
    // Its body too, not just the row that pointed at it.
    expect(await body(s, importsNote._id)).toBeNull()

    // Nothing worked on: the client, its contact, its site and its note.
    expect(all.clients.find((c) => c.name === 'Coastal Cafe Group')).toBe(
      undefined,
    )
    expect(all.clientContacts.map((c) => c.name)).toEqual(['Accounts'])
    expect(all.notes.map((n) => n.title).sort()).toEqual([
      '9 Rose Street',
      'Dog',
    ])

    // A job, a report or a series: client and site both stay, and are no
    // longer the import's.
    for (const key of ['job', 'report', 'series'] as const) {
      const client = await row(s, id(key))
      const kept = await row(s, worked[key])
      expect(client?.importId).toBeUndefined()
      expect(kept?.importId).toBeUndefined()
      expect(kept?.clientId).toBe(id(key))
    }

    // A note someone wrote keeps that site — and its client, with the site
    // nobody touched gone. The import's own note on the kept site stays
    // with it.
    expect(
      (await sitesOf(s, id('note'))).map((p) => [p.addressLine, p.importId]),
    ).toEqual([['9 Rose Street', undefined]])
    expect((await row(s, id('note')))?.importId).toBeUndefined()

    // A contact added since keeps the client; its untouched site goes.
    expect(await row(s, id('contact'))).toMatchObject({ name: 'Tom Wu' })
    expect(await sitesOf(s, id('contact'))).toEqual([])

    // The client that was already here: the site the import added goes, and
    // the client and its own site are exactly as they were.
    expect(await row(s, here.clientId)).toEqual(hereBefore)
    expect((await sitesOf(s, here.clientId)).map((p) => p._id)).toEqual([
      here.propertyId,
    ])

    // Nothing carries the import any more.
    expect(all.clients.filter((c) => c.importId !== undefined)).toEqual([])
    expect(all.properties.filter((p) => p.importId !== undefined)).toEqual([])

    // Removed: four sites (1, 11 and 13 Rose Street, 3 Hill Road) and one
    // client. Kept: four sites and five clients.
    expect(await row(s, importId)).toMatchObject({
      undoneAt: expect.any(Number),
      undoneByMembershipId: s.ownerMembershipId,
      undoState: 'done',
      undoRemoved: 5,
      undoKept: 9,
    })
  })

  test('the import’s own note goes with its site only while nobody has edited it', async () => {
    const s = await setup()
    const { importId, results } = await importAs(s, s.terence, [
      person('c1', 'Mary Brown', [
        site('1 Rose Street', { note: 'Gate code 1234' }),
        site('3 Rose Street', { note: 'Gate code 5678' }),
        site('5 Rose Street', { note: 'Side gate' }),
        site('7 Rose Street', { note: 'Key under the mat' }),
        site('9 Rose Street', { note: 'Dog in the yard' }),
        site('11 Rose Street', { note: 'Ring first' }),
      ]),
    ])
    const clientId = results[0].clientId!
    const noteOn = async (addressLine: string) =>
      (await everything(s)).notes.find((n) => n.title === addressLine)!
    const untouched = await noteOn('1 Rose Street')
    const kevins = await noteOn('3 Rose Street')
    const photographed = await noteOn('5 Rose Street')
    const importers = await noteOn('7 Rose Street')
    const kevinThenImporter = await noteOn('9 Rose Street')
    const unsaved = await noteOn('11 Rose Street')

    // Kevin opens it and reads it, and types nothing.
    await s.kevin.as.query(api.notesSync.getSnapshot, { id: untouched._id })
    const opened = await s.kevin.as.query(api.notesSync.latestVersion, {
      id: untouched._id,
    })
    await s.kevin.as.query(api.notesSync.getSteps, {
      id: untouched._id,
      version: opened!,
    })

    // Kevin changes the gate code, in the editor.
    await type(s.kevin, kevins, 'Gate code 4321')
    // Terence, who ran the import, adds to his own note.
    await type(s.terence, importers, 'Key under the mat, spare in the shed')
    // Kevin notes the dog's name, then Terence adds a line after him: the
    // note now names Terence as its last editor, and Kevin's words are
    // still in it.
    await type(s.kevin, kevinThenImporter, 'Dog in the yard, Rex')
    await type(s.terence, kevinThenImporter, 'Dog in the yard, Rex. Friendly')
    // Jo is typing, and the editor has sent the edit but not yet saved the
    // note: the row still reads as the import wrote it.
    await type(s.jo, unsaved, 'Ring first, gate sticks', { saved: false })
    expect(await s.t.run((ctx) => ctx.db.get(unsaved._id))).toMatchObject({
      lastEditedByMembershipId: s.ownerMembershipId,
      updatedAt: unsaved.createdAt,
    })

    // Jo adds a photo of the key box, which leaves the note's text as it
    // was.
    const photo = await s.t.run(async (ctx) => {
      const storageId = await ctx.storage.store(
        new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      )
      await ctx.db.insert('noteAttachments', {
        noteId: photographed._id,
        storageId,
        createdAt: Date.now() + 1000,
      })
      return storageId
    })

    await undoAll(s, s.terence, importId)

    // Any edit, by anyone, or a photo, keeps the site and the note, and so
    // the client; the sites are no longer the import's.
    expect(
      (await sitesOf(s, clientId)).map((p) => [p.addressLine, p.importId]),
    ).toEqual([
      ['3 Rose Street', undefined],
      ['5 Rose Street', undefined],
      ['7 Rose Street', undefined],
      ['9 Rose Street', undefined],
      ['11 Rose Street', undefined],
    ])
    expect((await row(s, clientId))?.importId).toBeUndefined()
    const kept = [kevins, photographed, importers, kevinThenImporter, unsaved]
    const notes = (await everything(s)).notes.map((n) => n._id).sort()
    expect(notes).toEqual(kept.map((n) => n._id).sort())
    expect(await body(s, kevins._id)).toContain('Gate code 4321')
    expect(await body(s, kevinThenImporter._id)).toContain('Rex. Friendly')
    expect(
      await s.t.run((ctx) => ctx.db.system.get('_storage', photo)),
    ).not.toBeNull()

    // Nobody edited it: the site goes, its note and body too.
    expect(await body(s, untouched._id)).toBeNull()
    expect(await row(s, importId)).toMatchObject({
      undoState: 'done',
      undoRemoved: 1,
      undoKept: 6,
    })
  })

  test('an undo that stopped partway can be carried on, once, and finishes', async () => {
    const s = await setup()
    const { importId, results } = await importAs(s, s.jo, [
      person('c1', 'Mary Brown', [
        site('1 Rose Street', { note: 'Gate code 1234' }),
      ]),
      person('c2', 'Bob Lee', [site('3 Rose Street')]),
    ])
    // As `undo` leaves it, with the step it scheduled having failed: marked
    // undone and running, and nothing removed. `lastStep` is a step that
    // did run, that long ago.
    const stopped = async (asked: number, lastStep?: number) =>
      s.t.run((ctx) =>
        ctx.db.patch(importId, {
          undoneAt: Date.now() - asked,
          undoneByMembershipId: s.joId,
          undoState: 'running',
          undoStepAt:
            lastStep === undefined ? undefined : Date.now() - lastStep,
          undoRemoved: 0,
          undoKept: 0,
        }),
      )
    const ask = (actor: TestActor) =>
      actor.as.mutation(api.clientImports.undo, {
        businessId: s.businessId,
        importId,
      })

    // Too soon to call it stopped: a step may still be on its way.
    await stopped(UNDO_STUCK_MS - 60 * 1000)
    await expect(ask(s.jo)).rejects.toThrow(/UNDO_RUNNING/)
    // Asked for long ago, but a step ran a minute ago: still moving.
    await stopped(3 * UNDO_STUCK_MS, 60 * 1000)
    await expect(ask(s.jo)).rejects.toThrow(/UNDO_RUNNING/)
    expect(await pendingSteps(s)).toBe(0)

    // Stopped: still only for those who may carry it on.
    await stopped(UNDO_STUCK_MS + 1000)
    await expect(ask(s.kevin)).rejects.toThrow(/NO_ACCESS/)
    const rival = await createActor(s.t, { email: 'rival@other.test' })
    const other = await createBusiness(s.t, rival, 'Other Pest')
    await expect(
      rival.as.mutation(api.clientImports.undo, {
        businessId: other.businessId,
        importId,
      }),
    ).rejects.toThrow(/NOT_FOUND/)

    // Asked for long ago, and no step since the last, a while back either.
    await stopped(3 * UNDO_STUCK_MS, UNDO_STUCK_MS + 1000)
    vi.useFakeTimers()
    await ask(s.jo)
    // Carrying on is progress: it reads as running again, not stopped…
    expect((await row(s, importId))?.undoStepAt).toBe(Date.now())
    expect(await pendingSteps(s)).toBe(1)
    // …so a second tap straight after starts no second chain of steps.
    await expect(ask(s.jo)).rejects.toThrow(/UNDO_RUNNING/)
    expect(await pendingSteps(s)).toBe(1)
    await s.t.finishAllScheduledFunctions(vi.runAllTimers)
    vi.useRealTimers()

    for (const result of results) {
      expect(await row(s, result.clientId!)).toBeNull()
    }
    expect(await everything(s)).toMatchObject({
      clients: [],
      properties: [],
      notes: [],
    })
    expect(await row(s, importId)).toMatchObject({
      undoneByMembershipId: s.joId,
      undoState: 'done',
      undoRemoved: 4,
      undoKept: 0,
    })
    // Finished, it is undone once and for all.
    await expect(ask(s.jo)).rejects.toThrow(/ALREADY_UNDONE/)
    // Asking again is not a second undo in the audit log.
    const audit = await s.t.run((ctx) =>
      ctx.db
        .query('auditLog')
        .withIndex('by_entity', (q) =>
          q.eq('entityType', 'clientImports').eq('entityId', importId),
        )
        .collect(),
    )
    expect(audit.map((a) => a.action)).toEqual(['clients.import'])
  })

  test('an undo that is still moving is refused, however long ago it was asked for', async () => {
    const s = await setup()
    // 75 sites and 25 clients: four steps.
    const { importId } = await importAs(
      s,
      s.terence,
      Array.from({ length: IMPORT_BATCH_SIZE }, (_, n) =>
        person(`c${n}`, `Client ${n}`, [
          site(`${n} Rose Street`),
          site(`${n} Hill Road`),
          site(`${n} Lake Drive`),
        ]),
      ),
    )
    const ask = () =>
      s.terence.as.mutation(api.clientImports.undo, {
        businessId: s.businessId,
        importId,
      })

    vi.useFakeTimers()
    const asked = Date.now()
    await ask()
    // Straight after: the first step is on its way.
    await expect(ask()).rejects.toThrow(/UNDO_RUNNING/)

    // The first step runs, nine minutes on.
    vi.setSystemTime(asked + UNDO_STUCK_MS - 60 * 1000)
    vi.runOnlyPendingTimers()
    await s.t.finishInProgressScheduledFunctions()
    expect(await row(s, importId)).toMatchObject({
      undoState: 'running',
      undoneAt: asked,
      undoStepAt: asked + UNDO_STUCK_MS - 60 * 1000,
      undoRemoved: 50,
    })

    // Longer ago than `UNDO_STUCK_MS` since it was asked for, but a step
    // ran two minutes ago: it is moving, and asking again would only start
    // a second chain beside it.
    vi.setSystemTime(asked + UNDO_STUCK_MS + 60 * 1000)
    await expect(ask()).rejects.toThrow(/UNDO_RUNNING/)
    expect(await pendingSteps(s)).toBe(1)

    await s.t.finishAllScheduledFunctions(vi.runAllTimers)
    vi.useRealTimers()
    expect(await row(s, importId)).toMatchObject({
      undoState: 'done',
      undoRemoved: 100,
      undoKept: 0,
    })
    const all = await everything(s)
    expect(all.clients).toEqual([])
    expect(all.properties).toEqual([])
    await expect(ask()).rejects.toThrow(/ALREADY_UNDONE/)
  })

  test('a contractor may not undo the owner’s import; the owner may undo a contractor’s', async () => {
    const s = await setup()
    const owners = await importAs(s, s.terence, [
      person('c1', 'Mary Brown', [site('1 Rose Street')]),
    ])
    const jos = await importAs(s, s.jo, [
      person('c1', 'Bob Lee', [site('3 Rose Street')]),
    ])

    await expect(
      s.jo.as.mutation(api.clientImports.undo, {
        businessId: s.businessId,
        importId: owners.importId,
      }),
    ).rejects.toThrow(/NO_ACCESS/)
    await expect(
      s.kevin.as.mutation(api.clientImports.undo, {
        businessId: s.businessId,
        importId: jos.importId,
      }),
    ).rejects.toThrow(/NO_ACCESS/)

    await undoAll(s, s.terence, jos.importId)
    expect(await row(s, jos.results[0].clientId!)).toBeNull()
    expect(await row(s, jos.importId)).toMatchObject({
      undoneByMembershipId: s.ownerMembershipId,
      undoState: 'done',
    })

    // Once is all.
    await expect(
      s.jo.as.mutation(api.clientImports.undo, {
        businessId: s.businessId,
        importId: jos.importId,
      }),
    ).rejects.toThrow(/ALREADY_UNDONE/)
    // And what was still on its way does not land after it.
    await expect(
      s.jo.as.mutation(api.clientImports.addBatch, {
        businessId: s.businessId,
        importId: jos.importId,
        clients: [person('c2', 'Sue Park', [site('5 Rose Street')])],
      }),
    ).rejects.toThrow(/IMPORT_UNDONE/)

    // The owner's own import is untouched by any of it.
    expect(await row(s, owners.results[0].clientId!)).toMatchObject({
      name: 'Mary Brown',
      importId: owners.importId,
    })
  })

  test('the importer may undo their own, for a week', async () => {
    const s = await setup()
    const recent = await importAs(s, s.jo, [
      person('c1', 'Mary Brown', [site('1 Rose Street')]),
    ])
    const old = await importAs(s, s.jo, [
      person('c1', 'Bob Lee', [site('3 Rose Street')]),
    ])
    await s.t.run(async (ctx) => {
      await ctx.db.patch(recent.importId, { createdAt: Date.now() - 6 * DAY })
      await ctx.db.patch(old.importId, { createdAt: Date.now() - 8 * DAY })
    })

    await expect(
      s.jo.as.mutation(api.clientImports.undo, {
        businessId: s.businessId,
        importId: old.importId,
      }),
    ).rejects.toThrow(/UNDO_EXPIRED/)
    expect((await row(s, old.importId))?.undoneAt).toBeUndefined()

    await undoAll(s, s.jo, recent.importId)
    expect(await row(s, recent.results[0].clientId!)).toBeNull()

    const audit = await s.t.run((ctx) =>
      ctx.db
        .query('auditLog')
        .withIndex('by_entity', (q) =>
          q.eq('entityType', 'clientImports').eq('entityId', recent.importId),
        )
        .collect(),
    )
    expect(audit.map((a) => [a.action, a.actorMembershipId])).toEqual([
      ['clients.import', s.joId],
      ['clients.importUndo', s.joId],
    ])
  })

  test('works through an import too big for one step', async () => {
    const s = await setup()
    const importId = await start(s, s.terence)
    // Three batches of 25, two sites each: 150 sites, three steps' worth.
    for (let batch = 0; batch < 3; batch++) {
      await s.terence.as.mutation(api.clientImports.addBatch, {
        businessId: s.businessId,
        importId,
        clients: Array.from({ length: IMPORT_BATCH_SIZE }, (_, i) => {
          const n = batch * IMPORT_BATCH_SIZE + i
          return person(`c${n}`, `Client ${n}`, [
            site(`${n} Rose Street`, { note: 'Key under the mat' }),
            site(`${n} Hill Road`),
          ])
        }),
      })
    }
    expect(await row(s, importId)).toMatchObject({
      clients: 75,
      sites: 150,
      notes: 75,
    })

    await undoAll(s, s.terence, importId)
    const all = await everything(s)
    expect(all.clients).toEqual([])
    expect(all.properties).toEqual([])
    expect(all.notes).toEqual([])
    expect(await row(s, importId)).toMatchObject({
      undoState: 'done',
      undoRemoved: 225,
      undoKept: 0,
    })
  })
})

describe('nothing comes in while an undo is running', () => {
  // Jo has a second file on the review screen when Terence, on his phone,
  // undoes her first. The sites the undo hasn't reached yet are still here,
  // so her Import would skip them as already here — then the undo takes
  // them away, and they are in neither import.

  /** Asks for an undo and leaves it running: its first step not yet run. */
  async function askUndo(
    s: Setup,
    actor: TestActor,
    importId: Id<'clientImports'>,
  ) {
    vi.useFakeTimers()
    await actor.as.mutation(api.clientImports.undo, {
      businessId: s.businessId,
      importId,
    })
  }

  /** Lets every step of the undo run, to done. */
  async function finishUndo(s: Setup) {
    await s.t.finishAllScheduledFunctions(vi.runAllTimers)
    vi.useRealTimers()
  }

  /** As a step that failed leaves it: running, with no step for longer
   * than `UNDO_STUCK_MS`. */
  function stall(s: Setup, importId: Id<'clientImports'>) {
    return s.t.run((ctx) =>
      ctx.db.patch(importId, {
        undoneAt: Date.now() - 3 * UNDO_STUCK_MS,
        undoStepAt: Date.now() - 2 * UNDO_STUCK_MS,
      }),
    )
  }

  const maryBrown = () => person('c1', 'Mary Brown', [site('1 Rose Street')])

  test('no import starts, whether the undo is moving or has stopped, and one does once it is done', async () => {
    const s = await setup()
    const first = await importAs(s, s.jo, [maryBrown()])
    const imports = () =>
      s.t.run((ctx) => ctx.db.query('clientImports').collect())

    await askUndo(s, s.terence, first.importId)
    // Moving: its first step is on its way. Not for the importer, and not
    // for the owner who asked for it.
    await expect(start(s, s.jo)).rejects.toThrow(/UNDO_IN_PROGRESS/)
    await expect(start(s, s.terence)).rejects.toThrow(/UNDO_IN_PROGRESS/)
    // Someone who may not import is told only that.
    await expect(start(s, s.kevin)).rejects.toThrow(/NO_ACCESS/)
    // Stopped part-way: what it hasn't reached is still waiting to go.
    await stall(s, first.importId)
    await expect(start(s, s.jo)).rejects.toThrow(/UNDO_IN_PROGRESS/)
    expect((await imports()).map((i) => i._id)).toEqual([first.importId])

    await finishUndo(s)
    expect((await row(s, first.importId))?.undoState).toBe('done')
    // Done: Mary Brown went with it, so the second file brings her back, in
    // an import of its own.
    const second = await importAs(s, s.jo, [maryBrown()])
    expect(second.results).toMatchObject([
      { status: 'created', sitesCreated: 1, sitesSkipped: 0 },
    ])
    expect((await everything(s)).properties).toMatchObject([
      { addressLine: '1 Rose Street', importId: second.importId },
    ])
  })

  test('no batch lands while an undo is running, and it does once the undo is done', async () => {
    const s = await setup()
    const first = await importAs(s, s.jo, [maryBrown()])
    // Jo started her second file before Terence undid her first.
    const second = await start(s, s.jo)
    const batch = () =>
      s.jo.as.mutation(api.clientImports.addBatch, {
        businessId: s.businessId,
        importId: second,
        clients: [
          maryBrown(),
          person('c2', 'Bob Lee', [site('3 Rose Street')]),
        ],
      })

    await askUndo(s, s.terence, first.importId)
    await expect(batch()).rejects.toThrow(/UNDO_IN_PROGRESS/)
    await stall(s, first.importId)
    await expect(batch()).rejects.toThrow(/UNDO_IN_PROGRESS/)
    // None of it landed: no Bob Lee, and the second import made nothing and
    // skipped nothing.
    expect((await everything(s)).clients.map((c) => c.name)).toEqual([
      'Mary Brown',
    ])
    expect(await row(s, second)).toMatchObject({
      clients: 0,
      sites: 0,
      skipped: 0,
      failed: 0,
    })

    await finishUndo(s)
    // Mary Brown's site went with the undo, so it comes in — in the second
    // import, whose Undo answers for it — rather than being skipped as
    // already here.
    expect(await batch()).toMatchObject([
      { key: 'c1', status: 'created', sitesCreated: 1, sitesSkipped: 0 },
      { key: 'c2', status: 'created', sitesCreated: 1, sitesSkipped: 0 },
    ])
    const all = await everything(s)
    expect(all.properties.map((p) => [p.addressLine, p.importId])).toEqual([
      ['1 Rose Street', second],
      ['3 Rose Street', second],
    ])
    expect(await row(s, second)).toMatchObject({ clients: 2, sites: 2 })
  })

  test('a batch for the import being undone is told it was undone, not to wait', async () => {
    const s = await setup()
    const mine = await importAs(s, s.jo, [maryBrown()])
    const more = () =>
      s.jo.as.mutation(api.clientImports.addBatch, {
        businessId: s.businessId,
        importId: mine.importId,
        clients: [person('c2', 'Bob Lee', [site('3 Rose Street')])],
      })

    // Its own undo is running: the rest of it is never to land, however long
    // it waits.
    await askUndo(s, s.terence, mine.importId)
    await expect(more()).rejects.toThrow(/IMPORT_UNDONE/)
    await stall(s, mine.importId)
    await expect(more()).rejects.toThrow(/IMPORT_UNDONE/)
    await finishUndo(s)
    await expect(more()).rejects.toThrow(/IMPORT_UNDONE/)
    expect((await everything(s)).clients).toEqual([])
  })

  test('another business’s undo holds nothing up', async () => {
    const s = await setup()
    const rival = await createActor(s.t, { email: 'rival@other.test' })
    const other = await createBusiness(s.t, rival, 'Other Pest')
    const theirs = await rival.as.mutation(api.clientImports.start, {
      businessId: other.businessId,
      fileName: 'theirs.csv',
    })
    await rival.as.mutation(api.clientImports.addBatch, {
      businessId: other.businessId,
      importId: theirs,
      clients: [maryBrown()],
    })
    vi.useFakeTimers()
    await rival.as.mutation(api.clientImports.undo, {
      businessId: other.businessId,
      importId: theirs,
    })
    expect((await row(s, theirs))?.undoState).toBe('running')

    const { results } = await importAs(s, s.jo, [maryBrown()])
    expect(results).toMatchObject([{ status: 'created', sitesCreated: 1 }])
    await finishUndo(s)
  })
})

describe('the list of recent imports', () => {
  test('newest first, with what each made, who ran it and whether this caller may undo it', async () => {
    const s = await setup()
    await alreadyHere(s)
    const owners = await importAs(s, s.terence, [
      person('c1', 'Mary Brown', [
        site('1 Rose Street', { note: 'Gate code 1234' }),
        site('12 Wattle Street'),
      ]),
      person('c2', '', [site('3 Rose Street')]),
    ])
    const jos = await importAs(s, s.jo, [
      person('c1', 'Bob Lee', [site('5 Rose Street')]),
    ])

    const forOwner = await s.terence.as.query(api.clientImports.list, {
      businessId: s.businessId,
    })
    expect(forOwner).toEqual([
      {
        _id: jos.importId,
        fileName: 'clients.csv',
        source: 'Jobber',
        createdAt: expect.any(Number),
        clients: 1,
        sites: 1,
        notes: 0,
        skipped: 0,
        failed: 0,
        byName: 'Jo',
        canUndo: true,
      },
      {
        _id: owners.importId,
        fileName: 'clients.csv',
        source: 'Jobber',
        createdAt: expect.any(Number),
        clients: 1,
        sites: 1,
        notes: 1,
        skipped: 1,
        failed: 1,
        byName: 'Terence',
        canUndo: true,
      },
    ])

    // A contractor may undo their own, not the owner's.
    const forJo = await s.jo.as.query(api.clientImports.list, {
      businessId: s.businessId,
    })
    expect(forJo.map((i) => [i.byName, i.canUndo])).toEqual([
      ['Jo', true],
      ['Terence', false],
    ])

    // Someone who cannot import is shown none, rather than refused.
    expect(
      await s.kevin.as.query(api.clientImports.list, {
        businessId: s.businessId,
      }),
    ).toEqual([])

    // Undone, it says so and says what it took back.
    await undoAll(s, s.jo, jos.importId)
    const [undone] = await s.terence.as.query(api.clientImports.list, {
      businessId: s.businessId,
    })
    expect(undone).toMatchObject({
      _id: jos.importId,
      undoneAt: expect.any(Number),
      undoState: 'done',
      undoRemoved: 2,
      undoKept: 0,
    })
  })

  test('keeps to the last ten', async () => {
    const s = await setup()
    const ids = []
    for (let i = 0; i < 12; i++) ids.push(await start(s, s.terence))
    const list = await s.terence.as.query(api.clientImports.list, {
      businessId: s.businessId,
    })
    expect(list.map((i) => i._id)).toEqual(ids.reverse().slice(0, 10))
  })
})
