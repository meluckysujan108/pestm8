import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { IdCard, LoaderCircle } from 'lucide-react'
import { FormAlert } from '#/components/forms/FormAlert'
import { useCan } from '#/lib/access'
import { licenceErrorCopy } from '#/lib/licenceErrors'
import { rq } from '#/lib/routeQueries'
import { useHydrated } from '#/lib/useHydrated'
import { ExpiryBadge } from './LicenceBits'
import { LicenceViewer } from './LicenceViewer'
import { licenceSubtitle } from './licenceExpiry'
import { ROW_CLASS, RowBody, SettingsGroup, SettingsRow } from './ui'
import { useBusinessToday } from './useMyLicences'
import type { WalletLicence } from './useMyLicences'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * A member's licences on their page under Team, for the owner: each one's
 * name, number and expiry, and its files to open — read-only. No adding,
 * renaming or taking off (those are the holder's alone, and the server takes
 * them from nobody else), no Share, and nothing kept on the owner's phone
 * (`licenceSource.ts`).
 *
 * The owner only (`business.manage`, which a switch into someone's account
 * drops): a contractor running a team does not see these — a licence card
 * carries a date of birth and a home address. Shown once the roster says
 * there are some (`licenceCount`), or once the list has answered, so a page
 * for someone with none does not grow a group a moment after it opens.
 *
 * No thumbnails: the only bytes on the owner's phone are the ones they
 * open, and an <img> of a file's own URL is an image request the service
 * worker would keep (`useLicenceThumbnail` has why).
 */
export function MemberLicences({
  businessId,
  membershipId,
  name,
  licenceCount,
  active,
  timezone,
}: {
  businessId: Id<'businesses'>
  membershipId: Id<'memberships'>
  /** How they are named, for the viewer's title. */
  name: string
  /** From the roster: how many they hold, when the roster says. */
  licenceCount?: number
  /** Only an active member's are there to read. */
  active: boolean
  /** The business's, which every expiry is counted in. */
  timezone: string
}) {
  const canSee = useCan('business.manage')
  const today = useBusinessToday(timezone)
  const hydrated = useHydrated()
  const list = useQuery({
    ...rq.memberLicences(businessId, membershipId),
    enabled: canSee && active,
  })
  const [viewing, setViewing] = useState<WalletLicence | null>(null)

  if (!canSee || !active) return null
  const expected = (licenceCount ?? 0) > 0
  if (list.data === undefined && !expected) return null

  const licences = list.data?.licences
  const viewed = viewing
    ? licences?.find((licence) => licence._id === viewing._id)
    : undefined

  return (
    <>
      <SettingsGroup
        title="Licences"
        footer={`Read-only. Only ${name} can add or change these.`}
      >
        {licences === undefined ? (
          list.isError ? (
            <div className="px-3.5 py-3">
              <FormAlert error={list.error} copy={licenceErrorCopy('load')} />
            </div>
          ) : (
            <div className={`${ROW_CLASS} justify-center`}>
              <LoaderCircle
                aria-hidden
                size={20}
                strokeWidth={1.7}
                className="animate-spin text-muted"
              />
              <span className="sr-only" role="status">
                Loading their licences
              </span>
            </div>
          )
        ) : licences.length === 0 ? (
          <SettingsRow title="No licences added" />
        ) : (
          licences.map((licence) =>
            licence.files.length > 0 ? (
              // The whole row opens it, at the first file; the viewer steps
              // through the rest.
              <button
                key={licence._id}
                type="button"
                onClick={() => setViewing(licence)}
                disabled={!hydrated}
                className={`${ROW_CLASS} disabled:opacity-60`}
              >
                <RowBody
                  icon={IdCard}
                  tint="green"
                  title={licence.name}
                  subtitle={licenceSubtitle(licence, today)}
                  value={fileCount(licence.files.length)}
                  badge={
                    <ExpiryBadge expiresOn={licence.expiresOn} today={today} />
                  }
                  chevron
                />
              </button>
            ) : (
              <SettingsRow
                key={licence._id}
                icon={IdCard}
                tint="green"
                title={licence.name}
                subtitle={licenceSubtitle(licence, today)}
                value="No files"
                badge={
                  <ExpiryBadge expiresOn={licence.expiresOn} today={today} />
                }
              />
            ),
          )
        )}
      </SettingsGroup>

      {viewing && (
        <LicenceViewer
          businessId={businessId}
          membershipId={membershipId}
          licence={viewed ?? viewing}
          // Their own page, opened by the owner themself, is still theirs.
          mine={list.data?.mine === true}
          startAt={viewing.files[0]?._id}
          title={`${name} — ${viewing.name}`}
          onClose={() => setViewing(null)}
        />
      )}
    </>
  )
}

function fileCount(n: number): string {
  return n === 1 ? '1 file' : `${n} files`
}
