// @vitest-environment node
import { describe, expect, test } from 'vitest'
import {
  EDIT_ROW,
  EDIT_TRIGGER,
  editTriggerLabel,
  jobEditChoices,
} from './jobEditChoices'
import type { EditableJob } from './jobEditChoices'

function job(extra: Partial<EditableJob> = {}): EditableJob {
  return {
    canEdit: true,
    status: 'pending',
    pricesHidden: false,
    property: {
      addressLine: '12 Wattle Street',
      client: { name: 'J. Nguyen', kind: 'person' },
    },
    ...extra,
  }
}

const business = job({
  property: {
    addressLine: '14 Kewdale Road',
    client: { name: 'Mahal Mart', kind: 'business' },
  },
})

describe('the rows Edit offers', () => {
  test('a homeowner’s job: the job, the client and the property, each saying where it changes', () => {
    expect(jobEditChoices(job())).toEqual([
      {
        target: 'job',
        title: 'Job details',
        line: 'Date, times, property, who’s going and price — this job.',
      },
      {
        target: 'client',
        title: 'Client details',
        line: 'Name, phone and email — on all of J. Nguyen’s jobs.',
      },
      {
        target: 'property',
        title: 'Property details',
        line: 'Correct the address — on every job at 12 Wattle Street.',
      },
    ])
  })

  test('a business’s job: the contact person, the main phone and the site contact', () => {
    expect(jobEditChoices(business).map((choice) => choice.line)).toEqual([
      'Date, times, property, who’s going and price — this job.',
      'Name, contact person, main phone and email — on all of Mahal Mart’s jobs.',
      'Correct the address or site contact — on every job at 14 Kewdale Road.',
    ])
  })

  test('with prices hidden from the person, the job’s line leaves out price', () => {
    expect(jobEditChoices(job({ pricesHidden: true }))[0].line).toBe(
      'Date, times, property and who’s going — this job.',
    )
  })

  test('none where the job’s Edit doesn’t show: someone else’s job, or an invoiced one', () => {
    expect(jobEditChoices(job({ canEdit: false }))).toEqual([])
    expect(jobEditChoices(job({ status: 'invoiced' }))).toEqual([])
    // Every other status keeps them: moving an invoiced job back out is
    // how its details reopen.
    for (const status of [
      'recurring',
      'pending',
      'booked',
      'completed',
      'cancelled',
    ]) {
      expect(jobEditChoices(job({ status }))).toHaveLength(3)
    }
  })

  test('only the job when its client or property is missing or in the Recycle bin', () => {
    const targets = (j: EditableJob) =>
      jobEditChoices(j).map((choice) => choice.target)
    expect(targets(job({ property: null }))).toEqual(['job'])
    expect(targets(job({ property: undefined }))).toEqual(['job'])
    expect(
      targets(
        job({ property: { addressLine: '12 Wattle Street', client: null } }),
      ),
    ).toEqual(['job', 'property'])
    expect(
      targets(
        job({
          property: {
            addressLine: '12 Wattle Street',
            client: { name: 'J. Nguyen', kind: 'person', deletedAt: 1 },
          },
        }),
      ),
    ).toEqual(['job', 'property'])
    expect(
      targets(
        job({
          property: {
            addressLine: '12 Wattle Street',
            deletedAt: 1,
            client: { name: 'J. Nguyen', kind: 'person' },
          },
        }),
      ),
    ).toEqual(['job', 'client'])
  })

  test('each row is found by the start of its name', () => {
    for (const choice of jobEditChoices(business)) {
      expect(`${choice.title} ${choice.line}`).toMatch(EDIT_ROW[choice.target])
    }
  })

  test('says "client", never "customer", in curly apostrophes', () => {
    for (const j of [job(), business, job({ pricesHidden: true })]) {
      for (const choice of jobEditChoices(j)) {
        expect(`${choice.title} ${choice.line}`).not.toMatch(/customer/i)
        expect(choice.line).not.toContain("'")
      }
    }
  })
})

describe('the Edit button’s name', () => {
  const of = (j: EditableJob) => editTriggerLabel(jobEditChoices(j))

  test('says what it offers, and always starts "Edit job"', () => {
    const names = [
      of(job()),
      of(job({ property: null })),
      of(job({ property: { addressLine: '12 Wattle Street', client: null } })),
      of(
        job({
          property: {
            addressLine: '12 Wattle Street',
            deletedAt: 1,
            client: { name: 'J. Nguyen', kind: 'person' },
          },
        }),
      ),
    ]
    expect(names).toEqual([
      'Edit job, client or property',
      'Edit job details',
      'Edit job or property',
      'Edit job or client',
    ])
    for (const name of names) expect(name).toMatch(EDIT_TRIGGER)
  })

  test('with only the job, as it has always been: "Edit job details"', () => {
    expect(editTriggerLabel([])).toBe('Edit job details')
  })
})
