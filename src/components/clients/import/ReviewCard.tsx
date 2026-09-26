import { memo, useRef, useState } from 'react'
import {
  Check,
  CircleX,
  Hash,
  Mail,
  MapPin,
  Phone,
  TriangleAlert,
  User,
} from 'lucide-react'
import { ClientKindPill } from '#/components/clients/ClientCard'
import { SECONDARY_BUTTON_COMPACT } from '#/components/primitives/buttons'
import { RowBadge } from '#/components/settings/ui'
import { duplicateSiteMessage } from '#/lib/clientImport/build'
import { formatAbn } from '../../../../convex/lib/abn'
import { plural } from './ui'
import type { ReactNode } from 'react'
import type {
  ReviewClient,
  ReviewIssue,
  ReviewSite,
  ReviewStatus,
} from '#/lib/clientImport/types'

/** Each status as the review names it, and the colour it wears. */
const STATUS_BADGE: Record<
  ReviewStatus,
  { label: string; tone: 'red' | 'grey' | 'amber' | 'green' }
> = {
  error: { label: 'Can’t import', tone: 'red' },
  duplicate: { label: 'Already in PestM8', tone: 'grey' },
  warning: { label: 'Needs a look', tone: 'amber' },
  fixed: { label: 'Ready', tone: 'green' },
  ready: { label: 'Ready', tone: 'green' },
}

const ISSUE_STYLE: Record<
  ReviewIssue['level'],
  { Icon: typeof Check; icon: string; text: string; word: string }
> = {
  // The -ink tokens, as FieldMessage uses: text-red and text-muted are too
  // faint to read in sunlight, and a review is read slowly.
  error: {
    Icon: CircleX,
    icon: 'text-red-ink',
    text: 'text-red-ink',
    word: 'Needs fixing',
  },
  warning: {
    Icon: TriangleAlert,
    icon: 'text-amber-ink',
    text: 'text-amber-ink',
    word: 'Worth a look',
  },
  fixed: {
    Icon: Check,
    icon: 'text-green-ink',
    text: 'text-grey-ink',
    word: 'Put right',
  },
}

/** Sites a card shows before "Show all": a property manager's hundreds
 * would make one card longer than the rest of the review put together. */
const SITES_SHOWN = 5

/** Issues a card shows before the rest are counted. Errors come first, so
 * whatever stops the client is always in view. */
const ISSUES_SHOWN = 8

const LEVEL_ORDER = { error: 0, warning: 1, fixed: 2 } as const

/**
 * Runs `act` — a fix, a Leave out — and keeps the keyboard's place. A fix
 * takes its own button away, and a change can take the card out of the
 * filter; focus would fall to the top of the page either way. It goes to
 * this card if it's still showing, or the next one if it isn't.
 */
function holdFocus(card: HTMLElement | null, act: () => void) {
  const next = (card?.nextElementSibling ??
    card?.previousElementSibling) as HTMLElement | null
  act()
  requestAnimationFrame(() => {
    const active = document.activeElement
    if (active && active !== document.body) return
    if (card?.isConnected) card.focus()
    else if (next?.isConnected) next.focus()
  })
}

function oneLine(site: ReviewSite): string {
  const place = [site.suburb, site.state, site.postcode]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ')
  return [site.addressLine.trim(), place].filter(Boolean).join(', ')
}

/**
 * One client as the review shows it: who, where, how to reach them, and
 * everything the review has to say about it — put right, worth a look, or
 * stopping it — each with its one-tap fix where there is one.
 *
 * Memoised, and handed the same callbacks every time: a fix changes one
 * client, and the other ninety-nine cards on screen should not draw again.
 * A client with a great many sites or issues shows the first few, and the
 * rest on request.
 */
