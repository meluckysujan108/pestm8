import { describe, expect, test } from 'vitest'
import { fieldsOf, getTemplate } from './index'
import { canCarryFrom, carryOverFrom, carryOverKeys } from './lastVisit'

/**
 * What a return visit inherits, and what it must not.
 *
 * The line here is the whole safety of the feature: an answer about the PLACE
 * is still true three months later, an answer about the DAY is not — and a
 * stale one under a signature is worse than a blank, because a blank is
 * obviously unanswered and "Sunny, 9:15 am" reads as observed.
 */

const serviceReport = getTemplate('serviceReport')
const timber = getTemplate('timberPestInspection')

describe('what the forms say carries over', () => {
  test('the service report carries the work and the advice', () => {
    expect(carryOverKeys(serviceReport)).toEqual([
      'treatments',
      'risks',
      'riskActions',
      'housekeeping',
      'limitations',
      'nextVisit',
    ])
  })

  test('the timber inspection carries the building, which does not move', () => {
    expect(carryOverKeys(timber)).toEqual([
      'facadeFaces',
      'siteTopography',
      'structureType',
      'structureHeight',
      'wallConstruction',
      'floorType',
      'roofType',
    ])
  })

  test('nothing about the day itself is ever carried', () => {
    const carried = new Set([
      ...carryOverKeys(serviceReport),
      ...carryOverKeys(timber),
    ])
    // Real keys, checked against the templates: asserting on a key no form
    // declares passes whatever the code does, which is the opposite of what
    // this test is for.
    const declared = new Set(fieldsOf(serviceReport).map((field) => field.key))
    for (const key of [
      'serviceDate',
      'startTime',
      'finishTime',
      'weather',
      'location',
      'comments',
      'technicianSignature',
      'clientSignature',
      'coverPhoto',
      'photos',
    ]) {
      expect(declared.has(key), `${key} is not a field on the service report`).toBe(true)
      expect(carried.has(key), key).toBe(false)
    }
  })
})

describe('copying from the last visit', () => {
  const previous = {
    treatments: [
      { _id: 'old-row', treatment: ['Ants'], product: ['Fipforce HP'], quantity: [], method: [] },
    ],
    nextVisit: '3 Months',
    comments: 'Dog in the back yard, call ahead.',
    serviceDate: '2026-03-12',
    housekeeping: [],
  }

  test('it offers last visit’s work, marked as a suggestion', () => {
    const carried = carryOverFrom(serviceReport, previous, {})
    expect(Object.keys(carried.data).sort()).toEqual(['nextVisit', 'treatments'])
    expect(carried.prefill.nextVisit).toEqual({ source: 'lastVisit' })
    expect(carried.labels).toContain('Your Next Pest Control Visit is due in')
  })

  test('a note about that day stays on that day', () => {
    const carried = carryOverFrom(serviceReport, previous, {})
    expect(carried.data.comments).toBeUndefined()
    expect(carried.data.serviceDate).toBeUndefined()
  })

  test('an answer already given is never overwritten', () => {
    const carried = carryOverFrom(serviceReport, previous, { nextVisit: '6 Months' })
    expect(carried.data.nextVisit).toBeUndefined()
    expect(carried.labels).not.toContain('Your Next Pest Control Visit is due in')
  })

  test('a blank last time is nothing to offer', () => {
    // `housekeeping` was left empty on the previous report, and an empty array
    // copied forward would read as "considered, nothing needed".
    const carried = carryOverFrom(serviceReport, previous, {})
    expect('housekeeping' in carried.data).toBe(false)
  })

  test('copied rows get their own ids', () => {
    const carried = carryOverFrom(serviceReport, previous, {})
    const rows = carried.data.treatments as Array<{ _id: string; product: Array<string> }>
    expect(rows[0].product).toEqual(['Fipforce HP'])
    // Two reports whose rows answer to the same name is how an edit to one
    // lands in the other.
    expect(rows[0]._id).not.toBe('old-row')
  })

  test('a row the job seeded keeps its own treatment and gains the rest', () => {
    // The case that matters most. A service report started from a General Pest
    // Control job arrives with one row whose Treatment is ticked from the job
    // type and whose product, quantity and method are blank — the three
    // answers a technician most wants filled. Today's treatment is a fact off
    // today's job; last visit's is a guess about the same site, so the fact
    // stays and the guess fills the cells beside it.
    const seeded = {
      treatments: [
        { _id: 'today', treatment: ['General Pest Control'], product: [], quantity: [], method: [] },
      ],
    }
    const carried = carryOverFrom(serviceReport, previous, seeded)
    const rows = carried.data.treatments as Array<Record<string, unknown>>

    expect(rows).toHaveLength(1)
    expect(rows[0].treatment).toEqual(['General Pest Control'])
    expect(rows[0].product).toEqual(['Fipforce HP'])
    // The same row, so a technician editing it is editing what they can see.
    expect(rows[0]._id).toBe('today')
  })

  test('a row already finished is left exactly as it is', () => {
    const done = {
      treatments: [
        {
          _id: 'today',
          treatment: ['Wasps'],
          product: ['Something else'],
          quantity: ['5 L'],
          method: ['Dust'],
        },
      ],
    }
    const carried = carryOverFrom(serviceReport, previous, done)
    expect('treatments' in carried.data).toBe(false)
  })

  test('last visit’s extra rows arrive only while nothing here is finished', () => {
    const twoLastTime = {
      treatments: [
        { _id: 'a', treatment: ['Ants'], product: ['P1'], quantity: ['Q'], method: ['M'] },
        { _id: 'b', treatment: ['Spiders'], product: ['P2'], quantity: ['Q'], method: ['M'] },
      ],
    }

    // Nothing finished here: the second row is a head start.
    const blank = carryOverFrom(serviceReport, twoLastTime, {
      treatments: [
        { _id: 'today', treatment: ['Ants'], product: [], quantity: [], method: [] },
      ],
    })
    expect((blank.data.treatments as Array<unknown>).length).toBe(2)

    // A finished row here: adding to a table somebody is filling in is a
    // rearrangement, not a head start.
    const started = carryOverFrom(serviceReport, twoLastTime, {
      treatments: [
        { _id: 'today', treatment: ['Ants'], product: ['P1'], quantity: ['Q'], method: ['M'] },
      ],
    })
    expect('treatments' in started.data).toBe(false)
  })

  test('nothing to carry is an empty offer, not an empty report', () => {
    const carried = carryOverFrom(serviceReport, {}, {})
    expect(carried.labels).toEqual([])
    expect(carried.data).toEqual({})
  })
})

