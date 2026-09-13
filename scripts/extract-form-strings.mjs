/**
 * Extracts the verbatim string corpus of the Pest M8 source forms into
 * `src/lib/reportTemplates/spec/*.generated.ts`.
 *
 * Why this exists: "word-for-word" is the product requirement, and a fidelity
 * test that compares a hand-written template against a hand-written fixture
 * proves nothing — the same transcription error appears on both sides. This
 * script derives one side of that comparison mechanically from the sources in
 * `docs/sources/`, so the test compares authored code against extracted source.
 *
 * The output is reviewed once as a diff and then frozen; re-run it only when a
 * source document changes.
 *
 *   node scripts/extract-form-strings.mjs
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCES = path.join(root, 'docs/sources')
const OUT = path.join(root, 'src/lib/reportTemplates/spec')

/**
 * Text that describes a control rather than appearing on the form. The md files
 * are a data dictionary, so a field's "value" is usually its control type —
 * `Single-line text input`, `Date picker`, `Multi-image dropzone`. None of that
 * is printed, so none of it belongs in the corpus.
 */
const CONTROL_DESCRIPTOR =
  /^(single-line text input|multi-line text (field|input)|text (field|area input)|date (picker|input)|time picker|toggle|radio|checkbox|dropdown|phone text input|email text input|image uploader|photo (uploader )?dropzone|multi-image|multi-photo|digital canvas pad|telemetry fields|address lookup|touch\/mouse signature canvas pad|single photo uploader|in progress|grid repeater actions)/i

/**
 * The data dictionary describes the form as well as quoting it. These labels are
 * about the document, so the label itself never prints — but the value does, and
 * it is often a heading that must appear verbatim ("TIMBER PEST WARRANTY
 * INSPECTION"). Capture the value, drop the label.
 */
