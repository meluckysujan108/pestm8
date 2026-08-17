import { useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { Camera, Check } from 'lucide-react'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'

/**
 * One upload target per slot the template declares. Photos are compressed on
 * the device first: an inspection photo off a modern phone is several
 * megabytes, and the person uploading it is typically under a house on mobile
 * data with one bar.
 */
export function PhotoSlots({
  businessId,
  reportId,
  slots,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  slots: Array<string>
}) {
  const { data: urls } = useQuery(
    convexQuery(api.reports.photoUrls, { businessId, reportId }),
  )

  return (
    <span className="flex flex-wrap gap-2">
      {slots.map((slot) => (
        <PhotoSlot
          key={slot}
          businessId={businessId}
          reportId={reportId}
          slot={slot}
          url={(urls as Record<string, string> | undefined)?.[slot]}
        />
      ))}
    </span>
  )
}

function PhotoSlot({
  businessId,
  reportId,
  slot,
  url,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  slot: string
  url?: string
}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const getUploadUrl = useConvexMutation(api.reports.generateUploadUrl)
  const convexAttach = useConvexMutation(api.reports.attachPhoto)
  const attach = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      reportId: Id<'reports'>
      storageId: Id<'_storage'>
      slot: string
    }) => convexAttach(args),
  })

  async function onPick(file: File) {
    setBusy(true)
    setFailed(false)
    try {
      const { default: compress } = await import('browser-image-compression')
      const compressed = await compress(file, {
        maxSizeMB: 1,
        maxWidthOrHeight: 2000,
        useWebWorker: true,
      })

      const uploadUrl = await getUploadUrl({ businessId })
      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': compressed.type },
        body: compressed,
      })
      if (!res.ok) throw new Error('upload failed')

      const { storageId } = (await res.json()) as { storageId: string }
      await attach.mutateAsync({
        businessId,
        reportId,
        storageId: storageId as Id<'_storage'>,
        slot,
      })
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="flex flex-col items-center gap-1">
      <button
        type="button"
        // The button's label replaces its subtree in the accessibility tree,
        // so the state has to live here — otherwise a screen reader cannot
        // tell an empty slot from one that already holds a photo.
        aria-label={
          busy
            ? `${slot} photo, uploading`
            : url
              ? `${slot} photo, uploaded — choose a different one`
              : `${slot} photo, none yet — add`
        }
        disabled={busy}
        onClick={() => input.current?.click()}
        className="relative flex h-24 w-28 items-center justify-center overflow-hidden rounded-xl border border-dashed border-hairline bg-surface-3 text-muted transition active:scale-[.97] disabled:opacity-50"
      >
        {url ? (
          <>
            <img
              src={url}
              alt=""
              aria-hidden
              className="size-full object-cover"
            />
            <span className="absolute bottom-1 right-1 flex size-5 items-center justify-center rounded-full bg-green text-white">
              <Check size={12} strokeWidth={3} />
            </span>
          </>
        ) : (
          <Camera size={20} strokeWidth={1.7} />
        )}
      </button>

      <span className="text-caption text-muted">
        {busy ? 'Uploading…' : slot}
      </span>
      {failed && (
        <span role="alert" className="text-caption text-amber-ink">
          Upload failed
        </span>
      )}

      <input
        ref={input}
        type="file"
        accept="image/*"
        // Opens the camera directly on a phone rather than the photo library.
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void onPick(file)
          e.target.value = ''
        }}
      />
    </span>
  )
}