describe('which report counts as the last visit', () => {
  const draft = { id: 'draft', templateRef: 'serviceReport', templateVersion: 2 }
  const signed = {
    id: 'older',
    templateRef: 'serviceReport',
    templateVersion: 2,
    status: 'finalised',
    deleted: false,
  }

  test('the same form, signed, at the same site', () => {
    expect(canCarryFrom(draft, signed)).toBe(true)
  })

  test('never itself', () => {
    expect(canCarryFrom(draft, { ...signed, id: 'draft' })).toBe(false)
  })

  test('never a draft — there is nothing settled to copy', () => {
    expect(canCarryFrom(draft, { ...signed, status: 'draft' })).toBe(false)
  })

  test('never one in the bin', () => {
    expect(canCarryFrom(draft, { ...signed, deleted: true })).toBe(false)
  })

  test('never a different form', () => {
    // Last year's timber inspection has nothing to say to this month's
    // service report, and their keys do not correspond.
    expect(canCarryFrom(draft, { ...signed, templateRef: 'timberPestInspection' })).toBe(
      false,
    )
  })

  test('never a report signed against the old wording', () => {
    // v1 holds 'Fipforce HP (100 g/L Fipronil)' where v2 says FIPRONIL, and
    // '100 mL / 10 L' where v2 says '100ml/10L'. Carried into a v2 draft those
    // are answers in no list it offers, arriving as suggestions on a document
    // somebody signs.
    expect(canCarryFrom(draft, { ...signed, templateVersion: 1 })).toBe(false)
  })

  test('a missing version reads as 1 on both sides', () => {
    // Every report predating the stamp was backfilled to 1; one that slipped
    // through must not be treated as matching a v2 draft.
    expect(canCarryFrom(draft, { ...signed, templateVersion: undefined })).toBe(false)
    expect(
      canCarryFrom(
        { ...draft, templateVersion: undefined },
        { ...signed, templateVersion: undefined },
      ),
    ).toBe(true)
  })
})
