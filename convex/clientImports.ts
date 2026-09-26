import { ConvexError, v } from 'convex/values'
import { internal } from './_generated/api'
import { internalMutation, mutation, query } from './_generated/server'
import { requireActor, requireCapability, requireWriteActor } from './lib/actor'
import { forSelf, recordAudit } from './lib/audit'
import {
  IMPORT_BATCH_SIZE,
  IMPORT_UNDO_DAYS,
  MAX_IMPORT_ROWS,
  checkImportClient,
  importClientValidator,
  importResultValidator,
  nameKey,
  siteKey,
} from './lib/clientImport'
import { memberName } from './lib/reportContext'
import { deriveNoteFields, docFromPlainText } from './lib/richText'
import { purgeNote } from './notes'
import { prosemirrorSync } from './notesSync'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import type { ActorEnvelope } from './lib/actor'
import type { ImportClient, ImportResult, ImportSite } from './lib/clientImport'

/**
 * Bringing a client list across from a spreadsheet or another app ("Bring
 * your clients across"). The page reads the file, matches the columns and
 * shows what will happen; this writes what it is sent, one batch at a time,
 * and can take it back.
 *
 * ── Who may do what ──────────────────────────────────────────────────────
 *
 *  - Import: anyone holding `clients.manage` — the owner and contractors, not
 *    subcontractors. It is one of the admin capabilities a switch drops, so
 *    nobody fills the client book from inside someone else's account, and an
 *    import is always the real person's (`env.actor.real`).
 *  - Undo: the person who ran it, or the owner (`business.manage`), for
 *    `IMPORT_UNDO_DAYS`. Still only while they hold `clients.manage`: undo
 *    deletes clients, and someone who can no longer manage the book should
 *    not be able to empty part of it either.
 *
 * ── What it never does ───────────────────────────────────────────────────
 *
 *  - Change anything already here. A site at the same street, suburb and
 *    postcode is skipped; a client of the same name gets the new sites and
 *    keeps every field it had.
 *  - Trust the page. Every client is checked again with `checkImportClient`,
 *    the rules the review screen applied, and one that fails comes back
 *    `failed` with the sentence the page shows — the rest of its batch still
 *    lands.
 *
 * ── Undo ─────────────────────────────────────────────────────────────────
 *
 * Every client and site an import makes carries its id, and undo walks those
 * and nothing else: sites added to an existing client go, and the client
 * stays. Anything worked on since stays too (`siteWorkedOn`,
 * `clientWorkedOn`) — a site with a job, a report or a repeating series would
 * leave those pointing at nothing, and a note or contact someone has added is
 * their work, not the import's. It runs in steps (`undoStep`), because two
 * thousand sites with a note each is more than one transaction should hold.
 */

const DAY = 24 * 60 * 60 * 1000

/** Sites or clients per undo step: each site can mean a note to purge, with
 * its body in the prosemirror-sync component. */
const UNDO_BATCH = 50

/** Recent imports, for the page's "Recent imports" and their Undo. */
const RECENT_IMPORTS = 10

// ------------------------------------------------------------------ start

/** Opens an import, which every batch after it adds to. */
export const start = mutation({
  args: {
    businessId: v.id('businesses'),
    fileName: v.string(),
    source: v.optional(v.string()),
  },
  returns: v.id('clientImports'),
  handler: async (ctx, { businessId, fileName, source }) => {
    const env = await requireWriteActor(ctx, businessId)
    requireCapability(env, 'clients.manage')

    // A name for the list of recent imports, nothing more; a phone's share
    // sheet can hand over a file called nothing at all.
    const name = fileName.trim().slice(0, 200).trim() || 'Spreadsheet'
    const app = source?.trim().slice(0, 40)

    const importId = await ctx.db.insert('clientImports', {
      businessId,
      createdByMembershipId: env.actor.real._id,
      fileName: name,
      ...(app ? { source: app } : {}),
      createdAt: Date.now(),
      clients: 0,
      sites: 0,
      notes: 0,
      skipped: 0,
      failed: 0,
    })
    await recordAudit(ctx, forSelf(env.actor.real._id), {
      businessId,
      action: 'clients.import',
      entityType: 'clientImports',
      entityId: importId,
      meta: { fileName: name, source: app || undefined },
    })
    return importId
  },
})

// --------------------------------------------------------------- addBatch

