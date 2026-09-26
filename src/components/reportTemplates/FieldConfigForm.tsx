import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react'
import { Segmented } from '#/components/primitives/Segmented'
import { OptionsListEditor } from './OptionsListEditor'
import { VisibleWhenEditor } from './VisibleWhenEditor'
import { slugifyKey } from './fieldKinds'
import { isDataField } from '#/lib/reportTemplates'
import type { FieldDef, RichDoc } from '#/lib/reportTemplates'
import type { Condition } from '#/lib/reportTemplates/visibility'
import { SECONDARY_BUTTON_COMPACT } from '#/components/primitives/buttons'
import { FIELD_COMPACT, FIELD_SURFACE } from '#/components/forms/FormField'

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
/**
 * The record details a `derived` row can print, grouped the way an author
 * thinks about them rather than in the order the union declares them.
 */
const DERIVED_SOURCES = [
  {
    label: 'Client',
    items: [
      { value: 'client.name', label: 'Client name' },
      { value: 'client.address', label: 'Client address' },
      { value: 'client.phone', label: 'Client phone' },
      { value: 'client.email', label: 'Client email' },
    ],
  },
  {
    label: 'Site',
    items: [{ value: 'property.address', label: 'Site address' }],
  },
  {
    label: 'Your business',
    items: [
      { value: 'business.name', label: 'Business name' },
      { value: 'business.tradingName', label: 'Trading name' },
      { value: 'business.address', label: 'Business address' },
      { value: 'business.phone', label: 'Business phone' },
      { value: 'business.email', label: 'Business email' },
      { value: 'business.website', label: 'Website' },
      { value: 'business.abn', label: 'ABN' },
    ],
  },
  {
    label: 'The person who did the work',
    items: [
      { value: 'technician.name', label: 'Name' },
      { value: 'technician.licence', label: 'Licence number' },
      { value: 'technician.phone', label: 'Phone' },
      { value: 'technician.address', label: 'Address' },
    ],
  },
  { label: 'Job', items: [{ value: 'job.number', label: 'Job number' }] },
] as const

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
          className={`${FIELD_COMPACT} w-full`}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="section-label">Stored as</span>
        <input
          value={field.key}
          onChange={(e) => onChange({ ...field, key: e.target.value })}
          className={`h-11 w-full rounded-xl bg-surface-3 px-3.5 font-mono text-[16px] outline-none focus:ring-2 focus:ring-blue ${
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
          className={`${FIELD_COMPACT} w-full`}
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
          kind="choice"
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
              className={`${FIELD_SURFACE} w-full p-3.5 leading-relaxed`}
            />
          </label>
        </>
      )

    case 'derived':
      return (
        <label className="flex flex-col gap-1.5">
          <span className="section-label">Which detail</span>
          <select
            value={field.source}
            onChange={(e) =>
              onChange({ ...field, source: e.target.value as typeof field.source })
            }
            className={`${FIELD_COMPACT} w-full`}
          >
            {DERIVED_SOURCES.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.items.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <span className="text-caption text-muted">
            Printed from the record, never asked for. It stays live while the
            report is a draft and freezes when the report is locked, so
            renaming a client next year will not rewrite a document signed this
            year.
          </span>
        </label>
      )

    case 'member':
      return (
        <label className="flex flex-col gap-1.5">
          <span className="section-label">What to call them</span>
          <select
            value={field.roleWord ?? 'Technician'}
            onChange={(e) =>
              onChange({ ...field, roleWord: e.target.value as 'Technician' })
            }
            className={`${FIELD_COMPACT} w-full`}
          >
            <option value="Technician">Technician</option>
            <option value="Inspector">Inspector</option>
            <option value="Installer">Installer</option>
          </select>
          <span className="text-caption text-muted">
            Chosen from your active team, and printed with their licence
            number.
          </span>
        </label>
      )

    case 'cover':
      return (
        <p className="text-caption text-muted">
          One landscape photo, banded across the top of the front page. A form
          with more than one cover field uses the first.
        </p>
      )

    case 'emails':
      return (
        <p className="text-caption text-muted">
          Extra addresses this document is sent to when it is finalised. An
          address that is on nobody&rsquo;s record still prints, but waits for
          an owner to approve the send.
        </p>
      )

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
        className={`${FIELD_COMPACT} w-full`}
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
        className={`${FIELD_COMPACT} w-full`}
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
            className={`${FIELD_COMPACT} flex-1`}
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
            <ChevronUp size={15} strokeWidth={2.2} />
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
            <ChevronDown size={15} strokeWidth={2.2} />
          </button>
          <button
            type="button"
            aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
            onClick={() => onChange(values.filter((_, i) => i !== index))}
            className="flex size-8 items-center justify-center rounded-full text-muted transition active:scale-[.95]"
          >
            <Trash2 size={15} strokeWidth={2} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...values, ''])}
        className={`${SECONDARY_BUTTON_COMPACT} flex items-center justify-center gap-1.5`}
      >
        <Plus size={15} strokeWidth={2.2} />
        {addLabel}
      </button>
    </div>
  )
}
