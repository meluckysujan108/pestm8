import { ConvexError, v } from 'convex/values'
import { internalMutation } from '../_generated/server'
import { authComponent } from '../auth'
import { writeEnvelopeForMember } from '../lib/actor'
import { isInScope } from '../lib/capabilities'
import { canWriteNote } from '../lib/noteAccess'
import { deriveNoteFields, heading, paragraph } from '../lib/richText'
import { applyDerived, prosemirrorSync } from '../notesSync'
import {
  NAMED_VISITS,
  at,
  clientMapV,
  demoBaseV,
  manifestJobV,
  propertyMapV,
} from './shared'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import type { Role } from '../lib/capabilities'
import type { NoteViewer } from '../lib/noteAccess'
import type { PmNode } from '../lib/richText'
import type { DemoBase, ManifestJob, MemberKey } from './shared'

/**
 * The demo's Field Notes: job visit notes, standing site and client notes,
 * team memos, checklists, @mentions read and unread, and a Recently Deleted.
 *
 * Each note is written the way the app writes one. notes.create inserts the
 * row and its first body in the prosemirror-sync component together; the
 * editor's snapshot then runs applyDerived, which re-derives the row from
 * the body, stamps who saved it and syncs the mention rows. The seed does
 * exactly that, with the finished body as the first snapshot (one version,
 * no steps, which the editor opens the same as an edited note), then dates
 * each save when it happened. Pins and deletions are togglePin's and
 * softDelete's patches, which never touch `updatedAt`.
 *
 * Bodies use only what the note editor's schema has
 * (src/components/notes/noteExtensions.ts): a level-one heading first, a
 * paragraph last, and no empty text. Anything else and the editor opens
 * blank over a full document, or writes a fix-up step the moment someone
 * opens the note, which re-dates it to today and re-credits it to them.
 *
 * Nobody here is signed in. Each note is checked against the rules the
 * public path would have applied to its author: a job note only on a job
 * its author can see, a second editor only where they could have edited,
 * and nobody writing before they joined or after they left.
 */

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** The client's roster labels a person by name, or by role when they have
 * none (src/lib/assignees.ts personLabel); a mention pill carries that. */
const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  contractor: 'Contractor',
  subcontractor: 'Subcontractor',
}

export const seed = internalMutation({
  args: {
    base: demoBaseV,
    properties: propertyMapV,
    clients: clientMapV,
    jobs: v.array(manifestJobV),
  },
  returns: v.object({ notes: v.number() }),
  handler: async (ctx, { base, properties, clients, jobs }) => {
    const now = Date.now()
    const people = await rosterOf(ctx, base)
    const pill = pillOf(people)
    const lookup: Lookup = {
      base,
      properties,
      clients,
      jobs: new Map(
        jobs.flatMap((job) => (job.key ? [[job.key, job] as const] : [])),
      ),
    }

    const viewers = new Map<Id<'memberships'>, Promise<NoteViewer>>()
    const viewerOf = (who: MemberKey) => {
      const id = people[who].membership._id
      const known = viewers.get(id)
      if (known) return known
      const pending = noteViewerFor(ctx, id)
      viewers.set(id, pending)
      return pending
    }

    const planned: Array<Planned> = []
    for (const spec of noteSpecs(base, now)) {
      planned.push(await plan(ctx, lookup, people, viewerOf, pill, spec, now))
    }

    // notes.create, in the order they were written: `_creationTime` breaks
    // ties in every notes index, so the order of inserts is part of the data.
    const ids = new Map<Planned, Id<'notes'>>()
    for (const note of [...planned].sort((a, b) => a.createdAt - b.createdAt)) {
      const derived = deriveNoteFields(note.doc)
      const author = people[note.spec.by].membership._id
      const noteId = await ctx.db.insert('notes', {
        businessId: base.businessId,
        authorMembershipId: author,
        lastEditedByMembershipId: author,
        ...note.links,
        title: derived.title,
        preview: derived.preview,
        plainText: derived.plainText,
        checklistTotal: derived.checklistTotal || undefined,
        checklistDone: derived.checklistTotal
          ? derived.checklistDone
          : undefined,
        createdAt: note.createdAt,
        updatedAt: note.createdAt,
        ...(note.spec.personal && { visibility: 'private' as const }),
      })
      await prosemirrorSync.create(ctx, noteId, note.doc)
      ids.set(note, noteId)
    }

    // The last save of each, in the order they were saved. Mention rows are
    // made here, and the Mentions folder lists them newest-inserted first.
    for (const note of [...planned].sort((a, b) => a.updatedAt - b.updatedAt)) {
      const noteId = ids.get(note)
      const row = noteId ? await ctx.db.get(noteId) : null
      if (!noteId || !row) throw new Error('demo: a note vanished mid-seed')
      const editorKey = note.spec.editedBy ?? note.spec.by
      const editor = people[editorKey].membership
      if (
        editorKey !== note.spec.by &&
        !(await canWriteNote(ctx, await viewerOf(editorKey), row))
      ) {
        throw new Error(
          `demo: ${editorKey} could not have edited ${note.spec.name}`,
        )
      }
      await applyDerived(ctx, row, editor, note.doc)
      // applyDerived stamps the save with the clock; this one was earlier.
      await ctx.db.patch(noteId, { updatedAt: note.updatedAt })

      const mentions = await ctx.db
        .query('noteMentions')
        .withIndex('by_note', (q) => q.eq('noteId', noteId))
        .take(20)
      for (const mention of mentions) {
        const who = keyOf(people, mention.membershipId)
        // Tagging yourself is read on the spot (notesSync syncMentions).
        const readAt =
          mention.membershipId === editor._id
            ? note.updatedAt
            : note.spec.readAt?.[who]
        if (
          readAt !== undefined &&
          !(readAt >= note.updatedAt && readAt <= now)
        ) {
          throw new Error(`demo: ${who} read ${note.spec.name} out of order`)
        }
        await ctx.db.patch(mention._id, {
          createdAt: note.updatedAt,
          ...(readAt !== undefined ? { readAt } : {}),
        })
      }
    }

    // togglePin and softDelete: their own stamp, `updatedAt` untouched, and
    // a deletion clears the pin, so no row is ever both.
    for (const note of planned) {
      const noteId = ids.get(note)
      if (!noteId) throw new Error('demo: a note vanished mid-seed')
      if (note.spec.pinnedAt !== undefined) {
        await ctx.db.patch(noteId, { pinnedAt: note.spec.pinnedAt })
      }
      if (note.spec.deletedAt !== undefined) {
        await ctx.db.patch(noteId, {
          deletedAt: note.spec.deletedAt,
          pinnedAt: undefined,
        })
      }
    }

    return { notes: planned.length }
  },
})

