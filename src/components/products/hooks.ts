import { useEffect, useState, useSyncExternalStore } from 'react'
import { readKeptPhoto } from '#/lib/keptProducts'
import { canShareFiles, canShareText, saveLabel } from '#/lib/pdfFiles'

/**
 * Small browser-facing hooks the Products page shares between its list, its
 * sheets and the viewer. Each one answers something about THIS phone, so each
 * has a server answer that is the cautious one, and reads the browser only
 * after hydration — never during a render the server also does.
 */

function subscribeToConnection(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

/**
 * Whether the phone says it has a connection. Only "false" is worth trusting:
 * a phone with one bar of signal still says online, which is why the page
 * also falls back to the kept copies when the list is merely slow. True on
 * the server, so nothing renders as offline before the browser has said so.
 */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeToConnection,
    () => navigator.onLine,
    () => true,
  )
}

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

/**
 * An object URL for a Blob, revoked when the Blob changes or the component
 * goes. Null for no Blob, and on the server.
 */
export function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!blob) {
      setUrl(null)
      return
    }
    const made = URL.createObjectURL(blob)
    setUrl(made)
    return () => URL.revokeObjectURL(made)
  }, [blob])
  return url
}

/**
 * The photo kept on this phone for a product, as a URL an <img> can show, or
 * null until it has been read (and for good, when there is none). Read from
 * Cache Storage only when `enabled` — a product with a live photo URL has no
 * need of it.
 */
export function useKeptPhotoUrl(
  businessId: string,
  productId: string,
  enabled: boolean,
): string | null {
  const [blob, setBlob] = useState<Blob | null>(null)
  useEffect(() => {
    if (!enabled) {
      setBlob(null)
      return
    }
    let live = true
    void readKeptPhoto(businessId, productId).then((read) => {
      if (live) setBlob(read)
    })
    return () => {
      live = false
    }
  }, [businessId, productId, enabled])
  return useObjectUrl(blob)
}

/**
 * True once `pending` has stayed true for `ms`. A Convex query does not fail
 * with no signal — it waits — so "still waiting after a few seconds" is the
 * only sign a page gets that it should show what the phone has instead.
 */
export function useStillPendingAfter(pending: boolean, ms: number): boolean {
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (!pending) {
      setLate(false)
      return
    }
    const timer = setTimeout(() => setLate(true), ms)
    return () => clearTimeout(timer)
  }, [pending, ms])
  return pending && late
}
