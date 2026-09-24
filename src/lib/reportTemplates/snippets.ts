import { fieldsOf } from './index'
import type { ReportTemplate } from './types'

/**
 * Saved wording for the long-answer boxes.
 *
 * The rules that decide what a phrase list looks like live here rather than in
 * the mutation, so they are the same rules on both sides of the wire and can
 * be read without a deployment: what counts as a duplicate, how a list is
 * ordered, and how full it is allowed to get.
 */

/** Per field, because a list that needs scrolling is the typing again. */
export const MAX_SNIPPETS_PER_FIELD = 12

/**
 * Long enough for a paragraph of recommendations, short enough that nobody
 * pastes a report into one.
 */
export const MAX_SNIPPET_LENGTH = 600

/**
 * How many a business may hold at once, across every field — enforced on save
 * AND the size of the window `snippets.list` reads, which must be the same
 * number. A phrase saved beyond what the list returns is one nobody can ever
 * reach.
 */
export const MAX_SNIPPETS = 200

export type Snippet = {
  id: string
  fieldKey: string
  text: string
  usedCount: number
  createdAt: number
  /** Its author, or an owner. Decided on the server, sent so the sheet can
   *  withhold the control rather than offer one that refuses. */
  canRemove: boolean
}

/**
 * The same phrase, allowing for how it was typed.
 *
 * Case and surrounding space are not a different sentence, and two entries
 * that differ by a trailing space are two entries nobody can tell apart.
 */
export function sameSnippet(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * What gets used rises, and a new phrase leads until it has been.
 *
 * Ties break on newest first rather than oldest, because the phrase somebody
 * just saved is the one they are about to want.
 */
export function snippetOrder<
  T extends Pick<Snippet, 'usedCount' | 'createdAt'>,
>(rows: Array<T>): Array<T> {
  return [...rows].sort(
    (a, b) => b.usedCount - a.usedCount || b.createdAt - a.createdAt,
  )
}

/** Adding `phrase` to `text`: its own paragraph, unless there is nothing yet. */
export function withSnippet(text: string, phrase: string): string {
  const existing = text.trimEnd()
  return existing === '' ? phrase : `${existing}\n${phrase}`
}

/** The long-answer fields a template has, which are the ones phrases serve. */
export function snippetFields(template: ReportTemplate): Array<string> {
  return fieldsOf(template)
    .filter((field) => field.kind === 'area')
    .map((field) => field.key)
}
