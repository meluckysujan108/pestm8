// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * What a client owes on their Jobs tab, with the line down. When the tab
 * draws and whether what they owe is on it are `useOwedGate`'s, tested on
 * its own (ClientOwing.hooks.test.ts) over a line that comes and goes;
 * there is no DOM renderer in these tests to mount the tab across that, so
 * this pins where it is put to work, and the sheet's asking for what they
 * owe as it opens, which keeps the tab from finding their jobs without it.
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

describe('what a client owes, on their Jobs tab', () => {
  const tab = functionText(source('./ClientJobsTab.tsx'), 'ClientJobsTab')

  test('the tab draws when `useOwedGate` says, waiting it out only with keeping on and the line down', () => {
    expect(tab).toMatch(
      /const owed = useOwedGate\(\{\s*jobsIn: summary !== undefined && summary !== null && settled,\s*owedIn: owedQuery\.data !== undefined \|\| owedQuery\.isError,\s*waitsOut: OUTBOX_ENABLED && lineDown !== null,\s*\}\)/,
    )
    expect(tab).toContain('const drawsJobs = owed.draws')
    // The bookings on the phone are drawn as the tab is, and the tab's own
    // placeholder gives way on the same say.
    expect(tab).toMatch(/useOutboxList\(\{[\s\S]*?draws: drawsJobs,/)
    expect(tab).toContain(
      'if (summary === undefined || summary === null || !drawsJobs) {',
    )
  })

  test('what they owe, or that it failed, is drawn only where `useOwedGate` shows it', () => {
    expect(tab).toMatch(
      /\{!owed\.owedShown \? null : owedQuery\.isError \? \(\s*<ClientOwingFailed[\s\S]*?<ClientOwing\b/,
    )
    expect(tab.match(/<ClientOwing(?:Failed)?\b/g)).toHaveLength(2)
  })

  test('the live sheet asks for it as it opens, whatever the part, as it does for their jobs', () => {
    const body = functionText(source('./ClientSheet.tsx'), 'ClientBody')
    // In the body itself, two spaces in: not in a branch, nor skipped.
    expect(body).toMatch(
      /\n {2}useQuery\(convexQuery\(api\.payments\.forClient, \{ businessId, clientId \}\)\)\n/,
    )
    expect(body).toMatch(/<ClientAtAGlance\b/)
  })
})
