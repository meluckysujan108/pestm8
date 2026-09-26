import { useId, useRef } from 'react'
import {
  MAX_LICENCE_NAME_LENGTH,
  MAX_LICENCE_NUMBER_LENGTH,
  checkExpiresOn,
  cleanLicenceName,
  cleanLicenceNumber,
} from '../../../convex/lib/memberLicences'
import { FieldMessage } from '#/components/forms/FieldMessage'
import {
  describedBy,
  fieldInputClass,
  fieldMessageId,
} from '#/components/forms/FormField'
import { licenceErrorCopy } from '#/lib/licenceErrors'
import { useHydrated } from '#/lib/useHydrated'
import { FieldRow } from './ui'

/**
 * A licence's name, number and expiry, as both "Add licence" and a licence's
 * own page edit them — one set of fields, one set of checks, the same rules
 * the server keeps (`convex/lib/memberLicences.ts`).
 */

/**
 * What most people in the trade carry, offered as one tap while the name is
 * empty. Only suggestions: the name is whatever the person calls it.
 */
export const SUGGESTED_LICENCE_NAMES = [
  'Pest management licence',
  'Fumigation licence',
  'Timber pest inspection',
  'White card',
  'First aid',
  'Driver licence',
  'Working at heights',
  'ChemCert',
] as const

/** The fields as typed. An empty number or date means none. */
export type LicenceDraft = { name: string; number: string; expiresOn: string }

export type LicenceFieldErrors = Partial<Record<keyof LicenceDraft, string>>

/** What a draft is as the server would keep it, or why it would refuse it. */
export function checkLicenceDraft(draft: LicenceDraft):
  | {
      ok: true
      value: { name: string; number?: string; expiresOn?: string }
    }
  | { ok: false; errors: LicenceFieldErrors } {
  const copy = licenceErrorCopy('save')
  const name = cleanLicenceName(draft.name)
  const number = cleanLicenceNumber(draft.number)
  const expiresOn = checkExpiresOn(draft.expiresOn)
  const errors: LicenceFieldErrors = {}
  if (!name.ok) errors.name = copy.INVALID_NAME
  if (!number.ok) errors.number = copy.INVALID_NUMBER
  if (!expiresOn.ok) errors.expiresOn = copy.INVALID_DATE
  if (!name.ok || !number.ok || !expiresOn.ok) return { ok: false, errors }
  return {
    ok: true,
    value: {
      name: name.value,
      number: number.value,
      expiresOn: expiresOn.value,
    },
  }
}

export function LicenceFields({
  draft,
  onChange,
  errors = {},
  disabled = false,
}: {
  draft: LicenceDraft
  onChange: (next: LicenceDraft) => void
  errors?: LicenceFieldErrors
  /** Shown from the copy on this phone: with no signal there is nothing to
   * save a change with. */
  disabled?: boolean
}) {
  // The fields take typing before hydration like any form's; the buttons
  // (a suggestion, Clear) do nothing until then, so they wait for it.
  const hydrated = useHydrated()
  const nameId = useId()
  const numberId = useId()
  const expiryId = useId()
  const nameInput = useRef<HTMLInputElement>(null)
  const expiryInput = useRef<HTMLInputElement>(null)
  const set = (field: keyof LicenceDraft, value: string) =>
    onChange({ ...draft, [field]: value })

  return (
    <>
      <FieldRow id={nameId} label="Name">
        <input
          ref={nameInput}
          id={nameId}
          value={draft.name}
          onChange={(e) => set('name', e.target.value)}
          maxLength={MAX_LICENCE_NAME_LENGTH}
          autoComplete="off"
          autoCapitalize="sentences"
          enterKeyHint="next"
          disabled={disabled}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={describedBy(
            errors.name && fieldMessageId(nameId, 'error'),
          )}
          className={fieldInputClass('lg', Boolean(errors.name))}
        />
        {errors.name && (
          <FieldMessage id={fieldMessageId(nameId, 'error')} tone="error">
            {errors.name}
          </FieldMessage>
        )}
        {/* Only while empty: once there is a name they are in the way. */}
        {draft.name === '' && !disabled && (
          <div
            role="group"
            aria-label="Suggested names"
            className="mt-2.5 flex flex-wrap gap-1.5"
          >
            {SUGGESTED_LICENCE_NAMES.map((name) => (
              <button
                key={name}
                type="button"
                onClick={(e) => {
                  handFocusOn(e.currentTarget, nameInput.current)
                  set('name', name)
                }}
                disabled={!hydrated}
                className="min-h-11 rounded-full bg-surface-2 px-3.5 text-caption font-semibold text-ink-2 outline-none transition active:scale-[.97] focus-visible:ring-2 focus-visible:ring-blue"
              >
                {name}
              </button>
            ))}
          </div>
        )}
      </FieldRow>

      <FieldRow id={numberId} label="Number (optional)">
        <input
          id={numberId}
          value={draft.number}
          onChange={(e) => set('number', e.target.value)}
          maxLength={MAX_LICENCE_NUMBER_LENGTH}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          enterKeyHint="next"
          disabled={disabled}
          aria-invalid={errors.number ? true : undefined}
          aria-describedby={describedBy(
            errors.number && fieldMessageId(numberId, 'error'),
          )}
          className={fieldInputClass('lg', Boolean(errors.number))}
        />
        {errors.number && (
          <FieldMessage id={fieldMessageId(numberId, 'error')} tone="error">
            {errors.number}
          </FieldMessage>
        )}
      </FieldRow>

      <FieldRow
        id={expiryId}
        label="Expires (optional)"
        hint="The last day it’s good for. It turns amber 60 days before."
      >
        <div className="flex items-center gap-2">
          <input
            ref={expiryInput}
            id={expiryId}
            type="date"
            value={draft.expiresOn}
            onChange={(e) => set('expiresOn', e.target.value)}
            disabled={disabled}
            aria-invalid={errors.expiresOn ? true : undefined}
            aria-describedby={describedBy(
              errors.expiresOn && fieldMessageId(expiryId, 'error'),
            )}
            className={`${fieldInputClass('lg', Boolean(errors.expiresOn))} min-w-0 flex-1`}
          />
          {/* A date field has no reliable "clear" of its own on every phone. */}
          {draft.expiresOn !== '' && !disabled && (
            <button
              type="button"
              onClick={(e) => {
                handFocusOn(e.currentTarget, expiryInput.current)
                set('expiresOn', '')
              }}
              disabled={!hydrated}
              aria-label="Clear expiry date"
              className="h-12 shrink-0 rounded-xl px-3 text-[16px] font-semibold text-blue transition active:opacity-50"
            >
              Clear
            </button>
          )}
        </div>
        {errors.expiresOn && (
          <FieldMessage id={fieldMessageId(expiryId, 'error')} tone="error">
            {errors.expiresOn}
          </FieldMessage>
        )}
      </FieldRow>
    </>
  )
}

/**
 * For a button that removes itself when pressed — a suggestion, gone once
 * there is a name; Clear, gone once there is no date — focus on it goes to
 * its field rather than falling to the page, which would send someone on a
 * keyboard or a screen reader back to the top. Only when it HAD focus: a tap
 * on an iPhone never gives a button focus, and moving it to the field would
 * put up a keyboard, or the date wheel, that nobody asked for.
 */
function handFocusOn(from: HTMLElement, to: HTMLElement | null): void {
  if (document.activeElement === from) to?.focus()
}
