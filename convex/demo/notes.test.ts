import { getSchema } from '@tiptap/core'
import { beforeAll, describe, expect, test } from 'vitest'
import { api, components } from '../_generated/api'
import { noteExtensions } from '../../src/components/notes/noteExtensions'
import { noteKind } from '../lib/noteAccess'
import { deriveNoteFields, walk } from '../lib/richText'
import { runDemoSteps } from '../../test/demoFixture'
import { NAMED_VISITS, at } from './shared'
import type { DemoRun } from '../../test/demoFixture'
import type { TestActor, TestApp } from '../../test/harness'
import type { Doc, Id } from '../_generated/dataModel'
import type { PmNode } from '../lib/richText'
import type { MemberKey } from './shared'

/**
 * The demo's notes step. Two kinds of check: the notes are ones the app
 * could have written (a body the editor opens, the row derived from that
 * body, mention rows in step with the pills, links as resolveLinks stores
 * them, authors who could see what they wrote on), and they are the set the
 * brief asks for, which is checked through the public queries as each
 * person would see it.
 */

const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE

/** What the fixture and demo/team.ts call everyone, so what a pill says. */
const LABELS: Record<MemberKey, string> = {
  owner: 'Terence',
  contractor: 'Kevin',
  sub: 'Priya',
  dana: 'Dana Brooks',
  former: 'Riley Cooper',
}

const NODES = new Set([
  'doc',
  'heading',
  'paragraph',
  'text',
  'hardBreak',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'mention',
])
const MARKS = new Set(['bold', 'italic', 'underline', 'strike', 'code', 'link'])

type NoteRow = Doc<'notes'> & {
  doc: PmNode
  snapshotVersion: number
  latestVersion: number | null
  steps: number
  mentions: Array<Doc<'noteMentions'>>
}

async function rowsOf(t: TestApp, businessId: Id<'businesses'>) {
  const read = await t.run(async (ctx) => {
    const notes: Array<NoteRow> = []
    const raw = await ctx.db
      .query('notes')
      .withIndex('by_business_updated', (q) => q.eq('businessId', businessId))
      .collect()
    for (const note of raw) {
      const snapshot = await ctx.runQuery(
        components.prosemirrorSync.lib.getSnapshot,
        { id: note._id },
      )
      if (snapshot.content === null) throw new Error(`${note.title}: no body`)
      const steps = await ctx.runQuery(
        components.prosemirrorSync.lib.getSteps,
        { id: note._id, version: 0 },
      )
      notes.push({
        ...note,
        doc: JSON.parse(snapshot.content) as PmNode,
        snapshotVersion: snapshot.version,
        latestVersion: await ctx.runQuery(
          components.prosemirrorSync.lib.latestVersion,
          { id: note._id },
        ),
        steps: steps.steps.length,
        mentions: await ctx.db
          .query('noteMentions')
          .withIndex('by_note', (q) => q.eq('noteId', note._id))
          .collect(),
      })
    }
    const jobs: Array<Doc<'jobs'>> = []
    const properties: Array<Doc<'properties'>> = []
    const clients: Array<Doc<'clients'>> = []
    for (const note of notes) {
      const job = note.jobId ? await ctx.db.get(note.jobId) : null
      if (job) jobs.push(job)
      const property = note.propertyId
        ? await ctx.db.get(note.propertyId)
        : null
      if (property) properties.push(property)
      const client = note.clientId ? await ctx.db.get(note.clientId) : null
      if (client) clients.push(client)
    }
    const members = await ctx.db
      .query('memberships')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect()
    return { notes, jobs, properties, clients, members }
  })
  return {
    notes: read.notes,
    members: read.members,
    jobs: new Map(read.jobs.map((job) => [job._id, job])),
    properties: new Map(read.properties.map((p) => [p._id, p])),
    clients: new Map(read.clients.map((c) => [c._id, c])),
  }
}

type Rows = Awaited<ReturnType<typeof rowsOf>>

/** Every page of a folder, as the paginated list hands it to someone. */
async function listAll(
  actor: TestActor,
  businessId: Id<'businesses'>,
  filter: 'all' | 'trash',
) {
  const out: Array<{ _id: Id<'notes'>; canEdit: boolean }> = []
  let cursor: string | null = null
  for (;;) {
    const page: {
      page: Array<{ _id: Id<'notes'>; canEdit: boolean }>
      isDone: boolean
      continueCursor: string
    } = await actor.as.query(api.notes.list, {
      businessId,
      filter,
      paginationOpts: { numItems: 30, cursor },
    })
    out.push(...page.page)
    if (page.isDone) return out
    cursor = page.continueCursor
  }
}

