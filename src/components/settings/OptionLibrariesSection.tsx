import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
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
import { ListPending } from '#/components/shell/Pending'
import { rq } from '#/lib/routeQueries'
import { useHydrated } from '#/lib/useHydrated'
import { api } from '../../../convex/_generated/api'
import {
  DANGER_ROW_CLASS,
  DangerGroup,
  ROW_CLASS,
  RowBody,
  SettingsGroup,
} from './ui'
import type { OptionSetKey } from '#/lib/reportTemplates'
import type { Id } from '../../../convex/_generated/dataModel'
import {
  NEUTRAL_BUTTON_COMPACT,
  PRIMARY_BUTTON_COMPACT,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'
import { FIELD_COMPACT } from '#/components/forms/FormField'
import { LoadFailed } from '#/components/primitives/EmptyState'

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
  const hydrated = useHydrated()
  const listsQuery = useQuery(rq.answerLists(businessId))
  const lists = listsQuery.data
  const [open, setOpen] = useState<OptionSetKey | null>(null)
  const editing = lists?.find((list) => list.key === open)

  return (
    <>
      {lists === undefined && listsQuery.isError ? (
        <LoadFailed
          what="the answer lists"
          onRetry={() => void listsQuery.refetch()}
        />
      ) : lists === undefined ? (
        <ListPending label="Loading answer lists" count={3} />
      ) : (
        <SettingsGroup footer="Changing a list changes every form that uses it. Finalised reports keep theirs.">
          {lists.map((list) => (
            <button
              key={list.key}
              type="button"
              // A sheet that opens only once React is listening: before
              // hydration the tap would do nothing, silently.
              disabled={!hydrated}
              onClick={() => setOpen(list.key)}
              className={ROW_CLASS}
            >
              <RowBody
                title={list.label}
                subtitle={
                  <>
                    {list.options.length}{' '}
                    {list.options.length === 1 ? 'option' : 'options'}
                    {/* Worth saying: an untouched list is still exactly what
                        the form ships with, and a correction to it will
                        arrive. */}
                    {list.isDefault ? ' · the form’s own' : ' · yours'}
                  </>
                }
                chevron
              />
            </button>
          ))}
        </SettingsGroup>
      )}

      {editing && (
        <OptionListSheet
          // A fresh sheet for each list, so a rename half-typed in one is
          // not waiting in the next.
          key={editing.key}
          businessId={businessId}
          list={editing}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  )
}

/** The square buttons on an option's row: 44px, the smallest a gloved
 * thumb lands on, with no room between them for a smaller hit area to grow. */
const ICON_BUTTON =
  'flex size-11 shrink-0 items-center justify-center rounded-lg transition active:bg-surface-2 disabled:opacity-30'

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
  const [confirmingReset, setConfirmingReset] = useState(false)
  const hydrated = useHydrated()

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
    // Closed once it has happened, not as it is asked for: closing first
    // left a refusal with nowhere to be said.
    onSuccess: onClose,
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

  function addDraft() {
    if (draft.trim() === '') return
    add.mutate({ businessId, key: list.key, label: draft })
    setDraft('')
  }

  function submitRename(from: string) {
    rename.mutate({ businessId, key: list.key, from, to: renameTo })
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
                addDraft()
              }}
              aria-label={`Add to ${list.label}`}
              placeholder="Add an option"
              className={`${FIELD_COMPACT} min-w-0 flex-1`}
            />
            <button
              type="button"
              disabled={draft.trim() === '' || add.isPending}
              onClick={addDraft}
              className={`${NEUTRAL_BUTTON_COMPACT} flex shrink-0 items-center gap-1.5 px-4`}
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
      {/* Said once, where the consequence is: a technician with the draft
          open on their phone right now wins, and that is a deliberate choice
          rather than a locking scheme a one-technician draft does not need. */}
      <SettingsGroup footer="Renaming updates open drafts too, except one a technician is editing right now.">
        <ul className="divide-y divide-hairline">
          {list.options.map((option, index) => (
            <li
              key={option.value}
              className="flex min-h-[52px] items-center gap-1 py-1.5 pl-3.5 pr-1.5"
            >
              {renaming === option.value ? (
                <>
                  <input
                    autoFocus
                    value={renameTo}
                    onChange={(event) => setRenameTo(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return
                      event.preventDefault()
                      submitRename(option.value)
                    }}
                    aria-label={`Rename ${option.label}`}
                    className={`${FIELD_COMPACT} min-w-0 flex-1`}
                  />
                  <button
                    type="button"
                    disabled={rename.isPending}
                    onClick={() => submitRename(option.value)}
                    className={`${NEUTRAL_BUTTON_COMPACT} shrink-0 px-3.5`}
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
                    className="min-w-0 flex-1 truncate py-1.5 text-left text-body text-ink disabled:text-muted"
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
                    className={`${ICON_BUTTON} ${
                      option.usual ? 'text-amber-ink' : 'text-muted'
                    }`}
                  >
                    <Star
                      size={16}
                      strokeWidth={2}
                      fill={option.usual ? 'currentColor' : 'none'}
                    />
                  </button>

                  <button
                    type="button"
                    aria-label={`Move ${option.label} up`}
                    disabled={index === 0 || reorder.isPending}
                    onClick={() => move(index, -1)}
                    className={`${ICON_BUTTON} text-muted`}
                  >
                    <ArrowUp size={16} strokeWidth={2} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${option.label} down`}
                    disabled={
                      index === list.options.length - 1 || reorder.isPending
                    }
                    onClick={() => move(index, 1)}
                    className={`${ICON_BUTTON} text-muted`}
                  >
                    <ArrowDown size={16} strokeWidth={2} />
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
                    className={`${ICON_BUTTON} text-muted`}
                  >
                    <Trash2 size={16} strokeWidth={2} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </SettingsGroup>

      {list.archived.length > 0 && (
        <SettingsGroup title="No longer offered">
          <ul className="divide-y divide-hairline">
            {list.archived.map((option) => (
              <li
                key={option.value}
                className="flex min-h-[52px] items-center gap-2 py-1.5 pl-3.5 pr-2"
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
                  className="flex min-h-9 shrink-0 items-center gap-1 rounded-lg px-2 text-caption font-semibold text-blue"
                >
                  <Check size={13} strokeWidth={2.2} />
                  Offer again
                </button>
              </li>
            ))}
          </ul>
        </SettingsGroup>
      )}

      {/* Last, and asked twice: it throws away everything this business has
          done to the list — additions, renames, stars, the order, what it
          stopped offering — and there is no undo. */}
      {!list.isDefault && (
        <DangerGroup>
          {confirmingReset ? (
            <div className="px-3.5 py-3">
              <p className="text-body text-ink">
                Go back to the form&rsquo;s own list?
              </p>
              <p className="mt-0.5 text-caption text-muted">
                Everything you&rsquo;ve added, renamed, starred, reordered or
                stopped offering here is undone.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmingReset(false)}
                  className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
                >
                  Keep my list
                </button>
                <button
                  type="button"
                  disabled={reset.isPending}
                  onClick={() => {
                    setError(null)
                    reset.mutate({ businessId, key: list.key })
                  }}
                  className={`${PRIMARY_BUTTON_COMPACT} flex-1`}
                >
                  {reset.isPending ? 'Resetting…' : 'Reset list'}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={!hydrated}
              onClick={() => setConfirmingReset(true)}
              className={`${DANGER_ROW_CLASS} gap-1.5`}
            >
              <RotateCcw size={15} strokeWidth={2} />
              Go back to the form&rsquo;s own list
            </button>
          )}
        </DangerGroup>
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
