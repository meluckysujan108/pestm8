import {
  keepLicenceFile,
  makeLicenceThumbnail,
  readKeptLicenceFile,
} from '#/lib/keptLicence'
import { fetchWithProgress } from '#/lib/pdfFiles'
import type { DocumentSource } from '#/components/pdf/types'
import type { KeptLicenceFile } from '#/lib/keptLicence'

/** One file on a licence as a page shows it: the live list's, or the copy
 * kept on this phone's (which has no URL). */
export type LicenceFileView = KeptLicenceFile & { url: string | null }

/** Names one file on one person's licence: the viewer's `source.key`. */
export function licenceFileKeyOf(
  membershipId: string,
  fileId: string,
  uploadedAt: number,
): string {
  return `licence:${membershipId}:${fileId}:${uploadedAt}`
}

/*
 * The bytes this page load already holds — just uploaded from this phone, or
 * opened a moment ago — so opening the same file again, or stepping back to
 * it in the viewer, costs nothing, and the background keep need not download
 * what was just uploaded. A licence's worth: the front, the back and a
 * certificate or three.
 */
const HELD_MAX = 6
const held = new Map<string, Blob>()

/** The bytes held for `key` this page load, if any. */
export function heldLicenceFile(key: string): Blob | null {
  return held.get(key) ?? null
}

export function holdLicenceFile(key: string, blob: Blob): void {
  held.delete(key)
  held.set(key, blob)
  while (held.size > HELD_MAX) {
    const oldest = held.keys().next().value
    if (oldest === undefined) break
    held.delete(oldest)
  }
}

/**
 * Where a viewer gets one licence file's bytes from, cheapest first: memory,
 * then — for the holder's own, and only theirs — the copy kept on this phone,
 * and only then the network. A holder's file fetched from the network is kept
 * (with a photo's thumbnail), in case the background keep has not got to it.
 *
 * A file never changes once it is on a licence (a new picture is a new file),
 * so a kept copy of this id and upload is always the right one.
 *
 * Nothing kept is ever read or written for someone else's licence — the
 * owner's look at a member's card leaves nothing on the owner's phone.
 */
export function licenceFileSource(
  businessId: string,
  membershipId: string,
  file: LicenceFileView,
  mine: boolean,
  /** Shown from the copy on this phone, with no signal to fetch with. */
  fromPhone: boolean,
): DocumentSource {
  const key = licenceFileKeyOf(membershipId, file._id, file.uploadedAt)

  return {
    key,
    load: async (onProgress, signal) => {
      const inMemory = held.get(key)
      if (inMemory) return inMemory

      if (mine) {
        const kept = await readKeptLicenceFile(
          businessId,
          membershipId,
          file._id,
          file.uploadedAt,
        )
        if (kept) {
          holdLicenceFile(key, kept)
          return kept
        }
      }
      if (file.url === null) {
        // Worded for whoever is looking: the owner cannot upload someone
        // else's licence, so telling them to would be a dead end.
        throw new Error(
          fromPhone
            ? 'This file isn’t on this phone yet. Open it once with signal to keep it here.'
            : mine
              ? 'This file is no longer available. Remove it and add it again.'
              : 'This file is no longer available. They need to add it again.',
        )
      }

      // Someone else's card leaves nothing in this phone's HTTP cache
      // either; the holder's own goes as any download does, and is kept.
      const blob = await fetchWithProgress(
        file.url,
        onProgress,
        signal,
        mine ? {} : { cache: 'no-store' },
      )
      // As stored, not as the server labelled it: a picture served with no
      // type would otherwise be kept as a PDF.
      const typed =
        blob.type === file.contentType
          ? blob
          : blob.slice(0, blob.size, file.contentType)
      holdLicenceFile(key, typed)
      if (mine) {
        void (async () => {
          const thumbnail =
            file.kind === 'image' ? await makeLicenceThumbnail(typed) : null
          await keepLicenceFile(
            businessId,
            membershipId,
            file,
            typed,
            thumbnail,
          )
        })()
      }
      return typed
    },
  }
}
