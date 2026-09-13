
import { withLocked } from './choices'
import type {
  AreaResult,
  DerivedSource,
  FieldDef,
  GpsValue,
  RepeaterRow,
  RichDoc,
  SignatureValue,
} from './types'

/**
 * How a stored field value should read once it leaves the builder — shared by
 * the on-screen document and the PDF.
 *
 * Both surfaces used to carry their own copy of this: `FieldValue` in
 * ReportDocument and `FieldRow` + `displayValue` in ReportPdf, each resolving
 * option codes to labels and each filtering photos out separately. Two copies
 * of the same rules drift, and the drift is invisible until a client reads a
 * PDF that disagrees with the screen.
 *
 * So semantics live here and painting lives in the surfaces. This module holds
 * no React and no DOM precisely so the PDF, which emits Text/View rather than
 * elements, can share it.
 */

export type Tone = 'default' | 'warn'

export type Presented =
  /** Rendered by a dedicated section elsewhere, or editor-only. */
  | { kind: 'omit' }
  /** Nothing recorded — the em dash. */
  | { kind: 'blank' }
  | { kind: 'text'; text: string; preserveWhitespace?: boolean; tone?: Tone }
  /** Stacked, unlabelled — GPS as latitude, longitude and altitude. */
  | { kind: 'lines'; lines: Array<string> }
  /** Structured prose: headings, bullets, bold lead-ins, definitions. */
  | { kind: 'rich'; doc: RichDoc }
  /** A stored image — a signature, printed rather than described. */
  | { kind: 'image'; url: string; caption?: string }
  /** A labelled sub-list, e.g. each inspected area and its outcome. */
  | { kind: 'pairs'; pairs: Array<{ label: string; value: string; tone: Tone }> }
  /** Repeating rows under column headings. */
  | { kind: 'grid'; columns: Array<string>; rows: Array<Array<string>> }

/**
 * The records a document prints from but never asks about. Declared here, once,
 * because the on-screen painter and the PDF painter each hand-maintain their
 * own shape over the same query — the exact duplication this module was
 * created to end.
 *
 * Every part is optional: a draft resolves against live records that may be
 * incomplete, and a field whose source is missing prints blank rather than
 * inventing a value on a document someone signs.
 */
export type PresentContext = {
  client?: {
    name?: string
    address?: string
    phone?: string
    email?: string
  } | null
  property?: { address?: string } | null
  business?: {
    name?: string
    tradingName?: string
    address?: string
    phone?: string
    email?: string
    website?: string
    abn?: string
  } | null
  /** The person named on the document, not necessarily its author. */
  technician?: {
    name?: string
    licence?: string
    phone?: string
    address?: string
  } | null
  job?: { number?: string } | null
  /** Membership id → printed name, for the `member` kind. */
  roster?: Record<string, string>
  /**
   * Membership id → the facts a `derived` row bound to a member field prints
   * about that person.
   */
  members?: Record<
    string,
    { name?: string; licence?: string; phone?: string; address?: string }
  >
  /**
   * The report's own answers, so a `derived` row bound to a member field can
   * see who was chosen there.
   */
  answers?: Record<string, unknown>
  /**
   * Signature slot → signed URL. Absent here, a signature prints as who signed
   * and when — which is what every report finalised so far already shows.
   */
  signatureUrls?: Record<string, string>
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === ''
}

/** Every cell unanswered — an empty array counts, the way an empty checklist does. */
export function isEmptyRow(
  columns: Array<{ key: string }>,
  row: Record<string, unknown>,
): boolean {
  return columns.every((cell) => {
    const v = row[cell.key]
    return isBlank(v) || (Array.isArray(v) && v.length === 0)
  })
}

/**
 * Flatten a presented cell to the single string a grid row can hold.
 *
 * Exhaustive on purpose. The obvious version — `shown.kind === 'text' ? … : ''`
 * — keeps compiling however wide `Presented` grows, so a new variant appearing
 * in a repeater cell would print as an empty box on a signed PDF with nothing
 * failing. `CellDef` makes that unreachable today; this makes it unreachable
 * tomorrow too.
 */
function cellText(shown: Presented): string {
  switch (shown.kind) {
    case 'text':
      return shown.text
    case 'blank':
      return '—'
    case 'lines':
      return shown.lines.join(' · ')
    case 'pairs':
      return shown.pairs.map((p) => `${p.label}: ${p.value}`).join('; ')
    case 'omit':
    case 'rich':
    case 'image':
    case 'grid':
      // Structurally cannot fit one cell of one row. `CellDef` excludes every
      // kind that produces these, so reaching here means the allowlist moved.
      return ''
    default: {
      const _exhaustive: never = shown
      void _exhaustive
      return ''
    }
  }
}

