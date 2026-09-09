import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react'
import type { Option } from '#/lib/reportTemplates'

/**
 * The options list every `select`/`radio`/`chips`/`checks` field needs.
 * `value` always mirrors `label` — matching the built-in templates' own
 * `asOptions()` convention (`serviceReport.ts`) — so a business author never
 * has to think about a separate stored code, only the words a technician
 * sees.
 */
export function OptionsListEditor({
  options,
  onChange,
}: {
  options: Array<Option>
  onChange: (next: Array<Option>) => void
}) {
  function updateLabel(index: number, label: string) {
    onChange(options.map((o, i) => (i === index ? { value: label, label } : o)))
  }
  function remove(index: number) {
    onChange(options.filter((_, i) => i !== index))
  }
  function move(index: number, direction: 'up' | 'down') {
    const target = direction === 'up' ? index - 1 : index + 1
    if (target < 0 || target >= options.length) return
    const next = [...options]
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="section-label">Options</span>
      {options.length === 0 && (
        <p className="text-caption text-muted">No options yet — add at least one.</p>
      )}
      {options.map((option, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <input
            value={option.label}
            onChange={(e) => updateLabel(index, e.target.value)}
            placeholder={`Option ${index + 1}`}
            className="h-11 flex-1 rounded-xl bg-surface-3 px-3 text-[15px] text-ink outline-none focus:ring-2 focus:ring-blue"
          />
          <button
            type="button"
            disabled={index === 0}
            aria-label={`Move option ${index + 1} up`}
            onClick={() => move(index, 'up')}
            className="flex size-8 items-center justify-center rounded-full text-muted transition active:scale-[.95] disabled:opacity-30"
          >
            <ChevronUp size={15} strokeWidth={2} />
          </button>
          <button
            type="button"
            disabled={index === options.length - 1}
            aria-label={`Move option ${index + 1} down`}
            onClick={() => move(index, 'down')}
            className="flex size-8 items-center justify-center rounded-full text-muted transition active:scale-[.95] disabled:opacity-30"
          >
            <ChevronDown size={15} strokeWidth={2} />
          </button>
          <button
            type="button"
            aria-label={`Remove option ${index + 1}`}
            onClick={() => remove(index)}
            className="flex size-8 items-center justify-center rounded-full text-muted transition active:scale-[.95]"
          >
            <Trash2 size={15} strokeWidth={1.8} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...options, { value: '', label: '' }])}
        className="flex h-10 items-center justify-center gap-1.5 rounded-xl bg-surface-2 text-[14px] font-semibold text-ink transition active:scale-[.98]"
      >
        <Plus size={15} strokeWidth={2} />
        Add option
      </button>
    </div>
  )
}
