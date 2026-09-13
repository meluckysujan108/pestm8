import { useState } from 'react'
import { MapPin } from 'lucide-react'
import { PhotoSlots } from './PhotoSlots'
import { SignaturePad } from './SignaturePad'
import {
  retainedOptions,
  toggleCheck,
  withLocked,
} from '#/lib/reportTemplates/choices'
import type { EditorProps } from './registry'
import type {
  AreaResult,
  FieldDef,
  GpsValue,
  SignatureValue,
} from '#/lib/reportTemplates'

/**
 * One editable control per field kind. Each is registered in `registry.ts`;
 * nothing here is reached by a `switch` on kind, so adding a kind means adding
 * a component and a registry line rather than editing a growing switch.
 */

const inputClass =
  'h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue'

type Of<TKind extends FieldDef['kind']> = EditorProps<
  Extract<FieldDef, { kind: TKind }>
>

export function TextControl({ field, value, onChange }: Of<'text'>) {
  return (
    <input
      value={(value as string | undefined) ?? ''}
      placeholder={field.placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={inputClass}
    />
  )
}

export function AreaControl({ field, value, onChange }: Of<'area'>) {
  return (
    <textarea
      value={(value as string | undefined) ?? ''}
      placeholder={field.placeholder}
      rows={field.rows ?? 3}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-xl bg-surface-3 p-3.5 text-[16px] leading-relaxed text-ink outline-none focus:ring-2 focus:ring-blue"
    />
  )
}

export function SelectControl({ field, value, onChange }: Of<'select'>) {
  return (
    <select
      value={(value as string | undefined) ?? ''}
      onChange={(e) => onChange(e.target.value)}
      className={inputClass}
    >
      {/* The source form's own placeholder when it has one (`-`), never
          stored: choosing it clears the answer. */}
      <option value="">{field.blankOption ?? 'Choose…'}</option>
      {retainedOptions(field.options, value).map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function ChipsControl({ field, value, onChange }: Of<'chips'>) {
  const selected = (value as Array<string> | undefined) ?? []
  return (
    <span className="flex flex-wrap gap-2">
      {retainedOptions(field.options, value).map((o) => {
        const on = selected.includes(o.value)
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() =>
              onChange((previous: unknown) => {
                const current = (previous as Array<string> | undefined) ?? []
                return current.includes(o.value)
                  ? current.filter((v) => v !== o.value)
                  : [...current, o.value]
              })
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

export function AreasControl({ field, value, onChange }: Of<'areas'>) {
  const areas = (value as Record<string, AreaResult> | undefined) ?? {}
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
                      onChange({ ...areas, [row]: { ...result, status } })
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

/**
 * Yes/No as two buttons rather than a dropdown (§2.3), reusing the switcher
 * shape the areas checklist already established.
 *
 * Neither button is pressed until one is chosen, so an unanswered question
 * looks unanswered instead of defaulting to "No" on the technician's behalf.
 */
export function ToggleControl({ field, value, onChange }: Of<'toggle'>) {
  const options = [
    { on: true, label: field.yes ?? 'Yes' },
    { on: false, label: field.no ?? 'No' },
  ]
  return (
    <span className="flex w-fit rounded-lg bg-fill-track p-0.5">
      {options.map((option) => (
        <button
          key={option.label}
          type="button"
          aria-pressed={value === option.on}
          onClick={() => onChange(option.on)}
          className={`rounded-md px-4 py-1.5 text-[13px] font-semibold transition ${
            value === option.on
              ? 'bg-surface text-ink shadow-elevation'
              : 'text-muted'
          }`}
        >
          {option.label}
        </button>
      ))}
    </span>
  )
}

/**
 * Native radios: the field is already wrapped in a fieldset with the label as
 * its legend, which is exactly the markup a radio group wants. Buttons with
 * `aria-pressed` would announce as independent toggles rather than one choice.
 */
export function RadioControl({ field, value, onChange }: Of<'radio'>) {
  // A radio group cannot be unset, so a source placeholder like `-` becomes the
  // choice that clears the answer rather than one that stores a dash.
  const choices = [
    ...(field.blankOption ? [{ value: '', label: field.blankOption }] : []),
    ...retainedOptions(field.options, value),
  ]
  return (
    <span className="flex flex-col gap-1.5">
      {choices.map((option) => (
        <label
          key={option.value}
          className="flex items-center gap-2.5 rounded-xl border border-hairline bg-surface px-3 py-2.5"
        >
          <input
            type="radio"
            name={field.key}
            value={option.value}
            checked={
              option.value === '' ? value === undefined || value === '' : value === option.value
            }
            onChange={() => onChange(option.value === '' ? undefined : option.value)}
            className="size-4 accent-red"
          />
          <span className="text-body text-ink">{option.label}</span>
        </label>
      ))}
    </span>
  )
}

export function DateControl({ value, onChange }: Of<'date'>) {
  return (
    <input
      type="date"
      value={(value as string | undefined) ?? ''}
      onChange={(e) => onChange(e.target.value)}
      className={inputClass}
    />
  )
}

export function TimeControl({ value, onChange }: Of<'time'>) {
  return (
    <input
      type="time"
      value={(value as string | undefined) ?? ''}
      onChange={(e) => onChange(e.target.value)}
      className={inputClass}
    />
  )
}

export function NumberControl({ field, value, onChange }: Of<'number'>) {
  return (
    <span className="flex items-center gap-2">
      <input
        type="number"
        // Brings up the numeric keypad on a phone without blocking decimals.
        inputMode="decimal"
        value={value === undefined || value === null ? '' : String(value)}
        min={field.min}
        max={field.max}
        step={field.step}
        // '' rather than NaN when cleared, so the field reads as unanswered.
        onChange={(e) =>
          onChange(e.target.value === '' ? undefined : Number(e.target.value))
        }
        className={inputClass}
      />
      {field.unit && (
        <span className="shrink-0 text-body text-muted">{field.unit}</span>
      )}
    </span>
  )
}

/**
 * A checklist, with an optional way to add an item the template never listed.
 *
 * Custom items store as their own label rather than a generated code: these
 * lists print straight onto a signed document, and a code with no matching
 * option would render as gibberish there.
 */
export function ChecksControl({ field, value, onChange }: Of<'checks'>) {
  const selected = (value as Array<string> | undefined) ?? []
  const [draft, setDraft] = useState('')

  const custom = selected.filter(
    (v) => !field.options.some((o) => o.value === v),
  )

  function toggle(itemValue: string) {
    // Locked and exclusive items live in the shared rules, so the control and
    // the printed document cannot disagree about what "locked" means.
    onChange((previous: unknown) => toggleCheck(field, previous, itemValue))
  }
  const locked = new Set(field.locked ?? [])
  const shown = withLocked(field, selected)

  function addCustom() {
    const trimmed = draft.trim()
    if (!trimmed || selected.includes(trimmed)) return
    // Through the same rule as a tapped item, so a typed risk still clears an
    // exclusive "No Risk Safe Access Given".
    onChange((previous: unknown) => toggleCheck(field, previous, trimmed))
    setDraft('')
  }

  return (
    <span className="flex flex-col gap-1.5">
      {[
        ...field.options,
        ...custom.map((c) => ({ value: c, label: c })),
      ].map((option) => (
        <label
          key={option.value}
          className="flex items-center gap-2.5 rounded-xl border border-hairline bg-surface px-3 py-2.5"
        >
          <input
            type="checkbox"
            checked={shown.includes(option.value)}
            disabled={locked.has(option.value)}
            onChange={() => toggle(option.value)}
            className="size-4 accent-red"
          />
          <span className="text-body text-ink">{option.label}</span>
        </label>
      ))}

      {field.extensible && (
        <span className="mt-0.5 flex gap-2">
          <input
            value={draft}
            placeholder={field.addLabel ?? 'Add another…'}
            aria-label={`${field.label} — add another item`}
            onChange={(e) => setDraft(e.target.value)}
            // Enter would otherwise submit or do nothing; here it is the
            // fastest way to add several items in a row on a phone.
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addCustom()
              }
            }}
            className="h-11 min-w-0 flex-1 rounded-lg bg-surface-3 px-3 text-[15px] text-ink outline-none focus:ring-2 focus:ring-blue"
          />
          <button
            type="button"
            onClick={addCustom}
            disabled={!draft.trim()}
            className="shrink-0 rounded-lg bg-surface-2 px-3.5 text-[13px] font-semibold text-ink transition active:scale-[.97] disabled:opacity-40"
          >
            Add
          </button>
        </span>
      )}
    </span>
  )
}

/**
 * Captures the device's location once, on demand.
 *
 * Never automatic: a coordinate on a report asserts the technician was at the
 * property, so it is recorded by a deliberate act rather than by the page
 * happening to load somewhere. A refusal is shown plainly instead of leaving
 * the button looking broken.
 */
export function GpsControl({ field, value, onChange }: Of<'gps'>) {
  const [state, setState] = useState<'idle' | 'locating' | 'denied' | 'failed'>(
    'idle',
  )
  const gps = value as GpsValue | undefined

  function capture() {
    setState('locating')
    navigator.geolocation.getCurrentPosition(
      (position) => {
        onChange({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          altitude: position.coords.altitude ?? undefined,
          at: Date.now(),
        })
        setState('idle')
      },
      (error) => {
        setState(error.code === error.PERMISSION_DENIED ? 'denied' : 'failed')
      },
      { enableHighAccuracy: true, timeout: 15_000 },
    )
  }

  return (
    <span className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={capture}
        disabled={state === 'locating'}
        aria-label={
          gps
            ? `${field.label} — captured, take a new reading`
            : `${field.label} — capture location`
        }
        className="flex h-12 w-fit items-center gap-2 rounded-xl bg-surface-2 px-4 text-[15px] font-semibold text-ink transition active:scale-[.97] disabled:opacity-50"
      >
        <MapPin size={16} strokeWidth={1.9} />
        {state === 'locating'
          ? 'Locating…'
          : gps
            ? 'Update location'
            : 'Use current location'}
      </button>

      {gps && (
        <span className="text-caption tabular-nums text-muted">
          {gps.lat.toFixed(6)}, {gps.lng.toFixed(6)}
          {gps.altitude !== undefined && ` · ${gps.altitude.toFixed(1)} m`}
        </span>
      )}

      {state === 'denied' && (
        <span role="alert" className="text-caption text-amber-ink">
          Location permission was refused. Enable it for this site, or leave
          this blank.
        </span>
      )}
      {state === 'failed' && (
        <span role="alert" className="text-caption text-amber-ink">
          Could not get a location. Try again with a clearer view of the sky.
        </span>
      )}
    </span>
  )
}

export function SignatureControl({ field, value, onChange, ctx }: Of<'signature'>) {
  const signed = value as SignatureValue | undefined
  return (
    <SignaturePad
      businessId={ctx.businessId}
      reportId={ctx.reportId}
      slot={field.slot}
      label={field.label}
      signedAt={signed?.signedAt}
      onSigned={(signedAt) =>
        onChange(signedAt === undefined ? undefined : { signedAt })
      }
    />
  )
}

export function PhotosControl({ field, ctx }: Of<'photos'>) {
  // Uploads attach directly to the report rather than flowing through the
  // draft's `data`, so a photo survives even if the draft is never saved.
  return (
    <PhotoSlots
      businessId={ctx.businessId}
      reportId={ctx.reportId}
      slots={field.slots}
    />
  )
}