/**
 * Writes one batch of an import, and says what happened to each client in
 * it, in the order sent. Only the person who opened the import adds to it:
 * it is their Undo that takes it back.
 *
 * The totals on the import row are what it made: `clients` the new clients
 * (not the existing ones that gained a site), `sites` and `notes` what was
 * written, `skipped` the SITES already here, `failed` the clients refused.
 */
export const addBatch = mutation({
  args: {
    businessId: v.id('businesses'),
    importId: v.id('clientImports'),
    clients: v.array(importClientValidator),
  },
  returns: v.array(importResultValidator),
  handler: async (ctx, { businessId, importId, clients }) => {
    const env = await requireWriteActor(ctx, businessId)
    requireCapability(env, 'clients.manage')

    // The page sends `IMPORT_BATCH_SIZE`; the sites cap is what one client
    // with a whole file's worth of sites could reach, and no more — past it
    // this is not a batch any page made.
    const siteCount = clients.reduce((n, c) => n + c.sites.length, 0)
    if (clients.length > IMPORT_BATCH_SIZE || siteCount > MAX_IMPORT_ROWS) {
      throw new ConvexError('BATCH_TOO_LARGE')
    }

    const run = await ctx.db.get(importId)
    if (!run || run.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    if (run.createdByMembershipId !== env.actor.real._id) {
      throw new ConvexError('NO_ACCESS')
    }
    // Undone mid-import (from another tab, or by the owner): what is still
    // to come would land after the undo, with nothing left to take it back.
    if (run.undoneAt !== undefined) throw new ConvexError('IMPORT_UNDONE')

    const known = knownSites(ctx, businessId)
    const results: Array<ImportResult> = []
    for (const input of clients) {
      results.push(await importClient(ctx, run, input, known))
    }

    await ctx.db.patch(importId, {
      clients:
        run.clients + results.filter((r) => r.status === 'created').length,
      sites: run.sites + sum(results, (r) => r.sitesCreated),
      notes: run.notes + sum(results, (r) => r.notesCreated),
      skipped: run.skipped + sum(results, (r) => r.sitesSkipped),
      failed: run.failed + results.filter((r) => r.status === 'failed').length,
    })
    return results
  },
})

function sum<T>(rows: Array<T>, of: (row: T) => number): number {
  return rows.reduce((total, row) => total + of(row), 0)
}

async function importClient(
  ctx: MutationCtx,
  run: Doc<'clientImports'>,
  input: ImportClient,
  known: KnownSites,
): Promise<ImportResult> {
  const nothing = {
    key: input.key,
    sitesCreated: 0,
    sitesSkipped: 0,
    notesCreated: 0,
  }
  const check = checkImportClient(input)
  if (!check.ok) return { ...nothing, status: 'failed', reason: check.reason }
  const client = check.client

  const existing = await existingClient(ctx, run.businessId, client)

  const fresh: Array<ImportSite> = []
  for (const site of client.sites) {
    if (await known.claim(site)) fresh.push(site)
  }
  if (fresh.length === 0) {
    return { ...nothing, status: 'skipped', sitesSkipped: client.sites.length }
  }

  // One timestamp for the client, its sites and their notes. Undo relies on
  // it: a note on an imported site created at the site's own `createdAt`, by
  // the importer, is the import's — anything else is someone's work.
  const now = Date.now()
  const clientId = existing
    ? existing._id
    : await insertClient(ctx, run, client, now)

  let notesCreated = 0
  for (const site of fresh) {
    const propertyId = await ctx.db.insert('properties', {
      businessId: run.businessId,
      clientId,
      addressLine: site.addressLine,
      suburb: site.suburb,
      state: site.state,
      postcode: site.postcode,
      ...(site.siteContactName !== undefined && {
        siteContactName: site.siteContactName,
      }),
      ...(site.siteContactPhone !== undefined && {
        siteContactPhone: site.siteContactPhone,
      }),
      // No `addressCheck`: that records how a person entered an address in
      // a form, and nobody did — the offline check on the page only warns.
      createdAt: now,
      importId: run._id,
    })
    if (site.note) {
      await pinSiteNote(ctx, run, { propertyId, clientId }, site, now)
      notesCreated += 1
    }
  }

  return {
    key: input.key,
    status: existing ? 'added' : 'created',
    clientId,
    sitesCreated: fresh.length,
    sitesSkipped: client.sites.length - fresh.length,
    notesCreated,
  }
}

/**
 * The client the page says this one already is — checked, not taken on its
 * word: an id from another business, a client archived since, or one renamed
 * since the file was read is none of those, and the row becomes a new client.
 */
async function existingClient(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  client: ImportClient,
): Promise<Doc<'clients'> | null> {
  if (!client.existingClientId) return null
  const row = await ctx.db.get(client.existingClientId)
  if (
    !row ||
    row.businessId !== businessId ||
    row.archivedAt !== undefined ||
    nameKey(row.name) !== nameKey(client.name)
  ) {
    return null
  }
  return row
}

type KnownSites = ReturnType<typeof knownSites>

/**
 * "Is this site already here?", asked of one postcode's sites at a time and
 * remembered for the batch. A site this batch writes counts as here from then
 * on, so the same address twice — in one client or across two — is written
 * once.
 */
function knownSites(ctx: MutationCtx, businessId: Id<'businesses'>) {
  const byPostcode = new Map<string, Set<string>>()
  return {
    /** True when the site is new, and claimed: the next one like it is not. */
    async claim(site: ImportSite): Promise<boolean> {
      let keys = byPostcode.get(site.postcode)
      if (!keys) {
        // Every site in one postcode, which is what the index is for: a
        // business has hundreds there at the very most, and stopping short
        // would let a duplicate through.
        const rows = await ctx.db
          .query('properties')
          .withIndex('by_business_and_postcode', (q) =>
            q.eq('businessId', businessId).eq('postcode', site.postcode),
          )
          .collect()
        keys = new Set(rows.map(siteKey))
        byPostcode.set(site.postcode, keys)
      }
      const key = siteKey(site)
      if (keys.has(key)) return false
      keys.add(key)
      return true
    },
  }
}

async function insertClient(
  ctx: MutationCtx,
  run: Doc<'clientImports'>,
  client: ImportClient,
  now: number,
): Promise<Id<'clients'>> {
  const clientId = await ctx.db.insert('clients', {
    businessId: run.businessId,
    kind: client.kind,
    name: client.name,
    ...(client.phone !== undefined && { phone: client.phone }),
    ...(client.email !== undefined && { email: client.email }),
    ...(client.abn !== undefined && { abn: client.abn }),
    createdAt: now,
    updatedAt: now,
    importId: run._id,
  })
  // As `properties.create` makes one: a business's contact person is its
  // primary contact, not a second, competing field. `checkImportClient` has
  // already dropped a person's.
  if (client.contactPerson) {
    await ctx.db.insert('clientContacts', {
      businessId: run.businessId,
      clientId,
      name: client.contactPerson,
      isPrimary: true,
      createdAt: now,
    })
  }
  return clientId
}

/**
 * A site's notes column as a pinned note on that site — shared, like every
 * note on a site, because the gate code is for whoever goes there. Written
 * the way the notes migration folded the old free-text field in
 * (`migrations/notesV2.ts`): the address as its title, the text beneath.
 * Authored by the importer, who brought it in.
 */
async function pinSiteNote(
  ctx: MutationCtx,
  run: Doc<'clientImports'>,
  links: { propertyId: Id<'properties'>; clientId: Id<'clients'> },
  site: ImportSite,
  /** The site's own `createdAt`, which is how undo knows this note. */
  now: number,
) {
  // A spreadsheet's line breaks arrive as \r\n, which would otherwise end up
  // inside the paragraphs.
  const text = (site.note ?? '').replace(/\r\n?/g, '\n')
  const doc = docFromPlainText(`${site.addressLine}\n${text}`)
  const derived = deriveNoteFields(doc)
  const noteId = await ctx.db.insert('notes', {
    businessId: run.businessId,
    authorMembershipId: run.createdByMembershipId,
    lastEditedByMembershipId: run.createdByMembershipId,
    ...links,
    title: derived.title,
    preview: derived.preview,
    plainText: derived.plainText,
    pinnedAt: now,
    createdAt: now,
    updatedAt: now,
  })
  await prosemirrorSync.create(ctx, noteId, doc)
}

// ------------------------------------------------------------------- undo

/** The importer, or the owner. See the top of this file. */
function mayUndo(env: ActorEnvelope, run: Doc<'clientImports'>): boolean {
  return (
    run.createdByMembershipId === env.actor.real._id ||
    env.caps['business.manage']
  )
}

/**
 * Takes an import back. Marked undone here — which stops any batch still on
 * its way — and done in steps by `undoStep`, which the page watches through
 * `list`.
 */
export const undo = mutation({
  args: { businessId: v.id('businesses'), importId: v.id('clientImports') },
  returns: v.null(),
  handler: async (ctx, { businessId, importId }) => {
    const env = await requireWriteActor(ctx, businessId)
    requireCapability(env, 'clients.manage')

    const run = await ctx.db.get(importId)
    if (!run || run.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    if (!mayUndo(env, run)) throw new ConvexError('NO_ACCESS')
    if (run.undoneAt !== undefined) throw new ConvexError('ALREADY_UNDONE')
    // A week is long enough to notice a column matched wrong. Past it the
    // clients are the business's own, however they arrived.
    const now = Date.now()
    if (now > run.createdAt + IMPORT_UNDO_DAYS * DAY) {
      throw new ConvexError('UNDO_EXPIRED')
    }

    await ctx.db.patch(importId, {
      undoneAt: now,
      undoneByMembershipId: env.actor.real._id,
      undoState: 'running',
      undoRemoved: 0,
      undoKept: 0,
    })
    await ctx.scheduler.runAfter(0, internal.clientImports.undoStep, {
      importId,
    })
    await recordAudit(ctx, forSelf(env.actor.real._id), {
      businessId,
      action: 'clients.importUndo',
      entityType: 'clientImports',
      entityId: importId,
      at: now,
    })
    return null
  },
})

/**
 * One step of an undo: a batch of the import's sites, then — once none are
 * left — a batch of its clients, rescheduling itself until both are gone.
 *
 * Every step reads what still carries the import's id rather than
 * remembering where it got to: a site or client it keeps has the id cleared,
 * so the next step moves past it, and one it removes is simply gone.
 */
export const undoStep = internalMutation({
  args: { importId: v.id('clientImports') },
  returns: v.null(),
  handler: async (ctx, { importId }) => {
    const run = await ctx.db.get(importId)
    if (!run || run.undoState !== 'running') return null

    let removed = 0
    let kept = 0

    const sites = await ctx.db
      .query('properties')
      .withIndex('by_import', (q) => q.eq('importId', importId))
      .take(UNDO_BATCH)

    if (sites.length > 0) {
      for (const site of sites) {
        const check = await siteWorkedOn(ctx, run, site)
        if (check.worked) {
          await ctx.db.patch(site._id, { importId: undefined })
          kept += 1
        } else {
          for (const note of check.notes) await purgeNote(ctx, note)
          await ctx.db.delete(site._id)
          removed += 1
        }
      }
    } else {
      // Sites first, always: a client can only go once it has none left.
      const clients = await ctx.db
        .query('clients')
        .withIndex('by_import', (q) => q.eq('importId', importId))
        .take(UNDO_BATCH)

      if (clients.length === 0) {
        await ctx.db.patch(importId, { undoState: 'done' })
        return null
      }
      for (const client of clients) {
        const check = await clientWorkedOn(ctx, client)
        if (check.worked) {
          await ctx.db.patch(client._id, { importId: undefined })
          kept += 1
        } else {
          for (const contact of check.contacts) {
            await ctx.db.delete(contact._id)
          }
          await ctx.db.delete(client._id)
          removed += 1
        }
      }
    }

    await ctx.db.patch(importId, {
      undoRemoved: (run.undoRemoved ?? 0) + removed,
      undoKept: (run.undoKept ?? 0) + kept,
    })
    await ctx.scheduler.runAfter(0, internal.clientImports.undoStep, {
      importId,
    })
    return null
  },
})

/**
 * Has anyone worked on this site since it was imported? Each of these points
 * at it, and would point at nothing if it went:
 *
 *  - a job, whatever its status — a cancelled one is still history;
 *  - a report, a draft or one in Recently Deleted included, which can be
 *    restored;
 *  - a repeating series, even one with no visit booked yet;
 *  - a note that is not the import's own: a gate code the office took down
 *    over the phone is someone's work, and the import has no right to it.
 *
 * Changing the site's own fields does not count — the import made it, and
 * undo is for taking back a list that came in wrong.
 *
 * `notes` is the import's own notes on it, to purge with it.
 */
async function siteWorkedOn(
  ctx: MutationCtx,
  run: Doc<'clientImports'>,
  site: Doc<'properties'>,
): Promise<{ worked: boolean; notes: Array<Doc<'notes'>> }> {
  const worked = { worked: true, notes: [] }

  const series = await ctx.db
    .query('recurrences')
    .withIndex('by_property', (q) => q.eq('propertyId', site._id))
    .first()
  if (series) return worked

  const job = await ctx.db
    .query('jobs')
    .withIndex('by_property', (q) => q.eq('propertyId', site._id))
    .first()
  if (job) return worked

  const report = await ctx.db
    .query('reports')
    .withIndex('by_property', (q) => q.eq('propertyId', site._id))
    .first()
  if (report) return worked

  const notes: Array<Doc<'notes'>> = []
  const onSite = ctx.db
    .query('notes')
    .withIndex('by_property', (q) => q.eq('propertyId', site._id))
  for await (const note of onSite) {
    // The import's own note: pinned by the importer in the same write as the
    // site (`importClient`). Edited since or not, it is still the one the
    // file brought in.
    const own =
      note.authorMembershipId === run.createdByMembershipId &&
      note.createdAt === site.createdAt &&
      note.jobId === undefined
    if (!own) return worked
    notes.push(note)
  }
  return { worked: false, notes }
}

/**
 * Has anyone worked on this client since it was imported? Once its sites are
 * dealt with, what can still point at it is:
 *
 *  - a site: one kept because it was worked on, or one added since;
 *  - a note: the import only writes notes on sites, and those went with
 *    their site, so any note still on the client is someone's;
 *  - a contact other than the primary one the import made alongside it.
 *
 * `contacts` is the import's own contact, to delete with it.
 */
async function clientWorkedOn(
  ctx: MutationCtx,
  client: Doc<'clients'>,
): Promise<{ worked: boolean; contacts: Array<Doc<'clientContacts'>> }> {
  const worked = { worked: true, contacts: [] }

  const site = await ctx.db
    .query('properties')
    .withIndex('by_client', (q) => q.eq('clientId', client._id))
    .first()
  if (site) return worked

  const note = await ctx.db
    .query('notes')
    .withIndex('by_client', (q) => q.eq('clientId', client._id))
    .first()
  if (note) return worked

  const contacts: Array<Doc<'clientContacts'>> = []
  const rows = ctx.db
    .query('clientContacts')
    .withIndex('by_client', (q) => q.eq('clientId', client._id))
  for await (const contact of rows) {
    // Made in the same write as the client (`insertClient`); anyone adding
    // one later writes a later time.
    if (contact.createdAt !== client.createdAt) return worked
    contacts.push(contact)
  }
  return { worked: false, contacts }
}

// ------------------------------------------------------------------- list

const importView = v.object({
  _id: v.id('clientImports'),
  fileName: v.string(),
  source: v.optional(v.string()),
  createdAt: v.number(),
  /** What it made — see `addBatch` for what each total counts. */
  clients: v.number(),
  sites: v.number(),
  notes: v.number(),
  skipped: v.number(),
  failed: v.number(),
  undoneAt: v.optional(v.number()),
  undoState: v.optional(v.union(v.literal('running'), v.literal('done'))),
  /** Clients and sites together. */
  undoRemoved: v.optional(v.number()),
  undoKept: v.optional(v.number()),
  /** Who ran it; '' if their name cannot be read. */
  byName: v.string(),
  /**
   * Whether this caller is someone who may undo it — the who, and only the
   * who. The week is the page's to compare against its own clock: a query
   * that read the time would be cached past the moment it ran out.
   */
  canUndo: v.boolean(),
})

/** The business's last few imports, newest first — empty for anyone who
 * cannot import, rather than a refusal on the page. */
export const list = query({
  args: { businessId: v.id('businesses') },
  returns: v.array(importView),
  handler: async (ctx, { businessId }) => {
    const env = await requireActor(ctx, businessId)
    if (!env.caps['clients.manage']) return []

    const rows = await ctx.db
      .query('clientImports')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .order('desc')
      .take(RECENT_IMPORTS)

    // Mostly one or two people run every import; ask for each name once.
    const names = new Map<Id<'memberships'>, Promise<string>>()
    const nameOf = (membershipId: Id<'memberships'>) => {
      let name = names.get(membershipId)
      if (!name) {
        name = ctx.db
          .get(membershipId)
          .then((member) => (member ? memberName(ctx, member.userId) : ''))
        names.set(membershipId, name)
      }
      return name
    }

    return Promise.all(
      rows.map(async (row) => ({
        _id: row._id,
        fileName: row.fileName,
        source: row.source,
        createdAt: row.createdAt,
        clients: row.clients,
        sites: row.sites,
        notes: row.notes,
        skipped: row.skipped,
        failed: row.failed,
        undoneAt: row.undoneAt,
        undoState: row.undoState,
        undoRemoved: row.undoRemoved,
        undoKept: row.undoKept,
        byName: await nameOf(row.createdByMembershipId),
        canUndo: mayUndo(env, row),
      })),
    )
  },
})
