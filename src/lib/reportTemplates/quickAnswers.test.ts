import { describe, expect, test } from 'vitest'
import { getTemplate, sectionsOf } from './index'
import { quickAnswersFor } from './quickAnswers'
import type { FieldDef } from './types'

/**
 * A one-tap answer is only defensible while it is honest: it must say what it
 * fills, fill nothing the technician already answered, and never answer the
 * question the form makes mandatory.
 */

const timberSection7 = sectionsOf(getTemplate('timberPestInspection')).find(
  (section) => section.id === 'conduciveConditions',
)!

describe('nothing found, on a clean inspection', () => {
  test('answers each row with the word that form uses for "no problem"', () => {
    const patch = quickAnswersFor(timberSection7.fields, 'allClear', {})

    // The forms disagree about which word is the clear one, which is why this
    // is derived from each field's own flags rather than listed.
    expect(patch.waterLeaks).toBe(false)
    expect(patch.siteDrainage).toBe('Adequate')
    expect(patch.slabEdgeExposure).toBe('Yes')
  })

  test('settles most of the section in one tap', () => {
    const patch = quickAnswersFor(timberSection7.fields, 'allClear', {})
    expect(Object.keys(patch).length).toBeGreaterThanOrEqual(10)
  })

  test('leaves comments and photos alone — they are not yes/no claims', () => {
    const patch = quickAnswersFor(timberSection7.fields, 'allClear', {})
    expect(Object.keys(patch).some((key) => key.toLowerCase().includes('comments'))).toBe(false)
    expect(Object.keys(patch).some((key) => key.toLowerCase().includes('photos'))).toBe(false)
  })

  test('never overwrites an answer already given', () => {
    const patch = quickAnswersFor(timberSection7.fields, 'allClear', {
      siteDrainage: 'Inadequate',
      waterLeaks: true,
    })
    expect(patch.siteDrainage).toBeUndefined()
    expect(patch.waterLeaks).toBeUndefined()
  })
})

describe('yes to all, on the safety checklist', () => {
  const service = getTemplate('serviceReport')
  const safety = sectionsOf(service).find((section) =>
    section.fields.some((field) => field.key === 'safetyChecklists'),
  )!
  const group = groupAfter(safety.fields, 'safetyChecklists')

  test('answers the checks yes', () => {
    const patch = quickAnswersFor(group, 'allYes', {})
    expect(patch.msds).toBe(true)
    expect(patch.ppe).toBe(true)
    expect(Object.values(patch).every((value) => value === true)).toBe(true)
  })

  test('never answers whether it is safe to commence work', () => {
    // The form's one mandatory gate. An app that answers it has defeated it —
    // and it sits in the same group, so this is a rule, not an accident of
    // where the fields happen to be.
    expect(safety.fields.some((field) => field.semantic === 'safetyGate')).toBe(true)
    expect(quickAnswersFor(safety.fields, 'allYes', {}).safeToStart).toBeUndefined()
  })
})

function groupAfter(fields: Array<FieldDef>, headingKey: string): Array<FieldDef> {
  const start = fields.findIndex((field) => field.key === headingKey)
  const rest = fields.slice(start + 1)
  const next = rest.findIndex((field) => field.kind === 'heading')
  return next === -1 ? rest : rest.slice(0, next)
}
