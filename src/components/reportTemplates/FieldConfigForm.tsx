import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react'
import { Segmented } from '#/components/primitives/Segmented'
import { OptionsListEditor } from './OptionsListEditor'
import { VisibleWhenEditor } from './VisibleWhenEditor'
import { slugifyKey } from './fieldKinds'
import { isDataField } from '#/lib/reportTemplates'
import type { FieldDef, RichDoc } from '#/lib/reportTemplates'
import type { Condition } from '#/lib/reportTemplates/visibility'

/**
 * Every field kind's configuration, in one form. Kept as one file rather
 * than fifteen — most kinds need only label/hint/required plus at most one
 * or two extras, and switching on `field.kind` here is no heavier than
 * fifteen tiny components would be, without the indirection of hunting
 * across files for what is, in every case, a handful of inputs.
 *
 * The one thing genuinely factored out is `OptionsListEditor`, reused by
 * four kinds, and `VisibleWhenEditor`, reused by every kind.
 */
export function FieldConfigForm({
  field,
  onChange,
  existingKeys,
  visibleWhenCandidates,
}: {
  field: FieldDef
  onChange: (next: FieldDef) => void
  /** Every other field's key already in this template, for uniqueness. */
  existingKeys: Set<string>
  visibleWhenCandidates: Array<{ key: string; label: string }>
}) {
  const keyTaken = field.key.trim().length === 0 || existingKeys.has(field.key)

  function setLabel(label: string) {
    // The key follows the label until the author edits it directly —
    // detected by whether the current key still matches what the *previous*
    // label would have produced, so a deliberate manual key survives.
    const wasFollowing = field.key === slugifyKey(field.label, existingKeys)
    const key = wasFollowing ? slugifyKey(label, existingKeys) : field.key
    onChange({ ...field, label, key })
  }

  return (
    <div className="flex flex-col gap-3.5">
      <label className="flex flex-col gap-1.5">
        <span className="section-label">Label</span>
        <input
          value={field.label}
          onChange={(e) => setLabel(e.target.value)}
          required
          className="h-11 w-full rounded-xl bg-surface-3 px-3 text-[15px] text-ink outline-none focus:ring-2 focus:ring-blue"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="section-label">Stored as</span>
        <input
          value={field.key}
          onChange={(e) => onChange({ ...field, key: e.target.value })}
          className={`h-10 w-full rounded-xl bg-surface-3 px-3 font-mono text-[13px] outline-none focus:ring-2 focus:ring-blue ${
            keyTaken ? 'text-red' : 'text-ink-2'
          }`}
        />
        {keyTaken && (
          <span className="text-caption text-red">
            Another field already uses this key.
          </span>
        )}
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="section-label">Hint (optional)</span>
        <input
          value={field.hint ?? ''}
          onChange={(e) =>
            onChange({ ...field, hint: e.target.value || undefined })
          }
          className="h-11 w-full rounded-xl bg-surface-3 px-3 text-[15px] text-ink outline-none focus:ring-2 focus:ring-blue"
        />
      </label>

      {/* `areas` has its own no-access-reason rule instead of a plain
          required flag; nothing that stores no answer in `data` can be
          enforced from it at all (see `deriveSchema.ts`) — showing the toggle
          for either would promise something that never actually happens. On a
          printed note the promise is worse than empty: ticking it makes the
          finalise gate demand a value for a block with no control, and the
          report can never be locked. */}
      {isDataField(field) && field.kind !== 'areas' && (
        <label className="flex items-center justify-between gap-2">
          <span className="text-body text-ink">Required</span>
          <input
            type="checkbox"
            checked={field.required ?? false}
            onChange={(e) =>
              onChange({ ...field, required: e.target.checked || undefined })
            }
            className="size-5"
          />
        </label>
      )}

      <KindSpecificFields field={field} onChange={onChange} />

      <VisibleWhenEditor
        value={field.visibleWhen}
        onChange={(next: Condition | undefined) => onChange({ ...field, visibleWhen: next })}
        candidates={visibleWhenCandidates}
      />
    </div>
  )
}

