/**
 * A text field for an update, only when it changed. Blank is sent as '',
 * which clears it on the server; an untouched field is left out, so a save
 * that changes nothing writes nothing — and a save made while the server is
 * still the previous version sends nothing it does not know.
 */
export function edited<TKey extends string>(
  key: TKey,
  now: string,
  before: string | undefined,
): Partial<Record<TKey, string>> {
  return changed(now, before)
    ? ({ [key]: now.trim() } as Record<TKey, string>)
    : {}
}

export function changed(now: string, before: string | undefined): boolean {
  return now.trim() !== (before ?? '').trim()
}
