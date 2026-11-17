/**
 * How long the words on a payment may be, apart from lib/payments.ts so the
 * form that takes them can stop at the same place without bringing the
 * server's reads to the phone.
 */

/** A receipt or transfer reference, not a paragraph pasted in by mistake. */
export const MAX_REFERENCE_LENGTH = 64

/** Room to say what was agreed: "Sam keeps $50, the rest to Terence". */
export const MAX_HAND_OVER_NOTE_LENGTH = 200

/** A machine's name under Card on a tile: "Square", "Tyro", "ANZ EFTPOS". */
export const MAX_CARD_MACHINE_LENGTH = 30

/**
 * The ways of being paid a business may switch off, in the order Settings →
 * Payments lists them. Invoice and No charge always stay: they say how a job
 * is settled, not what money came in.
 */
export const OFFERABLE_METHODS = [
  'cash',
  'card',
  'bankTransfer',
  'cheque',
  'other',
] as const

export type OfferableMethod = (typeof OFFERABLE_METHODS)[number]

/** What the job sheet offers, as `payments.forJob` sends it. */
export type PaymentsOffered = {
  methods: ReadonlyArray<OfferableMethod>
  cardMachine: string | null
}

/** Everything, as every business had it before there was a choice. */
export const EVERY_METHOD: PaymentsOffered = {
  methods: OFFERABLE_METHODS,
  cardMachine: null,
}

/** What a business offers, from its record. */
export function paymentsOffered(business: {
  paymentMethodsOff?: ReadonlyArray<OfferableMethod>
  cardMachine?: string
}): PaymentsOffered {
  const off = new Set(business.paymentMethodsOff ?? [])
  return {
    methods: OFFERABLE_METHODS.filter((method) => !off.has(method)),
    cardMachine: business.cardMachine ?? null,
  }
}
