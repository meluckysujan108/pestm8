// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

/**
 * docs/design-system.md, held to the code it describes.
 *
 * The guide is what an agent or a new hand reads before building a screen,
 * so a guide that has drifted is worse than none: it teaches the old token.
 * These read the guide's tables and the stylesheet and components they
 * describe, and fail when the two disagree — so a token, a size, a radius or
 * a shared component changes in the same commit as the words about it.
 */

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf8')

const guide = read('../../docs/design-system.md')
const css = read('../styles.css')

/** The custom properties declared in the block that opens with `opener`. */
function block(opener: string): Record<string, string> {
  const start = css.indexOf(opener)
  if (start === -1) throw new Error(`no block for ${opener}`)
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start))
  const vars: Record<string, string> = {}
  for (const [, name, value] of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    vars[name] = value.trim()
  }
  return vars
}

const LIGHT = block(":root,\n[data-theme='light'] {")
const DARK = block(":root[data-theme='dark'],\n[data-theme='dark'] {")
const GEOMETRY = block(':root {\n  --radius:')
const THEME = block('@theme inline {')

/** `rgba(60, 60, 67, 0.1)` and `rgba(60,60,67,.1)` are the same colour. */
const normal = (value: string) =>
  value
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/(^|[,(])0\./g, '$1.')

/** Rows of the guide's tables whose first cell matches `first`. */
function rows(first: RegExp): Array<Array<string>> {
  return guide
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim()),
    )
    .filter((cells) => first.test(cells[0]))
}

const code = (cell: string) => /^`([^`]+)`$/.exec(cell)?.[1] ?? cell

describe('the guide’s colour tables match styles.css', () => {
  const colourRows = rows(/^`--[\w-]+`$/)

  test('it has a colour table', () => {
    expect(colourRows.length).toBeGreaterThan(20)
  })

  test.each(colourRows.map((cells) => [code(cells[0]), cells] as const))(
    '%s',
    (token, cells) => {
      const name = token.slice(2)
      expect(normal(code(cells[1])), `${token} light`).toBe(
        normal(LIGHT[name] ?? 'missing'),
      )
      expect(normal(code(cells[2])), `${token} dark`).toBe(
        normal(DARK[name] ?? 'missing'),
      )
    },
  )

  const rampRows = rows(/^`--\w+-\*`$/)

  test.each(rampRows.map((cells) => [code(cells[0]), cells] as const))(
    'the %s status ramp',
    (ramp, cells) => {
      const hue = ramp.slice(2, -2)
      for (const [theme, cell] of [
        [LIGHT, cells[2]],
        [DARK, cells[3]],
      ] as const) {
        const [bg, line, ink] = cell.split('/').map((part) => code(part.trim()))
        expect(normal(bg)).toBe(normal(theme[`${hue}-bg`]))
        expect(normal(line)).toBe(normal(theme[`${hue}-line`]))
        expect(normal(ink)).toBe(normal(theme[`${hue}-ink`]))
      }
    },
  )

  test('every palette token is named in the guide', () => {
    const ramps = new Set(rampRows.map((cells) => code(cells[0]).slice(2, -2)))
    const unnamed = [...new Set([...Object.keys(LIGHT), ...Object.keys(DARK)])]
      .filter((name) => !ramps.has(name.replace(/-(bg|line|ink)$/, '')))
      .filter((name) => !guide.includes(`\`--${name}\``))
    expect(unnamed).toEqual([])
  })
})

describe('the guide’s type scale matches styles.css', () => {
  const typeRows = rows(/^`text-[\w-]+`$/)

  test.each(typeRows.map((cells) => [code(cells[0]), cells] as const))(
    '%s',
    (cls, cells) => {
      const name = cls.slice('text-'.length)
      expect(`${cells[1]}`).toBe(THEME[`text-${name}`])
      expect(cells[2]).toBe(THEME[`text-${name}--font-weight`] ?? '400')
    },
  )

  test('every text size token is in the table', () => {
    const tokens = Object.keys(THEME)
      .filter((name) => /^text-[\w-]+$/.test(name) && !name.includes('--'))
      .map((name) => `\`${name}\``)
    expect(
      tokens.filter((token) => !typeRows.some((r) => r[0] === token)),
    ).toEqual([])
  })
})

