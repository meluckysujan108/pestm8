// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * The online sheet sends its checks (the matching plan's M7, §4.5): where
 * New Job, Clients → New client and Add property put lib/sheetChecks.ts to
 * work. The pieces are tested on their own (`sendChecked`, `createHoldWait`,
 * `sheetRefusalOf` in sheetChecks.test.ts; the rows in clientMatchRows.test.ts
 * and siteWorkRows.test.ts; `inject` in saveWarningRules.test.ts; the call in
 * outbox/book.test.ts); there is no DOM renderer in these tests to press
 * Book against a refusing server, so this pins where each is used.
 */
const here = import.meta.dirname
const source = (path: string) => readFileSync(resolve(here, path), 'utf8')

function functionText(text: string, name: string): string {
  const start = text.indexOf(`function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  const next = text.slice(start + 1).search(/\n(?:export )?(?:function|const) /)
  return next === -1 ? text.slice(start) : text.slice(start, start + 1 + next)
}

/** A function inside a component (two spaces in), to its closing brace. */
function innerFunction(text: string, name: string): string {
  const start = text.indexOf(`\n  function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  const end = text.indexOf('\n  }\n', start)
  return text.slice(start, end + 4)
}

/** A const inside a component, to the next statement at its depth. */
function innerConst(text: string, name: string): string {
  const start = text.indexOf(`\n  const ${name} =`)
  expect(start).toBeGreaterThan(-1)
  const next = text
    .slice(start + 1)
    .search(/\n {2}(?:const|function|let|useEffect|useSaveCheck|\/\*\*|\/\/)/)
  return text.slice(start, start + 1 + next)
}

/**
 * The hold is asked again on every commit of the form (`holdWait.poke()`,
 * no deps), after the effects of its own checks of `sources`, which tell
 * the panel of an edit (`useSaveCheck`): an edit while it runs ends a wait
 * whose rows the panel would now turn down (`turnedDown`), rather than at
 * HOLD_WAIT_MS, as well as an answer of the list landing.
 */
function pokedEachCommit(text: string, sources: ReadonlyArray<string>): void {
  const poke = text.indexOf('\n  useEffect(() => holdWait.poke())\n')
  expect(poke).toBeGreaterThan(-1)
  expect(text).not.toMatch(/holdWait\.poke\(\),\s*\[/)
  for (const checked of sources) {
    const check = text.indexOf(`useSaveCheck(\n    '${checked}',`)
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(poke)
  }
}

const newJob = () =>
  functionText(source('../schedule/NewJobSheet.tsx'), 'NewJobForm')
const newClient = () =>
  functionText(source('../clients/NewPropertySheet.tsx'), 'NewPropertySheet')
const addProperty = () =>
  functionText(source('../clients/ClientSheet.tsx'), 'NewPropertyForClientForm')

describe('New Job (every client mode)', () => {
  test('books through `sendChecked`, with the checks read as the press’s send goes, under the draft’s request id; a send again goes straight, with what the send refused carried, and only while the form is as it was at the press', () => {
    expect(newJob()).toMatch(
      /const checks = pressChecks\(\(extra\) =>\s+latestSheetChecks\.current\(args, extra\),\s+\)\s+return sendChecked\(\{\s+(?:\/\/[^\n]*\s+)*send: \(extra, again\) =>\s+booking\.session\.book\(\s+args,\s+draft,\s+whoFor\(args\),\s+checks\(extra, again\),\s+\{ straight: again \},?\s+\),\s+(?:\/\/[^\n]*\s+)*asPressed: saveWarnings\.asPressed,/,
    )
    // Never read afresh for a send again.
    expect(newJob()).not.toMatch(
      /send: \(extra, again\) =>[^}]*latestSheetChecks\.current/,
    )
  })

  test('what goes with the booking: every client the phone’s matcher found, what the rows showed and fixes booked past, the work match rows named in the phone’s own words only, and what refused rows still standing named', () => {
    const body = functionText(newJob(), 'sheetChecksFor')
    // matchCheck with a new client or site, siteCheck always.
    expect(body).toMatch(/bookingSheetChecks\(\{\s+property: args\.property,/)
    // Every candidate, shown or counted in "And 2 more" (FW17d), not the
    // rows shown: as the press's match check found them.
    expect(body).toContain('const read = pressReads.sending()')
    expect(body).toContain('dismissed: read.match?.dismissed ?? [],')
    // A refusal's row in a match row's place says none of its site's
    // work, so that work is never sent as seen (it is the server's to
    // name).
    expect(body).toMatch(
      /const injected = saveWarnings\.injectedNow\(\)[\s\S]*?const named = namedOnPanel\(\s+read\.match\?\.named \?\? new Map\(\),\s+injected,\s+'new-job-client-match',\s+\)/,
    )
    expect(body).not.toMatch(/\[\.\.\.read\.match\?\.named\.values\(\)\]/)
    expect(body).toMatch(
      /seen: withSeenAll\(read\.site \?\? seen, \[\s+\{ shows: \{ rows: named, series: \[\] \} \},\s+\]\),/,
    )
    // What refused rows standing named, and those a row found again in
    // other words took the place of (`refusedNow`).
    expect(body).toMatch(
      /sends: joinSends\(\s+extra,\s+standingSends\(refusedSends\.current, saveWarnings\.refusedNow\(\)\),\s+\),/,
    )
  })

  test('what goes with the booking is what the press’s checks found as they answered, never the form read again as it goes: a client or job the phone took in while a slower check was looking was never shown', () => {
    const body = innerFunction(newJob(), 'sheetChecksFor')
    // The newest press's, kept as the one whose booking went (`sent`).
    expect(body).toContain('const read = pressReads.sending()')
    expect(body).not.toContain('pressReads.last()')
    expect(body).not.toMatch(
      /bookingChecks\(|bookingDismissed\(|matchCtx|matchAtNow\(/,
    )
    // Each check starts its press's record as it is asked, and notes what
    // it found as it answers (lib/sheetChecks.ts `createPressReads`).
    expect(newJob()).toContain(
      'const [pressReads] = useState(() => createPressReads<BookingPressRead>())',
    )
    for (const [name, check] of [
      ['new-job-client-match', 'matchWarnings'],
      ['new-job-site-work', 'siteWarnings'],
    ]) {
      expect(newJob()).toMatch(
        new RegExp(
          `useSaveCheck\\(\\s+'${name}',[\\s\\S]*?\\(signal\\) => \\{\\s+const note = pressReads\\.begin\\(signal\\)\\s+const checks = bookingChecks\\(\\)[\\s\\S]*?: ${check}\\(note, checks\\)`,
        ),
      )
    }
    expect(innerFunction(newJob(), 'matchWarnings')).toMatch(
      /note\('match', \{\s+dismissed: bookingDismissed\(matchCtx, matchAtNow\(\)\),\s+named: checks\.named,\s+\}\)/,
    )
    expect(innerFunction(newJob(), 'siteWarnings')).toContain(
      "note('site', withSeenAll(checks.seen, found))",
    )
  })

  test('the phone’s own site check counts what refused rows of it still standing named as seen: once the copy holds that work too, its own row for it, in more words, is the same work, never news, and Book anyway books once', () => {
    const checks = innerFunction(newJob(), 'bookingChecks')
    expect(checks).toContain(
      'const checkSeen = withSent(seen, refusedSiteSends())',
    )
    expect(checks).toMatch(/targets,\s+seen: checkSeen,\s+index: matchIndex,/)
    expect(checks).not.toMatch(/targets,\s+seen,\s+index/)
  })

  test('a refusal’s rows to be shown wait up to 3 s for the client list to hold what their fixes need, then are read; one sent again by itself waits for nothing (`hold`), and an edit while it runs ends it', () => {
    expect(newJob()).toMatch(
      /rowsOf: \(refusal\) => latestRefusalRows\.current\(refusal\),\s+(?:\/\/[^\n]*\s+)*hold: \(refusal, turnedDown\) =>\s+holdWait\.until\(\s+\(\) => turnedDown\(\) \|\| latestRefusalHeld\.current\(refusal\),\s+\),/,
    )
    expect(newJob()).not.toMatch(/rowsOf: async|await holdWait\.until/)
    // Asked again as the list's answers land, and after an edit: the
    // corrected mobile ends "Booking…" then, not 3 s on.
    pokedEachCommit(newJob(), ['new-job-client-match', 'new-job-site-work'])
    // Rows the panel would turn down (the check edited since the press, the
    // form reset) wait for nothing: FormAlert says it at once.
    expect(newJob()).toMatch(
      /latestRefusalHeld\.current\(refusal\),\s+\),\s+mayShow: saveWarnings\.mayInject,/,
    )
  })

  test('a count of the rest says which rows it counts, the phone’s and a refusal’s, so one telling only those again is no news (`alreadyListed`)', () => {
    expect(innerFunction(newJob(), 'siteWarnings')).toMatch(
      /return rows\.map\(\(row\) => \(\{\s+id: row\.id,\s+kind: 'site',\s+label: row\.label,\s+message: row\.message,\s+\.\.\.\(row\.counts \? \{ counts: row\.counts \} : \{\}\),/,
    )
    expect(innerFunction(newJob(), 'refusalRows')).toMatch(
      /kind: 'site',\s+label: row\.label,\s+message: row\.message,\s+\.\.\.\(row\.counts \? \{ counts: row\.counts \} : \{\}\),/,
    )
  })

  test('a refusal’s rows read while the list didn’t hold what their fixes book at are read again, in place, once it does, however late', () => {
    expect(newJob()).toMatch(
      /useEffect\(\s*\(\) => latestRefreshRefused\.current\(\),\s*\[latestRefreshRefused, matchIndex\],?\s*\)/,
    )
    const refresh = functionText(newJob(), 'refreshRefused')
    expect(refresh).toMatch(
      /if \(entry\.held \|\| !refusalHeld\(entry\.refusal\)\) continue\s+entry\.held = true\s+const \{ source, rows \} = refusalRows\(entry\.refusal\)/,
    )
    expect(refresh).toContain('saveWarnings.refresh(source, now)')
    // Each refusal shown is noted with whether the list held it then.
    expect(functionText(newJob(), 'showRefusal')).toMatch(
      /ids: rows\.map\(\(row\) => row\.id\),\s+held: refusalHeld\(refusal\),/,
    )
  })

  test('a row put back by a later refusal keeps what the one it replaced sent, and a Book at takes every refused row of the site’s work standing past, not the one tapped alone', () => {
    expect(functionText(newJob(), 'showRefusal')).toMatch(
      /const before = saveWarnings\.refusedNow\(\)[\s\S]*?refusedSends\.current = sendsByRow\(\s+refusedSends\.current,\s+before,\s+source,\s+rows,\s+sends,\s+\)/,
    )
    expect(newJob()).toMatch(
      /const refusedSiteSends = \(\) =>\s+standingSends\(\s+refusedSends\.current,\s+saveWarnings\.refusedNow\(\),\s+'new-job-site-work',\s+\)/,
    )
  })

  test('a refused row’s Book at books past what the press refused showed, as the phone’s own does: its rows, the work a match row named there in the phone’s own words (FW13), and its “Not checked” rows, read', () => {
    const fix = innerConst(newJob(), 'refusedSiteFix')
    expect(fix).toMatch(
      /const refusedThere = refusedSiteSends\(\)\s+const shown = pressShown\(\)\s+setSeen\(\(s\) =>\s+withSent\(\s+shown\s+\? withSeenAll\(\s+s,\s+bookAtSees\(fix\.propertyId, shown\.rows, shown\.named\),\s+\)\s+: s,\s+refusedThere,/,
    )
    // The "Not checked" rows with the day and repeat they were read for,
    // read together.
    expect(fix).toContain('if (shown) seeUnchecked(shown.read, shown.readFor)')
    // A refused match row's fixes read the "Not checked" rows beside it
    // too, and book past what the press refused showed at the site they
    // book at, as the phone's own match row's do (`fixSees`): its words
    // name none of it, but the person was shown it and booked past it.
    // Read as tapped, once the refused rows stand in the place of any
    // phone row of their id (`namedRowsOnPanel`), and the "Not checked"
    // rows for the day they were read for, never the form's day as the row
    // was read (the date moved while "Booking…" showed).
    const match = innerConst(newJob(), 'refusedMatchFix')
    expect(match).toMatch(
      /const refusedThere = refusedSiteSends\(\)\s+const shown = pressShown\(\)\s+const sees = shown && refusedMatchSees\(row, shown\.rows, shown\.named\)\s+setSeen\(\(s\) => withSent\(sees \? withSeen\(s, sees\) : s, refusedThere\)\)\s+if \(shown\) seeUnchecked\(shown\.read, shown\.readFor\)\s+latestApplyMatchFix\.current\(fix\)/,
    )
    expect(match).not.toContain('workDay')
    const rows = innerFunction(newJob(), 'refusalRows')
    expect(rows).toContain('fix: refusedMatchFix(row.fix, row)')
    expect(rows).toContain('fix2: refusedMatchFix(row.fix2, row)')
    expect(rows).not.toMatch(/panelFix\(|beside/)
  })

  test('what a refused row’s fix books past is what the press refused showed, from that press’s own record, read once its booking went: a later press still “Checking…”, whose rows aren’t drawn yet, or a press the guard dropped (the client mode switched while it waited for the week’s work), answering after a later press began, never stands in for it', () => {
    // The site check notes what it showed with the press, which nothing
    // takes where it ran out of time (`createPressReads`).
    expect(innerFunction(newJob(), 'siteWarnings')).toMatch(
      /const read = site \? uncheckedKeysOf\(site\.unchecked, site\.targets\) : \[\]\s+(?:\/\/[^\n]*\s+)*note\('shown', \{ rows, namedWork: named, read, readFor: workDay \}\)/,
    )
    // And the fixes read that record as they are tapped, never the
    // state every late answer still writes for the foot (`siteShown`):
    // the record of the press whose booking went (`sent`), every row of
    // which was on the panel, never the newest press's, which a later
    // press still "Checking…" has begun, its rows not drawn yet.
    const shown = innerFunction(newJob(), 'pressShown')
    expect(shown).toMatch(
      /const shown = pressReads\.sent\(\)\?\.shown\s+if \(!shown\) return null/,
    )
    expect(shown).not.toContain('pressReads.last()')
    expect(shown).toMatch(
      /named: namedRowsOnPanel\(\s+shown\.namedWork,\s+saveWarnings\.injectedNow\(\),\s+'new-job-client-match',\s+\),/,
    )
    expect(newJob()).not.toMatch(
      /latestSiteShown|siteShown\.(?:read|namedWork)\b/,
    )
    for (const name of ['refusedSiteFix', 'refusedMatchFix']) {
      expect(innerConst(newJob(), name)).not.toContain('siteShown')
      expect(innerConst(newJob(), name)).not.toMatch(/pressReads\./)
    }
  })

  test('a refusal’s site rows are read for the form as it is: Book at only for the client chosen in New site for, and an inactive or archived client said', () => {
    const rows = innerFunction(newJob(), 'refusalRows')
    expect(rows).toMatch(
      /mode === 'site'\s+\? \{ mode, typed: newSite, bookFor: siteClient\?\._id \?\? null \}/,
    )
    expect(rows).toContain(
      'siteOf: (id) => properties.find((p) => p._id === id),',
    )
    expect(rows).toContain('clientOf: (id) => matchIndex.clients.get(id),')
  })

  test('a refusal’s fixes wait for the client list to hold each client and site the server named, and at an address typed each site its work is at', () => {
    const held = innerFunction(newJob(), 'refusalHeld')
    expect(held).toMatch(
      /if \(refusal\.code === 'MATCHED_CLIENT'\) \{\s+return refusal\.candidates\.every\(\(c\) => candidateHeld\(matchIndex, c\)\)\s+\}/,
    )
    expect(held).toMatch(
      /if \(refusal\.code === 'SITE_BOOKED' && mode !== 'existing'\) \{\s+return refusal\.rows\.every\(\(r\) => matchIndex\.siteKeys\.has\(r\.propertyId\)\)\s+\}/,
    )
  })

  test('“Not checked” is the server’s to say past the weeks held only for someone it tells of every job (`seesWholeSchedule`, as `jobScope`), booking straight', () => {
    expect(newJob()).toContain('const seesEveryJob = seesWholeSchedule(access)')
    // Not with the outbox on: whether a press keeps the booking is
    // decided at the press, not as the sheet opens (`useCanKeep`).
    expect(newJob()).toContain('serverChecks: seesEveryJob && !OUTBOX_ENABLED,')
    expect(newJob()).not.toMatch(/serverChecks: [^\n]*canKeep/)
  })

  test('only what is new is shown: what the press listed is read as each refusal comes', () => {
    expect(newJob()).toMatch(
      /listed: saveWarnings\.listedNow,\s+inject: \(source, rows, sends, error\) =>\s+latestShowRefusal\.current\(source, rows, sends, error\),/,
    )
  })

  test('FormAlert’s words are for the booking as it was sent: a new site for a client has its own for MATCHED_CLIENT (bookingCopy.test.ts)', () => {
    expect(newJob()).toMatch(
      /copy=\{bookingErrorCopy\(\s+create\.variables\?\.property,\s+\(id\) => matchIndex\.clients\.get\(id\)\?\.name,\s+\)\}/,
    )
  })

  test('FormAlert says nothing of a refusal whose rows the panel shows, and the panel ends with “PestM8 found this when saving.”', () => {
    expect(newJob()).toMatch(
      /create\.isError && create\.error !== shownRefusal\s+\? create\.error\s+: null/,
    )
    expect(newJob()).toContain('FOUND_WHEN_SAVING')
  })

  test('the notes about the copy on the phone are for the phone’s own rows, never a refusal’s; and a refusal’s row’s foot is read from its own fixes', () => {
    expect(newJob()).toContain(
      'const fromServer = new Set(saveWarnings.injected.map((w) => w.id))',
    )
    expect(newJob()).toMatch(
      /const showsMatch = saveWarnings\.warnings\.some\(\s+\(w\) => w\.kind === 'match' && !fromServer\.has\(w\.id\),?\s+\)/,
    )
    expect(newJob()).toMatch(
      /const showsWork = saveWarnings\.warnings\.some\(\s+\(w\) =>\s+!fromServer\.has\(w\.id\) &&/,
    )
    expect(newJob()).toMatch(
      /\.\.\.\(showsRefused \? \[FOUND_WHEN_SAVING\] : \[\]\),/,
    )
    expect(newJob()).toMatch(
      /\(fromServer\.has\(w\.id\)\s+\? refused\.match\.get\(w\.id\)\s+: matchShown\.rows\.get\(w\.id\)\)/,
    )
    expect(newJob()).toMatch(
      /if \(!fromServer\.has\(w\.id\)\) return siteShown\.rows\.get\(w\.id\) \?\? \{\}\s+const row = refused\.site\.get\(w\.id\)/,
    )
  })
})

describe('Clients → New client', () => {
  test('saves with matchCheck by the sheet, through `sendChecked`, every client the press’s check found as it answered, never the list read again as the save goes', () => {
    expect(newClient()).toMatch(
      /sendChecked\(\{\s+send: \(extra\) =>\s+convexCreate\(\{\s+\.\.\.args,\s+matchCheck: latestMatchCheck\.current\(extra\),\s+\}\),/,
    )
    expect(innerFunction(newClient(), 'matchWarnings')).toMatch(
      /note\(\s+'dismissed',\s+bookingDismissed\(ctx, \{ mode: 'new', typed: typedOf\(typed\) \}\),?\s+\)/,
    )
    expect(newClient()).toContain(
      '? (signal) => matchWarnings(matchCtx, pressReads.begin(signal))',
    )
    const now = innerFunction(newClient(), 'matchCheckNow')
    expect(now).toContain('const dismissed = pressReads.last().dismissed ?? []')
    expect(now).not.toMatch(/bookingDismissed|\bindex\b|latestValue/)
  })

  test('a refusal’s rows wait for the client list, then open the client by the server’s id: on Add property with the address typed, where it isn’t theirs, list or no list', () => {
    expect(newClient()).toMatch(
      /rowsOf: \(refusal\) => latestRefusalRows\.current\(refusal\),\s+(?:\/\/[^\n]*\s+)*hold: \(refusal, turnedDown\) =>\s+holdWait\.until\(\(\) => turnedDown\(\) \|\| latestHeld\.current\(refusal\)\),/,
    )
    expect(newClient()).not.toMatch(/rowsOf: async|await holdWait\.until/)
    // An edit, or Clear, while it waits ends it.
    pokedEachCommit(newClient(), ['new-client-match'])
    // Rows the panel would turn down, or of a draft begun since, wait for
    // nothing.
    expect(newClient()).toMatch(
      /mayShow: \(source\) =>\s+draft === draftNo\.current && saveWarnings\.mayInject\(source\),/,
    )
    expect(newClient()).toMatch(/index: noClientsIndex\(\),/)
    expect(newClient()).toMatch(
      /!index \|\| !directory\s+\? openUnheld\(fix, typed\)\s+: openFromNewClient\(index, directory\.contacts, fix, typed\)/,
    )
  })

  test('what goes with the save: every client the phone’s matcher found, and what refused rows still standing named, a row put back keeping what the one it replaced sent', () => {
    expect(newClient()).toMatch(
      /const standing = standingSends\(\s+refusedSends\.current,\s+saveWarnings\.refusedNow\(\),\s+\)\s+return matchCheckFor\(\[\s+\.\.\.dismissed,\s+\.\.\.joinSends\(extra, standing\)\.dismissed,?\s+\]\)/,
    )
    expect(newClient()).toMatch(
      /const before = saveWarnings\.refusedNow\(\)[\s\S]*?refusedSends\.current = sendsByRow\(/,
    )
  })

  test('only what is new is shown: what the press listed is read as each refusal comes', () => {
    expect(newClient()).toMatch(
      /listed: saveWarnings\.listedNow,\s+(?:\/\/[^\n]*\s+)*inject: \(source, rows, sends, error\) => \{\s+if \(draft !== draftNo\.current\) return\s+latestShowRefusal\.current\(source, rows, sends, error\)\s+\},/,
    )
  })

  test('FormAlert says nothing of a refusal whose rows the panel shows', () => {
    expect(newClient()).toMatch(
      /create\.isError && create\.error !== shownRefusal\s+\? create\.error\s+: null/,
    )
    expect(newClient()).toContain('FOUND_WHEN_SAVING')
  })

  test('the notes about the copy on the phone are for the phone’s own rows, never a refusal’s, and “PestM8 found this when saving.” only under a refusal’s; a refusal’s row’s foot is read from its own fixes', () => {
    expect(newClient()).toContain(
      'const fromServer = new Set(saveWarnings.injected.map((w) => w.id))',
    )
    expect(newClient()).toMatch(
      /const showsPhoneRows = saveWarnings\.warnings\.some\(\s+\(w\) => w\.kind === 'match' && !fromServer\.has\(w\.id\),?\s+\)/,
    )
    expect(newClient()).toMatch(
      /const showsRefused = saveWarnings\.warnings\.some\(\(w\) => fromServer\.has\(w\.id\)\)/,
    )
    expect(newClient()).toMatch(
      /const panelNote = \[\s+\.\.\.\(showsPhoneRows \? matchShown\.notes : \[\]\),\s+\.\.\.\(showsRefused \? \[FOUND_WHEN_SAVING\] : \[\]\),?\s+\]/,
    )
    expect(newClient()).toContain(
      "note={panelNote.length > 0 ? panelNote.join(' ') : undefined}",
    )
    expect(newClient()).not.toMatch(/note=\{matchShown\.notes/)
    expect(newClient()).toMatch(
      /\(fromServer\.has\(w\.id\)\s+\? refused\.get\(w\.id\)\s+: matchShown\.rows\.get\(w\.id\)\)/,
    )
  })

  test('a save goes with the draft it was pressed for: a refusal of one discarded or cleared since never goes on the next draft’s panel, nor does its success blank or close it, while Save takes that draft’s press (`create.reset()`)', () => {
    expect(newClient()).toContain('const draftNo = useRef(0)')
    expect(innerFunction(newClient(), 'clear')).toMatch(
      /function clear\(\) \{\s+draftNo\.current \+= 1/,
    )
    // Pressed for the draft as it is; never sent to the server.
    expect(newClient()).toMatch(
      /create\.mutateAsync\(\{\s+draft: draftNo\.current,\s+businessId,\s+\.\.\.newClientArgs\(latestValue\.current\),?\s+\}\)/,
    )
    expect(newClient()).toMatch(
      /mutationFn: \(\{\s+draft,\s+\.\.\.args\s+\}: \{ draft: number; businessId: Id<'businesses'> \} & NewClientArgs\) =>/,
    )
    expect(newClient()).toMatch(
      /onSuccess: \(_saved, \{ draft \}\) => \{\s+if \(draft !== draftNo\.current\) return\s+setValue\(empty\)/,
    )
  })

  test('Discard (✕, a swipe) and Clear forget a save still out: the sheet stays mounted while closed, so a refusal landing after, whose rows `inject` turns down, says nothing above the next draft, and Save isn’t left reading “Saving…”', () => {
    const clear = innerFunction(newClient(), 'clear')
    expect(clear).toContain('saveWarnings.reset()')
    expect(clear).toContain('create.reset()')
    // Every way the sheet is blanked goes through it.
    expect(innerFunction(newClient(), 'close')).toMatch(
      /clear\(\)\s+onClose\(\)/,
    )
    expect(newClient()).toContain('<SheetShell open={open} onClose={close}>')
    expect(newClient()).toContain(
      '<KeptDraftNote from={keptFrom} onClear={clear} />',
    )
  })
})

describe('Add property on a client’s sheet', () => {
  test('adds with matchCheck by the sheet, the client dismissed only where the form said they have the address exactly', () => {
    expect(addProperty()).toMatch(
      /convexCreate\(\{\s+\.\.\.args,\s+matchCheck: latestMatchCheck\.current\(extra\),\s+\}\)/,
    )
    // Not a site only like one of theirs: the server's exact check stays
    // on. As the press's check found it, never the sheet's sites read
    // again as the save goes.
    expect(addProperty()).toMatch(
      /\(signal\) => \{\s+pressReads\.begin\(signal\)\(\s+'dismissed',\s+ownSiteDismissed\(clientId, sites, value\),\s+\)\s+return ownSiteRows\(clientName, sites, value\)/,
    )
    expect(addProperty()).toMatch(
      /return matchCheckFor\(\[\s+\.\.\.\(pressReads\.last\(\)\.dismissed \?\? \[\]\),\s+\.\.\.joinSends\(extra, standing\)\.dismissed,\s+\]\)/,
    )
    expect(addProperty().match(/ownSiteDismissed\(/g)).toHaveLength(1)
    expect(addProperty()).not.toMatch(/ownSiteRows\([^)]*\)\.length > 0/)
    expect(addProperty()).toMatch(
      /const standing = standingSends\(refusedSends\.current, warnings\.refusedNow\(\)\)/,
    )
    expect(addProperty()).toMatch(
      /const before = warnings\.refusedNow\(\)[\s\S]*?refusedSends\.current = sendsByRow\(/,
    )
  })

  test('a refusal’s row read while the sheet didn’t hold the site is read again, in place, once it does, however late', () => {
    expect(addProperty()).toContain(
      'useEffect(() => latestRefreshRefused.current(), [latestRefreshRefused, sites])',
    )
    expect(addProperty()).toMatch(
      /const latestRefreshRefused = useLatest\(\(\) => \{\s+const entry = refusalShown\.current\s+if \(!entry \|\| entry\.held \|\| !latestHeld\.current\(entry\.refusal\)\) return\s+entry\.held = true\s+const \{ source, rows \} = latestRefusalRows\.current\(entry\.refusal\)\s+warnings\.refresh\(source, rows\)/,
    )
    expect(addProperty()).toMatch(
      /refusalShown\.current = refusal && \{\s+refusal,\s+held: latestHeld\.current\(refusal\),\s+\}/,
    )
  })

  test('only what is new is shown: what the press listed is read as each refusal comes', () => {
    expect(addProperty()).toMatch(
      /listed: warnings\.listedNow,\s+inject: \(source, rows, sends, error\) => \{/,
    )
  })

  test('FormAlert’s words for a refusal it does say are `addPropertyErrorCopy`’s (NewClientFields.test.ts)', () => {
    expect(addProperty()).toContain('copy={addPropertyErrorCopy(clientName)}')
  })

  test('a refusal’s row waits for the sheet to hold the site, for Use 12 Wattle St, and FormAlert says nothing of it', () => {
    expect(addProperty()).toMatch(
      /rowsOf: \(refusal\) => latestRefusalRows\.current\(refusal\),\s+(?:\/\/[^\n]*\s+)*hold: \(refusal, turnedDown\) =>\s+holdWait\.until\(\(\) => turnedDown\(\) \|\| latestHeld\.current\(refusal\)\),/,
    )
    expect(addProperty()).not.toMatch(/rowsOf: async|await holdWait\.until/)
    // As the sheet's sites come in, and after an edit of the address.
    pokedEachCommit(addProperty(), ['add-property-own-site'])
    // Rows the panel would turn down wait for nothing.
    expect(addProperty()).toMatch(
      /holdWait\.until\(\(\) => turnedDown\(\) \|\| latestHeld\.current\(refusal\)\),\s+(?:\/\/[^\n]*\s+)*mayShow: warnings\.mayInject,/,
    )
    expect(addProperty()).toMatch(
      /create\.isError && create\.error !== shownRefusal\s+\? create\.error\s+: null/,
    )
    expect(addProperty()).toContain(
      'note={showsRefused ? FOUND_WHEN_SAVING : undefined}',
    )
  })

  test('the foot names Use only for rows that have it: a refused row whose site the sheet doesn’t hold yet says “Press Save anyway to add it again.” (clientMatchRows.test.ts `matchFooter`)', () => {
    expect(addProperty()).toMatch(
      /matchFooter\(\s+shown\.map\(\(w\) =>\s+w\.fix \? \{ fix: \{ kind: 'use' as const \} \} : \{\},?\s+\),\s+\{ anyway: 'Save anyway', adds: 'site' \},?\s+\)/,
    )
    expect(addProperty()).not.toMatch(
      /shown\.map\(\(\) => \(\{ fix: \{ kind: 'use'/,
    )
  })
})
