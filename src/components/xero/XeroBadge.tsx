import { RowBadge } from '#/components/settings/ui'
import { connectionValue, matchToCheck } from './xeroCopy'
import { syncOf } from './syncView'
import type { XeroView } from './XeroPage'

/**
 * What a Settings hub Xero row's badge says needs doing — one badge to a
 * row, the one that matters most:
 *
 * 1. "Reconnect": Xero stopped accepting PestM8's sign-in, and nothing
 *    reaches it until someone does;
 * 2. "{n} to check": clients waiting on Same or Different, which wait to be
 *    sent until someone decides;
 * 3. "{n} different": details PestM8 changed that Xero holds otherwise,
 *    left alone there until someone says which wins.
 *
 * Nothing otherwise. Its own small module, so the hub doesn't load the Xero
 * page to draw it.
 */
export function XeroBadge({ view }: { view: XeroView | null }) {
  const text = xeroBadgeText(view)
  return text ? <RowBadge tone="amber">{text}</RowBadge> : null
}

export function xeroBadgeText(view: XeroView | null): string | null {
  if (!view) return null
  if (view.status === 'needs_reconnect') return 'Reconnect'
  if (view.status !== 'connected') return null
  const sync = syncOf(view)
  // Once syncing, the sync's own count: a name Xero already holds puts a
  // client to check too, which the match never counted.
  const toCheck = sync ? sync.counts.review : matchToCheck(view)
  if (toCheck > 0) return `${toCheck.toLocaleString('en-AU')} to check`
  const different = sync?.counts.different ?? 0
  if (different > 0) return `${different.toLocaleString('en-AU')} different`
  return null
}

/**
 * The row's value beside the badge: the organisation's name, or "Not
 * connected" — but nothing while a badge shows. A long organisation's name
 * and a badge together squeezed "Xero" itself to a letter on a phone, and
 * the badge is what the row is there to say.
 */
export function xeroRowValue(view: XeroView | null): string | undefined {
  return xeroBadgeText(view) ? undefined : connectionValue(view)
}
