import { Plus } from 'lucide-react'
import { MAX_LICENCES } from '../../../convex/lib/memberLicences'
import { FormAlert } from '#/components/forms/FormAlert'
import { licenceErrorCopy } from '#/lib/licenceErrors'
import { ExpiryBadge, LicenceLeading } from './LicenceBits'
import { licenceSubtitle } from './licenceExpiry'
import { SettingsGroup, SettingsLinkRow, SettingsRow } from './ui'
import { useBusinessToday, useMyLicences } from './useMyLicences'
import type { Id } from '../../../convex/_generated/dataModel'
import { RowPending } from '#/components/shell/Pending'

/**
 * "My licences" on the Licences page: one row per licence the person holds —
 * its first photo, name, number and expiry, a badge once it is close to
 * running out — each opening that licence's page, and a last row to add one.
 *
 * Separate from the number above it ("On your reports"), which is what
 * prints on reports; nothing here changes that.
 *
 * Reads the wallet as the hub does (`useMyLicences`): with no signal, after a
 * few seconds, the copy kept on this phone stands in, and each licence still
 * opens — its files with it, for the inspector on site.
 */
export function MyLicencesList({
  businessId,
  businessSlug,
  membershipId,
  timezone,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  membershipId: Id<'memberships'>
  timezone: string
}) {
  const { live, shown, nothing } = useMyLicences(businessId, membershipId)
  const today = useBusinessToday(timezone)
  const full = (shown?.licences.length ?? 0) >= MAX_LICENCES

  return (
    <SettingsGroup
      title="My licences"
      footer={
        shown?.fromPhone
          ? 'No signal — showing the copy kept on this phone.'
          : 'Only you and the business owner can see these. Kept on this phone for sites with no signal.'
      }
    >
      {shown === undefined ? (
        live.isError ? (
          <div className="px-3.5 py-3">
            <FormAlert error={live.error} copy={licenceErrorCopy('load')} />
          </div>
        ) : nothing ? (
          <SettingsRow
            title="No signal"
            subtitle="Your licences show here once this phone has signal."
          />
        ) : (
          <RowPending label="Loading your licences" />
        )
      ) : (
        <>
          {shown.licences.map((licence) => (
            <SettingsLinkRow
              key={licence._id}
              to="/$businessSlug/settings/licence/$licenceId"
              params={{ businessSlug, licenceId: licence._id }}
              leading={
                <LicenceLeading
                  businessId={businessId}
                  membershipId={membershipId}
                  licence={licence}
                  mine={shown.mine}
                />
              }
              title={licence.name}
              subtitle={licenceSubtitle(licence, today)}
              badge={
                <ExpiryBadge expiresOn={licence.expiresOn} today={today} />
              }
            />
          ))}
          {full ? (
            <SettingsRow
              icon={Plus}
              tint="grey"
              title="Add licence"
              subtitle={`You can keep up to ${MAX_LICENCES}. Delete one to add another.`}
            />
          ) : (
            <SettingsLinkRow
              to="/$businessSlug/settings/licence/new"
              params={{ businessSlug }}
              leading={<AddTile />}
              title={
                <span className="font-semibold text-blue">Add licence</span>
              }
            />
          )}
        </>
      )}
    </SettingsGroup>
  )
}

/** The "+" an add row leads with, in the palette's blue. */
function AddTile() {
  return (
    <span
      aria-hidden
      className="flex size-[30px] shrink-0 items-center justify-center rounded-[8px] bg-blue text-white"
    >
      <Plus size={18} strokeWidth={2} />
    </span>
  )
}