/**
 * A fact about the person chosen in one member field. Never falls back to
 * anyone else: a blank choice prints a blank licence beside a blank name, not
 * the author's licence under nobody.
 */
function memberFact(
  source: DerivedSource,
  memberKey: string,
  ctx: PresentContext | undefined,
): string | undefined {
  const [group, key] = [source.slice(0, source.indexOf('.')), source.slice(source.indexOf('.') + 1)]
  if (group !== 'technician') return derivedValue(source, ctx)
  const chosen = ctx?.answers?.[memberKey]
  if (typeof chosen !== 'string') return undefined
  const facts: Record<string, string | undefined> | undefined =
    ctx?.members?.[chosen]
  const found = facts?.[key]
  return found === undefined || found === '' ? undefined : found
}

/** Resolve a `derived` field against the records, or nothing. */
function derivedValue(
  source: DerivedSource,
  ctx: PresentContext | undefined,
): string | undefined {
  if (!ctx) return undefined
  const dot = source.indexOf('.')
  const group = source.slice(0, dot)
  const key = source.slice(dot + 1)
  const record: Record<string, string | undefined> | null | undefined =
    group === 'client'
      ? ctx.client
      : group === 'property'
        ? ctx.property
        : group === 'business'
          ? ctx.business
          : group === 'technician'
            ? ctx.technician
            : ctx.job
  const found = record?.[key]
  return found === undefined || found === '' ? undefined : found
}

/** `2026-09-04` → `4 September 2026`. Falls back to the raw string. */
function formatDate(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number)
  if (!year || !month || !day) return iso
  return new Intl.DateTimeFormat('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    // The value is a plain calendar date with no timezone. Constructing it as
    // UTC and reading it back as UTC keeps it on the day the technician chose,
    // rather than shifting a morning date back to the day before.
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)))
}

/** `14:05` → `2:05 pm`. Falls back to the raw string. */
function formatTime(value: string): string {
  const [hours, minutes] = value.split(':').map(Number)
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return value
  return new Intl.DateTimeFormat('en-AU', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(2000, 0, 1, hours, minutes)))
}