function KindSpecificFields({
  field,
  onChange,
}: {
  field: FieldDef
  onChange: (next: FieldDef) => void
}) {
  switch (field.kind) {
    case 'text':
      return (
        <TextInput
          label="Placeholder (optional)"
          value={field.placeholder ?? ''}
          onChange={(v) => onChange({ ...field, placeholder: v || undefined })}
        />
      )

    case 'area':
      return (
        <>
          <TextInput
            label="Placeholder (optional)"
            value={field.placeholder ?? ''}
            onChange={(v) => onChange({ ...field, placeholder: v || undefined })}
          />
          <NumberInput
            label="Rows"
            value={field.rows ?? 3}
            onChange={(v) => onChange({ ...field, rows: v })}
          />
        </>
      )

    case 'number':
      return (
        <div className="grid grid-cols-2 gap-3">
          <TextInput
            label="Unit (optional)"
            value={field.unit ?? ''}
            onChange={(v) => onChange({ ...field, unit: v || undefined })}
          />
          <NumberInput
            label="Min (optional)"
            value={field.min}
            onChange={(v) => onChange({ ...field, min: v })}
            optional
          />
          <NumberInput
            label="Max (optional)"
            value={field.max}
            onChange={(v) => onChange({ ...field, max: v })}
            optional
          />
          <NumberInput
            label="Step (optional)"
            value={field.step}
            onChange={(v) => onChange({ ...field, step: v })}
            optional
          />
        </div>
      )

    case 'toggle':
      return (
        <div className="grid grid-cols-2 gap-3">
          <TextInput
            label='"Yes" label (optional)'
            value={field.yes ?? ''}
            onChange={(v) => onChange({ ...field, yes: v || undefined })}
          />
          <TextInput
            label='"No" label (optional)'
            value={field.no ?? ''}
            onChange={(v) => onChange({ ...field, no: v || undefined })}
          />
        </div>
      )

    case 'select':
    case 'radio':
    case 'chips':
      return (
        <OptionsListEditor
          options={field.options}
          onChange={(options) => onChange({ ...field, options })}
        />
      )

    case 'checks':
      return (
        <>
          <OptionsListEditor
            options={field.options}
            onChange={(options) => onChange({ ...field, options })}
          />
          <label className="flex items-center justify-between gap-2">
            <span className="text-body text-ink">
              Let the technician add their own item
            </span>
            <input
              type="checkbox"
              checked={field.extensible ?? false}
              onChange={(e) =>
                onChange({ ...field, extensible: e.target.checked || undefined })
              }
              className="size-5"
            />
          </label>
          {field.extensible && (
            <TextInput
              label="'Add item' button label (optional)"
              value={field.addLabel ?? ''}
              onChange={(v) => onChange({ ...field, addLabel: v || undefined })}
            />
          )}
        </>
      )

    case 'date':
      return (
        <label className="flex items-center justify-between gap-2">
          <span className="text-body text-ink">Default to today</span>
          <input
            type="checkbox"
            checked={field.defaultToday ?? false}
            onChange={(e) =>
              onChange({ ...field, defaultToday: e.target.checked || undefined })
            }
            className="size-5"
          />
        </label>
      )

    case 'time':
    case 'gps':
      return null

    case 'signature':
      return (
        <Segmented
          label="Who signs"
          value={field.role}
          options={[
            { value: 'technician', label: 'Technician' },
            { value: 'client', label: 'Client' },
          ]}
          onChange={(role) => onChange({ ...field, role })}
        />
      )

    case 'areas':
      return (
        <StringListEditor
          label="Areas"
          addLabel="Add area"
          values={field.rows}
          onChange={(rows) => onChange({ ...field, rows })}
        />
      )

    case 'photos':
      return (
        <StringListEditor
          label="Photo slots"
          addLabel="Add slot"
          values={field.slots}
          onChange={(slots) => onChange({ ...field, slots })}
        />
      )

    case 'gallery':
      return (
        <div className="grid grid-cols-2 gap-3">
          <NumberInput
            label="Max photos (optional)"
            value={field.maxPhotos}
            onChange={(v) => onChange({ ...field, maxPhotos: v })}
            optional
          />
          <TextInput
            label="'Add photo' button label (optional)"
            value={field.addLabel ?? ''}
            onChange={(v) => onChange({ ...field, addLabel: v || undefined })}
          />
        </div>
      )

    case 'repeater':
      // Columns are configured from `SectionEditor` via `ColumnsEditor` —
      // this form only owns the row-count bounds and add-button label, since
      // the columns editor needs more room than a shared form can spare.
      return (
        <div className="grid grid-cols-3 gap-3">
          <TextInput
            label="'Add row' label (optional)"
            value={field.addLabel ?? ''}
            onChange={(v) => onChange({ ...field, addLabel: v || undefined })}
          />
          <NumberInput
            label="Min rows (optional)"
            value={field.min}
            onChange={(v) => onChange({ ...field, min: v })}
            optional
          />
          <NumberInput
            label="Max rows (optional)"
            value={field.max}
            onChange={(v) => onChange({ ...field, max: v })}
            optional
          />
        </div>
      )

    case 'heading':
      return (
        <>
          <TextInput
            label="Heading"
            value={field.text}
            onChange={(v) => onChange({ ...field, text: v })}
          />
          <TextInput
            label="Note under the heading (optional)"
            value={field.note ?? ''}
            onChange={(v) => onChange({ ...field, note: v || undefined })}
          />
        </>
      )

    case 'note':
      // The body is edited as plain paragraphs here. A real rich-text editor
      // for notes arrives with the rest of the builder rebuild; until then
      // this stays honest about what it can do rather than offering formatting
      // it would silently drop.
      return (
        <>
          <TextInput
            label="Bold lead-in (optional)"
            value={field.heading ?? ''}
            onChange={(v) => onChange({ ...field, heading: v || undefined })}
          />
          <label className="flex flex-col gap-1.5">
            <span className="section-label">Printed text</span>
            <textarea
              rows={6}
              value={paragraphsToText(field.body)}
              onChange={(e) =>
                onChange({ ...field, body: textToParagraphs(e.target.value) })
              }
              className="w-full rounded-xl bg-surface-3 p-3.5 text-[16px] leading-relaxed text-ink outline-none focus:ring-2 focus:ring-blue"
            />
          </label>
        </>
      )

    case 'derived':
    case 'member':
    case 'cover':
    case 'emails':
      // Not offered in `ALL_FIELD_KINDS`, so the picker cannot mint one — but
      // a template cloned from a built-in can contain them, and this form must
      // still open without blowing up on one.
      return null

    default: {
      // A new kind must say how it is configured. Without this the switch just
      // widens its inferred return to include `undefined`, React renders
      // nothing, and the kind's config UI is silently absent.
      const _exhaustive: never = field
      void _exhaustive
      return null
    }
  }
}

