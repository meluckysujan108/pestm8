/** Segmented control. Never a dropdown for binary/ternary filters (§2.3). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  label: string
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex rounded-[9px] bg-fill-track p-0.5"
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(option.value)}
            className={`flex-1 rounded-[7px] px-3 py-1.5 text-[13px] font-semibold transition ${
              selected ? 'bg-surface text-ink shadow-elevation' : 'text-muted'
            }`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
