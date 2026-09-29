import { useState } from 'react'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import {
  CalendarDays,
  Contact,
  MapPin,
  Repeat,
  RotateCcw,
  Trash2,
  User,
} from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { EmptyState } from '#/components/primitives/EmptyState'
import { SECONDARY_BUTTON_COMPACT } from '#/components/primitives/buttons'
import { FormAlert } from '#/components/forms/FormAlert'
import { describeError } from '#/components/forms/describeError'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'
import {
  DANGER_ROW_CLASS,
  DangerGroup,
  IconTile,
  SettingsGroup,
} from '#/components/settings/ui'
import { formatJobDate, formatWhen, todayKey } from '#/lib/format'
import { useHydrated } from '#/lib/useHydrated'
import { dayKeyOf } from '../../../convex/lib/dates'
import { describeInterval } from '../../../convex/lib/recurrence'
import type { FunctionReturnType } from 'convex/server'
import type { LucideIcon } from 'lucide-react'
import type { ErrorCopy } from '#/components/forms/describeError'
import type { Id } from '../../../convex/_generated/dataModel'

type Entry = FunctionReturnType<typeof api.bin.list>['entries'][number]

/**
 * What is in the Recycle bin, each delete with its Restore and Delete now,
 * and Empty bin under them (convex/bin.ts) — Settings → Recycle bin's list,
 * the owner's.
 */
export function RecycleBinList({
  businessId,
  timezone,
}: {
  businessId: Id<'businesses'>
  timezone: string
}) {
  const { data } = useSuspenseQuery(convexQuery(api.bin.list, { businessId }))

  if (data.entries.length === 0) {
    return (
      <EmptyState
        title="Nothing deleted"
        body="Clients, properties, jobs and recurring services you delete wait here for 30 days, then are deleted for good."
      />
    )
  }

  return (
    <>
      <SettingsGroup
        footer={
          <>
            Each is deleted for good 30 days after it was deleted. Restoring
            brings back everything that was deleted with it. Finalised reports
            are never deleted, and stay in Reports.
            {data.capped && ' Showing the most recent 200.'}
          </>
        }
      >
        {data.entries.map((entry) => (
          <BinRow
            key={entry._id}
            businessId={businessId}
            timezone={timezone}
            entry={entry}
          />
        ))}
      </SettingsGroup>
      <p className="mt-6 px-1 text-caption text-muted">
        Report drafts and notes deleted on their own are kept in Reports →
        Deleted and Notes → Recently deleted.
      </p>
      <EmptyBin businessId={businessId} count={data.entries.length} />
    </>
  )
}

function EmptyBin({
  businessId,
  count,
}: {
  businessId: Id<'businesses'>
  count: number
}) {
  const hydrated = useHydrated()
  const [confirming, setConfirming] = useState(false)
  const convexEmpty = useConvexMutation(api.bin.empty)
  const empty = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'> }) => convexEmpty(args),
    onSuccess: () => setConfirming(false),
  })

  return (
    <>
      <DangerGroup>
        <button
          type="button"
          disabled={!hydrated}
          onClick={() => {
            empty.reset()
            setConfirming(true)
          }}
          className={DANGER_ROW_CLASS}
        >
          Empty Recycle bin
        </button>
      </DangerGroup>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Empty the Recycle bin?"
        body={`${count === 1 ? 'The 1 thing' : `All ${count} things`} in it, and everything deleted with them, are gone for good. This can’t be undone. Finalised reports are kept in Reports.`}
        cancel="Keep them"
        confirm="Empty bin"
        closeOnConfirm={false}
        pending={empty.isPending}
        pendingLabel="Emptying…"
        error={
          empty.isError
            ? describeError(empty.error, wipeCopy('empty the Recycle bin'))
            : null
        }
        onConfirm={() => empty.mutate({ businessId })}
      />
    </>
  )
}

const ICON: Record<Entry['kind'], LucideIcon> = {
  client: User,
  property: MapPin,
  job: CalendarDays,
  recurrence: Repeat,
  contact: Contact,
}

const KIND_LABEL: Record<Entry['kind'], string> = {
  client: 'Client',
  property: 'Property',
  job: 'Job',
  recurrence: 'Recurring service',
  contact: 'Contact',
}

