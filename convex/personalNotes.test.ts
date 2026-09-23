/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import type { Id } from './_generated/dataModel'
import type { TestActor } from '../test/harness'

/**
 * Phase 5.3: personal notes, through the API a client actually calls — the
 * folders, search, the mention badge, and making a note personal or shared.
 * The permission matrix itself is in noteAccess.test.ts.
 */

const PAGE = { numItems: 50, cursor: null }

async function setup() {
  const t = testApp()
  const terence = await createActor(t, {
    email: 'terence@coastal.test',
    name: 'Terence',
  })
  const { businessId, ownerMembershipId } = await createBusiness(t, terence)
  const kevin = await createActor(t, {
    email: 'kevin@coastal.test',
    name: 'Kevin',
  })
  const ann = await createActor(t, { email: 'ann@coastal.test', name: 'Ann' })
  const jo = await createActor(t, { email: 'jo@jospest.test', name: 'Jo' })
  const now = Date.now()
  const [kevinId, annId, propertyId, joId] = await t.run(async (ctx) => {
    // Jo is a contractor, and Kevin is on her team.
    const contractorId = await ctx.db.insert('memberships', {
      userId: jo.userId,
      businessId,
      role: 'contractor',
      canViewAllJobs: false,
      colour: '#0ea5e9',
      status: 'active',
      createdAt: now,
    })
    const member = (userId: string, canViewAllJobs: boolean, team?: boolean) =>
      ctx.db.insert('memberships', {
        userId,
        businessId,
        role: 'subcontractor',
        canViewAllJobs,
        colour: '#0ea5e9',
        status: 'active',
        createdAt: now,
        ...(team && { parentMembershipId: contractorId }),
      })
    const clientId = await ctx.db.insert('clients', {
      businessId,
      kind: 'person',
      name: 'J. Nguyen',
      createdAt: now,
      updatedAt: now,
    })
    return [
      await member(kevin.userId, false, true),
      // Ann sees the whole business's jobs: that must still not reach
      // anyone's personal notes.
      await member(ann.userId, true),
      await ctx.db.insert('properties', {
        businessId,
        clientId,
        addressLine: '12 Wattle Street',
        suburb: 'Bayswater',
        state: 'WA',
        postcode: '6053',
        createdAt: now,
      }),
      contractorId,
    ] as const
  })
  return {
    t,
    terence,
    kevin,
    ann,
    jo,
    joId,
    businessId,
    ownerMembershipId,
    kevinId,
    annId,
    propertyId,
  }
}

type Setup = Awaited<ReturnType<typeof setup>>

function newPersonal(s: Setup, who: TestActor) {
  return who.as.mutation(api.notes.create, {
    businessId: s.businessId,
    visibility: 'private',
  })
}

async function folder(
  s: Setup,
  who: TestActor,
  filter: 'all' | 'mine' | 'everyone' | 'team' | 'jobs' | 'sites' | 'trash',
) {
  const { page } = await who.as.query(api.notes.list, {
    businessId: s.businessId,
    filter,
    paginationOpts: PAGE,
  })
  return page.map((n) => n._id)
}

/** A body saying `text` and tagging `membershipId` — what the editor sends. */
async function writeBody(
  who: TestActor,
  noteId: Id<'notes'>,
  text: string,
  membershipId?: Id<'memberships'>,
) {
  const latest = await who.as.query(api.notesSync.latestVersion, { id: noteId })
  await who.as.mutation(api.notesSync.submitSnapshot, {
    id: noteId,
    version: (latest ?? 0) + 1,
    content: JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text }],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: `${text} ` },
            ...(membershipId
              ? [
                  {
                    type: 'mention',
                    attrs: { id: membershipId, label: 'someone' },
                  },
                ]
              : []),
          ],
        },
      ],
    }),
  })
}

async function mentionRows(s: Setup, noteId: Id<'notes'>) {
  return s.t.run((ctx) =>
    ctx.db
      .query('noteMentions')
      .withIndex('by_note', (q) => q.eq('noteId', noteId))
      .collect(),
  )
}

