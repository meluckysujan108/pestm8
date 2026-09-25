import { useSyncExternalStore } from 'react'
import { canShareFiles, canShareText, saveLabel } from '#/lib/pdfFiles'

/**
 * What this phone's share sheet can do, for every page that hands a PDF to
 * another app — the Products page, a finalised report.
 *
 * It answers something about THIS phone, so it has a server answer that is
 * the cautious one, and reads the browser only after hydration — never during
 * a render the server also does.
 */

export type ShareSupport = {
  /** The share sheet takes PDFs: Share PDF, and a product shared with it. */
  files: boolean
  /** There is a share sheet at all (otherwise sharing copies instead). */
  text: boolean
  /** "Save to Files" on an iPhone or iPad, "Download" elsewhere. */
  saveLabel: string
}

const SERVER_SUPPORT: ShareSupport = {
  files: false,
  text: false,
  saveLabel: 'Download',
}
let browserSupport: ShareSupport | null = null

const noSubscription = () => () => {}

/**
 * What the share sheet can do here. Asked once per page load — none of it
 * changes while the app is open — and cached, because
 * `useSyncExternalStore` needs the same object back on every call.
 */
export function useShareSupport(): ShareSupport {
  return useSyncExternalStore(
    noSubscription,
    () =>
      (browserSupport ??= {
        files: canShareFiles(),
        text: canShareText(),
        saveLabel: saveLabel(),
      }),
    () => SERVER_SUPPORT,
  )
}
