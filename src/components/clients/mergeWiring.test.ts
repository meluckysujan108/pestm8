// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * Merge into… and the possible-duplicate line on the client sheet (the
 * matching plan's M8). Their words and order are tested on their own
 * (lib/clientMergeCopy.test.ts, lib/clientMergePicker.test.ts); there is no
 * DOM renderer in these tests to open a sheet or tap a button, so this pins
 * who is offered what, what is asked for and when, and what a tap does with
 * no signal or twice.
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

const sheet = source('./ClientSheet.tsx')
const body = functionText(sheet, 'ClientBody')
const merge = source('./MergeIntoSheet.tsx')

describe('who is offered a merge', () => {
  test('whoever may change clients, as themselves', () => {
    expect(body).toContain("const mayMerge = useCan('clients.manage')")
    expect(body).toContain('const canMerge = mayMerge && !isSwitched')
  })

  test('the lines are read only by the owner and contractors, and only where they can be answered; skipped otherwise', () => {
    expect(body).toContain(
      "const seesHints = useCan('team.manage') && canMerge",
    )
    expect(body).toMatch(
      /convexQuery\(\s*api\.clientMatchHints\.forClient,\s*seesHints \? \{ businessId, clientId \} : 'skip',?\s*\)/,
    )
    // Never a line without its buttons: drawn only with `canMerge`.
    expect(body).toMatch(
      /\{canMerge && firstHints && firstHints\.length > 0 && \(\s*<MaybeSameLines/,
    )
  })

  test('Merge into… is at the foot of Details, never for an archived client', () => {
    expect(body).toMatch(
      /\{canMerge && client\.archivedAt === undefined && \(\s*<button[\s\S]*?\{MERGE_INTO_LABEL\}/,
    )
    expect(body.indexOf('{MERGE_INTO_LABEL}')).toBeLessThan(
      body.indexOf('Delete client'),
    )
  })

  test('the lines sit under Call, Text and Email, decided once, and none on an archived client’s sheet', () => {
    expect(body.indexOf('<ContactButtons')).toBeLessThan(
      body.indexOf('<MaybeSameLines'),
    )
    // Decided by firstHintsNow (lib/clientMergePicker.test.ts), with the
    // archived client, the skip and the refusal in it.
    expect(body).toMatch(
      /if \(firstHints === null\) \{\s*const decided = firstHintsNow\(\{\s*client: clientQuery\.data,\s*hints: hintsQuery\.data,\s*settled: !seesHints \|\| hintsQuery\.isError,\s*waited: hintsLate,?\s*\}\)\s*if \(decided !== null\) setFirstHints\(decided\)/,
    )
  })

  test('the lines answered a moment after the client still show: the decision waits for them, a short while after the client draws', () => {
    // Each query is its own subscription, answered in turn, so the client
    // can draw before its lines: deciding then would leave them out of
    // almost every opening.
    expect(body).toMatch(
      /useEffect\(\(\) => \{\s*if \(firstHints !== null \|\| !clientDrawn\) return\s*const late = setTimeout\(\(\) => setHintsLate\(true\), HINTS_AFTER_DRAW_MS\)\s*return \(\) => clearTimeout\(late\)\s*\}, \[firstHints, clientDrawn\]\)/,
    )
    expect(body).toContain('const clientDrawn = Boolean(clientQuery.data)')
  })

  test('a line that comes later waits for the next opening; one gone from the server goes, unless answered here', () => {
    // The lines drawn are the first answer's, each while the server lists
    // it: never one put in under Book a job while the sheet is in use.
    expect(body).toContain('hints={firstHints}')
    expect(body).toContain('live={liveHints}')
    // Live by its id and the client it pairs them with now: a merge
    // elsewhere hands a hint to a third client under the same id
    // (shownHints, lib/clientMergePicker.test.ts).
    expect(body).toMatch(
      /new Map<string, string>\(\s*hintsQuery\.data\?\.map\(\(hint\) => \[hint\._id, hint\.otherClientId\]\),?\s*\)/,
    )
    expect(functionText(merge, 'MaybeSameLines')).toContain(
      'const shown = shownHints(hints, live, answered)',
    )
  })

  test('the line names the other client by number where the two are called the same, from the client list in memory as it first draws', () => {
    const line = functionText(merge, 'MaybeSameLine')
    expect(line).toMatch(
      /const \[otherSaid\] = useState\(\(\) =>\s*maybeSameName\(\s*here\.name,\s*hint\.otherName,\s*queryClient\s*\.getQueryData<Directory>\(rq\.directory\(businessId\)\.queryKey\)\s*\?\.clients\.find\(\(c\) => c\._id === hint\.otherClientId\)\?\.clientNumber,?\s*\),?\s*\)/,
    )
    expect(line).toContain('{maybeSameLine(otherSaid, hint.evidence, through)}')
    expect(line).toContain('notTheSameSaved(otherSaid)')
  })

  test('the line says whose contact person a name agreed through, decided as it first draws, with the other’s kind from the client list in memory', () => {
    const line = functionText(merge, 'MaybeSameLine')
    expect(line).toMatch(
      /const \[through\] = useState\(\(\) =>\s*hintThroughContact\(\s*here,\s*\{\s*name: hint\.otherName,\s*kind: queryClient\s*\.getQueryData<Directory>\(rq\.directory\(businessId\)\.queryKey\)\s*\?\.clients\.find\(\(c\) => c\._id === hint\.otherClientId\)\?\.kind,?\s*\},\s*hint,?\s*\),?\s*\)/,
    )
  })

  test('Not the same keeps its line where it was, saying what was saved, so the next line never slides up under the thumb', () => {
    const line = functionText(merge, 'MaybeSameLine')
    // Kept before the answer is sent: the server may drop it before the
    // mutation's own answer comes.
    expect(line).toMatch(
      /onConfirm=\{\(\) => \{[^}]*onAnswering\(\)\s*answer\.mutate\(\)/,
    )
    expect(line).toContain(
      '<Saved>{answer.isSuccess && notTheSameSaved(otherSaid)}</Saved>',
    )
  })

  test('the saved line’s status is in the accessibility tree while empty, so a screen reader hears it fill', () => {
    const saved = functionText(merge, 'Saved')
    expect(saved).toMatch(/role="status"\s*className="[^"]*\bempty:mt-0\b/)
    // display: none would take it out of the tree until it filled.
    expect(saved).not.toContain('empty:hidden')
  })

  test('Not the same asks first, held a moment as it comes up under the tap, since its answer can’t be taken back', () => {
    const line = functionText(merge, 'MaybeSameLine')
    // The button only asks.
    const button = line.slice(
      line.indexOf('<button', line.indexOf('{MAYBE_SAME_MERGE}')),
      line.indexOf('{answer.isPending ? '),
    )
    expect(button).toMatch(/setAsking\(true\)\s*setAskHeld\(true\)/)
    expect(button).not.toContain('answer.mutate')
    // The dialog answers, held for FIX_ARM_MS.
    expect(line).toMatch(
      /<ConfirmDialog\s+open=\{asking\}[\s\S]*?title=\{notTheSameTitle\(otherSaid\)\}[\s\S]*?confirm=\{MAYBE_SAME_DIFFERENT\}[\s\S]*?cancel=\{NOT_THE_SAME_CANCEL\}[\s\S]*?held=\{askHeld\}/,
    )
    expect(line).toMatch(
      /if \(!askHeld\) return\s*const release = setTimeout\(\(\) => setAskHeld\(false\), FIX_ARM_MS\)/,
    )
    // Answered, focus goes to the line, not the greyed-out button.
    expect(line).toContain(
      'returnFocus={(confirmed) => (confirmed ? sentence.current : null)}',
    )
    expect(line).toMatch(
      /id=\{sentenceId\}\s+ref=\{sentence\}\s+tabIndex=\{-1\}/,
    )
  })

  test('a line whose other client is archived greys Merge… out and says why; the pair says so too', () => {
    const line = functionText(merge, 'MaybeSameLine')
    expect(line).toContain(
      'const otherArchived = other != null && other.archivedAt !== undefined',
    )
    expect(line).toMatch(
      /disabled=\{!hydrated \|\| busy \|\| held \|\| otherArchived\}[\s\S]*?\{MAYBE_SAME_MERGE\}/,
    )
    expect(line).toMatch(
      /\{otherArchived && \([\s\S]*?mergeArchivedNote\(named\.into\)/,
    )
    expect(merge).toContain(
      'copy={clientMergeErrorCopy(names.from, names.into, archived)}',
    )
  })

  test('Not the same promises Merge into… only where the other client’s record says they can still be merged, decided as it asks', () => {
    const line = functionText(merge, 'MaybeSameLine')
    // Archived (Merge into… leaves them out, a merge refuses them), gone,
    // or not answered yet: no promise.
    const button = line.slice(
      line.indexOf('<button', line.indexOf('{MAYBE_SAME_MERGE}')),
      line.indexOf('{answer.isPending ? '),
    )
    expect(button).toMatch(
      /setAskMergeLater\(other != null && !otherArchived\)\s*setAsking\(true\)/,
    )
    expect(line).toMatch(
      /<ConfirmDialog\s+open=\{asking\}[\s\S]*?body=\{notTheSameText\(askMergeLater\)\}/,
    )
    expect(merge).not.toContain('NOT_THE_SAME_TEXT')
  })

  test('their sheet, opened next, has its lines: a line asks for the other client’s with their record', () => {
    const line = functionText(merge, 'MaybeSameLine')
    expect(line).toMatch(
      /convexQuery\(api\.clients\.get, \{\s*businessId,\s*clientId: hint\.otherClientId,?\s*\}\)/,
    )
    expect(line).toMatch(
      /convexQuery\(\s*api\.clientMatchHints\.forClient,\s*seesHints \? \{ businessId, clientId: hint\.otherClientId \} : 'skip',?\s*\)/,
    )
    expect(line).toContain("const seesHints = useCan('team.manage')")
  })

  test('no merge while a contact or site is half-typed: the hand-over to the client kept would lose it', () => {
    expect(body).toMatch(
      /aria-haspopup="dialog"\s*disabled=\{!hydrated \|\| formOpen\}[\s\S]*?\{MERGE_INTO_LABEL\}/,
    )
    expect(body).toContain('held={formOpen}')
  })

  test('each line’s buttons are named by its sentence, and both merges say they open a sheet', () => {
    const line = functionText(merge, 'MaybeSameLine')
    expect(line).toMatch(/<p\s+id=\{sentenceId\}/)
    expect(line).toMatch(/<div\s+role="group"\s+aria-labelledby=\{sentenceId\}/)
    expect(line).toMatch(/aria-haspopup="dialog"[\s\S]*?\{MAYBE_SAME_MERGE\}/)
  })

  test('the copy kept on the phone offers neither', () => {
    const kept = source('./KeptClientView.tsx')
    expect(kept).not.toMatch(/Merge|clientMatchHints|MaybeSame/)
  })
})

describe('what is asked for, and when', () => {
  test('nothing is only disabled: every query is skipped until it is wanted', () => {
    expect(merge).not.toMatch(/enabled:/)
    expect(merge).toMatch(
      /api\.clients\.directory, asked \? \{ businessId \} : 'skip'/,
    )
    expect(merge).toMatch(
      /api\.memberships\.listForBusiness,\s*asked \? \{ businessId \} : 'skip'/,
    )
    expect(merge).toMatch(/api\.clientMerge\.mergePreview,\s*open && pair\s*\?/)
  })

  test('the list, once asked for, is not dropped as the sheet slides away: it leaves with its rows', () => {
    const list = functionText(merge, 'PickList')
    expect(list).toMatch(
      /const \[asked, setAsked\] = useState\(open\)\s*if \(open && !asked\) setAsked\(true\)/,
    )
  })

  test('a roster that failed says so, rather than a placeholder waiting for good; the search bar is there from the first frame', () => {
    const list = functionText(merge, 'PickList')
    expect(list).toMatch(
      /if \(answer\.isError \|\| \(rows === null && roster\.isError\)\) \{\s*return \(\s*<LoadFailed/,
    )
    expect(list).toMatch(
      /if \(rows === null\) \{\s*return \(\s*<>\s*\{searchBar\}\s*<RowsPending \/>/,
    )
  })

  test('its placeholder is shaped as its rows, at their gap, not as cards', () => {
    const bones = functionText(merge, 'RowsPending')
    expect(bones).toMatch(
      /<div aria-hidden className="flex flex-col gap-1\.5">[\s\S]*?<Bone key=\{`bone-\$\{i\}`\} className="h-\[62px\] rounded-xl" \/>/,
    )
    expect(bones).toMatch(/<div role="status">\s*<span className="sr-only">/)
    // The rows it stands in for: a row-card at that gap.
    const list = functionText(merge, 'PickList')
    expect(list).toContain('<ul className="flex flex-col gap-1.5">')
    expect(list).toContain(
      'flex min-h-12 w-full items-center gap-3 rounded-xl border border-hairline bg-surface px-3 py-2.5',
    )
    expect(merge).not.toMatch(/<ListPending|<CardRows|<CardCells/)
  })

  test('Choose another goes back to the list as it was searched: the search is the sheet’s, not the list’s, which the pair takes the place of', () => {
    const outer = functionText(merge, 'MergeIntoSheet')
    expect(outer).toContain("const [query, setQuery] = useState('')")
    expect(outer).toMatch(
      /<PickList[\s\S]*?query=\{query\}\s*onQuery=\{setQuery\}/,
    )
    const list = functionText(merge, 'PickList')
    expect(list).not.toMatch(/useState\(''\)/)
    expect(list).toMatch(/value=\{query\}\s*onChange=\{onQuery\}/)
  })

  test('the matcher reads the book without the client being merged', () => {
    expect(functionText(merge, 'PickList')).toContain(
      'mergeBook(directory, client._id)',
    )
  })
})

describe('no signal, and a double tap', () => {
  test('every save fails fast with no signal', () => {
    const fns = [...merge.matchAll(/mutationFn: async \([^)]*\) => \{\n(.*)/g)]
    expect(fns.length).toBe(2)
    for (const fn of fns) {
      expect(fn[1].trim()).toBe("if (isOffline()) throw new Error('offline')")
    }
  })

  test('Merge… on a line, and a row in the list, say so at once rather than open a pair that waits', () => {
    expect(functionText(merge, 'MaybeSameLine')).toMatch(
      /if \(isOffline\(\)\) \{\s*setMergeOffline\(true\)\s*return\s*\}[\s\S]*onMerge\(/,
    )
    expect(functionText(merge, 'PickList')).toMatch(
      /if \(isOffline\(\)\) \{\s*onOffline\(true\)\s*return\s*\}[\s\S]*onPick\(/,
    )
  })

  test('a row’s no-signal refusal is in the footer, above Done, never put in above the rows', () => {
    expect(functionText(merge, 'PickList')).not.toContain('<FormAlert')
    expect(functionText(merge, 'MergeIntoSheet')).toMatch(
      /<FormAlert\s+className="mb-2"\s+error=\{rowOffline \? new Error\('offline'\) : null\}[\s\S]*?Done/,
    )
  })

  test('Merge merges once, however often it is tapped', () => {
    expect(merge).toMatch(
      /onConfirm=\{\(\) => \{\s*if \(sent\.current\) return\s*sent\.current = true\s*merge\.mutate\(\{ pair, names \}\)/,
    )
    // Refused, it can be asked again.
    expect(merge).toMatch(/onError: \(\) => \{\s*sent\.current = false/)
    expect(merge).toContain('closeOnConfirm={false}')
  })
})

describe('the pair', () => {
  test('from a line, its lone Merge… is full width, as every lone sheet button is', () => {
    expect(functionText(merge, 'PairFooter')).toMatch(
      /picking\s*\? `\$\{NEUTRAL_BUTTON_COMPACT\} flex-1`\s*: `\$\{NEUTRAL_BUTTON\} w-full`/,
    )
  })

  test('put up from the list, Keep {B} instead takes no tap for a moment: it lands under the thumb that tapped a row', () => {
    const outer = functionText(merge, 'MergeIntoSheet')
    expect(outer).toMatch(
      /onPick=\{\(into\) => \{\s*choose\(\{ from: client, into \}\)\s*setSwapHold\(\(n\) => \(n \?\? 0\) \+ 1\)/,
    )
    expect(outer).toMatch(
      /if \(swapHold === null\) return\s*const release = setTimeout\(\(\) => setSwapHold\(null\), FIX_ARM_MS\)/,
    )
    expect(outer).toContain('held={swapHold !== null}')
    // Held pressed in, never dimmed, and the tap does nothing meanwhile.
    expect(functionText(merge, 'PairBody')).toMatch(
      /aria-disabled=\{held \|\| undefined\}\s*onClick=\{\(\) => \{\s*if \(held\) return\s*onSwap\(\)\s*\}\}\s*className=\{`\$\{LINK_BUTTON_COMPACT\} \$\{HELD_BUTTON\} mt-2 w-full`\}/,
    )
  })

  test('Try again asks the preview again, as its words say, never the confirm over counts it no longer stands by', () => {
    const outer = functionText(merge, 'MergeIntoSheet')
    expect(outer).toContain('const retry = preview.isError && !refused')
    expect(outer).toContain('retry={retry}')
    expect(outer).toMatch(
      /onAsk=\{\(\) => \{\s*if \(counted === undefined \|\| retry\) \{\s*void preview\.refetch\(\)\s*return\s*\}/,
    )
    expect(functionText(merge, 'PairFooter')).toMatch(
      /: retry\s*\? MERGE_TRY_AGAIN_LABEL/,
    )
  })
})

describe('someone who may no longer merge', () => {
  test('the merge sheet goes once a switch or a role takes clients.manage away', () => {
    const outer = functionText(sheet, 'ClientSheet')
    expect(outer).toContain("const mayMerge = useCan('clients.manage')")
    expect(outer).toContain('const canMerge = mayMerge && !isSwitched')
    expect(outer).toMatch(
      /if \(merge !== null && \(merge\.for !== clientId \|\| !canMerge\)\) \{\s*setMerge\(null\)\s*setMergeOpen\(false\)/,
    )
  })
})

describe('done', () => {
  test('the notice names the two as the confirm did, from the preview, not the pair as a line first made it', () => {
    expect(merge).toMatch(
      /onSuccess: \(\{ pair: chosen, names: said \}\) => \{[\s\S]*?mergedCopy\(said\.from, said\.into\)/,
    )
    expect(merge).toContain(
      'const names = sides && mergeNames(sides.from, sides.into)',
    )
  })

  test('focus goes back to what opened the merge, or once merged to the line saying so', () => {
    const outer = functionText(sheet, 'ClientSheet')
    expect(outer).toContain('mergeReturn.current = opener')
    expect(outer).toContain('returnFocusRef={mergeReturn}')
    expect(outer).toMatch(/if \(el\) mergeReturn\.current = el/)
    expect(merge).toContain('returnFocusRef={returnFocusRef}')
    expect(body).toMatch(
      /<p\s+key=\{merged\}\s+ref=\{mergedRef\}\s+tabIndex=\{-1\}\s+role="status"/,
    )
  })

  test('the client kept is asked for while the pair is up, record and lines, so their sheet opens on them at once, lines and all, and focus lands on “Merged —”', () => {
    const outer = functionText(merge, 'MergeIntoSheet')
    expect(outer).toMatch(
      /convexQuery\(\s*api\.clients\.get,\s*open && pair \? \{ businessId, clientId: pair\.into\._id \} : 'skip',?\s*\)/,
    )
    expect(outer).toMatch(
      /convexQuery\(\s*api\.clientMatchHints\.forClient,\s*open && pair && seesHints\s*\? \{ businessId, clientId: pair\.into\._id \}\s*: 'skip',?\s*\)/,
    )
    expect(outer).toContain("const seesHints = useCan('team.manage')")
  })

  test('the sheet behind gives way to the client kept, with what was merged said', () => {
    const outer = functionText(sheet, 'ClientSheet')
    expect(outer).toMatch(
      /setKept\(\{ for: clientId, id: done\.into\._id, notice: done\.notice \}\)/,
    )
    expect(outer).toContain('key={shownId}')
    expect(outer).toContain('merged={kept?.notice}')
    // Over the sheet, outside the client's own body, so it slides away
    // rather than going with the merged-away client.
    expect(outer.indexOf('<MergeIntoSheet')).toBeGreaterThan(
      outer.indexOf('<ClientBody'),
    )
    expect(body).toMatch(/\{merged && \([\s\S]*?<p[\s\S]*?role="status"/)
  })
})
