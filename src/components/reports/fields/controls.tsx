import { useCallback, useEffect, useState } from 'react'
import { MapPin } from 'lucide-react'
import { PhotoSlots } from './PhotoSlots'
import { SignatureRow } from './SignatureRow'
import {
  retainedOptions,
  toggleCheck,
  withLocked,
} from '#/lib/reportTemplates/choices'
import { PickerSheet, PickerTrigger } from './PickerSheet'
import { PhrasesSheet } from './PhrasesSheet'
import { withSnippet } from '#/lib/reportTemplates/snippets'
import type { EditorCtx, EditorProps } from './registry'
import type {
  AreaResult,
  FieldDef,
  GpsValue,
  OptionSetKey,
  SignatureValue,
} from '#/lib/reportTemplates'
import { SECONDARY_BUTTON } from '#/components/primitives/buttons'
import { FIELD, FIELD_COMPACT, FIELD_SURFACE } from '#/components/forms/FormField'
import { formatTime } from '#/lib/format'
import { deviceTimezone } from '#/lib/useBusinessTimezone'

/**
 * One editable control per field kind. Each is registered in `registry.ts`;
 * nothing here is reached by a `switch` on kind, so adding a kind means adding
 * a component and a registry line rather than editing a growing switch.
 */

const inputClass = `${FIELD} w-full`

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

export function AreaControl({ field, value, onChange, ctx }: Of<'area'>) {
  const [picking, setPicking] = useState(false)
  const text = (value as string | undefined) ?? ''
  const phrases = ctx.phrases
  const saved = phrases?.forField(field.key) ?? []

  return (
    <span className="flex flex-col gap-1.5">
      <textarea
        value={text}
        placeholder={field.placeholder}
        rows={field.rows ?? 3}
        onChange={(e) => onChange(e.target.value)}
        className={`${FIELD_SURFACE} w-full p-3.5 leading-relaxed`}
      />

      {/* Offered once there is something to offer OR something to keep, so a
          business that has never saved one never sees the button. */}
      {phrases && (saved.length > 0 || text.trim() !== '') && (
        <button
          type="button"
          onClick={() => setPicking(true)}
          className="self-start rounded-lg px-1 py-0.5 text-caption font-semibold text-blue transition active:scale-[.97]"
        >
          {saved.length > 0 ? `Phrases (${saved.length})` : 'Save as a phrase'}
        </button>
      )}

      {phrases && (
        <PhrasesSheet
          open={picking}
          onClose={() => setPicking(false)}
          label={field.label}
          phrases={saved}
          current={text}
          onPick={(phrase) => {
            onChange(withSnippet(text, phrase.text))
            phrases.used(phrase.id)
          }}
          onSave={(written) => phrases.save(field.key, written)}
          onRemove={(phrase) => phrases.remove(phrase.id)}
        />
      )}
    </span>
  )
}

/**
 * Where a list stops being quicker to read in place than to search.
 *
 * Twelve is the Service Report's "Your Next Pest Control Visit is due in:"
 * list, which reads fine as rows; thirteen is its product list, where every
 * entry carries an active constituent in brackets and the one you use daily is
 * somewhere in the middle. The line falls between them.
 */
const LIST_LIMIT = 12

/**
 * The few options this business actually reaches for, for whichever library
 * this field draws on.
 *
 * A field with its options written into the template has no library behind it
 * and therefore no preference to express — the form's own order is the answer.
 */
function usualFor(
  field: { optionsFrom?: OptionSetKey },
  ctx: EditorCtx,
): Array<string> {
  return field.optionsFrom ? (ctx.usual?.[field.optionsFrom] ?? []) : []
}

/**
 * Says this member just reached for these answers, so the next picker on the
 * same list offers them first.
 *
 * A checklist reports on close rather than on each tap — a technician who
 * opens a sheet, looks, changes their mind and closes it has taught the app
 * nothing — while a single choice reports the tap itself, which is both the
 * answer and the moment the sheet closes.
 */
function remember(
  field: { optionsFrom?: OptionSetKey },
  ctx: EditorCtx,
  chosen: Array<string>,
) {
  if (field.optionsFrom && chosen.length > 0) {
    ctx.remember?.(field.optionsFrom, chosen)
  }
}