// ─────────────────────────────────────────────────────────────── people

type Person = {
  key: MemberKey
  membership: Doc<'memberships'>
  /** What the roster shows, so what a pill typed in the editor carries. */
  label: string
}
type People = Record<MemberKey, Person>

async function rosterOf(ctx: MutationCtx, base: DemoBase): Promise<People> {
  const person = async (key: MemberKey): Promise<Person> => {
    const membership = await ctx.db.get(base.members[key])
    if (!membership || membership.businessId !== base.businessId) {
      throw new ConvexError(`demo: the ${key} is not in the demo business`)
    }
    const user = await authComponent.getAnyUserById(ctx, membership.userId)
    return {
      key,
      membership,
      label: user?.name || ROLE_LABEL[membership.role],
    }
  }
  return {
    owner: await person('owner'),
    contractor: await person('contractor'),
    sub: await person('sub'),
    dana: await person('dana'),
    former: await person('former'),
  }
}

function keyOf(people: People, id: Id<'memberships'>): MemberKey {
  const found = Object.values(people).find(
    (person) => person.membership._id === id,
  )
  if (!found) throw new Error('demo: a mention of someone outside the demo')
  return found.key
}

/** What noteViewer resolves for a signed-in member, standing in their own
 * account: the rows their job notes may link to are `ownRows`. */
async function noteViewerFor(
  ctx: MutationCtx,
  membershipId: Id<'memberships'>,
): Promise<NoteViewer> {
  const env = await writeEnvelopeForMember(ctx, membershipId)
  return {
    real: env.actor.real,
    scope: env.readScope,
    readRows: env.scope,
    ownRows: env.realScope,
    pickerRows: env.listScope,
    // Only lists other people's personal notes; never decides access, which
    // is all this viewer is used for.
    godView: false,
  }
}

function joinedBy(person: Person, t: number): boolean {
  const { createdAt, removedAt } = person.membership
  return createdAt <= t && (removedAt === undefined || t <= removedAt)
}

// ────────────────────────────────────────────────────────────── bodies

type Pill = (who: MemberKey) => PmNode

/** A teammate pill as the editor inserts one from the @ menu. */
function pillOf(people: People): Pill {
  return (who) => ({
    type: 'mention',
    attrs: {
      id: people[who].membership._id,
      label: people[who].label,
      colour: people[who].membership.colour,
      mentionSuggestionChar: '@',
    },
  })
}

type Inline = string | PmNode

/** A title and a body. Ends on a paragraph, as the templates do, so the
 * editor's trailing-node rule has nothing to fix. */
function titled(title: string, ...blocks: Array<PmNode>): PmNode {
  const last = blocks.at(-1)
  return {
    type: 'doc',
    content: [
      heading(title),
      ...blocks,
      ...(last?.type === 'paragraph' ? [] : [paragraph('')]),
    ],
  }
}

/** A paragraph of text runs and pills. Empty strings are dropped: an empty
 * text node is the one thing the editor's schema refuses outright. */
function p(...parts: Array<Inline>): PmNode {
  const content = parts
    .filter((part) => part !== '')
    .map((part): PmNode =>
      typeof part === 'string' ? { type: 'text', text: part } : part,
    )
  return content.length > 0
    ? { type: 'paragraph', content }
    : { type: 'paragraph' }
}

const marked =
  (type: string) =>
  (text: string): PmNode => ({ type: 'text', text, marks: [{ type }] })
const bold = marked('bold')
const italic = marked('italic')
const underline = marked('underline')
const strike = marked('strike')
const code = marked('code')
const br: PmNode = { type: 'hardBreak' }

/** A pasted link, with the attributes the editor's Link mark stores. */
function link(text: string, href: string): PmNode {
  return {
    type: 'text',
    text,
    marks: [
      {
        type: 'link',
        attrs: {
          href,
          target: '_blank',
          rel: 'noopener noreferrer nofollow',
          class: null,
          title: null,
        },
      },
    ],
  }
}

/** The templates' section label ("Findings", "Access"…). */
const label = (text: string) => p(bold(text))

function bullets(...items: Array<PmNode>): PmNode {
  return {
    type: 'bulletList',
    content: items.map((item) => ({ type: 'listItem', content: [item] })),
  }
}

function numbered(...items: Array<PmNode>): PmNode {
  return {
    type: 'orderedList',
    attrs: { start: 1 },
    content: items.map((item) => ({ type: 'listItem', content: [item] })),
  }
}

function checklist(...items: Array<PmNode>): PmNode {
  return { type: 'taskList', content: items }
}

/** One checklist line, with any lines nested under it. */
function task(done: boolean, text: string, ...nested: Array<PmNode>): PmNode {
  return {
    type: 'taskItem',
    attrs: { checked: done },
    content: [p(text), ...(nested.length > 0 ? [checklist(...nested)] : [])],
  }
}

// ────────────────────────────────────────────────────────────── the set

type Link =
  { job: string } | { property: string } | { client: string } | { team: true }

/** An instant, or one worked out from the linked job (when it was booked,
 * when the visit ended), since those move with the jobs step. */
type Stamp = number | ((job: Doc<'jobs'>) => number)

type NoteSpec = {
  /** For the seed's own error messages; not stored. */
  name: string
  by: MemberKey
  /** Whoever saved the last version, when it was not the author. */
  editedBy?: MemberKey
  on: Link
  createdAt: Stamp
  updatedAt: Stamp
  pinnedAt?: number
  deletedAt?: number
  /** Mentions already opened, and when. Unlisted means unread. */
  readAt?: Partial<Record<MemberKey, number>>
  /** A personal note (notes.create's visibility 'private'): its author and
   * the owner read it, only its author writes it, it links to nothing, and
   * any pills in it tag nobody. */
  personal?: true
  body: (pill: Pill) => PmNode
}

/**
 * The oldest note: the business's first week. No older, because it opened
 * 180 days before the seed (demo/team.ts) and nothing in it can have been
 * written before then. The list's previous-year date label ("12 Mar 2026")
 * shows on it whenever the seed runs between January and June.
 */
const OLDEST_NOTE_DAY = -179

