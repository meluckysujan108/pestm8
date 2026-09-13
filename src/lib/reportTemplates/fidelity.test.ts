// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { getTemplate } from './index'
import {
  blockText,
  collectTemplateStrings,
  nonWinAnsi,
  normalise,
  sourceText,
} from './fidelity'
import { canonicalise, snapshotOf } from './snapshot'
import { serviceReportSource } from './spec/serviceReport.generated'
import { timberPestInspectionSource } from './spec/timberPestInspection.generated'
import { termiteManagementCertSource } from './spec/termiteManagementCert.generated'
import type { SourceString } from './spec/types'
import type { ReportTemplate, RichBlock, TemplateId } from './types'

/**
 * The word-for-word guarantee, enforced.
 *
 * TEST A — nothing omitted. Every string mechanically extracted from the
 * source forms is in the template, or is a documented correction, or is
 * explicitly accounted for in `superseded` with the precedence rule that
 * superseded it.
 *
 * TEST B — nothing invented. Every string the template shows or prints appears
 * verbatim in the vendored source, or is a documented correction. Held against
 * the raw source text as well as the extracted corpus, because the extractor
 * is a best-effort parser of loosely structured markdown and misses some plain
 * lines; "it is written in the source document" is the property that matters.
 *
 * One side of each comparison is mechanical. A test comparing a hand-written
 * template with a hand-written fixture passes on a shared typo.
 *
 * See docs/reports/fidelity.md for the precedence rules and the registers.
 */

const ROOT = new URL('../../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf8')

type Case = {
  id: TemplateId
  corpus: Array<SourceString>
  sources: Array<string>
}

const CASES: Array<Case> = [
  {
    id: 'serviceReport',
    corpus: serviceReportSource,
    sources: ['docs/sources/service-report-spec.md', 'docs/sources/service-report-submitted.md'],
  },
  {
    id: 'timberPestInspection',
    corpus: timberPestInspectionSource,
    // The interim terms are the Certificate's, so its source is in scope.
    sources: ['docs/sources/timber-pest-inspection.md', 'docs/sources/termite-certificate.md'],
  },
  {
    id: 'termiteManagementCert',
    corpus: termiteManagementCertSource,
    sources: ['docs/sources/termite-certificate.md'],
  },
]

function applyCorrections(text: string, template: ReportTemplate): string {
  let out = text
  for (const c of template.corrections ?? []) {
    out = out.split(c.source).join(c.printed)
  }
  return out
}

