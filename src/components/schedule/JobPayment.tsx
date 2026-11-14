import { useId, useRef, useState } from 'react'
import type { ComponentType, RefObject } from 'react'
import { useIsMutating, useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import {
  Banknote,
  Check,
  CreditCard,
  Ellipsis,
  Landmark,
  Receipt,
} from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { LoadFailed } from '#/components/primitives/EmptyState'
import { FormField } from '#/components/forms/FormField'
import { FormAlert } from '#/components/forms/FormAlert'
import { Segmented } from '#/components/primitives/Segmented'
import { Sheet, SheetLock, useSheetLock } from '#/components/primitives/Sheet'
import {
  LINK_BUTTON_COMPACT,
  PRIMARY_BUTTON,
  PRIMARY_BUTTON_COMPACT,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'
import { RowPending } from '#/components/shell/Pending'
import { personLabel } from '#/lib/assignees'
import { formatJobDate, formatMoney } from '#/lib/format'
import { useLineDown } from '#/lib/offline/useLineDown'
import { newRequestId } from '#/lib/outbox/outboxItem'
import {
  PAYMENT_METHOD,
  PAYMENT_STILL_SAVING,
  PAYMENT_WAITS,
  amountHint,
  amountProblem,
  amountText,
  handOverLine,
  lastTimeLine,
  otherMethods,
  parseAmount,
  paymentPhrase,
  paymentQuestion,
  paymentSaveKey,
  paymentTiles,
  receiptDetail,
  receiptTitle,
  recordLabel,
} from '#/lib/payments'
import type {
  OtherMethod,
  PaymentAsk,
  PaymentMethod,
  PaymentTile,
} from '#/lib/payments'
import { useHydrated } from '#/lib/useHydrated'
import { dayKeyOf, startOfDayInZone } from '../../../convex/lib/dates'
import {
  MAX_HAND_OVER_NOTE_LENGTH,
  MAX_REFERENCE_LENGTH,
} from '../../../convex/lib/paymentLimits'
import type { FunctionReturnType } from 'convex/server'
import type { Role } from '../../../convex/lib/capabilities'
import type { Id } from '../../../convex/_generated/dataModel'
import type { ErrorCopy } from '#/components/forms/describeError'

type PaymentsOfJob = NonNullable<FunctionReturnType<typeof api.payments.forJob>>
type PaymentRow = PaymentsOfJob['payments'][number]
type Person = { _id: Id<'memberships'>; name: string; role: Role }

const RECORD_COPY: ErrorCopy = {
  REPORT_REQUIRED:
    'Finalise this job’s report first — your business asks for one before a job is marked complete.',
  default: 'Could not record this payment. Check your signal and try again.',
}
const INVOICE_COPY: ErrorCopy = {
  REPORT_REQUIRED:
    'Finalise this job’s report first — your business asks for one before a job is marked invoiced.',
  default: 'Could not mark this job invoiced. Check your signal and try again.',
}
const REMOVE_COPY: ErrorCopy = {
  NO_ACCESS:
    'Could not remove this payment: only whoever recorded it, or the business owner, can.',
  default: 'Could not remove this payment. Check your signal and try again.',
}
const HAND_OVER_COPY: ErrorCopy = {
  NOT_FOUND:
    'Could not save: one of those people is no longer on the team. Choose someone else.',
  default: 'Could not save this. Check your signal and try again.',
}
const TICK_COPY: ErrorCopy = {
  NO_ACCESS:
    'Could not change this: only the two people it’s between, or the business owner, can.',
  default: 'Could not change this. Check your signal and try again.',
}

const TILE_GLYPH: Record<
  PaymentTile,
  ComponentType<{
    size?: number
    strokeWidth?: number
    className?: string
    'aria-hidden'?: boolean
  }>
> = {
  cash: Banknote,
  card: CreditCard,
  invoice: Receipt,
  bankTransfer: Landmark,
  other: Ellipsis,
}

/**
 * The last thing that happens at the door, so it comes after Report & photos.
 *
 * Recording a payment moves the job's status; the status is never asked for
 * here. It is the last step of finishing a job and never a gate on it:
 * nothing else on the sheet waits for this.
 */
export function JobPaymentSection({
  businessId,
  timezone,
  job,
  ask,
  roster,
  asked,
  headingRef,
  canDeposit = false,
}: {
  businessId: Id<'businesses'>
  timezone: string
  job: {
    _id: Id<'jobs'>
    status: string
    canEdit: boolean
    property?: {
      client?: { name: string; kind: 'person' | 'business' } | null
    } | null
  }
  ask: PaymentAsk
  /** The team, to say whose money it is. Undefined while it loads. */
  roster: ReadonlyArray<Person> | undefined
  /** Goes up each time the status picker sends someone here. */
  asked: number
  headingRef: RefObject<HTMLHeadingElement | null>
  /**
   * Work still ahead that money may be taken for first: a deposit, behind a
   * tap, leaving the job as it is until the work is done.
   */
  canDeposit?: boolean
}) {
  const query = useQuery(
    convexQuery(api.payments.forJob, { businessId, jobId: job._id }),
  )
  const data = query.data
  const hydrated = useHydrated()
  // Billed already: the question waits behind a tap, unless the status
  // picker sent them here to answer it.
  const [tapped, setTapped] = useState(false)
  const [seenAsked, setSeenAsked] = useState(asked)
  if (asked !== seenAsked) {
    setSeenAsked(asked)
    setTapped(true)
  }
  const open = ask === 'open' || (ask === 'onTap' && tapped)
  const [depositing, setDepositing] = useState(false)
  const deposit = ask === 'none' && canDeposit
  const [justRecorded, setJustRecorded] = useState<Id<'payments'> | null>(null)
  const recorded = (paymentId: Id<'payments'>) => {
    setJustRecorded(paymentId)
    setTapped(false)
    setDepositing(false)
  }

  const heading = (
    <h3
      ref={headingRef}
      tabIndex={-1}
      className="section-label mb-2 outline-none"
    >
      Payment
    </h3>
  )

  // Hidden on work still ahead, unless money has already come in on it.
  if (data === null) return null
  if (data === undefined) {
    if (query.isError) {
      return ask === 'none' ? null : (
        <section className="mt-6">
          {heading}
          <LoadFailed
            what="this job’s payments"
            onRetry={() => void query.refetch()}
          />
        </section>
      )
    }
    return ask === 'none' && job.status !== 'paid' && !deposit ? null : (
      <section className="mt-6">
        {heading}
        <div className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
          <RowPending label="Loading payment" />
        </div>
      </section>
    )
  }
  const hidden = data.pricesHidden
  // Asked for only with a price to take part of, and by someone who sees it.
  const takesDeposit = deposit && !hidden && data.owing > 0
  if (ask === 'none' && data.payments.length === 0 && !takesDeposit) {
    return null
  }

  const billed = job.status === 'invoiced'
  const today = dayKeyOf(Date.now(), timezone)
  // A job with no price has nothing to collect, and the server says so.
  const noPrice = !hidden && data.owing === 0 && !data.settled

  return (
    <section className="mt-6">
      {heading}

      <PaymentReceipts
        businessId={businessId}
        jobId={job._id}
        timezone={timezone}
        today={today}
        data={data}
        roster={roster}
        canEdit={job.canEdit}
        justRecorded={justRecorded}
        headingRef={headingRef}
      />

      {data.overpaid > 0 && (
        <p className="mt-2 text-caption text-amber-ink">
          {formatMoney(data.overpaid)} more than the price came in — the client
          is owed that back.
        </p>
      )}

      {ask !== 'none' && noPrice && (
        <NoPricePanel
          businessId={businessId}
          jobId={job._id}
          onRecorded={recorded}
          hasReceipts={data.payments.length > 0}
        />
      )}

      {ask === 'onTap' && !open && !noPrice && (
        <div className={data.payments.length > 0 ? 'mt-3' : ''}>
          <div className="flex items-center gap-3 rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-2 text-ink-2">
              <Receipt size={17} strokeWidth={2} aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-row-title text-ink">
                {hidden ? 'Invoiced' : `${formatMoney(data.owing)} owing`}
              </span>
              <span className="block text-caption text-ink-2">
                {data.payments.length > 0
                  ? 'Part paid, the rest still to come.'
                  : 'Invoiced, waiting to be paid.'}
              </span>
            </span>
          </div>
          <button
            type="button"
            disabled={!hydrated}
            onClick={() => setTapped(true)}
            className={`${LINK_BUTTON_COMPACT} mt-2 w-full`}
          >
            Record a payment
          </button>
        </div>
      )}

      {takesDeposit && (
        <div className={data.payments.length > 0 ? 'mt-3' : ''}>
          {depositing ? (
            <>
              <PaymentAskForm
                businessId={businessId}
                jobId={job._id}
                timezone={timezone}
                hidden={false}
                owing={data.owing}
                paidBefore={data.payments.length > 0}
                billed={false}
                deposit
                question="How was the deposit paid?"
                lastTime={null}
                onRecorded={recorded}
                onInvoiced={() => {}}
              />
              <button
                type="button"
                onClick={() => setDepositing(false)}
                className={`${SECONDARY_BUTTON_COMPACT} mt-2 w-full`}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={!hydrated}
              onClick={() => setDepositing(true)}
              className={`${LINK_BUTTON_COMPACT} w-full`}
            >
              Record a deposit
            </button>
          )}
        </div>
      )}

      {open && !noPrice && (
        <div className={data.payments.length > 0 ? 'mt-4' : ''}>
          <PaymentAskForm
            businessId={businessId}
            jobId={job._id}
            timezone={timezone}
            hidden={hidden}
            owing={data.owing}
            paidBefore={data.payments.length > 0}
            billed={billed}
            question={
              data.payments.length > 0
                ? 'How was the rest paid?'
                : paymentQuestion(job.property?.client)
            }
            lastTime={lastTimeLine(data.lastTime, timezone, today)}
            onRecorded={recorded}
            onInvoiced={() => setTapped(false)}
          />
        </div>
      )}

      <RemovedPayments
        rows={data.removed}
        hidden={hidden}
        timezone={timezone}
        today={today}
      />
    </section>
  )
}

/** Nothing to take: the one thing left to say about it is that it's free. */
function NoPricePanel({
  businessId,
  jobId,
  onRecorded,
  hasReceipts,
}: {
  businessId: Id<'businesses'>
  jobId: Id<'jobs'>
  onRecorded: (id: Id<'payments'>) => void
  hasReceipts: boolean
}) {
  const hydrated = useHydrated()
  const lineDown = useLineDown()
  const convexRecord = useConvexMutation(api.payments.record)
  const requestId = useRef(newRequestId())
  const saving = useIsMutating({ mutationKey: paymentSaveKey(jobId) }) > 0
  const record = useMutation({
    mutationKey: paymentSaveKey(jobId),
    mutationFn: () =>
      convexRecord({
        businessId,
        jobId,
        method: 'noCharge',
        complete: true,
        clientRequestId: requestId.current,
      }),
    onSuccess: ({ paymentId }) => {
      requestId.current = newRequestId()
      onRecorded(paymentId)
    },
  })
  return (
    <div className={hasReceipts ? 'mt-4' : ''}>
      <p className="text-row-title text-ink">No price on this job</p>
      <p className="mb-3 text-caption text-ink-2">
        Close it as No charge, or add a price to record a payment.
      </p>
      <FormAlert
        className="mb-2"
        error={record.isError ? record.error : null}
        copy={RECORD_COPY}
      />
      {lineDown && (
        <p className="mb-2 text-caption text-ink-2">
          {PAYMENT_WAITS[lineDown]}
        </p>
      )}
      <button
        type="button"
        disabled={!hydrated || record.isPending || saving}
        onClick={() => record.mutate()}
        className={`${PRIMARY_BUTTON} w-full`}
      >
        {record.isPending || saving ? 'Recording…' : 'Record no charge'}
      </button>
    </div>
  )
}

/** The question, the four choices, and what the chosen one needs. */
function PaymentAskForm({
  businessId,
  jobId,
  timezone,
  hidden,
  owing,
  paidBefore,
  billed,
  deposit = false,
  question,
  lastTime,
  onRecorded,
  onInvoiced,
}: {
  businessId: Id<'businesses'>
  jobId: Id<'jobs'>
  timezone: string
  hidden: boolean
  owing: number
  paidBefore: boolean
  billed: boolean
  /** Money before the work: no Invoice or No charge, and the job stays. */
  deposit?: boolean
  question: string
  lastTime: string | null
  onRecorded: (id: Id<'payments'>) => void
  onInvoiced: () => void
}) {
  const hydrated = useHydrated()
  const lineDown = useLineDown()
  const id = useId()
  const [tile, setTile] = useState<PaymentTile | null>(null)
  const [other, setOther] = useState<OtherMethod | ''>('')
  // Null until it is typed in, when it follows what is owing.
  const [amountRaw, setAmountRaw] = useState<string | null>(null)
  const [reference, setReference] = useState('')
  const [checkAmount, setCheckAmount] = useState(false)
  // Money that comes in apart from the visit (a transfer landing for an
  // invoice, a deposit taken last week) can be put on the day it came.
  const datesIt = billed || deposit
  const today = dayKeyOf(Date.now(), timezone)
  // Untouched, it is whatever today is when it is sent, not the day the
  // form opened: a form left open past midnight still means today.
  const [paidOnRaw, setPaidOn] = useState<string | null>(null)
  const paidOn = paidOnRaw ?? today
  const paidOnError =
    !datesIt || (paidOn !== '' && paidOn <= today)
      ? null
      : paidOn === ''
        ? 'Choose the day it was paid.'
        : 'Choose a day up to today.'
  // One id for one payment, however often it is sent: changed only when what
  // is being recorded changes, so a save repeated after a lost answer counts
  // once and a corrected amount is a new one.
  const request = useRef<{ key: string; id: string } | null>(null)

  const clear = () => {
    setTile(null)
    setOther('')
    setAmountRaw(null)
    setReference('')
    setCheckAmount(false)
    setPaidOn(null)
    request.current = null
  }

  const convexRecord = useConvexMutation(api.payments.record)
  const record = useMutation({
    mutationKey: paymentSaveKey(jobId),
    mutationFn: (args: {
      method: PaymentMethod
      amount?: number
      reference?: string
      receivedAt?: number
      clientRequestId: string
    }) =>
      convexRecord({
        businessId,
        jobId,
        ...(deposit ? {} : { complete: true }),
        ...args,
      }),
    onSuccess: ({ paymentId }) => {
      clear()
      onRecorded(paymentId)
    },
  })
  const convexInvoice = useConvexMutation(api.payments.markInvoiced)
  const invoice = useMutation({
    mutationKey: paymentSaveKey(jobId),
    mutationFn: () => convexInvoice({ businessId, jobId }),
    onSuccess: () => {
      clear()
      onInvoiced()
    },
  })
  const sentHere = record.isPending || invoice.isPending
  // A save from before this sheet was shut and opened again. A second one
  // now would be a new payment, with the first still to land.
  const sentEarlier = useIsMutating({ mutationKey: paymentSaveKey(jobId) }) > 0
  const busy = sentHere || sentEarlier

  // Something typed is not lost to a swipe; while it saves, ✕ just closes.
  useSheetLock((amountRaw !== null || reference !== '') && !busy, {
    whileUnchanged: false,
  })

  const method: PaymentMethod | null =
    tile === null || tile === 'invoice'
      ? null
      : tile === 'other'
        ? other === ''
          ? null
          : other
        : tile
  const showsAmount = method !== null && method !== 'noCharge' && !hidden
  const showsReference =
    method === 'bankTransfer' || method === 'cheque' || method === 'other'
  const cents = amountRaw === null ? owing : parseAmount(amountRaw)
  const amountError = checkAmount ? amountProblem(cents, owing) : null

  const choose = (next: PaymentTile) => {
    record.reset()
    invoice.reset()
    if (next === tile) {
      setTile(null)
      return
    }
    setTile(next)
    setOther('')
  }

  const submit = () => {
    if (busy) return
    if (tile === 'invoice') {
      invoice.mutate()
      return
    }
    if (method === null) return
    if (showsAmount && amountProblem(cents, owing) !== null) {
      setCheckAmount(true)
      return
    }
    if (paidOnError !== null) return
    const words = showsReference ? reference.trim() : ''
    // Today is now, as at the door; an earlier day is its middle, so no
    // zone puts it on the day before.
    const receivedAt =
      datesIt && paidOn < today
        ? startOfDayInZone(paidOn, timezone) + 12 * 60 * 60 * 1000
        : undefined
    const key = JSON.stringify([
      method,
      showsAmount ? cents : null,
      words,
      receivedAt ?? null,
    ])
    if (request.current?.key !== key) {
      request.current = { key, id: newRequestId() }
    }
    record.mutate({
      method,
      clientRequestId: request.current.id,
      ...(showsAmount && cents !== null ? { amount: cents } : {}),
      ...(words ? { reference: words } : {}),
      ...(receivedAt !== undefined ? { receivedAt } : {}),
    })
  }

  const tiles = paymentTiles(billed, deposit)
  const ready = tile === 'invoice' || method !== null
  const waitId = `${id}-waits`
  const otherId = `${id}-other`

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <div className="mb-2.5 flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="text-row-title text-ink">{question}</p>
          {lastTime && <p className="text-caption text-muted">{lastTime}</p>}
        </div>
        <span className="shrink-0 text-metric-sm text-ink">
          {hidden ? '—' : formatMoney(owing)}
        </span>
      </div>

      {sentEarlier && !sentHere && (
        <p className="mb-2.5 text-caption text-ink-2">
          {lineDown ? PAYMENT_WAITS[lineDown] : PAYMENT_STILL_SAVING}
        </p>
      )}

      <div
        role="group"
        aria-label={question}
        className="grid grid-cols-2 gap-2"
      >
        {tiles.map(({ tile: value, title, line }) => {
          const on = tile === value
          const Glyph = TILE_GLYPH[value]
          return (
            <button
              key={value}
              type="button"
              aria-pressed={on}
              disabled={!hydrated || busy}
              onClick={() => choose(value)}
              className={`relative flex min-h-[76px] flex-col items-start gap-0.5 rounded-xl border p-3 text-left transition active:scale-[.97] disabled:opacity-50 ${
                on ? 'border-blue bg-blue/8' : 'border-hairline bg-surface'
              }`}
            >
              <Glyph
                size={20}
                strokeWidth={1.7}
                aria-hidden
                className="text-ink-2"
              />
              <span className="mt-1.5 text-row-title text-ink">{title}</span>
              <span className="text-caption text-ink-2">{line}</span>
              {on && (
                <Check
                  size={17}
                  strokeWidth={2.2}
                  aria-hidden
                  className="absolute right-2.5 top-2.5 text-blue"
                />
              )}
            </button>
          )
        })}
      </div>

      {tile === 'other' && (
        <div className="mt-3.5 flex flex-col gap-1.5">
          <span id={otherId} className="section-label">
            How they paid
          </span>
          <Segmented
            kind="choice"
            labelledBy={otherId}
            value={other}
            options={otherMethods(billed, deposit)}
            disabled={!hydrated || busy}
            onChange={(next) => {
              record.reset()
              setOther(next)
            }}
          />
        </div>
      )}

      {ready && (
        <div className="mt-3.5 flex flex-col gap-3">
          {showsAmount && (
            <FormField
              id={`${id}-amount`}
              label="Amount (AUD)"
              error={amountError}
              hint={
                amountError ? undefined : amountHint(cents, owing, paidBefore)
              }
            >
              {(control) => (
                <input
                  {...control}
                  type="text"
                  inputMode="decimal"
                  enterKeyHint="done"
                  autoComplete="off"
                  disabled={busy}
                  value={amountRaw ?? amountText(owing)}
                  onChange={(event) => setAmountRaw(event.target.value)}
                  onBlur={() => setCheckAmount(amountRaw !== null)}
                />
              )}
            </FormField>
          )}

          {datesIt && method !== null && (
            <FormField
              id={`${id}-paid-on`}
              label="Paid on"
              error={paidOnError}
              hint={paidOnError ? undefined : 'The day the money came in.'}
            >
              {(control) => (
                <input
                  {...control}
                  type="date"
                  max={today}
                  disabled={busy}
                  value={paidOn}
                  onChange={(event) => setPaidOn(event.target.value)}
                />
              )}
            </FormField>
          )}

          {showsReference && (
            <FormField id={`${id}-reference`} label="Reference (optional)">
              {(control) => (
                <input
                  {...control}
                  type="text"
                  autoComplete="off"
                  enterKeyHint="done"
                  maxLength={MAX_REFERENCE_LENGTH}
                  placeholder="Receipt or transfer number"
                  disabled={busy}
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                />
              )}
            </FormField>
          )}

          {tile === 'invoice' && (
            <p className="text-caption text-ink-2">
              It shows as owing until a payment is recorded.
            </p>
          )}
          {deposit && method !== null && (
            <p className="text-caption text-ink-2">
              Taken before the work, so the job stays as it is until it’s done.
            </p>
          )}
          {method === 'noCharge' && (
            <p className="text-caption text-ink-2">
              For a warranty re-treat or a call-back. Closes the job at no
              charge.
            </p>
          )}
          {hidden && method !== null && method !== 'noCharge' && (
            <p className="text-caption text-ink-2">
              Recorded as the full amount owing.
            </p>
          )}

          <FormAlert
            error={record.isError ? record.error : null}
            copy={RECORD_COPY}
          />
          <FormAlert
            error={invoice.isError ? invoice.error : null}
            copy={INVOICE_COPY}
          />

          <div>
            {lineDown && (
              <p id={waitId} className="mb-2 text-caption text-ink-2">
                {PAYMENT_WAITS[lineDown]}
              </p>
            )}
            <button
              type="submit"
              disabled={!hydrated || busy}
              aria-describedby={lineDown ? waitId : undefined}
              className={`${PRIMARY_BUTTON} w-full`}
            >
              {invoice.isPending
                ? 'Marking invoiced…'
                : record.isPending
                  ? 'Recording…'
                  : tile === 'invoice'
                    ? 'Mark invoiced'
                    : recordLabel(
                        method as PaymentMethod,
                        showsAmount ? cents : null,
                        hidden,
                      )}
            </button>
          </div>
        </div>
      )}
    </form>
  )
}

/** Each payment as it was taken, who took it, and whose it is. */
function PaymentReceipts({
  businessId,
  jobId,
  timezone,
  today,
  data,
  roster,
  canEdit,
  justRecorded,
  headingRef,
}: {
  businessId: Id<'businesses'>
  jobId: Id<'jobs'>
  timezone: string
  today: string
  data: PaymentsOfJob
  roster: ReadonlyArray<Person> | undefined
  canEdit: boolean
  justRecorded: Id<'payments'> | null
  headingRef: RefObject<HTMLHeadingElement | null>
}) {
  const hydrated = useHydrated()
  const [confirming, setConfirming] = useState<PaymentRow | null>(null)
  const [marking, setMarking] = useState<{
    row: PaymentRow
    opened: number
  } | null>(null)
  const [markOpen, setMarkOpen] = useState(false)

  const convexRemove = useConvexMutation(api.payments.remove)
  const remove = useMutation({
    mutationFn: (paymentId: Id<'payments'>) =>
      convexRemove({ businessId, jobId, paymentId }),
    onSuccess: () => setConfirming(null),
  })
  const convexTick = useConvexMutation(api.payments.setHandOverDone)
  const tick = useMutation({
    mutationFn: (args: { paymentId: Id<'payments'>; done: boolean }) =>
      convexTick({
        businessId,
        paymentIds: [args.paymentId],
        done: args.done,
      }),
  })

  const hidden = data.pricesHidden
  const canMark = canEdit && (roster?.length ?? 0) > 1
  const startMarking = (row: PaymentRow) => {
    setMarking((was) => ({ row, opened: (was?.opened ?? 0) + 1 }))
    setMarkOpen(true)
  }

  return (
    <>
      {data.payments.length > 0 && (
        <div className="divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
          {data.payments.map((row) => {
            const just = row._id === justRecorded
            return (
              <div key={row._id} className="flex items-start gap-3 px-3.5 py-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-green-bg text-green-ink">
                  <Check size={17} strokeWidth={2.2} aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-row-title text-ink">
                    {receiptTitle(row, hidden)}
                  </p>
                  <p className="text-caption text-ink-2">
                    {receiptDetail(row, timezone, today)}
                  </p>

                  {row.handOver ? (
                    <div className="mt-2 rounded-lg bg-surface-2 px-3 py-2">
                      <p className="text-caption font-semibold text-ink">
                        {handOverLine(
                          row.handOver,
                          row.recordedBy,
                          timezone,
                          today,
                        )}
                      </p>
                      {row.handOver.note && (
                        <p className="text-caption text-ink-2">
                          {row.handOver.note}
                        </p>
                      )}
                      <div className="mt-1 flex flex-wrap gap-x-5">
                        {row.handOver.canTick && (
                          <button
                            type="button"
                            disabled={!hydrated || tick.isPending}
                            onClick={() =>
                              tick.mutate({
                                paymentId: row._id,
                                done: row.handOver?.doneAt === null,
                              })
                            }
                            className="relative tap-target text-caption font-semibold text-blue disabled:opacity-50"
                          >
                            {row.handOver.doneAt === null
                              ? 'Mark handed over'
                              : 'Not handed over yet'}
                          </button>
                        )}
                        {canEdit && row.handOver.doneAt === null && (
                          <button
                            type="button"
                            disabled={!hydrated}
                            onClick={() => startMarking(row)}
                            className="relative tap-target text-caption font-semibold text-blue disabled:opacity-50"
                          >
                            Change
                          </button>
                        )}
                      </div>
                    </div>
                  ) : (
                    canMark &&
                    row.method !== 'noCharge' && (
                      <button
                        type="button"
                        disabled={!hydrated}
                        onClick={() => startMarking(row)}
                        className="relative tap-target mt-1 text-caption font-semibold text-blue disabled:opacity-50"
                      >
                        Mark to hand over
                      </button>
                    )
                  )}
                </div>

                {row.canRemove && (
                  <button
                    type="button"
                    disabled={!hydrated || remove.isPending}
                    onClick={() => {
                      remove.reset()
                      if (just) remove.mutate(row._id)
                      else setConfirming(row)
                    }}
                    className="relative tap-target shrink-0 text-body font-semibold text-blue disabled:opacity-50"
                  >
                    {just ? (remove.isPending ? 'Undoing…' : 'Undo') : 'Remove'}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      <FormAlert
        className="mt-2"
        error={remove.isError ? remove.error : null}
        copy={REMOVE_COPY}
      />
      <FormAlert
        className="mt-2"
        error={tick.isError ? tick.error : null}
        copy={TICK_COPY}
      />

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title="Remove this payment?"
        body={
          confirming && (
            <>
              {paymentPhrase(confirming, hidden)} comes off this job, and its
              status follows. The job keeps a record of who removed it.
            </>
          )
        }
        cancel="Keep payment"
        confirm="Remove"
        pending={remove.isPending}
        pendingLabel="Removing…"
        returnFocus={() => headingRef.current}
        onConfirm={() => confirming && remove.mutate(confirming._id)}
      />

      {marking && (
        <HandOverSheet
          key={`${marking.row._id}:${marking.opened}`}
          open={markOpen}
          onClose={() => setMarkOpen(false)}
          businessId={businessId}
          jobId={jobId}
          payment={marking.row}
          hidden={hidden}
          roster={roster ?? []}
        />
      )}
    </>
  )
}

/**
 * Whose money it is, for when a job crossed over: the owner's job given to a
 * subcontractor, or the other way round. It keeps track and nothing more. It
 * is a mark and never a rule, so anyone who can edit the job can make it and
 * nobody is made to.
 */
function HandOverSheet({
  open,
  onClose,
  businessId,
  jobId,
  payment,
  hidden,
  roster,
}: {
  open: boolean
  onClose: () => void
  businessId: Id<'businesses'>
  jobId: Id<'jobs'>
  payment: PaymentRow
  hidden: boolean
  roster: ReadonlyArray<Person>
}) {
  const id = useId()
  const hydrated = useHydrated()
  const marked = payment.handOver
  const [from, setFrom] = useState<string>(marked?.from ?? payment.recordedBy)
  const [to, setTo] = useState<string>(marked?.to ?? '')
  const [note, setNote] = useState(marked?.note ?? '')
  const [checked, setChecked] = useState(false)

  const convexSet = useConvexMutation(api.payments.setHandOver)
  const save = useMutation({
    mutationFn: (
      handOver: {
        from: Id<'memberships'>
        to: Id<'memberships'>
        note?: string
      } | null,
    ) => convexSet({ businessId, jobId, paymentId: payment._id, handOver }),
    onSuccess: onClose,
  })

  const changed =
    from !== (marked?.from ?? payment.recordedBy) ||
    to !== (marked?.to ?? '') ||
    note !== (marked?.note ?? '')

  const toError = checked && to === '' ? 'Choose who it goes to.' : null
  // Someone since taken off the team is still named on a mark made before.
  const options = (
    keep: string | undefined,
    name: string | null | undefined,
  ) => [
    ...roster.map((person) => ({
      value: person._id,
      label: personLabel(person),
    })),
    ...(keep && !roster.some((person) => person._id === keep)
      ? [{ value: keep, label: name ?? 'No longer on the team' }]
      : []),
  ]
  const fromOptions = options(
    marked?.from ?? payment.recordedBy,
    marked?.fromName ?? payment.recordedByName,
  )
  const toOptions = options(marked?.to, marked?.toName).filter(
    (option) => option.value !== from,
  )

  const submit = () => {
    if (to === '' || to === from) {
      setChecked(true)
      if (to === from) setTo('')
      return
    }
    save.mutate({
      from: from as Id<'memberships'>,
      to: to as Id<'memberships'>,
      ...(note.trim() ? { note: note.trim() } : {}),
    })
  }

  const describe = `${paymentPhrase(payment, hidden)} · ${
    payment.recordedByName ?? 'Recorded earlier'
  }`

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Mark to hand over"
      description={describe}
      footer={
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!hydrated || save.isPending}
            onClick={submit}
            className={`${PRIMARY_BUTTON_COMPACT} flex-1`}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      }
    >
      <SheetLock changed={changed && !save.isPending} whileUnchanged={false} />
      <p className="text-caption text-ink-2">
        For when a job crossed over and this money is someone else’s. It only
        keeps track — PestM8 doesn’t move any money.
      </p>
      <div className="mt-3 flex flex-col gap-3">
        <FormField id={`${id}-from`} label="Who has it">
          {(control) => (
            <select
              {...control}
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            >
              {fromOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField id={`${id}-to`} label="Hand over to" error={toError}>
          {(control) => (
            <select
              {...control}
              value={to === from ? '' : to}
              onChange={(event) => setTo(event.target.value)}
            >
              <option value="" disabled>
                Choose someone
              </option>
              {toOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </FormField>
        <FormField id={`${id}-note`} label="Note (optional)">
          {(control) => (
            <input
              {...control}
              type="text"
              autoComplete="off"
              enterKeyHint="done"
              autoCapitalize="sentences"
              maxLength={MAX_HAND_OVER_NOTE_LENGTH}
              placeholder="Half to the office, the rest to keep"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          )}
        </FormField>
        <FormAlert
          error={save.isError ? save.error : null}
          copy={HAND_OVER_COPY}
        />
        {marked && (
          <button
            type="button"
            disabled={!hydrated || save.isPending}
            onClick={() => save.mutate(null)}
            className={`${SECONDARY_BUTTON_COMPACT} w-full`}
          >
            Remove this mark
          </button>
        )}
      </div>
    </Sheet>
  )
}

/** What was taken back, out of the way until someone asks. */
function RemovedPayments({
  rows,
  hidden,
  timezone,
  today,
}: {
  rows: PaymentsOfJob['removed']
  hidden: boolean
  timezone: string
  today: string
}) {
  const [shown, setShown] = useState(false)
  if (rows.length === 0) return null
  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={shown}
        onClick={() => setShown((was) => !was)}
        className="relative tap-target text-caption font-semibold text-blue"
      >
        {shown
          ? 'Hide removed'
          : `Show ${rows.length} removed ${rows.length === 1 ? 'payment' : 'payments'}`}
      </button>
      {shown && (
        <ul className="mt-1 flex flex-col gap-1">
          {rows.map((row) => (
            <li key={row._id} className="text-caption text-ink-2">
              {PAYMENT_METHOD[row.method].label}
              {!hidden && row.method !== 'noCharge'
                ? ` ${formatMoney(row.amount)}`
                : ''}
              {' · '}removed by {row.removedByName ?? 'someone'}
              {row.removedAt !== null &&
                ` · ${formatJobDate(dayKeyOf(row.removedAt, timezone), today)}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
