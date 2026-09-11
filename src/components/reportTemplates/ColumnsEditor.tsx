import { useState } from 'react'
import { ChevronDown, ChevronUp, Pencil, Plus, Trash2 } from 'lucide-react'
import { FieldConfigForm } from './FieldConfigForm'
import {
  CELL_FIELD_KINDS,
  FIELD_KIND_LABELS,
  defaultField,
  slugifyKey,
} from './fieldKinds'
import type { CellDef } from '#/lib/reportTemplates'

/**
 * A repeater's columns, edited inline rather than through `AddFieldSheet` —
 * this is already nested one level inside that sheet (repeater is itself a
 * field being configured), and a second sheet stacked on top of the first
 * is worse than a form that expands in place.
 *
 * Restricted to `CELL_FIELD_KINDS` — the same leaf subset `CellDef` enforces
 * at the type level, so a column can never itself be a photo, signature,
 * GPS capture, area checklist, or nested repeater.
 */
export function ColumnsEditor({
  columns,
  onChange,
}: {
  columns: Array<CellDef>
  onChange: (next: Array<CellDef>) => void
}) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [picking, setPicking] = useState(false)

  const existingKeys = new Set(columns.map((c) => c.key))

  function updateAt(index: number, next: CellDef) {
    onChange(columns.map((c, i) => (i === index ? next : c)))
  }
  function removeAt(index: number) {
    onChange(columns.filter((_, i) => i !== index))
    if (editingIndex === index) setEditingIndex(null)
  }
  function move(index: number, direction: 'up' | 'down') {
    const target = direction === 'up' ? index - 1 : index + 1
    if (target < 0 || target >= columns.length) return
    const next = [...columns]
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }

  if (editingIndex !== null) {
    const column = columns[editingIndex]
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-hairline bg-surface-2 p-3">
        <span className="section-label">
          Editing column — {FIELD_KIND_LABELS[column.kind]}
        </span>
        <FieldConfigForm
          field={column}
          onChange={(next) => updateAt(editingIndex, next as CellDef)}
          existingKeys={
            new Set([...existingKeys].filter((k) => k !== column.key))
          }
          visibleWhenCandidates={[]}
        />
        <button
          type="button"
          onClick={() => setEditingIndex(null)}
          className="h-10 rounded-xl bg-surface text-[14px] font-semibold text-ink transition active:scale-[.98]"
        >
          Done
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="section-label">Columns</span>
      {columns.length === 0 && (
        <p className="text-caption text-muted">
          No columns yet — add at least one.
        </p>
      )}
      {columns.map((column, index) => (
        <div
          key={column.key}
          className="flex items-center gap-1.5 rounded-xl bg-surface-2 px-3 py-2"
        >
          <span className="flex-1 truncate text-body text-ink">
            {column.label}{' '}
            <span className="text-caption text-muted">
              ({FIELD_KIND_LABELS[column.kind]})
            </span>
          </span>
          <button
            type="button"
            disabled={index === 0}
            aria-label={`Move column ${index + 1} up`}
            onClick={() => move(index, 'up')}
            className="flex size-8 items-center justify-center rounded-full text-muted transition active:scale-[.95] disabled:opacity-30"
          >
            <ChevronUp size={15} strokeWidth={2} />
          </button>
          <button
            type="button"
            disabled={index === columns.length - 1}
            aria-label={`Move column ${index + 1} down`}
            onClick={() => move(index, 'down')}
            className="flex size-8 items-center justify-center rounded-full text-muted transition active:scale-[.95] disabled:opacity-30"
          >
            <ChevronDown size={15} strokeWidth={2} />
          </button>
          <button
            type="button"
            aria-label={`Edit column ${index + 1}`}
            onClick={() => setEditingIndex(index)}
            className="flex size-8 items-center justify-center rounded-full text-muted transition active:scale-[.95]"
          >
            <Pencil size={14} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            aria-label={`Remove column ${index + 1}`}
            onClick={() => removeAt(index)}
            className="flex size-8 items-center justify-center rounded-full text-muted transition active:scale-[.95]"
          >
            <Trash2 size={15} strokeWidth={1.8} />
          </button>
        </div>
      ))}

      {picking ? (
        <div className="grid grid-cols-2 gap-1.5">
          {CELL_FIELD_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => {
                const label = FIELD_KIND_LABELS[kind]
                const key = slugifyKey(label, existingKeys)
                onChange([
                  ...columns,
                  defaultField(kind, key, label) as CellDef,
                ])
                setPicking(false)
                setEditingIndex(columns.length)
              }}
              className="rounded-xl bg-surface-2 px-2 py-2.5 text-left text-[13px] font-semibold text-ink transition active:scale-[.97]"
            >
              {FIELD_KIND_LABELS[kind]}
            </button>
          ))}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setPicking(true)}
          className="flex h-10 items-center justify-center gap-1.5 rounded-xl bg-surface-2 text-[14px] font-semibold text-ink transition active:scale-[.98]"
        >
          <Plus size={15} strokeWidth={2} />
          Add column
        </button>
      )}
    </div>
  )
}
