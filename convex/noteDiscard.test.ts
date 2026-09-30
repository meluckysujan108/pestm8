/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest'
import { api } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { emptyDoc, heading } from './lib/richText'
import type { Id } from './_generated/dataModel'
import type { PmNode } from './lib/richText'
import type { TestActor } from '../test/harness'

/**
 * A note made and left empty is cleared away as it is closed
 * (`notes.discardEmpty`, 30 Sept 2026) — and nothing else ever is.
 */

async function join(
  owner: TestActor,
  invitee: TestActor,
  businessId: Id<'businesses'>,
) {
  const { url } = await owner.as.action(api.invitations.create, {
    businessId,
    email: invitee.email,
    role: 'subcontractor',
  })
  await invitee.as.action(api.invitations.redeem, {
    token: url.split('/join/')[1],
  })
}

async function setup() {
  const t = testApp()
  const owner = await createActor(t, { email: 'terence@coastal.test' })
  const { businessId } = await createBusiness(t, owner)
  const kevin = await createActor(t, { email: 'kevin@coastal.test' })
  await join(owner, kevin, businessId)
  const note = (by: TestActor, title: string) =>
    by.as.mutation(api.notes.create, {
      businessId,
      template: 'blank',
      title,
    })
  const exists = async (noteId: Id<'notes'>) =>
    (await t.run((ctx) => ctx.db.get(noteId))) !== null
  const discard = (by: TestActor, noteId: Id<'notes'>) =>
    by.as.mutation(api.notes.discardEmpty, { businessId, noteId })
  return { t, owner, kevin, businessId, note, exists, discard }
}

/**
 * An edit as the editor sends it the moment it is typed, and — unless
 * `saved: false`, the moment before typing stops — the whole body after it.
 */
async function edit(
  who: TestActor,
  noteId: Id<'notes'>,
  body: PmNode,
  { saved = true } = {},
) {
  const version = (await who.as.query(api.notesSync.latestVersion, {
    id: noteId,
  }))!
  await who.as.mutation(api.notesSync.submitSteps, {
    id: noteId,
    version,
    clientId: who.userId,
    steps: [
      JSON.stringify({
        stepType: 'replace',
        from: 1,
        to: 1,
        slice: { content: [{ type: 'text', text: 'R' }] },
      }),
    ],
  })
  if (!saved) return
  await who.as.mutation(api.notesSync.submitSnapshot, {
    id: noteId,
    version: version + 1,
    content: JSON.stringify(body),
  })
}

describe('notes.discardEmpty', () => {
  test('clears away an empty note its writer made', async () => {
    const s = await setup()
    const noteId = await s.note(s.owner, '')
    expect(await s.discard(s.owner, noteId)).toBe(true)
    expect(await s.exists(noteId)).toBe(false)
  })

  test('keeps a note with anything in it', async () => {
    const s = await setup()
    const noteId = await s.note(s.owner, 'Ring first')
    expect(await s.discard(s.owner, noteId)).toBe(false)
    expect(await s.exists(noteId)).toBe(true)
  })

  test('keeps a note typed in whose words are not saved yet', async () => {
    const s = await setup()
    const noteId = await s.note(s.owner, '')
    // The row still reads empty: it follows the saved body, which has not
    // caught up with the edit.
    await edit(s.owner, noteId, emptyDoc(), { saved: false })
    expect(await s.discard(s.owner, noteId)).toBe(false)
    expect(await s.exists(noteId)).toBe(true)
  })

  test('keeps a note whose body has something that is not words', async () => {
    const s = await setup()
    const noteId = await s.note(s.owner, '')
    await edit(s.owner, noteId, {
      type: 'doc',
      content: [
        heading(''),
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: true },
              content: [{ type: 'paragraph' }],
            },
          ],
        },
      ],
    })
    expect(await s.discard(s.owner, noteId)).toBe(false)
    expect(await s.exists(noteId)).toBe(true)
  })

  test('clears away a note typed in and emptied again, once that is saved', async () => {
    const s = await setup()
    const noteId = await s.note(s.owner, '')
    await edit(s.owner, noteId, {
      type: 'doc',
      content: [heading('Ring first')],
    })
    await edit(s.owner, noteId, emptyDoc())
    expect(await s.discard(s.owner, noteId)).toBe(true)
    expect(await s.exists(noteId)).toBe(false)
  })

  test('keeps an empty note someone else wrote, the owner’s included', async () => {
    const s = await setup()
    const kevins = await s.note(s.kevin, '')
    expect(await s.discard(s.owner, kevins)).toBe(false)
    expect(await s.exists(kevins)).toBe(true)
  })

  test('keeps one already in Recently deleted, where it is restored from', async () => {
    const s = await setup()
    const noteId = await s.note(s.owner, '')
    await s.owner.as.mutation(api.notes.softDelete, {
      businessId: s.businessId,
      noteId,
    })
    expect(await s.discard(s.owner, noteId)).toBe(false)
    expect(await s.exists(noteId)).toBe(true)
  })
})

describe('notesSync.submitSnapshot', () => {
  test('refuses a copy older than the newest, and takes the newest again', async () => {
    const s = await setup()
    const noteId = await s.note(s.owner, '')
    const said = (title: string): PmNode => ({
      type: 'doc',
      content: [heading(title)],
    })
    await edit(s.owner, noteId, said('Ring first')) // saved at 2
    await edit(s.owner, noteId, said('Gate code 4521')) // saved at 3
    // A phone that slept through the second edit: nothing it has is newer.
    await expect(
      s.owner.as.mutation(api.notesSync.submitSnapshot, {
        id: noteId,
        version: 2,
        content: JSON.stringify(said('Ring first')),
      }),
    ).rejects.toThrow('SNAPSHOT_SUPERSEDED')
    await s.owner.as.mutation(api.notesSync.submitSnapshot, {
      id: noteId,
      version: 3,
      content: JSON.stringify(said('Gate code 4521')),
    })
    const note = await s.t.run((ctx) => ctx.db.get(noteId))
    expect(note?.title).toBe('Gate code 4521')
  })
})