function mentionIds(doc: PmNode): Array<string> {
  return deriveNoteFields(doc).mentionIds
}

describe('the demo notes', () => {
  let run: DemoRun
  let rows: Rows
  let seededBy: number
  const member = (key: MemberKey) => run.base.members[key]
  const byTitle = (title: string) => {
    const found = rows.notes.filter((n) => n.title === title)
    expect(found, title).toHaveLength(1)
    return found[0]
  }
  const jobId = (key: string) => {
    const job = run.jobs.find((j) => j.key === key)
    if (!job) throw new Error(`no ${key} in the manifest`)
    return job.id
  }

  beforeAll(async () => {
    run = await runDemoSteps('notes')
    seededBy = Date.now()
    rows = await rowsOf(run.t, run.base.businessId)
  }, 60_000)

  test('it made the notes it says it made', () => {
    expect(rows.notes).toHaveLength(run.notes)
    expect(run.notes).toBeGreaterThanOrEqual(35)
  })

  describe('as the app would have written them', () => {
    test('each has one snapshot, version 1, and no steps', () => {
      for (const note of rows.notes) {
        expect(note.snapshotVersion, note.title).toBe(1)
        expect(note.latestVersion, note.title).toBe(1)
        expect(note.steps, note.title).toBe(0)
      }
    })

    test('the row is derived from the stored body', () => {
      for (const note of rows.notes) {
        const derived = deriveNoteFields(note.doc)
        expect(note.title).toBe(derived.title)
        expect(note.preview).toBe(derived.preview)
        expect(note.plainText).toBe(derived.plainText)
        // Absent, never 0; done only alongside a total.
        expect(note.checklistTotal).toBe(derived.checklistTotal || undefined)
        expect(note.checklistDone).toBe(
          derived.checklistTotal ? derived.checklistDone : undefined,
        )
      }
    })

    test('every body opens in the note editor as it is', () => {
      const schema = getSchema(noteExtensions({ items: () => [] }))
      for (const note of rows.notes) {
        // nodeFromJSON throws on an unknown node or mark and on empty text;
        // check() on content the schema's rules refuse.
        const parsed = schema.nodeFromJSON(note.doc)
        expect(() => parsed.check(), note.title).not.toThrow()

        const blocks = note.doc.content ?? []
        expect(blocks.at(0)?.type, note.title).toBe('heading')
        expect(blocks.at(0)?.attrs, note.title).toEqual({ level: 1 })
        // The trailing-node rule would otherwise edit it on opening.
        expect(blocks.at(-1)?.type, note.title).toBe('paragraph')

        walk(note.doc, (node) => {
          expect(NODES.has(node.type), node.type).toBe(true)
          if (node.type === 'text') expect(node.text).toBeTruthy()
          for (const mark of node.marks ?? []) {
            expect(MARKS.has(mark.type), mark.type).toBe(true)
          }
          if (node.type === 'heading') expect(node.attrs).toEqual({ level: 1 })
        })
      }
    })

    test('every pill is a demo member, labelled and coloured as the roster shows them', () => {
      const keyOf = new Map(
        (Object.keys(LABELS) as Array<MemberKey>).map((k) => [member(k), k]),
      )
      let pills = 0
      for (const note of rows.notes) {
        walk(note.doc, (node) => {
          if (node.type !== 'mention') return
          pills++
          const id = node.attrs?.id as Id<'memberships'>
          const key = keyOf.get(id)
          expect(key, note.title).toBeDefined()
          const m = rows.members.find((row) => row._id === id)
          expect(node.attrs).toEqual({
            id,
            label: key ? LABELS[key] : undefined,
            colour: m?.colour,
            mentionSuggestionChar: '@',
          })
          expect(m?.colour).toMatch(/^#[0-9A-F]{6}$/)
        })
      }
      expect(pills).toBeGreaterThan(15)
    })

    test('mention rows match the pills one to one, less anyone who has left', () => {
      const removed = new Set(
        rows.members.filter((m) => m.status === 'removed').map((m) => m._id),
      )
      let droppedPills = 0
      for (const note of rows.notes) {
        const pills = mentionIds(note.doc) as Array<Id<'memberships'>>
        droppedPills += pills.filter((id) => removed.has(id)).length
        const wanted = pills.filter((id) => !removed.has(id)).sort()
        const have = note.mentions.map((row) => row.membershipId).sort()
        expect(have, note.title).toEqual(wanted)

        for (const row of note.mentions) {
          expect(row.businessId).toBe(run.base.businessId)
          // Whoever saved the version that added it.
          expect(row.mentionedByMembershipId).toBe(
            note.lastEditedByMembershipId,
          )
          expect(row.createdAt).toBeGreaterThanOrEqual(note.createdAt)
          expect(row.createdAt).toBeLessThanOrEqual(note.updatedAt)
          if (row.membershipId === row.mentionedByMembershipId) {
            expect(row.readAt, 'a self-tag is read at once').toBe(row.createdAt)
          } else if (row.readAt !== undefined) {
            expect(row.readAt).toBeGreaterThan(row.createdAt)
            expect(row.readAt).toBeLessThanOrEqual(seededBy)
          }
        }
      }
      // Riley's pill stays in the handover memo; the row does not.
      expect(droppedPills).toBeGreaterThanOrEqual(1)
    })

    test('links are what resolveLinks stores', () => {
      for (const note of rows.notes) {
        if (note.jobId) {
          const job = rows.jobs.get(note.jobId)
          expect(job?.businessId).toBe(run.base.businessId)
          expect(note.propertyId).toBe(job?.propertyId)
        }
        if (note.propertyId) {
          const property = rows.properties.get(note.propertyId)
          expect(property?.businessId).toBe(run.base.businessId)
          expect(note.clientId, note.title).toBe(property?.clientId)
        }
        if (note.clientId) {
          const client = rows.clients.get(note.clientId)
          expect(client?.businessId).toBe(run.base.businessId)
        }
        // Never a job without its site, or a site without its client.
        if (note.jobId) expect(note.propertyId).toBeDefined()
        if (note.propertyId) expect(note.clientId).toBeDefined()
      }
    })

    test('authors could see the jobs they wrote on', () => {
      const facts = new Map(rows.members.map((m) => [m._id, m]))
      for (const note of rows.notes) {
        if (!note.jobId) continue
        const job = rows.jobs.get(note.jobId)
        const author = facts.get(note.authorMembershipId)
        const assignee = job ? facts.get(job.assignedMembershipId) : undefined
        const visible =
          author?.role === 'owner' ||
          assignee?._id === author?._id ||
          (author?.role === 'contractor' &&
            assignee?.parentMembershipId === author._id)
        expect(visible, note.title).toBe(true)
      }
    })

    test('times run in order, nobody wrote outside their time on the team', () => {
      const facts = new Map(rows.members.map((m) => [m._id, m]))
      for (const note of rows.notes) {
        expect(note.createdAt).toBeLessThanOrEqual(note.updatedAt)
        expect(note.updatedAt).toBeLessThanOrEqual(seededBy)
        if (note.jobId) {
          const job = rows.jobs.get(note.jobId)
          expect(note.createdAt).toBeGreaterThanOrEqual(job?.createdAt ?? 0)
        }
        for (const [id, t] of [
          [note.authorMembershipId, note.createdAt],
          [note.lastEditedByMembershipId, note.updatedAt],
        ] as const) {
          const m = facts.get(id)
          expect(m?.createdAt, note.title).toBeLessThanOrEqual(t)
          if (m?.removedAt !== undefined) {
            expect(t).toBeLessThanOrEqual(m.removedAt)
          }
        }
        if (note.pinnedAt !== undefined) {
          expect(note.pinnedAt).toBeGreaterThanOrEqual(note.createdAt)
        }
        if (note.deletedAt !== undefined) {
          expect(note.deletedAt).toBeGreaterThanOrEqual(note.updatedAt)
          // Still inside Recently Deleted's 30 days.
          expect(note.deletedAt).toBeGreaterThan(seededBy - 30 * DAY)
        }
      }
    })

    test('no note is both pinned and deleted', () => {
      for (const note of rows.notes) {
        expect(
          note.pinnedAt !== undefined && note.deletedAt !== undefined,
          note.title,
        ).toBe(false)
      }
    })
  })

  describe('who sees what', () => {
    const ants = 'Coastal brown ants — kitchen and patio'
    const bait = 'Bait stations — 2 of 14 with heavy take'
    const termites = 'Live termites in the garage — quote a barrier'
    const askSub = 'Marcus Roberts — can you take this one?'

    test('one visit note each: the sub sees theirs, the contractor theirs and the sub’s, the owner all', async () => {
      const businessId = run.base.businessId
      const seen = async (actor: TestActor) =>
        new Set((await listAll(actor, businessId, 'all')).map((n) => n._id))
      const [owner, contractor, sub] = [
        await seen(run.owner),
        await seen(run.contractor),
        await seen(run.sub),
      ]
      const [a, b, c] = [byTitle(ants), byTitle(bait), byTitle(termites)]
      expect(a.authorMembershipId).toBe(member('sub'))
      expect(b.authorMembershipId).toBe(member('contractor'))
      expect(c.authorMembershipId).toBe(member('owner'))

      expect([sub.has(a._id), sub.has(b._id), sub.has(c._id)]).toEqual([
        true,
        false,
        false,
      ])
      expect([
        contractor.has(a._id),
        contractor.has(b._id),
        contractor.has(c._id),
      ]).toEqual([true, true, false])
      expect([owner.has(a._id), owner.has(b._id), owner.has(c._id)]).toEqual([
        true,
        true,
        true,
      ])
      // The owner reads every live note.
      expect(owner.size).toBe(
        rows.notes.filter((n) => n.deletedAt === undefined).length,
      )
    })

    test('the subcontractor reads exactly what the rules allow', async () => {
      const businessId = run.base.businessId
      const sub = member('sub')
      // canReadNote for a subcontractor, whose job scope is their own jobs.
      const readable = (n: NoteRow) => {
        if (n.deletedAt !== undefined) return false
        if (noteKind(n) !== 'job' || n.authorMembershipId === sub) return true
        const job = n.jobId ? rows.jobs.get(n.jobId) : undefined
        if (job?.assignedMembershipId === sub) return true
        return n.mentions.some((row) => row.membershipId === sub)
      }
      const expected = rows.notes
        .filter(readable)
        .map((n) => n._id)
        .sort()
      const listed = (await listAll(run.sub, businessId, 'all'))
        .map((n) => n._id)
        .sort()
      expect(listed).toEqual(expected)
      // …and some job notes are not among them.
      expect(listed.length).toBeLessThan(
        rows.notes.filter((n) => n.deletedAt === undefined).length,
      )
      expect(await listAll(run.sub, businessId, 'trash')).toEqual([])
    })

    test('a mention lets the sub into the owner’s job note, and edit it', async () => {
      const note = byTitle(askSub)
      expect(note.jobId).toBe(jobId('lastVisitNext'))
      expect(
        rows.jobs.get(note.jobId as Id<'jobs'>)?.assignedMembershipId,
      ).toBe(member('owner'))
      const row = note.mentions.find((m) => m.membershipId === member('sub'))
      expect(row?.readAt).toBeUndefined()

      const got = await run.sub.as.query(api.notes.get, {
        businessId: run.base.businessId,
        noteId: note._id,
      })
      expect(got?.canEdit).toBe(true)
      expect(
        await run.sub.as.query(api.notes.get, {
          businessId: run.base.businessId,
          noteId: byTitle(termites)._id,
        }),
      ).toBeNull()
      expect(
        await run.sub.as.query(api.notes.unreadMentionCount, {
          businessId: run.base.businessId,
        }),
      ).toBe(1)
    })

    test('Recently Deleted: the contractor sees their own, the owner both', async () => {
      const businessId = run.base.businessId
      const trashed = rows.notes.filter((n) => n.deletedAt !== undefined)
      expect(trashed).toHaveLength(2)
      const mine = trashed.find(
        (n) => n.authorMembershipId === member('contractor'),
      )
      const owners = trashed.find(
        (n) => n.authorMembershipId === member('owner'),
      )
      // Two hours ago, and twenty days ago.
      expect(seededBy - (mine?.deletedAt ?? 0)).toBeGreaterThanOrEqual(
        2 * 60 * MINUTE,
      )
      expect(seededBy - (mine?.deletedAt ?? 0)).toBeLessThan(3 * 60 * MINUTE)
      expect(owners?.deletedAt).toBe(at(run.base, -20, 8, 30))

      const contractorTrash = await listAll(run.contractor, businessId, 'trash')
      expect(contractorTrash.map((n) => n._id)).toEqual([mine?._id])
      expect(contractorTrash.every((n) => !n.canEdit)).toBe(true)
      const ownerTrash = await listAll(run.owner, businessId, 'trash')
      expect(ownerTrash.map((n) => n._id).sort()).toEqual(
        trashed.map((n) => n._id).sort(),
      )
    })
  })

  describe('mentions and the badge', () => {
    test('the contractor has ten or more unread, so the badge says 9+', async () => {
      const contractor = member('contractor')
      const unreadLive = rows.notes.filter(
        (n) =>
          n.deletedAt === undefined &&
          n.mentions.some(
            (m) => m.membershipId === contractor && m.readAt === undefined,
          ),
      )
      expect(unreadLive.length).toBeGreaterThanOrEqual(10)
      expect(
        await run.contractor.as.query(api.notes.unreadMentionCount, {
          businessId: run.base.businessId,
        }),
      ).toBe(10)
    })

    test('the Mentions folder has New and Earlier, and nothing from the trash', async () => {
      const listed = await run.contractor.as.query(api.notes.listMentions, {
        businessId: run.base.businessId,
      })
      const unread = listed.filter((n) => n.unread)
      const read = listed.filter((n) => !n.unread)
      expect(unread.length).toBeGreaterThanOrEqual(10)
      // One opened a day later, and one they tagged themselves in.
      expect(read.length).toBe(2)
      expect(listed.every((n) => n.deletedAt === undefined)).toBe(true)

      const selfTag = rows.notes.flatMap((n) =>
        n.mentions.filter(
          (m) =>
            m.membershipId === member('contractor') &&
            m.mentionedByMembershipId === member('contractor'),
        ),
      )
      expect(selfTag).toHaveLength(1)
      expect(selfTag[0].readAt).toBe(selfTag[0].createdAt)
    })

    test('an unread mention on a trashed note, left out of the count', async () => {
      const onTrash = rows.notes
        .filter((n) => n.deletedAt !== undefined)
        .flatMap((n) => n.mentions.filter((m) => m.readAt === undefined))
      expect(onTrash.length).toBeGreaterThanOrEqual(1)
      // The owner's badge counts live notes only.
      const ownerUnread = rows.notes.flatMap((n) =>
        n.mentions.filter(
          (m) => m.membershipId === member('owner') && m.readAt === undefined,
        ),
      )
      const ownerLive = rows.notes
        .filter((n) => n.deletedAt === undefined)
        .flatMap((n) =>
          n.mentions.filter(
            (m) => m.membershipId === member('owner') && m.readAt === undefined,
          ),
        )
      expect(ownerUnread.length).toBeGreaterThan(ownerLive.length)
      expect(
        await run.owner.as.query(api.notes.unreadMentionCount, {
          businessId: run.base.businessId,
        }),
      ).toBe(ownerLive.length)
    })
  })

  describe('the set the brief asks for', () => {
    const nodesOf = (note: NoteRow) => {
      const types = new Set<string>()
      const marks = new Set<string>()
      walk(note.doc, (node) => {
        types.add(node.type)
        for (const mark of node.marks ?? []) marks.add(mark.type)
      })
      return { types, marks }
    }

    test('checklists at 0 of 3, 2 of 5 with nesting, and 4 of 4', () => {
      const states = rows.notes.map(
        (n) => `${n.checklistDone ?? '-'}/${n.checklistTotal ?? '-'}`,
      )
      expect(states).toContain('0/3')
      expect(states).toContain('2/5')
      expect(states).toContain('4/4')
      const nested = rows.notes.find((n) => n.checklistTotal === 5)
      let depth = 0
      if (nested) {
        walk(nested.doc, (node) => {
          if (
            node.type === 'taskItem' &&
            node.content?.[1]?.type === 'taskList'
          ) {
            depth++
          }
        })
      }
      expect(depth).toBeGreaterThanOrEqual(1)
    })

    test('titles: empty, title-only, very long, and a note long enough to cut', () => {
      const empty = rows.notes.filter((n) => n.title === '')
      expect(empty.some((n) => n.preview !== '')).toBe(true)
      expect(empty.some((n) => n.preview === '')).toBe(true)
      expect(rows.notes.some((n) => n.title !== '' && n.preview === '')).toBe(
        true,
      )
      expect(rows.notes.some((n) => n.title.length >= 150)).toBe(true)
      const long = rows.notes.find(
        (n) => n.plainText.split(/\s+/).length >= 1000,
      )
      expect(long?.preview).toHaveLength(140)
      expect(long?.mentions.length).toBeGreaterThan(0)
    })

    test('one note written by the owner and last edited by the sub', () => {
      const edited = rows.notes.filter(
        (n) => n.authorMembershipId !== n.lastEditedByMembershipId,
      )
      expect(edited).toHaveLength(1)
      expect(edited[0].authorMembershipId).toBe(member('owner'))
      expect(edited[0].lastEditedByMembershipId).toBe(member('sub'))
      expect(edited[0].propertyId).toBeDefined()
    })

    test('a pinned team memo in every format the editor has', () => {
      const memo = rows.notes.find(
        (n) => n.pinnedAt !== undefined && noteKind(n) === 'team',
      )
      if (!memo) throw new Error('no pinned team memo')
      const { types, marks } = nodesOf(memo)
      for (const type of ['bulletList', 'orderedList', 'hardBreak']) {
        expect(types.has(type), type).toBe(true)
      }
      for (const mark of MARKS) expect(marks.has(mark), mark).toBe(true)
    })

    test('standing notes: the sub’s pinned site note, and a client-only note on every site', async () => {
      const site = rows.notes.find(
        (n) =>
          n.propertyId === run.properties.ppm2 &&
          n.jobId === undefined &&
          n.authorMembershipId === member('sub'),
      )
      expect(site?.pinnedAt).toBeDefined()
      // Only the sub and the owner get the delete control.
      const asContractor = await run.contractor.as.query(api.notes.get, {
        businessId: run.base.businessId,
        noteId: site?._id as Id<'notes'>,
      })
      expect(asContractor).toMatchObject({ canEdit: true, canDelete: false })

      const accounts = byTitle('Accounts: 30-day terms, PO number required')
      expect(noteKind(accounts)).toBe('client')
      expect(accounts.clientId).toBe(run.clients.ppm)
      for (const key of ['ppm1', 'ppm7']) {
        const forSite = await run.sub.as.query(api.notes.listForProperty, {
          businessId: run.base.businessId,
          propertyId: run.properties[key],
        })
        expect(forSite.site.map((n) => n._id)).toContain(accounts._id)
      }
    })

    test('notes on the cancelled job, the visit due today, six weeks out, the archived client, and by the one who left', () => {
      const onJob = (id: Id<'jobs'>) => rows.notes.some((n) => n.jobId === id)
      expect(onJob(jobId('cancelledToday'))).toBe(true)
      expect(onJob(jobId(NAMED_VISITS.dueToday))).toBe(true)
      expect(onJob(jobId('sixWeeksAhead'))).toBe(true)
      expect(rows.jobs.get(jobId(NAMED_VISITS.dueToday))?.status).toBe(
        'recurring',
      )
      expect(
        rows.notes.some(
          (n) => n.propertyId === run.properties.colinHome && !n.jobId,
        ),
      ).toBe(true)
      const former = rows.notes.filter(
        (n) => n.authorMembershipId === member('former'),
      )
      expect(former).toHaveLength(1)
      expect(noteKind(former[0])).toBe('site')
      expect(former[0].deletedAt).toBeUndefined()
    })

    test('last edits spread from today back to the business’s first week', () => {
      const daysAgo = rows.notes.map((n) =>
        Math.floor((at(run.base, 1, 0) - n.updatedAt) / DAY),
      )
      for (const day of [0, 1, 3]) expect(daysAgo, `${day}`).toContain(day)
      expect(daysAgo.some((d) => d >= 8 && d < 30)).toBe(true)
      expect(daysAgo.some((d) => d >= 55 && d < 70)).toBe(true)
      expect(Math.max(...daysAgo)).toBeGreaterThanOrEqual(170)
    })

    test('search words are spread across notes', () => {
      for (const word of ['Rottweiler', '4471', 'Fipronil', 'Nguyễn', '李']) {
        expect(
          rows.notes.filter((n) => n.plainText.includes(word)).length,
          word,
        ).toBeGreaterThanOrEqual(1)
      }
      // A word only Recently Deleted's search finds.
      const trashOnly = rows.notes.filter((n) =>
        n.plainText.includes('Brodifacoum'),
      )
      expect(trashOnly).toHaveLength(1)
      expect(trashOnly[0].deletedAt).toBeDefined()
    })
  })
})
