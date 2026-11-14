/**
 * What the job sheet's Payment section and a job's card say about money, in
 * words. Pure, and nothing from `#/`, so the rules can be tested alone and e2e
 * can import the words it looks for.
 *
 * Which status money gives a job is `convex/lib/jobStatus.ts` and only there.
 */

import {
  dayKeyToDate,
  formatJobDate,
  formatMoney,
  formatMonthLabel,
  formatTime,
  formatUpdated,
} from './format'
import { firstName } from './jobPeople'
import { dayKeyOf } from '../../convex/lib/dates'
import type { Doc } from '../../convex/_generated/dataModel'

export type PaymentMethod = Doc<'payments'>['method']

/** `word` fits a sentence ("Paid by cash"); `Other` and `No charge` don't. */
export const PAYMENT_METHOD: Record<
  PaymentMethod,
  { label: string; word: string | null }
> = {
  cash: { label: 'Cash', word: 'cash' },
  card: { label: 'Card', word: 'card' },
  bankTransfer: { label: 'Bank transfer', word: 'bank transfer' },
  cheque: { label: 'Cheque', word: 'cheque' },
  other: { label: 'Other', word: null },
  noCharge: { label: 'No charge', word: null },
}

/**
 * Whether the question is asked, and how loudly. `open` where nobody has said
 * yet: a visit's day has come, or the work is done. `onTap` once it is billed,
 * when the answer comes later and the sheet is opened for other reasons too.
 * `none` on work still ahead, on money that is settled, and for anyone who
 * can only read the job.
 */
export type PaymentAsk = 'open' | 'onTap' | 'none'

export function paymentAsk(
  job: { status: string; canEdit: boolean },
  jobDay: string,
  today: string,
): PaymentAsk {
  if (!job.canEdit) return 'none'
  if (job.status === 'paid' || job.status === 'cancelled') return 'none'
  if (job.status === 'invoiced') return 'onTap'
  if (job.status === 'completed') return 'open'
  return jobDay <= today ? 'open' : 'none'
}

/** The four big choices. `invoice` records no money, so it is not a method. */
export type PaymentTile = 'cash' | 'card' | 'invoice' | 'bankTransfer' | 'other'

export type OtherMethod = Extract<
  PaymentMethod,
  'bankTransfer' | 'cheque' | 'other' | 'noCharge'
>

/**
 * Once it has been billed, Invoice has been answered, and what is most likely
 * still to come is the transfer it asked for. A deposit is money taken before
 * the work, so it has no Invoice either, and nothing to give away for free.
 */
export function paymentTiles(
  billed: boolean,
  deposit = false,
): ReadonlyArray<{
  tile: PaymentTile
  title: string
  line: string
}> {
  const later = billed || deposit
  return [
    { tile: 'cash', title: 'Cash', line: 'Paid now' },
    { tile: 'card', title: 'Card', line: 'EFTPOS machine' },
    later
      ? { tile: 'bankTransfer', title: 'Transfer', line: 'Bank transfer' }
      : { tile: 'invoice', title: 'Invoice', line: 'Pays later' },
    {
      tile: 'other',
      title: 'Other',
      line: deposit
        ? 'Cheque or other'
        : billed
          ? 'Cheque, no charge'
          : 'Transfer, cheque, no charge',
    },
  ]
}

export function otherMethods(
  billed: boolean,
  deposit = false,
): Array<{ value: OtherMethod; label: string }> {
  return [
    ...(billed || deposit
      ? []
      : [{ value: 'bankTransfer' as const, label: 'Transfer' }]),
    { value: 'cheque' as const, label: 'Cheque' },
    { value: 'other' as const, label: 'Other' },
    ...(deposit ? [] : [{ value: 'noCharge' as const, label: 'No charge' }]),
  ]
}

/**
 * "How did Jan pay?", or "they" for a business, whose name is not someone to
 * ask, and for a name saved as "J. Nguyen", whose initial isn't one either.
 */
export function paymentQuestion(
  client: { name: string; kind: 'person' | 'business' } | null | undefined,
): string {
  const first = client?.kind === 'person' ? firstName(client.name).trim() : ''
  return first.replace('.', '').length > 1
    ? `How did ${first} pay?`
    : 'How did they pay?'
}

export function lastTimeLine(
  last: { method: PaymentMethod; receivedAt: number } | null | undefined,
  timezone: string,
  today: string,
): string | null {
  if (!last) return null
  const day = formatJobDate(dayKeyOf(last.receivedAt, timezone), today)
  return `Last time: ${PAYMENT_METHOD[last.method].label} · ${day}`
}

