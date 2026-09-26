import { useId, useMemo } from 'react'
import { Sparkles, TriangleAlert } from 'lucide-react'
import { FormAlert } from '#/components/forms/FormAlert'
import { fieldInputClass } from '#/components/forms/FormField'
import {
  NEUTRAL_BUTTON,
  SECONDARY_BUTTON,
} from '#/components/primitives/buttons'
import {
  FIELD_LABELS,
  FIELD_ORDER,
  mappingProblems,
} from '#/lib/clientImport/columns'
import { useHydrated } from '#/lib/useHydrated'
import { BottomBar, StepHeading, plural } from './ui'
import type { ReactNode } from 'react'
import type { ErrorCopy } from '#/components/forms/describeError'
import type {
  ColumnMapping,
  ImportField,
  ImportSheet,
  SourceApp,
} from '#/lib/clientImport/types'

/** Continue reads what PestM8 already holds, once, to say what's already
 * here; this is when that read is turned down. */
const CONTINUE_COPY: ErrorCopy = {
  offline:
    'This device is offline, so the review can’t check what’s already in PestM8. Continue again when you have signal.',
  default:
    'Couldn’t read the clients already in PestM8, so the review can’t say what’s already here. Continue again in a moment.',
}

/** Two of a column's values, so "Column F" or "Field 3" says what it is. */
function samplesOf(sheet: ImportSheet): Array<Array<string>> {
  return sheet.headers.map((_, column) => {
    const found: Array<string> = []
    for (const row of sheet.rows) {
      const value = row[column]
      if (value && !found.includes(value)) found.push(value)
      if (found.length === 2) break
    }
    return found
  })
}

/**
 * Step two: what each column is. Every column is listed, with two of its
 * values, and the guess `autoMap` made from its heading — right for the
 * apps it knows, and a start for a spreadsheet it doesn't. Continue waits
 * for a name and an address; everything else is optional.
 */
export function MatchStep({
  sheet,
  source,
  mapping,
  error,
  wait,
  onChange,
  onBack,
  onContinue,
}: {
  sheet: ImportSheet
  source: SourceApp | null
  mapping: ColumnMapping
  /** Why the last Continue didn't get to the review. */
  error: unknown
  /** Why Continue has to wait, while it does: an import being undone
   * (`UndoHold`) — what's already here is read at Continue, and mid-undo
   * it would still count what the undo is about to take away. */
  wait?: ReactNode
  onChange: (mapping: ColumnMapping) => void
  onBack: () => void
  onContinue: () => void
}) {
  const hydrated = useHydrated()
  const idPrefix = useId()
  const samples = useMemo(() => samplesOf(sheet), [sheet])
  const problems = mappingProblems(mapping)

  // A field chosen for two columns is one of the problems; the two selects
  // are ringed, so the person can see which.
  const twice = new Set<ImportField>()
  const seen = new Set<ImportField>()
  for (const field of mapping) {
    if (field === null) continue
    if (seen.has(field)) twice.add(field)
    seen.add(field)
  }

  const set = (column: number, field: ImportField | null) =>
    onChange(mapping.map((f, i) => (i === column ? field : f)))

  return (
    <>
      <StepHeading
        title="Match your columns"
        lede={`${sheet.fileName} · ${plural(sheet.rows.length, 'row')}. Check what each column holds — a column that isn’t matched is left behind.`}
      >
        {source && (
          <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-blue-bg px-3 py-1 text-caption font-semibold text-blue-ink">
            <Sparkles aria-hidden size={14} strokeWidth={2} />
            Looks like a {source} export
          </p>
        )}
      </StepHeading>

      <ul className="mt-5 divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
        {sheet.headers.map((header, column) => {
          const id = `${idPrefix}-${column}`
          const field = mapping[column] ?? null
          const example = samples[column]
          return (
            <li
              key={column}
              className="flex flex-col gap-2 px-3.5 py-3 sm:flex-row sm:items-center sm:gap-4"
            >
              <div className="min-w-0 flex-1">
                <label
                  htmlFor={id}
                  className={`block truncate text-body font-semibold ${field ? 'text-ink' : 'text-muted'}`}
                >
                  {header}
                </label>
                <p
                  id={`${id}-sample`}
                  className="truncate text-caption text-muted"
                >
                  {example.length > 0
                    ? example.join(' · ')
                    : 'Empty in every row'}
                </p>
              </div>
              <select
                id={id}
                value={field ?? ''}
                disabled={!hydrated}
                aria-describedby={`${id}-sample`}
                aria-invalid={field && twice.has(field) ? true : undefined}
                onChange={(event) =>
                  set(column, (event.target.value || null) as ImportField)
                }
                className={`${fieldInputClass('md', field !== null && twice.has(field))} shrink-0 sm:w-60`}
              >
                <option value="">Don’t import</option>
                {FIELD_ORDER.map((option) => (
                  <option key={option} value={option}>
                    {FIELD_LABELS[option]}
                  </option>
                ))}
              </select>
            </li>
          )
        })}
      </ul>

      <BottomBar>
        <FormAlert error={error} copy={CONTINUE_COPY} className="mb-3" />
        {wait}
        {problems.length > 0 && (
          <ul
            aria-label="Before you continue"
            className="mb-3 space-y-1 text-caption text-amber-ink"
          >
            {problems.map((problem) => (
              <li key={problem} className="flex items-start gap-1.5">
                <TriangleAlert
                  aria-hidden
                  className="mt-0.5 size-3.5 shrink-0"
                />
                <span>{problem}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onBack}
            disabled={!hydrated}
            className={`${SECONDARY_BUTTON} px-4`}
          >
            Back
          </button>
          <button
            type="button"
            onClick={onContinue}
            disabled={!hydrated || problems.length > 0 || Boolean(wait)}
            // Ink: Continue reads what's here and saves nothing.
            className={`${NEUTRAL_BUTTON} flex-1`}
          >
            Continue
          </button>
        </div>
      </BottomBar>
    </>
  )
}
