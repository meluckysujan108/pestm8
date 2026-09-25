import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useOnline, useStillPendingAfter } from '#/components/products/hooks'
import { forgetKeptLicence, readKeptLicence } from '#/lib/keptLicence'
import { rq } from '#/lib/routeQueries'
import type { KeptLicence } from '#/lib/keptLicence'
import type { LicenceView } from './licenceSource'
import type { Id } from '../../../convex/_generated/dataModel'

/*
 * Apart from LicenceDocument, which uses it too, so the hub's "Show my
 * licence" does not bring the upload code into the chunk every Settings
 * visit loads.
 */

/** How long the live query may wait before the kept copy stands in. */
const KEPT_FALLBACK_AFTER_MS = 4000

/**
 * Which licence document to show the signed-in person as their own: the live
 * one once the query answers (`null` when there is none), else the copy kept
 * on this phone — once the query has waited a few seconds, the phone says it
 * is offline, or the query failed. `undefined` while neither is known yet.
 *
 * One hook for the Licence page's tile and the hub's "Show my licence", so
 * the two never disagree about what the phone can show an inspector.
 */
export function useMyLicence(
  businessId: Id<'businesses'>,
  membershipId: Id<'memberships'>,
) {
  const live = useQuery(rq.licenceFile(businessId, membershipId))
  const online = useOnline()
  const late = useStillPendingAfter(live.isPending, KEPT_FALLBACK_AFTER_MS)

  // The copy on this phone: read when the page opens and whenever the live
  // version changes, so it can stand in for the query with no signal.
  const [kept, setKept] = useState<KeptLicence | null>(null)
  const liveUploadedAt = live.data?.uploadedAt
  useEffect(() => {
    let current = true
    void readKeptLicence(businessId, membershipId).then((copy) => {
      if (current) setKept(copy)
    })
    return () => {
      current = false
    }
  }, [businessId, membershipId, liveUploadedAt])

  // Removed on another phone: the copy here goes too. Here rather than on
  // the Licence page alone, so the hub's button stops offering a card that
  // has been taken down without its holder having to open that page first.
  const removedElsewhere = live.data === null
  useEffect(() => {
    if (!removedElsewhere) return
    void forgetKeptLicence(businessId, membershipId).then(() => setKept(null))
  }, [businessId, membershipId, removedElsewhere])

  const liveData = live.data
  const standIn =
    liveData === undefined && (late || !online || live.isError) ? kept : null
  // The same object from render to render while nothing changes: the viewer
  // builds its source from it, and a new one each render would be a new
  // source for a document already open.
  const shown = useMemo<LicenceView | null | undefined>(
    () =>
      liveData !== undefined
        ? liveData
        : standIn
          ? {
              url: null,
              kind: standIn.meta.kind,
              contentType: standIn.meta.contentType,
              fileName: standIn.meta.fileName,
              size: standIn.meta.size,
              uploadedAt: standIn.meta.uploadedAt,
              mine: true,
            }
          : undefined,
    [liveData, standIn],
  )

  return { live, kept, setKept, shown, online }
}
