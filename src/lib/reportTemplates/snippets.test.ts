import { describe, expect, test } from 'vitest'
import { getTemplate } from './index'
import {
  MAX_SNIPPETS_PER_FIELD,
  sameSnippet,
  snippetFields,
  snippetOrder,
  withSnippet,
} from './snippets'

/**
 * Phrases: saved wording for the boxes a technician types into with one thumb.
 *
 * The rules that matter are the small ones. A phrase is ADDED to what is
 * written rather than replacing it, because the standard wording and the one
 * thing that was different about today are both wanted. Two entries nobody can
 * tell apart are worse than a refusal. And a list that needs scrolling is the
 * typing again, one heading lower.
 */

describe('adding a phrase to what is written', () => {
  test('an empty box takes the phrase as it is', () => {
    expect(withSnippet('', 'Keep pets off the treated area for two hours.')).toBe(
      'Keep pets off the treated area for two hours.',
    )
  })

  test('an answer already written keeps it, and gains a paragraph', () => {
    expect(withSnippet('Wasp nest above the meter box.', 'Re-treat in 14 days.')).toBe(
      'Wasp nest above the meter box.\nRe-treat in 14 days.',
    )
  })

  test('a box left with trailing whitespace does not gain a blank line', () => {
    expect(withSnippet('Treated externally.\n\n', 'Re-treat in 14 days.')).toBe(
      'Treated externally.\nRe-treat in 14 days.',
    )
  })
})

describe('the same phrase twice', () => {
  test('is the same phrase however it was typed', () => {
    expect(sameSnippet('Re-treat in 14 days.', '  re-treat in 14 days. ')).toBe(true)
  })

  test('and a different sentence is not', () => {
    expect(sameSnippet('Re-treat in 14 days.', 'Re-treat in 28 days.')).toBe(false)
  })
})

describe('the order they are offered in', () => {
  const rows = [
    { id: 'a', usedCount: 1, createdAt: 100 },
    { id: 'b', usedCount: 9, createdAt: 50 },
    { id: 'c', usedCount: 1, createdAt: 300 },
  ]

  test('what gets used rises', () => {
    expect(snippetOrder(rows).map((row) => row.id)).toEqual(['b', 'c', 'a'])
  })

  test('and among equals, the one just saved leads', () => {
    // It is the one somebody is about to want: they saved it a moment ago.
    const order = snippetOrder(rows).map((row) => row.id)
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('a'))
  })

  test('the input is left alone', () => {
    const before = rows.map((row) => row.id)
    snippetOrder(rows)
    expect(rows.map((row) => row.id)).toEqual(before)
  })
})

describe('which questions have them', () => {
  test('the long-answer boxes, and there are a lot of them', () => {
    const service = snippetFields(getTemplate('serviceReport'))
    expect(service).toContain('comments')
    expect(service).toContain('limitations')

    // The Timber report asks for a comment per conducive condition — which is
    // the case phrases exist for, and the bulk of the twenty-eight the three
    // forms declare between them.
    expect(snippetFields(getTemplate('timberPestInspection')).length).toBe(23)
    expect(
      ['serviceReport', 'timberPestInspection', 'termiteManagementCert'].reduce(
        (total, id) =>
          total + snippetFields(getTemplate(id as 'serviceReport')).length,
        0,
      ),
    ).toBe(28)
    // And enough of them that the per-field cap is the binding one.
    expect(
      snippetFields(getTemplate('timberPestInspection')).length,
    ).toBeGreaterThan(MAX_SNIPPETS_PER_FIELD)
  })

  test('and nothing that is answered by choosing', () => {
    const service = snippetFields(getTemplate('serviceReport'))
    for (const key of ['nextVisit', 'risks', 'treatments', 'safeToStart']) {
      expect(service, key).not.toContain(key)
    }
  })
})
