// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'

/**
 * Every way to sign out goes through `useSignOut` (plan part 2c §11.3, S20):
 * with no signal it says "Signing out needs signal." and clears nothing; it
 * asks about the bookings on this phone not sent yet first; and a sign-out
 * that fails says so, with what the confirm discarded (D27). There is no
 * DOM renderer here to press each screen's button, so this pins all six to
 * the hook, and each button to the amber box just above it that says why
 * it didn't go (useSignOut.test.ts is what the hook does).
 */
const SRC = resolve(import.meta.dirname, '..')

test.each([
  ['routes/$businessSlug/settings/index.tsx', 'login'],
  ['components/onboarding/NoBusiness.tsx', 'login'],
  ['routes/onboarding.tsx', 'login'],
  ['routes/two-step.tsx', 'login'],
  ['routes/join.$token.tsx', 'reload'],
  ['routes/start.$token.tsx', 'reload'],
])('%s signs out through useSignOut, then %s', (file, then) => {
  const text = readFileSync(resolve(SRC, file), 'utf8')
  expect(text).toMatch(
    new RegExp(`useSignOut\\(\\{\\s*then: '${then}',?\\s*\\}\\)`),
  )
  // Nothing of its own that clears the phone or asks the server first.
  expect(text).not.toMatch(/\bbeginSignOut\(/)
  expect(text).not.toMatch(/authClient\.signOut\(/)
  expect(text).not.toMatch(/\bconfirmLeave\(/)
  // Each button says why it didn't go, in the FormAlert just above it.
  const presses = text.split(/\bsignOut\(\)\}?/)
  expect(presses.length).toBeGreaterThan(1)
  for (const before of presses.slice(0, -1)) {
    expect(before).toMatch(
      /\bproblem && [\s\S]{0,80}?<FormAlert[^>]*>\{(?:\w+\.)?problem\}<\/FormAlert>/,
    )
  }
  expect(text).toContain('Signing out…')
  // From the tap, while the question is worked out and up (seconds, at
  // most), each says so and takes no second press, `aria-disabled` so focus
  // can go back to it once the question is answered stay.
  const buttons = text.split(/\bsignOut\(\)\}/).slice(0, -1)
  for (const before of buttons) {
    const button = before.slice(before.lastIndexOf('<button'))
    expect(button).toMatch(
      /aria-disabled=\{(?:\w+\.)?checking \|\| undefined\}/,
    )
  }
  const labels = text.match(/\{[^{}]*\? 'Signing out…'/g) ?? []
  expect(labels.length).toBe(buttons.length)
  for (const label of labels) {
    expect(label).toMatch(/(?:\w+\.)?signingOut \|\| (?:\w+\.)?checking/)
  }
})