export function SelectControl({ field, value, onChange, ctx }: Of<'select'>) {
  const [picking, setPicking] = useState(false)
  const options = retainedOptions(field.options, value)
  const chosen = typeof value === 'string' && value !== '' ? [value] : []

  if (options.length > LIST_LIMIT || ctx.inRow) {
    return (
      <>
        <PickerTrigger
          label={field.label}
          values={chosen}
          placeholder={field.blankOption ?? 'Choose…'}
          onOpen={() => setPicking(true)}
        />
        <PickerSheet
          open={picking}
          onClose={() => setPicking(false)}
          title={field.label}
          options={options}
          selected={chosen}
          multiple={false}
          usual={usualFor(field, ctx)}
          onToggle={(next: string) => {
            onChange(next)
            remember(field, ctx, [next])
          }}
          onClear={() => onChange(undefined)}
        />
      </>
    )
  }

  return (
    <select
      value={(value as string | undefined) ?? ''}
      onChange={(e) => onChange(e.target.value)}
      className={inputClass}
    >
      {/* The source form's own placeholder when it has one (`-`), never
          stored: choosing it clears the answer. */}
      <option value="">{field.blankOption ?? 'Choose…'}</option>
      {options.map((o) => (
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
                ? 'bg-red-fill text-white'
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
                    className={`relative tap-target rounded-md px-2.5 py-1 text-caption font-semibold transition ${
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
                className={`${FIELD_COMPACT} mt-2 w-full`}
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
          className={`relative tap-target rounded-md px-4 py-1.5 text-caption font-semibold transition ${
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
export function ChecksControl({ field, value, onChange, ctx }: Of<'checks'>) {
  const selected = (value as Array<string> | undefined) ?? []
  const [draft, setDraft] = useState('')
  const [picking, setPicking] = useState(false)

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

  const all = [...field.options, ...custom.map((c) => ({ value: c, label: c }))]

  if (all.length > LIST_LIMIT || ctx.inRow) {
    return (
      <>
        <PickerTrigger
          label={field.label}
          values={shown}
          placeholder={field.addLabel ?? 'Choose…'}
          onOpen={() => setPicking(true)}
        />
        <PickerSheet
          open={picking}
          onClose={() => {
            setPicking(false)
            // What was chosen, not what the form keeps ticked on its own.
            remember(field, ctx, selected.filter((v) => !locked.has(v)))
          }}
          title={field.label}
          options={all}
          selected={shown}
          multiple
          disabledValues={[...locked]}
          usual={usualFor(field, ctx)}
          onToggle={toggle}
          addLabel={field.extensible ? field.addLabel : undefined}
          onAdd={field.extensible ? (item: string) => toggle(item) : undefined}
        />
      </>
    )
  }

  return (
    <span className="flex flex-col gap-1.5">
      {all.map((option) => (
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
            className={`${FIELD_COMPACT} min-w-0 flex-1`}
          />
          <button
            type="button"
            onClick={addCustom}
            disabled={!draft.trim()}
            className="shrink-0 rounded-lg bg-surface-2 px-3.5 text-caption font-semibold text-ink transition active:scale-[.97] disabled:opacity-40"
          >
            Add
          </button>
        </span>
      )}
    </span>
  )
}

/** `10:25am` — when the reading was taken, in the phone's own timezone. */
function formatClock(at: number): string {
  return formatTime(at, deviceTimezone())
}

/**
 * Captures the device's location.
 *
 * A coordinate on a report asserts the technician was at the property, so this
 * never prompts: a permission dialog that appears because a section scrolled
 * into view is one people dismiss without reading, and an answer obtained that
 * way is not evidence of anything. A field marked `auto` takes the reading by
 * itself ONLY where the browser already holds a granted permission — a
 * decision this person made once, deliberately, on this device — and only
 * while the question is still unanswered, so it can never overwrite a reading
 * someone took on purpose.
 *
 * The reading shows when it was taken and how good it is. Eight metres and
 * three hundred metres look identical on a printed page, and only the person
 * standing there can decide whether to take it again.
 */
export function GpsControl({ field, value, onChange }: Of<'gps'>) {
  const [state, setState] = useState<'idle' | 'locating' | 'denied' | 'failed'>(
    'idle',
  )
  const gps = value as GpsValue | undefined

  const capture = useCallback(() => {
    setState('locating')
    navigator.geolocation.getCurrentPosition(
      (position) => {
        onChange({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          altitude: position.coords.altitude ?? undefined,
          accuracy: position.coords.accuracy,
          at: Date.now(),
        })
        setState('idle')
      },
      (error) => {
        setState(error.code === error.PERMISSION_DENIED ? 'denied' : 'failed')
      },
      { enableHighAccuracy: true, timeout: 15_000 },
    )
  }, [onChange])

  const answered = gps !== undefined
  useEffect(() => {
    if (!field.auto || answered) return
    if (typeof navigator === 'undefined') return
    let live = true
    // Not every browser reports on this permission — Safari did not for years
    // — and a rejection here is a reason to leave it to the button, never to
    // ask.
    void Promise.resolve()
      .then(() => navigator.permissions.query({ name: 'geolocation' }))
      .then((status) => {
        // Anything but an existing grant leaves the button to do its job.
        // `prompt` in particular must not be turned into a prompt.
        if (live && status.state === 'granted') capture()
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [field.auto, answered, capture])

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
        className={`${SECONDARY_BUTTON} flex w-fit items-center gap-2 px-4`}
      >
        <MapPin size={16} strokeWidth={2} />
        {state === 'locating'
          ? 'Locating…'
          : gps
            ? 'Update location'
            : 'Use current location'}
      </button>

      {gps && (
        <span className="flex flex-col text-caption tabular-nums text-muted">
          <span>
            {gps.lat.toFixed(6)}, {gps.lng.toFixed(6)}
            {gps.altitude !== undefined && ` · ${gps.altitude.toFixed(1)} m`}
          </span>
          <span>
            captured {formatClock(gps.at)}
            {gps.accuracy !== undefined && ` · ±${Math.round(gps.accuracy)} m`}
          </span>
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
    <SignatureRow
      businessId={ctx.businessId}
      reportId={ctx.reportId}
      slot={field.slot}
      label={field.label}
      statement={field.statement}
      askName={field.askName ?? field.role === 'client'}
      // The technician's own slot is the only one their saved signature may
      // ever fill. A client's is signed by the client, on this phone, now.
      ownSignature={field.role === 'technician'}
      signedAt={signed?.signedAt}
      onSigned={(signedAt: number | undefined) =>
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
