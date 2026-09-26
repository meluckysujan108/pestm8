import { useEffect, useMemo, useState } from 'react'
import { ViewerHost } from '#/components/pdf/host/ViewerHost'
import { useShareSupport } from '#/components/pdf/host/useShareSupport'
import { ImageViewer } from '#/components/viewer/ImageViewer'
import { sharePdf } from '#/lib/pdfFiles'
import { licenceFileSource } from './licenceSource'
import type { ViewerPager } from '#/components/pdf/types'
import type { WalletLicence } from './useMyLicences'

/**
 * A licence's files, open inside the app: a PDF in the Products viewer (the
 * same lazily loaded chunk — pdf.js is never imported here), a photo in the
 * image viewer. Never a download, and never a file's own URL in a tab.
 *
 * Opens at the file tapped, and steps between the licence's files — front,
 * back, certificate — with the viewer's own previous and next (and a swipe
 * across a photo), without closing.
 *
 * What the viewer offers follows whose licence it is:
 *
 *  - The holder's own: Share (the file itself, where the phone's share sheet
 *    takes files). No Save — a download from an installed iPhone app has
 *    nowhere to land, and the point is to show it from here.
 *  - A member's, opened by the owner from Team: nothing but reading it, and
 *    nothing kept on the owner's phone (`licenceSource.ts`).
 */
export function LicenceViewer({
  businessId,
  membershipId,
  licence,
  mine,
  fromPhone = false,
  startAt,
  title,
  onClose,
}: {
  businessId: string
  membershipId: string
  licence: WalletLicence
  mine: boolean
  /** Shown from the copy on this phone (`Wallet.fromPhone`). */
  fromPhone?: boolean
  /** The file to open at; the first when absent or gone. */
  startAt?: string
  title: string
  onClose: () => void
}) {
  const support = useShareSupport()
  const { files } = licence
  const [at, setAt] = useState(() =>
    Math.max(
      0,
      files.findIndex((file) => file._id === startAt),
    ),
  )
  // A file taken off meanwhile (on another phone) leaves fewer to step
  // through; the viewer stays on the last rather than on nothing.
  const index = Math.min(at, files.length - 1)
  const file = index >= 0 ? files[index] : undefined

  // Every file gone: nothing left to show.
  useEffect(() => {
    if (!file) onClose()
  }, [file, onClose])

  useReturnFocus()

  const source = useMemo(
    () =>
      file
        ? licenceFileSource(businessId, membershipId, file, mine, fromPhone)
        : null,
    [businessId, membershipId, file, mine, fromPhone],
  )

  const count = files.length
  const pager = useMemo<ViewerPager | undefined>(
    () =>
      count > 1
        ? {
            index,
            count,
            onPrevious: () => setAt(Math.max(0, index - 1)),
            onNext: () => setAt(Math.min(count - 1, index + 1)),
          }
        : undefined,
    [index, count],
  )

  if (!file || !source) return null

  const share =
    mine && support.files
      ? (shared: File) => sharePdf(shared, { title })
      : undefined

  // Keyed by kind, not by file: stepping from one photo to the next keeps the
  // viewer open and swaps its picture, rather than closing one and opening
  // another over it.
  if (file.kind === 'pdf') {
    return (
      <ViewerHost
        key="pdf"
        title={title}
        fileName={file.fileName}
        source={source}
        actions={{ share }}
        onClose={onClose}
        pager={pager}
      />
    )
  }
  return (
    <ImageViewer
      key="image"
      title={title}
      fileName={file.fileName}
      contentType={file.contentType}
      source={source}
      share={share}
      pager={pager}
      brokenMessage={
        mine
          ? 'This picture can’t be shown. Remove it and add it again as a JPG or PNG.'
          : 'This picture can’t be shown. They need to add it again as a JPG or PNG.'
      }
      onClose={onClose}
    />
  )
}

/**
 * Puts focus back on whatever opened the viewer once it closes. Each viewer
 * does this itself, but stepping from a photo to a PDF swaps one viewer for
 * the other, and the second one opened from a button the first took away
 * with it.
 */
function useReturnFocus() {
  const [opener] = useState<Element | null>(() =>
    typeof document === 'undefined' ? null : document.activeElement,
  )
  useEffect(
    () => () => {
      if (!(opener instanceof HTMLElement)) return
      // After the viewer's own return has had its turn.
      requestAnimationFrame(() => {
        const active = document.activeElement
        if (
          opener.isConnected &&
          (active === null || active === document.body)
        ) {
          opener.focus({ preventScroll: true })
        }
      })
    },
    [opener],
  )
}
