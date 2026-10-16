import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { ChevronRight, LoaderCircle } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { FormAlert } from '#/components/forms/FormAlert'
import { describeError, errorCode } from '#/components/forms/describeError'
import { Sheet } from '#/components/primitives/Sheet'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'
import { useCan } from '#/lib/access'
import { isOffline } from '#/lib/online'
import { useHydrated } from '#/lib/useHydrated'
import {
  MERGE_CANCEL,
  MERGE_NOT_YOURS,
  giveErrorCopy,
  keepBothTitle,
  mergeConfirmBody,
  mergeErrorCopy,
  mergeOptionCopy,
  mergeUnavailableCopy,
  shareErrorCopy,
} from './xeroCopy'
import type { ReactNode, RefObject } from 'react'
import type { HeldOutcome } from './xeroCopy'
import type { Id } from '../../../convex/_generated/dataModel'

/** Merging two clients is the client book's own operation, not Xero's
 * (convex/clientMerge.ts): offered here, where the duplicate shows itself. */
const MERGE = api.clientMerge.merge
const MERGE_PREVIEW = api.clientMerge.mergePreview

/** The client already holding the card's Xero contact, as the card has it
 * (`heldBy` on a `reviewPage` item). */
export type Holder = { clientId: Id<'clients'>; name: string }

type Asking = 'merge' | 'give' | null

/**
 * "Same customer…" on a To check card whose Xero contact another client
 * (A, the holder) already has: what to do about B, the card's client, now
 * that they're one customer. Three ways, each with what it does in a line:
 *
 * 1. Merge B into A — B's sites, jobs, notes and contacts move to A, and B
 *    goes to the Recycle bin, for good (`clientMerge.merge`). Asked first: it
 *    can't be undone. Only for whoever may change clients; anyone else is
 *    told who can, rather than offered a button the server would refuse —
 *    and the same when the preview already says the merge would be refused
 *    (too big, a business into a person, changed since).
 * 2. Keep both, on A's contact — B stays, and sends nothing to Xero
 *    (`decide` 'share'). Saved on the tap, like Same and Different: it is
 *    undone by Unlink, under Shared contact.
 * 3. A is the wrong match — the contact goes to B, and A gets one of its
 *    own (`decide` 'give'). Asked first: it moves a match someone made.
 *
 * Every one fails fast with no signal: each changes a client someone else
 * may be looking at, and moves what reaches the organisation. Done, the
 * sheet closes and the card says what was saved (`onDone`), staying where
 * it was in the list — `onPin` is called before the save, because the list
 * may drop the card the moment the server has it.
 */
