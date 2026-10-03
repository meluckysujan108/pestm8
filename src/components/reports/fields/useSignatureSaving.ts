import { useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import { isOffline } from '#/lib/online'
import { forgetSignature } from '#/lib/signature/kept'
import type { KeptSignature } from '#/lib/signature/kept'

/**
 * Putting a signature on a report: a drawing (its image and its strokes, one
 * upload each, then one `attachSignature`), or the signer's own saved one.
 * Both resolve to the time the report now says it was signed.
 *
 * Shared by the signing screen's Done (`ReportSigning`) and the report's
 * "Save it" for a drawing kept on the phone (`SignatureRow`), so a drawing
 * saved an hour late goes the same way as one saved at once.
 */
export function useSignatureSaving({
  businessId,
  reportId,
  ownSignature,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  /** The signer's own slot: only there is a drawing kept as theirs. */
  ownSignature: boolean
}) {
  const getUploadUrl = useConvexMutation(api.reports.generateUploadUrl)
  const attach = useConvexMutation(api.reports.attachSignature)

  async function upload(body: Blob): Promise<Id<'_storage'>> {
    const url = await getUploadUrl({ businessId })
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': body.type },
      body,
    })
    if (!res.ok) throw new Error('upload failed')
    const { storageId } = (await res.json()) as { storageId: Id<'_storage'> }
    return storageId
  }

  /**
   * A drawing, from the phone's keeping (`kept.ts`), to the report — and then
   * forgotten here. With no signal it is not tried at all (`'offline'`), and
   * stays kept.
   */
  async function saveDrawn(kept: KeptSignature): Promise<number> {
    if (isOffline()) throw new Error('offline')
    const [storageId, strokesStorageId] = await Promise.all([
      upload(new Blob([kept.png], { type: 'image/png' })),
      upload(
        new Blob([JSON.stringify(kept.strokes)], { type: 'application/json' }),
      ),
    ])
    const result = await attach({
      businessId,
      reportId,
      slot: kept.slot,
      storageId,
      strokesStorageId,
      method: 'drawn',
      drawnAt: kept.drawnAt,
      ...(kept.signedBy ? { signedBy: kept.signedBy } : {}),
      ...(kept.statement ? { statement: kept.statement } : {}),
      // Saving it is the signer's own choice, and only ever their own.
      ...(ownSignature && kept.keepAsMine ? { saveForMember: true } : {}),
    })
    await forgetSignature(kept.reportId, kept.slot)
    return result.signedAt
  }

  /** The signer's own saved signature, on this slot: one tap, one write. */
  async function applySaved({
    slot,
    storageId,
    statement,
  }: {
    slot: string
    storageId: Id<'_storage'>
    statement?: string
  }): Promise<number> {
    if (isOffline()) throw new Error('offline')
    const result = await attach({
      businessId,
      reportId,
      slot,
      storageId,
      method: 'saved',
      ...(statement ? { statement } : {}),
    })
    return result.signedAt
  }

  return { saveDrawn, applySaved }
}
