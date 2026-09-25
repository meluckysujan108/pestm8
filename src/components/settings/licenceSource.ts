import { keepLicence, readKeptLicence } from '#/lib/keptLicence'
import { fetchWithProgress, isAbortError } from '#/lib/pdfFiles'
import type { DocumentSource } from '#/components/pdf/types'
import type { KeptLicenceMeta } from '#/lib/keptLicence'
import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../../convex/_generated/api'

/** A licence document as `licences.file` hands it over. */
export type LicenceView = NonNullable<
  FunctionReturnType<typeof api.licences.file>
>

/**
 * How long a download may go with no bytes arriving, when a kept copy is
 * waiting to stand in for it — the Products viewer's rule
 * (`KEPT_FALLBACK_STALL_MS`), for the same one bar of signal in a roof void.
 */
const KEPT_FALLBACK_STALL_MS = 15_000

/** Names one version of one person's licence: the viewer's `source.key`. */
export function licenceKeyOf(membershipId: string, uploadedAt: number): string {
  return `licence:${membershipId}:${uploadedAt}`
}

/*
 * The bytes this page load already holds — just uploaded from this phone, or
 * opened a moment ago — so opening the same licence again costs nothing. Two
 * at most: one person's, and the one an owner last looked at.
 */
const held = new Map<string, Blob>()

/** The bytes held for `key` this page load, if any — for the Profile tile. */
export function heldLicence(key: string): Blob | null {
  return held.get(key) ?? null
}

export function holdLicence(key: string, blob: Blob): void {
  held.delete(key)
  held.set(key, blob)
  while (held.size > 2) {
    const oldest = held.keys().next().value
    if (oldest === undefined) break
    held.delete(oldest)
  }
}

export function metaOf(licence: LicenceView): KeptLicenceMeta {
  return {
    uploadedAt: licence.uploadedAt,
    fileName: licence.fileName,
    kind: licence.kind,
    contentType: licence.contentType,
    size: licence.size,
  }
}

/**
 * Where a viewer gets a licence's bytes from, cheapest first: memory, then —
 * for the holder's own, and only theirs — the copy kept on this phone when it
 * is this version or there is no signal to fetch this version, and only then
 * the network. A holder's licence fetched from the network is kept, which is
 * what "kept on first view" means; a failed or stalled fetch falls back to
 * whatever copy is kept, even an older one: the card they held last week is a
 * better answer on site than an error.
 *
 * Nothing kept is ever read or written for someone else's licence — the
 * owner's look at a member's card leaves nothing on the owner's phone.
 */
export function licenceSourceFor(
  businessId: string,
  membershipId: string,
  licence: LicenceView,
  isOnline: () => boolean,
): DocumentSource {
  const key = licenceKeyOf(membershipId, licence.uploadedAt)
  const { url, mine } = licence

  return {
    key,
    load: async (onProgress, signal) => {
      const inMemory = held.get(key)
      if (inMemory) return inMemory

      const kept = mine ? await readKeptLicence(businessId, membershipId) : null
      const current = kept?.meta.uploadedAt === licence.uploadedAt
      if (kept && (current || url === null || !isOnline())) {
        if (current) holdLicence(key, kept.blob)
        return kept.blob
      }
      if (url === null) {
        // Worded for whoever is looking: the owner cannot upload someone
        // else's licence, so telling them to would be a dead end.
        throw new Error(
          mine
            ? 'This file is no longer available. Upload your licence again.'
            : 'This file is no longer available. They need to upload their licence again.',
        )
      }

      try {
        const blob = await fetchWithProgress(
          url,
          onProgress,
          signal,
          kept ? { stallMs: KEPT_FALLBACK_STALL_MS } : undefined,
        )
        holdLicence(key, blob)
        if (mine)
          void keepLicence(businessId, membershipId, metaOf(licence), blob)
        return blob
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error
        if (kept) return kept.blob
        throw error
      }
    },
  }
}
