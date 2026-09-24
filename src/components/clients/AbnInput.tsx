import { useEffect, useRef, useState } from 'react'
import { isValidAbn } from '../../../convex/lib/abn'

const MESSAGE = 'Check the ABN: it should be 11 digits and pass the ATO check.'

const SIZES = {
  lg: 'h-12 px-3.5 text-[16px]',
  md: 'h-11 px-3.5 text-[15px]',
}

/**
 * A client's ABN (Prompt 6.1), checked as it is typed with the rule the
 * server enforces (convex/lib/abn.ts). Blank is fine: it is optional.
 *
 * A wrong one is refused the way a missing required field is, through the
 * input's own validity, so the form stops at the field rather than the
 * server answering INVALID_ABN after the sheet has been filled in. The
 * sentence saying why appears once the field has been left, or a submit
 * refused, and not while the digits are still going in.
 *
 * The sentence is rendered beside the input, so do NOT put this inside a
 * <label>, where it would become part of the field's name. Name it with
 * <label htmlFor={id}>.
 */
export function AbnInput({
  id,
  value,
  onChange,
  size = 'lg',
}: {
  id: string
  value: string
  onChange: (v: string) => void
  size?: 'lg' | 'md'
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [reveal, setReveal] = useState(false)
  const invalid = value.trim() !== '' && !isValidAbn(value)
  const showError = invalid && reveal
  const errorId = `${id}-error`

  useEffect(() => {
    inputRef.current?.setCustomValidity(invalid ? MESSAGE : '')
  }, [invalid])

  return (
    <>
      <input
        ref={inputRef}
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="e.g. 51 824 753 556"
        value={value}
        onChange={(e) => {
          const next = e.target.value
          // Put right (or cleared), it goes quiet again until the next time
          // the field is left.
          if (next.trim() === '' || isValidAbn(next)) setReveal(false)
          onChange(next)
        }}
        onBlur={() => setReveal(invalid)}
        onInvalid={() => setReveal(true)}
        aria-invalid={showError || undefined}
        aria-describedby={showError ? errorId : undefined}
        className={`${SIZES[size]} w-full rounded-xl bg-surface-3 tabular-nums text-ink outline-none ${showError ? 'ring-2 ring-red' : 'focus:ring-2 focus:ring-blue'}`}
      />
      {showError && (
        <p
          id={errorId}
          role="alert"
          className="mt-1.5 text-caption text-red-ink"
        >
          {MESSAGE}
        </p>
      )}
    </>
  )
}