function BinRow({
  businessId,
  timezone,
  entry,
}: {
  businessId: Id<'businesses'>
  timezone: string
  entry: Entry
}) {
  const hydrated = useHydrated()
  const convexRestore = useConvexMutation(api.bin.restore)
  const restore = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      entryId: Id<'binEntries'>
    }) => convexRestore(args),
  })

  const [confirming, setConfirming] = useState(false)
  const convexWipe = useConvexMutation(api.bin.wipe)
  const wipe = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      entryId: Id<'binEntries'>
    }) => convexWipe(args),
    onSuccess: () => setConfirming(false),
  })

  // A client archived before the bin existed has no one who deleted it —
  // only when it was archived (migrations/archivedClientsToBinV1).
  const deleted =
    entry.archivedAt !== null && !entry.deletedBy
      ? `Archived ${formatWhen(entry.archivedAt, timezone)}`
      : entry.deletedBy
        ? `Deleted ${formatWhen(entry.deletedAt, timezone)} by ${entry.deletedBy}`
        : `Deleted ${formatWhen(entry.deletedAt, timezone)}`
  const wipes = formatJobDate(
    dayKeyOf(entry.wipesAt, timezone),
    todayKey(timezone),
  )
  const withIt = withWhat(entry.counts)

  return (
    <div className="px-3.5 py-3">
      <div className="flex items-start gap-3">
        <IconTile icon={ICON[entry.kind]} tint="grey" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-body text-ink">{entry.title}</p>
          <p className="text-caption text-muted">{describe(entry, timezone)}</p>
          <p className="text-caption text-muted">{deleted}</p>
          <p className="text-caption text-muted">Deleted for good on {wipes}</p>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={!hydrated || restore.isPending}
          onClick={() => restore.mutate({ businessId, entryId: entry._id })}
          className={`${SECONDARY_BUTTON_COMPACT} flex flex-1 items-center justify-center gap-1.5`}
        >
          <RotateCcw aria-hidden size={15} strokeWidth={2} />
          {restore.isPending ? 'Restoring…' : 'Restore'}
        </button>
        <button
          type="button"
          disabled={!hydrated}
          onClick={() => {
            wipe.reset()
            setConfirming(true)
          }}
          // A grey button with its word in red, as Reports → Deleted draws
          // its Delete now: SECONDARY_BUTTON_COMPACT's shape, which cannot
          // take a second text colour.
          className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-fill-secondary text-body font-semibold text-red outline-none transition focus-visible:ring-2 focus-visible:ring-blue active:scale-[.975] disabled:opacity-50"
        >
          <Trash2 aria-hidden size={15} strokeWidth={2} />
          Delete now
        </button>
      </div>
      <FormAlert
        className="mt-2"
        error={restore.isError ? restore.error : null}
        copy={RESTORE_COPY}
      />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${entry.title} for good?`}
        body={`${withIt ? `It and the ${withIt} deleted with it are` : 'It is'} gone for good. This can’t be undone. Finalised reports are kept in Reports.`}
        cancel="Keep it"
        confirm="Delete for good"
        closeOnConfirm={false}
        pending={wipe.isPending}
        pendingLabel="Deleting…"
        error={
          wipe.isError
            ? describeError(wipe.error, wipeCopy('delete this for good'))
            : null
        }
        onConfirm={() => wipe.mutate({ businessId, entryId: entry._id })}
      />
    </div>
  )
}

/** "Job · Bayswater · Fri 25 Sept · with 1 note", what the row stands for. */
function describe(entry: Entry, timezone: string): string {
  const parts: Array<string> = [KIND_LABEL[entry.kind]]
  switch (entry.kind) {
    case 'property':
      if (entry.suburb) parts.push(entry.suburb)
      if (entry.clientName) parts.push(entry.clientName)
      break
    case 'job':
      if (entry.suburb) parts.push(entry.suburb)
      parts.push(
        formatJobDate(
          dayKeyOf(entry.scheduledAt, timezone),
          todayKey(timezone),
        ),
      )
      break
    case 'recurrence':
      if (entry.suburb) parts.push(entry.suburb)
      parts.push(describeInterval(entry.interval))
      break
    case 'contact':
      if (entry.clientName) parts.push(entry.clientName)
      break
    case 'client':
      break
  }
  const withIt = withWhat(entry.counts)
  if (withIt) parts.push(`with ${withIt}`)
  return parts.join(' · ')
}

function withWhat(counts: Entry['counts']): string {
  const noun = (n: number, one: string, many: string) =>
    n > 0 ? `${n} ${n === 1 ? one : many}` : null
  return [
    noun(counts.properties, 'property', 'properties'),
    noun(counts.recurrences, 'recurring service', 'recurring services'),
    noun(counts.jobs, 'job', 'jobs'),
    noun(counts.notes, 'note', 'notes'),
    noun(counts.drafts, 'draft report', 'draft reports'),
  ]
    .filter((part) => part !== null)
    .join(', ')
}

/** A restore refused, in words: what to restore first, or why it can't be. */
const RESTORE_COPY: ErrorCopy = {
  RESTORE_CLIENT_FIRST:
    'Could not restore: its client is in the Recycle bin too. Restore the client first.',
  RESTORE_PROPERTY_FIRST:
    'Could not restore: its property is in the Recycle bin too. Restore the property first.',
  RESTORE_SERIES_FIRST:
    'Could not restore: the recurring service it belongs to is in the Recycle bin too. Restore that first.',
  RESTORE_PARENT_GONE:
    'Could not restore: what it belonged to has been deleted for good.',
  WIPING: 'Could not restore: it is already being deleted for good.',
  NOT_FOUND:
    'Could not restore: it has changed since you opened this page. Look again.',
  NO_ACCESS:
    'Could not restore: only the business owner can restore from the Recycle bin.',
  offline:
    'Could not restore: this device is offline. Try again when you have signal.',
  default: 'Could not restore. Check your signal and try again.',
}

/** Delete now and Empty bin, refused — in words. */
function wipeCopy(action: string): ErrorCopy {
  return {
    NO_ACCESS: `Could not ${action}: only the business owner can.`,
    offline: `Could not ${action}: this device is offline. Try again when you have signal.`,
    default: `Could not ${action}. Check your signal and try again.`,
  }
}
