import type {
  AreaResult,
  FieldDef,
  GpsValue,
  RepeaterRow,
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
  | { kind: 'text'; text: string; preserveWhitespace?: boolean }
  /** A labelled sub-list, e.g. each inspected area and its outcome. */
  | {
      kind: 'pairs'
      pairs: Array<{ label: string; value: string; tone: Tone }>
    }
  /** Repeating rows under column headings. */
  | { kind: 'grid'; columns: Array<string>; rows: Array<Array<string>> }

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === ''
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

export function present(field: FieldDef, value: unknown): Presented {
  // Photos are evidence with their own gallery section, never a row in the
  // field table. This replaces a `.filter(f => f.kind !== 'photos')` that both
  // surfaces had to remember to apply. `gallery` never stores a value in
  // `data` at all, so it must be caught here too, before the blank check below
  // would otherwise treat it as an unanswered field.
  if (field.kind === 'photos' || field.kind === 'gallery') {
    return { kind: 'omit' }
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
            value: inspected
              ? 'Inspected'
              : `No access — ${result.reason ?? ''}`,
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
      const labels = value.map(
        (v) => field.options.find((o) => o.value === v)?.label ?? String(v),
      )
      return { kind: 'text', text: labels.join(', ') }
    }

    case 'gps': {
      const gps = value as GpsValue
      if (typeof gps.lat !== 'number' || typeof gps.lng !== 'number') break
      // Six decimal places is ~0.1 m — past the accuracy of any phone GPS, and
      // enough to identify which side of a building the technician stood on.
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
      if (value.length === 0) return { kind: 'blank' }
      const rows = (value as Array<RepeaterRow>).map((row) =>
        field.columns.map((cell) => {
          // Cells present through the same rules as top-level fields, so a
          // product code reads as its label inside the grid too.
          const cellShown = present(cell, row[cell.key])
          if (cellShown.kind === 'text') return cellShown.text
          return cellShown.kind === 'blank' ? '—' : ''
        }),
      )
      return {
        kind: 'grid',
        columns: field.columns.map((cell) => cell.label),
        rows,
      }
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
