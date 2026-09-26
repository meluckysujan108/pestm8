import { useState } from 'react'
import { Drawer } from 'vaul'
import { SHEET_BODY, SheetShell } from '#/components/primitives/Sheet'
import { FieldConfigForm } from './FieldConfigForm'
import { ColumnsEditor } from './ColumnsEditor'
import { ALL_FIELD_KINDS, FIELD_KIND_HINTS, FIELD_KIND_LABELS, defaultField, slugifyKey } from './fieldKinds'
import type { FieldDef, FieldKind } from '#/lib/reportTemplates'
import { PRIMARY_BUTTON } from '#/components/primitives/buttons'

/**
 * Two steps for a new field (pick a kind, then configure it), or straight to
 * configuration when editing one that already exists — the kind of an
 * existing field never changes, only its settings, so re-showing the picker
 * would invite a switch this app has nowhere to migrate stored answers for.
 */
export function AddFieldSheet({
  open,
  onClose,
  onSave,
  existingKeys,
  visibleWhenCandidates,
  editing,
}: {
  open: boolean
  onClose: () => void
  onSave: (field: FieldDef) => void
  existingKeys: Set<string>
  visibleWhenCandidates: Array<{ key: string; label: string }>
  /** Present when editing an already-declared field; absent when adding a new one. */
  editing?: FieldDef
}) {
  const [kind, setKind] = useState<FieldKind | null>(editing?.kind ?? null)
  const [draft, setDraft] = useState<FieldDef | null>(editing ?? null)

  function reset() {
    setKind(editing?.kind ?? null)
    setDraft(editing ?? null)
  }

  function pickKind(k: FieldKind) {
    const label = FIELD_KIND_LABELS[k]
    const key = slugifyKey(label, existingKeys)
    setKind(k)
    setDraft(defaultField(k, key, label))
  }

  const keyConflict =
    draft !== null &&
    (draft.key.trim().length === 0 ||
      (draft.key !== editing?.key && existingKeys.has(draft.key)))
  const optionsMissing =
    draft !== null &&
    (draft.kind === 'select' ||
      draft.kind === 'radio' ||
      draft.kind === 'chips' ||
      draft.kind === 'checks') &&
    draft.options.length === 0
  const columnsMissing = draft !== null && draft.kind === 'repeater' && draft.columns.length === 0
  // A heading with no text prints as a blank line; a note with an empty body
  // prints as an empty box. Caught here rather than server-side, where the
  // same mistake surfaces as a generic INVALID_TEMPLATE the author cannot act
  // on.
  const textMissing =
    draft !== null && draft.kind === 'heading' && draft.text.trim().length === 0
  const bodyMissing =
    draft !== null &&
    draft.kind === 'note' &&
    draft.body.content.every(
      (block) =>
        (block.type === 'paragraph' || block.type === 'heading') &&
        block.content.every((node) => node.text.trim() === ''),
    )
  const canSave =
    draft !== null &&
    !keyConflict &&
    !optionsMissing &&
    !columnsMissing &&
    !textMissing &&
    !bodyMissing &&
    draft.label.trim().length > 0

  return (
    <SheetShell open={open} onClose={() => {
              onClose()
              reset()
            }}>
      <div className={`${SHEET_BODY} pt-3`}>
        <Drawer.Title className="pr-10 text-sheet-title text-ink">
          {editing ? 'Edit field' : kind ? FIELD_KIND_LABELS[kind] : 'Add a field'}
        </Drawer.Title>

        {kind === null ? (
          <div className="mt-4 grid grid-cols-2 gap-2">
            {ALL_FIELD_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => pickKind(k)}
                className="rounded-xl border border-hairline bg-surface p-3 text-left transition active:scale-[.97]"
              >
                <p className="text-[14px] font-semibold text-ink">
                  {FIELD_KIND_LABELS[k]}
                </p>
                <p className="mt-0.5 text-caption text-muted">
                  {FIELD_KIND_HINTS[k]}
                </p>
              </button>
            ))}
          </div>
        ) : (
          draft && (
            <div className="mt-4 flex flex-col gap-4">
              <FieldConfigForm
                field={draft}
                onChange={setDraft}
                existingKeys={
                  new Set([...existingKeys].filter((k) => k !== editing?.key))
                }
                visibleWhenCandidates={visibleWhenCandidates}
              />
              {draft.kind === 'repeater' && (
                <ColumnsEditor
                  columns={draft.columns}
                  onChange={(columns) => setDraft({ ...draft, columns })}
                />
              )}
              <button
                type="button"
                disabled={!canSave}
                onClick={() => {
                  onSave(draft)
                  onClose()
                  reset()
                }}
                className={PRIMARY_BUTTON}
              >
                {editing ? 'Save field' : 'Add field'}
              </button>
            </div>
          )
        )}
      </div>
    </SheetShell>
  )
}