function noteSpecs(base: DemoBase, now: number): Array<NoteSpec> {
  const when = (day: number, hh: number, mm = 0) => at(base, day, hh, mm)
  // "Today" must be earlier than the seed whatever time it runs, and still
  // the seed's today if the steps ran across midnight. Just after midnight
  // they bunch up at the start of the day, a millisecond apart and still in
  // the order they were written.
  const startOfToday = at(base, 0, 0)
  const clock = Math.min(now, at(base, 1, 0) - MINUTE)
  const earlierToday = (minutes: number) =>
    Math.min(
      clock,
      Math.max(clock - minutes * MINUTE, startOfToday + (24 * 60 - minutes)),
    )
  const afterBooking =
    (minutes: number) =>
    (job: Doc<'jobs'>): number =>
      job.createdAt + minutes * MINUTE
  const afterVisit =
    (minutes: number) =>
    (job: Doc<'jobs'>): number =>
      job.scheduledAt + (job.durationMinutes + minutes) * MINUTE

  return [
    // ── One visit note per person, on their own job ─────────────────────
    // The subcontractor sees only theirs, the contractor theirs and the
    // sub's, the owner all three.
    {
      name: 'sub on their ant job',
      by: 'sub',
      on: { job: 'subAntsDone' },
      createdAt: afterVisit(20),
      updatedAt: when(-3, 7, 50),
      body: (pill) =>
        titled(
          'Coastal brown ants — kitchen and patio',
          label('Findings'),
          p(
            'Trails along the kitchen skirting and out under the back door. ' +
              'Nest under the pavers by the BBQ: lifted two and they were full of brood.',
          ),
          label('Treatment applied'),
          p(
            'Fipronil gel along the skirting and the door frame, granules around the pavers. ' +
              'Tenant to keep the dog off the lawn until it has been watered in.',
          ),
          label('Follow-ups'),
          checklist(
            task(true, 'Photos of the paver nest on the job'),
            task(false, 'Recheck in two weeks'),
          ),
          p(
            pill('contractor'),
            ' we are down to the last tube of Fipronil gel. Can you grab more on Monday?',
          ),
        ),
    },
    {
      name: 'contractor on their bait station check',
      by: 'contractor',
      on: { job: 'baitStationCheck' },
      createdAt: afterVisit(10),
      updatedAt: afterVisit(35),
      body: (pill) =>
        titled(
          'Bait stations — 2 of 14 with heavy take',
          label('Findings'),
          p(
            'Stations 6 and 7 by dock 3 cleaned out, fresh droppings behind the pallet racking. ' +
              'Everything else light or nil.',
          ),
          label('Treatment applied'),
          p(
            'New blocks in all 14, and two extra stations either side of the dock door. ' +
              'Station map updated in the folder in the dispatch office.',
          ),
          label('Follow-ups'),
          checklist(task(false, 'Quote new seals for the dock roller door')),
          p(
            pill('owner'),
            ' worth quoting the door seals? Mick says the roller door has not closed properly since winter.',
          ),
        ),
    },
    {
      name: 'owner on their flagged termite inspection',
      by: 'owner',
      on: { job: 'termiteInspectionFlagged' },
      createdAt: afterVisit(35),
      updatedAt: when(-10, 16, 40),
      // Kept at the top of the Jobs folder until the treatment is sold.
      pinnedAt: when(-10, 16, 45),
      body: () =>
        titled(
          'Live termites in the garage — quote a barrier',
          label('Findings'),
          p(
            'Coptotermes in the garage skirting and in the timber stacked against the back fence. ' +
              'Mud leads up the brick pier by the laundry. Moisture high under the bathroom.',
          ),
          label('Treatment applied'),
          p(
            'None today, inspection only. Katya is getting a second quote, so the report went out tonight.',
          ),
          label('Follow-ups'),
          checklist(
            task(true, 'Report emailed'),
            task(false, 'Quote chemical barrier plus monitoring stations'),
            task(false, 'Call Katya on Thursday'),
          ),
        ),
    },

    // ── A mention that lets the sub into the owner's job ────────────────
    {
      name: "owner asking the sub to take Marcus's service",
      by: 'owner',
      on: { job: 'lastVisitNext' },
      createdAt: earlierToday(55),
      updatedAt: earlierToday(50),
      body: (pill) =>
        titled(
          'Marcus Roberts — can you take this one?',
          p(
            pill('sub'),
            " I'm stuck in Rockingham that morning. Can you do Marcus's general service? " +
              'Same as last time: inside, outside and the roof void.',
          ),
          label('Before you arrive'),
          p(
            'Call Marcus 30 minutes out. There is a Rottweiler in the back yard: ' +
              'he will put her inside, but do not open the side gate until he says so.',
          ),
        ),
    },

    // ── The cancelled job, the visit due today, six weeks out ───────────
    {
      name: "owner on today's rat job",
      by: 'owner',
      on: { job: 'todayUnstarted1730' },
      createdAt: earlierToday(200),
      updatedAt: earlierToday(190),
      body: (pill) =>
        titled(
          'Jenny — rats in the roof void',
          p(
            'Scratching above the main bedroom most nights. She has seen one on the fence line by the lemon tree.',
          ),
          label('Plan'),
          bullets(
            p('Roof void: four lockable stations'),
            p('Fence line: two ground stations'),
            p('Check the gap where the downpipe goes into the eave'),
          ),
          p(
            pill('contractor'),
            ' can I borrow the six-metre ladder for this one?',
          ),
        ),
    },
    {
      name: 'sub on the job cancelled today',
      by: 'sub',
      on: { job: 'cancelledToday' },
      createdAt: earlierToday(100),
      updatedAt: earlierToday(95),
      body: (pill) =>
        titled(
          'Cancelled — David is away',
          p(
            'David Smith (the Armadale one, not Midland) rang at nine. He is overseas until the 10th. ' +
              'The spiders can wait: rebook for the week after.',
          ),
          p(
            pill('contractor'),
            ' can you put it back on my run when he is home?',
          ),
        ),
    },
    {
      name: 'owner on the monthly visit due today',
      by: 'owner',
      on: { job: NAMED_VISITS.dueToday },
      createdAt: when(-1, 17, 40),
      updatedAt: when(-1, 17, 46),
      body: (pill) =>
        titled(
          'Monthly rodent check — afternoons only',
          p(
            'Katya works from home in the mornings and asked us not to come before 1pm. ' +
              'Stations 1 to 4 are along the side path, 5 is in the garage.',
          ),
          p(
            pill('contractor'),
            ' if you end up doing this one, station 5 is behind the freezer.',
          ),
        ),
    },
    {
      name: 'owner on the pre-purchase six weeks out',
      by: 'owner',
      on: { job: 'sixWeeksAhead' },
      createdAt: afterBooking(25),
      updatedAt: afterBooking(40),
      body: (pill) =>
        titled(
          'Pre-purchase at Scarborough — the agent has the keys',
          p(
            "Buyer's inspection on one of Coastline's units. The agent, Sam (0491 571 010), meets us at 8:50 with the keys. " +
              'The unit is on the third floor; the subfloor hatch is in the car park storeroom.',
          ),
          p(
            pill('dana'),
            ' can you do the subfloor while I do the roof? Bring the long torch.',
          ),
        ),
    },
    {
      name: 'owner on the Darwin job tomorrow',
      by: 'owner',
      on: { job: 'fannieBayTomorrow' },
      createdAt: afterBooking(30),
      updatedAt: afterBooking(45),
      body: () =>
        titled(
          'Fannie Bay — flights and hire car',
          p(
            'Flying up the night before. Hire car from the airport, ten minutes to Greg’s. ' +
              'Buy the chemicals up there; nothing liquid goes in the checked bag.',
          ),
        ),
    },
    {
      // No licence on file (demo/team.ts), so the report is not theirs to
      // finalise: the note asks for someone who can.
      name: 'sub on the timber inspection they cannot sign',
      by: 'sub',
      on: { job: 'subTimberTomorrow' },
      createdAt: when(-1, 19, 5),
      updatedAt: when(-1, 19, 9),
      body: (pill) =>
        titled(
          'Timber inspection tomorrow — need a licensed tech',
          p(
            'Booked in for a full timber pest inspection at 9 Wharf Street. I can do the inspection ' +
              'but the report has to go out under a timber pest licence.',
          ),
          p(
            pill('contractor'),
            ' can you meet me there at 8 or sign it off after?',
          ),
        ),
    },
    {
      name: 'sub on the weekly visit they missed',
      by: 'sub',
      on: { job: NAMED_VISITS.overdueWeek },
      createdAt: afterVisit(15),
      updatedAt: afterVisit(18),
      body: () =>
        titled(
          'Missed — nobody home at unit 2',
          p(
            'Knocked twice and rang, no answer. Left a card in the letterbox. ' +
              'The common areas are done; unit 2 still needs its inside treatment.',
          ),
        ),
    },
    {
      name: 'contractor on the clean timber inspection',
      by: 'contractor',
      on: { job: 'termiteInspectionClean' },
      createdAt: afterVisit(20),
      updatedAt: afterVisit(30),
      body: () =>
        titled(
          'All clear at Beaufort Street',
          p(
            'No activity, no damage, no conducive conditions worth writing up. ' +
              'Sofia wants the same inspection every year before summer.',
          ),
        ),
    },
    {
      name: 'owner on the contractor’s bird proofing job (read)',
      by: 'owner',
      on: { job: 'photoJob' },
      createdAt: when(-3, 15, 10),
      updatedAt: when(-3, 15, 12),
      readAt: { contractor: when(-2, 7, 45) },
      body: (pill) =>
        titled(
          'Ridgeline want the east parapet done too',
          p(
            pill('contractor'),
            ' Priya Raman rang: can we add spikes along the east parapet while the lift is on site? ' +
              'Quote it as a variation.',
          ),
        ),
    },
    {
      name: 'Dana on the wasp job she stopped',
      by: 'dana',
      on: { job: 'unsafeStop' },
      createdAt: afterVisit(10),
      updatedAt: afterVisit(35),
      body: () =>
        titled(
          'Wasps 🐝 — stopped, the nest is inside the wall',
          label('Findings'),
          p(
            'European wasps going in and out of a gap under the eave above the front door. ' +
              'The nest is in the wall cavity and cannot be reached from the eave.',
          ),
          label('Treatment applied'),
          p(
            'None. Not safe to start with the front door in use and no way to seal off the cavity. ' +
              'Dayo is keeping the front door shut until we are back.',
          ),
          label('Follow-ups'),
          checklist(
            task(
              false,
              'Book a return visit with a builder there to open the wall',
            ),
          ),
        ),
    },
    {
      name: "Dana on yesterday's café job",
      by: 'dana',
      on: { job: 'legacyStarted' },
      createdAt: afterVisit(5),
      updatedAt: afterVisit(20),
      body: (pill) =>
        titled(
          'Harbourview Café — German cockroaches behind the dishwasher',
          p(
            'Gel behind the dishwasher, the pass and the coffee station. ' +
              'The manager wants the invoice sent to the owner, not the café.',
          ),
          p(
            pill('contractor'),
            ' can you check the owner’s email before it goes out?',
          ),
        ),
    },

    // ── Standing knowledge: sites, clients, the team ────────────────────
    {
      name: 'sub’s pinned site note at 44 Shepperton Road',
      by: 'sub',
      on: { property: 'ppm2' },
      createdAt: when(-110, 17, 5),
      updatedAt: when(-6, 18, 20),
      pinnedAt: when(-110, 17, 6),
      body: (pill) =>
        titled(
          '44 Shepperton Road — site access',
          label('Access'),
          p('Gate code: 4471'),
          p('Key: lockbox on the meter box, same code'),
          label('Animals'),
          p(
            "Rottweiler (Bruno) in unit 2's yard. Friendly, but he jumps: ask the tenant to hold him.",
          ),
          label('Hazards'),
          p(
            'Asbestos eaves on the old laundry shed. No drilling, no ladders against them.',
          ),
          label('Before you arrive'),
          checklist(
            task(false, 'Call ahead'),
            task(false, 'Close the side gate behind you'),
          ),
          p(pill('contractor'), ' has the spare key if the lockbox jams.'),
        ),
    },
    {
      name: 'owner’s client note for Perth Property Managers',
      by: 'owner',
      on: { client: 'ppm' },
      createdAt: when(-90, 11, 0),
      updatedAt: when(-2, 9, 10),
      body: (pill) =>
        titled(
          'Accounts: 30-day terms, PO number required',
          p(
            'Perth Property Managers pay on 30-day terms. Every invoice needs their PO number, or it comes back unpaid.',
          ),
          bullets(
            p('Ask Grace Liu for the PO before booking'),
            p('The PO goes in the job note and on the invoice'),
            p('Tenant call-backs within 14 days are free: no PO'),
          ),
          p(
            pill('contractor'),
            ' please do not book any PPM site without a PO.',
          ),
        ),
    },
    {
      name: 'owner’s pinned mix ratios memo',
      by: 'owner',
      on: { team: true },
      createdAt: when(-178, 19, 40),
      updatedAt: when(-20, 20, 15),
      pinnedAt: when(-178, 19, 45),
      body: () =>
        titled(
          'Mix ratios and supplier numbers',
          p(
            bold('Always read the label.'),
            ' These are our usual rates, but the ',
            italic('label'),
            ' is the law, not this note.',
          ),
          numbered(
            p(
              bold('Termidor SC (fipronil 100 g/L)'),
              ': 60 mL per 10 L of water for soil barriers.',
              br,
              'Trench and rod: 5 L of mix per metre, per 100 mm of depth.',
            ),
            p(
              bold('Fipronil gel'),
              ': pea-sized spots 30 cm apart along trails. ',
              strike('Squeeze a line'),
              ' Spots only.',
            ),
            p(
              bold('Bifenthrin'),
              ': ',
              code('20 mL / 5 L'),
              ' for perimeter sprays.',
            ),
          ),
          label('Supplier numbers'),
          bullets(
            p('Chemical supplier, Welshpool: (08) 5550 1180'),
            p('After-hours spill line: (08) 5550 1199'),
            p(
              'Safety data sheets: ',
              link('example.com/sds', 'https://www.example.com/sds'),
            ),
          ),
          p(
            underline('Never'),
            ' decant into drink bottles. Label every tank with the product and the date it was mixed.',
          ),
        ),
    },
    {
      name: 'contractor’s van restock (0 of 3)',
      by: 'contractor',
      on: { team: true },
      createdAt: when(-3, 17, 30),
      updatedAt: when(-3, 17, 33),
      body: () =>
        titled(
          'Van restock — Monday',
          checklist(
            task(false, 'Bait blocks, two buckets'),
            task(false, 'Fipronil gel ×6'),
            task(false, 'Nitrile gloves, size L'),
          ),
        ),
    },
    {
      name: 'contractor’s bird proofing punch list (2 of 5, nested)',
      by: 'contractor',
      on: { property: 'ridgeOsborne2' },
      createdAt: when(-9, 15, 0),
      updatedAt: when(-3, 16, 45),
      body: (pill) =>
        titled(
          '12 Main Street — bird proofing punch list',
          checklist(
            task(true, 'East parapet spikes'),
            task(
              false,
              'North gutter mesh',
              task(true, 'Measure the run (11.5 m)'),
              task(false, 'Order 12 m of mesh'),
            ),
            task(false, 'Photos to the strata manager'),
          ),
          p(pill('owner'), ' can we bill the mesh as a variation?'),
        ),
    },
    {
      name: 'Dana’s pre-summer checks (4 of 4)',
      by: 'dana',
      on: { property: 'smithMidland' },
      createdAt: when(-14, 8, 0),
      updatedAt: when(-13, 15, 20),
      body: (pill) =>
        titled(
          'Morrison Road — pre-summer checks',
          checklist(
            task(true, 'Roof void stations checked'),
            task(true, 'Weep holes clear'),
            task(true, 'Garden beds pulled back from the slab'),
            task(true, 'Termite monitors read: nil'),
          ),
          p(pill('contractor'), ' all done here. Invoice when you are ready.'),
        ),
    },
    {
      name: 'sub’s note with no title',
      by: 'sub',
      on: { team: true },
      createdAt: when(-2, 7, 10),
      updatedAt: when(-2, 7, 12),
      body: () =>
        titled(
          '',
          p(
            'Leftover gel in the van fridge. Use it before opening the new batch.',
          ),
        ),
    },
    {
      name: 'owner’s note with a title and nothing else',
      by: 'owner',
      on: { property: 'arthurHome' },
      createdAt: when(-1, 8, 5),
      updatedAt: when(-1, 8, 6),
      body: () => titled('Call Arthur back about the barrier warranty'),
    },
    {
      name: 'contractor’s abandoned blank note',
      by: 'contractor',
      on: { team: true },
      createdAt: earlierToday(20),
      updatedAt: earlierToday(20),
      body: () => titled(''),
    },
    {
      name: 'owner’s note with a very long title',
      by: 'owner',
      on: { property: 'longAddress' },
      createdAt: when(-25, 13, 0),
      updatedAt: when(-25, 13, 20),
      body: (pill) =>
        titled(
          "O'Brien & Sons, Rivervale — rear unit access is via the laneway off Kooyong Road, " +
            'the roller door code changes every month so ring the office first, and never park across ' +
            "the neighbour's driveway",
          p(
            'The office is upstairs at the front. Ask for the plant room key; the bait stations are behind it.',
          ),
          p(pill('contractor'), ' this one is yours from next month.'),
        ),
    },
    {
      name: 'owner’s long new starter guide',
      by: 'owner',
      on: { team: true },
      createdAt: when(-150, 20, 10),
      updatedAt: when(-60, 19, 0),
      body: (pill) => starterGuide(pill),
    },
    {
      name: 'owner’s site note, last edited by the sub',
      by: 'owner',
      editedBy: 'sub',
      on: { property: 'ppm3' },
      createdAt: when(-40, 10, 0),
      updatedAt: earlierToday(130),
      body: (pill) =>
        titled(
          '17 Great Eastern Highway — tenants',
          p(
            'Four units. The tenants in 1 and 4 work nights, so knock softly before ten. ' +
              'Unit 3 has a new tenant as of this week; the property manager has the number.',
          ),
          p(
            pill('contractor'),
            ' unit 3 changed hands, so ring the property manager, not the old tenant.',
          ),
        ),
    },
    {
      name: 'Dana’s site note for Nguyễn Thị Hương',
      by: 'dana',
      on: { property: 'huongHome' },
      createdAt: when(-30, 10, 0),
      updatedAt: when(-30, 10, 15),
      body: (pill) =>
        titled(
          'Chị Nguyễn — call her daughter first',
          p(
            'Mrs Nguyễn Thị Hương prefers Vietnamese. Her daughter Linh (0491 572 318) translates and ' +
              'books the visits; ring her, not the house.',
          ),
          p(pill('contractor'), ' Linh is happy with texts too.'),
        ),
    },
    {
      name: 'contractor’s site note for the 李 household',
      by: 'contractor',
      on: { property: 'ppm6' },
      createdAt: when(-58, 12, 0),
      updatedAt: when(-58, 12, 10),
      body: () =>
        titled(
          '8 Kintail Road — tenant 李伟 (Li Wei)',
          p(
            'Mr 李 is home on Tuesdays and Thursdays. Shoes off inside; there is a rack by the door.',
          ),
        ),
    },
    {
      name: 'contractor’s note at the archived client’s house',
      by: 'contractor',
      on: { property: 'colinHome' },
      createdAt: when(-61, 18, 10),
      updatedAt: when(-60, 16, 30),
      body: (pill) =>
        titled(
          'Kalgoorlie — plan the day around the drive',
          p(
            'Six hours each way. Leave Perth by 4:30am and fuel up at Southern Cross on the way back.',
          ),
          p(
            'Colin leaves the side door open. The shed key is on the hook inside the laundry.',
          ),
          p(
            pill('contractor'),
            ' take the spare pump: the only supplier out there shuts at noon on Saturdays.',
          ),
        ),
    },
    {
      name: 'the former technician’s site note',
      by: 'former',
      on: { property: 'harbourCafe' },
      createdAt: when(-64, 15, 20),
      updatedAt: when(-64, 15, 35),
      body: () =>
        titled(
          'Harbourview Café — kitchen access',
          p(
            'The kitchen closes at 2:30. Come in through the laneway door off Mews Road, never through ' +
              'the dining room during service.',
          ),
          label('Hazards'),
          p(
            'The grease trap lid by the back step is loose: step around it. The cool room door sticks, so prop it open.',
          ),
        ),
    },
    {
      // Written the day before Riley left and edited after, so the pill
      // stays in the body and the save that followed dropped its row.
      name: 'owner’s handover memo naming the former technician',
      by: 'owner',
      on: { team: true },
      createdAt: when(-31, 16, 0),
      updatedAt: when(-20, 9, 0),
      body: (pill) =>
        titled(
          'Riley’s runs — who takes what',
          p(
            pill('former'),
            ' has finished with us. Thanks for five good months.',
          ),
          bullets(
            p(pill('contractor'), ' takes the Ridgeline sites'),
            p(pill('dana'), ' takes the Midland and Bassendean rounds'),
            p('The shed gate at Shepperton Road is still 4471'),
            p('Van keys are in the top drawer in the office'),
          ),
        ),
    },
    {
      name: 'the first thing anyone wrote',
      by: 'owner',
      on: { team: true },
      createdAt: when(OLDEST_NOTE_DAY, 19, 30),
      updatedAt: when(OLDEST_NOTE_DAY, 19, 42),
      body: () =>
        titled(
          'Where everything lives',
          bullets(
            p(
              'Safety data sheets: the red folder in the van, and a copy in the office',
            ),
            p('Spill kit: behind the passenger seat'),
            p(
              'Spare keys for client sites: the lockbox in the shed, code on request',
            ),
          ),
        ),
    },

    // ── Recently Deleted ────────────────────────────────────────────────
    {
      // Deleted a moment ago in real time, not at a clock time: "2 hours
      // ago" at 1am would otherwise be tomorrow.
      name: 'contractor’s note deleted two hours ago',
      by: 'contractor',
      on: { property: 'coastRockingham' },
      createdAt: when(-8, 11, 0),
      updatedAt: when(-1, 16, 0),
      deletedAt: now - 2 * HOUR,
      body: (pill) =>
        titled(
          'Old quote — Kent Street rodent program',
          p(
            'Superseded. The old program used Brodifacoum blocks in the car park; the new one is ' +
              'traps only, at the building manager’s request.',
          ),
          p(pill('owner'), ' ignore this one, the new quote is on the job.'),
        ),
    },
    {
      name: 'owner’s note deleted twenty days ago',
      by: 'owner',
      on: { team: true },
      createdAt: when(-50, 9, 0),
      updatedAt: when(-27, 17, 0),
      deletedAt: when(-20, 8, 30),
      body: (pill) =>
        titled(
          'Price list — last financial year',
          p('General service $190, rodents $165, termite inspection $350.'),
          p(
            pill('contractor'),
            ' these are out of date, do not quote from them.',
          ),
        ),
    },

    // ── Personal notes: "My notes", and the owner's "Everyone's notes" ────
    // Readable by their author and the owner, written by the author alone,
    // linked to nothing, tagging nobody.
    {
      name: 'owner’s quotes to chase, pinned',
      by: 'owner',
      on: { team: true },
      personal: true,
      createdAt: when(-9, 19, 10),
      updatedAt: when(-2, 20, 5),
      pinnedAt: when(-9, 19, 12),
      body: () =>
        titled(
          'Quotes to chase',
          checklist(
            task(true, 'Ridgeline — Osborne Park bird netting (sent)'),
            task(true, 'Coastline — Scarborough pre-purchase'),
            task(false, 'PPM — whole-portfolio termite program'),
            task(false, 'Harbourview Café — monthly service agreement'),
          ),
          p('Follow up anything older than a week by phone, not email.'),
        ),
    },
    {
      name: 'owner’s van and admin',
      by: 'owner',
      on: { team: true },
      personal: true,
      createdAt: when(-40, 7, 30),
      updatedAt: when(-20, 18, 45),
      body: () =>
        titled(
          'Van — service and rego',
          p(
            'Rego due end of next month. Service booked with the dealer for the 14th, loan van organised.',
          ),
          p(
            'Ask the accountant whether the new sprayer is a write-off this year.',
          ),
        ),
    },
    {
      name: 'owner’s personal note deleted three days ago',
      by: 'owner',
      on: { team: true },
      personal: true,
      createdAt: when(-12, 21, 0),
      updatedAt: when(-12, 21, 20),
      deletedAt: when(-3, 6, 45),
      body: () =>
        titled(
          'Pricing idea (dropped)',
          p(
            'Flat monthly fee for strata clients instead of per visit. Not worth it for the volume.',
          ),
        ),
    },
    {
      name: 'contractor’s stock count',
      by: 'contractor',
      on: { team: true },
      personal: true,
      createdAt: when(-15, 17, 30),
      updatedAt: when(-1, 17, 40),
      body: () =>
        titled(
          'My chemical stock — van 2',
          checklist(
            task(true, 'Fipronil gel: 1 tube left'),
            task(true, 'Bait blocks: 3 buckets'),
            task(false, 'Bifenthrin: order 2 × 5 L'),
          ),
          p('Supplier closes at 3pm on Fridays.'),
        ),
    },
    {
      // A pill typed into a personal note: kept in the body, but it tags
      // nobody (applyDerived keeps no mention row), so the contractor's
      // badge does not move.
      name: 'sub’s licence application notes',
      by: 'sub',
      on: { team: true },
      personal: true,
      createdAt: when(-7, 20, 0),
      updatedAt: when(-3, 21, 15),
      body: (pill) =>
        titled(
          'Licence application',
          p(
            'Need 20 supervised timber inspections logged before I can apply. At 12 so far.',
          ),
          p('Ask ', pill('contractor'), ' to sign off the next eight.'),
        ),
    },
    {
      name: 'Dana’s questions for the owner',
      by: 'dana',
      on: { team: true },
      personal: true,
      createdAt: earlierToday(95),
      updatedAt: earlierToday(90),
      body: () =>
        titled(
          'To ask on Monday',
          checklist(
            task(false, 'Can I take the ute home on call-out weeks?'),
            task(false, 'Who restocks the café bait stations?'),
          ),
          p(''),
        ),
    },
  ]
}