/**
 * Plain paragraphs in and out of a `RichDoc`. Lossy by design: it cannot
 * express bold, bullets or definitions, so it is only ever used to edit a body
 * that has none, and the blocks it does not understand are left untouched.
 */
function paragraphsToText(doc: RichDoc): string {
  return doc.content
    .map((block) =>
      block.type === 'paragraph' || block.type === 'heading'
        ? block.content.map((node) => node.text).join('')
        : '',
    )
    .join('\n\n')
}

function textToParagraphs(text: string): RichDoc {
  return {
    type: 'doc',
    content: text.split(/\n{2,}/).map((paragraph) => ({
      type: 'paragraph' as const,
      content: paragraph === '' ? [] : [{ type: 'text' as const, text: paragraph }],
    })),
  }
}

function TextInput({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="section-label">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-11 w-full rounded-xl bg-surface-3 px-3 text-[15px] text-ink outline-none focus:ring-2 focus:ring-blue"
      />
    </label>
  )
}

function NumberInput({
  label,
  value,
  onChange,
  optional,
}: {
  label: string
  value: number | undefined
  onChange: (v: number | undefined) => void
  optional?: boolean
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="section-label">{label}</span>
      <input
        type="number"
        value={value ?? ''}
        onChange={(e) => {
          const raw = e.target.value
          onChange(raw === '' ? (optional ? undefined : 0) : Number(raw))
        }}
        className="h-11 w-full rounded-xl bg-surface-3 px-3 text-[15px] text-ink outline-none focus:ring-2 focus:ring-blue"
      />
    </label>
  )
}

function StringListEditor({
  label,
  addLabel,
  values,
  onChange,
}: {
  label: string
  addLabel: string
  values: Array<string>
  onChange: (next: Array<string>) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="section-label">{label}</span>
      {values.map((value, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <input
            value={value}
            onChange={(e) =>
              onChange(values.map((v, i) => (i === index ? e.target.value : v)))
            }
            className="h-11 flex-1 rounded-xl bg-surface-3 px-3 text-[15px] text-ink outline-none focus:ring-2 focus:ring-blue"
          />
          <button
            type="button"
            disabled={index === 0}
            aria-label={`Move ${label.toLowerCase()} ${index + 1} up`}
            onClick={() => {
              if (index === 0) return
              const next = [...values]
              ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
              onChange(next)
            }}
            className="flex size-8 items-center justify-center rounded-full text-muted transition active:scale-[.95] disabled:opacity-30"
          >
            <ChevronUp size={15} strokeWidth={2} />
          </button>
          <button
            type="button"
            disabled={index === values.length - 1}
            aria-label={`Move ${label.toLowerCase()} ${index + 1} down`}
            onClick={() => {
              if (index === values.length - 1) return
              const next = [...values]
              ;[next[index], next[index + 1]] = [next[index + 1], next[index]]
              onChange(next)
            }}
            className="flex size-8 items-center justify-center rounded-full text-muted transition active:scale-[.95] disabled:opacity-30"
          >
            <ChevronDown size={15} strokeWidth={2} />
          </button>
          <button
            type="button"
            aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
            onClick={() => onChange(values.filter((_, i) => i !== index))}
            className="flex size-8 items-center justify-center rounded-full text-muted transition active:scale-[.95]"
          >
            <Trash2 size={15} strokeWidth={1.8} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...values, ''])}
        className="flex h-10 items-center justify-center gap-1.5 rounded-xl bg-surface-2 text-[14px] font-semibold text-ink transition active:scale-[.98]"
      >
        <Plus size={15} strokeWidth={2} />
        {addLabel}
      </button>
    </div>
  )
}
