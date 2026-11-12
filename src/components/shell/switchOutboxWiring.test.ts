// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'

/**
 * What the business switcher and SwitchBanner say of, and do around, the
 * bookings on this phone not sent yet (plan part 2c §11.2, §11.5). There is
 * no DOM renderer here to open the list and answer the question, so this
 * pins the wiring (what the words are: outboxRules.test.ts and
 * leaveAsk.test.ts).
 */
const read = (file: string) =>
  readFileSync(resolve(import.meta.dirname, file), 'utf8')

test('the switcher’s list stays open under the switch’s question (F15)', () => {
  const text = read('BusinessSwitcher.tsx')
  // Asking from the moment the switch is tapped until it is answered…
  expect(text).toMatch(
    /asking\.current = true\s*void confirmLeave\('switchBusiness'\)\.then\(\(go\) => \{\s*asking\.current = false/,
  )
  // …the list doesn't close as focus goes to the question, or a tap on it.
  for (const outside of ['onFocusOutside', 'onInteractOutside']) {
    expect(text).toMatch(
      new RegExp(
        `${outside}=\\{\\(event\\) => \\{\\s*if \\(asking\\.current\\) event\\.preventDefault\\(\\)`,
      ),
    )
  }
  // A refusal shown before is gone once the list is opened again, as when
  // it closes.
  expect(text).toContain(
    '<Popover.Root onOpenChange={() => setRefused(false)}>',
  )
})

test('SwitchBanner says apart those needing a look, which don’t go by themselves (F3)', () => {
  const text = read('SwitchBanner.tsx')
  expect(text).toContain(
    'heldWhileSwitchedWords(unsent.count, unsent.needsLook)',
  )
  // The switcher's row counts them all.
  expect(read('BusinessSwitcher.tsx')).toMatch(/here\.count \+ here\.needsLook/)
})
