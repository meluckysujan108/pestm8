import { useMemo } from 'react'
import { ViewerHost } from '#/components/products/ViewerHost'
import { useShareSupport } from '#/components/products/hooks'
import { ImageViewer } from '#/components/viewer/ImageViewer'
import { sharePdf } from '#/lib/pdfFiles'
import { licenceSourceFor } from './licenceSource'
import type { LicenceView } from './licenceSource'

/**
 * A licence document, open inside the app: a PDF in the Products viewer (the
 * same lazily loaded chunk — pdf.js is never imported here), a photo in the
 * image viewer. Never a download, and never the file's own URL in a tab.
 *
 * What the viewer offers follows whose licence it is:
 *
 *  - The holder's own: Share (the file itself, as a product's PDF is shared,
 *    where the phone's share sheet takes files) and, for a PDF, Replace from
 *    the viewer's menu. No Save — a download from an installed iPhone app has
 *    nowhere to land, and the point is to show it from here.
 *  - A member's, opened by the owner from Team: nothing but reading it.
 */
export function LicenceViewer({
  businessId,
  membershipId,
  licence,
  title,
  onClose,
  onReplace,
}: {
  businessId: string
  membershipId: string
  licence: LicenceView
  title: string
  onClose: () => void
  /** Opens the file picker, for the holder. */
  onReplace?: () => void
}) {
  const support = useShareSupport()
  const source = useMemo(
    () =>
      licenceSourceFor(businessId, membershipId, licence, () =>
        typeof navigator === 'undefined' ? true : navigator.onLine,
      ),
    [businessId, membershipId, licence],
  )
  const share =
    licence.mine && support.files
      ? (file: File) => sharePdf(file, { title })
      : undefined

  if (licence.kind === 'pdf') {
    return (
      <ViewerHost
        title={title}
        fileName={licence.fileName}
        source={source}
        actions={{
          share,
          replace: licence.mine ? onReplace : undefined,
        }}
        onClose={onClose}
      />
    )
  }
  return (
    <ImageViewer
      title={title}
      fileName={licence.fileName}
      contentType={licence.contentType}
      source={source}
      share={share}
      onClose={onClose}
    />
  )
}
