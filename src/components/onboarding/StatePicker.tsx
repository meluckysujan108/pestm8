import { AU_STATES } from '#/lib/au'

/** West to east, the way the map reads. */
const ORDER = ['WA', 'NT', 'SA', 'QLD', 'NSW', 'ACT', 'VIC', 'TAS']
const STATES = ORDER.map((code) => AU_STATES.find((s) => s.code === code)!)

/**
 * The state, as eight buttons rather than a menu: one tap, and every choice
 * in view. A radio group to a screen reader.
 */
export function StatePicker({
  value,
  onChange,
  labelId,
  guessed,
}: {
  value: string
  onChange: (code: string) => void
  labelId: string
  /** Picked from the phone's time zone, and not yet changed. */
  guessed: boolean
}) {
  const current = AU_STATES.find((s) => s.code === value)
  return (
    <div>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className="grid grid-cols-4 gap-2"
      >
        {STATES.map((s) => {
          const selected = s.code === value
          return (
            <button
              key={s.code}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={s.name}
              onClick={() => onChange(s.code)}
              className={`h-11 rounded-xl text-[15px] font-semibold transition active:scale-[.96] ${
                selected ? 'bg-ink text-canvas' : 'bg-surface-3 text-ink-2'
              }`}
            >
              {s.code}
            </button>
          )
        })}
      </div>
      <p className="mt-2 text-caption text-muted">
        {current?.name}
        {guessed ? ', from your phone’s time zone. ' : '. '}
        Sets your time zone and how licences are labelled.
      </p>
    </div>
  )
}
