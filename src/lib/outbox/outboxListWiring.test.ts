// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'

/**
 * The lists of every day that draw the bookings on this phone (plan part
 * 2c §9.8), wired in pages there is no DOM renderer here for, so pinned as
 * the other wiring is.
 */
const SRC = resolve(import.meta.dirname, '../..')
const read = (path: string) => readFileSync(resolve(SRC, path), 'utf8')

/**
 * The Job tab's group reads the whole list, and the list reveals from what
 * is left once the slots have taken their jobs out: a job that comes in at
 * the top as its booking is sent, drawn in its slot, takes no card of the
 * revealed, so the last stays and "Show more jobs" doesn't move up.
 */
test('the Job tab reveals from its list without the jobs its slots draw', () => {
  const text = read('routes/$businessSlug/job/index.tsx')
  expect(text).toMatch(
    /const listRows: ReadonlyArray<JobRow & LatchRow> = paging \? paged\.rows : whole/,
  )
  expect(text).toMatch(/rows: listRows,/)
  expect(text).toMatch(
    /const revealable =\s+unsent\.hidden\.size === 0\s+\? whole\s+: whole\.filter\(\(job\) => !unsent\.hidden\.has\(job\._id\)\)/,
  )
  expect(text).toMatch(/useRevealMore\(revealable, JOBS_PAGE, resetKey\)/)
  expect(text).not.toMatch(/useRevealMore\(whole,/)
  expect(text.indexOf('useOutboxList(')).toBeLessThan(
    text.indexOf('useRevealMore('),
  )
})

/**
 * With its group drawn, the Job tab says neither "No jobs yet" nor "No jobs
 * match these filters." under it: both would be untrue. Its group is
 * whatever `useOutboxList` drew, and its list leaves out the jobs the slots
 * draw.
 */
test('the Job tab draws no empty or no-matches state under its group', () => {
  const text = read('routes/$businessSlug/job/index.tsx')
  expect(text).toMatch(/const unsentDrawn = unsentDay\.slots\.length > 0/)
  expect(text).toMatch(
    /view === 'empty' \?[\s\S]*?!unsentDrawn && \(\s+<EmptyState\s+title="No jobs yet"/,
  )
  expect(text).toMatch(
    /view === 'noMatches' \? \(\s+!unsentDrawn && \(\s+<NoMatches\s+hint="No jobs match these filters\."/,
  )
  expect(text.match(/<EmptyState\b/g)).toHaveLength(1)
  expect(text.match(/<NoMatches\b/g)).toHaveLength(1)
  expect(text).toMatch(
    /const shownRows =\s+unsent\.hidden\.size === 0\s+\? rows\s+: rows\.filter\(\(job\) => !unsent\.hidden\.has\(job\._id\)\)/,
  )
  expect(text).toMatch(/\{shownRows\.map\(\(job\) => \(/)
})

/** Its filters let a booking through by the rule its tests pin. */
test('the Job tab lists its bookings by `jobTabShows`, under its own filters', () => {
  const text = read('routes/$businessSlug/job/index.tsx')
  expect(text).toMatch(
    /shows: jobTabShows\(\{\s+status,\s+person,\s+mine: mode === 'mine' \? acting\.membershipId : null,\s+\}\)/,
  )
  expect(text).not.toMatch(/isOnJob\(/)
})

/**
 * A booking begun on a client's sheet lives in one keyed element, put in
 * every body the sheet may change to while it is open: the kept sheet's,
 * the live sheet's, and, with the outbox on, "can't load" and "Not found",
 * so what was typed is never lost without "Discard your changes?".
 */
test('New Job begun on a client’s sheet stays open whatever PestM8 answers', () => {
  const text = read('components/clients/ClientSheet.tsx')
  expect(text.match(/<Suspense key="new-job"/g)).toHaveLength(1)
  // The kept sheet's, "can't load"'s and "Not found"'s.
  expect(text.match(/\{OUTBOX_ENABLED && newJob\}/g)).toHaveLength(3)
  // The live sheet's.
  expect(text.match(/^\s+\{newJob\}$/gm)).toHaveLength(1)
  const failed = text.indexOf('<LoadFailed')
  const notFound = text.indexOf('Not found')
  expect(text.indexOf('{OUTBOX_ENABLED && newJob}', failed)).toBeLessThan(
    text.indexOf('if (client === undefined) {', failed),
  )
  expect(text.indexOf('{OUTBOX_ENABLED && newJob}', notFound)).toBeGreaterThan(
    notFound,
  )
  expect(text.indexOf('{OUTBOX_ENABLED && newJob}', notFound)).toBeLessThan(
    text.indexOf('const kicker', notFound),
  )
})
