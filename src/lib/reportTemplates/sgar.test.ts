import { describe, expect, test } from 'vitest'
import { getTemplate } from './index'
import { sgarFollowUp } from './sgar'

/**
 * The one date a finished report knows that nobody has written down.
 *
 * The APVMA suspended second-generation anticoagulant rodenticides on 24 March
 * 2026 with replacement label instructions, one of which is an evaluation
 * within 35 days. The Service Report's method list carries that instruction
 * verbatim, so the report itself can say when somebody has to go back.
 */

const serviceReport = getTemplate('serviceReport')
const TREATED = Date.UTC(2026, 8, 17)
const SGAR = 'SGARS in compliance with the new 35 day ruling'

function withMethod(method: string) {
  return {
    treatments: [
      {
        _id: 'r1',
        treatment: ['Rodents'],
        product: ['Ditrac All Weather Blox (0.05 g/kg Bromadiolone)'],
        quantity: ['Bait Blocks'],
        method: [method],
      },
    ],
  }
}

describe('when a rodent treatment has to be gone back to', () => {
  test('thirty-five days after the treatment, to the day', () => {
    const due = sgarFollowUp(serviceReport, withMethod(SGAR), TREATED, TREATED)
    expect(due).not.toBeNull()
    expect(new Date(due!.dueBy).toISOString().slice(0, 10)).toBe('2026-10-22')
    expect(due!.daysRemaining).toBe(35)
  })

  test('says so even once the date has passed', () => {
    // Late is exactly when somebody needs telling.
    const due = sgarFollowUp(
      serviceReport,
      withMethod(SGAR),
      TREATED,
      TREATED + 40 * 24 * 60 * 60 * 1000,
    )
    expect(due!.daysRemaining).toBeLessThan(0)
  })

  test('says nothing about a treatment that used something else', () => {
    expect(
      sgarFollowUp(serviceReport, withMethod('Hand Compression Sprayer'), TREATED),
    ).toBeNull()
  })

  test('says nothing about a report with no treatments at all', () => {
    expect(sgarFollowUp(serviceReport, { treatments: [] }, TREATED)).toBeNull()
  })

  test('says nothing about a draft, which has no treatment date yet', () => {
    // Counted from when the work was done, so a report that has not been
    // locked has nothing to count from.
    expect(sgarFollowUp(serviceReport, withMethod(SGAR), undefined)).toBeNull()
  })
})
