import { describe, expect, test } from 'vitest'
import { fieldsOf, getTemplate, templateFor } from '../index'
import { migrateServiceReportV1, valueMigrations } from './serviceReport.migrate'

/** Letters and digits only, lower-cased — "100 mL / 10 L" and "100ml/10L" agree. */
const squash = (text: string) =>
  text
    .toLowerCase()
    .replace(/\bthe\b|\bnew\b/g, '')
    .replace(/litres/g, 'l')
    .replace(/[^a-z0-9]+/g, '')

const numbers = (text: string) => text.match(/\d+(?:\.\d+)?/g) ?? []

/** Dice coefficient over character bigrams: 1 for identical, near 0 for unrelated. */
function similarity(a: string, b: string): number {
  const grams = (s: string) => {
    const out = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i += 1) {
      const g = s.slice(i, i + 2)
      out.set(g, (out.get(g) ?? 0) + 1)
    }
    return out
  }
  const x = grams(squash(a))
  const y = grams(squash(b))
  let shared = 0
  for (const [g, n] of x) shared += Math.min(n, y.get(g) ?? 0)
  const total = [...x.values()].reduce((t, n) => t + n, 0) + [...y.values()].reduce((t, n) => t + n, 0)
  return total === 0 ? 1 : (2 * shared) / total
}

describe('v1 Service Report answers carry across', () => {
  const maps = valueMigrations()

  test('every v1 answer list maps onto the v2 list of the same length', () => {
    const lists = (t: ReturnType<typeof getTemplate>) =>
      Object.fromEntries(
        fieldsOf(t).flatMap((f) =>
          f.kind === 'repeater'
            ? f.columns.filter((c) => 'options' in c).map((c) => [`${f.key}.${c.key}`, 'options' in c ? c.options.length : 0])
            : 'options' in f
              ? [[f.key, f.options.length]]
              : [],
        ),
      )
    expect(lists(templateFor('serviceReport', 1))).toEqual(lists(getTemplate('serviceReport')))
    expect([...maps.keys()].sort()).toEqual(
      ['housekeeping', 'nextVisit', 'riskActions', 'risks', 'treatments.method', 'treatments.product', 'treatments.quantity', 'treatments.treatment', 'weather'],
    )
  })

  test('each pair is the same answer re-worded, not a neighbour after a reorder', () => {
    for (const [path, pairs] of maps) {
      for (const [from, to] of pairs) {
        const at = `${path}: "${from}" -> "${to}"`
        // Numbers are the answer in "60ml/10L" or "3-6 Months" — a neighbour
        // one row away reads almost identically, so they must match outright.
        expect(numbers(to), at).toEqual(numbers(from))
        expect(similarity(from, to), at).toBeGreaterThanOrEqual(0.6)
      }
    }
  })

  test('every target is an option on the v2 form', () => {
    const v2 = new Map<string, Set<string>>()
    for (const f of fieldsOf(getTemplate('serviceReport'))) {
      if (f.kind === 'repeater') {
        for (const c of f.columns) if ('options' in c) v2.set(`${f.key}.${c.key}`, new Set(c.options.map((o) => o.value)))
      } else if ('options' in f) v2.set(f.key, new Set(f.options.map((o) => o.value)))
    }
    for (const [path, pairs] of maps) {
      for (const to of pairs.values()) expect(v2.get(path)?.has(to), `${path}: ${to}`).toBe(true)
    }
  })

  test('a realistic draft switches cleanly', () => {
    const { data, unmapped, clearedSignatures } = migrateServiceReportV1(
      {
        serviceDate: '2026-08-28',
        weather: ['Sunny'],
        treatments: [
          {
            _id: 'row1',
            treatment: ['General Pest Control'],
            product: ['Fipforce HP (100 g/L Fipronil)'],
            quantity: ['100 mL / 10 L'],
            method: ['SGARs in compliance with the 35 day ruling'],
          },
        ],
        risks: ['No risk — safe access given', 'A dog called Rex'],
        nextVisit: '3–6 months',
        msds: true,
        emailReportTo: 'a@example.com, b@example.com',
        technicianSignature: { signedAt: 1 },
      },
      { hasReportPhotos: true },
    )
    expect(data.treatments).toEqual([
      {
        _id: 'row1',
        treatment: ['General Pest Control'],
        product: ['Fipforce HP (100 g/L FIPRONIL)'],
        quantity: ['100ml/10L'],
        method: ['SGARS in compliance with the new 35 day ruling'],
      },
    ])
    expect(data.risks).toEqual(['No Risk Safe Access Given', 'A dog called Rex'])
    expect(data.nextVisit).toBe('3-6 Months')
    expect(data.msds).toBe(true)
    expect(data.emailReportTo).toEqual(['a@example.com', 'b@example.com'])
    expect(data.addPhotos).toBe(true)
    expect(data.technicianSignature).toBeUndefined()
    expect(clearedSignatures).toBe(true)
    expect(unmapped).toEqual([{ path: 'risks', value: 'A dog called Rex' }])
  })
})