export function present(
  field: FieldDef,
  value: unknown,
  ctx?: PresentContext,
): Presented {
  // EVERY kind that prints from something other than `data` is decided here,
  // ahead of the blank check below. That ordering is the whole point: a static
  // note has no stored value, so reaching `isBlank` would return `blank` and
  // both painters would print a labelled em dash — a warranty clause rendering
  // as "Warranty preamble —" on a document a client signs. The `never` guard
  // at the bottom cannot catch it, because the function has already returned.
  switch (field.kind) {
    // Evidence with its own gallery section, never a row in the field table.
    // This replaces a `.filter(f => f.kind !== 'photos')` that both surfaces
    // had to remember to apply.
    // A cover belongs to a page, not a row, so it is omitted alongside them.
    case 'photos':
    case 'gallery':
    case 'cover':
      return { kind: 'omit' }

    // The label is the editor's name for the block; the body is what prints.
    case 'note':
      return { kind: 'rich', doc: field.body }

    case 'heading':
      return { kind: 'text', text: field.text }

    case 'derived': {
      const resolved = field.member
        ? memberFact(field.source, field.member, ctx)
        : derivedValue(field.source, ctx)
      if (resolved === undefined) return { kind: 'blank' }
      return field.format === 'lines'
        ? { kind: 'lines', lines: resolved.split('\n') }
        : { kind: 'text', text: resolved }
    }
  }

  if (isBlank(value)) return { kind: 'blank' }

  switch (field.kind) {
    // Stored values are codes; a finished document must read as prose.
    // "chemical" and "12" mean nothing to a client or an inspector —
    // "Chemical soil barrier" and "12 months" are the actual content.
    case 'select': {
      const option = field.options.find((o) => o.value === String(value))
      return { kind: 'text', text: option?.label ?? String(value) }
    }

    case 'chips': {
      if (!Array.isArray(value)) break
      const labels = value.map(
        (v) => field.options.find((o) => o.value === v)?.label ?? String(v),
      )
      return { kind: 'text', text: labels.join(', ') }
    }

    case 'areas': {
      if (typeof value !== 'object') break
      const areas = value as Record<string, AreaResult>
      return {
        kind: 'pairs',
        // Template order, not storage order — Convex returns object keys
        // sorted, which would list the areas alphabetically instead of in the
        // sequence a technician actually works through.
        pairs: field.rows.map((row) => {
          const result = areas[row] ?? { status: 'inspected' as const }
          const inspected = result.status === 'inspected'
          return {
            label: row,
            value: inspected ? 'Inspected' : `No access — ${result.reason ?? ''}`,
            tone: inspected ? 'default' : 'warn',
          }
        }),
      }
    }

    case 'toggle':
      return {
        kind: 'text',
        text: value ? (field.yes ?? 'Yes') : (field.no ?? 'No'),
      }

    case 'radio': {
      const option = field.options.find((o) => o.value === String(value))
      return { kind: 'text', text: option?.label ?? String(value) }
    }

    // Stored ISO so it sorts and compares; printed the way an Australian
    // technician and their client both read a date.
    case 'date':
      return { kind: 'text', text: formatDate(String(value)) }

    case 'time':
      return { kind: 'text', text: formatTime(String(value)) }

    case 'number':
      return {
        kind: 'text',
        text: field.unit ? `${String(value)} ${field.unit}` : String(value),
      }

    case 'checks': {
      if (!Array.isArray(value)) break
      // An item the technician added at fill time has no option entry — it
      // stores as its own label, so falling back to the raw value prints it.
      // Locked items print whether or not the stored array holds them.
      const labels = withLocked(field, value).map(
        (v) => field.options.find((o) => o.value === v)?.label ?? String(v),
      )
      return { kind: 'text', text: labels.join(', ') }
    }

    case 'gps': {
      const gps = value as GpsValue
      if (typeof gps.lat !== 'number' || typeof gps.lng !== 'number') break
      // Six decimal places is ~0.1 m — past the accuracy of any phone GPS, and
      // enough to identify which side of a building the technician stood on.
      if (field.format === 'lines') {
        const lines = [
          `Lat: ${gps.lat.toFixed(6)}`,
          `Lng: ${gps.lng.toFixed(6)}`,
        ]
        if (gps.altitude !== undefined) {
          lines.push(`Alt: ${gps.altitude.toFixed(1)} m`)
        }
        return { kind: 'lines', lines }
      }
      const coords = `${gps.lat.toFixed(6)}, ${gps.lng.toFixed(6)}`
      return {
        kind: 'text',
        text:
          gps.altitude === undefined
            ? coords
            : `${coords} · ${gps.altitude.toFixed(1)} m`,
      }
    }

    case 'signature': {
      const sig = value as SignatureValue
      if (typeof sig.signedAt !== 'number') break
      const when = new Intl.DateTimeFormat('en-AU', {
        dateStyle: 'long',
      }).format(new Date(sig.signedAt))
      return {
        kind: 'text',
        text: sig.signedBy ? `${sig.signedBy} — ${when}` : `Signed ${when}`,
      }
    }

    case 'repeater': {
      if (!Array.isArray(value)) break
      // A row with nothing in it is a tap on "Add Row" that went nowhere. It
      // prints as nothing — not a blank line in a signed treatment table —
      // whether it reached storage through an old draft or straight from an API
      // caller.
      const filled = (value as Array<RepeaterRow>).filter((row) =>
        !isEmptyRow(field.columns, row),
      )
      if (filled.length === 0) return { kind: 'blank' }
      const rows = filled.map((row) =>
        field.columns.map((cell) => {
          // Cells present through the same rules as top-level fields, so a
          // product code reads as its label inside the grid too.
          const cellShown = present(cell, row[cell.key], ctx)
          return cellText(cellShown)
        }),
      )
      return {
        kind: 'grid',
        columns: field.columns.map((cell) => cell.label),
        rows,
      }
    }

    case 'member': {
      // Never the raw membership id: an id nobody can resolve prints as an
      // unanswered row, not as a Convex id on a signed document.
      const printed = ctx?.roster?.[String(value)]
      return printed ? { kind: 'text', text: printed } : { kind: 'blank' }
    }

    case 'emails': {
      const list = Array.isArray(value) ? value.map(String) : [String(value)]
      const kept = list.filter((entry) => entry.trim() !== '')
      if (kept.length === 0) return { kind: 'blank' }
      return { kind: 'text', text: kept.join(', ') }
    }

    case 'text':
    case 'area':
      break

    default: {
      // A new field kind must decide how it reads before it can ship.
      const _exhaustive: never = field
      void _exhaustive
    }
  }

  return { kind: 'text', text: String(value), preserveWhitespace: true }
}