describe('a personal note', () => {
  test('is its author’s: listed in My notes and All Notes, nowhere shared', async () => {
    const s = await setup()
    const noteId = await newPersonal(s, s.kevin)

    expect(await folder(s, s.kevin, 'mine')).toEqual([noteId])
    expect(await folder(s, s.kevin, 'all')).toContain(noteId)
    expect(await folder(s, s.kevin, 'team')).not.toContain(noteId)

    const note = await s.kevin.as.query(api.notes.get, {
      businessId: s.businessId,
      noteId,
    })
    expect(note).toMatchObject({
      private: true,
      mine: true,
      canEdit: true,
      kind: 'team',
    })
  })

  test('is nobody else’s on the team, whatever their job scope', async () => {
    const s = await setup()
    const noteId = await newPersonal(s, s.kevin)
    await writeBody(s.kevin, noteId, 'Bait station count')

    expect(
      await s.ann.as.query(api.notes.get, { businessId: s.businessId, noteId }),
    ).toBeNull()
    for (const f of ['all', 'mine', 'everyone', 'team', 'trash'] as const) {
      expect(await folder(s, s.ann, f)).not.toContain(noteId)
    }
    expect(
      await s.ann.as.query(api.notes.search, {
        businessId: s.businessId,
        q: 'Bait',
        filter: 'all',
      }),
    ).toEqual([])
    // Nor through the editor's own sync endpoints.
    await expect(
      s.ann.as.query(api.notesSync.getSnapshot, { id: noteId }),
    ).rejects.toThrow(/NOT_FOUND/)
    // (A write is refused as NO_ACCESS, the sync endpoint's answer for any
    // note the caller cannot write.)
    await expect(
      s.ann.as.mutation(api.notesSync.submitSnapshot, {
        id: noteId,
        version: 9,
        content: '{"type":"doc","content":[]}',
      }),
    ).rejects.toThrow(/NO_ACCESS/)
  })

  test('the owner reads it, read-only, listed in Everyone’s notes in God view', async () => {
    const s = await setup()
    const noteId = await newPersonal(s, s.kevin)
    await writeBody(s.kevin, noteId, 'Van stock')

    const seen = await s.terence.as.query(api.notes.get, {
      businessId: s.businessId,
      noteId,
    })
    expect(seen).toMatchObject({
      private: true,
      mine: false,
      canEdit: false,
      canDelete: true,
    })
    expect(await folder(s, s.terence, 'everyone')).toEqual([noteId])
    // Kept out of his own notebook and the team's folders.
    expect(await folder(s, s.terence, 'all')).not.toContain(noteId)
    expect(await folder(s, s.terence, 'mine')).not.toContain(noteId)
    expect(await folder(s, s.terence, 'team')).not.toContain(noteId)
    expect(
      (
        await s.terence.as.query(api.notes.search, {
          businessId: s.businessId,
          q: 'Van',
          filter: 'everyone',
        })
      ).map((n) => n._id),
    ).toEqual([noteId])
    expect(
      await s.terence.as.query(api.notes.search, {
        businessId: s.businessId,
        q: 'Van',
        filter: 'all',
      }),
    ).toEqual([])

    // He can read the body, and cannot change it any way at all.
    await s.terence.as.query(api.notesSync.getSnapshot, { id: noteId })
    await expect(
      s.terence.as.mutation(api.notesSync.submitSnapshot, {
        id: noteId,
        version: 9,
        content: '{"type":"doc","content":[]}',
      }),
    ).rejects.toThrow(/NO_ACCESS/)
    await expect(
      s.terence.as.mutation(api.notes.togglePin, {
        businessId: s.businessId,
        noteId,
      }),
    ).rejects.toThrow(/NO_ACCESS/)
    await expect(
      s.terence.as.mutation(api.notes.setVisibility, {
        businessId: s.businessId,
        noteId,
        visibility: 'shared',
      }),
    ).rejects.toThrow(/NO_ACCESS/)
  })

  test('Everyone’s notes is empty outside God view, and reads by link stay allowed', async () => {
    const s = await setup()
    const noteId = await newPersonal(s, s.kevin)
    await s.terence.as.mutation(api.views.set, {
      businessId: s.businessId,
      view: { kind: 'mine' },
    })
    expect(await folder(s, s.terence, 'everyone')).toEqual([])
    expect(
      await s.terence.as.query(api.notes.get, {
        businessId: s.businessId,
        noteId,
      }),
    ).not.toBeNull()
    // Nobody else gets the folder at all — an empty page, not an error.
    expect(await folder(s, s.ann, 'everyone')).toEqual([])
  })

  test('in Recently Deleted: its author’s, and the owner’s in God view only', async () => {
    const s = await setup()
    const noteId = await newPersonal(s, s.kevin)
    await s.kevin.as.mutation(api.notes.softDelete, {
      businessId: s.businessId,
      noteId,
    })

    expect(await folder(s, s.kevin, 'trash')).toEqual([noteId])
    expect(await folder(s, s.ann, 'trash')).not.toContain(noteId)
    expect(await folder(s, s.terence, 'trash')).toEqual([noteId])
    await s.terence.as.mutation(api.views.set, {
      businessId: s.businessId,
      view: { kind: 'mine' },
    })
    expect(await folder(s, s.terence, 'trash')).not.toContain(noteId)
  })

  test('cannot be put on a job, site or client — it is shared first', async () => {
    const s = await setup()
    await expect(
      s.kevin.as.mutation(api.notes.create, {
        businessId: s.businessId,
        visibility: 'private',
        propertyId: s.propertyId,
      }),
    ).rejects.toThrow(/PRIVATE_NOTE_LINK/)

    const noteId = await newPersonal(s, s.kevin)
    await expect(
      s.kevin.as.mutation(api.notes.setLinks, {
        businessId: s.businessId,
        noteId,
        link: { kind: 'property', propertyId: s.propertyId },
      }),
    ).rejects.toThrow(/PRIVATE_NOTE_LINK/)
    // Unlinking what is already unlinked is harmless.
    await s.kevin.as.mutation(api.notes.setLinks, {
      businessId: s.businessId,
      noteId,
      link: { kind: 'none' },
    })
  })

  test('tags nobody: a mention typed into it makes no row and no badge', async () => {
    const s = await setup()
    const noteId = await newPersonal(s, s.kevin)
    await writeBody(s.kevin, noteId, 'Ask Ann', s.annId)

    expect(await mentionRows(s, noteId)).toEqual([])
    expect(
      await s.ann.as.query(api.notes.unreadMentionCount, {
        businessId: s.businessId,
      }),
    ).toBe(0)
    expect(
      await s.ann.as.query(api.notes.listMentions, {
        businessId: s.businessId,
      }),
    ).toEqual([])
  })

  test('a mention row left from before cannot surface it to anyone', async () => {
    const s = await setup()
    const noteId = await newPersonal(s, s.kevin)
    for (const membershipId of [s.annId, s.ownerMembershipId]) {
      await s.t.run((ctx) =>
        ctx.db.insert('noteMentions', {
          businessId: s.businessId,
          noteId,
          membershipId,
          mentionedByMembershipId: s.kevinId,
          createdAt: Date.now(),
        }),
      )
    }
    for (const who of [s.ann, s.terence]) {
      expect(
        await who.as.query(api.notes.unreadMentionCount, {
          businessId: s.businessId,
        }),
      ).toBe(0)
      expect(
        await who.as.query(api.notes.listMentions, {
          businessId: s.businessId,
        }),
      ).toEqual([])
    }
  })
})

