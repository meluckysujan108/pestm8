import type { ErrorCopy } from '#/components/forms/describeError'

/**
 * Merging two clients, in words (convex/clientMerge.ts): B, the one that
 * goes, into A, the one kept. Shared by the two places a merge is offered —
 * the client sheet (Merge into…, and the possible-duplicate line) and
 * Xero's Same customer sheet (components/xero/xeroCopy.ts, which re-exports
 * what it uses from here) — so what a merge moves, and what it does in
 * Xero, is said one way wherever it is asked.
 *
 * Names, never pronouns: "Jane Nguyen’s sites", not "her sites". Curly
 * apostrophes and spaced em dashes. Type imports only, so the Xero pages
 * that read it carry nothing else with it.
 */

/** What merging moves, as `clientMerge.mergePreview` counts it. */
export type MergeMoves = {
  properties: number
  jobs: number
  notes: number
  contacts: number
}

/** "2 sites, 14 jobs and 3 notes move" — "1 site moves" — what there is,
 * with its verb, or null for nothing. Contacts too: a merge moves the people
 * as well as the places. */
export function mergeMovesList(moves: MergeMoves): string | null {
  const noun = (n: number, one: string, many: string) =>
    n > 0 ? `${n.toLocaleString('en-AU')} ${n === 1 ? one : many}` : null
  const parts = [
    noun(moves.properties, 'site', 'sites'),
    noun(moves.jobs, 'job', 'jobs'),
    noun(moves.notes, 'note', 'notes'),
    noun(moves.contacts, 'contact', 'contacts'),
  ].filter((part): part is string => part !== null)
  if (parts.length === 0) return null
  if (parts.length === 1) {
    return `${parts[0]} ${parts[0].startsWith('1 ') ? 'moves' : 'move'}`
  }
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]} move`
}

/** What a merge does in one organisation (`clientMerge.mergePreview`):
 * A takes B's contact over, B's own contact stays in Xero beside A's, or B
 * has none there. */
export type MergeXeroOrg = {
  orgName: string
  outcome: 'takes_over' | 'stays' | 'none'
}

/**
 * One sentence per organisation where B is a contact of its own: "In Doyle
 * Pest Services, Jan Smith takes over Jan Morris’s contact." where A has
 * none there (it becomes that contact, rather than a second one beside it),
 * or "Jan Morris’s own contact in Doyle Pest Services stays in Xero." where
 * A has its own (PestM8 never deletes in Xero, so the merge leaves it).
 */
export function mergeXeroLines(
  from: string,
  into: string,
  xero: ReadonlyArray<MergeXeroOrg>,
): string {
  return xero
    .map((org) => {
      switch (org.outcome) {
        case 'takes_over':
          return ` In ${org.orgName}, ${into} takes over ${from}’s contact.`
        case 'stays':
          return ` ${from}’s own contact in ${org.orgName} stays in Xero.`
        case 'none':
          return ''
      }
    })
    .join('')
}

/** A merge confirm's way out. Not "Keep both" (the Same customer sheet's
 * second answer, which this saves nothing of), nor "Keep client", which
 * reads as choosing one of the two. */
export const MERGE_CANCEL = 'Don’t merge'

/** Why a business can't go into a person (`KIND_MISMATCH`): what a person's
 * record never shows, and the way on — no full stop, for the caller's own
 * ending. */
export function kindMismatch(from: string, into: string): string {
  return `${from} is a business with contact people, an ABN or an office address, which ${into} — a person — can’t show. Make ${into} a business first`
}

/** Said once a merge has gone through: on the Xero card that asked, and
 * at the top of the kept client's sheet. */
export function mergedCopy(from: string, into: string): string {
  return `Merged — ${from}’s sites, jobs and notes are ${into}’s now, and ${from} is in the Recycle bin.`
}

// ─────────────────────────────────────────────── on the client sheet

/** At the foot of a client's Details, for whoever may merge clients. */
export const MERGE_INTO_LABEL = 'Merge into…'

/** The sheet Merge into… opens: who goes, the one to keep still to be
 * chosen. */
export function mergeIntoTitle(from: string): string {
  return `Merge ${from} into…`
}

/** Only the choice: the list's own heading says who may be the same
 * customer where the matcher finds anyone alike, and nothing claims an
 * order where it finds no one, or while a search orders the list. */
export const MERGE_INTO_DESCRIPTION = 'Choose the client to keep.'

/** The list's first heading: who the matcher finds alike, before
 * everyone, A–Z. */
export const MAY_BE_SAME_GROUP = 'May be the same customer'

export const MERGE_SEARCH_PLACEHOLDER = 'Search by name, phone, email or suburb'

/** The list with nobody else in it to keep. */
export const MERGE_NO_OTHERS = 'There’s no other client to merge into.'

/** One side of a merge, as `mergePreview` gives it. */
export type MergeSide = { name: string; clientNumber: number | null }

/**
 * The two names a merge's words use. Where both are called the same — the
 * usual duplicate — each carries its number ("Jane Nguyen #31"), so "Merge
 * Jane Nguyen into Jane Nguyen" never leaves anyone guessing which goes.
 * Bare, not in brackets, so a possessive reads "Jane Nguyen #12’s".
 */
export function mergeNames(
  from: MergeSide,
  into: MergeSide,
): { from: string; into: string } {
  const same =
    from.name.trim().toLocaleLowerCase('en-AU') ===
    into.name.trim().toLocaleLowerCase('en-AU')
  const named = (side: MergeSide) =>
    same && side.clientNumber !== null
      ? `${side.name} #${side.clientNumber}`
      : side.name
  return { from: named(from), into: named(into) }
}

