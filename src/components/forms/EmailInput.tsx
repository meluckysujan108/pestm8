import { useEffect, useRef, useState } from 'react'
import {
  COMMON_EMAIL_DOMAINS,
  emailDomain,
  emailProblem,
  emailTypoFix,
} from '../../../convex/lib/email'
import { networkLookupsAllowed } from '#/lib/addressLookup'
import { isOffline } from '#/lib/online'
import { checkEmailDomain, knownDomainMail } from '#/lib/emailDomainCheck'
import { FieldMessage } from './FieldMessage'
import {
  describedBy,
  fieldInputClass,
  fieldLabelText,
  fieldMessageId,
} from './FormField'
import { useLatest, useSaveCheck } from './SaveWarnings'
import type { DomainMail } from '#/lib/emailDomainCheck'
import type { FieldSize } from './FormField'
import type { SaveWarning } from './saveWarningRules'

const COMMON: ReadonlySet<string> = new Set(COMMON_EMAIL_DOMAINS)

/**
 * An email address, checked three ways (convex/lib/email.ts):
 *
 * - One that can never be delivered to ("bob@gmail", a space) is refused
 *   through the input's own validity, so the form stops at the field — the
 *   rule the server enforces, which the browser's type="email" does not
 *   (it lets bob@gmail through). Its sentence appears once the field is left
 *   or a submit refused, not while the address is still going in.
 * - A near miss of a common provider ("gmial.com") is a warning with a
 *   one-tap fix, never a refusal: it may be a real address.
 * - At save, inside a SaveWarningsProvider, whether the domain receives mail
 *   at all (DNS-over-HTTPS, only the domain sent). Off under a test runner
 *   and offline; a slow or failed answer says nothing.
 *
 * `initial` is the address already saved on the record. Left as it was, it
 * is never refused — only warned about — whatever it is: nothing here makes
 * old data unsaveable.
 *
 * Renders its own message lines, so name it with <label htmlFor={id}> (or
 * FormField), not by wrapping it in a <label>.
 */
export function EmailInput({
  id,
  value,
  onChange,
  initial,
  required,
  size = 'lg',
  placeholder,
  ariaLabel,
  name,
  describedBy: extraDescribedBy,
  autoComplete = 'off',
}: {
  id: string
  value: string
  onChange: (v: string) => void
  /** The saved value. Unchanged, it is never an error. */
  initial?: string
  required?: boolean
  size?: FieldSize
  placeholder?: string
  /** Only when there is no visible <label>. */
  ariaLabel?: string
  /** The field's name in the save-warnings list. Defaults to its label's
   * text, else "Email". */
  name?: string
  /** More ids for aria-describedby: a FormField hint, say. */
  describedBy?: string
  /** Off by default: most of these fields are a customer's address, which
   * the browser would fill with the person's own. */
  autoComplete?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [reveal, setReveal] = useState(false)

  const typed = value.trim()
  const changed = initial === undefined || typed !== initial.trim()
  const problem = typed === '' ? null : emailProblem(typed)
  const refused = problem !== null && changed
  const typo = problem === null ? emailTypoFix(typed) : null

  const showError = refused && reveal
  // A saved address that fails the rule is still said, as a warning.
  const warning =
    problem !== null && !changed
      ? problem
      : typo !== null
        ? `Did you mean ${typo}?`
        : null
  const showWarning = warning !== null && reveal
  const errorId = fieldMessageId(id, 'error')
  const warningId = fieldMessageId(id, 'warning')

  useEffect(() => {
    inputRef.current?.setCustomValidity(refused && problem ? problem : '')
  }, [refused, problem])

  const latestOnChange = useLatest(onChange)
  const focus = () => inputRef.current?.focus()
  const fieldName = () => name ?? fieldLabelText(id, 'Email')

  useSaveCheck(
    id,
    (signal) => {
      if (typed === '' || refused) return []
      if (warning !== null) {
        const w: SaveWarning = {
          id: `${id}:${typo ? 'typo' : 'saved'}`,
          label: fieldName(),
          message: warning,
          focus,
        }
        if (typo)
          w.fix = { label: 'Use it', apply: () => latestOnChange.current(typo) }
        return [w]
      }
      // An address already on the record is not looked up on every save of
      // something else; one being typed now is.
      const domain = changed ? emailDomain(typed) : null
      if (domain === null || COMMON.has(domain)) return []
      if (!networkLookupsAllowed() || isOffline()) return []
      const said = (answer: DomainMail): Array<SaveWarning> =>
        answer === 'no-mail'
          ? [
              {
                id: `${id}:domain`,
                label: fieldName(),
                message: `${domain} doesn't look like it receives email.`,
                focus,
              },
            ]
          : []
      // Asked already (on blur): answered in the same tick, no "Checking…".
      const known = knownDomainMail(domain)
      if (known !== undefined) return said(known)
      return checkEmailDomain(domain, { signal }).then(said)
    },
    [typed],
  )

  return (
    <>
      <input
        ref={inputRef}
        id={id}
        // A saved address the browser's own check would refuse (a space in
        // it) must still save untouched, so it is plain text until edited.
        type={problem !== null && !changed ? 'text' : 'email'}
        inputMode="email"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        autoComplete={autoComplete}
        required={required}
        placeholder={placeholder}
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => {
          const next = e.target.value
          // Put right (or cleared), it goes quiet until next left.
          const t = next.trim()
          if (t === '' || (emailProblem(t) === null && !emailTypoFix(t))) {
            setReveal(false)
          }
          onChange(next)
        }}
        onBlur={() => {
          setReveal(warning !== null || refused)
          // Ask now, so Save has the answer waiting. Only the domain goes.
          if (!refused && warning === null && changed) {
            const domain = emailDomain(typed)
            if (
              domain !== null &&
              !COMMON.has(domain) &&
              networkLookupsAllowed() &&
              !isOffline()
            ) {
              void checkEmailDomain(domain)
            }
          }
        }}
        onInvalid={() => setReveal(true)}
        aria-invalid={showError || undefined}
        aria-describedby={describedBy(
          showError && errorId,
          showWarning && warningId,
          extraDescribedBy,
        )}
        className={fieldInputClass(size, showError)}
      />
      {showError && (
        <FieldMessage id={errorId} tone="error">
          {problem}
        </FieldMessage>
      )}
      {showWarning && (
        <FieldMessage
          id={warningId}
          tone="warning"
          fix={
            typo
              ? { label: 'Use it', onApply: () => onChange(typo) }
              : undefined
          }
        >
          {warning}
        </FieldMessage>
      )}
    </>
  )
}
