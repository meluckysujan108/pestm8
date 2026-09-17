import { describe, expect, test } from 'vitest'
import { getTemplate } from './index'
import { carryOverFrom, carryOverKeys } from './lastVisit'

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
    for (const key of [
      'serviceDate',
      'startTime',
      'finishTime',
      'weather',
      'gps',
      'comments',
      'technicianSignature',
      'clientSignature',
      'reportPhotos',
    ]) {
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

  test('nothing to carry is an empty offer, not an empty report', () => {
    const carried = carryOverFrom(serviceReport, {}, {})
    expect(carried.labels).toEqual([])
    expect(carried.data).toEqual({})
  })
})