/** The pair's own heading, and the confirm's question. */
export function mergePairTitle(from: string, into: string): string {
  return `Merge ${from} into ${into}`
}

export function mergeConfirmTitle(from: string, into: string): string {
  return `Merge ${from} into ${into}?`
}

/** The two halves of the pair, as the sheet labels them. */
export const MERGE_KEPT_LABEL = 'Kept'
export const MERGE_GOES_LABEL = 'Goes to the Recycle bin'

/** The way round, for when the other one should be kept. */
export function keepInsteadLabel(from: string): string {
  return `Keep ${from} instead`
}

/** Back to the list, from a pair chosen there. */
export const MERGE_CHOOSE_ANOTHER = 'Choose another'

/** The pair's button: it asks first (`…`), so it is not the commit. */
export const MERGE_ASK_LABEL = 'Merge…'
export const MERGE_CHECKING_LABEL = 'Checking…'
/** The pair's button when the preview failed for a reason that may pass. */
export const MERGE_TRY_AGAIN_LABEL = 'Try again'

type Preview = {
  moves: MergeMoves
  xero: ReadonlyArray<MergeXeroOrg>
}

/**
 * What the pair says the merge does: what moves, that A's details win with
 * B's filling the blanks, that B goes to the Recycle bin for good, and each
 * organisation's outcome. Until the preview has counted, what moves is said
 * without numbers, so it can be read at once.
 */
export function mergePairSummary({
  from,
  into,
  preview,
}: {
  from: string
  into: string
  preview?: Preview
}): string {
  const moves = preview
    ? mergeMovesList(preview.moves)
    : `${from}’s sites, jobs and notes move`
  const first = moves ? `${moves} to ${into}. ` : ''
  const xero = preview ? mergeXeroLines(from, into, preview.xero) : ''
  return `${first}${into}’s name, number and details stay, with ${from}’s filling any blanks. ${from} goes to the Recycle bin, and can’t be restored from there.${xero}`
}

/** The confirm: what moves, where B goes, and that it can't be undone —
 * the Recycle bin won't give B back, its sites and jobs being A's by then
 * (`bin.restore` refuses `MERGED`). Asked only once the preview has
 * counted. */
export function mergeConfirmText({
  from,
  into,
  preview,
}: {
  from: string
  into: string
  preview: Preview
}): string {
  const moves = mergeMovesList(preview.moves)
  const first = moves ? `${moves} to ${into}, and ` : ''
  return `${first}${from} goes to the Recycle bin. This can’t be undone.${mergeXeroLines(from, into, preview.xero)}`
}

/**
 * A merge refused, by the preview or by the merge itself
 * (`clientMerge.mergePreview` refuses as `merge` does), in the pair's
 * FormAlert. Fails fast with no signal: it moves a client's whole history,
 * which nobody should find happening hours later.
 */