/** About 1,200 words, so the list preview has to cut it. */
function starterGuide(pill: Pill): PmNode {
  return titled(
    'New starter guide — how a job runs here',
    p(
      'Read this before your first week, then again after it. Ride along with ',
      pill('contractor'),
      ' for your first two weeks; nobody works alone until they have done every kind of job with someone watching.',
    ),
    label('Before the day'),
    p(
      'Your run for tomorrow is on the Schedule by four. Open every job the night before and read the site ' +
        'notes and the client notes under Before you arrive: gate codes, dogs, who to call, which door to use. ' +
        'If a new client has no notes, ring them in the morning to confirm the address and ask about pets, ' +
        'kids and anything they have already tried. Anything you learn goes into a site note, not your head. ' +
        'The next person on that site might be you in a year, or someone who has never been there.',
    ),
    label('The van'),
    p(
      'Check the van before you leave the yard, not at the first job. Spill kit, first aid kit, fire ' +
        'extinguisher, eyewash, the red folder of safety data sheets and a full set of PPE. Top up the gel, the ' +
        'bait blocks and the dust from the shelf in the shed, and write down what you took on the restock list. ' +
        'Tanks are rinsed at the end of the day and never left full overnight. Every tank is labelled with the ' +
        'product and the date it was mixed. If you cannot tell what is in a tank, it gets emptied properly, not guessed at.',
    ),
    label('Arriving'),
    p(
      'Park on the street unless the client says otherwise, and never across a driveway. Knock, introduce ' +
        'yourself, and ask the same three things every time: where have you seen them, for how long, and is ' +
        'there anything I should know about. Pets, kids, someone pregnant, a fishpond, a vegetable garden. Walk ' +
        'the outside first, then the inside. Do not start spraying before you have looked; half our jobs are ' +
        'solved by finding where they are getting in.',
    ),
    label('Inspecting'),
    p(
      'Take your time. Torch into every cupboard under a sink, behind the fridge and the dishwasher, along the ' +
        'skirting boards, into the roof void if it is safe to get to and the subfloor if there is one. Look for ' +
        'droppings, trails, frass, mud leads and damage. Photograph what you find before you treat it. If you ' +
        'find termites, stop. Do not disturb them, do not spray them: take photos and ring the office before you ' +
        'say anything to the client about cost.',
    ),
    label('Treating'),
    p(
      'Use the least product that will do the job and follow the label every time; the label is the law. Gel ' +
        'and bait go where the pests are, not where they are easy to reach. Sprays go on the outside perimeter ' +
        'and the entry points, not across floors where kids and pets walk. Keep people and animals out of treated ' +
        'areas until they are dry, and tell the client exactly how long that is. If the wind picks up or it starts ' +
        'to rain, stop the outside work and say so in the report.',
    ),
    label('Pets, kids and neighbours'),
    p(
      'Ask for dogs to be inside before you open a gate. Cover or move fish tanks, pet bowls and toys. Never ' +
        'leave a bait station unlocked, never put bait where a child could reach it, and never treat over a ' +
        'neighbour’s fence. If a neighbour asks what you are doing, be friendly and tell them. That is how half ' +
        'our work finds us.',
    ),
    label('When it is not safe'),
    p(
      'You can always stop. A wasp nest inside a wall, a roof void with bad wiring, a ladder with nowhere solid ' +
        'to stand, a dog that means it, a client who will not keep the kids out: any of these is a reason to stop ' +
        'and rebook. Start the service report anyway, answer No to safe to start, and write down why. Nobody here ' +
        'will ever be in trouble for stopping a job that was not safe.',
    ),
    label('The report'),
    p(
      'Every job gets a report before you leave the street. Fill in what you found, what you used and where, ' +
        'how much, and what the client needs to do next. Pick the products from the list so the active ' +
        'constituent goes on the report properly. Add photos of what you found and what you did. Read it back to ' +
        'yourself once: the client, the council or a court might read it one day.',
    ),
    label('Termite work'),
    p(
      'Timber pest inspections and termite treatments follow the standard, not our habits. The report says what ' +
        'was inspected, what was not and why, and what got in the way: a car stored in the garage, a locked room, ' +
        'insulation over the ceiling. Barrier treatments get a certificate and a durable notice in the meter box. ' +
        'If you are not licensed for timber pests yet, you can help and learn, but the report goes out under the ' +
        'licensed technician’s name.',
    ),
    label('Photos and notes'),
    p(
      'Photos belong on the job, not in your camera roll. Notes are for the team. A site note is for anything ' +
        'true about the property every visit: gate codes, keys, animals, hazards. A job note is for what happened ' +
        'on one visit. Mention someone with @ when they need to see it and they will get the badge. If a note is ' +
        'wrong, fix it. Everyone can edit, and that is the point.',
    ),
    label('Leaving'),
    p(
      'Before you go, walk the client through what you did and what happens next, and ask if they have any ' +
        'questions. Close every gate you opened. Pack the van so nothing can tip over on the way to the next job. ' +
        'Mark the job completed on the Schedule so the office knows it is ready to invoice.',
    ),
    label('Getting paid'),
    p(
      'The office invoices from the Schedule, so the status matters. Completed means the work is done and the ' +
        'report is finished. Invoiced means the invoice has gone out. Do not mark a job invoiced yourself unless ' +
        'you have been asked to. If a client wants to pay on the spot, take the details and tell the office the same day.',
    ),
    label('Call-backs'),
    p(
      'Some jobs come back. Ants find a new way in, a roof void gets a second family of rats, a tenant moves ' +
        'the bait station behind the fridge. A call-back inside the warranty period is free, and it is booked ' +
        'as its own job so the history stays straight. Read the last visit’s report and notes before you go, ' +
        'so you are not guessing at what was done. Treat what you find, and write down why you think it came ' +
        'back: the next person needs that more than anything else on the report.',
    ),
    label('Weather and the heat'),
    p(
      'Summer here is hard on people and on chemicals. Start early, carry more water than you think you need, ' +
        'and do roof voids first thing, never in the afternoon. Most sprays do not go on in rain, wind or when ' +
        'rain is due within the day; check the forecast on the job card before you leave. If a job has to move ' +
        'because of the weather, move it on the Schedule and ring the client yourself.',
    ),
    label('Questions'),
    p(
      'Ask. Ring the office, message the team, or leave a note and mention someone. There is no such thing as a ' +
        'silly question about chemicals, ladders or roofs. The only mistake we cannot fix is the one nobody told us about.',
    ),
  )
}

