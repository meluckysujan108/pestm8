// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * The job sheet loads with the Schedule's first chunk, and lazy-loads the
 * client sheet's notes and reports (the note editor alone is about 411 KB),
 * which took the Schedule's hydration from ~0.7 s to ~70 ms. The forms it
 * edits a client and a property with came out of `ClientSheet.tsx` for that
 * reason: a static import that reaches back to the notes or reports would
 * bring them into whatever loads the form. There is no bundle in these
 * tests, so this follows the static imports in the source instead.
 */
const SRC = resolve(import.meta.dirname, '../..')

/** What a form the job sheet loads must never bring with it. */
const HEAVY = [
  'ClientSheet',
  'ClientJobsTab',
  'ClientNotesSection',
  'InlineNotes',
  'InlineReports',
  'NoteEditor',
]

/**
 * The modules a file's text imports for their values, as written: `import
 * type` is left out (it is gone once compiled), as is `import('…')`, which
 * loads only when called. An import over several lines, a re-export and an
 * import for its side effects (`import './x'`) are all in.
 */
function valueSpecs(text: string): Array<string> {
  return [
    ...text.matchAll(
      /^(?:(?:import\s+(?!type\b)|export\s+[*{])[^'"]*?\sfrom\s+|import\s+)['"]([^'"]+)['"]/gm,
    ),
  ].map((m) => m[1])
}

/**
 * Each module `file` imports for its values, as a path under src. Packages,
 * and modules outside src, are not followed.
 */
function valueImports(file: string): Array<string> {
  return valueSpecs(readFileSync(file, 'utf8')).flatMap((spec) => {
    const base = spec.startsWith('#/')
      ? resolve(SRC, spec.slice(2))
      : spec.startsWith('.')
        ? resolve(dirname(file), spec)
        : null
    if (base === null || !base.startsWith(SRC)) return []
    const found = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']
      .map((ext) => base + ext)
      .find((path) => /\.tsx?$/.test(path) && existsSync(path))
    return found ? [found] : []
  })
}

/** Every module `root` brings with it, itself included. */
function reached(root: string): Set<string> {
  const seen = new Set<string>()
  const queue = [resolve(SRC, root)]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    queue.push(...valueImports(file))
  }
  return seen
}

function heavyIn(modules: Set<string>): Array<string> {
  return [...modules]
    .filter((file) =>
      HEAVY.includes(
        file
          .split('/')
          .at(-1)!
          .replace(/\.tsx?$/, ''),
      ),
    )
    .map((file) => relative(SRC, file))
}

/** The forms the job sheet edits a client and a property with. */
const FORMS = [
  'components/schedule/JobRecordEdit.tsx',
  'components/clients/ClientEditForm.tsx',
  'components/clients/PropertyEditMode.tsx',
  'components/clients/PropertyFields.tsx',
]

describe('the forms the job sheet edits a client and a property with', () => {
  test.each(FORMS)(
    '%s brings none of the client sheet, its notes or its reports',
    (root) => {
      const modules = reached(root)
      // Followed, not stopped at the first import: a scan that read nothing
      // would find nothing heavy either.
      expect(modules.size).toBeGreaterThan(3)
      expect(heavyIn(modules)).toEqual([])
    },
  )

  test('the scan reads every way of importing a module for its values', () => {
    expect(
      valueSpecs(
        [
          "import { a } from './a'",
          "import b, {\n  c,\n  d,\n} from '#/b'",
          "import './c.css'",
          "export { e } from './e'",
          "export * from './f'",
          "import type { G } from './g'",
          "const h = () => import('./h')",
        ].join('\n'),
      ),
    ).toEqual(['./a', '#/b', './c.css', './e', './f'])
  })

  test('the scan finds the client sheet’s notes when they are there', () => {
    expect(heavyIn(reached('components/clients/ClientSheet.tsx'))).toEqual(
      expect.arrayContaining([
        'components/clients/ClientSheet.tsx',
        'components/notes/ClientNotesSection.tsx',
      ]),
    )
  })
})

describe('the job sheet', () => {
  const sheet = 'components/schedule/JobDetailSheet.tsx'
  const text = readFileSync(resolve(SRC, sheet), 'utf8')

  test('imports nothing from the clients, the notes or the reports to draw it: those come when the job opens', () => {
    const fromThere = valueSpecs(text).filter((spec) =>
      /(?:^|\/)(?:clients|notes)\/|reports\/InlineReports/.test(spec),
    )
    expect(fromThere).toEqual([])
    expect(text).toContain("import('./JobRecordEdit')")
  })

  test('brings none of the client sheet, the notes or the reports with it', () => {
    const modules = reached(sheet)
    expect(modules.size).toBeGreaterThan(20)
    expect(heavyIn(modules)).toEqual([])
    // The forms it edits a client and a property with come only when asked,
    // by whatever path they might have come.
    const names = [...modules].map((file) => relative(SRC, file))
    expect(FORMS.filter((form) => names.includes(form))).toEqual([])
  })
})
