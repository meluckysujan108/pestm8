/**
 * How long the words on a payment may be, apart from lib/payments.ts so the
 * form that takes them can stop at the same place without bringing the
 * server's reads to the phone.
 */

/** A receipt or transfer reference, not a paragraph pasted in by mistake. */
export const MAX_REFERENCE_LENGTH = 64

/** Room to say what was agreed: "Sam keeps $50, the rest to Terence". */
export const MAX_HAND_OVER_NOTE_LENGTH = 200
