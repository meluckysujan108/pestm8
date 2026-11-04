import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { SaveWarningsPanel, SaveWarningsProvider } from './SaveWarnings'
import type { SaveWarning, SaveWarningsController } from './SaveWarnings'

/**
 * The panel as it is drawn: the fields' own warnings first and the clients
 * the caller may be after them, a second fix beside the first, the foot's
 * line for match rows alone, the note on where they were found, and fixes
 * held `aria-disabled` while the list has only just come in.
 */

const typo: SaveWarning = {
  id: 'email:typo',
  label: 'Email',
  message: 'Did you mean jane@gmail.com?',
  fix: { label: 'Use it', apply: () => {} },
}
const jane: SaveWarning = {
  id: 'match:c_jane',
  kind: 'match',
  label: 'Already a client',
  message:
    'Jane Nguyen has the same name and mobile. 12 Watle St looks like Jane Nguyen’s 12 Wattle St, Bayswater.',
  fix: { label: 'Book at 12 Wattle St', apply: () => {} },
  fix2: { label: 'Add 12 Watle St', apply: () => {} },
}

function controller(
  warnings: Array<SaveWarning>,
  fixArmed = false,
): SaveWarningsController {
  const nothing = () => {}
  return {
    guard: nothing,
    saveLabel: (label) => label,
    checking: false,
    warnings,
    reset: nothing,
    armed: false,
    isArmed: () => false,
    fixArmed,
    fixIgnored: () => fixArmed,
    fields: {
      register: () => nothing,
      edited: nothing,
      removed: nothing,
      fix: nothing,
    },
  }
}

const foot = (rows: ReadonlyArray<SaveWarning>) =>
  `${rows.length === 1 ? 'Use it' : 'Use one'}, or press Book anyway to add a new client.`

function draw(warnings: Array<SaveWarning>, fixArmed = false, note?: string) {
  return renderToStaticMarkup(
    <SaveWarningsProvider value={controller(warnings, fixArmed)}>
      <SaveWarningsPanel
        anywayLabel="Book anyway"
        matchFooter={foot}
        note={note}
      />
    </SaveWarningsProvider>,
  )
}

describe('SaveWarningsPanel', () => {
  test('match rows go last, under the fields’ own', () => {
    const html = draw([jane, typo])
    expect(html.indexOf('Email:')).toBeLessThan(
      html.indexOf('Already a client:'),
    )
    expect(html).toContain('2 things to check before saving')
    // Mixed: today's line at the foot.
    expect(html).toContain(
      'Fix them, or press Book anyway to keep them as they are.',
    )
  })

  test('two fixes side by side, the foot naming what Book anyway does, and the note last', () => {
    const html = draw(
      [jane],
      false,
      'From the clients on this phone, updated 9:42am.',
    )
    expect(html).toContain('>Book at 12 Wattle St</button>')
    expect(html).toContain('>Add 12 Watle St</button>')
    expect(html).toContain('Use it, or press Book anyway to add a new client.')
    expect(html.indexOf('add a new client.')).toBeLessThan(
      html.indexOf('From the clients on this phone, updated 9:42am.'),
    )
  })

  test('fixes are held aria-disabled while the list has only just come in, and only then', () => {
    expect(draw([jane], true).match(/aria-disabled="true"/g)).toHaveLength(2)
    expect(draw([jane], false)).not.toContain('aria-disabled')
  })

  test('nothing at all with nothing to say', () => {
    expect(draw([])).toBe('')
  })
})
