import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { api } from '../../../convex/_generated/api'
import { FormAlert } from '#/components/forms/FormAlert'
import { errorCode } from '#/components/forms/describeError'
import { FIX_ARM_MS } from '#/components/forms/saveWarningRules'
import { LoadFailed, NoMatches } from '#/components/primitives/EmptyState'
import { SearchBox } from '#/components/primitives/SearchBox'
import { Sheet } from '#/components/primitives/Sheet'
import {
  HELD_BUTTON,
  LINK_BUTTON_COMPACT,
  NEUTRAL_BUTTON,
  NEUTRAL_BUTTON_COMPACT,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'
import { Bone } from '#/components/shell/Pending'
import { useAccess, useCan } from '#/lib/access'
import {
  MERGE_ASK_LABEL,
  MERGE_CANCEL,
  MERGE_CHECKING_LABEL,
  MERGE_CHOOSE_ANOTHER,
  MERGE_GOES_LABEL,
  MERGE_INTO_DESCRIPTION,
  MERGE_KEPT_LABEL,
  MERGE_NO_OTHERS,
  MERGE_SEARCH_PLACEHOLDER,
  MERGE_TRY_AGAIN_LABEL,
  MAYBE_SAME_DIFFERENT,
  MAYBE_SAME_MERGE,
  MAYBE_SAME_REGION,
  NOT_THE_SAME_CANCEL,
  NOT_THE_SAME_ERROR_COPY,
  clientMergeErrorCopy,
  keepInsteadLabel,
  mergeConfirmText,
  mergeConfirmTitle,
  mergeArchivedNote,
  mergeIntoTitle,
  mergeNames,
  mergePairSummary,
  mergePairTitle,
  mergeRefusalStands,
  mergedCopy,
  notTheSameSaved,
  notTheSameText,
  notTheSameTitle,
} from '#/lib/clientMergeCopy'
import {
  hintThroughContact,
  keepsByDefault,
  maybeSameLine,
  maybeSameName,
  mergeMatches,
  mergeOptions,
  mergeBook,
  shownHints,
} from '#/lib/clientMergePicker'
import { queryHolders } from '#/lib/clientSearch'
import { normaliseDirectory } from '#/lib/directory'
import { isOffline } from '#/lib/online'
import { rq } from '#/lib/routeQueries'
import { useHydrated } from '#/lib/useHydrated'
import { useMatchIndexWhenRead } from '#/lib/useMatchIndex'
import { usePickerList } from '#/lib/usePickerList'
import type { ReactNode, RefObject } from 'react'
import type { FunctionReturnType } from 'convex/server'
import type { ComboboxLookup } from '#/components/primitives/Combobox'
import type { MergeSide } from '#/lib/clientMergeCopy'
import type { Directory } from '#/lib/directory'
import type { TypedAddress } from '../../../convex/lib/clientMatch'
import type { Id } from '../../../convex/_generated/dataModel'

/** One of the two clients, as the sheet knows them before the preview
 * says: its id, name and number. */
export type MergeClient = MergeSide & { _id: Id<'clients'> }

/** B, the one that goes, into A, the one kept. */
export type MergePair = { from: MergeClient; into: MergeClient }

/** How the sheet opens: on the list (Merge into…), or on a pair already
 * chosen (the possible-duplicate line's Merge…). */
export type MergeStart = { kind: 'pick' } | ({ kind: 'pair' } & MergePair)

/** A merge that went through, for the sheet behind to hand over to the
 * client kept, with what it says there. */
export type Merged = MergePair & { notice: string }

/** Past this many rows the list asks for more typing, as `Combobox` does:
 * a phone sheet of a few thousand buttons is slow to open and no use to
 * scroll. */
const MAX_ROWS = 100

/**
 * Merging one client into another from the client sheet (the matching
 * plan's M8; convex/clientMerge.ts does it). Two steps in one sheet:
 *
 * 1. **The list** (Merge into…): every other client the caller can see,
 *    never one archived or in the Recycle bin, searchable as New Job's
 *    client picker is (`clientOptions`, a number or email found by its
 *    holders), with the ones the matcher finds alike first — same name,
 *    number, email or address (`mergeMatches`, from the book without this
 *    client). A row is the client to keep.
 * 2. **The pair** (a row, or the possible-duplicate line's Merge…): who is
 *    kept and who goes to the Recycle bin, the way round to swap them, and
 *    what the merge does as `clientMerge.mergePreview` counts it — sites,
 *    jobs, notes and contacts moving, the kept client's details winning,
 *    each Xero organisation's outcome. A refusal that will stand is said
 *    there, and greys Merge… out (`mergeRefusalStands`). Merge… asks first,
 *    in `ConfirmDialog`, and the merge goes once however often it is
 *    tapped.
 *
 * Fails fast with no signal, as the Same customer sheet does: a merge moves
 * a client's whole history, which nobody should find happening hours later.
 * Done, `onMerged` hands the sheet behind to the client kept, and this one
 * closes.
 *
 * Only ever opened for someone with `clients.manage`, acting as themselves
 * (`useCan` drops it while switched); the server refuses anyone else.
 */
export function MergeIntoSheet({
  open,
  onClose,
  businessId,
  client,
  sites,
  start,
  onMerged,
  returnFocusRef,
}: {
  open: boolean
  onClose: () => void
  businessId: Id<'businesses'>
  /** The sheet's own client: the one Merge into… merges away. */
  client: MergeClient & { phone?: string; email?: string }
  /** Their sites, for who the matcher finds alike. */
  sites: ReadonlyArray<TypedAddress>
  start: MergeStart
  onMerged: (merged: Merged) => void
  /** Where focus goes as the sheet closes: what opened it, or once merged
   * the "Merged — …" line on the kept client's sheet, which says what
   * happened. */
  returnFocusRef?: RefObject<HTMLElement | null>
}) {
  const [pair, setPair] = useState<MergePair | null>(
    start.kind === 'pair' ? { from: start.from, into: start.into } : null,
  )
  const picking = start.kind === 'pick'

  const preview = useQuery(
    convexQuery(
      api.clientMerge.mergePreview,
      open && pair
        ? {
            businessId,
            fromClientId: pair.from._id,
            intoClientId: pair.into._id,
          }
        : 'skip',
    ),
  )
  // The client kept, asked for while the pair is up: the sheet behind
  // opens on them the moment the merge is done, rather than on a
  // placeholder.
  const intoRecord = useQuery(
    convexQuery(
      api.clients.get,
      open && pair ? { businessId, clientId: pair.into._id } : 'skip',
    ),
  ).data
  // And the one that goes, already in memory (the sheet's own client, or
  // the line's other): whether either is archived, which the server
  // refuses as it refuses a client gone, and which the pair then says.
  const fromRecord = useQuery(
    convexQuery(
      api.clients.get,
      open && pair ? { businessId, clientId: pair.from._id } : 'skip',
    ),
  ).data
  // And their possible duplicates, for whoever reads them: the merged-away
  // client's go to them, and their sheet shows the lines only if they are
  // there as it first draws.
  const seesHints = useCan('team.manage')
  useQuery(
    convexQuery(
      api.clientMatchHints.forClient,
      open && pair && seesHints
        ? { businessId, clientId: pair.into._id }
        : 'skip',
    ),
  )

  // The pair's last answer, kept while the sheet slides away once merged:
  // the preview is no longer asked for then, and the merged-away client
  // would only be refused.
  const [counted, setCounted] = useState(preview.data)
  if (preview.data && preview.data !== counted) setCounted(preview.data)
  // Fresher than what the sheet was opened with, once the preview says.
  const sides = pair && {
    from: counted?.from ?? pair.from,
    into: counted?.into ?? pair.into,
  }
  const names = sides && mergeNames(sides.from, sides.into)
  const archived = !names
    ? undefined
    : isArchived(fromRecord)
      ? names.from
      : isArchived(intoRecord)
        ? names.into
        : undefined

  const convexMerge = useConvexMutation(api.clientMerge.merge)
  const [asking, setAsking] = useState(false)
  // Set as Merge is pressed, before the dialog's own `pending` is drawn:
  // the second tap of a double tap merges nothing.
  const sent = useRef(false)
  const merge = useMutation({
    // With the two names as the confirm said them, from the preview: the
    // pair a line's Merge… made may have been made before the other
    // client's own record, and number, had come.
    mutationFn: async (chosen: Asked) => {
      if (isOffline()) throw new Error('offline')
      await convexMerge({
        businessId,
        fromClientId: chosen.pair.from._id,
        intoClientId: chosen.pair.into._id,
      })
      return chosen
    },
    onSuccess: ({ pair: chosen, names: said }) => {
      setAsking(false)
      onMerged({ ...chosen, notice: mergedCopy(said.from, said.into) })
    },
    onError: () => {
      sent.current = false
      // Said in the sheet, where Merge… was, not in the dialog.
      setAsking(false)
    },
  })

  /** Back to the list, or the other way round: asked afresh. */
  function choose(next: MergePair | null) {
    merge.reset()
    sent.current = false
    setCounted(undefined)
    setPair(next)
  }

  // A pair put up from the list comes in under the thumb that tapped its
  // row: the sheet shrinks to fit it, and Keep {B} instead lands where the
  // list's middle rows were. For FIX_ARM_MS it takes no tap, as a fix that
  // comes in under a tap takes none, so the second tap of a double tap
  // never swaps who is kept. A fresh hold for each pair put up (`n`).
  const [swapHold, setSwapHold] = useState<number | null>(null)
  useEffect(() => {
    if (swapHold === null) return
    const release = setTimeout(() => setSwapHold(null), FIX_ARM_MS)
    return () => clearTimeout(release)
  }, [swapHold])

  // What was typed in the list, kept here rather than in the list, which
  // the pair takes the place of: Choose another goes back to the list as
  // it was searched, not to every client again.
  const [query, setQuery] = useState('')

  // A row tapped with no signal: said in the footer, above Done, rather
  // than above the rows, where it would push them down under the thumb, or
  // land out of sight with the list scrolled.
  const [rowOffline, setRowOffline] = useState(false)

  const refused =
    preview.isError && mergeRefusalStands(errorCode(preview.error))
  // A refusal that may not last (anything unforeseen): the button says Try
  // again, and asks the preview again, rather than a Merge… that can't ask
  // or a confirm over counts the preview no longer stands by. One
  // condition for its words and what it does.
  const retry = preview.isError && !refused
  const title = names
    ? mergePairTitle(names.from, names.into)
    : mergeIntoTitle(client.name)

  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        returnFocusRef={returnFocusRef}
        title={title}
        description={pair ? undefined : MERGE_INTO_DESCRIPTION}
        footer={
          pair && names ? (
            <PairFooter
              picking={picking}
              checking={counted === undefined && !preview.isError}
              done={merge.isSuccess}
              refused={refused}
              retry={retry}
              merging={merge.isPending}
              onBack={() => choose(null)}
              onAsk={() => {
                if (counted === undefined || retry) {
                  void preview.refetch()
                  return
                }
                merge.reset()
                setAsking(true)
              }}
            />
          ) : (
            <>
              <FormAlert
                className="mb-2"
                error={rowOffline ? new Error('offline') : null}
                copy={clientMergeErrorCopy(client.name, client.name)}
              />
              <button
                type="button"
                onClick={onClose}
                className={`${NEUTRAL_BUTTON_COMPACT} w-full`}
              >
                Done
              </button>
            </>
          )
        }
      >
        {pair && sides && names ? (
          <PairBody
            sides={sides}
            names={names}
            summary={mergePairSummary({
              from: names.from,
              into: names.into,
              preview: counted,
            })}
            failure={
              merge.isError
                ? merge.error
                : preview.isError
                  ? preview.error
                  : null
            }
            archived={archived}
            merging={merge.isPending}
            held={swapHold !== null}
            onSwap={() => choose({ from: pair.into, into: pair.from })}
          />
        ) : (
          <PickList
            open={open && picking}
            businessId={businessId}
            client={client}
            sites={sites}
            query={query}
            onQuery={setQuery}
            onOffline={setRowOffline}
            onPick={(into) => {
              choose({ from: client, into })
              setSwapHold((n) => (n ?? 0) + 1)
            }}
          />
        )}
      </Sheet>

      {pair && names && counted && (
        <ConfirmDialog
          open={asking}
          onOpenChange={(next) => !next && setAsking(false)}
          title={mergeConfirmTitle(names.from, names.into)}
          body={mergeConfirmText({
            from: names.from,
            into: names.into,
            preview: counted,
          })}
          confirm="Merge"
          cancel={MERGE_CANCEL}
          onConfirm={() => {
            if (sent.current) return
            sent.current = true
            merge.mutate({ pair, names })
          }}
          pending={merge.isPending}
          pendingLabel="Merging…"
          closeOnConfirm={false}
        />
      )}
    </>
  )
}