describe('sharing and taking back', () => {
  test('sharing puts it in front of the team, with its tags in force', async () => {
    const s = await setup()
    const noteId = await newPersonal(s, s.kevin)
    await writeBody(s.kevin, noteId, 'Ask Ann', s.annId)

    await s.kevin.as.mutation(api.notes.setVisibility, {
      businessId: s.businessId,
      noteId,
      visibility: 'shared',
    })

    expect(await folder(s, s.ann, 'team')).toContain(noteId)
    expect(await folder(s, s.kevin, 'mine')).toEqual([])
    const ann = await s.ann.as.query(api.notes.get, {
      businessId: s.businessId,
      noteId,
    })
    expect(ann).toMatchObject({ private: false, canEdit: true })
    expect((await mentionRows(s, noteId)).map((r) => r.membershipId)).toEqual([
      s.annId,
    ])
    expect(
      await s.ann.as.query(api.notes.unreadMentionCount, {
        businessId: s.businessId,
      }),
    ).toBe(1)
  })

  test('making it personal again takes it off the team and its tags off', async () => {
    const s = await setup()
    const noteId = await s.kevin.as.mutation(api.notes.create, {
      businessId: s.businessId,
    })
    await writeBody(s.kevin, noteId, 'Ask Ann', s.annId)
    expect(await mentionRows(s, noteId)).toHaveLength(1)

    await s.kevin.as.mutation(api.notes.setVisibility, {
      businessId: s.businessId,
      noteId,
      visibility: 'private',
    })

    expect(await mentionRows(s, noteId)).toEqual([])
    expect(
      await s.ann.as.query(api.notes.get, { businessId: s.businessId, noteId }),
    ).toBeNull()
    expect(await folder(s, s.kevin, 'mine')).toEqual([noteId])
  })

  test('only its author decides, and only for a note about nothing in particular', async () => {
    const s = await setup()
    const shared = await s.kevin.as.mutation(api.notes.create, {
      businessId: s.businessId,
    })
    // Ann can read and edit Kevin's team note, but not make it personal.
    await expect(
      s.ann.as.mutation(api.notes.setVisibility, {
        businessId: s.businessId,
        noteId: shared,
        visibility: 'private',
      }),
    ).rejects.toThrow(/NO_ACCESS/)
    // Nor can the owner.
    await expect(
      s.terence.as.mutation(api.notes.setVisibility, {
        businessId: s.businessId,
        noteId: shared,
        visibility: 'private',
      }),
    ).rejects.toThrow(/NO_ACCESS/)

    // A site note is part of the site's record: it stays shared.
    const siteNote = await s.kevin.as.mutation(api.notes.create, {
      businessId: s.businessId,
      propertyId: s.propertyId,
    })
    await expect(
      s.kevin.as.mutation(api.notes.setVisibility, {
        businessId: s.businessId,
        noteId: siteNote,
        visibility: 'private',
      }),
    ).rejects.toThrow(/PRIVATE_NOTE_LINK/)
  })

  test('notes made before personal notes existed stay shared', async () => {
    const s = await setup()
    const noteId = await s.kevin.as.mutation(api.notes.create, {
      businessId: s.businessId,
    })
    const note = await s.t.run((ctx) => ctx.db.get(noteId))
    expect(note).not.toHaveProperty('visibility')
    expect(await folder(s, s.ann, 'team')).toContain(noteId)
  })
})

