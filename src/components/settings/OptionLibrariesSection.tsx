import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import {
  ArrowDown,
  ArrowUp,
  Check,
  Plus,
  RotateCcw,
  Star,
  Trash2,
} from 'lucide-react'
import { Sheet } from '#/components/primitives/Sheet'
import { api } from '../../../convex/_generated/api'
import type { OptionSetKey } from '#/lib/reportTemplates'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * The words a business's own reports offer.
 *
 * The products it actually stocks, the treatments it actually sells. Until
 * now these were the verbatim defaults out of the Pest M8 forms and the only
 * way to change one was to clone the whole template — which forks the wording
 * the business is required to reproduce. The mechanism for editing them has
 * existed since Phase 2 (resolution, and a rename that rewrites open drafts in
 * its own transaction); what was missing was any way to reach it.
 *
 * Business-wide rather than per-form on purpose: a product is a thing on a
 * shelf, not a thing a particular form knows about. What a single form calls
 * itself, and who has to sign it, lives with that form instead.
 */

type OptionRow = { value: string; label: string; usual: boolean }
type ListRow = {
  key: OptionSetKey
  label: string
  options: Array<OptionRow>
  archived: Array<{ value: string; label: string }>
  isDefault: boolean
  pinned: Array<string>
}

export function OptionLibrariesSection({
  businessId,
}: {
  businessId: Id<'businesses'>
}) {
  const { data: lists } = useQuery(
    convexQuery(api.optionSets.editable, { businessId }),
  )
  const [open, setOpen] = useState<OptionSetKey | null>(null)
  const editing = lists?.find((list) => list.key === open)

  return (
    <section>
      <h2 className="section-label mb-2">Report options</h2>
      <p className="mb-3 text-caption text-muted">
        The lists your reports offer. Changing one changes every form that uses
        it, and reports already finalised keep the list they were signed with.
      </p>

      {lists === undefined ? (
        <p className="text-caption text-muted">Loading…</p>
      ) : (
        <div className="flex flex-col gap-2">
          {lists.map((list) => (
            <button
              key={list.key}
              type="button"
              onClick={() => setOpen(list.key)}
              className="flex items-center justify-between gap-2 rounded-2xl border border-hairline bg-surface px-3.5 py-3 text-left shadow-elevation transition active:scale-[.99]"
            >
              <span className="min-w-0">
                <span className="block truncate text-body text-ink">
                  {list.label}
                </span>
                <span className="text-caption text-muted">
                  {list.options.length}{' '}
                  {list.options.length === 1 ? 'option' : 'options'}
                  {/* Worth saying: an untouched list is still exactly what the
                      form ships with, and a correction to it will arrive. */}
                  {list.isDefault ? " · the form's own" : ' · yours'}
                </span>
              </span>
              <span className="shrink-0 text-caption font-semibold text-blue">
                Edit
              </span>
            </button>
          ))}
        </div>
      )}

      {editing && (
        <OptionListSheet
          businessId={businessId}
          list={editing}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  )
}

function OptionListSheet({
  businessId,
  list,
  onClose,
}: {
  businessId: Id<'businesses'>
  list: ListRow
  onClose: () => void
}) {
  const [draft, setDraft] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameTo, setRenameTo] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Written out rather than wrapped in a helper that calls `useMutation`:
  // a hook behind a function is a rule-of-hooks trap waiting for the first
  // person who calls it conditionally.
  const onError = (failure: Error) => setError(messageFor(failure.message))
  const convexAdd = useConvexMutation(api.optionSets.addOption)
  const convexArchive = useConvexMutation(api.optionSets.archiveOption)
  const convexRestore = useConvexMutation(api.optionSets.restoreOption)
  const convexUsual = useConvexMutation(api.optionSets.setUsual)
  const convexReorder = useConvexMutation(api.optionSets.reorder)
  const convexReset = useConvexMutation(api.optionSets.resetToDefaults)

  type ByValue = {
    businessId: Id<'businesses'>
    key: OptionSetKey
    value: string
  }
  const add = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      key: OptionSetKey
      label: string
    }) => convexAdd(args),
    onError,
  })
  const archive = useMutation({
    mutationFn: (args: ByValue) => convexArchive(args),
    onError,
  })
  const restore = useMutation({
    mutationFn: (args: ByValue) => convexRestore(args),
    onError,
  })
  const usual = useMutation({
    mutationFn: (args: ByValue & { usual: boolean }) => convexUsual(args),
    onError,
  })
  const reorder = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      key: OptionSetKey
      values: Array<string>
    }) => convexReorder(args),
    onError,
  })
  const reset = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'>; key: OptionSetKey }) =>
      convexReset(args),
    onError,
  })

  const convexRename = useConvexMutation(api.optionSets.renameOption)
  const rename = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      key: OptionSetKey
      from: string
      to: string
    }) => convexRename(args),
    onSuccess: (result: { rewritten: number }) => {
      setRenaming(null)
      // The number matters: an owner renaming a product wants to know that
      // the half-finished reports out in vans were updated too.
      setNote(
        result.rewritten === 0
          ? 'Renamed.'
          : `Renamed, and updated ${result.rewritten} open ${
              result.rewritten === 1 ? 'draft' : 'drafts'
            }.`,
      )
    },
    onError: (failure: Error) => setError(messageFor(failure.message)),
  })

  const pinned = new Set(list.pinned)

  function move(index: number, by: -1 | 1) {
    const values = list.options.map((option) => option.value)
    const target = index + by
    if (target < 0 || target >= values.length) return
    ;[values[index], values[target]] = [values[target], values[index]]
    reorder.mutate({ businessId, key: list.key, values })
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={list.label}
      description="Reports already finalised keep the list they were signed with."
      footer={
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                if (draft.trim() === '') return
                add.mutate({ businessId, key: list.key, label: draft })
                setDraft('')
              }}
              aria-label={`Add to ${list.label}`}
              placeholder="Add an option"
              className="h-11 min-w-0 flex-1 rounded-xl bg-surface-3 px-3 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
            />
            <button
              type="button"
              disabled={draft.trim() === '' || add.isPending}
              onClick={() => {
                add.mutate({ businessId, key: list.key, label: draft })
                setDraft('')
              }}
              className="flex h-11 shrink-0 items-center gap-1.5 rounded-xl bg-ink px-4 text-[15px] font-semibold text-surface disabled:opacity-40"
            >
              <Plus size={15} strokeWidth={2.2} />
              Add
            </button>
          </div>
          {error && (
            <p role="alert" className="text-caption text-amber-ink">
              {error}
            </p>
          )}
          {note && !error && <p className="text-caption text-muted">{note}</p>}
        </div>
      }
    >
      <ul className="flex flex-col gap-1">
        {list.options.map((option, index) => (
          <li
            key={option.value}
            className="flex items-center gap-1.5 rounded-xl border border-hairline bg-surface px-2.5 py-2"
          >
            {renaming === option.value ? (
              <>
                <input
                  autoFocus
                  value={renameTo}
                  onChange={(event) => setRenameTo(event.target.value)}
                  aria-label={`Rename ${option.label}`}
                  className="h-9 min-w-0 flex-1 rounded-lg bg-surface-3 px-2.5 text-[15px] text-ink outline-none"
                />
                <button
                  type="button"
                  onClick={() =>
                    rename.mutate({
                      businessId,
                      key: list.key,
                      from: option.value,
                      to: renameTo,
                    })
                  }
                  className="shrink-0 rounded-lg bg-ink px-2.5 py-1.5 text-caption font-semibold text-surface"
                >
                  Save
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={pinned.has(option.value)}
                  onClick={() => {
                    setError(null)
                    setNote(null)
                    setRenaming(option.value)
                    setRenameTo(option.label)
                  }}
                  className="min-w-0 flex-1 truncate text-left text-body text-ink disabled:text-muted"
                >
                  {option.label}
                </button>

                <button
                  type="button"
                  aria-label={
                    option.usual
                      ? `${option.label} — one of the usual, remove`
                      : `${option.label} — mark as one of the usual`
                  }
                  aria-pressed={option.usual}
                  disabled={usual.isPending}
                  onClick={() =>
                    usual.mutate({
                      businessId,
                      key: list.key,
                      value: option.value,
                      usual: !option.usual,
                    })
                  }
                  className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${
                    option.usual ? 'text-amber-ink' : 'text-muted'
                  }`}
                >
                  <Star
                    size={15}
                    strokeWidth={2}
                    fill={option.usual ? 'currentColor' : 'none'}
                  />
                </button>

                <button
                  type="button"
                  aria-label={`Move ${option.label} up`}
                  disabled={index === 0 || reorder.isPending}
                  onClick={() => move(index, -1)}
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted disabled:opacity-30"
                >
                  <ArrowUp size={15} strokeWidth={2} />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${option.label} down`}
                  disabled={
                    index === list.options.length - 1 || reorder.isPending
                  }
                  onClick={() => move(index, 1)}
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted disabled:opacity-30"
                >
                  <ArrowDown size={15} strokeWidth={2} />
                </button>

                <button
                  type="button"
                  aria-label={`Stop offering ${option.label}`}
                  disabled={pinned.has(option.value)}
                  onClick={() => {
                    setError(null)
                    archive.mutate({
                      businessId,
                      key: list.key,
                      value: option.value,
                    })
                  }}
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted disabled:opacity-30"
                >
                  <Trash2 size={15} strokeWidth={1.9} />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>

      {/* Said once, where the consequence is: a technician with the draft open
          on their phone right now wins, and that is a deliberate choice rather
          than a locking scheme a one-technician draft does not need. */}
      <p className="mt-2 text-caption text-muted">
        Renaming an option updates open drafts too. A technician editing one
        right now keeps their version.
      </p>

      {list.archived.length > 0 && (
        <>
          <p className="section-label mt-4">No longer offered</p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {list.archived.map((option) => (
              <li
                key={option.value}
                className="flex items-center gap-2 rounded-xl border border-hairline bg-surface-2 px-2.5 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-body text-muted">
                  {option.label}
                </span>
                <button
                  type="button"
                  aria-label={`Offer ${option.label} again`}
                  onClick={() =>
                    restore.mutate({
                      businessId,
                      key: list.key,
                      value: option.value,
                    })
                  }
                  className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-caption font-semibold text-blue"
                >
                  <Check size={13} strokeWidth={2.4} />
                  Offer again
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {!list.isDefault && (
        <button
          type="button"
          onClick={() => {
            reset.mutate({ businessId, key: list.key })
            onClose()
          }}
          className="mt-4 flex items-center gap-1.5 text-caption font-semibold text-muted"
        >
          <RotateCcw size={13} strokeWidth={2.2} />
          Go back to the form&rsquo;s own list
        </button>
      )}
    </Sheet>
  )
}

/**
 * The refusals an owner can actually act on. Anything else keeps its code,
 * because a message invented for an unknown failure is a guess presented as
 * an explanation.
 */
function messageFor(raw: string): string {
  if (raw.includes('OPTION_PINNED')) {
    return 'The form itself refers to this one by name — renaming or removing it would change how the form behaves, not just what it offers.'
  }
  if (raw.includes('OPTION_EXISTS')) return 'That one is already on the list.'
  if (raw.includes('INVALID_OPTION'))
    return 'That is not something a form can offer.'
  if (raw.includes('TOO_MANY_OPTIONS'))
    return 'This list is as long as it can get.'
  if (raw.includes('LAST_OPTION')) return 'A list cannot be empty.'
  if (raw.includes('NO_ACCESS')) return 'Only an owner can change these.'
  return 'That did not work.'
}