/**
 * Cents from what was typed, or null for what isn't an amount. A leading "$"
 * and thousands commas are what people type; anything past two decimals is
 * not a sum of money.
 */
export function parseAmount(raw: string): number | null {
  const cleaned = raw
    .trim()
    .replace(/^\$\s*/, '')
    .replace(/,/g, '')
  if (!/^(\d+(\.\d{0,2})?|\.\d{1,2})$/.test(cleaned)) return null
  return Math.round(Number(cleaned) * 100)
}

/** The field as it first reads: "220.00". */
export function amountText(cents: number): string {
  return (cents / 100).toFixed(2)
}

/** Why an amount can't be recorded, or null if it can. */
export function amountProblem(
  cents: number | null,
  owing: number,
): string | null {
  if (cents === null) return 'Enter an amount, like 120 or 120.50.'
  if (cents <= 0) return 'Enter more than $0.'
  if (cents > owing) return `That’s more than the ${formatMoney(owing)} owing.`
  return null
}

export function amountHint(
  cents: number | null,
  owing: number,
  paidBefore: boolean,
): string {
  if (cents !== null && cents > 0 && cents < owing) {
    return `Leaves ${formatMoney(owing - cents)} owing.`
  }
  return paidBefore
    ? 'What’s still owing. Change it for a part payment.'
    : 'The job’s price. Change it for a part payment.'
}

/**
 * The button, saying exactly what it will save: "Record $220 cash". Someone
 * who can't see the price still records "Record cash, paid in full".
 */
export function recordLabel(
  method: PaymentMethod,
  cents: number | null,
  pricesHidden: boolean,
): string {
  if (method === 'noCharge') return 'Record no charge'
  const word =
    method === 'bankTransfer' ? 'transfer' : PAYMENT_METHOD[method].word
  if (pricesHidden) {
    return word
      ? `Record ${word}, paid in full`
      : 'Record payment, paid in full'
  }
  const money = cents !== null && cents > 0 ? formatMoney(cents) : null
  if (money && word) return `Record ${money} ${word}`
  if (money) return `Record ${money}`
  return word ? `Record ${word}` : 'Record payment'
}

/**
 * Every save of a job's money, so a sheet opened again can see one that is
 * still out: closing a sheet does not stop a save, and one held for signal
 * has left nothing on the job yet to say it was made.
 */
export const paymentSaveKey = (jobId: string) =>
  ['payments', 'save', jobId] as const

/** Over the choices while an earlier save is out and the line is up. */
export const PAYMENT_STILL_SAVING = 'Saving the payment you recorded…'

/** Above a save the Convex client holds until the line is back. */
export const PAYMENT_WAITS = {
  'no-signal':
    'No signal — the payment is saved when you have signal. Keep PestM8 open until then.',
  unreachable:
    'Could not reach PestM8 — it’s saved once it can. Keep PestM8 open until then.',
} as const

/** A line that wraps ends on the dot and never starts the next one with it. */
const BETWEEN = '\u00a0· '

type Receipt = {
  method: PaymentMethod
  amount: number
  deposit: boolean
  receivedAt: number
  /** Put on a day ("Paid on"): its time means nothing, so none is said. */
  dayOnly: boolean
  recordedByName: string | null
  reference: string | null
}

/** "Paid $220", or with the price hidden, just that it was. */
export function receiptTitle(payment: Receipt, pricesHidden: boolean): string {
  if (payment.method === 'noCharge') return 'No charge'
  const verb = payment.deposit ? 'Deposit' : 'Paid'
  return pricesHidden ? verb : `${verb} ${formatMoney(payment.amount)}`
}

/** "Cash · 10:34am · Sam Lee", with the day when it wasn't today. */
export function receiptDetail(
  payment: Receipt,
  timezone: string,
  today: string,
): string {
  return [
    payment.method === 'noCharge' ? null : PAYMENT_METHOD[payment.method].label,
    payment.dayOnly
      ? formatJobDate(dayKeyOf(payment.receivedAt, timezone), today)
      : formatUpdated(payment.receivedAt, timezone, today),
    payment.recordedByName,
    payment.reference ? `Ref ${payment.reference}` : null,
  ]
    .filter((part) => part !== null)
    .join(BETWEEN)
}

/** "$220 cash", as the question about taking one back names it. */
export function paymentPhrase(
  payment: Pick<Receipt, 'method' | 'amount'>,
  pricesHidden: boolean,
): string {
  const { label, word } = PAYMENT_METHOD[payment.method]
  if (payment.method === 'noCharge') return 'The no charge'
  if (pricesHidden) return `The ${word ?? label.toLowerCase()} payment`
  return [formatMoney(payment.amount), word].filter(Boolean).join(' ')
}

