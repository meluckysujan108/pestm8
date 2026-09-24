// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { jobStatus } from '../../convex/schema'
import { contrastRatio } from './contrast'
import {
  JOB_STATUS,
  OVERDUE_CHIP,
  REPORT_PILL,
  TONE_CHART,
  TONE_PILL,
  jobStatusStyle,
} from './statusColours'
import type { StatusTone } from './statusColours'

/**
 * The status colours as they will actually render: read out of styles.css,
 * not restated here, so a token retuned in the stylesheet is checked as it
 * now stands. There is no DOM in this suite — the ratios are computed.
 */
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')

/** The custom properties declared in the block that opens with `selector`. */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector)
  if (start === -1) throw new Error(`no block for ${selector}`)
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start))
  const vars: Record<string, string> = {}
  for (const [, name, value] of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    vars[name] = value.trim()
  }
  return vars
}

const THEMES = {
  light: block(":root,\n[data-theme='light'] {"),
  dark: block(":root[data-theme='dark'],\n[data-theme='dark'] {"),
}

/** The theme-independent contract block, where --overdue is declared. */
const CONTRACT = block(':root,\n[data-theme] {')

const TONES: Array<StatusTone> = [
  'orange',
  'red',
  'yellow',
  'green',
  'blue',
  'grey',
]

describe('status colours in the stylesheet', () => {
  for (const [theme, vars] of Object.entries(THEMES)) {
    describe(theme, () => {
      test.each(TONES)(
        '%s: the word clears 7:1 on its pill (grey 6:1)',
        (tone) => {
          const ratio = contrastRatio(vars[`${tone}-ink`], vars[`${tone}-bg`])
          expect(ratio).toBeGreaterThanOrEqual(tone === 'grey' ? 6 : 7)
        },
      )

      test.each(TONES)(
        '%s: the border holds 3:1 on the card, so the pill survives sun',
        (tone) => {
          expect(
            contrastRatio(vars[`${tone}-line`], vars.surface),
          ).toBeGreaterThanOrEqual(3)
        },
      )

      test('overdue — its own two tokens, resolved — is far past AA', () => {
        const resolve = (token: string) => {
          const ref = /^var\(--([\w-]+)\)$/.exec(CONTRACT[token])
          if (!ref)
            throw new Error(`--${token} is not a var(): ${CONTRACT[token]}`)
          return vars[ref[1]]
        }
        expect(
          contrastRatio(resolve('overdue-ink'), resolve('overdue')),
        ).toBeGreaterThanOrEqual(7)
      })
    })
  }

  test('every ramp token is declared in both themes and mapped for Tailwind', () => {
    for (const tone of TONES) {
      for (const part of ['bg', 'line', 'ink']) {
        expect(THEMES.light[`${tone}-${part}`]).toMatch(/^#[0-9a-f]{6}$/i)
        expect(THEMES.dark[`${tone}-${part}`]).toMatch(/^#[0-9a-f]{6}$/i)
        expect(css).toContain(
          `--color-${tone}-${part}: var(--${tone}-${part});`,
        )
      }
    }
    expect(css).toContain('--color-overdue: var(--overdue);')
    expect(css).toContain('--color-overdue-ink: var(--overdue-ink);')
  })

  test('overdue carries no hue: it is ink on the surface, in every theme', () => {
    expect(CONTRACT.overdue).toBe('var(--ink)')
    expect(CONTRACT['overdue-ink']).toBe('var(--surface)')
  })

  test('amber keeps meaning "warning" and is none of the status hues', () => {
    expect(Object.values(TONE_PILL).join(' ')).not.toContain('amber')
    expect(OVERDUE_CHIP).not.toContain('amber')
  })
})

describe('which status takes which hue', () => {
  test('covers exactly the statuses the schema admits', () => {
    const schemaStatuses = jobStatus.members.map((m) => m.value).sort()
    expect(Object.keys(JOB_STATUS).sort()).toEqual(schemaStatuses)
  })

  test('is the mapping the brief asked for', () => {
    expect(
      Object.fromEntries(
        Object.entries(JOB_STATUS).map(([status, { tone }]) => [status, tone]),
      ),
    ).toEqual({
      recurring: 'orange',
      pending: 'red',
      booked: 'yellow',
      completed: 'green',
      invoiced: 'blue',
      cancelled: 'grey',
    })
  })

  test('every pill says its word; hue never separates two statuses alone', () => {
    const labels = Object.values(JOB_STATUS).map((s) => s.label)
    expect(new Set(labels).size).toBe(labels.length)
    for (const status of Object.keys(JOB_STATUS)) {
      expect(jobStatusStyle(status).label).toBeTruthy()
    }
  })

  test('the class strings are written out whole, so Tailwind finds them', () => {
    expect(TONE_PILL.yellow).toBe(
      'border border-yellow-line bg-yellow-bg text-yellow-ink',
    )
    expect(TONE_CHART.green).toBe('var(--green-line)')
  })

  test('a status this build has never heard of shows its own name in grey', () => {
    expect(jobStatusStyle('inProgress')).toEqual({
      label: 'inProgress',
      pill: TONE_PILL.grey,
      chart: TONE_CHART.grey,
    })
  })

  test('a draft report stays amber; the locked ones take the ramps', () => {
    expect(REPORT_PILL.draft).toContain('amber')
    expect(REPORT_PILL.finalised).toBe(TONE_PILL.green)
    expect(REPORT_PILL.sent).toBe(TONE_PILL.blue)
  })
})

describe('the old styles are gone', () => {
  const read = (path: string) =>
    readFileSync(new URL(`../components/${path}`, import.meta.url), 'utf8')

  // Only where a status or overdue is drawn: amber is still every warning
  // banner's colour, and blue still the active filter chip's.
  test.each([
    'primitives/StatusPill.tsx',
    'reports/InlineReports.tsx',
    'reports/ReportsLibrary.tsx',
    'reports/ReportDocument.tsx',
  ])('%s draws no 2:1 tinted status pill', (path) => {
    expect(read(path)).not.toMatch(/bg-(green|blue)\/12/)
  })

  test.each([
    'schedule/JobCard.tsx',
    'schedule/DayAgendaPanel.tsx',
    'shell/AppShell.tsx',
    'shell/MobileDock.tsx',
  ])('%s draws overdue without amber', (path) => {
    // Comments may still say why amber went; class names may not use it.
    const code = read(path).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    expect(code).not.toContain('amber')
  })
})
