import { useCallback, useState } from 'react'
import { IdCard } from 'lucide-react'
import { Sheet } from '#/components/primitives/Sheet'
import { formatBytes } from '#/lib/pdfFiles'
import { useHydrated } from '#/lib/useHydrated'
import { ExpiryBadge, FileThumb } from './LicenceBits'
import { LicenceViewer } from './LicenceViewer'
import { licenceSubtitle } from './licenceExpiry'
import type { Wallet, WalletLicence } from './useMyLicences'
import type { Id } from '../../../convex/_generated/dataModel'
import { SECONDARY_BUTTON_COMPACT } from '#/components/primitives/buttons'

/**
 * The hub's "Show my licence": every licence the signed-in person holds, as
 * cards in a sheet — the name, number and expiry an inspector asks about, and
 * each file to open full screen — one tap from Settings rather than three.
 *
 * Never suspends: it is handed the wallet the hub reads (`useMyLicences`),
 * which with no signal is the copy kept on this phone after a few seconds —
 * the moment this button is for. Renders nothing until there is at least one
 * file to show, live or kept.
 *
 * The sheet and the viewer are never open together (both are modal, and the
 * viewer opened over a vaul sheet fights its focus trap): opening a file
 * closes the sheet, and Done in the viewer brings it back.
 *
 * Nothing is changed from here. Adding and taking off belongs on the
 * Licences page, which has the picker, its checks and its error messages.
 */
export function ShowMyLicenceButton({
  businessId,
  membershipId,
  wallet,
  today,
}: {
  businessId: Id<'businesses'>
  membershipId: Id<'memberships'>
  wallet: Wallet | undefined
  today: string
}) {
  const hydrated = useHydrated()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [viewing, setViewing] = useState<{
    licence: WalletLicence
    fileId: string
  } | null>(null)

  const closeViewer = useCallback(() => {
    setViewing(null)
    // Reopened once the viewer has finished closing, not in the same commit:
    // its cleanup puts focus back on whatever opened it, outside the sheet,
    // and a sheet already open takes that as a reason to close again.
    setTimeout(() => setSheetOpen(true), 0)
  }, [])

  if (!wallet || !wallet.licences.some((licence) => licence.files.length > 0)) {
    return null
  }

  // The licence as the wallet has it now, so a viewer left open while the
  // list moved on (a file taken off elsewhere) follows it.
  const viewed = viewing
    ? wallet.licences.find((licence) => licence._id === viewing.licence._id)
    : undefined
  // The button and the sheet it opens say the same thing, in the number the
  // person actually has.
  const plural = wallet.licences.length !== 1

  return (
    <>
      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        disabled={!hydrated}
        className={`${SECONDARY_BUTTON_COMPACT} flex w-full items-center justify-center gap-2`}
      >
        <IdCard
          aria-hidden
          size={19}
          strokeWidth={1.7}
          className="shrink-0 text-blue"
        />
        {plural ? 'Show my licences' : 'Show my licence'}
      </button>

      <Sheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={plural ? 'My licences' : 'My licence'}
        description={
          wallet.fromPhone
            ? 'No signal — showing the copy kept on this phone.'
            : undefined
        }
      >
        <div className="flex flex-col gap-3 pb-3">
          {wallet.licences.map((licence) => (
            <LicenceCard
              key={licence._id}
              businessId={businessId}
              membershipId={membershipId}
              licence={licence}
              today={today}
              onOpen={(fileId) => {
                setSheetOpen(false)
                setViewing({ licence, fileId })
              }}
            />
          ))}
        </div>
      </Sheet>

      {viewing && (
        <LicenceViewer
          businessId={businessId}
          membershipId={membershipId}
          licence={viewed ?? viewing.licence}
          mine
          fromPhone={wallet.fromPhone}
          startAt={viewing.fileId}
          title={viewing.licence.name}
          onClose={closeViewer}
        />
      )}
    </>
  )
}

/** One licence, as a card an inspector can read at arm's length. */
function LicenceCard({
  businessId,
  membershipId,
  licence,
  today,
  onOpen,
}: {
  businessId: string
  membershipId: string
  licence: WalletLicence
  today: string
  onOpen: (fileId: string) => void
}) {
  return (
    <section
      aria-label={licence.name}
      className="rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation"
    >
      <div className="flex items-start gap-2">
        <h3 className="min-w-0 flex-1 text-row-title font-semibold text-ink [overflow-wrap:anywhere]">
          {licence.name}
        </h3>
        <ExpiryBadge expiresOn={licence.expiresOn} today={today} />
      </div>
      {licence.number && (
        <p className="mt-0.5 text-body text-ink-2 [overflow-wrap:anywhere]">
          {licence.number}
        </p>
      )}
      <p className="text-caption text-muted">
        {/* The number sits on its own line above, so only the date part of
            the list's subtitle — "Expired …" once it has run out. */}
        {licenceSubtitle({ expiresOn: licence.expiresOn }, today)}
      </p>
      {licence.files.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {licence.files.map((file) => (
            <button
              key={file._id}
              type="button"
              onClick={() => onOpen(file._id)}
              aria-label={`Open ${file.fileName}, ${file.kind === 'pdf' ? 'PDF' : 'photo'}, ${formatBytes(file.size)}`}
              className="rounded-xl outline-none transition active:scale-[.97] focus-visible:ring-2 focus-visible:ring-blue"
            >
              <FileThumb
                businessId={businessId}
                membershipId={membershipId}
                file={file}
                mine
                className="size-[72px] rounded-xl"
              />
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