describe('decided on who is really asking', () => {
  test('the owner working in the author’s account reads it, and cannot write it', async () => {
    const s = await setup()
    const noteId = await newPersonal(s, s.kevin)
    await s.terence.as.mutation(api.views.set, {
      businessId: s.businessId,
      view: { kind: 'account', membershipId: s.kevinId },
    })

    const seen = await s.terence.as.query(api.notes.get, {
      businessId: s.businessId,
      noteId,
    })
    expect(seen).toMatchObject({ mine: false, canEdit: false })
    expect(await folder(s, s.terence, 'mine')).not.toContain(noteId)
    await expect(
      s.terence.as.mutation(api.notes.setVisibility, {
        businessId: s.businessId,
        noteId,
        visibility: 'shared',
      }),
    ).rejects.toThrow(/NO_ACCESS/)
    await expect(
      s.terence.as.mutation(api.notesSync.submitSnapshot, {
        id: noteId,
        version: 9,
        content: '{"type":"doc","content":[]}',
      }),
    ).rejects.toThrow(/NO_ACCESS/)
  })

  test('Everyone’s notes is empty while the owner works in an account or views as someone', async () => {
    const s = await setup()
    const live = await newPersonal(s, s.kevin)
    const binned = await newPersonal(s, s.kevin)
    await s.kevin.as.mutation(api.notes.softDelete, {
      businessId: s.businessId,
      noteId: binned,
    })
    expect(await folder(s, s.terence, 'everyone')).toEqual([live])
    expect(await folder(s, s.terence, 'trash')).toContain(binned)

    await s.terence.as.mutation(api.views.set, {
      businessId: s.businessId,
      view: { kind: 'account', membershipId: s.kevinId },
    })
    expect(await folder(s, s.terence, 'everyone')).toEqual([])
    expect(await folder(s, s.terence, 'trash')).not.toContain(binned)

    await s.terence.as.mutation(api.accountSwitches.stop, {
      businessId: s.businessId,
    })
    // The older read-only "view as", which leaves the chosen view alone.
    await s.t.run((ctx) =>
      ctx.db.patch(s.ownerMembershipId, { viewingAsMembershipId: s.kevinId }),
    )
    expect(await folder(s, s.terence, 'everyone')).toEqual([])
    expect(await folder(s, s.terence, 'trash')).not.toContain(binned)
    expect(
      await s.terence.as.query(api.notes.get, {
        businessId: s.businessId,
        noteId: live,
      }),
    ).toMatchObject({ canEdit: false })
  })

  test('the author’s own contractor gets nothing, even working in their account', async () => {
    const s = await setup()
    const noteId = await newPersonal(s, s.kevin)
    expect(
      await s.jo.as.query(api.notes.get, { businessId: s.businessId, noteId }),
    ).toBeNull()

    await s.jo.as.mutation(api.accountSwitches.start, {
      businessId: s.businessId,
      targetMembershipId: s.kevinId,
    })
    expect(
      await s.jo.as.query(api.notes.get, { businessId: s.businessId, noteId }),
    ).toBeNull()
    expect(await folder(s, s.jo, 'mine')).not.toContain(noteId)
    expect(await folder(s, s.jo, 'all')).not.toContain(noteId)
    await expect(
      s.jo.as.query(api.notesSync.getSnapshot, { id: noteId }),
    ).rejects.toThrow(/NOT_FOUND/)
    await expect(
      s.jo.as.mutation(api.notesSync.submitSnapshot, {
        id: noteId,
        version: 9,
        content: '{"type":"doc","content":[]}',
      }),
    ).rejects.toThrow(/NO_ACCESS/)
  })
})

