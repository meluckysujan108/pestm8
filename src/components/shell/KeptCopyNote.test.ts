import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { KeptCopyNote } from './KeptCopyNote'
import type { KeptNote } from '#/lib/offline/useKept'

/**
 * The "Updated" note keeps the height it first painted with, whatever its
 * words become: every first line it can say is laid in the same place, and
 * the "Updated" line is always there. And the server's words are already
 * the ones for no signal when the head script says the phone has none.
 */

const TZ = 'Australia/Perth'
const TODAY = '2026-10-25'
/** 9:42am in Perth on TODAY. */
const AT = Date.UTC(2026, 9, 25, 1, 42)

const FIRST_LINES = [
  'No signal — showing the copy kept on this phone.',
  'Could not reach PestM8 — showing the kept copy.',
  'Showing the copy kept on this phone.',
  'Up to date.',
]

function note(props: Pick<KeptNote, 'phase' | 'tone' | 'asOf'>): string {
  return renderToStaticMarkup(
    createElement(KeptCopyNote, { ...props, timezone: TZ, todayKey: TODAY }),
  )
}

/** The words shown, without the unseen ones that hold the height. */
function shownWords(html: string): string {
  return (
    /data-kept-words[^>]*>(.*?)<\/span><span aria-hidden/.exec(html)?.[1] ?? ''
  )
}

describe('the note’s height', () => {
  test.each([
    ['hydrating', 'kept'],
    ['shown', 'no-signal'],
    ['shown', 'unreachable'],
    ['shown', 'kept'],
    ['shown', 'live'],
  ] as const)('%s, %s: every first line is laid under it', (phase, tone) => {
    const html = note({ phase, tone, asOf: AT })
    const sizers = html.match(/data-kept-sizer/g) ?? []
    expect(sizers).toHaveLength(FIRST_LINES.length)
    for (const line of FIRST_LINES) expect(html).toContain(line)
    expect(html).toContain('Updated 9:42am')
  })

  test('the second line is there before any time is known', () => {
    const html = note({ phase: 'shown', tone: 'kept', asOf: null })
    expect(html).toContain('<span class="block"> </span>')
  })

  test('hidden, it is not drawn at all', () => {
    expect(note({ phase: 'hidden', tone: 'kept', asOf: AT })).toBe('')
  })
})

describe('the words', () => {
  test('the server draws it hidden, in the neutral words or, with no signal, those for it', () => {
    const html = note({ phase: 'hydrating', tone: 'kept', asOf: AT })
    expect(html).toContain('hidden kept:flex')
    const words = shownWords(html)
    expect(words).toContain(
      '<span class="kept-offline:hidden">Showing the copy kept on this phone.</span>',
    )
    expect(words).toContain(
      '<span class="hidden kept-offline:inline">No signal — showing the copy kept on this phone.</span>',
    )
  })

  test('shown, they follow the line', () => {
    expect(
      shownWords(note({ phase: 'shown', tone: 'unreachable', asOf: AT })),
    ).toBe('Could not reach PestM8 — showing the kept copy.')
    const live = note({ phase: 'shown', tone: 'live', asOf: AT })
    expect(shownWords(live)).toBe('Up to date.')
    expect(live).toContain('Updated 9:42am')
  })
})