export const ReviewCard = memo(function ReviewCard({
  client,
  status,
  hydrated,
  onEdit,
  onToggle,
  onFix,
}: {
  client: ReviewClient
  status: ReviewStatus
  hydrated: boolean
  /** With the Edit button, for focus to go back to once the sheet shuts. */
  onEdit: (client: ReviewClient, from: HTMLElement) => void
  onToggle: (client: ReviewClient) => void
  onFix: (client: ReviewClient, issue: ReviewIssue) => void
}) {
  const card = useRef<HTMLLIElement>(null)
  const [allSites, setAllSites] = useState(false)
  const [allIssues, setAllIssues] = useState(false)
  const business = client.kind === 'business'
  const name = client.name || 'this client'
  const badge = client.included
    ? STATUS_BADGE[status]
    : { label: 'Left out', tone: 'grey' as const }
  // A site already here isn't sent, so what the review says about it is
  // beside the point.
  const issues = client.issues
    .filter(
      (issue) =>
        issue.siteIndex === undefined ||
        !client.sites[issue.siteIndex]?.duplicate,
    )
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
  const several = client.sites.length > 1
  const sites = allSites ? client.sites : client.sites.slice(0, SITES_SHOWN)
  const shownIssues = allIssues ? issues : issues.slice(0, ISSUES_SHOWN)

  const contact: Array<{ Icon: typeof Phone; text: string; label: string }> = []
  if (business && client.contactPerson) {
    contact.push({
      Icon: User,
      text: client.contactPerson,
      label: 'Contact person',
    })
  }
  if (client.phone) {
    contact.push({ Icon: Phone, text: client.phone, label: 'Phone' })
  }
  if (client.email) {
    contact.push({ Icon: Mail, text: client.email, label: 'Email' })
  }
  if (business && client.abn) {
    contact.push({
      Icon: Hash,
      text: `ABN ${formatAbn(client.abn)}`,
      label: 'ABN',
    })
  }

  return (
    <li
      ref={card}
      // Where focus is kept after a fix or a Leave out (`holdFocus`).
      tabIndex={-1}
      aria-label={client.name || 'A client with no name'}
      className="rounded-2xl border border-hairline bg-surface p-4 shadow-elevation outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-row-title text-ink [overflow-wrap:anywhere]">
            {client.name || <span className="italic text-muted">No name</span>}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <ClientKindPill kind={client.kind} />
            {/* Not when every site is already here: nothing is added. */}
            {client.existingClientId &&
              (status === 'duplicate' ? (
                <span className="text-caption font-medium text-grey-ink">
                  Already a client in PestM8
                </span>
              ) : (
                <span className="text-caption font-medium text-blue-ink">
                  Adds to an existing client
                </span>
              ))}
          </div>
        </div>
        <RowBadge tone={badge.tone}>{badge.label}</RowBadge>
      </div>

      {/* Left out, what it holds recedes; its name and badge stay clear,
          so it is still easy to find and bring back. */}
      <div className={client.included ? '' : 'opacity-55'}>
        {client.sites.length > 0 && (
          <ul className="mt-3 space-y-2">
            {sites.map((site, i) => (
              <li key={i} className="flex gap-2.5">
                <MapPin
                  aria-hidden
                  size={15}
                  strokeWidth={2}
                  className="mt-[3px] shrink-0 text-muted"
                />
                <div className="min-w-0 flex-1">
                  <p
                    className={`text-body [overflow-wrap:anywhere] ${site.duplicate ? 'text-muted' : 'text-ink'}`}
                  >
                    {oneLine(site) || (
                      <span className="italic text-muted">No address</span>
                    )}
                  </p>
                  {site.duplicate && (
                    <p className="text-caption text-grey-ink [overflow-wrap:anywhere]">
                      {duplicateSiteMessage(site)}
                    </p>
                  )}
                  {/* A business's only: a person is their own contact, and
                      the import drops a person's (toImportClient). */}
                  {business &&
                    (site.siteContactName || site.siteContactPhone) && (
                      <p className="text-caption text-muted [overflow-wrap:anywhere]">
                        Site contact:{' '}
                        {[site.siteContactName, site.siteContactPhone]
                          .filter(Boolean)
                          .join(', ')}
                      </p>
                    )}
                  {site.note && (
                    <p className="mt-0.5 line-clamp-2 whitespace-pre-line text-caption text-ink-2">
                      <span className="sr-only">Site note: </span>“{site.note}”
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {client.sites.length > SITES_SHOWN && (
          <button
            type="button"
            disabled={!hydrated}
            aria-expanded={allSites}
            onClick={() => setAllSites((all) => !all)}
            // Drawn 36px, tapped at 44 (`tap-target`): nothing that can be
            // pressed sits within reach above or below it.
            className="relative tap-target mt-1 inline-flex min-h-9 items-center pl-6 text-body font-semibold text-blue transition active:opacity-60 disabled:opacity-50"
          >
            {allSites
              ? 'Show fewer sites'
              : `Show all ${plural(client.sites.length, 'site')}`}
          </button>
        )}

        {contact.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-caption text-ink-2">
            {contact.map(({ Icon, text, label }) => (
              <li key={label} className="flex min-w-0 items-center gap-1.5">
                <Icon
                  aria-hidden
                  size={13}
                  strokeWidth={2}
                  className="shrink-0 text-muted"
                />
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  <span className="sr-only">{label}: </span>
                  {text}
                </span>
              </li>
            ))}
          </ul>
        )}

        {issues.length > 0 && (
          <ul className="mt-3 space-y-1.5 border-t border-hairline-2 pt-3">
            {shownIssues.map((issue, i) => (
              <IssueLine
                key={`${issue.field}-${issue.siteIndex ?? ''}-${i}`}
                issue={issue}
                where={
                  several && issue.siteIndex !== undefined
                    ? client.sites[issue.siteIndex]?.addressLine ||
                      `Site ${issue.siteIndex + 1}`
                    : null
                }
                fix={
                  issue.fix && client.included ? (
                    // Inline, straight after what it fixes: padded for a
                    // thumb, with the padding taken back so the line keeps
                    // its height.
                    <button
                      type="button"
                      disabled={!hydrated}
                      onClick={() =>
                        holdFocus(card.current, () => onFix(client, issue))
                      }
                      className="-my-1.5 inline-block max-w-full py-1.5 text-left font-semibold text-blue-ink underline underline-offset-2 transition [overflow-wrap:anywhere] active:opacity-60 disabled:opacity-50"
                    >
                      {issue.fix.label}
                    </button>
                  ) : null
                }
              />
            ))}
            {issues.length > ISSUES_SHOWN && (
              <li>
                <button
                  type="button"
                  disabled={!hydrated}
                  aria-expanded={allIssues}
                  onClick={() => setAllIssues((all) => !all)}
                  // 44px outright, not a widened hit area: the line above
                  // can end in a fix, whose padding reaches down to here.
                  className="inline-flex min-h-11 items-center pl-5.5 text-body font-semibold text-blue transition active:opacity-60 disabled:opacity-50"
                >
                  {allIssues
                    ? 'Show fewer'
                    : `Show ${(issues.length - ISSUES_SHOWN).toLocaleString('en-AU')} more`}
                </button>
              </li>
            )}
          </ul>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!hydrated}
          onClick={(event) => onEdit(client, event.currentTarget)}
          aria-label={`Edit ${name}`}
          className={`${SECONDARY_BUTTON_COMPACT} px-4`}
        >
          Edit
        </button>
        <button
          type="button"
          disabled={!hydrated}
          onClick={() => holdFocus(card.current, () => onToggle(client))}
          aria-label={`${client.included ? 'Leave out' : 'Include'} ${name}`}
          className={`${SECONDARY_BUTTON_COMPACT} px-4`}
        >
          {client.included ? 'Leave out' : 'Include'}
        </button>
      </div>
    </li>
  )
})

function IssueLine({
  issue,
  where,
  fix,
}: {
  issue: ReviewIssue
  /** Which site, when the client has more than one. */
  where: string | null
  fix: ReactNode
}) {
  const { Icon, icon, text, word } = ISSUE_STYLE[issue.level]
  return (
    <li className={`flex items-start gap-x-2 text-caption ${text}`}>
      <Icon
        aria-hidden
        className={`mt-0.5 size-3.5 shrink-0 ${icon}`}
        strokeWidth={2.2}
      />
      {/* A message can quote a whole email address, which has nowhere to
          break on a phone. */}
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <span className="sr-only">{word}: </span>
        {where && <span className="font-semibold">{where}: </span>}
        {issue.message}
        {fix && <> {fix}</>}
      </span>
    </li>
  )
}
