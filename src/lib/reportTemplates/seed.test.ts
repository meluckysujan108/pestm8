import { describe, expect, test } from 'vitest'
import { getTemplate } from './index'
import { seedFromContext } from './seed'
import { suggestTemplate, treatmentForJobType } from './suggest'
import { weatherAnswerFrom } from './weatherAnswer'

/**
 * The promise under test: a report started from a job asks for nothing the
 * app already knows, and never claims something it merely guessed.
 *
 * So each case checks two things at once — what landed in the answers, and
 * whether it was recorded as a suggestion. A fact in `prefill` would nag the
 * technician to confirm what their own records already said; a guess missing
 * from it would print under their signature unseen.
 */

const TODAY = '2026-09-16'

describe('seeding a service report from its job', () => {
  const template = getTemplate('serviceReport')

  test('takes the date from the job, not from the day it is written up', () => {
    const { data, prefill } = seedFromContext(template, {
      today: '2026-09-17',
      jobDate: '2026-09-16',
    })
    expect(data.serviceDate).toBe('2026-09-16')
    expect(prefill.serviceDate).toBeUndefined()
  })

  test('falls back to today when the report has no job behind it', () => {
    const { data } = seedFromContext(template, { today: TODAY })
    expect(data.serviceDate).toBe(TODAY)
  })

  test('a real start beats a booked one, and only the booked one needs confirming', () => {
    const booked = seedFromContext(template, {
      today: TODAY,
      scheduledTime: '09:30',
    })
    expect(booked.data.startTime).toBe('09:30')
    expect(booked.prefill.startTime).toEqual({ source: 'scheduled' })

    const started = seedFromContext(template, {
      today: TODAY,
      scheduledTime: '09:30',
      startedTime: '09:47',
    })
    expect(started.data.startTime).toBe('09:47')
    expect(started.prefill.startTime).toBeUndefined()
  })

  test('offers to email the client exactly when there is an address', () => {
    expect(
      seedFromContext(template, { today: TODAY, clientEmail: 'client@example.com' }).data.sendCopy,
    ).toBe(true)
    expect(seedFromContext(template, { today: TODAY, clientEmail: null }).data.sendCopy).toBe(false)
  })

  test('never answers whether it is safe to commence work', () => {
    const { data, prefill } = seedFromContext(template, {
      today: TODAY,
      jobType: 'General Pest Control',
      clientEmail: 'client@example.com',
    })
    expect(data.safeToStart).toBeUndefined()
    expect(prefill.safeToStart).toBeUndefined()
  })

  test('names the technician the job is assigned to', () => {
    const { data, prefill } = seedFromContext(template, {
      today: TODAY,
      jobAssigneeMembershipId: 'membership_kevin',
      authorMembershipId: 'membership_terence',
    })
    // The form asks who did the work, not who typed it up.
    expect(data.technician).toBe('membership_kevin')
    expect(prefill.technician).toBeUndefined()
  })

  test('starts the treatment grid on the job type, in the form own words', () => {
    const { data } = seedFromContext(template, { today: TODAY, jobType: 'Cockroaches' })
    const rows = data.treatments as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0].treatment).toEqual(['Cockroach Treatment'])
    // The other three columns stay for the technician: what was applied, how
    // much and how are not deducible from a booking.
    expect(rows[0].product).toBeUndefined()
  })

  test('leaves the grid empty for a job type the form has no treatment for', () => {
    expect(seedFromContext(template, { today: TODAY, jobType: 'Bed Bugs' }).data.treatments).toBeUndefined()
  })

  test('suggests the weather, and records that it was a guess', () => {
    const { data, prefill } = seedFromContext(template, {
      today: TODAY,
      forecast: { rainMm: 6, windKmh: 12, code: 61 },
    })
    expect(data.weather).toEqual(['Wet'])
    expect(prefill.weather).toEqual({ source: 'forecast' })
  })

  test('adds Evening from the hour work began, alongside the sky', () => {
    const { data } = seedFromContext(template, {
      today: TODAY,
      startedTime: '17:40',
      forecast: { code: 0 },
    })
    expect(data.weather).toEqual(['Sunny', 'Evening'])
  })

  test('says nothing about the weather when there is no forecast', () => {
    const { data, prefill } = seedFromContext(template, { today: TODAY, forecast: null })
    expect(data.weather).toBeUndefined()
    expect(prefill.weather).toBeUndefined()
  })

  test('fills blanks only, so re-seeding an edited draft changes nothing', () => {
    const existing = { serviceDate: '2026-01-05', weather: ['Overcast'], sendCopy: false }
    const { data, prefill } = seedFromContext(
      template,
      { today: TODAY, jobDate: '2026-09-16', clientEmail: 'a@example.com', forecast: { rainMm: 9 } },
      existing,
    )
    expect(data.serviceDate).toBeUndefined()
    expect(data.weather).toBeUndefined()
    expect(data.sendCopy).toBeUndefined()
    expect(prefill.weather).toBeUndefined()
  })
})