/** A merge as the confirm asked it: the pair, and the names it said. */
type Asked = { pair: MergePair; names: { from: string; into: string } }

/** A client record that is there and archived (not one gone). */
function isArchived(
  client: { archivedAt?: number } | null | undefined,
): boolean {
  return client != null && client.archivedAt !== undefined
}

/** The pair's buttons: Merge…, and from the list a way back to it. */
function PairFooter({
  picking,
  checking,
  done,
  refused,
  retry,
  merging,
  onBack,
  onAsk,
}: {
  picking: boolean
  checking: boolean
  /** Merged: the sheet is on its way out. */
  done: boolean
  refused: boolean
  /** The preview failed for a reason that may pass: the button asks it
   * again. */
  retry: boolean
  merging: boolean
  onBack: () => void
  onAsk: () => void
}) {
  const hydrated = useHydrated()
  // Ink, not red: it asks, and the red is the dialog's.
  const ask = (
    <button
      type="button"
      disabled={!hydrated || checking || refused || merging || done}
      aria-busy={checking || undefined}
      onClick={onAsk}
      className={
        picking
          ? `${NEUTRAL_BUTTON_COMPACT} flex-1`
          : `${NEUTRAL_BUTTON} w-full`
      }
    >
      {checking
        ? MERGE_CHECKING_LABEL
        : retry
          ? MERGE_TRY_AGAIN_LABEL
          : MERGE_ASK_LABEL}
    </button>
  )
  if (!picking) return ask
  return (
    <div className="flex gap-2">
      <button
        type="button"
        disabled={!hydrated || merging || done}
        onClick={onBack}
        className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
      >
        {MERGE_CHOOSE_ANOTHER}
      </button>
      {ask}
    </div>
  )
}