// ─────────────────────────────────────────────────────────── resolving

type Links = {
  jobId?: Id<'jobs'>
  propertyId?: Id<'properties'>
  clientId?: Id<'clients'>
}

type Lookup = {
  base: DemoBase
  properties: Record<string, Id<'properties'>>
  clients: Record<string, Id<'clients'>>
  jobs: Map<string, ManifestJob>
}

type Planned = {
  spec: NoteSpec
  links: Links
  doc: PmNode
  createdAt: number
  updatedAt: number
}

/**
 * One note, resolved and checked: its links as notes.create's resolveLinks
 * would store them, its times, its body, and that the people in it were
 * there to write it.
 */
async function plan(
  ctx: MutationCtx,
  lookup: Lookup,
  people: People,
  viewerOf: (who: MemberKey) => Promise<NoteViewer>,
  pill: Pill,
  spec: NoteSpec,
  now: number,
): Promise<Planned> {
  const fail: (why: string) => never = (why) => {
    throw new Error(`demo: note "${spec.name}": ${why}`)
  }
  // notes.create refuses a personal note with a link (PRIVATE_NOTE_LINK).
  if (spec.personal && !('team' in spec.on)) fail('a personal note is linked')
  if (spec.personal && spec.editedBy && spec.editedBy !== spec.by) {
    fail('only its author writes a personal note')
  }
  const { links, job } = await resolveLinks(ctx, lookup, spec.on, fail)

  // A job the author cannot see is NOT_FOUND to notes.create.
  if (job && !isInScope((await viewerOf(spec.by)).ownRows, job)) {
    fail(`${spec.by} cannot see that job`)
  }

  const stamp = (s: Stamp) =>
    typeof s === 'number' ? s : job ? s(job) : fail('a job time on no job')
  const createdAt = stamp(spec.createdAt)
  const updatedAt = stamp(spec.updatedAt)
  if (!(createdAt <= updatedAt && updatedAt <= now)) {
    fail('its times are out of order, or in the future')
  }
  if (job && createdAt < job.createdAt) {
    fail('written before the job was booked')
  }
  if (spec.pinnedAt !== undefined && spec.deletedAt !== undefined) {
    fail('softDelete clears the pin, so a deleted note is never pinned')
  }
  if (
    spec.pinnedAt !== undefined &&
    !(spec.pinnedAt >= createdAt && spec.pinnedAt <= now)
  ) {
    fail('pinned outside its life')
  }
  if (
    spec.deletedAt !== undefined &&
    !(spec.deletedAt >= updatedAt && spec.deletedAt <= now)
  ) {
    fail('deleted outside its life')
  }
  // The nightly purge takes anything deleted over 30 days ago; a day's
  // margin keeps it from going the night after the seed.
  if (spec.deletedAt !== undefined && spec.deletedAt < now - 29 * DAY) {
    fail('deleted too long ago to still be in Recently Deleted')
  }

  const editor = spec.editedBy ?? spec.by
  if (!joinedBy(people[spec.by], createdAt)) fail(`${spec.by} was not there`)
  if (!joinedBy(people[editor], updatedAt)) fail(`${editor} was not there`)

  const doc = spec.body(pill)
  for (const id of deriveNoteFields(doc).mentionIds) {
    const who = keyOf(people, id as Id<'memberships'>)
    // A pill is typed from the roster, so its person was on the team when
    // the note was being written; one who has left since keeps the pill.
    const typedAt =
      people[who].membership.removedAt === undefined ? updatedAt : createdAt
    if (!joinedBy(people[who], typedAt)) fail(`${who} was not on the roster`)
  }

  return { spec, links, doc, createdAt, updatedAt }
}

