import { FileText, IdCard, ImageIcon } from 'lucide-react'
import { expiryBadgeText, expiryOf } from './licenceExpiry'
import { IconTile, RowBadge } from './ui'
import { useLicenceThumbnail } from './useMyLicences'
import type { WalletLicence } from './useMyLicences'
import type { LicenceFileView } from './licenceSource'

/**
 * The small pieces every licence list draws the same way: the expiry badge,
 * the tile a row leads with, a file's tile.
 */

/** Amber "45 days" from sixty days out, red "Expired" after; nothing else. */
export function ExpiryBadge({
  expiresOn,
  today,
}: {
  expiresOn?: string
  today: string
}) {
  const expiry = expiryOf(expiresOn, today)
  const words = expiryBadgeText(expiry)
  if (!words) return null
  return (
    <RowBadge tone={expiry.state === 'expired' ? 'red' : 'amber'}>
      {words}
    </RowBadge>
  )
}

/**
 * What a licence's row leads with: its first photo, small — from the copy
 * kept on this phone, so the holder's own only — else the ID-card tile.
 */
export function LicenceLeading({
  businessId,
  membershipId,
  licence,
  mine,
}: {
  businessId: string
  membershipId: string
  licence: WalletLicence
  mine: boolean
}) {
  const photo = licence.files.find((file) => file.kind === 'image') ?? null
  const thumbnail = useLicenceThumbnail(businessId, membershipId, photo, mine)
  if (!thumbnail) return <IconTile icon={IdCard} tint="green" />
  return (
    <span className="flex size-[30px] shrink-0 overflow-hidden rounded-[8px] bg-surface-2">
      <img
        src={thumbnail}
        alt=""
        draggable={false}
        className="size-full object-cover"
      />
    </span>
  )
}

/**
 * A file as a square: its photo's thumbnail when this phone has one, else a
 * plain tile saying what kind of file it is. `size` is the tile's side in
 * Tailwind's units.
 */
export function FileThumb({
  businessId,
  membershipId,
  file,
  mine,
  className = 'size-12 rounded-lg',
}: {
  businessId: string
  membershipId: string
  file: LicenceFileView
  mine: boolean
  className?: string
}) {
  const thumbnail = useLicenceThumbnail(businessId, membershipId, file, mine)
  return (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden bg-surface-2 text-muted ${className}`}
    >
      {thumbnail ? (
        <img
          src={thumbnail}
          alt=""
          draggable={false}
          className="size-full object-cover"
        />
      ) : file.kind === 'pdf' ? (
        <FileText aria-hidden size={22} strokeWidth={1.7} />
      ) : (
        <ImageIcon aria-hidden size={22} strokeWidth={1.7} />
      )}
    </span>
  )
}
