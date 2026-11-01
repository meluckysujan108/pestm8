// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * What a matching fix moves, and what keeps the person's eye and thumb on
 * it (the matching plan's §2.9–2.10), and what goes with an Open or a Save
 * in Clients → New client. The hooks and helpers are tested on their own
 * (`useIntoViewOnOpen` in clientSheetOpening.test.ts, `useLineFixHold` in
 * useMatchLines.test.ts, `openFromNewClient` in clientMatchRows.test.ts,
 * `answerOnceRead` in NewPropertySheet.test.tsx); there is no DOM renderer
 * in these tests to open a sheet or tap a line's fix, so this pins where
 * each is put to work.
 */
const here = import.meta.dirname
const source = (path: string) => readFileSync(resolve(here, path), 'utf8')

/** The text of the function `name` in `text`, up to the next top-level one. */
function functionText(text: string, name: string): string {
  const start = text.indexOf(`function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  const next = text.slice(start + 1).search(/\n(?:export )?(?:function|const) /)
  return next === -1 ? text.slice(start) : text.slice(start, start + 1 + next)
}

describe('Add property opened from Clients → New client', () => {
  test('brings its form into view as it opens on the address given, and only then', () => {
    const form = functionText(
      source('./ClientSheet.tsx'),
      'NewPropertyForClientForm',
    )
    expect(form).toContain('useIntoViewOnOpen(form, initial !== undefined)')
    expect(form).toMatch(/<form\s+ref=\{form\}/)
  })

  test('an address picked from the suggestions there is still picked: “Street found”, not looked up again', () => {
    // Taken from what was typed as Open is tapped (`openFromNewClient`
    // carries it into `addSite`).
    expect(source('./NewPropertySheet.tsx')).toMatch(
      /openFromNewClient\(index, directory\.contacts, fix, \{[^}]*addressCheck: typed\.addressCheck,/,
    )
    const form = functionText(
      source('./ClientSheet.tsx'),
      'NewPropertyForClientForm',
    )
    expect(form).toMatch(
      /useState<AddressCheck>\(\s*initial\?\.addressCheck \?\? 'typed',?\s*\)/,
    )
    expect(form).toContain("picked={initial?.addressCheck === 'picked'}")
    expect(functionText(source('./ClientSheet.tsx'), 'PropertyFields')).toMatch(
      /<VerifiedAddressFields[^>]*\spicked=\{picked\}/,
    )
  })
})

describe('Clients → New client, a Save waiting for the client list', () => {
  test('goes with its press: given up on at 3 s (`answerOnceRead`, with the check’s signal), or as the sheet is cleared', () => {
    const sheet = source('./NewPropertySheet.tsx')
    expect(sheet).toMatch(
      /: \(signal\) =>\s+answerOnceRead\(waitingForList\.current, signal,/,
    )
    expect(sheet).toMatch(
      /function clear\(\) \{[^}]*waitingForList\.current = \[\]/,
    )
  })
})

describe('New Job, once a line’s fix is taken', () => {
  test('the form takes no tap for a moment, mousedown and click alike', () => {
    const sheet = functionText(
      source('../schedule/NewJobSheet.tsx'),
      'NewJobForm',
    )
    expect(sheet).toContain('const lineFixHold = useLineFixHold()')
    // Held from the tap that took the fix, before it changes the form.
    expect(sheet).toMatch(
      /const lineFix = \(fix: MatchFix\): FieldFix => \(\{\s+label: fix\.label,\s+onApply: \(\) => \{\s+lineFixHold\.taken\(\)\s+flushSync/,
    )
    expect(sheet).toMatch(
      /<form\s+className=\{`\$\{SHEET_BODY\} pt-3`\}\s+onMouseDownCapture=\{lineFixHold\.onTapCapture\}\s+onClickCapture=\{lineFixHold\.onTapCapture\}/,
    )
  })

  test('and once one of the panel’s is: it changes the form just as much', () => {
    const sheet = functionText(
      source('../schedule/NewJobSheet.tsx'),
      'NewJobForm',
    )
    // Held from the tap that took the fix, before it changes the form.
    expect(sheet).toMatch(
      /const panelFix = \(fix: MatchFix\): SaveWarningFix => \(\{\s+label: fix\.label,\s+apply: \(\) => \{\s+lineFixHold\.taken\(\)\s+latestApplyMatchFix\.current\(fix\)/,
    )
  })
})
