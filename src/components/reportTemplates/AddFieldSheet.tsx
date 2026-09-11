import { useState } from 'react'
import { Drawer } from 'vaul'
import { FieldConfigForm } from './FieldConfigForm'
import { ColumnsEditor } from './ColumnsEditor'
import { ALL_FIELD_KINDS, FIELD_KIND_HINTS, FIELD_KIND_LABELS, defaultField, slugifyKey } from './fieldKinds'
import type { FieldDef, FieldKind } from '#/lib/reportTemplates'

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
  const canSave =
    draft !== null && !keyConflict && !optionsMissing && !columnsMissing && draft.label.trim().length > 0

  return (
    <Drawer.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          onClose()
          reset()
        }
      }}
    >
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92vh] w-full max-w-[460px] flex-col rounded-t-[22px] bg-canvas outline-none">
          <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-hairline" />
          <div className="flex-1 overflow-y-auto px-4 pb-[calc(24px+env(safe-area-inset-bottom))] pt-3">
            <Drawer.Title className="text-sheet-title text-ink">
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
                    className="h-12 rounded-xl bg-red text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
                  >
                    {editing ? 'Save field' : 'Add field'}
                  </button>
                </div>
              )
            )}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
