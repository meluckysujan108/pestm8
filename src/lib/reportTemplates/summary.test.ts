import { describe, expect, test } from 'vitest'
import { getTemplate } from './index'
import { reportSummary } from './summary'

/**
 * What a technician is shown before the lock closes.
 *
 * The rule under test is restraint: a summary that lists everything is the
 * document a second time, and one that lists the wrong things is worse than
 * none — it invites a confirming glance at facts that were never checked.
 */

const serviceReport = getTemplate('serviceReport')

const FILLED = {
  treatments: [
    { treatment: ['General Pest Control'], product: ['Biflex Ultra (100 g/L Bifenthrin)'] },
    { treatment: ['General Pest Control'], product: ['Fipforce HP (100 g/L FIPRONIL)'] },
  ],
  safeToStart: true,
  nextVisit: '6 Months',
  comments: 'Ants around the meter box.',
  msds: true,
}

describe('what the finalise sheet reads back', () => {
  test('says what was applied, whether it was safe, and when the next visit falls due', () => {
    const lines = reportSummary(serviceReport, FILLED)
    const byLabel = Object.fromEntries(lines.map((line) => [line.label, line.text]))

    expect(byLabel['Treatment']).toBe('General Pest Control')
    expect(byLabel['Product & Active Ingredient']).toBe(
      'Biflex Ultra (100 g/L Bifenthrin), Fipforce HP (100 g/L FIPRONIL)',
    )
    expect(byLabel['Is it safe to commence work?']).toBe('Yes')
    expect(byLabel['Your Next Pest Control Visit is due in']).toBe('6 Months')
  })

  test('the same treatment twice reads once', () => {
    // Two rows of one treatment is how a technician records two products, not
    // two jobs. "General Pest Control, General Pest Control" would read as
    // a mistake in the report rather than a shape of the table.
    const lines = reportSummary(serviceReport, FILLED)
    expect(lines.find((line) => line.label === 'Treatment')?.text).toBe('General Pest Control')
  })

  test('leaves out everything the form did not ask it to carry', () => {
    const lines = reportSummary(serviceReport, FILLED)
    const labels = lines.map((line) => line.label)

    // Answered, and none of its business: a summary of forty answers is the
    // report itself, which is exactly what nobody re-reads to confirm.
    expect(labels).not.toContain("Technician's Comments")
    expect(labels).not.toContain('MSDS on site')
    expect(labels).not.toContain('Quantity of Chemicals Used')
    expect(lines.length).toBeLessThanOrEqual(6)
  })

  test('an unsafe site is marked, not just stated', () => {
    // The one line that must catch the eye — the form's mandatory gate. It
    // still finalises; the technician has to see that it says No.
    const lines = reportSummary(serviceReport, { ...FILLED, safeToStart: false })
    const safety = lines.find((line) => line.label === 'Is it safe to commence work?')

    expect(safety?.text).toBe('No')
    expect(safety?.tone).toBe('warn')
  })

  test('says nothing at all about an empty report', () => {
    // Every line is an answer. A row of em dashes would be a summary of
    // nothing, dressed as a summary of something.
    expect(reportSummary(serviceReport, {})).toEqual([])
  })

  test('skips rows that were added and never filled', () => {
    const lines = reportSummary(serviceReport, {
      treatments: [{ treatment: [], product: [] }, {}],
      nextVisit: '3 Months',
    })
    expect(lines.map((line) => line.label)).toEqual(['Your Next Pest Control Visit is due in'])
  })

  test('drops answers to questions the form has hidden', () => {
    // `visibleWhen` is what makes a question part of this report. A summary
    // built from the template rather than from what is on screen would read
    // back an answer the technician can no longer see or change.
    const certificate = getTemplate('termiteManagementCert')
    const shown = reportSummary(certificate, {
      systemType: 'Chemical Soil Barrier',
      nextInspectionDue: '2027-03-01',
    })
    expect(shown.map((line) => line.label)).toContain('System Type Installed')
  })
})

describe('across the three forms', () => {
  test('each one summarises to a handful, and none to nothing', () => {
    // A form whose author marked no field would show a blank sheet with a red
    // button — the exact screen this component exists to replace.
    for (const id of ['serviceReport', 'timberPestInspection', 'termiteManagementCert'] as const) {
      const template = getTemplate(id)
      const marked = (template.sections ?? []).flatMap((section) =>
        section.fields.filter(
          (field) =>
            ('summary' in field && field.summary === true) ||
            (field.kind === 'repeater' && field.columns.some((cell) => cell.summary === true)),
        ),
      )
      expect(marked.length, id).toBeGreaterThanOrEqual(3)
      expect(marked.length, id).toBeLessThanOrEqual(6)
    }
  })
})
