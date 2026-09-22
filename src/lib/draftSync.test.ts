import { describe, expect, test } from 'vitest'
import { mergeDraft } from '../../convex/lib/capabilities'
import { draftToSend } from './draftSync'

/**
 * The autosave half of a two-editor draft, run against the server's own merge.
 *
 * `seeded` is what the form padded an empty report with when it opened; the
 * server has stored none of it (a new report is `data: {}`).
 */
const seeded = {
  comments: '',
  chemicals: [],
  areas: [{ area: 'Roof void', status: 'inspected' }],
  visitDate: '2026-09-22',
}

function save(
  payload: Record<string, unknown>,
  base: Record<string, unknown>,
  server: Record<string, unknown>,
) {
  const sent = draftToSend(payload, seeded, base)
  return { sent, merge: mergeDraft(base, server, sent) }
}

describe('saving a new report', () => {
  test('the first answer typed saves, instead of clashing with the padding', () => {
    // The regression: sent against a padded base, this was DRAFT_CONFLICT on
    // `comments` — the server's `undefined` read as someone else's change.
    const { sent, merge } = save(
      { ...seeded, comments: 'Nest behind the meter box' },
      {},
      {},
    )
    expect(sent).toEqual({ comments: 'Nest behind the meter box' })
    expect(merge).toEqual({
      ok: true,
      data: { comments: 'Nest behind the meter box' },
      conflicts: [],
    })
  })

  test('changing a field that was padded with a value saves too', () => {
    const areas = [{ area: 'Roof void', status: 'noAccess', reason: 'Locked' }]
    const { sent, merge } = save({ ...seeded, areas }, {}, {})
    expect(sent).toEqual({ areas })
    expect(merge.ok).toBe(true)
  })

  test('untouched padding is never sent', () => {
    expect(draftToSend(seeded, seeded, {})).toEqual({})
  })
})

describe('two people on one draft', () => {
  test('what someone else filled in stays, when this person never touched it', () => {
    const server = { comments: 'Found by the owner' }
    const { merge } = save({ ...seeded, visitDate: '2026-09-23' }, {}, server)
    expect(merge).toEqual({
      ok: true,
      data: { comments: 'Found by the owner', visitDate: '2026-09-23' },
      conflicts: [],
    })
  })

  test('the same answer given two ways is still the one real clash', () => {
    const { merge } = save(
      { ...seeded, comments: 'Mine' },
      {},
      { comments: 'Theirs' },
    )
    expect(merge).toEqual({ ok: false, conflicts: ['comments'] })
  })
})

describe('answers the server already holds', () => {
  test('are sent as they are, so an untouched one is not an edit', () => {
    const base = { comments: 'On the server' }
    const { sent, merge } = save({ ...seeded, ...base }, base, base)
    expect(sent).toEqual(base)
    expect(merge).toEqual({ ok: true, data: base, conflicts: [] })
  })

  test('clearing one is an edit like any other', () => {
    const base = { comments: 'On the server' }
    const { sent, merge } = save({ ...seeded, comments: '' }, base, base)
    expect(sent).toEqual({ comments: '' })
    expect(merge).toEqual({ ok: true, data: { comments: '' }, conflicts: [] })
  })

  test('and after a save, what was sent is the new base', () => {
    const first = save({ ...seeded, comments: 'abc' }, {}, {})
    const base = first.sent
    // Typed back to empty: it was on the server, so the clear goes through.
    const second = save({ ...seeded, comments: '' }, base, base)
    expect(second.sent).toEqual({ comments: '' })
    expect(second.merge.ok).toBe(true)
  })
})