/** notes.create's resolveLinks: a job carries its property and that
 * property's client, a property its client, so `by_client` finds every note
 * about a client and `by_property` every note about a site. */
async function resolveLinks(
  ctx: MutationCtx,
  lookup: Lookup,
  on: Link,
  fail: (why: string) => never,
): Promise<{ links: Links; job: Doc<'jobs'> | null }> {
  const businessId = lookup.base.businessId
  if ('job' in on) {
    const entry = lookup.jobs.get(on.job) ?? fail(`no job ${on.job}`)
    const job = await ctx.db.get(entry.id)
    if (!job || job.businessId !== businessId) {
      return fail(`job ${on.job} is gone`)
    }
    const property = await ctx.db.get(job.propertyId)
    if (!property) return fail(`job ${on.job} has no property`)
    return {
      links: {
        jobId: job._id,
        propertyId: job.propertyId,
        clientId: property.clientId,
      },
      job,
    }
  }
  if ('property' in on) {
    const id =
      entryOf(lookup.properties, on.property) ?? fail(`no ${on.property}`)
    const property = await ctx.db.get(id)
    if (!property || property.businessId !== businessId) {
      return fail(`property ${on.property} is gone`)
    }
    return {
      links: { propertyId: property._id, clientId: property.clientId },
      job: null,
    }
  }
  if ('client' in on) {
    const id = entryOf(lookup.clients, on.client) ?? fail(`no ${on.client}`)
    const client = await ctx.db.get(id)
    if (!client || client.businessId !== businessId) {
      return fail(`client ${on.client} is gone`)
    }
    return { links: { clientId: client._id }, job: null }
  }
  return { links: {}, job: null }
}

/** A key the previous step may not have handed over. */
function entryOf<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined
}