export function SameCustomerSheet({
  open,
  onClose,
  businessId,
  connectionId,
  clientId,
  clientName,
  holder,
  contactName,
  onPin,
  onDone,
  returnFocusRef,
}: {
  open: boolean
  onClose: () => void
  businessId: Id<'businesses'>
  connectionId: Id<'xeroConnections'>
  /** B, the card's client. */
  clientId: Id<'clients'>
  clientName: string
  /** A, who has the contact. */
  holder: Holder
  /** The Xero contact's name. */
  contactName: string
  onPin: () => void
  onDone: (outcome: Exclude<HeldOutcome, 'different'>) => void
  /** Where focus goes as the sheet shuts. */
  returnFocusRef: RefObject<HTMLElement | null>
}) {
  const hydrated = useHydrated()
  const canMerge = useCan('clients.manage')
  const [asking, setAsking] = useState<Asking>(null)
  const from = clientName
  const into = holder.name

  const mergeArgs = {
    businessId,
    fromClientId: clientId,
    intoClientId: holder.clientId,
  }
  // Only for whoever may merge, and only while the sheet is up: the counts
  // are the option's detail, never what it waits on. It refuses as the
  // merge would, and a refusal is said in the option's place.
  const previewQuery = useQuery(
    convexQuery(MERGE_PREVIEW, open && canMerge ? mergeArgs : 'skip'),
  )
  const preview = previewQuery.data
  const unavailable = previewQuery.isError
    ? mergeUnavailableCopy(errorCode(previewQuery.error), from, into)
    : null

  const convexDecide = useConvexMutation(api.xeroMatch.decide)
  const decide = useMutation({
    mutationFn: async (choice: 'share' | 'give') => {
      if (isOffline()) throw new Error('offline')
      await convexDecide({ businessId, connectionId, clientId, choice })
    },
    onSuccess: (_, choice) => {
      setAsking(null)
      onDone(choice)
      onClose()
    },
  })
  const convexMerge = useConvexMutation(MERGE)
  const merge = useMutation({
    mutationFn: async () => {
      if (isOffline()) throw new Error('offline')
      await convexMerge(mergeArgs)
    },
    onSuccess: () => {
      setAsking(null)
      onDone('merge')
      onClose()
    },
  })

  const busy = decide.isPending || merge.isPending
  const done = decide.isSuccess || merge.isSuccess
  const off = !hydrated || busy || done
  const sharing = decide.isPending && decide.variables === 'share'
  const shareFailed = decide.isError && decide.variables === 'share'
  const giveFailed = decide.isError && decide.variables === 'give'

  /** A confirm, asked afresh: without the last one's refusal. */
  function ask(which: Exclude<Asking, null>) {
    decide.reset()
    merge.reset()
    setAsking(which)
  }

  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        title={`${from} and ${into} are the same customer`}
        returnFocusRef={returnFocusRef}
      >
        <ul className="flex flex-col gap-1.5">
          <li>
            {canMerge && unavailable === null ? (
              <Option
                title={`Merge ${from} into ${into}`}
                disabled={off}
                onClick={() => ask('merge')}
              >
                {mergeOptionCopy({ from, into, preview })}
              </Option>
            ) : (
              // Said, not offered: a subcontractor can't change clients, and
              // a merge the preview refused would be refused again — a
              // button the server refuses would only fail. No chevron, and
              // its words in ink-2: not a row to tap.
              <div className="rounded-xl border border-hairline bg-surface px-3 py-2.5">
                <p className="text-body font-semibold text-ink-2 [overflow-wrap:anywhere]">
                  Merge {from} into {into}
                </p>
                <p className="mt-0.5 text-caption text-ink-2 [overflow-wrap:anywhere]">
                  {canMerge ? unavailable : MERGE_NOT_YOURS}
                </p>
              </div>
            )}
          </li>
          <li>
            <Option
              title={keepBothTitle(into)}
              disabled={off}
              pending={sharing}
              onClick={() => {
                onPin()
                decide.mutate('share')
              }}
            >
              {from} stays in PestM8; its changes aren’t sent to Xero.
            </Option>
          </li>
          <li>
            <Option
              title={`${into} is the wrong match — give this contact to ${from}`}
              disabled={off}
              onClick={() => ask('give')}
            >
              {into} gets a contact of its own.
            </Option>
          </li>
        </ul>
        <FormAlert
          error={shareFailed ? decide.error : null}
          copy={shareErrorCopy(into)}
          className="mt-3"
        />
      </Sheet>

      <ConfirmDialog
        open={asking === 'merge'}
        onOpenChange={(next) => !next && setAsking(null)}
        title={`Merge ${from} into ${into}?`}
        body={mergeConfirmBody({ from, into, preview })}
        confirm="Merge"
        // Not "Keep both", the sheet's second answer: this saves nothing.
        cancel={MERGE_CANCEL}
        onConfirm={() => {
          onPin()
          merge.mutate()
        }}
        pending={merge.isPending}
        pendingLabel="Merging…"
        closeOnConfirm={false}
        // Done, the sheet goes too, and focus with it to the card.
        returnFocus={(confirmed) => (confirmed ? returnFocusRef.current : null)}
        error={
          merge.isError
            ? describeError(merge.error, mergeErrorCopy(from, into))
            : undefined
        }
      />
      <ConfirmDialog
        open={asking === 'give'}
        onOpenChange={(next) => !next && setAsking(null)}
        title={`Give “${contactName}” to ${from}?`}
        body={`${into} is unlinked and PestM8 adds it as its own contact.`}
        // Short, without the names: a dialog's two buttons share one row,
        // and "Give it to Coastal Property Group" ran to three lines.
        confirm="Give it"
        cancel="Keep matched"
        onConfirm={() => {
          onPin()
          decide.mutate('give')
        }}
        pending={decide.isPending && decide.variables === 'give'}
        pendingLabel="Giving…"
        closeOnConfirm={false}
        returnFocus={(confirmed) => (confirmed ? returnFocusRef.current : null)}
        error={
          giveFailed
            ? describeError(decide.error, giveErrorCopy(into))
            : undefined
        }
      />
    </>
  )
}

/**
 * One way to go, as a row-card in the sheet: what it is, and in a line what
 * it does — so choosing one is not a guess (as `StatusPicker` says what a
 * status means). A chevron, as any row that leads on; a spinner in its
 * place while it saves.
 */
function Option({
  title,
  children,
  disabled,
  pending = false,
  onClick,
}: {
  title: string
  children: ReactNode
  disabled: boolean
  pending?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-busy={pending || undefined}
      onClick={onClick}
      className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-hairline bg-surface px-3 py-2.5 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-blue active:scale-[.99] disabled:opacity-50"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-body font-semibold text-ink [overflow-wrap:anywhere]">
          {title}
        </span>
        <span className="mt-0.5 block text-caption text-ink-2">
          {pending ? 'Saving…' : children}
        </span>
      </span>
      {pending ? (
        <LoaderCircle
          aria-hidden
          size={17}
          strokeWidth={2}
          className="shrink-0 animate-spin text-muted"
        />
      ) : (
        <ChevronRight
          aria-hidden
          size={17}
          strokeWidth={2.2}
          className="shrink-0 text-muted-2"
        />
      )}
    </button>
  )
}
