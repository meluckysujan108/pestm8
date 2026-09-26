import { describeError } from './describeError'
import type { ReactNode } from 'react'
import type { ErrorCopy } from './describeError'

/**
 * The amber box a form shows when a save fails — the one every form wrote out
 * by hand. Its text is amber-ink, the one warning colour, which clears 4.5:1
 * in this box (styles.css; statusColours.test.ts checks it), since it is read
 * on a phone in the sun.
 *
 * Either pass the error and let describeError word it (with the form's own
 * `copy` where it wants), or pass the words as children. Renders nothing when
 * there is neither, so it can sit in the form unconditionally:
 *
 *   <FormAlert error={save.isError ? save.error : null} />
 */
export function FormAlert({
  error,
  copy,
  children,
  className,
}: {
  error?: unknown
  copy?: ErrorCopy
  children?: ReactNode
  className?: string
}) {
  const words =
    children ??
    (error !== undefined && error !== null ? describeError(error, copy) : null)
  if (words === null) return null
  return (
    <p
      role="alert"
      className={`rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-amber-ink ${className ?? ''}`}
    >
      {words}
    </p>
  )
}
