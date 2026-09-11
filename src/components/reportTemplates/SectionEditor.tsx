import { useState } from 'react'
import { ChevronDown, ChevronUp, Pencil, Plus, Trash2 } from 'lucide-react'
import { AddFieldSheet } from './AddFieldSheet'
import { VisibleWhenEditor } from './VisibleWhenEditor'
import { FIELD_KIND_LABELS } from './fieldKinds'
import type { FieldDef, SectionDef } from '#/lib/reportTemplates'

/**
 * One numbered section: title/preamble, its own `visibleWhen` (restricted to
 * fields declared in an earlier section, matching `VisibleWhenEditor`'s own
 * earlier-only rule), and its field rows.
 */
export function SectionEditor({
  section,
  onChange,
  onRemove,
  onMove,
  isFirst,
  isLast,
  earlierFieldCandidates,
  otherKeys,
}: {
  section: SectionDef
  onChange: (next: SectionDef) => void
  onRemove: () => void
  onMove: (direction: 'up' | 'down') => void
  isFirst: boolean
  isLast: boolean
  /** Fields from sections strictly before this one — for this section's own `visibleWhen`. */
  earlierFieldCandidates: Array<{ key: string; label: string }>
  /** Every field key elsewhere in the template, for key-uniqueness checks. */
  otherKeys: Set<string>
}) {
  const [sheetOpen, setSheetOpen] = useState(false)
  const [sheetNonce, setSheetNonce] = useState(0)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)

  function openAdd() {
    setEditingIndex(null)
    setSheetNonce((n) => n + 1)
    setSheetOpen(true)
  }
  function openEdit(index: number) {
    setEditingIndex(index)
    setSheetNonce((n) => n + 1)
    setSheetOpen(true)
  }

  function updateField(index: number, next: FieldDef) {
    onChange({ ...section, fields: section.fields.map((f, i) => (i === index ? next : f)) })
  }
  function removeField(index: number) {
    onChange({ ...section, fields: section.fields.filter((_, i) => i !== index) })
  }
  function moveField(index: number, direction: 'up' | 'down') {
    const target = direction === 'up' ? index - 1 : index + 1
    if (target < 0 || target >= section.fields.length) return
    const next = [...section.fields]
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange({ ...section, fields: next })
  }

  // A field's own `visibleWhen` may reference any field declared earlier in
  // the *whole template* — every field in this section before it, plus
  // everything from earlier sections.
  function candidatesBefore(fieldIndex: number) {
    return [
      ...earlierFieldCandidates,
      ...section.fields.slice(0, fieldIndex).map((f) => ({ key: f.key, label: f.label })),
    ]
  }

  const allKeysHere = new Set(section.fields.map((f) => f.key))
  const existingKeysForSheet = new Set([...otherKeys, ...allKeysHere])

  return (
    <div className="rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation">
      <div className="flex items-center gap-1.5">
        <input
          value={section.title}
          onChange={(e) => onChange({ ...section, title: e.target.value })}
          placeholder="Section title"
          className="h-11 flex-1 rounded-xl bg-surface-3 px-3 text-[16px] font-semibold text-ink outline-none focus:ring-2 focus:ring-blue"
        />
        <button
          type="button"
          disabled={isFirst}
          aria-label="Move section up"
          onClick={() => onMove('up')}
          className="flex size-9 items-center justify-center rounded-full text-muted transition active:scale-[.95] disabled:opacity-30"
        >
          <ChevronUp size={16} strokeWidth={2} />
        </button>
        <button
          type="button"
          disabled={isLast}
          aria-label="Move section down"
          onClick={() => onMove('down')}
          className="flex size-9 items-center justify-center rounded-full text-muted transition active:scale-[.95] disabled:opacity-30"
        >
          <ChevronDown size={16} strokeWidth={2} />
        </button>
        <button
          type="button"
          aria-label="Remove section"
          onClick={onRemove}
          className="flex size-9 items-center justify-center rounded-full text-muted transition active:scale-[.95]"
        >
          <Trash2 size={16} strokeWidth={1.8} />
        </button>
      </div>

      <input
        value={section.preamble ?? ''}
        onChange={(e) => onChange({ ...section, preamble: e.target.value || undefined })}
        placeholder="Preamble (optional)"
        className="mt-2 h-10 w-full rounded-xl bg-surface-3 px-3 text-[14px] text-ink-2 outline-none focus:ring-2 focus:ring-blue"
      />

      <div className="mt-3 flex flex-col gap-1.5">
        {section.fields.map((field, index) => (
          <div
            key={field.key}
            className="flex items-center gap-1.5 rounded-xl bg-surface-2 px-3 py-2"
          >
            <span className="flex-1 truncate text-body text-ink">
              {field.label}{' '}
              <span className="text-caption text-muted">
                ({FIELD_KIND_LABELS[field.kind]})
              </span>
            </span>
            <button
              type="button"
              disabled={index === 0}
              aria-label={`Move field ${index + 1} up`}
              onClick={() => moveField(index, 'up')}
              className="flex size-8 items-center justify-center rounded-full text-muted transition active:scale-[.95] disabled:opacity-30"
            >
              <ChevronUp size={15} strokeWidth={2} />
            </button>
            <button
              type="button"
              disabled={index === section.fields.length - 1}
              aria-label={`Move field ${index + 1} down`}
              onClick={() => moveField(index, 'down')}
              className="flex size-8 items-center justify-center rounded-full text-muted transition active:scale-[.95] disabled:opacity-30"
            >
              <ChevronDown size={15} strokeWidth={2} />
            </button>
            <button
              type="button"
              aria-label={`Edit field ${index + 1}`}
              onClick={() => openEdit(index)}
              className="flex size-8 items-center justify-center rounded-full text-muted transition active:scale-[.95]"
            >
              <Pencil size={14} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              aria-label={`Remove field ${index + 1}`}
              onClick={() => removeField(index)}
              className="flex size-8 items-center justify-center rounded-full text-muted transition active:scale-[.95]"
            >
              <Trash2 size={15} strokeWidth={1.8} />
            </button>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={openAdd}
        className="mt-2 flex h-10 w-full items-center justify-center gap-1.5 rounded-xl bg-surface-2 text-[14px] font-semibold text-ink transition active:scale-[.98]"
      >
        <Plus size={15} strokeWidth={2} />
        Add field
      </button>

      <div className="mt-3">
        <VisibleWhenEditor
          value={section.visibleWhen}
          onChange={(next) => onChange({ ...section, visibleWhen: next })}
          candidates={earlierFieldCandidates}
        />
      </div>

      <AddFieldSheet
        key={sheetNonce}
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        editing={editingIndex !== null ? section.fields[editingIndex] : undefined}
        existingKeys={
          editingIndex !== null
            ? new Set([...otherKeys, ...allKeysHere])
            : existingKeysForSheet
        }
        visibleWhenCandidates={
          editingIndex !== null ? candidatesBefore(editingIndex) : candidatesBefore(section.fields.length)
        }
        onSave={(field) => {
          if (editingIndex !== null) updateField(editingIndex, field)
          else onChange({ ...section, fields: [...section.fields, field] })
        }}
      />
    </div>
  )
}
