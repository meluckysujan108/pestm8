/**
 * Keeping an answered card where it was on the match page (`MatchReview`'s
 * list): an answered client leaves the server's list at once, and would take
 * its card out from under the thumb that answered it. Pure, so the rules
 * are tested without a page.
 */

/** A row of the list: a client, by id. */
type Row = { clientId: string }

/** A client kept on screen after it was answered or unlinked, at the place
 * it was in the list when it first was. */
export type Pin<T extends Row> = { item: T; index: number }

/**
 * Pins a card at the tap, before the save: the list may drop it the moment
 * the server has it.
 *
 * Pinned again — an earlier save on the card failed, the live list changed
 * it meanwhile (another client took its contact, say, so it became a
 * different kind of card), and it was answered again — it keeps the place
 * it first had but takes the card as it is now. The card shown once the
 * client leaves the list is then the one the answer was given on, never an
 * older snapshot of another kind with nothing answered on it.
 */
export function pinCard<T extends Row>(
  pins: ReadonlyMap<string, Pin<T>>,
  item: T,
  shown: ReadonlyArray<T> | undefined,
): ReadonlyMap<string, Pin<T>> {
  const kept = pins.get(item.clientId)
  if (kept) {
    if (kept.item === item) return pins
    return new Map(pins).set(item.clientId, { item, index: kept.index })
  }
  const index = shown?.findIndex((row) => row.clientId === item.clientId) ?? -1
  return new Map(pins).set(item.clientId, {
    item,
    index: index === -1 ? Number.MAX_SAFE_INTEGER : index,
  })
}

/**
 * The list as shown: the server's rows, with every pinned row that has left
 * them put back where it was. Pinned in the order they were shown, so a run
 * of answered cards keeps its order.
 */
export function steady<T extends Row>(
  live: ReadonlyArray<T>,
  pins: ReadonlyMap<string, Pin<T>>,
): Array<T> {
  const here = new Set<string>(live.map((item) => item.clientId))
  const rows = [...live]
  const gone = [...pins.values()]
    .filter((pin) => !here.has(pin.item.clientId))
    .sort((a, b) => a.index - b.index)
  for (const pin of gone) {
    rows.splice(Math.min(pin.index, rows.length), 0, pin.item)
  }
  return rows
}
