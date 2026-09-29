import { describe, expect, test } from 'vitest'
import { reportEmailHtml } from './reportEmail'

/**
 * The email a client opens says what is attached and who it is from, and
 * stops there. Until 29 Sept 2026 it ended "Reply to this email if anything
 * in it needs checking" — an invitation to write back, and every reply is
 * one the business has to answer.
 */

const html = reportEmailHtml({
  businessName: 'Pest M8 Pest Control',
  formName: 'Service Report',
  address: '27 Gemstone Parade, Wellard',
  facts: [
    { label: 'Treatment', value: 'General Pest Control' },
    { label: 'Your Next Pest Control Visit is due in', value: '6-12 Months' },
  ],
})

describe('the report email', () => {
  test('says the report is attached, and who it is from', () => {
    expect(html).toContain(
      'Your Service Report for 27 Gemstone Parade, Wellard',
    )
    expect(html).toContain('The full report is attached as a PDF.')
    expect(html).toContain('Pest M8 Pest Control')
  })

  test('never asks the client to reply or get in touch', () => {
    expect(html).not.toMatch(
      /reply|needs checking|get in touch|contact us|let us know|questions/i,
    )
  })
})