describe.each(CASES)('$id', ({ id, corpus, sources }) => {
  const template = getTemplate(id)
  const strings = collectTemplateStrings(template)
  const sections = template.sections ?? []

  // Section titles are compared both bare and numbered: the corpus records
  // "1. CLIENT DETAILS" where the template stores number 1 and the title.
  const numberedTitles = sections
    .filter((s) => s.number !== undefined)
    .map((s) => normalise(`${s.number}. ${s.title}`))

  const exactSet = new Set([
    ...strings.exact.map((s) => normalise(s.text)),
    ...numberedTitles,
  ])
  const proseBlocks = strings.prose.map((s) => normalise(s.text))
  const proseBlob = proseBlocks.join(' ')
  const templateBlob = normalise(
    [...strings.exact.map((s) => s.text), ...proseBlocks].join(' '),
  )

  // Bold lead-ins inside a RichDoc — "Constructions issues and faults:" opening
  // a bullet — are labels in the source's own structure. Trailing colon dropped,
  // as the extractor drops it.
  const leadIns = new Set<string>()
  const walkRuns = (blocks: Array<RichBlock>) => {
    for (const block of blocks) {
      if (block.type === 'heading' || block.type === 'paragraph') {
        const first = block.content.at(0)
        if (first?.marks?.includes('bold')) {
          leadIns.add(normalise(first.text).replace(/:$/, ''))
        }
      } else {
        block.content.forEach((item) => walkRuns(item.content))
      }
    }
  }
  if (template.terms) walkRuns(template.terms.content)
  for (const field of sections.flatMap((section) => section.fields)) {
    if (field.kind === 'note') walkRuns(field.body.content)
  }

  const corpusTexts = corpus.map((entry) => normalise(entry.text))
  const corpusSet = new Set(corpusTexts)
  // The source as the client would read it once the documented corrections are
  // applied — the only form a template string is allowed to take.
  const uncorrectedSource = normalise(
    sources.map((path) => sourceText(read(path))).join(' '),
  )
  const rawSource = applyCorrections(uncorrectedSource, template)
  const correctedCorpusBlob = applyCorrections(corpusTexts.join(' \n '), template)

  const corrections = template.corrections ?? []
  const superseded = template.superseded ?? []

  test('declares its source and registers', () => {
    expect(template.version).toBe(2)
    expect(template.sourceRef).toBeTruthy()
    expect(Array.isArray(template.corrections)).toBe(true)
    expect(Array.isArray(template.superseded)).toBe(true)
    expect(template.fields).toEqual([])
    expect(template.boilerplate).toBe('')
  })

  test('A — every source string is used, corrected, or accounted for', () => {
    const correctionSources = new Set(corrections.map((c) => normalise(c.source)))
    const supersededTexts = new Set(superseded.map((s) => normalise(s.text)))

    const missing = corpus.filter((entry) => {
      const text = normalise(entry.text)
      const corrected = normalise(applyCorrections(entry.text, template))
      if (correctionSources.has(text) || supersededTexts.has(text)) return false
      if (exactSet.has(text) || exactSet.has(corrected)) return false
      if (leadIns.has(text)) return false
      if (proseBlocks.includes(text) || proseBlocks.includes(corrected)) return false
      // Prose may be split differently on the two sides — a bold lead-in is
      // its own run, a trailing colon lives inside it. Only for prose-shaped
      // entries of some length, so a missing option cannot hide inside a
      // paragraph that happens to contain the same word.
      const prosey = entry.kind === 'note' || entry.kind === 'printed' || entry.kind === 'heading'
      if (prosey && corrected.length >= 12) {
        if (proseBlob.includes(corrected) || templateBlob.includes(corrected)) return false
      }
      return true
    })

    expect(
      missing.map((m) => `${m.cite} [${m.kind}] ${m.text}`),
      'corpus strings not in the template, not corrected and not superseded',
    ).toEqual([])
  })

  test('A — the registers only list real source strings', () => {
    // A correction's source must really be in the source — read before the
    // corrections are applied, or every correction would erase its own evidence.
    const inCorpus = (text: string) =>
      corpusSet.has(normalise(text)) || uncorrectedSource.includes(normalise(text))
    expect(superseded.filter((s) => !corpusSet.has(normalise(s.text))).map((s) => s.text)).toEqual([])
    expect(
      corrections.filter((c) => !inCorpus(c.source) && !correctedCorpusBlob.includes(normalise(c.printed))).map((c) => c.source),
    ).toEqual([])
  })

  test('B — every label, option and heading is verbatim from the source', () => {
    const printed = new Set(corrections.map((c) => normalise(c.printed)))
    const invented = strings.exact.filter(({ text }) => {
      const t = normalise(text)
      if (corpusSet.has(t) || printed.has(t)) return false
      if (correctedCorpusBlob.includes(t)) return false
      return !rawSource.includes(t)
    })
    expect(
      invented.map((s) => `${s.where}: ${s.text}`),
      'template strings found nowhere in the source',
    ).toEqual([])
  })

  test('B — every paragraph is verbatim from the source', () => {
    const invented = strings.prose.filter(({ text }) => {
      const t = normalise(text)
      return !rawSource.includes(t) && !correctedCorpusBlob.includes(t)
    })
    expect(
      invented.map((s) => `${s.where}: ${s.text.slice(0, 120)}`),
      'template prose found nowhere in the source',
    ).toEqual([])
  })

  test('every option stores the words it prints', () => {
    const coded = template.sections!
      .flatMap((s) => s.fields)
      .flatMap((f) => (f.kind === 'repeater' ? f.columns : [f]))
      .flatMap((f) => ('options' in f ? f.options : []))
      .filter((o) => o.value !== o.label)
    expect(coded).toEqual([])
  })

  test('prints in Helvetica without a single garbled character', () => {
    // The built-in PDF font is WinAnsi-encoded; anything outside it prints as a
    // different character or not at all, with no error.
    const all = [...strings.exact, ...strings.prose]
    const bad = all
      .map((s) => ({ ...s, bad: nonWinAnsi(s.text) }))
      .filter((s) => s.bad.length > 0)
    expect(bad.map((s) => `${s.where}: ${s.bad.join('')}`)).toEqual([])
  })

  test('field keys are unique across the whole template', () => {
    const keys = template.sections!.flatMap((s) => s.fields.map((f) => f.key))
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([])
  })

  test('every visibility and attachment reference points at a real field', () => {
    const keys = new Set(template.sections!.flatMap((s) => s.fields.map((f) => f.key)))
    const refs: Array<string> = []
    const walk = (condition: unknown) => {
      if (!condition || typeof condition !== 'object') return
      const c = condition as Record<string, unknown>
      if (typeof c.when === 'string') refs.push(c.when)
      for (const k of ['all', 'any'] as const) if (Array.isArray(c[k])) (c[k] as Array<unknown>).forEach(walk)
      if (c.not) walk(c.not)
    }
    for (const section of template.sections!) {
      walk(section.visibleWhen)
      for (const field of section.fields) {
        walk(field.visibleWhen)
        if (field.attachedTo) refs.push(field.attachedTo)
      }
    }
    expect(refs.filter((r) => !keys.has(r))).toEqual([])
  })

  test('records its snapshot size', () => {
    const bytes = canonicalise(snapshotOf(template)).length
    // Well inside Convex's 1 MB document limit, with room for a business's own
    // option lists. The number is printed so a jump is visible in review.
    console.info(`${id} v${template.version} snapshot: ${bytes} bytes`)
    expect(bytes).toBeLessThan(200_000)
  })
})

test('RichDoc paragraphs join their runs when compared', () => {
  expect(
    blockText({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Constructions issues and faults:', marks: ['bold'] },
        { type: 'text', text: ' cracks.' },
      ],
    }),
  ).toBe('Constructions issues and faults: cracks.')
})
