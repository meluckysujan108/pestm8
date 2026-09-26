import { memo } from 'react'
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
import { RowBadge } from '#/components/settings/ui'
import { formatAbn } from '../../../../convex/lib/abn'
import { SMALL_BUTTON } from './ui'
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
    icon: 'text-orange-ink',
    text: 'text-orange-ink',
    word: 'Worth a look',
  },
  fixed: {
    Icon: Check,
    icon: 'text-green-ink',
    text: 'text-grey-ink',
    word: 'Put right',
  },
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
  onEdit: (client: ReviewClient) => void
  onToggle: (client: ReviewClient) => void
  onFix: (client: ReviewClient, issue: ReviewIssue) => void
}) {
  const business = client.kind === 'business'
  const badge = client.included
    ? STATUS_BADGE[status]
    : { label: 'Left out', tone: 'grey' as const }
  // A site already here isn't sent, so what the review says about it is
  // beside the point.
  const issues = client.issues.filter(
    (issue) =>
      issue.siteIndex === undefined ||
      !client.sites[issue.siteIndex]?.duplicate,
  )
  const several = client.sites.length > 1

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
      aria-label={client.name || 'A client with no name'}
      className="rounded-2xl border border-hairline bg-surface p-4 shadow-elevation"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-row-title text-ink [overflow-wrap:anywhere]">
            {client.name || <span className="italic text-muted">No name</span>}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <ClientKindPill kind={client.kind} />
            {client.existingClientId && (
              <span className="text-caption font-medium text-blue-ink">
                Adds to an existing client
              </span>
            )}
          </div>
        </div>
        <RowBadge tone={badge.tone}>{badge.label}</RowBadge>
      </div>

      {/* Left out, what it holds recedes; its name and badge stay clear,
          so it is still easy to find and bring back. */}
      <div className={client.included ? '' : 'opacity-55'}>
        {client.sites.length > 0 && (
          <ul className="mt-3 space-y-2">
            {client.sites.map((site, i) => (
              <li key={i} className="flex gap-2.5">
                <MapPin
                  aria-hidden
                  size={15}
                  strokeWidth={1.8}
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
                    <p className="text-caption text-grey-ink">
                      Already in PestM8 — this site is skipped
                    </p>
                  )}
                  {business && site.siteContactName && (
                    <p className="text-caption text-muted">
                      Site contact: {site.siteContactName}
                      {site.siteContactPhone && `, ${site.siteContactPhone}`}
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
            {issues.map((issue, i) => (
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
                    <button
                      type="button"
                      disabled={!hydrated}
                      onClick={() => onFix(client, issue)}
                      className="inline-flex min-h-8 items-center font-semibold text-blue-ink underline underline-offset-2 transition active:opacity-60 disabled:opacity-50"
                    >
                      {issue.fix.label}
                    </button>
                  ) : null
                }
              />
            ))}
          </ul>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!hydrated}
          onClick={() => onEdit(client)}
          aria-label={`Edit ${client.name || 'this client'}`}
          className={SMALL_BUTTON}
        >
          Edit
        </button>
        <button
          type="button"
          disabled={!hydrated}
          onClick={() => onToggle(client)}
          className={SMALL_BUTTON}
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
    <li className={`flex flex-wrap items-start gap-x-2 text-caption ${text}`}>
      <Icon
        aria-hidden
        className={`mt-0.5 size-3.5 shrink-0 ${icon}`}
        strokeWidth={2.2}
      />
      <span className="min-w-0 flex-1">
        <span className="sr-only">{word}: </span>
        {where && <span className="font-semibold">{where}: </span>}
        {issue.message}
      </span>
      {fix && (
        <span className="basis-full pl-5.5 sm:basis-auto sm:pl-0">{fix}</span>
      )}
    </li>
  )
}