const META_VALUE_LABEL =
  /^(main heading|sub heading|report title|standards reference|standards compliance|inspection requested \/ inspection type requested|installer certification statement|client acknowledgment statement|client acceptance statement|recommendation notice|large property clause|strata properties clause|concrete slab disclaimer|risk (notice|warning)|critical disclaimer|historical disclaimer|warning notice|inspection frequency rule|agreement details note|inspection provider details note|preamble|explanatory note|name \(hereafter .*|signed on behalf of)$/i

/** Labels that describe the file rather than the form. Neither side prints. */
const META_DROP_LABEL =
  /^(form (name|title|status|id)|source form|grid repeater actions)$/i

/** Footer/header chrome — reproduced from `PrintSpec`, not from a field. */
const PDF_CHROME =
  /^(page \d+|submitted by:|submission id:|version:|environment friendly|www\.|info@|\+61|pest m8 south|pest m8 service report for \d{4})/i

const collapse = (s) => s.replace(/\s+/g, ' ').trim()
const unquote = (s) => s.replace(/^[`"']+|[`"']+$/g, '').trim()

/** Splits a data-dictionary value into the option strings it lists. */
function optionsIn(value) {
  const ticks = [...value.matchAll(/`([^`]+)`/g)].map((m) => m[1])
  if (ticks.length) return ticks
  return []
}

function parseMarkdown(file, text) {
  const out = []
  const lines = text.split('\n')
  const add = (kind, raw, i) => {
    const t = collapse(unquote(raw))
    if (!t || t === '-' || CONTROL_DESCRIPTOR.test(t)) return
    out.push({ text: t, kind, cite: `${file}:${i + 1}` })
  }

  lines.forEach((line, i) => {
    // Headings: "## 1. CLIENT DETAILS" and "### Hindered Access"
    let m = line.match(/^#{2,4}\s+(.*\S)\s*$/)
    if (m) return add(m[1].startsWith('#') ? 'heading' : 'heading', m[1], i)

    // Checkbox / radio items: "  * [ ] Vendor", "  * ( ) Dry", "  - [x] Year 1"
    m = line.match(/^\s*[*-]\s*(?:\[[ xX]\]|\([ xX]?\))\s*(.*\S)\s*$/)
    if (m) return add('option', m[1], i)

    // Field rows: "* **Client Name:** Single-line text input"
    m = line.match(/^\s*[*-]\s*\*\*(.+?)\*\*\s*:?\s*(.*)$/)
    if (m) {
      const label = m[1].replace(/:$/, '')
      const value = m[2] ?? ''
      // Rows that describe the document rather than quote it.
      if (META_DROP_LABEL.test(label)) return
      if (META_VALUE_LABEL.test(label)) {
        add('note', value, i) // the value is the printed text, any length
        for (const opt of optionsIn(value)) add('option', opt, i)
        return
      }
      // A parenthesised control hint is part of the printed label on these
      // forms ("Weather Conditions at time of inspection (Radio buttons)" is
      // not, but "Photo for Front Page of Report (1 Landscape Photo)" is), so
      // strip only the known control-type parentheticals.
      add(
        'label',
        label.replace(
          /\s*\((checkboxes?|radio buttons?|dropdown|radio|toggle|yes \/ no toggles?|checkboxes \+ runtime user input addition)\)\s*$/i,
          '',
        ),
        i,
      )
      for (const opt of optionsIn(value)) add('option', opt, i)
      if (
        !optionsIn(value).length &&
        value &&
        !CONTROL_DESCRIPTOR.test(collapse(value)) &&
        collapse(value).length > 40
      ) {
        add('note', value, i) // an explanatory clause, not a control type
      }
      return
    }

    // Blockquote notes: "> **Explanatory Note:** The Client is the person..."
    m = line.match(/^>\s*(?:\*\*(.+?):\*\*)?\s*(.*\S)\s*$/)
    if (m) return add('note', m[2], i)

    // Table rows: "| **Water Leaks** | Toggle (`Yes` | `No`) + ... | Engage a ... |"
    if (/^\|/.test(line) && !/^\|\s*:?-/.test(line)) {
      const cells = line.split('|').slice(1, -1)
      cells.forEach((cell, c) => {
        const bold = cell.match(/\*\*(.+?)\*\*/)
        if (bold) add('label', bold[1].replace(/:$/, ''), i)
        for (const opt of optionsIn(cell)) add('option', opt, i)
        // The third column of the conducive-conditions table is advisory prose.
        if (
          !bold &&
          !optionsIn(cell).length &&
          collapse(cell).length > 30 &&
          c > 0
        ) {
          add('note', cell, i)
        }
      })
      return
    }

    // Plain bullets under a "### Column N: Treatment (Checkboxes)" heading
    m = line.match(/^\s*[-*]\s+(?!\*\*)(.*\S)\s*$/)
    if (m) return add('option', m[1], i)
  })

  return out
}

/**
 * The sample submission's own answers are the design partner's client data, and
 * they are not form text — the corpus wants labels, headings and the static
 * boilerplate. Answers that survive cell-splitting are redacted here so nothing
 * identifying can reach the repo; the rest are pruned during the one-time review.
 *
 * Two layers. Shape rules below catch anything that looks like a client email,
 * a mobile number or a coordinate, and reduce coordinates to the whole degree —
 * four decimal places is a house. The client's name, street address and the
 * vendor's submission id have no shape, so they are listed in
 * `scripts/form-redactions.local` (gitignored: `*.local`), a JSON array of
 * `[pattern, replacement]` pairs kept next to the source PDF on the machine that
 * holds it. Writing those literals here would publish exactly what is being
 * hidden. The script refuses to read the PDF without that file.
 */
const SHAPE_REDACT = [
  [/[A-Za-z0-9._%+-]+@(?!pestm8\.com\.au)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi, 'client@example.com'],
  [/\b04\d{2} ?\d{3} ?\d{3}\b/g, '0400 000 000'],
  [/-?32\.\d+/g, '-32.000000'],
  [/115\.\d+/g, '115.000000'],
  [/\b35\.\d+/g, '35.000000'],
]
const LOCAL_REDACTIONS = path.join(root, 'scripts/form-redactions.local')

async function loadRedactions() {
  let pairs
  try {
    pairs = JSON.parse(await readFile(LOCAL_REDACTIONS, 'utf8'))
  } catch {
    throw new Error(
      `Refusing to read the PDF without ${path.relative(root, LOCAL_REDACTIONS)} ` +
        '(a JSON array of [pattern, replacement] pairs for the client name, address and submission id).',
    )
  }
  const literal = pairs.map(([pattern, to]) => [new RegExp(pattern, 'gi'), to])
  return (s) => [...literal, ...SHAPE_REDACT].reduce((acc, [re, to]) => acc.replace(re, to), s)
}

/**
 * Reflows a page's text runs into the strings a reader sees.
 *
 * Two geometric facts about this document, measured from it: cells in a row are
 * separated by a horizontal gap of more than 6pt (without splitting on it, a
 * key/value row reads "Client NameJ. Sample"), and a line that wraps inside one
 * cell sits ~9-12pt below its predecessor in the same column while a genuinely
 * new item sits 15pt or more below. So: split on the gap, then rejoin a cell
 * with the one above it when they share a column and are within 13pt.
 */
const LINE_CONTINUATION_PT = 13
const COLUMN_TOLERANCE_PT = 2

async function parsePdf(file, buf, redact) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise
  const out = []

  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent()

    const rows = new Map()
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue
      const y = Math.round(item.transform[5])
      const key = [...rows.keys()].find((k) => Math.abs(k - y) <= 2) ?? y
      if (!rows.has(key)) rows.set(key, [])
      rows
        .get(key)
        .push({ x: item.transform[4], w: item.width ?? 0, s: item.str })
    }

    /** @type {Array<{ y: number; cells: Array<{ x: number; w: number; s: string }> }>} */
    const lines = [...rows.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([y, runs]) => {
        runs.sort((a, b) => a.x - b.x)
        const cells = []
        let cur = null
        for (const run of runs) {
          if (cur && run.x - (cur.x + cur.w) > 6) {
            cells.push(cur)
            cur = null
          }
          if (!cur) cur = { x: run.x, w: run.w, s: run.s }
          else {
            cur.s += run.s
            cur.w = run.x + run.w - cur.x
          }
        }
        if (cur) cells.push(cur)
        return { y, cells }
      })

    // Rejoin wrapped cells into the cell they continue.
    const blocks = []
    for (const line of lines) {
      for (const cell of line.cells) {
        const prev = blocks.find(
          (b) =>
            Math.abs(b.x - cell.x) <= COLUMN_TOLERANCE_PT &&
            b.lastY - line.y > 0 &&
            b.lastY - line.y <= LINE_CONTINUATION_PT,
        )
        if (prev) {
          prev.s = `${prev.s} ${cell.s}`
          prev.lastY = line.y
        } else {
          blocks.push({ x: cell.x, s: cell.s, lastY: line.y })
        }
      }
    }

    for (const block of blocks) {
      const text = redact(collapse(block.s))
      if (!text || PDF_CHROME.test(text)) continue
      out.push({ text, kind: 'printed', cite: `${file}:p${p}` })
    }
  }
  return out
}

function dedupe(entries) {
  const seen = new Map()
  for (const e of entries) if (!seen.has(e.text)) seen.set(e.text, e)
  return [...seen.values()]
}

function emit(name, description, entries) {
  const body = entries
    .map(
      (e) =>
        `  { text: ${JSON.stringify(e.text)}, kind: '${e.kind}', cite: ${JSON.stringify(e.cite)} },`,
    )
    .join('\n')
  return `/**
 * GENERATED by scripts/extract-form-strings.mjs — reviewed once, then frozen.
 * Do not hand-edit: re-run the script and review the diff.
 *
 * ${description}
 */
import type { SourceString } from './types'

export const ${name}: Array<SourceString> = [
${body}
]
`
}

const FORMS = [
  {
    name: 'serviceReportSource',
    out: 'serviceReport.generated.ts',
    description:
      'The Pest M8 Service Report, from the spec, the as-submitted form and the printed PDF text layer.',
    md: ['service-report-spec.md', 'service-report-submitted.md'],
    pdf: 'service-report-printed.txt',
  },
  {
    name: 'timberPestInspectionSource',
    out: 'timberPestInspection.generated.ts',
    description: 'Timber Pest Inspection Report (AS 4349.3-2010) — Warranty.',
    md: ['timber-pest-inspection.md'],
  },
  {
    name: 'termiteManagementCertSource',
    out: 'termiteManagementCert.generated.ts',
    description:
      'Existing Structure Certificate of Installation (AS 3660.2-2017).',
    md: ['termite-certificate.md'],
  },
]

const pdfArg = process.argv.find((a) => a.startsWith('--pdf='))

for (const form of FORMS) {
  let entries = []
  for (const file of form.md) {
    entries.push(
      ...parseMarkdown(file, await readFile(path.join(SOURCES, file), 'utf8')),
    )
  }
  if (form.pdf && pdfArg) {
    entries.push(
      ...(await parsePdf(
        'service-report-printed.pdf',
        await readFile(pdfArg.slice(6)),
        await loadRedactions(),
      )),
    )
  }
  entries = dedupe(entries)
  await writeFile(
    path.join(OUT, form.out),
    emit(form.name, form.description, entries),
    'utf8',
  )
  const by = (k) => entries.filter((e) => e.kind === k).length
  console.log(
    `${form.out.padEnd(38)} ${String(entries.length).padStart(4)} strings  ` +
      `(heading ${by('heading')}, label ${by('label')}, option ${by('option')}, note ${by('note')}, printed ${by('printed')})`,
  )
}