export function clientMergeErrorCopy(
  from: string,
  into: string,
  /** The one of the two that is archived, as the pair names them: the
   * server refuses one as it refuses a client gone (`NOT_FOUND`), and
   * "since this opened" would be untrue of one archived before. */
  archived?: string,
): ErrorCopy {
  return {
    MERGE_TOO_BIG: `Could not merge: ${from} has more sites, contacts or notes than PestM8 can move at once. Keep ${from} instead, or leave the two as they are.`,
    KIND_MISMATCH: `Could not merge: ${kindMismatch(from, into)}, or keep ${from} instead.`,
    SAME_CLIENT:
      'Could not merge: they’re the same client already. Close this and look again.',
    MERGED: `Could not merge: ${from} has already been merged into another client. Close this and look again.`,
    // Archived: nothing in the app restores one, and the way round is
    // refused as well, so the way on is to leave the two be.
    NOT_FOUND:
      archived !== undefined
        ? `Could not merge: ${mergeArchivedNote(archived)} Close this and leave the two as they are.`
        : `Could not merge: ${from} or ${into} has been deleted, archived or changed since this opened. Close this and look again.`,
    NO_ACCESS:
      'Could not merge: only the owner or a contractor can merge clients.',
    SWITCHED:
      'Could not merge: switch back to your own account first, then try again.',
    offline:
      'Could not merge: this device is offline. Nothing was changed — try again when you have signal.',
    default:
      'Could not merge. Nothing was changed — check your signal and try again.',
  }
}

/** Refusals that will stand however often it is asked: the pair greys
 * Merge… out over one, and says the reason (and, beside it, the way
 * round). */
const STANDING = new Set([
  'MERGE_TOO_BIG',
  'KIND_MISMATCH',
  'SAME_CLIENT',
  'MERGED',
  'NOT_FOUND',
  'NO_ACCESS',
  'SWITCHED',
])

export function mergeRefusalStands(code: string | null): boolean {
  return code !== null && STANDING.has(code)
}

// ───────────────────────────────────── the possible-duplicate line

/** The line's two answers. Merge… asks first, as Merge into… does. */
export const MAYBE_SAME_MERGE = 'Merge…'
export const MAYBE_SAME_DIFFERENT = 'Not the same'

/** The line's region name, for a screen reader. */
export const MAYBE_SAME_REGION = 'Possible duplicates'

/** A line whose other client is archived, under its buttons, Merge…
 * greyed out: a merge refuses an archived client either way round, and
 * nothing in the app restores one from archived. */
export function mergeArchivedNote(name: string): string {
  return `${name} is archived, and an archived client can’t be merged.`
}

/**
 * Not the same, asked first: the answer can't be taken back
 * (`clientMatchHints.answer` reopens nothing), so it is never one tap, and
 * a glove aiming at Merge… beside it sets nothing aside. The question
 * names the other client as the line does; the body says what stays, what
 * goes, and, only where the other client can still be merged, that Merge
 * into… can merge them: never for one archived, whom Merge into… leaves
 * out and a merge refuses (nothing in the app restores one), nor for one
 * whose record isn't there.
 */
export function notTheSameTitle(otherName: string): string {
  return `Not the same customer as ${otherName}?`
}

export function notTheSameText(canMergeLater: boolean): string {
  const stays =
    'Both clients stay as they are, and this goes from both their sheets, for everyone.'
  return canMergeLater
    ? `${stays} It can’t be brought back, but Details → Merge into… can still merge them.`
    : `${stays} It can’t be brought back.`
}

/** Its way out keeps the question open. */
export const NOT_THE_SAME_CANCEL = 'Keep it'

/** Not the same, saved: said under the line, which stays where it was
 * until the sheet is next opened, so the next line's answer never slides
 * up under the thumb that answered this one. */
export function notTheSameSaved(otherName: string): string {
  return `Saved — not the same customer as ${otherName}.`
}

/** Not the same, refused (`clientMatchHints.answer`). Fails fast with no
 * signal, as the merge does: the line would otherwise go and come back. */
export const NOT_THE_SAME_ERROR_COPY: ErrorCopy = {
  NOT_FOUND:
    'Could not save: this has changed since you opened it. Close it and look again.',
  NO_ACCESS: 'Could not save: only the owner or a contractor can answer this.',
  SWITCHED:
    'Could not save: switch back to your own account first, then try again.',
  offline:
    'Could not save: this device is offline. Try again when you have signal.',
  default: 'Could not save. Check your signal and try again.',
}