/** Who is kept and who goes, the way round to swap them, and what the
 * merge does. */
function PairBody({
  sides,
  names,
  summary,
  failure,
  archived,
  merging,
  held,
  onSwap,
}: {
  sides: { from: MergeSide; into: MergeSide }
  names: { from: string; into: string }
  summary: string
  failure: unknown
  /** The one of the two that is archived, as `names` names them. */
  archived: string | undefined
  merging: boolean
  /** Just put up under a tap on the list: the way round takes no tap yet,
   * held pressed in (`HELD_BUTTON`), never dimmed. */
  held: boolean
  onSwap: () => void
}) {
  const hydrated = useHydrated()
  return (
    <>
      <div className="overflow-hidden rounded-xl border border-hairline bg-surface">
        <PairSide label={MERGE_KEPT_LABEL} side={sides.into} />
        <PairSide
          label={MERGE_GOES_LABEL}
          side={sides.from}
          className="border-t border-hairline"
        />
      </div>
      <button
        type="button"
        disabled={!hydrated || merging}
        aria-disabled={held || undefined}
        onClick={() => {
          if (held) return
          onSwap()
        }}
        className={`${LINK_BUTTON_COMPACT} ${HELD_BUTTON} mt-2 w-full`}
      >
        {keepInsteadLabel(names.from)}
      </button>
      <p className="mt-3 text-body text-ink-2">{summary}</p>
      <FormAlert
        className="mt-3"
        error={failure}
        copy={clientMergeErrorCopy(names.from, names.into, archived)}
      />
    </>
  )
}