/** Who a hand-over is to, and whether it has happened. */
export function handOverLine(
  mark: {
    from: string
    fromName: string | null
    toName: string | null
    doneAt: number | null
  },
  recordedBy: string,
  timezone: string,
  today: string,
): string {
  const to = mark.toName ?? 'someone no longer on the team'
  if (mark.doneAt !== null) {
    const day = formatJobDate(dayKeyOf(mark.doneAt, timezone), today)
    return `Handed over to ${to}${BETWEEN}${day}`
  }
  // Only worth saying when it isn't whoever is named on the receipt above.
  return mark.from !== recordedBy && mark.fromName
    ? `With ${mark.fromName}, to hand over to ${to}`
    : `To hand over to ${to}`
}

function listOf(words: ReadonlyArray<string>): string {
  if (words.length < 2) return words.join('')
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

/** A job's money as its row carries it (`paymentOnCard`). */
export type CardPayment = {
  methods: ReadonlyArray<PaymentMethod>
  paid: number
  owing: number
}

/**
 * The line by a card's price: how it was paid, or what's owing. `quiet` is
 * for what can be skipped when scanning a day. Absent from a backend older
 * than this, and a phone's older kept copy, when the card says nothing rather
 * than "No payment recorded", which it would not know.
 */
export function paymentCardLine(
  status: string,
  payment: CardPayment | undefined,
  pricesHidden: boolean,
): { text: string; quiet: boolean } | null {
  if (!payment) return null
  const taken = payment.methods.filter((method) => method !== 'noCharge')
  if (status === 'paid') {
    if (taken.length === 0) return { text: 'No charge', quiet: false }
    const words = taken.flatMap((method) => PAYMENT_METHOD[method].word ?? [])
    return {
      text: words.length > 0 ? `Paid by ${listOf(words)}` : 'Paid',
      quiet: false,
    }
  }
  if (status !== 'invoiced' && status !== 'completed') return null
  if (status === 'completed' && taken.length === 0) {
    return { text: 'No payment recorded', quiet: true }
  }
  if (pricesHidden) {
    return taken.length > 0 ? { text: 'Part paid', quiet: false } : null
  }
  const { paid, owing } = payment
  if (status === 'completed') {
    return {
      text: `${formatMoney(paid)} deposit · ${formatMoney(owing)} to bill`,
      quiet: false,
    }
  }
  if (paid > 0) {
    return {
      text: `${formatMoney(paid)} paid · ${formatMoney(owing)} owing`,
      quiet: false,
    }
  }
  return owing > 0
    ? { text: `${formatMoney(owing)} owing`, quiet: false }
    : null
}

// ——— The Payments page ———

export type PaymentsTab = 'owing' | 'toBill' | 'paid'

export const PAYMENTS_TABS: Array<{ value: PaymentsTab; label: string }> = [
  { value: 'owing', label: 'Owing' },
  { value: 'toBill', label: 'To bill' },
  { value: 'paid', label: 'Paid' },
]

const DAY_MS = 24 * 60 * 60 * 1000

/** "1 job", "9 jobs": digits, as every count in the app. */
export function jobsWord(count: number): string {
  return `${count} ${count === 1 ? 'job' : 'jobs'}`
}

function daysWord(days: number): string {
  return `${days} ${days === 1 ? 'day' : 'days'}`
}

/**
 * Under the Owing total: how many, and how long the oldest bill has waited.
 * "9 jobs · oldest 34 days", "1 job · billed 34 days ago". Null with nothing
 * owing, or with the count withheld. Days are calendar days in the
 * business's zone: billed at 5pm yesterday is a day ago at 9am today.
 */
export function owingCaption(
  count: number | null,
  since: number | null,
  opts: { timezone: string; today: string },
): string | null {
  if (count === null || count === 0) return null
  if (since === null) return jobsWord(count)
  const days = Math.max(
    0,
    Math.round(
      (dayKeyToDate(opts.today).getTime() -
        dayKeyToDate(dayKeyOf(since, opts.timezone)).getTime()) /
        DAY_MS,
    ),
  )
  const age =
    count === 1
      ? days === 0
        ? 'billed today'
        : `billed ${daysWord(days)} ago`
      : days === 0
        ? 'all billed today'
        : `oldest ${daysWord(days)}`
  return `${jobsWord(count)}${BETWEEN}${age}`
}

/** Under the To bill total. */
export function toBillCaption(count: number | null): string | null {
  if (count === null || count === 0) return null
  return `${jobsWord(count)} done, not billed`
}

/** A job waiting to be billed or paid, as its row on the Payments page has it. */
export type OutstandingRow = {
  jobNumber: number | null
  scheduledAt: number
  completedAt: number | null
  invoicedAt: number | null
  price: number
  paid: number
  leadName: string | null
}

/**
 * Under the client's name on an Owing or To bill row:
 * "#2391 · Sam Lee · invoiced Fri 2 Oct", "#2402 · $150 of $350 paid",
 * "#2421 · done Mon 2 Nov", "#2433 · $100 deposit". The lead is named only
 * where the list holds more than one person's work.
 */
export function outstandingCaption(
  row: OutstandingRow,
  list: 'owing' | 'toBill',
  opts: {
    timezone: string
    today: string
    showLead: boolean
    pricesHidden: boolean
  },
): string {
  const day = (ts: number) =>
    formatJobDate(dayKeyOf(ts, opts.timezone), opts.today)
  let state: string
  if (!opts.pricesHidden && row.paid > 0) {
    state =
      list === 'owing'
        ? `${formatMoney(row.paid)} of ${formatMoney(row.price)} paid`
        : `${formatMoney(row.paid)} deposit`
  } else if (list === 'owing') {
    // Billed before invoices were dated: the visit is the nearest it says.
    state =
      row.invoicedAt === null
        ? `visited ${day(row.scheduledAt)}`
        : `invoiced ${day(row.invoicedAt)}`
  } else {
    state = `done ${day(row.completedAt ?? row.scheduledAt)}`
  }
  return [
    row.jobNumber === null ? null : `#${row.jobNumber}`,
    // First names, as a card names people: the line is short on a phone.
    opts.showLead && row.leadName ? firstName(row.leadName) : null,
    state,
  ]
    .filter((part) => part !== null && part !== '')
    .join(BETWEEN)
}

/**
 * The line under an Owing or To bill list: where counting starts, and what it
 * leaves out. "Counting work from Thu 12 Nov. 117 older jobs not counted."
 */
export function countsFromLine(
  countsFrom: number | null,
  older: number | null,
  timezone: string,
  today: string,
): string {
  if (countsFrom === null) return 'Counting every job.'
  const day = formatJobDate(dayKeyOf(countsFrom, timezone), today)
  const left =
    older === null || older === 0
      ? ''
      : ` ${older} older ${older === 1 ? 'job' : 'jobs'} not counted.`
  return `Counting work from ${day}.${left}`
}

/** A payment as its row on the Paid list has it. */
export type PaidRow = {
  jobNumber: number | null
  method: PaymentMethod
  receivedAt: number
  /** Put on a day: the list's day heading says all there is. */
  dayOnly: boolean
  reference: string | null
  deposit: boolean
  whoseName: string | null
  handOverTo: string | null
}

/**
 * "#2418 · Cash · 10:34am · Sam Lee", then a deposit, a reference, or who it
 * is still to be handed to.
 */
export function paidCaption(
  row: PaidRow,
  opts: { timezone: string; showWhose: boolean },
): string {
  return [
    row.jobNumber === null ? null : `#${row.jobNumber}`,
    PAYMENT_METHOD[row.method].label,
    row.dayOnly ? null : formatTime(row.receivedAt, opts.timezone),
    // Money still to be passed on is the receiver's: the hand-over says so.
    opts.showWhose && row.whoseName && row.handOverTo === null
      ? firstName(row.whoseName)
      : null,
    row.deposit ? 'Deposit' : null,
    row.reference ? `Ref ${row.reference}` : null,
    row.handOverTo ? `To hand over to ${firstName(row.handOverTo)}` : null,
  ]
    .filter((part) => part !== null && part !== '')
    .join(BETWEEN)
}

/** "November", or "November 2025" when it isn't this year. */
export function monthName(monthKey: string, thisMonth: string): string {
  const label = formatMonthLabel(`${monthKey}-01`)
  return monthKey.slice(0, 4) === thisMonth.slice(0, 4)
    ? label.replace(/\s\d{4}$/, '')
    : label
}

/** The month before or after "2026-11". */
export function stepMonth(monthKey: string, by: number): string {
  const [year, month] = monthKey.split('-').map(Number)
  const index = year * 12 + (month - 1) + by
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`
}

/** "Sam Nguyen to you", "You to Terence Walsh", "Sam Nguyen to Terence Walsh". */
export function handOverPair(
  pair: {
    from: string
    to: string
    fromName: string | null
    toName: string | null
  },
  viewer: string | null,
): string {
  const gone = 'someone no longer on the team'
  const from =
    pair.from === viewer
      ? 'You'
      : (pair.fromName ?? 'Someone no longer on the team')
  const to = pair.to === viewer ? 'you' : (pair.toName ?? gone)
  return `${from} to ${to}`
}
