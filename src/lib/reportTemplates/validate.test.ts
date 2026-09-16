import { describe, expect, test } from 'vitest'
import { getTemplate, templateFor } from './index'
import { submittablePayload, validateReport } from './validate'

/**
 * These rules decide whether a compliance document may be signed, so they are
 * tested from both directions: what must be refused, and — just as important —
 * what must NOT be. A validator that rejects a legitimately finished report
 * locks a technician out of their own work at the end of a job.
 */

const service = getTemplate('serviceReport')

const COMPLETE = {
  serviceDate: '2026-09-16',
  safeToStart: true,
  technicianSignature: { signedAt: 1789000000000 },
}
const SIGNED = ['technician']

const run = (data: Record<string, unknown>, extra = {}) =>
  validateReport({ template: service, data, signedSlots: SIGNED, ...extra })

describe('what may be signed', () => {
  test('a finished report passes, and hands back what to store', () => {
    const result = run(COMPLETE)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.payload.serviceDate).toBe('2026-09-16')
  })

  test('an empty report is refused, naming each question', () => {
    const result = run({})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.key)).toContain('serviceDate')
      expect(result.issues.map((issue) => issue.key)).toContain('safeToStart')
      expect(result.issues.every((issue) => issue.message.length > 0)).toBe(true)
    }
  })

  test('answering "not safe" is an answer, not a failure', () => {
    // The form's one mandatory gate records a fact. A technician who finds the
    // site unsafe still has to file the report saying so.
    expect(run({ ...COMPLETE, safeToStart: false }).ok).toBe(true)
  })
})

describe('signatures, which are images rather than answers', () => {
  test('a required signature with no image is refused', () => {
    const result = run(COMPLETE, { signedSlots: [] })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.key)).toContain('technicianSignature')
    }
  })

  test('is not checked when the caller cannot see storage', () => {
    // The pure client path has the timestamp but not the slot listing; the
    // server, which has both, is where this rule bites.
    expect(validateReport({ template: service, data: COMPLETE }).ok).toBe(true)
  })
})

describe('answers the app suggested', () => {
  test('are refused until confirmed, in words that say why', () => {
    const result = run(
      { ...COMPLETE, weather: ['Wet'] },
      { prefill: { weather: { source: 'forecast' as const } } },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues[0].message).toMatch(/suggested/i)
      expect(result.issues[0].key).toBe('weather')
    }
  })

  test('pass once confirmed', () => {
    expect(
      run(
        { ...COMPLETE, weather: ['Wet'] },
        { prefill: { weather: { source: 'forecast' as const, confirmedAt: 1789000000000 } } },
      ).ok,
    ).toBe(true)
  })

  test('are ignored when the question is no longer being asked', () => {
    // A suggestion against a hidden question must not block a report that no
    // longer shows it — the technician cannot confirm what they cannot see.
    const cert = getTemplate('termiteManagementCert')
    const result = validateReport({
      template: cert,
      data: {
        installDate: '2026-09-16',
        systemType: 'Chemical Soil Barrier',
        product: 'Termidor HE',
        activeConstituent: 'Fipronil 100g/L',
        reinspectionInterval: '12 months',
        durableNoticeFitted: 'No',
        installerSignature: { signedAt: 1789000000000 },
      },
      signedSlots: ['installer'],
      prefill: { durableNoticeLocation: { source: 'lastVisit' } },
    })
    expect(result.ok).toBe(true)
  })
})

describe('the payload that gets stored', () => {
  test('drops a row left completely empty rather than failing it', () => {
    // An inspection-only visit with a stray "Add Row" tap still finalises,
    // exactly as the Service Report's own validation notes promise.
    const withStrayRow = {
      ...COMPLETE,
      treatments: [{ _id: 'row-1' }],
    }
    const result = run(withStrayRow)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.payload.treatments).toEqual([])
  })

  test('refuses a row that was half filled in', () => {
    const result = run({
      ...COMPLETE,
      treatments: [{ _id: 'row-1', treatment: ['General Pest Control'] }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.map((i) => i.key)).toContain('treatments')
  })

  test('drops answers to questions that are no longer asked', () => {
    const payload = submittablePayload(getTemplate('termiteManagementCert'), {
      durableNoticeFitted: 'No',
      durableNoticeLocation: 'Meter box',
    })
    // "Where was the notice fitted?" is not asked once the answer is "it was
    // not fitted", so a stale answer to it must not reach the document.
    expect(payload.durableNoticeLocation).toBeUndefined()
  })
})

/** A complete v1 Service Report, in v1's own wording. */
const V1_REPORT = {
  serviceDate: '2026-01-05',
  safeToStart: true,
  treatments: [
    {
      _id: 'row-1',
      treatment: ['General Pest Control'],
      product: ['Biflex Ultra (100 g/L Bifenthrin)'],
      quantity: ['100 mL / 10 L'],
      method: ['Hand held battery operated sprayer'],
    },
  ],
  technicianSignature: { signedAt: 1789000000000 },
}

describe('a report written against an older revision', () => {
  test('is judged by the rules it was filled under', () => {
    // v1's Service Report asked for different keys entirely. Judging a v1
    // draft by today's form would refuse a document nobody can now fix.
    const v1 = templateFor('serviceReport', 1)
    const result = validateReport({
      template: v1,
      // v1 wrote its option strings its own way, and wanted at least one
      // treatment row where today's form allows an inspection-only visit.
      data: V1_REPORT,
      signedSlots: ['technician'],
    })
    expect(result.ok).toBe(true)
  })

  test('by rules that differ from today\'s, which is why the revision is kept', () => {
    // v1 demanded at least one treatment row; v2 lets an inspection-only visit
    // finalise. Judging a v1 report by today's form would apply a rule it was
    // never filled under — in this direction, a laxer one.
    const inspectionOnly = { ...V1_REPORT, treatments: [] }
    expect(validateReport({ template: templateFor('serviceReport', 1), data: inspectionOnly, signedSlots: ['technician'] }).ok).toBe(false)
    expect(validateReport({ template: service, data: inspectionOnly, signedSlots: ['technician'] }).ok).toBe(true)
  })

  test('keeps an answer whose option list has since changed', () => {
    // A business can rename a product mid-draft. The control keeps showing the
    // stored answer, and validation must not refuse a report for holding it.
    const renamedSince = {
      ...V1_REPORT,
      treatments: [
        { ...V1_REPORT.treatments[0], product: ['Biflex Ultra — old name'] },
      ],
    }
    expect(validateReport({ template: service, data: renamedSince, signedSlots: ['technician'] }).ok).toBe(true)
  })
})
