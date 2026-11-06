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
 * `answerOnceRead` and `keepsDraftAfterOpen` in NewPropertySheet.test.tsx); there is no DOM renderer
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
      /const typed = \{[^}]*addressCheck: form\.addressCheck,[\s\S]*?\? openUnheld\(fix, typed\)\s+: openFromNewClient\(index, directory\.contacts, fix, typed\)/,
    )
    const form = functionText(
      source('./ClientSheet.tsx'),
      'NewPropertyForClientForm',
    )
    expect(form).toMatch(
      /useState<AddressCheck>\(\s*initial\?\.addressCheck \?\? 'typed',?\s*\)/,
    )
    expect(form).toContain("picked={initial?.addressCheck === 'picked'}")
    expect(
      functionText(source('./PropertyFields.tsx'), 'PropertyFields'),
    ).toMatch(/<VerifiedAddressFields[^>]*\spicked=\{picked\}/)
  })
})

describe('Clients → New client, a Save waiting for the client list', () => {
  test('goes with its press: given up on at 3 s (`answerOnceRead`, with the check’s signal), or as the sheet is cleared', () => {
    const sheet = source('./NewPropertySheet.tsx')
    expect(sheet).toMatch(
      /: \(signal\) => \{\s+const note = pressReads\.begin\(signal\)\s+return answerOnceRead\(waitingForList\.current, signal,/,
    )
    expect(sheet).toMatch(
      /function clear\(\) \{[^}]*waitingForList\.current = \[\]/,
    )
  })
})

describe('Clients → New client, an Open with no signal', () => {
  test('keeps what was typed by `keepsDraftAfterOpen`, given the line as it is then', () => {
    expect(
      functionText(source('./NewPropertySheet.tsx'), 'NewPropertySheet'),
    ).toContain('if (keepsDraftAfterOpen(opened, lineDown)) {')
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
    // Held from the tap that took the fix, before it changes the form; the
    // site's work its row named, and the rows about that site beside it,
    // marked seen first (FW13), and what the panel said couldn't be
    // checked beside it read, so the press after it isn't asked about any
    // of it again.
    expect(sheet).toMatch(
      /const panelFix = \(\s+fix: MatchFix,\s+sees: Shows \| undefined,\s+beside: ReadonlyArray<string>,\s+\): SaveWarningFix => \(\{\s+label: fix\.label,\s+apply: \(\) => \{\s+lineFixHold\.taken\(\)\s+(?:\/\/[^\n]*\s+)*const refusedThere = refusedSiteSends\(\)\s+setSeen\(\(s\) => withSent\(sees \? withSeen\(s, sees\) : s, refusedThere\)\)\s+seeUnchecked\(beside, workDay\)\s+latestApplyMatchFix\.current\(fix\)/,
    )
    expect(sheet).toMatch(
      /const beside = uncheckedKeysOf\(\s+checks\.site\?\.unchecked \?\? \[\],\s+checks\.site\?\.targets \?\? \[\],\s+\)[\s\S]*?\.\.\.\(row\.fix\s+\? \{ fix: panelFix\(row\.fix, fixSees\.get\(row\.id\), beside\) \}\s+: \{\}\),\s+\.\.\.\(row\.fix2\s+\? \{ fix2: panelFix\(row\.fix2, fixSees\.get\(row\.id\), beside\) \}\s+: \{\}\),/,
    )
  })
})

describe('New Job’s check at Book, is this site already booked (M5)', () => {
  const sheet = () =>
    functionText(source('../schedule/NewJobSheet.tsx'), 'NewJobForm')

  test('Book at from an “Already booked” row books past every row the panel showed of the site’s work, and the work a match row named there, before the fix moves the form, so the press after it books (FW13)', () => {
    expect(sheet()).toMatch(
      /const siteFix = \(\s*fix: SiteFix,\s*shown: ReadonlyArray<SiteRow>,\s*named: ReadonlyMap<string, ReadonlyArray<OpenWorkRow>>,\s*read: ReadonlyArray<string>,?\s*\): SaveWarningFix =>[\s\S]*?: \{\s+label: fix\.label,\s+apply: \(\) => \{\s+lineFixHold\.taken\(\)\s+(?:\/\/[^\n]*\s+)*const refusedThere = refusedSiteSends\(\)\s+setSeen\(\(s\) =>\s+withSent\(\s+withSeenAll\(s, bookAtSees\(fix\.propertyId, shown, named\)\),\s+refusedThere,\s+\),?\s+\)\s+seeUnchecked\(read, workDay\)\s+latestApplyMatchFix\.current\(fix\)\s+\},\s+focusAfter: \(\) => latestFocusAfterMatchFix\.current\(\),/,
    )
    // Every row of the panel's, not the one tapped alone, and what the
    // match rows of the same press named.
    expect(sheet()).toMatch(
      /const \{ named, site \} = checks[\s\S]*?const read = site \? uncheckedKeysOf\(site\.unchecked, site\.targets\) : \[\][\s\S]*?return rows\.map\(\(row\) => \(\{[\s\S]*?\.\.\.\(row\.fix \? \{ fix: siteFix\(row\.fix, rows, named, read\) \} : \{\}\),\s+\.\.\.\(row\.fix2 \? \{ fix2: siteFix\(row\.fix2, rows, named, read\) \} : \{\}\),/,
    )
  })

  test('what couldn’t be checked, said beside a fix, isn’t said again on the press after it while the date and repeat are as they were; a client mode changed by hand forgets it', () => {
    expect(sheet()).toMatch(
      /const seeUnchecked = \(keys: ReadonlyArray<string>, readFor: string\) => \{\s+if \(keys\.length === 0\) return\s+setUncheckedSeen\(\(s\) => \(\{\s+workDay: readFor,\s+keys: new Set\(\[\.\.\.\(s\.workDay === readFor \? s\.keys : \[\]\), \.\.\.keys\]\),\s+\}\)\)\s+\}/,
    )
    expect(sheet()).toMatch(
      /const work = bookingWork\(\{[\s\S]*?\},\s+uncheckedSeen:\s+uncheckedSeen\.workDay === workDay \? uncheckedSeen\.keys : undefined,\s+(?:\/\/[^\n]*\s+)*serverChecks: seesEveryJob && !OUTBOX_ENABLED,\s+\}\)/,
    )
    expect(sheet()).toMatch(
      /function switchMode\([\s\S]*?setSeen\(NOTHING_SEEN\)\s+setUncheckedSeen\(\{ workDay: '', keys: new Set\(\) \}\)[\s\S]*?setMode\(next\)\s+\}/,
    )
  })

  test('in New site for, the rows book only at the chosen client’s own sites (`bookFor`)', () => {
    expect(sheet()).toMatch(
      /const work = bookingWork\(\{[\s\S]*?typedAddress: typed\.addressLine\.trim\(\),\s+(?:\/\/.*\s+)*\.\.\.\(mode === 'site' \? \{ bookFor: siteClient\?\._id \?\? null \} : \{\}\),/,
    )
  })

  test('what couldn’t be checked is a row of the panel, after the work found, wherever there is a site to check, with an answer or none', () => {
    // The sites are found first, so a phone with nothing of what is
    // booked still knows there is a site it couldn't check; both checks
    // read the one answer (`bookingWork`).
    expect(sheet()).toMatch(
      /function bookingChecks\(\) \{[\s\S]*?const targets =[\s\S]*?const work = bookingWork\(\{\s+held: openWork\.held,\s+dayKey: when\.dayKey,\s+matchRows,[\s\S]*?targets,[\s\S]*?site: \{ \.\.\.work, today, targets \},/,
    )
    expect(sheet()).toMatch(
      /function siteWarnings\([\s\S]*?\): Array<SaveWarning> \{[\s\S]*?const rows = site \? \[\.\.\.found, \.\.\.site\.unchecked\] : \[\][\s\S]*?return rows\.map\(\(row\) => \(\{\s+id: row\.id,\s+kind: 'site',/,
    )
  })

  test('with signal and nothing of it on the phone yet, both checks wait a moment for it, once, as one', () => {
    // Not again once a wait has run out, until what is held or coming
    // changes (`createWorkWait`, NewJobSheet.test.tsx).
    expect(sheet()).toMatch(
      /function waitsForWork\([\s\S]*?\): boolean \{\s+return \(\s+checks\.site\?\.pick === 'none' &&\s+checks\.site\.targets\.length > 0 &&\s+openWork\.coming &&\s+!workWait\.ranOut\(\) &&\s+lineDown === null &&\s+!isOffline\(\)\s+\)/,
    )
    // Let go as it comes, or once it plainly isn't coming.
    expect(sheet()).toMatch(
      /const \[workWait\] = useState\(createWorkWait\)\s+const workSettled = openWork\.held\.length > 0 \|\| !openWork\.coming\s+useEffect\(\(\) => \{\s+if \(workSettled\) workWait\.settle\(\)\s+\}, \[workWait, workSettled\]\)\s+useEffect\(\(\) => \{\s+workWait\.reset\(\)\s+\}, \[workWait, openWork\.held\.length, openWork\.coming\]\)/,
    )
    // One wait for a press, its time cut short of the guard's.
    expect(sheet()).toMatch(
      /function untilWorkHeld\(\): Promise<void> \{\s+return workWait\.until\(\)\s+\}/,
    )
    for (const [source_, warnings] of [
      ['new-job-client-match', 'latestMatchWarnings'],
      ['new-job-site-work', 'latestSiteWarnings'],
    ]) {
      expect(sheet()).toMatch(
        new RegExp(
          `useSaveCheck\\(\\s+'${source_}',[\\s\\S]*?const checks = bookingChecks\\(\\)\\s+return waitsForWork\\(checks\\)\\s+\\? untilWorkHeld\\(\\)\\.then\\(\\(\\) => ${warnings}\\.current\\(note\\)\\)`,
        ),
      )
    }
  })

  test('Open #123 leaves its row while “Discard your changes?” asks (`keepsRow`)', () => {
    expect(sheet()).toMatch(
      /fix\.kind === 'openJob'\s+\? \{\s+label: fix\.label,\s+apply: \(\) => latestOpenJob\.current\(fix\),[\s\S]*?keepsRow: true,\s+\}/,
    )
  })

  test('a client mode changed by hand forgets what a fix booked past: the booking is another, and is told of that work again', () => {
    expect(sheet()).toMatch(
      /function switchMode\([\s\S]*?\) \{\s+saveWarnings\.reset\(\)[\s\S]*?setSeen\(NOTHING_SEEN\)[\s\S]*?setMode\(next\)\s+\}/,
    )
  })

  test('the site’s rows go with the date, the repeat and what is seen; a match row only where it named the site’s work (M3’s rows stay as they were)', () => {
    const deps = (source_: string, name: string) => {
      // The check's own registration, not another mention of its name.
      const at = source_.search(new RegExp(`useSaveCheck\\(\\s+'${name}',`))
      expect(at).toBeGreaterThan(-1)
      const list = source_.slice(at).match(/\n {4}\[\n([\s\S]*?)\n {4}\],/)
      return (list?.[1] ?? '')
        .replace(/\/\/.*$/gm, '')
        .split(/,\n/)
        .map((d) => d.replace(/\s+/g, ' ').replace(/,$/, '').trim())
        .filter((d) => d !== '')
    }
    const site = deps(sheet(), 'new-job-site-work')
    expect(site).toEqual(
      expect.arrayContaining(['workDay', 'seen', 'uncheckedSeen']),
    )
    // The day the rows are about: a series' first visit's, which the time
    // can move by a whole interval (`workDayOf`), not the form's.
    expect(site).not.toContain('day')
    expect(sheet()).toMatch(
      /const workDay = workDayOf\(bookingWhen\(\)\?\.dayKey \?\? day, chosenInterval\)/,
    )
    const match = deps(sheet(), 'new-job-client-match')
    for (const dep of [
      'day',
      'chosenInterval?.count',
      'chosenInterval?.unit',
      'seen',
    ]) {
      expect(match).not.toContain(dep)
    }
    // Not the date at all: a dependency takes every row the check gave,
    // and a row that named no work stays as the date moves under it (M3).
    expect(match.join(', ')).not.toMatch(/namedWorkMoved|workDay/)
    // Only the rows that named the work go, once the date or repeat moves:
    // every such row listed, on screen or not (a refusal's rows shown
    // alone, or the list closed), never a refusal's row in a match row's
    // place, whose words name none of it.
    expect(sheet()).toMatch(
      /const refusedRows = saveWarnings\.injected\s+const matchNamesWork = saveWarnings\.listed\.some\(\s+\(w\) =>\s+w\.kind === 'match' &&\s+siteShown\.named\.has\(w\.id\) &&\s+!refusedRows\.includes\(w\),\s+\)\s+const namedMoved = namedWorkMoved\(\{\s+naming: matchNamesWork,\s+workDay,\s+readFor: siteShown\.readFor,\s+\}\)\s+const namedRows = siteShown\.named\s+const dropRows = saveWarnings\.drop\s+const injectedNow = saveWarnings\.injectedNow\s+useEffect\(\(\) => \{\s+if \(namedMoved === null\) return\s+const refused = injectedNow\(\)\s+dropRows\(\s+'new-job-client-match',\s+\(w\) => namedRows\.has\(w\.id\) && !refused\.some\(\(r\) => r === w\),\s+\)\s+\}, \[dropRows, namedMoved, namedRows, injectedNow\]\)/,
    )
    expect(sheet()).not.toMatch(
      /saveWarnings\.warnings\.some\(\s+\(w\) => w\.kind === 'match' && siteShown\.named/,
    )
    // Read for the day as it was at the press.
    expect(sheet()).toMatch(
      /setSiteShown\(\{[\s\S]*?named: new Set\(named\.keys\(\)\),\s+readFor: workDay,\s+\}\)/,
    )
  })

  test('on the Schedule, Open #123 opens the job as the page does: the view kept, and the day moved to as picking it moves (`openJobScroll`)', () => {
    const schedule = source('../../routes/$businessSlug/schedule.tsx')
    expect(schedule).toMatch(
      /const openJobOnDay = \(id: string, dayKey: string\) => \{\s+const \{ resetScroll, focusWeek \} = openJobScroll\(\s+activeView,\s+requestedKey,\s+dayKey,\s+\)\s+if \(focusWeek\) setWeekFocusTick\(\(tick\) => tick \+ 1\)\s+navigate\(\{\s+search: \(prev\) => \(\{\s+\.\.\.prev,\s+date: dayKey,\s+jobId: id,\s+outboxId: undefined,\s+\}\),\s+replace: true,\s+resetScroll,\s+\}\)/,
    )
    expect(schedule).toMatch(
      /<NewJobSheet\s[\s\S]*?\sonOpenJob=\{openJobOnDay\}[\s\S]*?\/>/,
    )
    expect(sheet()).toMatch(
      /closeSheet\(\(\) => \{\s+if \(onOpenJob\) \{\s+onOpenJob\(fix\.jobId, fix\.dayKey\)\s+return\s+\}/,
    )
  })
})
