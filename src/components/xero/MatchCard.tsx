import { memo, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { Check } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { FormAlert } from '#/components/forms/FormAlert'
import { describeError } from '#/components/forms/describeError'
import { Segmented } from '#/components/primitives/Segmented'
import {
  LINK_BUTTON_COMPACT,
  NEUTRAL_BUTTON_COMPACT,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'
import { FIELD_LABEL } from '#/components/settings/ui'
import { isOffline } from '#/lib/online'
import { SameCustomerSheet } from './SameCustomerSheet'
import {
  DECIDE_ERROR_COPY,
  REOPEN_ERROR_COPY,
  UNLINK_ERROR_COPY,
  heldOutcomeCopy,
  matchReasonCopy,
  openClientLabel,
  unlinkSharedBody,
} from './xeroCopy'
import type { HeldOutcome } from './xeroCopy'
import type { ReactNode, Ref } from 'react'
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

/** What a To check card is handed: what to save against, the client, and
 * the list's callbacks — the same functions for every card. */
type CardProps = Where & {
  item: MatchItem
  hydrated: boolean
  /** Keeps the card on screen once answered (`MatchReview`'s pins). */
  onPin: (item: MatchItem) => void
  /** Opens the client's own sheet over the page. */
  onOpenClient: (clientId: Id<'clients'>) => void
}

/**
 * One client PestM8 isn't sure of: the client as PestM8 holds them, above
 * the Xero contact it thinks they might be, and the holder's answer. Most
 * cards ask Same client or Different client (`OpenMatchCard`); a card whose
 * contact another client already has asks something else
 * (`HeldMatchCard`), since Same would be refused.
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
export const MatchCard = memo(function MatchCard(props: CardProps) {
  // A To check row always has its candidate (`xeroMatch.saveProposals`).
  if (!props.item.candidate) return null
  return props.item.heldBy ? (
    <HeldMatchCard {...props} holder={props.item.heldBy} />
  ) : (
    <OpenMatchCard {...props} />
  )
})

/**
 * Same client or Different client, saved the moment it is chosen. Either
 * can be taken back: Same by Unlink under Matched, Different by Match again
 * under Different. Nothing is chosen by the arrow keys (`Segmented`, with
 * nothing chosen yet): only a tap, Space or Enter.
 */
function OpenMatchCard({
  businessId,
  connectionId,
  item,
  hydrated,
  onPin,
}: CardProps) {
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
  if (!contact) return null

  const saved = decide.isSuccess
  const chosen: Choice =
    decide.isPending || decide.isSuccess ? decide.variables : ''

  return (
    <CardFrame ref={card} item={item}>
      {/* Grey-ink, not muted: it is the reason to answer, read in sun. */}
      <p className="mt-3 text-caption text-grey-ink">
        {matchReasonCopy(contact.reason, item.sharedWith?.name)}
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
      <Saved>
        {saved &&
          (decide.variables === 'same'
            ? `Saved — ${item.clientName} is “${contact.name}” in Xero.`
            : heldOutcomeCopy('different', {
                client: item.clientName,
                holder: '',
                contact: contact.name,
              }))}
      </Saved>
    </CardFrame>
  )
}

/**
 * A card whose Xero contact another client (A) already has — so B, this
 * card's client, can't simply be Same: the contact would be two clients'.
 * The card says who has it, with what tells them apart, and asks which
 * they are:
 *
 * - **Different customers** — B gets a contact of its own, saved on the tap
 *   as Different client is, and taken back the same way (Match again).
 * - **Same customer…** — the sheet of what to do about that
 *   (`SameCustomerSheet`): merge B into A, keep both on A's contact, or
 *   give the contact to B.
 * - **Open {B}** — B's own sheet over the page, for when B is just wrong
 *   (a mistyped email that made them look alike): its Edit is there, for
 *   whoever may change clients.
 *
 * Answered, the buttons stay where they were, disabled, so the card keeps
 * its height under the thumb; what was saved is said below them.
 */
function HeldMatchCard({
  businessId,
  connectionId,
  item,
  hydrated,
  onPin,
  onOpenClient,
  holder,
}: CardProps & { holder: NonNullable<MatchItem['heldBy']> }) {
  const card = useRef<HTMLLIElement>(null)
  const same = useRef<HTMLButtonElement>(null)
  // Where the sheet hands focus back: the button that opened it, or the
  // card once the sheet has saved (the button is disabled by then).
  const returnTo = useRef<HTMLElement | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  // Mounted at the first open, then kept, so closing slides it away.
  const [sheetUsed, setSheetUsed] = useState(false)
  const [outcome, setOutcome] = useState<HeldOutcome | null>(null)

  const convexDecide = useConvexMutation(api.xeroMatch.decide)
  const different = useMutation({
    mutationFn: async () => {
      if (isOffline()) throw new Error('offline')
      await convexDecide({
        businessId,
        connectionId,
        clientId: item.clientId,
        choice: 'different',
      })
    },
    onSuccess: () => {
      setOutcome('different')
      keepFocus(card.current)
    },
  })

  const contact = item.candidate
  if (!contact) return null

  const answered = outcome !== null
  const off = !hydrated || different.isPending || answered
  const holderFacts = [
    typeof holder.clientNumber === 'number' ? `#${holder.clientNumber}` : null,
    holder.suburb,
    holder.email,
    holder.phone,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <CardFrame ref={card} item={item}>
      {/* Not a warning: nothing is wrong yet, it is what to answer from. */}
      <div className="mt-3 rounded-xl bg-surface-2 px-3 py-2.5">
        <p className="text-body text-ink [overflow-wrap:anywhere]">
          In PestM8, “{contact.name}” is already {holder.name}
        </p>
        {holderFacts && (
          <p className="text-caption text-ink-2 [overflow-wrap:anywhere]">
            {holderFacts}
          </p>
        )}
      </div>
      <p className="mt-3 text-caption text-grey-ink">
        {matchReasonCopy(contact.reason, item.sharedWith?.name)}
      </p>
      <div
        role="group"
        aria-label={`Is ${item.clientName} the same customer as ${holder.name}?`}
        className="mt-2 flex flex-col gap-2"
      >
        {/* Side by side where both fit, else one above the other: on a
            phone, two halves would wrap "Different customers" inside a
            44px button. */}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={off}
            onClick={() => {
              onPin(item)
              different.mutate()
            }}
            className={`${NEUTRAL_BUTTON_COMPACT} grow whitespace-nowrap px-4`}
          >
            {different.isPending ? 'Saving…' : 'Different customers'}
          </button>
          <button
            ref={same}
            type="button"
            aria-haspopup="dialog"
            disabled={off}
            onClick={() => {
              different.reset()
              returnTo.current = same.current
              setSheetUsed(true)
              setSheetOpen(true)
            }}
            className={`${SECONDARY_BUTTON_COMPACT} grow whitespace-nowrap px-4`}
          >
            Same customer…
          </button>
        </div>
        <button
          type="button"
          // Not once merged: B is in the Recycle bin by then.
          disabled={!hydrated || outcome === 'merge'}
          aria-haspopup="dialog"
          onClick={() => onOpenClient(item.clientId)}
          className={`${LINK_BUTTON_COMPACT} w-full truncate px-4`}
        >
          {openClientLabel(item.clientName)}
        </button>
      </div>
      <FormAlert
        error={different.isError ? different.error : null}
        copy={DECIDE_ERROR_COPY}
        className="mt-2"
      />
      <Saved>
        {outcome &&
          heldOutcomeCopy(outcome, {
            client: item.clientName,
            holder: holder.name,
            contact: contact.name,
          })}
      </Saved>
      {sheetUsed && (
        <SameCustomerSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          businessId={businessId}
          connectionId={connectionId}
          clientId={item.clientId}
          clientName={item.clientName}
          holder={holder}
          contactName={contact.name}
          onPin={() => onPin(item)}
          onDone={(done) => {
            returnTo.current = card.current
            setOutcome(done)
          }}
          returnFocusRef={returnTo}
        />
      )}
    </CardFrame>
  )
}

/**
 * A To check card's frame and what every card shows first: the client as
 * PestM8 holds them, above the Xero contact. Focusable (not a tab stop), as
 * where focus is kept once the card is answered (`keepFocus`).
 */
function CardFrame({
  ref,
  item,
  children,
}: {
  ref: Ref<HTMLLIElement>
  item: MatchItem
  children: ReactNode
}) {
  const contact = item.candidate
  if (!contact) return null
  const xeroFacts = [
    contact.phone,
    contact.place,
    contact.accountNumber ? `Account no. ${contact.accountNumber}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <li
      ref={ref}
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
      {children}
    </li>
  )
}

/**
 * What an answered card saved, with a tick. Mounted with the card, so it is
 * already listening when the answer is saved.
 */
function Saved({ children }: { children: ReactNode }) {
  return (
    <p
      role="status"
      className="empty:hidden mt-2 flex gap-1.5 text-caption text-ink-2"
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

/**
 * A client kept as the same customer as another (Keep both), on that
 * client's Xero contact, as one row of a grouped list: "Uses {A}’s contact".
 * Nothing of its own is sent while it is. **Unlink** asks first, as a
 * matched row's does, and gives it a contact of its own (`xeroMatch.unlink`):
 * it goes to Different, where Match again can ask about it once more.
 */
export const SharedRow = memo(function SharedRow({
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
      if (isOffline()) throw new Error('offline')
      await convexUnlink({ businessId, connectionId, clientId: item.clientId })
    },
    onSuccess: () => setConfirming(false),
  })
  const unlinked = unlink.isSuccess
  // Named by the server; "another client" only if it has gone since.
  const holder = item.sharedWith?.name ?? 'another client'

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
            : `Uses ${holder}’s contact${item.xeroName ? `, “${item.xeroName}”` : ''}`}
        </p>
      </div>
      {!unlinked && (
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
        body={unlinkSharedBody(item.clientName, holder)}
        confirm="Unlink"
        cancel="Keep shared"
        onConfirm={() => {
          onPin(item)
          unlink.mutate()
        }}
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
