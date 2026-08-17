import type { AreaResult, FieldDef } from '#/lib/reportTemplates'

/**
 * The generic renderer §5.3 depends on: the builder knows field *kinds*, never
 * specific templates. A new document type is a new definition file.
 */
export function FieldRenderer({
  field,
  value,
  error,
  onChange,
}: {
  field: FieldDef
  value: unknown
  error?: string
  onChange: (value: unknown) => void
}) {
  // A <label> names exactly one control. Wrapping a multi-control group in one
  // makes every button inside inherit the whole group's text as its accessible
  // name, so a screen reader announces the entire checklist per button.
  const isGroup =
    field.kind === 'chips' || field.kind === 'areas' || field.kind === 'photos'

  const caption = (
    <>
      {field.label}
      {'required' in field && field.required && (
        <span aria-hidden className="ml-1 text-red">
          *
        </span>
      )}
    </>
  )

  return (
    <div className="mt-4">
      {isGroup ? (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="section-label mb-1.5">{caption}</legend>
          <Control field={field} value={value} onChange={onChange} />
        </fieldset>
      ) : (
        <label className="flex flex-col gap-1.5">
          <span className="section-label">{caption}</span>
          <Control field={field} value={value} onChange={onChange} />
        </label>
      )}

      {'hint' in field && field.hint && (
        <p className="mt-1 text-secondary text-muted">{field.hint}</p>
      )}
      {field.kind === 'areas' && field.note && (
        <p className="mt-1 text-secondary text-muted">{field.note}</p>
      )}
      {error && (
        <p role="alert" className="mt-1 text-secondary text-red">
          {error}
        </p>
      )}
    </div>
  )
}

const inputClass =
  'h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue'

function Control({
  field,
  value,
  onChange,
}: {
  field: FieldDef
  value: unknown
  onChange: (value: unknown) => void
}) {
  switch (field.kind) {
    case 'text':
      return (
        <input
          value={(value as string) ?? ''}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        />
      )

    case 'area':
      return (
        <textarea
          value={(value as string) ?? ''}
          placeholder={field.placeholder}
          rows={field.rows ?? 3}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-xl bg-surface-3 p-3.5 text-[16px] leading-relaxed text-ink outline-none focus:ring-2 focus:ring-blue"
        />
      )

    case 'select':
      return (
        <select
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        >
          <option value="">Choose…</option>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )

    case 'chips': {
      const selected = (value as Array<string>) ?? []
      return (
        <span className="flex flex-wrap gap-2">
          {field.options.map((o) => {
            const on = selected.includes(o.value)
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  onChange(
                    on
                      ? selected.filter((v) => v !== o.value)
                      : [...selected, o.value],
                  )
                }
                className={`rounded-full px-3 py-1.5 text-body transition ${
                  on
                    ? 'bg-red text-white'
                    : 'bg-surface-3 text-ink-2 hover:bg-surface-2'
                }`}
              >
                {o.label}
              </button>
            )
          })}
        </span>
      )
    }

    case 'areas': {
      const areas = (value as Record<string, AreaResult>) ?? {}
      return (
        <span className="flex flex-col gap-2">
          {field.rows.map((row) => {
            const result = areas[row] ?? { status: 'inspected' }
            const noAccess = result.status === 'noAccess'
            return (
              <span
                key={row}
                className="rounded-xl border border-hairline bg-surface p-3"
              >
                <span className="flex items-center justify-between gap-3">
                  <span className="text-body text-ink">{row}</span>
                  <span className="flex rounded-lg bg-fill-track p-0.5">
                    {(['inspected', 'noAccess'] as const).map((status) => (
                      <button
                        key={status}
                        type="button"
                        aria-pressed={result.status === status}
                        aria-label={`${row}: ${
                          status === 'inspected' ? 'Inspected' : 'No access'
                        }`}
                        onClick={() =>
                          onChange({
                            ...areas,
                            [row]: { ...result, status },
                          })
                        }
                        className={`rounded-md px-2.5 py-1 text-[13px] font-semibold transition ${
                          result.status === status
                            ? 'bg-surface text-ink shadow-elevation'
                            : 'text-muted'
                        }`}
                      >
                        {status === 'inspected' ? 'Inspected' : 'No access'}
                      </button>
                    ))}
                  </span>
                </span>

                {/* AS 4349.3 requires a reason whenever access was not
                    available — enforced here and in the schema. */}
                {noAccess && (
                  <input
                    value={result.reason ?? ''}
                    placeholder="Reason access was not available"
                    aria-label={`${row} — reason for no access`}
                    onChange={(e) =>
                      onChange({
                        ...areas,
                        [row]: { ...result, reason: e.target.value },
                      })
                    }
                    className="mt-2 h-11 w-full rounded-lg bg-surface-3 px-3 text-[15px] text-ink outline-none focus:ring-2 focus:ring-blue"
                  />
                )}
              </span>
            )
          })}
        </span>
      )
    }

    case 'photos':
      // Photo upload lands with Convex file storage; the slots are declared by
      // the template so the builder already knows what to ask for.
      return (
        <span className="flex flex-wrap gap-2">
          {field.slots.map((slot) => (
            <span
              key={slot}
              className="flex h-20 w-24 flex-col items-center justify-center rounded-xl border border-dashed border-hairline bg-surface-3 text-center text-secondary text-muted"
            >
              {slot}
            </span>
          ))}
        </span>
      )
  }
}
