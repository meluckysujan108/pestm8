import { useEffect, useRef, useState } from 'react'
import { checkPhone } from '../../../convex/lib/phone'
import { FieldMessage, FixButton } from './FieldMessage'
import {
  describedBy,
  fieldInputClass,
  fieldLabelText,
  fieldMessageId,
} from './FormField'
import { useLatest, useSaveCheck } from './SaveWarnings'

/**
 * An Australian phone number, checked with the rule the server shares
 * (convex/lib/phone.ts). Call and Text dial exactly what is saved, so:
 *
 * - One that can never be dialled (letters, too few digits) is refused
 *   through the input's own validity, shown once the field is left or a
 *   submit refused.
 * - One that probably will not connect (no area code, a mobile missing its
 *   0) is a warning, with the likely number as a one-tap fix. Never a
 *   refusal: the person on the phone to the customer may know better.
 * - A good number typed another way ("0412345678") is offered written the
 *   usual way, quietly. Nothing typed is ever rewritten without a tap.
 *
 * `initial` is the number already saved on the record: left as it was it is
 * never refused, only warned about. `businessState` picks the area code a
 * number missing one most likely has.
 *
 * Renders its own message lines, so name it with <label htmlFor={id}> (or
 * FormField), not by wrapping it in a <label>.
 */
export function PhoneInput({
  id,
  value,
  onChange,
  initial,
  businessState,
  required,
  size = 'lg',
  placeholder,
  ariaLabel,
  name,
  describedBy: extraDescribedBy,
}: {
  id: string
  value: string
  onChange: (v: string) => void
  /** The saved value. Unchanged, it is never an error. */
  initial?: string
  businessState?: string
  required?: boolean
  size?: 'lg' | 'md'
  placeholder?: string
  /** Only when there is no visible <label>. */
  ariaLabel?: string
  /** The field's name in the save-warnings list. Defaults to its label's
   * text, else "Phone". */
  name?: string
  /** More ids for aria-describedby: a FormField hint, say. */
  describedBy?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [reveal, setReveal] = useState(false)

  const typed = value.trim()
  const changed = initial === undefined || typed !== initial.trim()
  const check = checkPhone(value, { businessState })
  const refused = check.level === 'error' && changed
  // A saved number that fails the rule is still said, as a warning.
  const warning =
    check.level === 'warning' || (check.level === 'error' && !changed)
      ? (check.message ?? null)
      : null
  const tidy = check.tidy

  const showError = refused && reveal
  const showWarning = warning !== null && reveal
  const showTidy = check.level === 'ok' && tidy !== undefined && reveal
  const errorId = fieldMessageId(id, 'error')
  const warningId = fieldMessageId(id, 'warning')

  useEffect(() => {
    inputRef.current?.setCustomValidity(
      refused ? (check.message ?? 'Check the phone number.') : '',
    )
  }, [refused, check.message])

  const latestOnChange = useLatest(onChange)
  const fix = tidy
    ? { label: `Use ${tidy}`, apply: () => latestOnChange.current(tidy) }
    : undefined

  useSaveCheck(
    id,
    () =>
      warning === null
        ? []
        : [
            {
              id: `${id}:${check.kind}`,
              label: name ?? fieldLabelText(id, 'Phone'),
              message: warning,
              fix,
              focus: () => inputRef.current?.focus(),
            },
          ],
    [typed],
  )

  return (
    <>
      <input
        ref={inputRef}
        id={id}
        type="tel"
        inputMode="tel"
        autoComplete="off"
        required={required}
        placeholder={placeholder}
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => {
          const next = e.target.value
          // Put right (or cleared), it goes quiet until next left.
          const after = checkPhone(next, { businessState })
          if (after.level === 'ok' && after.tidy === undefined) setReveal(false)
          onChange(next)
        }}
        onBlur={() => setReveal(typed !== '')}
        onInvalid={() => setReveal(true)}
        aria-invalid={showError || undefined}
        aria-describedby={describedBy(
          showError && errorId,
          showWarning && warningId,
          extraDescribedBy,
        )}
        className={`${fieldInputClass(size, showError)} tabular-nums`}
      />
      {showError && (
        <FieldMessage id={errorId} tone="error">
          {check.message}
        </FieldMessage>
      )}
      {showWarning && (
        <FieldMessage
          id={warningId}
          tone="warning"
          fix={fix && { label: fix.label, onApply: fix.apply }}
        >
          {warning}
        </FieldMessage>
      )}
      {showTidy && fix && (
        <div className="mt-0.5 text-caption">
          <FixButton fix={{ label: fix.label, onApply: fix.apply }} />
        </div>
      )}
    </>
  )
}
