import { useState } from 'react'
import { useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { prepareLogo } from '#/lib/images/prepareLogo'
import type { Id } from '../../../convex/_generated/dataModel'

/** The letterhead's logo, or its optional version with light lettering. */
export type LogoSlot = 'logo' | 'logoOnDark'

/** What the row says after its last action, if anything. */
export type LogoNotice = keyof typeof LOGO_NOTICE_COPY

/**
 * The words for each. Only `darkBackground` is a warning rather than a
 * failure: the logo went up, and may be exactly what the owner wants.
 */
export const LOGO_NOTICE_COPY = {
  unreadable: 'Could not read that image. Try a PNG or a JPEG.',
  failed: 'Could not upload the logo. Check your signal and try again.',
  removeFailed: 'Could not remove the logo. Check your signal and try again.',
  darkBackground:
    'This logo sits on a dark background, so it prints as a dark box. A version with a clear or white background looks best.',
} as const

/**
 * Picking, uploading and taking off one of the letterhead's logos.
 *
 * One pick is two files (lib/images/prepareLogo.ts): the logo the PDF prints
 * and its copy for email. Both go up side by side, then `setLogo` puts them on
 * together, so no report or email ever has one without the other. It uploads
 * the moment it is picked: there is nothing to type, and nothing to take back
 * but the logo itself.
 */
export function useLogoUpload(businessId: Id<'businesses'>, which: LogoSlot) {
  const generateUploadUrl = useConvexMutation(api.businesses.generateUploadUrl)
  const setLogo = useConvexMutation(api.businesses.setLogo)
  const [busy, setBusy] = useState<'uploading' | 'removing' | null>(null)
  const [notice, setNotice] = useState<LogoNotice | null>(null)

  async function put(blob: Blob): Promise<Id<'_storage'>> {
    const url = await generateUploadUrl({ businessId })
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': blob.type },
      body: blob,
    })
    if (!res.ok) throw new Error('upload failed')
    const { storageId } = (await res.json()) as { storageId: Id<'_storage'> }
    return storageId
  }

  async function upload(file: File) {
    setBusy('uploading')
    setNotice(null)
    try {
      const prepared = await prepareLogo(file, which).catch(() => null)
      if (!prepared) {
        setNotice('unreadable')
        return
      }
      const [storageId, emailStorageId] = await Promise.all([
        put(prepared.logo.blob),
        put(prepared.email.blob),
      ])
      await setLogo({
        businessId,
        which,
        files: {
          storageId,
          email: {
            storageId: emailStorageId,
            width: prepared.email.width,
            height: prepared.email.height,
          },
        },
      })
      if (prepared.darkBackground) setNotice('darkBackground')
    } catch {
      setNotice('failed')
    } finally {
      setBusy(null)
    }
  }

  async function remove() {
    setBusy('removing')
    setNotice(null)
    try {
      await setLogo({ businessId, which, files: null })
    } catch {
      setNotice('removeFailed')
    } finally {
      setBusy(null)
    }
  }

  return { busy, notice, upload, remove }
}
