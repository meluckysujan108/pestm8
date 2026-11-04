import { FIELD_COMPACT } from '#/components/forms/FormField'

/** A control wrapped in its label, for one with no message lines of its own
 * (those take the forms FormField, whose label names it by `htmlFor`). */
export function WrappedField({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="section-label">{label}</span>
      {children}
    </label>
  )
}

export function TextInput({
  value,
  onChange,
  type = 'text',
  required,
  inputMode,
  placeholder,
  ariaLabel,
}: {
  value: string
  onChange: (v: string) => void
  type?: string
  required?: boolean
  inputMode?: 'numeric' | 'decimal' | 'tel'
  placeholder?: string
  /** A name for a field with no visible label: a placeholder is only a
   * fallback name, and not every screen reader reads it as one. */
  ariaLabel?: string
}) {
  return (
    <input
      type={type}
      value={value}
      required={required}
      inputMode={inputMode}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      className={`${FIELD_COMPACT} w-full`}
    />
  )
}
