import { memo, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { Check } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { FormAlert } from '#/components/forms/FormAlert'
import { describeError } from '#/components/forms/describeError'
import { Segmented } from '#/components/primitives/Segmented'
import { SECONDARY_BUTTON_COMPACT } from '#/components/primitives/buttons'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'
import { FIELD_LABEL } from '#/components/settings/ui'
import { isOffline } from '#/lib/online'
import {
  DECIDE_ERROR_COPY,
  MATCH_REASON_COPY,
  REOPEN_ERROR_COPY,
  UNLINK_ERROR_COPY,
} from './xeroCopy'
import type { FunctionReturnType } from 'convex/server'
import type { Id } from '../../../convex/_generated/dataModel'

/** One client on the match page, as `xeroMatch.reviewPage` gives it. */
export type MatchItem = FunctionReturnType<
  typeof api.xeroMatch.reviewPage
>['page'][number]

/** Same client, Different client — or neither yet. */
type Choice = 'same' | 'different' | ''

const CHOICES: Array<{ value: Choice; label: string }> = [
  { value: 'same', label: 'Same client' },
  { value: 'different', label: 'Different client' },
]

/** What every card and row needs to save against. */
type Where = {
  businessId: Id<'businesses'>
  connectionId: Id<'xeroConnections'>
}

/**
 * Keeps the keyboard's place once a card has settled: the control it was on
 * is now disabled, which drops focus to the top of the page. It goes to the
 * card itself, which stays where it was (`MatchReview` keeps it on screen).
 */
function keepFocus(card: HTMLElement | null) {
  requestAnimationFrame(() => {
    const active = document.activeElement
    if (active && active !== document.body) return
    if (card?.isConnected) card.focus()
  })
}

/** "#42 · 0412 345 678 · Nightcliff": a client's facts, in one line. */
function clientFacts(item: MatchItem): string {
  return [
    typeof item.clientNumber === 'number' ? `#${item.clientNumber}` : null,
    item.clientPhone,
    item.clientSuburb,
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * One client PestM8 isn't sure of: the client as PestM8 holds them, above
 * the Xero contact it thinks they might be, why it thinks so, and the
 * holder's answer — Same client or Different client, saved the moment it is
 * chosen. Either can be taken back: Same by Unlink under Matched, Different
 * by Match again under Different. Nothing is chosen by the arrow keys
 * (`Segmented`, with nothing chosen yet): only a tap, Space or Enter.
 *
 * Once saved the card stays where it was, answered, rather than leaving the
 * list under the thumb that answered it (the next card's choice would slide
 * up into the same spot). `onPin` is how it asks to stay: called at the tap,
 * before the save, because the list may drop it the moment the server has
 * it. A save that fails leaves it to be answered again, with why.
 *
 * Memoised, and handed the same callbacks every time: an answer changes one
 * client, and the other ninety-nine cards on screen should not draw again.
 */
export const MatchCard = memo(function MatchCard({
  businessId,
  connectionId,
  item,
  hydrated,
  onPin,
}: Where & {
  item: MatchItem
  hydrated: boolean
  onPin: (item: MatchItem) => void
}) {
  const card = useRef<HTMLLIElement>(null)
  const convexDecide = useConvexMutation(api.xeroMatch.decide)
  const decide = useMutation({
    mutationFn: async (choice: 'same' | 'different') => {
      // Fails fast: a choice held for the signal would land long after the
      // card seemed to have taken it, maybe after the holder had left.
      if (isOffline()) throw new Error('offline')
      await convexDecide({
        businessId,
        connectionId,
        clientId: item.clientId,
        choice,
      })
    },
    onSuccess: () => keepFocus(card.current),
  })

  const contact = item.candidate
  // A To check row always has its candidate (`xeroMatch.saveProposals`).
  if (!contact) return null

  const saved = decide.isSuccess
  const chosen: Choice =
    decide.isPending || decide.isSuccess ? decide.variables : ''
  const xeroFacts = [
    contact.phone,
    contact.place,
    contact.accountNumber ? `Account no. ${contact.accountNumber}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <li
      ref={card}
      // Where focus is kept once the card is answered (`keepFocus`).
      tabIndex={-1}
      aria-label={item.clientName}
      className="rounded-2xl border border-hairline bg-surface p-4 shadow-elevation outline-none focus-visible:ring-2 focus-visible:ring-blue"
    >
      <p className={FIELD_LABEL}>In PestM8</p>
      <p className="mt-0.5 text-row-title text-ink [overflow-wrap:anywhere]">
        {item.clientName}
      </p>
      {clientFacts(item) && (
        <p className="text-caption text-ink-2 [overflow-wrap:anywhere]">
          {clientFacts(item)}
        </p>
      )}

      <div className="mt-3 border-t border-hairline-2 pt-3">
        <p className={FIELD_LABEL}>In Xero</p>
        <p className="mt-0.5 text-row-title text-ink [overflow-wrap:anywhere]">
          {contact.name}
        </p>
        {/* Its own line: an address has nowhere to break on a phone. */}
        {contact.email && (
          <p className="text-caption text-ink-2 [overflow-wrap:anywhere]">
            {contact.email}
          </p>
        )}
        {xeroFacts && (
          <p className="text-caption text-ink-2 [overflow-wrap:anywhere]">
            {xeroFacts}
          </p>
        )}
      </div>

      {/* Grey-ink, not muted: it is the reason to answer, read in sun. */}
      <p className="mt-3 text-caption text-grey-ink">
        {MATCH_REASON_COPY[contact.reason]}
      </p>
      <div className="mt-2">
        <Segmented<Choice>
          kind="choice"
          label={`Is ${item.clientName} the same client as ${contact.name} in Xero?`}
          value={chosen}
          options={CHOICES}
          // Answered once: it is undone from the list it went to (Unlink
          // under Matched, Match again under Different), so a second tap
          // here must not look as if it changed anything.
          disabled={!hydrated || decide.isPending || saved}
          onChange={(choice) => {
            if (choice === '') return
            onPin(item)
            decide.mutate(choice)
          }}
        />
      </div>
      <FormAlert
        error={decide.isError ? decide.error : null}
        copy={DECIDE_ERROR_COPY}
        className="mt-2"
      />
      {/* Mounted with the card, so it is already listening when the answer
          is saved. */}
      <p
        role="status"
        className="empty:hidden mt-2 flex gap-1.5 text-caption text-ink-2"
      >
        {saved && (
          <>
            <Check
              aria-hidden
              size={13}
              strokeWidth={2.2}
              className="mt-[3px] shrink-0 text-green"
            />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {decide.variables === 'same'
                ? `Saved — ${item.clientName} is “${contact.name}” in Xero.`
                : `Saved — PestM8 will add ${item.clientName} to Xero as a new contact. Match again is under Different.`}
            </span>
          </>
        )}
      </p>
    </li>
  )
})

/**
 * A client PestM8 has matched to a Xero contact, as one row of a grouped
 * list, with Unlink — asked first, since it goes from Matched to Different,
 * where only Match again brings it back. Once unlinked the row stays,
 * saying so, for the same reason an answered card does (`MatchCard`).
 *
 * "Matched by you" only for the person looking: an organisation's answers
 * pass to whoever holds it next (`xeroMatch.reviewPage`'s `decidedByYou`).
 */
export const MatchedRow = memo(function MatchedRow({
  businessId,
  connectionId,
  item,
  hydrated,
  onPin,
}: Where & {
  item: MatchItem
  hydrated: boolean
  onPin: (item: MatchItem) => void
}) {
  const row = useRef<HTMLLIElement>(null)
  const [confirming, setConfirming] = useState(false)
  const convexUnlink = useConvexMutation(api.xeroMatch.unlink)
  const unlink = useMutation({
    mutationFn: async () => {
      // Fails fast: an unlink held for the signal would go through after
      // the person had decided it hadn't.
      if (isOffline()) throw new Error('offline')
      await convexUnlink({ businessId, connectionId, clientId: item.clientId })
    },
    onSuccess: () => setConfirming(false),
  })
  const unlinked = unlink.isSuccess
  const xeroName = item.xeroName ?? item.clientName
  // A contact PestM8 added for this very client: unlinking it would only
  // add the client a second time, with a suffix.
  const added = item.how === 'created'

  return (
    <li
      ref={row}
      tabIndex={-1}
      aria-label={item.clientName}
      className="flex items-center gap-3 px-3.5 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue"
    >
      <div className="min-w-0 flex-1">
        <ClientName item={item} />
        <p
          role="status"
          className="text-caption text-ink-2 [overflow-wrap:anywhere]"
        >
          {unlinked
            ? 'Unlinked — PestM8 will add them to Xero as a new contact.'
            : `Is “${xeroName}” in Xero${
                added
                  ? ' · Added by PestM8'
                  : item.how !== 'chosen'
                    ? ''
                    : item.decidedByYou
                      ? ' · Matched by you'
                      : ' · Matched by hand'
              }`}
        </p>
      </div>
      {!unlinked && !added && (
        <button
          type="button"
          disabled={!hydrated}
          onClick={() => {
            unlink.reset()
            setConfirming(true)
          }}
          aria-label={`Unlink ${item.clientName}`}
          className={`${SECONDARY_BUTTON_COMPACT} shrink-0 px-4`}
        >
          Unlink
        </button>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Unlink ${item.clientName}?`}
        body={`PestM8 will add ${item.clientName} to Xero as a new contact instead. You can match them again from Different.`}
        confirm="Unlink"
        cancel="Keep matched"
        onConfirm={() => {
          onPin(item)
          unlink.mutate()
        }}
        // The button goes once it has gone through: to the row instead.
        returnFocus={(confirmed) => (confirmed ? row.current : null)}
        pending={unlink.isPending}
        pendingLabel="Unlinking…"
        closeOnConfirm={false}
        error={
          unlink.isError
            ? describeError(unlink.error, UNLINK_ERROR_COPY)
            : undefined
        }
      />
    </li>
  )
})

/** "#42 · Nightcliff": a client's number and suburb. */
function numberAndSuburb(item: MatchItem): string {
  return [
    typeof item.clientNumber === 'number' ? `#${item.clientNumber}` : null,
    item.clientSuburb,
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * A client new to Xero, as one row of a grouped list: the name, then the
 * number and suburb. Read only: there is nothing in Xero to match it to.
 */
export const ClientRow = memo(function ClientRow({
  item,
}: {
  item: MatchItem
}) {
  const facts = numberAndSuburb(item)
  return (
    <li className="flex min-h-[52px] flex-col justify-center px-3.5 py-2.5">
      <p className="text-body text-ink [overflow-wrap:anywhere]">
        {item.clientName}
      </p>
      {facts && (
        <p className="text-caption text-ink-2 [overflow-wrap:anywhere]">
          {facts}
        </p>
      )}
    </li>
  )
})

/**
 * A client the holder said is a different client, or unlinked, as one row
 * of a grouped list: the name, number and suburb, which contact it isn't —
 * and Match again, which takes that answer back and puts the client To
 * check against the same contact (`xeroMatch.reopen`). That is what makes
 * Different, saved on one tap, safe to offer.
 *
 * No confirm: Match again decides nothing, it only asks again. It fails
 * fast offline, like the answer it takes back. Once done the row stays,
 * saying where the client went, as an answered card does (`MatchCard`).
 */
export const DifferentRow = memo(function DifferentRow({
  businessId,
  connectionId,
  item,
  hydrated,
  onPin,
}: Where & {
  item: MatchItem
  hydrated: boolean
  onPin: (item: MatchItem) => void
}) {
  const row = useRef<HTMLLIElement>(null)
  const convexReopen = useConvexMutation(api.xeroMatch.reopen)
  const reopen = useMutation({
    mutationFn: async () => {
      if (isOffline()) throw new Error('offline')
      return convexReopen({ businessId, connectionId, clientId: item.clientId })
    },
    onSuccess: () => keepFocus(row.current),
  })
  // The contact it was said not to be: the suggestion it was answered on,
  // or the one it was unlinked from.
  const notThem = item.candidate?.name || item.xeroName
  const facts = [
    numberAndSuburb(item),
    notThem ? `Not “${notThem}” in Xero` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const done = reopen.isSuccess

  return (
    <li
      ref={row}
      tabIndex={-1}
      aria-label={item.clientName}
      className="px-3.5 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue"
    >
      <div className="flex min-h-[32px] items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-body text-ink [overflow-wrap:anywhere]">
            {item.clientName}
          </p>
          <p
            role="status"
            className="text-caption text-ink-2 [overflow-wrap:anywhere]"
          >
            {done
              ? reopen.data === 'needs_review'
                ? 'Back under To check.'
                : 'Back under New to Xero.'
              : facts}
          </p>
        </div>
        {!done && (
          <button
            type="button"
            disabled={!hydrated || reopen.isPending}
            onClick={() => {
              onPin(item)
              reopen.mutate()
            }}
            aria-label={`Match ${item.clientName} again`}
            className={`${SECONDARY_BUTTON_COMPACT} shrink-0 px-4`}
          >
            Match again
          </button>
        )}
      </div>
      <FormAlert
        error={reopen.isError ? reopen.error : null}
        copy={REOPEN_ERROR_COPY}
        className="mt-2"
      />
    </li>
  )
})

/** A matched client's name with their number, quieter, beside it. */
function ClientName({ item }: { item: MatchItem }) {
  return (
    <p className="text-body text-ink [overflow-wrap:anywhere]">
      {item.clientName}
      {typeof item.clientNumber === 'number' && (
        <span className="text-muted"> #{item.clientNumber}</span>
      )}
    </p>
  )
}
