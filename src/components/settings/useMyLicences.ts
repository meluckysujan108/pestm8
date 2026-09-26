import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { dayKeyOf } from '../../../convex/lib/dates'
import {
  useObjectUrl,
  useOnline,
  useStillPendingAfter,
} from '#/components/products/hooks'
import {
  onKeptLicencesChange,
  readKeptThumbnail,
  readKeptWallet,
  syncKeptWallet,
} from '#/lib/keptLicence'
import { rq } from '#/lib/routeQueries'
import { heldLicenceFile, licenceFileKeyOf } from './licenceSource'
import type { KeptWallet } from '#/lib/keptLicence'
import type { LicenceFileView } from './licenceSource'
import type { Id } from '../../../convex/_generated/dataModel'

/*
 * Apart from the pages' upload and edit code, so the hub — which reads the
 * wallet for its badge and its Show my licence — does not bring those into
 * the chunk every Settings visit loads.
 */

/** How long the live list may wait before the kept copy stands in. */
const KEPT_FALLBACK_AFTER_MS = 4000

/**
 * When this page load began, on this phone's clock — the same clock
 * react-query stamps an answer with (`dataUpdatedAt`) when the Convex client
 * delivers it. An answer stamped earlier did not come from this page load's
 * socket: it came in the page's HTML (the server's clock, at the time the
 * HTML was made), which the service worker may be serving days later.
 */
const PAGE_LOADED_AT =
  typeof performance === 'undefined'
    ? 0
    : performance.timeOrigin || Date.now() - performance.now()

/** One licence as a page shows it, from the live list or the phone's copy. */
export type WalletLicence = {
  _id: string
  name: string
  number?: string
  expiresOn?: string
  files: Array<LicenceFileView>
}

export type Wallet = {
  /** The signed-in person's own: only then is anything offered but looking. */
  mine: boolean
  licences: Array<WalletLicence>
  /** Shown from the copy kept on this phone: there is no signal to change
   * anything with, and files open only if they were kept. */
  fromPhone: boolean
}

/**
 * The signed-in person's licences: the live list once it answers, else the
 * copy kept on this phone — once the list has waited a few seconds, the
 * phone says it is offline, or the list failed.
 *
 * Whenever the live list answers, what is kept on this phone is brought into
 * line with it in the background (`syncKeptWallet`): the list, every file not
 * yet kept, and nothing that has been taken off. So a wallet filled in from
 * the office laptop is on the phone the next time the phone opens Settings,
 * without anyone opening each file.
 *
 * Only an answer from this page load counts as live. The list is kept out of
 * the page's HTML (`keptOutOfHtml`), but if an older answer ever reached the
 * query cache some other way — a copy of the page the service worker kept,
 * say — it is neither shown as current nor used to bring the kept copy into
 * line: that would put back the list as it was then, and forget every file
 * kept since. `syncKeptWallet` refuses a list older than the kept one too.
 *
 * One hook for the hub, the Licences page, a licence's page and the Show my
 * licence sheet, so none of them can disagree about what the phone can show
 * an inspector. Never suspends: with no signal a Convex query waits rather
 * than fails, and this is read on the pages a technician opens on site.
 */
export function useMyLicences(
  businessId: Id<'businesses'>,
  membershipId: Id<'memberships'>,
) {
  const live = useQuery(rq.memberLicences(businessId, membershipId))
  const online = useOnline()
  const kept = useKeptWallet(businessId, membershipId)

  const answeredAt = live.dataUpdatedAt
  const data =
    live.data !== undefined && answeredAt >= PAGE_LOADED_AT
      ? live.data
      : undefined
  const late = useStillPendingAfter(data === undefined, KEPT_FALLBACK_AFTER_MS)

  // On `answeredAt` as well as `data`: an answer the same as the last keeps
  // the same object, and is still news that the list is current as of now.
  useEffect(() => {
    if (!data?.mine) return
    void syncKeptWallet(businessId, membershipId, data, {
      answeredAt,
      inHand: (fileId, uploadedAt) =>
        heldLicenceFile(licenceFileKeyOf(membershipId, fileId, uploadedAt)),
    })
  }, [businessId, membershipId, data, answeredAt])

  const standIn = data === undefined && (late || !online || live.isError)
  // The same object from render to render while nothing changes: the viewer
  // builds its source from what it is handed.
  const shown = useMemo<Wallet | undefined>(() => {
    if (data !== undefined) {
      return { mine: data.mine, licences: data.licences, fromPhone: false }
    }
    if (!standIn || !kept) return undefined
    return {
      mine: true,
      licences: kept.licences.map((licence) => ({
        ...licence,
        files: licence.files.map((file) => ({ ...file, url: null })),
      })),
      fromPhone: true,
    }
  }, [data, standIn, kept])

  return {
    live,
    shown,
    online,
    /** No list, no signal and nothing kept: nothing is coming. */
    nothing: data === undefined && standIn && kept === null,
  }
}

/**
 * The list kept on this phone: undefined until it has been read, null when
 * there is none. Read again whenever something kept changes.
 */
export function useKeptWallet(
  businessId: string,
  membershipId: string,
): KeptWallet | null | undefined {
  const [kept, setKept] = useState<KeptWallet | null | undefined>(undefined)
  useEffect(() => {
    let current = true
    const read = () => {
      void readKeptWallet(businessId, membershipId).then((copy) => {
        if (current) setKept(copy)
      })
    }
    read()
    const stop = onKeptLicencesChange(read)
    return () => {
      current = false
      stop()
    }
  }, [businessId, membershipId])
  return kept
}

/**
 * A photo's thumbnail kept on this phone, as a URL an <img> can show, or null
 * — none kept (yet), not a photo, or not `enabled`. Never the file's own URL,
 * for two reasons. An <img> of it is an image request, which the service
 * worker's 'images' rule stores in a cache nothing clears at sign-out — so a
 * card, with its date of birth and home address, would stay behind on a
 * shared tablet for the next person. And it would pull a 2400px photo over
 * mobile data to draw 48 pixels.
 */
export function useLicenceThumbnail(
  businessId: string,
  membershipId: string,
  file: { _id: string; uploadedAt: number; kind: 'pdf' | 'image' } | null,
  enabled: boolean,
): string | null {
  const [blob, setBlob] = useState<Blob | null>(null)
  const fileId = file?.kind === 'image' ? file._id : null
  const uploadedAt = file?.uploadedAt ?? 0
  useEffect(() => {
    if (!enabled || fileId === null) {
      setBlob(null)
      return
    }
    let current = true
    // Once found, it is these bytes for good (a file never changes), so
    // later notices — each file the background keep brings in — are not
    // read again, and the tile does not redraw for every one of them.
    let found = false
    const read = () => {
      if (found) return
      void readKeptThumbnail(businessId, membershipId, fileId, uploadedAt).then(
        (thumb) => {
          if (!current || !thumb) return
          found = true
          setBlob(thumb)
        },
      )
    }
    setBlob(null)
    read()
    const stop = onKeptLicencesChange(read)
    return () => {
      current = false
      stop()
    }
  }, [businessId, membershipId, fileId, uploadedAt, enabled])
  return useObjectUrl(blob)
}

/** Today where the business is — the day every expiry is counted from. */
export function useBusinessToday(timezone: string): string {
  return dayKeyOf(Date.now(), timezone)
}