describe('folder edges', () => {
  test('pinned: the author’s own, never anyone else’s', async () => {
    const s = await setup()
    const noteId = await newPersonal(s, s.kevin)
    await s.kevin.as.mutation(api.notes.togglePin, {
      businessId: s.businessId,
      noteId,
    })
    const pinned = async (who: TestActor) =>
      (
        await who.as.query(api.notes.listPinned, { businessId: s.businessId })
      ).map((n) => n._id)
    expect(await pinned(s.kevin)).toEqual([noteId])
    expect(await pinned(s.terence)).toEqual([])
    expect(await pinned(s.ann)).toEqual([])
  })

  test('the owner’s own personal notes are his, not in Everyone’s notes', async () => {
    const s = await setup()
    const his = await newPersonal(s, s.terence)
    expect(await folder(s, s.terence, 'everyone')).not.toContain(his)
    expect(await folder(s, s.terence, 'mine')).toEqual([his])
  })

  test('searching Everyone’s notes outside God view finds nothing', async () => {
    const s = await setup()
    const noteId = await newPersonal(s, s.kevin)
    await writeBody(s.kevin, noteId, 'Van stock')
    await s.terence.as.mutation(api.views.set, {
      businessId: s.businessId,
      view: { kind: 'mine' },
    })
    const find = (who: TestActor) =>
      who.as.query(api.notes.search, {
        businessId: s.businessId,
        q: 'Van',
        filter: 'everyone',
      })
    expect(await find(s.terence)).toEqual([])
    expect(await find(s.ann)).toEqual([])
  })

  test('your own personal notes cannot crowd a team note out of a Team search', async () => {
    const s = await setup()
    const now = Date.now()
    await s.t.run(async (ctx) => {
      for (let i = 0; i < 45; i++) {
        await ctx.db.insert('notes', {
          businessId: s.businessId,
          authorMembershipId: s.kevinId,
          lastEditedByMembershipId: s.kevinId,
          title: `bait ${i}`,
          preview: '',
          plainText: `bait ${i}`,
          createdAt: now,
          updatedAt: now,
          visibility: 'private',
        })
      }
    })
    const memo = await s.ann.as.mutation(api.notes.create, {
      businessId: s.businessId,
    })
    await writeBody(s.ann, memo, 'Bait supplier number')
    const hits = await s.kevin.as.query(api.notes.search, {
      businessId: s.businessId,
      q: 'bait',
      filter: 'team',
    })
    expect(hits.map((n) => n._id)).toEqual([memo])
  })

  test('no link of any kind on a personal note', async () => {
    const s = await setup()
    const jobId = await s.t.run((ctx) =>
      ctx.db.insert('jobs', {
        businessId: s.businessId,
        propertyId: s.propertyId,
        assignedMembershipId: s.kevinId,
        jobType: 'Termites',
        price: 0,
        scheduledAt: Date.now(),
        durationMinutes: 60,
        status: 'booked',
        createdAt: Date.now(),
      }),
    )
    const property = await s.t.run((ctx) => ctx.db.get(s.propertyId))
    for (const link of [
      { jobId },
      { propertyId: s.propertyId },
      { clientId: property!.clientId },
    ]) {
      await expect(
        s.kevin.as.mutation(api.notes.create, {
          businessId: s.businessId,
          visibility: 'private',
          ...link,
        }),
      ).rejects.toThrow(/PRIVATE_NOTE_LINK/)
    }
    const noteId = await newPersonal(s, s.kevin)
    for (const link of [
      { kind: 'job' as const, jobId },
      { kind: 'client' as const, clientId: property!.clientId },
    ]) {
      await expect(
        s.kevin.as.mutation(api.notes.setLinks, {
          businessId: s.businessId,
          noteId,
          link,
        }),
      ).rejects.toThrow(/PRIVATE_NOTE_LINK/)
    }
  })
})

