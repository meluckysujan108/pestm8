import { useState } from 'react'
import { useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { errorCode } from '#/components/forms/describeError'
import { prepareLogo } from '#/lib/images/prepareLogo'
import type { Id } from '../../../convex/_generated/dataModel'

/** The letterhead's logo, or its optional version with light lettering. */
export type LogoSlot = 'logo' | 'logoOnDark'

/** What a row says after its last action. */
export type LogoNotice = keyof typeof LOGO_NOTICE_COPY

/**
 * The words for each. The last four are warnings, not failures: the logo went
 * up, and may be exactly what the owner meant (`LOGO_WARNINGS`).
 */
export const LOGO_NOTICE_COPY = {
  unreadable: 'Could not read that image. Try a PNG or a JPEG.',
  tooLarge:
    'Could not upload: that image is too large. Try a smaller copy of the logo.',
  noLogo: 'Could not add it: the logo has been taken off. Add the logo first.',
  noAccess:
    'Could not change the logo: your access does not cover the letterhead. Ask the business owner.',
  failed: 'Could not upload the logo. Check your signal and try again.',
  removeFailed: 'Could not remove the logo. Check your signal and try again.',
  darkBackground:
    'This logo sits on a dark background, so it prints as a dark box. A version with a clear or white background looks best.',
  lightLettering:
    'This logo is mostly white, so it won’t show on white paper. Use it as the logo for dark backgrounds, and a version with dark lettering here.',
  darkLettering:
    'This version has dark lettering, so it won’t show in a dark email. Use one with white lettering.',
  clearedOnDark:
    'The logo for dark backgrounds went with the old logo. Add one that matches this logo.',
} as const

/** The notices that say the logo went up, and something about it. */
export const LOGO_WARNINGS: ReadonlySet<LogoNotice> = new Set([
  'darkBackground',
  'lightLettering',
  'darkLettering',
  'clearedOnDark',
])

/** A refusal from `setLogo`, in the row's words. */
function refusal(error: unknown): LogoNotice {
  switch (errorCode(error)) {
    case 'FILE_TOO_LARGE':
      return 'tooLarge'
    case 'WRONG_FILE_TYPE':
    case 'INVALID_SIZE':
      return 'unreadable'
    case 'NO_LOGO':
      return 'noLogo'
    case 'NO_ACCESS':
      return 'noAccess'
    default:
      return 'failed'
  }
}

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
  const [notices, setNotices] = useState<Array<LogoNotice>>([])

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
    setNotices([])
    try {
      const prepared = await prepareLogo(file, which).catch(() => null)
      if (!prepared) {
        setNotices(['unreadable'])
        return
      }
      const [storageId, emailStorageId] = await Promise.all([
        put(prepared.logo.blob),
        put(prepared.email.blob),
      ])
      const result = await setLogo({
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
      setNotices([
        ...(prepared.warning ? [prepared.warning] : []),
        ...(result.clearedOnDark ? (['clearedOnDark'] as const) : []),
      ])
    } catch (error) {
      setNotices([refusal(error)])
    } finally {
      setBusy(null)
    }
  }

  /** True once it is off. */
  async function remove(): Promise<boolean> {
    setBusy('removing')
    setNotices([])
    try {
      await setLogo({ businessId, which, files: null })
      return true
    } catch {
      setNotices(['removeFailed'])
      return false
    } finally {
      setBusy(null)
    }
  }

  return { busy, notices, upload, remove, clear: () => setNotices([]) }
}
