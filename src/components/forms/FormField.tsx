import { FieldMessage } from './FieldMessage'
import type { ReactNode } from 'react'
import type { FieldFix } from './FieldMessage'

export type FieldSize = 'lg' | 'md'

/**
 * lg is the new-client and new-job sheets (NewClientFields), md the denser
 * edit sheets (ClientSheet). 16px is also the smallest text iOS will not
 * zoom into when the field is focused; md's 15px is kept where it already was.
 */
export const FIELD_SIZES: Record<FieldSize, string> = {
  lg: 'h-12 px-3.5 text-[16px]',
  md: 'h-11 px-3.5 text-[15px]',
}

/** The input look every form shares, red-ringed while its error shows. */
export function fieldInputClass(size: FieldSize = 'lg', invalid = false) {
  return `${FIELD_SIZES[size]} w-full rounded-xl bg-surface-3 text-ink outline-none ${invalid ? 'ring-2 ring-red' : 'focus:ring-2 focus:ring-blue'}`
}

/** The id of a field's hint, error or warning line, for aria-describedby. */
export function fieldMessageId(
  id: string,
  kind: 'hint' | 'error' | 'warning',
): string {
  return `${id}-${kind}`
}

/** Joins the ids that are present; undefined when none are, so the
 * attribute is left off rather than empty. */
export function describedBy(
  ...ids: Array<string | false | null | undefined>
): string | undefined {
  const present = ids.filter(Boolean)
  return present.length > 0 ? present.join(' ') : undefined
}

/**
 * A field's name as the person sees it: its <label>'s text without
 * "(optional)". For the save-warnings list, read when the list is built so a
 * field need not be told its own name twice.
 */
export function fieldLabelText(id: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const text = document
    .querySelector(`label[for="${CSS.escape(id)}"]`)
    ?.textContent.replace(/\(optional\)/i, '')
    .trim()
  return text || fallback
}

/** What a render-prop control spreads onto its input. */
export type FieldControlProps = {
  id: string
  'aria-describedby': string | undefined
  'aria-invalid': true | undefined
  className: string
}

/**
 * A label, its control and the lines under it, wired together.
 *
 * The label names the control with `htmlFor`, and nothing but the label's
 * text is inside it: an error line or a fix button inside a <label> becomes
 * part of the field's name, and a tap on the button would also focus the
 * field.
 *
 * `children` is either the control itself — EmailInput, PhoneInput and
 * AbnInput wire their own messages; give them the same `id` — or a function
 * given the props to spread onto a plain input:
 *
 *   <FormField id={nameId} label="Client name" error={nameError}>
 *     {(control) => <input {...control} value={name} onChange={…} />}
 *   </FormField>
 *
 * `hint` is always shown; `error` and `warning` when given. For a control
 * that renders its own messages, pass its extra ids through `describedBy` on
 * it, since only the render-prop form gets them spread automatically.
 */
export function FormField({
  id,
  label,
  size = 'lg',
  hint,
  error,
  warning,
  warningFix,
  className,
  children,
}: {
  id: string
  label: ReactNode
  size?: FieldSize
  hint?: ReactNode
  error?: ReactNode
  warning?: ReactNode
  warningFix?: FieldFix
  className?: string
  children: ReactNode | ((control: FieldControlProps) => ReactNode)
}) {
  const hintId = hint ? fieldMessageId(id, 'hint') : undefined
  const errorId = error ? fieldMessageId(id, 'error') : undefined
  const warningId = warning ? fieldMessageId(id, 'warning') : undefined

  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ''}`}>
      <label htmlFor={id} className="section-label">
        {label}
      </label>
      <div>
        {typeof children === 'function'
          ? children({
              id,
              'aria-describedby': describedBy(errorId, warningId, hintId),
              'aria-invalid': error ? true : undefined,
              className: fieldInputClass(size, Boolean(error)),
            })
          : children}
        {error && (
          <FieldMessage id={errorId} tone="error">
            {error}
          </FieldMessage>
        )}
        {warning && (
          <FieldMessage id={warningId} tone="warning" fix={warningFix}>
            {warning}
          </FieldMessage>
        )}
        {hint && (
          <p id={hintId} className="mt-1.5 text-caption text-grey-ink">
            {hint}
          </p>
        )}
      </div>
    </div>
  )
}