function PairSide({
  label,
  side,
  className = '',
}: {
  label: string
  side: MergeSide
  className?: string
}) {
  return (
    <div className={`px-3 py-2.5 ${className}`}>
      <p className="section-label mb-0.5">{label}</p>
      <p className="text-body font-semibold text-ink [overflow-wrap:anywhere]">
        {side.name}
        {side.clientNumber !== null && (
          <span className="ml-1.5 font-normal tabular-nums text-muted">
            #{side.clientNumber}
          </span>
        )}
      </p>
    </div>
  )
}

/**
 * The clients to choose the one to keep from: the client list and the
 * roster, read from the list's first opening on ('skip' before it, since a
 * query only disabled keeps its subscription), and drawn once both are
 * here, so the ones alike never land above rows already under a thumb.
 * Under the search bar, there from the first frame, so the rows land where
 * the placeholder was rather than a bar's height lower.
 */
function PickList({
  open,
  businessId,
  client,
  sites,
  query,
  onQuery,
  onOffline,
  onPick,
}: {
  open: boolean
  businessId: Id<'businesses'>
  client: MergeClient & { phone?: string; email?: string }
  sites: ReadonlyArray<TypedAddress>
  /** What is typed in the search, kept by the sheet across a pair. */
  query: string
  onQuery: (query: string) => void
  /** A row tapped with no signal, or one tapped since with it. */
  onOffline: (offline: boolean) => void
  onPick: (into: MergeClient) => void
}) {
  const business = useRouteContext({
    from: '/$businessSlug',
    select: (context) => context.business,
  })
  const access = useAccess()
  const hydrated = useHydrated()
  // Asked for from the first opening, and not dropped as the sheet slides
  // away: 'skip' then would swap the rows for placeholders mid-slide. Both
  // are kept for as long as the app is open anyway (gcTime Infinity), so
  // dropping them would save nothing.
  const [asked, setAsked] = useState(open)
  if (open && !asked) setAsked(true)
  const answer = useQuery(
    convexQuery(api.clients.directory, asked ? { businessId } : 'skip'),
  )
  const roster = useQuery(
    convexQuery(
      api.memberships.listForBusiness,
      asked ? { businessId } : 'skip',
    ),
  )
  const members = roster.data
  const directory = useMemo(
    () => (answer.data ? normaliseDirectory(answer.data) : undefined),
    [answer.data],
  )
  const others = useMemo(
    () => directory && mergeBook(directory, client._id),
    [directory, client._id],
  )
  const index = useMatchIndexWhenRead(others, business, members, access)
  const { name, phone, email } = client
  const rows = useMemo(() => {
    if (!directory || !index) return null
    const matches = mergeMatches(index, { name, phone, email }, sites)
    return mergeOptions(directory, client._id, matches)
  }, [directory, index, name, phone, email, sites, client._id])

  // A number or an email typed finds whoever holds it first, as New Job's
  // client picker does.
  const lookup = useCallback(
    (typed: string): ComboboxLookup | null => {
      const holders = index && queryHolders(index, typed)
      return holders ? { first: holders.clientIds } : null
    },
    [index],
  )
  const list = usePickerList({
    open: open && rows !== null,
    rows: rows ?? [],
    query,
    lookup,
    allowCustom: false,
  })

  // The roster too: for whoever manages the team, the list waits for it
  // (`useMatchIndexWhenRead`), and would wait for good on one that failed.
  if (answer.isError || (rows === null && roster.isError)) {
    return (
      <LoadFailed
        what="your clients"
        onRetry={() => {
          if (answer.isError) void answer.refetch()
          if (roster.isError) void roster.refetch()
        }}
      />
    )
  }
  const searchBar = (
    <div className="sticky top-0 z-20 -mx-4 flex bg-canvas px-4 pb-2">
      <SearchBox
        value={query}
        onChange={onQuery}
        label="Search clients"
        placeholder={MERGE_SEARCH_PLACEHOLDER}
      />
    </div>
  )
  if (rows === null) {
    return (
      <>
        {searchBar}
        <RowsPending />
      </>
    )
  }

  const searching = list.query.trim() !== ''
  const shown = list.ordered.slice(0, MAX_ROWS)
  const sections: Array<{ group?: string; rows: typeof shown }> = []
  for (const row of shown) {
    const group = searching ? undefined : row.group
    const last = sections.at(-1)
    if (last && last.group === group) last.rows.push(row)
    else sections.push({ group, rows: [row] })
  }
  const byId = new Map(directory?.clients.map((c) => [c._id, c]) ?? [])

  return (
    <>
      {searchBar}
      {sections.map((section, at) => (
        <section
          key={section.group ?? `rows-${at}`}
          className={at > 0 ? 'mt-4' : undefined}
        >
          {section.group && (
            <h3 className="section-label mb-1.5">{section.group}</h3>
          )}
          <ul className="flex flex-col gap-1.5">
            {section.rows.map((row) => (
              <li key={row.value}>
                <button
                  type="button"
                  disabled={!hydrated}
                  onClick={() => {
                    const chosen = byId.get(row.value as Id<'clients'>)
                    if (!chosen) return
                    if (isOffline()) {
                      onOffline(true)
                      return
                    }
                    onOffline(false)
                    onPick({
                      _id: chosen._id,
                      name: chosen.name,
                      clientNumber: chosen.clientNumber ?? null,
                    })
                  }}
                  className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-hairline bg-surface px-3 py-2.5 text-left transition active:scale-[.99]"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-body text-ink">
                      {row.label}
                    </span>
                    {row.detail && (
                      <span className="block text-caption text-muted">
                        {row.detail}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {list.ordered.length > shown.length && (
        <p className="px-1 py-2 text-caption text-muted">
          Showing {shown.length} of {list.ordered.length}. Keep typing to narrow
          it down.
        </p>
      )}
      {list.ordered.length === 0 &&
        (searching ? (
          <NoMatches
            term={list.query}
            clearLabel="Clear search"
            onClear={() => onQuery('')}
          />
        ) : (
          <p className="px-1 py-3 text-center text-caption text-grey-ink">
            {MERGE_NO_OTHERS}
          </p>
        ))}
    </>
  )
}

/**
 * The list loading: bones shaped as its rows are, a row-card's 62px (a
 * name over its number, `py-2.5`, its border) at the list's own gap, so
 * the rows land where the bones were rather than shorter and closer. No
 * heading: whether anyone is alike isn't known yet, and a placeholder
 * carries none. Announced, as `ListPending` is, inside a sheet whose
 * `status` means nothing else.
 */
function RowsPending() {
  return (
    <div role="status">
      <span className="sr-only">Loading clients</span>
      <div aria-hidden className="flex flex-col gap-1.5">
        {Array.from({ length: 4 }, (_, i) => (
          <Bone key={`bone-${i}`} className="h-[62px] rounded-xl" />
        ))}
      </div>
    </div>
  )
}

/** An open possible duplicate on a client's sheet
 * (`clientMatchHints.forClient`). */
export type MaybeSame = FunctionReturnType<
  typeof api.clientMatchHints.forClient
>[number]

/** The sheet's client, as its possible-duplicate lines read it: with when
 * it was made, for which of the two came first, and its kind, for whose
 * contact a name agreed through (`hintThroughContact`). */
type LineClient = MergeClient & {
  _creationTime: number
  kind: 'person' | 'business'
}

/**
 * The possible-duplicate lines on a client's sheet: one for each client the
 * server's check let through as maybe this one when a booking made one of
 * them, newest first, each saying what the two agree on — "May be the same
 * customer as Jane Nguyen #12: same name and mobile." — with **Merge…**, the
 * merge's pair with the client there first kept (`keepsByDefault`; the pair
 * can swap), and **Not the same**, which asks first and then sets it aside
 * for good, on both sheets.
 *
 * The lines are the ones the sheet first drew (`hints`), each while the
 * server still lists it between the same two clients (`live`,
 * `shownHints`): one that comes later waits for the next opening, never
 * put in above Book a job under a thumb. One answered Not
 * the same here stays where it was, saying so, until the sheet is next
 * opened: gone, it would slide the next line's answer up under the thumb
 * that answered this one, and that answer can't be taken back (the Xero
 * cards keep their place for the same reason).
 *
 * Only for the owner and contractors (`team.manage` reads the lines, and
 * `clients.manage` answers them), acting as themselves: anyone else has no
 * line at all, never one they could only read.
 */
export function MaybeSameLines({
  businessId,
  here,
  hints,
  live,
  held,
  onMerge,
}: {
  businessId: Id<'businesses'>
  /** The sheet's client. */
  here: LineClient
  /** The lines as the sheet first drew them. */
  hints: ReadonlyArray<MaybeSame>
  /** Those the server still lists: each open hint's id, to the other
   * client it pairs this one with now. */
  live: ReadonlyMap<string, string>
  /** A contact or site half-typed in Details: a merge hands the sheet to
   * the client kept, which would lose it without a word, so Merge… waits,
   * as Edit and the tabs do. */
  held: boolean
  /** Merge…, with the button that asked, for focus to come back to. */
  onMerge: (pair: MergePair, opener: HTMLElement) => void
}) {
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set())
  const shown = shownHints(hints, live, answered)
  if (shown.length === 0) return null
  return (
    <ul aria-label={MAYBE_SAME_REGION} className="mt-3 flex flex-col gap-2">
      {shown.map((hint) => (
        <MaybeSameLine
          key={hint._id}
          businessId={businessId}
          here={here}
          hint={hint}
          held={held}
          onAnswering={() => setAnswered((was) => new Set(was).add(hint._id))}
          onMerge={onMerge}
        />
      ))}
    </ul>
  )
}

function MaybeSameLine({
  businessId,
  here,
  hint,
  held,
  onAnswering,
  onMerge,
}: {
  businessId: Id<'businesses'>
  here: LineClient
  hint: MaybeSame
  held: boolean
  /** Not the same tapped: the line stays, whatever the server lists. */
  onAnswering: () => void
  onMerge: (pair: MergePair, opener: HTMLElement) => void
}) {
  const hydrated = useHydrated()
  const sentenceId = useId()
  const sentence = useRef<HTMLParagraphElement>(null)
  const queryClient = useQueryClient()
  // The other client as the line names them, decided as it first draws and
  // kept for the opening: where the two are called the same, with their
  // number from the client list in memory (kept while the app is open), so
  // the line says which record it means; bare without it, as a number that
  // came later would change the line's length under a thumb.
  const [otherSaid] = useState(() =>
    maybeSameName(
      here.name,
      hint.otherName,
      queryClient
        .getQueryData<Directory>(rq.directory(businessId).queryKey)
        ?.clients.find((c) => c._id === hint.otherClientId)?.clientNumber,
    ),
  )
  // And, decided with it, whose contact person a name agreed through where
  // it wasn't the two clients' own (Sarah Lee at Ray White Bayswater): the
  // line says so, never "same name" for an agency called nothing like her.
  // The other's kind from the same list, where it is there.
  const [through] = useState(() =>
    hintThroughContact(
      here,
      {
        name: hint.otherName,
        kind: queryClient
          .getQueryData<Directory>(rq.directory(businessId).queryKey)
          ?.clients.find((c) => c._id === hint.otherClientId)?.kind,
      },
      hint,
    ),
  )
  // The other client's own record, for which of the two came first, their
  // number, and whether they are archived: asked for as the line shows, so
  // Merge… has it to hand.
  const other = useQuery(
    convexQuery(api.clients.get, {
      businessId,
      clientId: hint.otherClientId,
    }),
  ).data
  // And their own lines, with it: their sheet, opened next to compare, draws
  // at once from the record this answer keeps, and shows its lines only if
  // they are there as it first draws.
  const seesHints = useCan('team.manage')
  useQuery(
    convexQuery(
      api.clientMatchHints.forClient,
      seesHints ? { businessId, clientId: hint.otherClientId } : 'skip',
    ),
  )
  const convexAnswer = useConvexMutation(api.clientMatchHints.answer)
  const answer = useMutation({
    mutationFn: async () => {
      if (isOffline()) throw new Error('offline')
      await convexAnswer({ businessId, hintId: hint._id, answer: 'different' })
    },
  })
  // Merge… with no signal: said here, rather than a pair that waits.
  const [mergeOffline, setMergeOffline] = useState(false)
  // Not the same asks first: its answer can't be taken back. The question
  // comes up over the tap that asked, so for FIX_ARM_MS neither of its
  // buttons takes a tap (ConfirmDialog's `held`), as "Discard your
  // changes?" asked from inside a sheet is held.
  const [asking, setAsking] = useState(false)
  const [askHeld, setAskHeld] = useState(false)
  // Whether it may say Merge into… can still merge them: only once the
  // other client's record says they can be (there, and not archived), and
  // decided as it asks, so its words never change while it is up.
  const [askMergeLater, setAskMergeLater] = useState(false)
  useEffect(() => {
    if (!askHeld) return
    const release = setTimeout(() => setAskHeld(false), FIX_ARM_MS)
    return () => clearTimeout(release)
  }, [askHeld])
  const busy = answer.isPending || answer.isSuccess
  // A merge refuses an archived client either way round, and nothing in the
  // app restores one from archived: Merge… greyed out, and why under it.
  // Known once their record answers; Merge… tapped before then opens the
  // pair, which says it too.
  const otherArchived = other != null && other.archivedAt !== undefined
  const named = mergeNames(here, {
    name: other?.name ?? hint.otherName,
    clientNumber: other?.clientNumber ?? null,
  })

  return (
    <li className="rounded-xl bg-surface-2 px-3 py-2.5">
      {/* Where focus goes once Not the same is answered: the line stays,
          and its buttons are greyed out (not a tab stop). */}
      <p
        id={sentenceId}
        ref={sentence}
        tabIndex={-1}
        className="rounded-sm text-caption text-ink-2 outline-none [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-blue"
      >
        {maybeSameLine(otherSaid, hint.evidence, through)}
      </p>
      {/* Named by the line's own sentence: with two lines, a screen
          reader's list of buttons is never "Merge…, Not the same" twice
          over. */}
      <div
        role="group"
        aria-labelledby={sentenceId}
        className="mt-2 flex gap-2"
      >
        <button
          type="button"
          aria-haspopup="dialog"
          disabled={!hydrated || busy || held || otherArchived}
          onClick={(event) => {
            const opener = event.currentTarget
            answer.reset()
            if (isOffline()) {
              setMergeOffline(true)
              return
            }
            setMergeOffline(false)
            const there: MergeClient = {
              _id: hint.otherClientId,
              name: other?.name ?? hint.otherName,
              clientNumber: other?.clientNumber ?? null,
            }
            const mine: MergeClient = {
              _id: here._id,
              name: here.name,
              clientNumber: here.clientNumber,
            }
            onMerge(
              keepsByDefault(here, other, hint.madeAt) === 'here'
                ? { from: there, into: mine }
                : { from: mine, into: there },
              opener,
            )
          }}
          className={`${LINK_BUTTON_COMPACT} flex-1`}
        >
          {MAYBE_SAME_MERGE}
        </button>
        <button
          type="button"
          disabled={!hydrated || busy}
          onClick={() => {
            setMergeOffline(false)
            answer.reset()
            setAskMergeLater(other != null && !otherArchived)
            setAsking(true)
            setAskHeld(true)
          }}
          className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
        >
          {answer.isPending ? 'Saving…' : MAYBE_SAME_DIFFERENT}
        </button>
      </div>
      <ConfirmDialog
        open={asking}
        onOpenChange={(next) => {
          if (next) return
          setAsking(false)
          setAskHeld(false)
        }}
        title={notTheSameTitle(otherSaid)}
        body={notTheSameText(askMergeLater)}
        confirm={MAYBE_SAME_DIFFERENT}
        cancel={NOT_THE_SAME_CANCEL}
        held={askHeld}
        onConfirm={() => {
          // Kept before the answer is sent: the server may drop it before
          // the mutation's own answer comes.
          onAnswering()
          answer.mutate()
        }}
        // Answered, the button that asked is greyed out: focus goes to the
        // line, which stays saying so.
        returnFocus={(confirmed) => (confirmed ? sentence.current : null)}
      />
      {otherArchived && (
        <p className="mt-2 text-caption text-ink-2 [overflow-wrap:anywhere]">
          {mergeArchivedNote(named.into)}
        </p>
      )}
      <Saved>{answer.isSuccess && notTheSameSaved(otherSaid)}</Saved>
      {mergeOffline ? (
        <FormAlert
          className="mt-2"
          error={new Error('offline')}
          copy={clientMergeErrorCopy(here.name, otherSaid)}
        />
      ) : (
        <FormAlert
          className="mt-2"
          error={answer.isError ? answer.error : null}
          copy={NOT_THE_SAME_ERROR_COPY}
        />
      )}
    </li>
  )
}

/**
 * What an answered line saved, with a tick, as an answered Xero card says
 * it. Mounted with the line, so it is already listening when the answer is
 * saved: in the accessibility tree while empty (no height, no margin),
 * never `display: none`, which a screen reader would meet as a region
 * newly shown and may not read.
 */
function Saved({ children }: { children: ReactNode }) {
  return (
    <p
      role="status"
      className="mt-2 flex gap-1.5 text-caption text-ink-2 empty:mt-0"
    >
      {children && (
        <>
          <Check
            aria-hidden
            size={13}
            strokeWidth={2.2}
            className="mt-[3px] shrink-0 text-green"
          />
          <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
        </>
      )}
    </p>
  )
}
