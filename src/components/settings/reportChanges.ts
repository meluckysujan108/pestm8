/**
 * What the Reports page's two text fields would change, as the fields of a
 * `businesses.update` call — only the ones that differ from what is saved.
 *
 * Only changes, because the server records every field it is sent in the
 * audit log as changed ("business.update", `meta.fields`), and a report title
 * sent back as it was is not a change anybody made.
 *
 * `typed` holds `null` for a field nobody has touched since it was last
 * saved, so the page can show the saved value until someone types.
 */
export function reportTextChanges(
  typed: { title: string | null; copy: string | null },
  saved: {
    reportBrandName?: string
    reportCopyEmail?: string
    tradingName?: string
  },
  businessName: string,
): { reportBrandName?: string; reportCopyEmail?: string } {
  const changes: { reportBrandName?: string; reportCopyEmail?: string } = {}

  if (typed.title !== null) {
    const before = saved.reportBrandName?.trim() ?? ''
    // Blank cannot be sent as blank. `businesses.update` stores '' as it
    // comes, and the title band reads `reportBrandName ?? tradingName ??
    // name` — so an empty one prints " Service Report for 2026", with no
    // name at all. Blank instead writes the name the band would fall back
    // to, which prints exactly what clearing it would have. (Nothing to do
    // when there was no title to clear.)
    const after =
      typed.title.trim() ||
      (before === '' ? '' : saved.tradingName?.trim() || businessName)
    if (after !== before) changes.reportBrandName = after
  }

  if (typed.copy !== null) {
    // Sent as typed: the server trims it and lower-cases the domain, and
    // blank clears it (`normaliseEmail('')` is undefined, which removes the
    // field), so the copy goes back to the business email.
    if (typed.copy.trim() !== (saved.reportCopyEmail ?? '').trim()) {
      changes.reportCopyEmail = typed.copy
    }
  }

  return changes
}
