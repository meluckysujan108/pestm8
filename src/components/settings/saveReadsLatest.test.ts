// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A save behind `warnings.guard` can run seconds after Save was pressed: the
 * address or email domain check answers first, and the person may keep
 * typing meanwhile. A save that closes over the form as it was at the press
 * sends what is no longer in the fields — Branding saved the phone number
 * from before an edit the button then called "Saved", and Team minted the
 * single-use invite link for the address from before a typo was fixed.
 *
 * So the save reads the form through `useLatest`, when it runs. There is no
 * DOM renderer in these tests to press the button and type during the
 * check, so this pins the rule where it is written: each guarded save reads
 * `.current`, and names no form value directly.
 */
const here = import.meta.dirname

/** The text of each `warnings.guard(…)` call in `source`. */
function guardedSaves(source: string): Array<string> {
  const calls: Array<string> = []
  let from = 0
  for (;;) {
    const start = source.indexOf('warnings.guard(', from)
    if (start === -1) return calls
    let depth = 0
    let end = start + 'warnings.guard'.length
    do {
      if (source[end] === '(') depth++
      if (source[end] === ')') depth--
      end++
    } while (depth > 0 && end < source.length)
    calls.push(source.slice(start, end))
    from = end
  }
}

/** A form value named bare in the save — not as a property of what
 * `useLatest` holds (`.phone`), and not as the key it is sent under
 * (`phone:`). */
const bare = (name: string) => new RegExp(`(?<![.\\w])${name}\\b(?!\\s*:)`)

const FORMS: Record<string, ReadonlyArray<RegExp>> = {
  'BusinessSection.tsx': [
    'values',
    'edits',
    'address',
    'phone',
    'email',
    'licenceNumber',
    'name',
    'tradingName',
    'state',
    'abn',
    'website',
  ].map(bare),
  'TeamSection.tsx': ['email', 'inviteRole'].map(bare),
  'MyDetails.tsx': ['name', 'phone'].map(bare),
  'ReportSettingsForm.tsx': ['title', 'copy', 'settings'].map(bare),
  // Set-up's letterhead and invite, the same forms in another place.
  '../onboarding/BrandStep.tsx': ['phone', 'email', 'address'].map(bare),
  '../onboarding/TeamStep.tsx': ['email'].map(bare),
}

describe('settings forms save what is in the fields when the save runs', () => {
  for (const [file, values] of Object.entries(FORMS)) {
    it(file, () => {
      const saves = guardedSaves(readFileSync(resolve(here, file), 'utf8'))
      expect(saves).toHaveLength(1)
      const [save] = saves
      expect(save).toMatch(/\.current\b/)
      for (const value of values) expect(save).not.toMatch(value)
    })
  }
})