describe('the guide’s radii match styles.css', () => {
  /** `var(--radius-card)` → 18px, through the geometry block. */
  const resolve = (value: string): string => {
    const ref = /^var\(--([\w-]+)\)$/.exec(value)
    return ref ? resolve(GEOMETRY[ref[1]]) : value
  }
  const radiusRows = rows(/^`rounded-[\w-]+`$/).filter(
    (cells) => cells[1] !== '—',
  )

  test.each(radiusRows.map((cells) => [code(cells[0]), cells] as const))(
    '%s',
    (cls, cells) => {
      // rounded-t-sheet is the sheet radius on the top corners only.
      const name = cls.replace(/^rounded-(t-)?/, '')
      expect(cells[1]).toBe(resolve(THEME[`radius-${name}`] ?? 'missing'))
    },
  )

  test('every radius token is in the table', () => {
    const named = new Set(
      radiusRows.map((cells) => code(cells[0]).replace(/^rounded-(t-)?/, '')),
    )
    const missing = Object.keys(THEME)
      .filter((name) => name.startsWith('radius-'))
      .map((name) => name.slice('radius-'.length))
      .filter((name) => !named.has(name))
    expect(missing).toEqual([])
  })
})

describe('the guide names every shared utility and component', () => {
  test('every @utility in styles.css', () => {
    const utilities = [...css.matchAll(/^@utility ([\w-]+)/gm)].map((m) => m[1])
    expect(utilities.length).toBeGreaterThan(0)
    expect(utilities.filter((u) => !guide.includes(`\`${u}\``))).toEqual([])
  })

  // The modules a screen is built from. A helper module that only one
  // component uses (primitives/searchEcho.ts) is that component's business.
  const MODULES = [
    'primitives/BarMeter.tsx',
    'primitives/Combobox.tsx',
    'primitives/ContactButtons.tsx',
    'primitives/EmptyState.tsx',
    'primitives/FilterDropdown.tsx',
    'primitives/HoldButton.tsx',
    'primitives/SearchBox.tsx',
    'primitives/Segmented.tsx',
    'primitives/Sheet.tsx',
    'primitives/StatusPill.tsx',
    'primitives/buttons.ts',
    'forms/EmailInput.tsx',
    'forms/FieldMessage.tsx',
    'forms/FormAlert.tsx',
    'forms/FormField.tsx',
    'forms/PhoneInput.tsx',
    'forms/SaveWarnings.tsx',
    'forms/VerifiedAddressFields.tsx',
    'shell/ErrorScreen.tsx',
    'shell/Pending.tsx',
    'settings/ConfirmDialog.tsx',
    'settings/ui.tsx',
  ]

  test('the list above is every primitive there is', () => {
    const primitives = readdirSync(
      new URL('../components/primitives', import.meta.url),
    ).filter((file) => /\.tsx?$/.test(file) && !/\.test\./.test(file))
    expect(
      primitives
        .map((file) => `primitives/${file}`)
        .filter((path) => !MODULES.includes(path)),
    ).toEqual(['primitives/searchEcho.ts'])
  })

  test.each(MODULES)('%s', (path) => {
    const source = read(`../components/${path}`)
    const exported = [
      ...source.matchAll(/^export (?:function|const|class) ([A-Za-z_]\w*)/gm),
    ].map((m) => m[1])
    expect(exported.length).toBeGreaterThan(0)
    // In code, whole: `FIELD` is not named by `FIELD_LABEL`.
    const named = (name: string) => new RegExp(`\`${name}[\`(]`).test(guide)
    expect(exported.filter((name) => !named(name))).toEqual([])
  })
})

describe('the stacking order', () => {
  const layers = new Set(
    rows(/^`z-/).flatMap((cells) =>
      [...cells[0].matchAll(/`(z-[^`]+)`/g)].map((m) => m[1]),
    ),
  )

  test('the guide lists the layers', () => {
    expect([...layers].sort()).toEqual(
      [
        'z-10',
        'z-20',
        'z-30',
        'z-40',
        'z-50',
        'z-[60]',
        'z-[70]',
        'z-[80]',
        'z-[90]',
      ].sort(),
    )
  })

  test('nothing under src/ invents another', () => {
    const src = new URL('../', import.meta.url)
    const files = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\./.test(file))
      .filter((file) => !file.endsWith('routeTree.gen.ts'))
    const strays: Array<string> = []
    for (const file of files) {
      // Classes, not prose: comments here explain the layers ("the viewer
      // is z-80") and are not themselves one.
      const source = readFileSync(new URL(file, src), 'utf8').replace(
        /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
        '',
      )
      for (const [, z] of source.matchAll(
        /(?<![\w-])-?(z-(?:\d+|\[[^\]]+\]))(?![\w-])/g,
      )) {
        if (!layers.has(z)) strays.push(`${file}: ${z}`)
      }
    }
    expect(strays).toEqual([])
  })
})