describe('seeding the AS forms', () => {
  test('the timber inspection takes its date, time and single weather word', () => {
    const { data, prefill } = seedFromContext(getTemplate('timberPestInspection'), {
      today: TODAY,
      jobDate: '2026-09-16',
      scheduledTime: '08:00',
      forecast: { rainMm: 0, windKmh: 30 },
    })
    expect(data.inspectionDate).toBe('2026-09-16')
    expect(data.inspectionTime).toBe('08:00')
    // A radio holds one word, not a list — the same question, a different control.
    expect(data.weatherConditions).toBe('Windy')
    expect(prefill.weatherConditions).toEqual({ source: 'forecast' })
  })

  test('the certificate seeds its own installer field from the job assignee', () => {
    const { data } = seedFromContext(getTemplate('termiteManagementCert'), {
      today: TODAY,
      jobAssigneeMembershipId: 'membership_kevin',
    })
    expect(data.installer).toBe('membership_kevin')
    expect(data.installDate).toBe(TODAY)
  })
})

describe('reading the forecast in a form own words', () => {
  const FIVE = ['Overcast', 'Wet', 'Sunny', 'Windy', 'Evening']
  const SEVEN = ['Dry', 'Prolonged Dry Period', 'Wet', 'Prolonged Wet Period', 'Overcast', 'Windy', 'Sunny']

  test('wind outranks rain, because it decides whether spraying happens at all', () => {
    expect(weatherAnswerFrom({ rainMm: 9, windKmh: 40 }, FIVE)).toEqual(['Windy', 'Wet'])
  })

  test('falls back to Dry only on a form that offers it', () => {
    expect(weatherAnswerFrom({ rainMm: 0, windKmh: 3, code: 45 }, SEVEN)).toEqual(['Dry'])
    expect(weatherAnswerFrom({ rainMm: 0, windKmh: 3, code: 45 }, FIVE)).toEqual([])
  })

  test('never guesses a prolonged period from one day of forecast', () => {
    const answers = [
      weatherAnswerFrom({ rainMm: 40 }, SEVEN),
      weatherAnswerFrom({ rainMm: 0, code: 0 }, SEVEN),
    ].flat()
    expect(answers.filter((word) => word.startsWith('Prolonged'))).toEqual([])
  })

  test('offers nothing at all without a forecast', () => {
    expect(weatherAnswerFrom(undefined, FIVE)).toEqual([])
    expect(weatherAnswerFrom(null, SEVEN)).toEqual([])
  })
})

describe('which form a job suggests', () => {
  test('maps the schedule vocabulary to the three forms', () => {
    expect(suggestTemplate('General Pest Control')).toBe('serviceReport')
    expect(suggestTemplate('Termite Inspection')).toBe('timberPestInspection')
    expect(suggestTemplate('Termite Treatment')).toBe('termiteManagementCert')
  })

  test('reads a renamed job type rather than guessing wrong', () => {
    expect(suggestTemplate('Annual Termite Inspection (Warranty)')).toBe('timberPestInspection')
    expect(suggestTemplate('Rodent Bait Top-Up')).toBeNull()
    expect(suggestTemplate(undefined)).toBeNull()
  })

  test('has no treatment for a pest the service report does not list', () => {
    expect(treatmentForJobType('Bed Bugs')).toBeNull()
    expect(treatmentForJobType('Ants')).toBe('Ant Full Block Spray')
  })
})
