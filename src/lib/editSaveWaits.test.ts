// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { editSaveWaits } from './editSaveWaits'

describe('what an edit form says above Save while its save waits for signal', () => {
  test.each(['job', 'client', 'property'] as const)(
    'the %s’s says it waits, and to keep PestM8 open',
    (thing) => {
      const waits = editSaveWaits(thing)
      expect(waits['no-signal']).toBe(
        `No signal — the ${thing}’s changes are saved when you have signal. Keep PestM8 open until then.`,
      )
      expect(waits.unreachable).toBe(
        'Could not reach PestM8 — they’re saved once it can. Keep PestM8 open until then.',
      )
    },
  )

  test('in the guide’s words: curly apostrophes, never "customer"', () => {
    for (const thing of ['job', 'client', 'property'] as const) {
      for (const line of Object.values(editSaveWaits(thing))) {
        expect(line).toMatch(/^(No signal|Could not reach PestM8) — /)
        expect(line).toMatch(/Keep PestM8 open until then\.$/)
        expect(line).not.toContain("'")
        expect(line).not.toMatch(/customer/i)
      }
    }
  })
})

/**
 * Where it is used. There is no DOM renderer here to take the line down and
 * press Save, so this pins each form's wiring: the caption, Save described
 * by it, and the sheet's lock let go of "Discard your changes?" while the
 * save is on its way — it would land anyway, so nothing would be discarded.
 */
const SRC = resolve(import.meta.dirname, '..')
const source = (path: string) => readFileSync(resolve(SRC, path), 'utf8')

/** The text of the function `name` in `text`, up to the next top-level one. */
function functionText(text: string, name: string): string {
  const start = text.indexOf(`function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  const next = text
    .slice(start + 1)
    .search(/\n(?:export )?(?:function|const|type) /)
  return next === -1 ? text.slice(start) : text.slice(start, start + 1 + next)
}

describe.each([
  ['components/schedule/JobDetailSheet.tsx', 'JobEditForm', 'job'],
  ['components/clients/ClientEditForm.tsx', 'ClientEditForm', 'client'],
  ['components/clients/ClientSheet.tsx', 'PropertyEditForm', 'property'],
  ['components/clients/PropertyEditMode.tsx', 'PropertyEditMode', 'property'],
])('%s %s', (file, name, thing) => {
  const form = functionText(source(file), name)

  test(`says the ${thing}’s changes wait, and Save is described by it`, () => {
    expect(form).toContain(`{editSaveWaits('${thing}')[lineDown]}`)
    expect(form).toMatch(
      /<p id=\{lineDownId\} className="text-caption text-ink-2">/,
    )
    expect(form).toContain(
      'aria-describedby={lineDown ? lineDownId : undefined}',
    )
  })

  test('closes without "Discard your changes?" while it saves', () => {
    const lock = form.slice(form.indexOf('useSheetLock('))
    expect(lock).toMatch(/^useSheetLock\([^;]*?&& !save\.isPending,?\s*\)/s)
    // Below the save it reads: above, it is not yet declared.
    expect(form.indexOf('useSheetLock(')).toBeGreaterThan(
      form.indexOf('const save = useMutation('),
    )
  })
})