describe('sharing only what the note says now', () => {
  test('text typed and deleted while personal does not come with it', async () => {
    const s = await setup()
    // Even its first version — the page as it was made — stays behind.
    const noteId = await s.kevin.as.mutation(api.notes.create, {
      businessId: s.businessId,
      visibility: 'private',
      title: 'Alarm 4471 first draft',
    })
    const v0 = (await s.kevin.as.query(api.notesSync.latestVersion, {
      id: noteId,
    }))!
    const typed = JSON.stringify({
      stepType: 'replace',
      from: 1,
      to: 1,
      slice: { content: [{ type: 'text', text: 'Alarm code 4471' }] },
    })
    const erased = JSON.stringify({ stepType: 'replace', from: 1, to: 16 })
    await s.kevin.as.mutation(api.notesSync.submitSteps, {
      id: noteId,
      version: v0,
      clientId: 'k',
      steps: [typed],
    })
    await s.kevin.as.mutation(api.notesSync.submitSteps, {
      id: noteId,
      version: v0 + 1,
      clientId: 'k',
      steps: [erased],
    })
    await s.kevin.as.mutation(api.notesSync.submitSnapshot, {
      id: noteId,
      version: v0 + 2,
      content: JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 1 },
            content: [{ type: 'text', text: 'Shopping' }],
          },
        ],
      }),
    })

    await s.kevin.as.mutation(api.notes.setVisibility, {
      businessId: s.businessId,
      noteId,
      visibility: 'shared',
    })

    for (const version of [0, 1, v0]) {
      const history = await s.ann.as.query(api.notesSync.getSteps, {
        id: noteId,
        version,
      })
      expect(JSON.stringify(history)).not.toContain('4471')
    }
    const now = await s.ann.as.query(api.notesSync.getSnapshot, { id: noteId })
    expect(now.content).toContain('Shopping')
    for (const version of [1, v0]) {
      const old = await s.ann.as.query(api.notesSync.getSnapshot, {
        id: noteId,
        version,
      })
      expect(JSON.stringify(old)).not.toContain('4471')
    }
  })

  test('refused while an edit is newer than the last save', async () => {
    const s = await setup()
    const noteId = await newPersonal(s, s.kevin)
    const v0 = (await s.kevin.as.query(api.notesSync.latestVersion, {
      id: noteId,
    }))!
    await s.kevin.as.mutation(api.notesSync.submitSteps, {
      id: noteId,
      version: v0,
      clientId: 'k',
      steps: [
        JSON.stringify({
          stepType: 'replace',
          from: 1,
          to: 1,
          slice: { content: [{ type: 'text', text: 'Draft' }] },
        }),
      ],
    })
    await expect(
      s.kevin.as.mutation(api.notes.setVisibility, {
        businessId: s.businessId,
        noteId,
        visibility: 'shared',
      }),
    ).rejects.toThrow(/NOTE_SAVING/)
    expect(await folder(s, s.kevin, 'mine')).toEqual([noteId])
  })

  test('its author’s pin comes off', async () => {
    const s = await setup()
    const noteId = await newPersonal(s, s.kevin)
    await s.kevin.as.mutation(api.notes.togglePin, {
      businessId: s.businessId,
      noteId,
    })
    await s.kevin.as.mutation(api.notes.setVisibility, {
      businessId: s.businessId,
      noteId,
      visibility: 'shared',
    })
    expect(
      await s.ann.as.query(api.notes.listPinned, { businessId: s.businessId }),
    ).toEqual([])
  })

  test('not from Recently Deleted', async () => {
    const s = await setup()
    const noteId = await newPersonal(s, s.kevin)
    await s.kevin.as.mutation(api.notes.softDelete, {
      businessId: s.businessId,
      noteId,
    })
    await expect(
      s.kevin.as.mutation(api.notes.setVisibility, {
        businessId: s.businessId,
        noteId,
        visibility: 'shared',
      }),
    ).rejects.toThrow(/NOT_FOUND/)
  })
})
