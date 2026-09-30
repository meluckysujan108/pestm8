import { useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { Check, Plus, RotateCcw } from 'lucide-react'
import { Sheet, SheetLock } from '#/components/primitives/Sheet'
import { LoadFailed } from '#/components/primitives/EmptyState'
import {
  PRIMARY_BUTTON_COMPACT,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'
import { FormField } from '#/components/forms/FormField'
import { FormAlert } from '#/components/forms/FormAlert'
import { describeError } from '#/components/forms/describeError'
import { ListPending } from '#/components/shell/Pending'
import { CREATABLE_TEMPLATES } from '#/lib/reportTemplates'
import { suggestTemplate } from '#/lib/reportTemplates/suggest'
import { rq } from '#/lib/routeQueries'
import { useHydrated } from '#/lib/useHydrated'
import { api } from '../../../convex/_generated/api'
import {
  JOB_TYPE_REPORTS,
  MAX_JOBS_COUNTED,
  MAX_JOB_TYPE_LENGTH,
  jobTypeKey,
  jobTypeNameProblem,
  tidyJobTypeName,
} from '../../../convex/lib/jobTypes'
import { ConfirmDialog } from './ConfirmDialog'
import {
  DANGER_ROW_CLASS,
  DangerGroup,
  ROW_CLASS,
  RowBody,
  SettingsGroup,
} from './ui'
import type { ErrorCopy } from '#/components/forms/describeError'
import type { FunctionReturnType } from 'convex/server'
import type { JobTypeReport } from '../../../convex/lib/jobTypes'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * Settings → Job types: the services New Job offers, the owner's own list
 * (`convex/jobTypes.ts`).
 *
 * The list, A–Z, each with its report and how many jobs carry it; then the
 * services typed into jobs that the list does not have, to swap or add; then
 * the ones deleted, each with "Offer again". Every change is made in a sheet,
 * and the sheet says what it will touch before it is saved.
 */

type Manage = FunctionReturnType<typeof api.jobTypes.manage>
type TypeRow = Manage['types'][number]
type TypedIn = Manage['typedIn'][number]

/**
 * The sheet open, with the row as it was when it was opened: found again by
 * its key while it is still there (so its counts stay live), and shown as it
 * was once it is not — renamed or merged by this save, or by another device —
 * so the sheet closes as a sheet rather than vanishing mid-sentence.
 */
type Open =
  | { kind: 'edit'; row: TypeRow }
  | { kind: 'new'; from?: TypedIn }
  | { kind: 'typed'; row: TypedIn }
  | null

/**
 * The words for a refusal an owner can act on (`describeError`), for the
 * thing that was being done: "save", "delete it", "swap it", "offer it again".
 */
function copyFor(what: string): ErrorCopy {
  return {
    JOB_TYPE_EXISTS: `Could not ${what}: that name is already on your list. Choose another name.`,
    JOB_TYPE_EMPTY: `Could not ${what}: give it a name.`,
    JOB_TYPE_TOO_LONG: `Could not ${what}: keep the name to ${MAX_JOB_TYPE_LENGTH} characters.`,
    JOB_TYPE_COMMA: `Could not ${what}: a comma separates services, so a name can’t have one. Add each service on its own.`,
    JOB_TYPE_ON_LIST: `Could not ${what}: that one is on your list now. Close this and look again.`,
    JOB_TYPE_BUSY: `Could not ${what} yet: jobs are still being updated from your last change. Try again in a minute.`,
    TOO_MANY_JOB_TYPES: `Could not ${what}: your list is as long as it can get. Delete one you don’t use first.`,
    JOB_TYPE_NOT_FOUND: `Could not ${what}: this job type was changed on another device. Look at the list again, then try again.`,
    LAST_JOB_TYPE: `Could not ${what}: New Job needs at least one job type. Add another first.`,
    NO_ACCESS: `Could not ${what}: only the business owner can change job types.`,
    default: `Could not ${what}. Check your signal and try again.`,
  }
}

const NAME_PROBLEM: Record<
  NonNullable<ReturnType<typeof jobTypeNameProblem>>,
  string
> = {
  JOB_TYPE_EMPTY: 'Give it a name.',
  JOB_TYPE_TOO_LONG: `Keep it to ${MAX_JOB_TYPE_LENGTH} characters.`,
  JOB_TYPE_COMMA:
    'A comma separates services, so a name can’t have one. Add each service on its own.',
}

/** A form's name as the list shows it. */
function reportName(report: JobTypeReport): string {
  if (report === 'none') return 'No report'
  return CREATABLE_TEMPLATES.find((t) => t.id === report)?.name ?? 'No report'
}

/** The forms a service can produce, as offered here: those still startable. */
const REPORT_CHOICES = JOB_TYPE_REPORTS.filter(
  (report) =>
    report === 'none' || CREATABLE_TEMPLATES.some((t) => t.id === report),
)

/** A new service's form, guessed from its name until the owner picks one. */
function guessedReport(name: string): JobTypeReport {
  const guess = suggestTemplate(name)
  return guess && (REPORT_CHOICES as ReadonlyArray<string>).includes(guess)
    ? (guess as JobTypeReport)
    : 'none'
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`

/** "38 jobs and 2 repeating services", "1 job", "no jobs". */
function onWhat({ jobs, series }: { jobs: number; series: number }): string {
  const parts = [
    ...(jobs > 0 ? [plural(jobs, 'job', 'jobs')] : []),
    ...(series > 0
      ? [plural(series, 'repeating service', 'repeating services')]
      : []),
  ]
  return parts.length > 0 ? parts.join(' and ') : 'no jobs'
}

const capitalised = (text: string) => text.replace(/^./, (c) => c.toUpperCase())

export function JobTypesSection({
  businessId,
}: {
  businessId: Id<'businesses'>
}) {
  const hydrated = useHydrated()
  const query = useQuery(rq.jobTypesManage(businessId))
  const data = query.data
  const [open, setOpen] = useState<Open>(null)
  // The row that opened a sheet, for focus to go back to when it shuts.
  const opener = useRef<HTMLElement | null>(null)

  const convexRestore = useConvexMutation(api.jobTypes.restore)
  const restore = useMutation({
    mutationFn: (name: string) => convexRestore({ businessId, name }),
  })

  if (data === undefined) {
    return query.isError ? (
      <LoadFailed what="your job types" onRetry={() => void query.refetch()} />
    ) : (
      <ListPending label="Loading job types" count={6} />
    )
  }

  const offered = data.types.filter((type) => type.offered)
  const deleted = data.types.filter((type) => !type.offered)
  const editing =
    open?.kind === 'edit'
      ? (data.types.find(
          (type) => jobTypeKey(type.name) === jobTypeKey(open.row.name),
        ) ?? open.row)
      : undefined
  const typed =
    open?.kind === 'typed'
      ? (data.typedIn.find(
          (entry) => jobTypeKey(entry.name) === jobTypeKey(open.row.name),
        ) ?? open.row)
      : undefined
  const close = () => setOpen(null)

  return (
    <>
      <SettingsGroup
        title="Offered on new jobs"
        footer={
          <>
            New Job lists these A–Z. Tap one to rename it, change its report or
            delete it.
            {!data.complete &&
              ` Counts stop at ${MAX_JOBS_COUNTED.toLocaleString('en-AU')} jobs.`}
          </>
        }
      >
        {offered.map((type) => (
          <button
            key={type.name}
            type="button"
            // A sheet that opens only once React is listening.
            disabled={!hydrated}
            onClick={(event) => {
              opener.current = event.currentTarget
              setOpen({ kind: 'edit', row: type })
            }}
            className={ROW_CLASS}
          >
            <RowBody
              title={type.name}
              subtitle={reportName(type.report)}
              value={
                type.jobs > 0
                  ? plural(type.jobs, 'job', 'jobs')
                  : type.series > 0
                    ? 'Repeating'
                    : 'Not used yet'
              }
              chevron
            />
          </button>
        ))}
        <button
          type="button"
          disabled={!hydrated}
          onClick={(event) => {
            opener.current = event.currentTarget
            setOpen({ kind: 'new' })
          }}
          className={`${ROW_CLASS} font-medium text-blue`}
        >
          <Plus aria-hidden size={18} strokeWidth={2} className="shrink-0" />
          <span className="text-body">Add a job type</span>
        </button>
      </SettingsGroup>

      {data.typedIn.length > 0 && (
        <SettingsGroup
          title={`Typed into jobs · ${data.typedIn.length}`}
          footer="Typed into a job rather than picked from your list. Add one to your list, or swap it for types you have — or leave it be."
        >
          {data.typedIn.map((entry) => (
            <button
              key={entry.name}
              type="button"
              disabled={!hydrated}
              onClick={(event) => {
                opener.current = event.currentTarget
                setOpen({ kind: 'typed', row: entry })
              }}
              className={ROW_CLASS}
            >
              <RowBody
                title={entry.name}
                subtitle={capitalised(onWhat(entry))}
                chevron
              />
            </button>
          ))}
        </SettingsGroup>
      )}

      {deleted.length > 0 && (
        <SettingsGroup
          title="No longer offered"
          footer={
            restore.isError ? (
              <span role="alert" className="text-amber-ink">
                {describeError(restore.error, copyFor('offer it again'))}
              </span>
            ) : (
              'Jobs booked with these keep them.'
            )
          }
        >
          {deleted.map((type) => (
            <div
              key={type.name}
              className="flex min-h-[52px] items-center gap-2 py-1.5 pl-3.5 pr-2"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body text-muted">
                  {type.name}
                </span>
                <span className="block truncate text-caption text-muted">
                  {type.jobs > 0 || type.series > 0
                    ? `On ${onWhat(type)}`
                    : 'Not used yet'}
                </span>
              </span>
              <button
                type="button"
                disabled={!hydrated || restore.isPending}
                onClick={() => restore.mutate(type.name)}
                className="relative tap-target flex min-h-9 shrink-0 items-center gap-1 rounded-lg px-2 text-caption font-semibold text-blue disabled:opacity-50"
              >
                <RotateCcw aria-hidden size={13} strokeWidth={2.2} />
                {restore.isPending && restore.variables === type.name
                  ? 'Offering…'
                  : 'Offer again'}
                <span className="sr-only"> {type.name}</span>
              </button>
            </div>
          ))}
        </SettingsGroup>
      )}

      {(open?.kind === 'new' || editing) && (
        <JobTypeSheet
          // A fresh form for each, so a name half-typed for one is not
          // waiting in the next.
          key={
            open?.kind === 'edit'
              ? `edit:${jobTypeKey(open.row.name)}`
              : `new:${open?.kind === 'new' ? (open.from?.name ?? '') : ''}`
          }
          businessId={businessId}
          editing={editing}
          from={open?.kind === 'new' ? open.from : undefined}
          types={data.types}
          offeredCount={offered.length}
          returnFocusRef={opener}
          onClose={close}
        />
      )}

      {typed && (
        <TypedInSheet
          key={jobTypeKey(typed.name)}
          businessId={businessId}
          typed={typed}
          offered={offered}
          returnFocusRef={opener}
          onAdd={() => setOpen({ kind: 'new', from: typed })}
          onClose={close}
        />
      )}
    </>
  )
}

/** Add a service, or rename one, change its report or delete it. */
function JobTypeSheet({
  businessId,
  editing,
  from,
  types,
  offeredCount,
  returnFocusRef,
  onClose,
}: {
  businessId: Id<'businesses'>
  /** The service being edited; absent to add one. */
  editing?: TypeRow
  /** A service typed into jobs, being put on the list. */
  from?: TypedIn
  types: ReadonlyArray<TypeRow>
  offeredCount: number
  returnFocusRef: RefObject<HTMLElement | null>
  onClose: () => void
}) {
  const hydrated = useHydrated()
  const nameRef = useRef<HTMLInputElement>(null)
  const openedName = editing?.name ?? from?.name ?? ''
  const [name, setName] = useState(openedName)
  const [report, setReport] = useState<JobTypeReport>(
    editing?.report ?? guessedReport(openedName),
  )
  const [reportPicked, setReportPicked] = useState(editing !== undefined)
  const [nameError, setNameError] = useState<string | null>(null)
  const [merging, setMerging] = useState<TypeRow | null>(null)
  const [deleting, setDeleting] = useState(false)

  // No close on the mutations themselves: a save that lands after this sheet
  // has gone must not close whichever sheet is open by then. Each call closes
  // this one, and only while it is still here.
  const convexCreate = useConvexMutation(api.jobTypes.create)
  const convexUpdate = useConvexMutation(api.jobTypes.update)
  const convexRemove = useConvexMutation(api.jobTypes.remove)
  const create = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      name: string
      report: JobTypeReport
      from?: string
    }) => convexCreate(args),
  })
  const update = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      name: string
      newName?: string
      report?: JobTypeReport
      merge?: boolean
    }) => convexUpdate(args),
  })
  const remove = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'>; name: string }) =>
      convexRemove(args),
  })

  const tidy = tidyJobTypeName(name)
  const renamed = editing !== undefined && tidy !== editing.name
  const changed = editing
    ? renamed || report !== editing.report
    : from
      ? tidy !== from.name || reportPicked
      : tidy !== ''
  const saving = create.isPending || update.isPending || remove.isPending
  const failed = create.error ?? (merging ? null : update.error)
  const used = editing ? editing.jobs + editing.series > 0 : false
  const lastOne = offeredCount <= 1 && editing?.offered === true

  function changeName(next: string) {
    setName(next)
    setNameError(null)
    // Until the owner picks a form, a new service's follows its name:
    // "Termite Barrier Top-Up" is a certificate.
    if (!reportPicked) setReport(guessedReport(next))
  }

  function save() {
    const problem = jobTypeNameProblem(name)
    if (problem) {
      setNameError(NAME_PROBLEM[problem])
      nameRef.current?.focus()
      return
    }
    const key = jobTypeKey(tidy)
    const clash = types.find(
      (type) =>
        jobTypeKey(type.name) === key &&
        (!editing || jobTypeKey(editing.name) !== key),
    )
    if (editing) {
      // Onto a name the list already has: two services become one, asked first.
      if (clash) {
        update.reset()
        setMerging(clash)
        return
      }
      update.mutate(
        {
          businessId,
          name: editing.name,
          ...(renamed && { newName: tidy }),
          ...(report !== editing.report && { report }),
        },
        { onSuccess: onClose },
      )
      return
    }
    if (clash?.offered) {
      setNameError(`${clash.name} is already on your list.`)
      nameRef.current?.focus()
      return
    }
    // A name deleted earlier comes back rather than being added twice.
    create.mutate(
      {
        businessId,
        name: tidy,
        report,
        ...(from && { from: from.name }),
      },
      { onSuccess: onClose },
    )
  }

  const renameHint =
    editing && renamed && used
      ? `Renaming changes it everywhere it’s used: ${onWhat(editing)}. Finalised reports keep the name they were signed with.`
      : undefined

  return (
    <Sheet
      open
      // Not while a save is on its way: closing then would say nothing was
      // saved, and the save would land anyway.
      onClose={() => {
        if (!saving) onClose()
      }}
      returnFocusRef={returnFocusRef}
      title={editing ? editing.name : 'New job type'}
      description={
        editing
          ? used
            ? `On ${onWhat(editing)}.`
            : 'Not on any job yet.'
          : from
            ? `Typed into ${onWhat(from)}. Adding it puts them all under the name you give it here.`
            : undefined
      }
      footer={
        <div className="flex flex-col gap-2">
          {failed && (
            <FormAlert
              error={failed}
              copy={copyFor(editing ? 'save' : 'add it')}
            />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!hydrated || saving || !changed}
              className={`${PRIMARY_BUTTON_COMPACT} flex-1`}
            >
              {editing
                ? update.isPending
                  ? 'Saving…'
                  : 'Save'
                : create.isPending
                  ? 'Adding…'
                  : 'Add job type'}
            </button>
          </div>
        </div>
      }
    >
      <SheetLock changed={changed} whileUnchanged={editing !== undefined} />
      <form
        className="pt-3"
        onSubmit={(event) => {
          event.preventDefault()
          save()
        }}
      >
        <FormField
          id="job-type-name"
          label="Name"
          error={nameError ?? undefined}
          hint={
            renameHint ??
            (editing
              ? undefined
              : 'One service. A job with several ticks each one.')
          }
        >
          {(control) => (
            <input
              {...control}
              ref={nameRef}
              value={name}
              onChange={(event) => changeName(event.target.value)}
              autoCapitalize="words"
              autoComplete="off"
              enterKeyHint="done"
              maxLength={MAX_JOB_TYPE_LENGTH + 20}
            />
          )}
        </FormField>
      </form>

      <SettingsGroup
        title="Report"
        footer="The form a job of this type suggests. With “Require a finalised report” on, a job whose types have a form waits for a finalised report before it can be completed; No report never holds one up."
      >
        <div
          role="radiogroup"
          aria-label="Report"
          className="divide-y divide-hairline"
        >
          {REPORT_CHOICES.map((choice) => (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={choice === report}
              disabled={saving}
              onClick={() => {
                setReport(choice)
                setReportPicked(true)
              }}
              className={ROW_CLASS}
            >
              <span className="min-w-0 flex-1 text-body text-ink">
                {reportName(choice)}
              </span>
              {choice === report && (
                <Check
                  aria-hidden
                  size={18}
                  strokeWidth={2}
                  className="shrink-0 text-blue"
                />
              )}
            </button>
          ))}
        </div>
      </SettingsGroup>

      {/* Not for the only one New Job offers: it has nothing left to offer
          without it, and the server refuses (LAST_JOB_TYPE). */}
      {editing && !lastOne && (
        <DangerGroup>
          <button
            type="button"
            disabled={!hydrated || saving}
            onClick={() => setDeleting(true)}
            className={DANGER_ROW_CLASS}
          >
            Delete job type
          </button>
        </DangerGroup>
      )}

      {editing && (
        <ConfirmDialog
          open={deleting}
          onOpenChange={(next) => {
            setDeleting(next)
            if (!next) remove.reset()
          }}
          title={`Delete ${editing.name}?`}
          body={deleteBody(editing)}
          cancel={`Keep ${editing.name}`}
          confirm="Delete"
          pending={remove.isPending}
          pendingLabel="Deleting…"
          closeOnConfirm={false}
          error={
            remove.isError
              ? describeError(remove.error, copyFor('delete it'))
              : undefined
          }
          onConfirm={() =>
            remove.mutate(
              { businessId, name: editing.name },
              { onSuccess: onClose },
            )
          }
        />
      )}

      {editing && merging && (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) {
              setMerging(null)
              update.reset()
            }
          }}
          title={`Merge into ${merging.name}?`}
          body={mergeBody(editing, merging, report)}
          cancel="Keep both"
          confirm="Merge"
          pending={update.isPending}
          pendingLabel="Merging…"
          closeOnConfirm={false}
          error={
            update.isError
              ? describeError(update.error, copyFor('merge them'))
              : undefined
          }
          onConfirm={() =>
            update.mutate(
              { businessId, name: editing.name, newName: tidy, merge: true },
              { onSuccess: onClose },
            )
          }
        />
      )}
    </Sheet>
  )
}

function deleteBody(type: TypeRow): string {
  const back = 'you can offer it again from this page.'
  if (type.jobs === 0 && type.series === 0) {
    return `It’s on no jobs yet. New Job stops offering it, and ${back}`
  }
  const jobs =
    type.jobs > 0
      ? ` ${type.jobs === 1 ? 'The job' : `The ${type.jobs} jobs`} booked as ${type.name} keep it.`
      : ''
  const series =
    type.series > 0
      ? ` ${type.series === 1 ? 'Its repeating service keeps' : `Its ${type.series} repeating services keep`} booking visits with it.`
      : ''
  return `New Job stops offering it.${jobs}${series} You can offer it again from this page.`
}

function mergeBody(
  from: TypeRow,
  into: TypeRow,
  report: JobTypeReport,
): string {
  const back = into.offered ? '' : ' It’s offered again.'
  const keeps =
    report !== into.report
      ? ` It keeps its own report, ${reportName(into.report)}.`
      : ''
  return `You already have ${into.name}. Every job and repeating service that says ${from.name} will say ${into.name}, and ${from.name} leaves your list.${back}${keeps}`
}

/** A service typed into jobs: swap it for services on the list, or add it. */
function TypedInSheet({
  businessId,
  typed,
  offered,
  returnFocusRef,
  onAdd,
  onClose,
}: {
  businessId: Id<'businesses'>
  typed: TypedIn
  offered: ReadonlyArray<TypeRow>
  returnFocusRef: RefObject<HTMLElement | null>
  onAdd: () => void
  onClose: () => void
}) {
  const hydrated = useHydrated()
  const [ticked, setTicked] = useState<Array<string>>([])
  const convexSwap = useConvexMutation(api.jobTypes.swap)
  const swap = useMutation({
    mutationFn: (to: Array<string>) =>
      convexSwap({ businessId, from: typed.name, to }),
  })

  // In the list's order, whatever order they were ticked in.
  const chosen = offered
    .map((type) => type.name)
    .filter((name) => ticked.includes(name))

  return (
    <Sheet
      open
      onClose={() => {
        if (!swap.isPending) onClose()
      }}
      returnFocusRef={returnFocusRef}
      title={typed.name}
      description={`Typed into ${onWhat(typed)}. It isn’t on your list.`}
      footer={
        <div className="flex flex-col gap-2">
          {swap.isError && (
            <FormAlert error={swap.error} copy={copyFor('swap it')} />
          )}
          <button
            type="button"
            disabled={!hydrated || swap.isPending || chosen.length === 0}
            onClick={() => swap.mutate(chosen, { onSuccess: onClose })}
            className={`${PRIMARY_BUTTON_COMPACT} w-full`}
          >
            {swap.isPending
              ? 'Swapping…'
              : chosen.length === 0
                ? 'Tick what it should be'
                : chosen.length === 1
                  ? `Swap for ${chosen[0]}`
                  : `Swap for these ${chosen.length}`}
          </button>
          <button
            type="button"
            disabled={!hydrated || swap.isPending}
            onClick={onAdd}
            className={`${SECONDARY_BUTTON_COMPACT} w-full`}
          >
            Add it to my list instead
          </button>
        </div>
      }
    >
      <SheetLock changed={ticked.length > 0} whileUnchanged={false} />
      <div className="pt-3">
        <SettingsGroup
          title="Swap it for"
          footer={`Every job and repeating service that says ${typed.name} will list ${chosen.length > 1 ? 'these' : 'this'} instead.`}
        >
          {offered.map((type) => {
            const on = ticked.includes(type.name)
            return (
              <button
                key={type.name}
                type="button"
                role="checkbox"
                aria-checked={on}
                disabled={swap.isPending}
                onClick={() =>
                  setTicked((current) =>
                    on
                      ? current.filter((name) => name !== type.name)
                      : [...current, type.name],
                  )
                }
                className={ROW_CLASS}
              >
                <span className="min-w-0 flex-1 text-body text-ink">
                  {type.name}
                </span>
                {on && (
                  <Check
                    aria-hidden
                    size={18}
                    strokeWidth={2}
                    className="shrink-0 text-blue"
                  />
                )}
              </button>
            )
          })}
        </SettingsGroup>
      </div>
    </Sheet>
  )
}
