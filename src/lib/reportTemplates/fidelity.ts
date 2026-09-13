import { sectionsOf } from './index'
import type {
  CellDef,
  FieldDef,
  ReportTemplate,
  RichBlock,
  RichDoc,
} from './types'

/**
 * Every string a template shows or prints, gathered for the fidelity test.
 *
 * Two classes, because they are held to different standards. EXACT strings — a
 * label, an option, a section title — must equal a source string character for
 * character. PROSE — a paragraph of a note or of the terms — must appear verbatim
 * inside the source, since the extractor and the template can legitimately break
 * the same paragraph at different places (a bold lead-in is its own run).
 *
 * A static block's `label` is deliberately absent: it is the author's name for
 * the block, never printed.
 */
export type CollectedString = { text: string; where: string }

export type TemplateStrings = {
  exact: Array<CollectedString>
  prose: Array<CollectedString>
}

export function collectTemplateStrings(template: ReportTemplate): TemplateStrings {
  const exact: Array<CollectedString> = []
  const prose: Array<CollectedString> = []
  const push = (list: Array<CollectedString>, text: string | undefined | null, where: string) => {
    if (typeof text === 'string' && text.trim() !== '') list.push({ text, where })
  }

  const print = template.print
  if (print) {
    push(exact, print.formName, 'print.formName')
    print.headings?.forEach((h, i) => push(exact, h, `print.headings[${i}]`))
    push(exact, print.standardsLine, 'print.standardsLine')
    push(exact, print.cover?.title, 'print.cover.title')
    push(exact, print.cover?.subtitle, 'print.cover.subtitle')
    push(exact, print.termsHeading, 'print.termsHeading')
  }

  for (const section of sectionsOf(template)) {
    const at = `§${section.number ?? '-'} ${section.title}`
    push(exact, section.title, `${at} title`)
    push(prose, section.preamble, `${at} preamble`)
    if (section.print && 'heading' in section.print) {
      push(exact, section.print.heading, `${at} print.heading`)
    }
    for (const field of section.fields) collectField(field, at, exact, prose)
  }

  if (template.terms) collectDoc(template.terms, 'terms', exact, prose)
  return { exact, prose }
}

function collectField(
  field: FieldDef | CellDef,
  at: string,
  exact: Array<CollectedString>,
  prose: Array<CollectedString>,
) {
  const where = `${at} > ${field.key}`
  const push = (list: Array<CollectedString>, text: string | undefined, suffix: string) => {
    if (typeof text === 'string' && text.trim() !== '') {
      list.push({ text, where: `${where} ${suffix}` })
    }
  }

  switch (field.kind) {
    case 'note':
      push(exact, field.heading, 'heading')
      collectDoc(field.body, `${where} body`, exact, prose)
      return
    case 'heading':
      push(exact, field.text, 'text')
      push(prose, field.note, 'note')
      return
    default:
      break
  }

  push(exact, field.label, 'label')
  push(prose, field.hint, 'hint')
  if ('placeholder' in field) push(exact, field.placeholder, 'placeholder')

  switch (field.kind) {
    case 'select':
    case 'radio':
    case 'chips':
    case 'checks':
      field.options.forEach((option, i) => {
        push(exact, option.label, `options[${i}]`)
        if (option.value !== option.label) {
          push(exact, option.value, `options[${i}].value`)
        }
      })
      push(exact, field.blankOption, 'blankOption')
      if (field.kind === 'checks') push(exact, field.addLabel, 'addLabel')
      return
    case 'toggle':
      push(exact, field.yes, 'yes')
      push(exact, field.no, 'no')
      return
    case 'repeater':
      push(exact, field.addLabel, 'addLabel')
      push(exact, field.removeLabel, 'removeLabel')
      field.columns.forEach((cell) => collectField(cell, where, exact, prose))
      return
    case 'gallery':
    case 'cover':
      push(exact, field.addLabel, 'addLabel')
      return
    case 'areas':
      field.rows.forEach((row, i) => push(exact, row, `rows[${i}]`))
      push(prose, field.note, 'note')
      return
    case 'photos':
      field.slots.forEach((slot, i) => push(exact, slot, `slots[${i}]`))
      return
    default:
      return
  }
}

/** The text of one block, its runs joined — how it reads, not how it is split. */
export function blockText(block: RichBlock): string {
  switch (block.type) {
    case 'heading':
    case 'paragraph':
      return block.content.map((run) => run.text).join('')
    case 'bulletList':
      return block.content
        .map((item) => item.content.map(blockText).join(' '))
        .join(' ')
    case 'definitionList':
      return block.content
        .map((item) => `${item.term} ${item.content.map(blockText).join(' ')}`)
        .join(' ')
  }
}

function collectDoc(
  doc: RichDoc,
  where: string,
  exact: Array<CollectedString>,
  prose: Array<CollectedString>,
) {
  const walk = (blocks: Array<RichBlock>, path: string) => {
    blocks.forEach((block, i) => {
      const here = `${path}[${i}]`
      switch (block.type) {
        case 'heading':
        case 'paragraph':
          prose.push({ text: blockText(block), where: here })
          return
        case 'bulletList':
          block.content.forEach((item, j) => walk(item.content, `${here}.item${j}`))
          return
        case 'definitionList':
          block.content.forEach((item, j) => {
            exact.push({ text: item.term, where: `${here}.term${j}` })
            walk(item.content, `${here}.def${j}`)
          })
          return
      }
    })
  }
  walk(doc.content, where)
}

/** Whitespace only. Quotes, dashes and case are wording, and stay. */
export function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * A vendored markdown source reduced to the words it contains: emphasis,
 * code ticks, heading and quote markers, bullets and table pipes removed,
 * everything joined into one searchable run.
 */
export function sourceText(markdown: string): string {
  return normalise(
    markdown
      .split('\n')
      .map((line) =>
        line
          .replace(/^\s*#{1,6}\s+/, '')
          .replace(/^\s*>\s?/, '')
          .replace(/^\s*[-*+]\s+/, '')
          .replace(/\|/g, ' \n ')
          .replace(/\*\*|__|`/g, '')
          .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1'),
      )
      .join(' '),
  )
}

/** Characters Helvetica (WinAnsiEncoding) cannot print, and would silently garble. */
const WIN_ANSI_EXTRA = new Set([...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'])

export function nonWinAnsi(text: string): Array<string> {
  const bad = new Set<string>()
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const ok =
      (code >= 0x20 && code <= 0x7e) ||
      (code >= 0xa0 && code <= 0xff) ||
      code === 0x0a ||
      WIN_ANSI_EXTRA.has(char)
    if (!ok) bad.add(char)
  }
  return [...bad]
}
