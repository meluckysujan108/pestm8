import { Plus, Trash2 } from 'lucide-react'
import { applyUpdate, LEAF_EDITORS } from './leafEditors'
import type { EditorProps, FieldEditor } from './registry'
import type { CellDef, FieldDef, RepeaterRow } from '#/lib/reportTemplates'

type RepeaterField = Extract<FieldDef, { kind: 'repeater' }>

function newRow(columns: Array<CellDef>): RepeaterRow {
  const row: RepeaterRow = { _id: crypto.randomUUID() }
  for (const cell of columns) {
    const editor = LEAF_EDITORS[cell.kind] as FieldEditor
    const seeded = editor.seed(cell)
    if (seeded !== undefined) row[cell.key] = seeded
  }
  return row
}

/**
 * Repeating rows, rendered as stacked cards rather than a table.
 *
 * The treatment grid's columns are each a multi-select list; four of those side
 * by side is unreadable on the phone a technician actually fills this in on. It
 * prints as a real grid — see `present()` — because a finished document is read
 * on paper or a desktop.
 *
 * Cells reuse the same registry as top-level fields, so a cell kind never needs
 * its own rendering path.
 */
export function RepeaterControl({
  field,
  value,
  onChange,
  ctx,
}: EditorProps<RepeaterField>) {
  const rows = (value as Array<RepeaterRow> | undefined) ?? []
  const atMax = field.max !== undefined && rows.length >= field.max
  const atMin = rows.length <= (field.min ?? 0)

  function update(rowId: string, key: string, next: unknown) {
    onChange((previous: unknown) =>
      ((previous as Array<RepeaterRow> | undefined) ?? []).map((row) =>
        // Cells use the same updater contract as top-level fields, resolved
        // here against the cell's own previous value rather than the row's.
        row._id === rowId
          ? { ...row, [key]: applyUpdate(next, row[key]) }
          : row,
      ),
    )
  }

  return (
    <span className="flex flex-col gap-2">
      {rows.map((row, index) => (
        // Keyed by the row's own id, not its index: deleting a middle row
        // would otherwise leave a focused input attached to different data.
        <span
          key={row._id}
          className="flex flex-col gap-2 rounded-xl border border-hairline bg-surface p-3"
        >
          <span className="flex items-center justify-between">
            <span className="section-label">
              {field.label} {index + 1}
            </span>
            <button
              type="button"
              disabled={atMin}
              aria-label={`Remove ${field.label.toLowerCase()} ${index + 1}`}
              onClick={() =>
                onChange((previous: unknown) =>
                  ((previous as Array<RepeaterRow> | undefined) ?? []).filter(
                    (candidate) => candidate._id !== row._id,
                  ),
                )
              }
              className="flex size-8 items-center justify-center rounded-full text-muted transition active:scale-[.95] disabled:opacity-30"
            >
              <Trash2 size={15} strokeWidth={1.8} />
            </button>
          </span>

          {field.columns.map((cell) => {
            const editor = LEAF_EDITORS[cell.kind] as FieldEditor
            const Control = editor.Control as React.ComponentType<EditorProps>
            return (
              <span key={cell.key} className="flex flex-col gap-1">
                <span className="section-label">{cell.label}</span>
                <Control
                  field={cell}
                  value={row[cell.key]}
                  onChange={(cellValue) => update(row._id, cell.key, cellValue)}
                  ctx={ctx}
                />
              </span>
            )
          })}
        </span>
      ))}

      <button
        type="button"
        disabled={atMax}
        onClick={() =>
          onChange((previous: unknown) => [
            ...((previous as Array<RepeaterRow> | undefined) ?? []),
            newRow(field.columns),
          ])
        }
        className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-surface-2 text-[15px] font-semibold text-ink transition active:scale-[.98] disabled:opacity-40"
      >
        <Plus size={16} strokeWidth={2} />
        {field.addLabel ?? `Add ${field.label.toLowerCase()}`}
      </button>
    </span>
  )
}
