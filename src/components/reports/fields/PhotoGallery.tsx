import { useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { Camera, ChevronDown, ChevronUp, Star, Trash2 } from 'lucide-react'
import { api } from '../../../../convex/_generated/api'
import type { EditorProps } from './registry'
import type { FieldDef } from '#/lib/reportTemplates'
import type { Id } from '../../../../convex/_generated/dataModel'

type GalleryField = EditorProps<Extract<FieldDef, { kind: 'gallery' }>>

type GalleryPhoto = {
  _id: Id<'reportPhotos'>
  fieldKey: string
  caption?: string
  order: number
  isCover: boolean
  url: string | null
}

/**
 * As many photos as the technician takes, unlike `PhotoSlots`' fixed named
 * targets. Compression mirrors `PhotoSlots` exactly — an inspection photo off
 * a phone is several megabytes, uploaded from under a house on one bar.
 */
export function GalleryControl({ field, ctx }: GalleryField) {
  const { businessId, reportId } = ctx
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const { data } = useQuery(
    convexQuery(api.reports.galleryPhotos, { businessId, reportId }),
  )
  const photos = ((data as Array<GalleryPhoto> | undefined) ?? [])
    .filter((photo) => photo.fieldKey === field.key)
    .sort((a, b) => a.order - b.order)

  const getUploadUrl = useConvexMutation(api.reports.generateUploadUrl)
  const convexAdd = useConvexMutation(api.reports.addGalleryPhoto)
  const add = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      reportId: Id<'reports'>
      fieldKey: string
      storageId: Id<'_storage'>
    }) => convexAdd(args),
  })

  const atMax = field.maxPhotos !== undefined && photos.length >= field.maxPhotos

  async function onPick(files: Array<File>) {
    setBusy(true)
    setFailed(false)
    try {
      const { default: compress } = await import('browser-image-compression')
      // One at a time rather than in parallel: keeps upload order matching
      // selection order, which is what "order" means to someone reordering
      // afterwards, and avoids opening a burst of concurrent uploads on a
      // connection that is already the constraint.
      for (const file of files) {
        if (field.maxPhotos !== undefined && photos.length >= field.maxPhotos) {
          break
        }
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
        await add.mutateAsync({
          businessId,
          reportId,
          fieldKey: field.key,
          storageId: storageId as Id<'_storage'>,
        })
      }
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    // Test-only hook: a report can have more than one gallery field (a cover
    // photo and a general set), so a selector needs a way to scope to one of
    // them that doesn't depend on sibling order in the DOM.
    <span data-gallery-field={field.key} className="flex flex-col gap-2">
      {photos.length > 0 && (
        <span className="grid grid-cols-2 gap-2">
          {photos.map((photo, index) => (
            <GalleryTile
              key={photo._id}
              businessId={businessId}
              reportId={reportId}
              photo={photo}
              index={index}
              total={photos.length}
              label={field.label}
              // A cover flag only means something when there is more than one
              // photo to distinguish between.
              showCover={field.maxPhotos !== 1 && photos.length > 1}
            />
          ))}
        </span>
      )}

      <button
        type="button"
        disabled={busy || atMax}
        aria-label={`${field.label} — add photos`}
        onClick={() => input.current?.click()}
        className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-surface-2 text-[15px] font-semibold text-ink transition active:scale-[.98] disabled:opacity-40"
      >
        <Camera size={16} strokeWidth={1.9} />
        {busy
          ? 'Uploading…'
          : atMax
            ? `${field.label} — limit reached`
            : (field.addLabel ?? `Add ${field.label.toLowerCase()}`)}
      </button>

      {failed && (
        <span role="alert" className="text-caption text-amber-ink">
          Upload failed. Check your connection and try again.
        </span>
      )}

      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        capture="environment"
        className="hidden"
        onChange={(e) => {
          // Snapshotted to a plain array synchronously, before anything else
          // runs. `e.target.files` is a *live* FileList tied to the input's
          // current state — `onPick` is async and reads its argument only
          // after its first `await`, by which point the `e.target.value = ''`
          // reset below has already run in this same synchronous handler and
          // would otherwise have emptied the very FileList `onPick` is about
          // to iterate, so it would silently see zero files and do nothing.
          const files = Array.from(e.target.files ?? [])
          if (files.length > 0) void onPick(files)
          e.target.value = ''
        }}
      />
    </span>
  )
}

function GalleryTile({
  businessId,
  reportId,
  photo,
  index,
  total,
  label,
  showCover,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  photo: GalleryPhoto
  index: number
  total: number
  label: string
  showCover: boolean
}) {
  const [caption, setCaption] = useState(photo.caption ?? '')

  const setCover = useConvexMutation(api.reports.setGalleryCover)
  const updateCaption = useConvexMutation(api.reports.updateGalleryCaption)
  const move = useConvexMutation(api.reports.moveGalleryPhoto)
  const remove = useConvexMutation(api.reports.removeGalleryPhoto)

  const ordinal = index + 1

  return (
    <span className="flex flex-col gap-1 rounded-xl border border-hairline bg-surface p-2">
      <span className="relative overflow-hidden rounded-lg bg-surface-3">
        {photo.url && (
          <img
            src={photo.url}
            alt={photo.caption || `${label} photo ${ordinal}`}
            className="h-28 w-full object-cover"
          />
        )}
        {showCover && (
          <button
            type="button"
            aria-pressed={photo.isCover}
            aria-label={
              photo.isCover
                ? `${label} photo ${ordinal} — cover photo`
                : `${label} photo ${ordinal} — set as cover`
            }
            onClick={() => void setCover({ businessId, reportId, photoId: photo._id })}
            className={`absolute right-1 top-1 flex size-7 items-center justify-center rounded-full transition ${
              photo.isCover
                ? 'bg-amber text-white'
                : 'bg-black/40 text-white/80 hover:text-white'
            }`}
          >
            <Star size={14} strokeWidth={2} fill={photo.isCover ? 'currentColor' : 'none'} />
          </button>
        )}
      </span>

      <input
        value={caption}
        placeholder="Caption"
        aria-label={`${label} photo ${ordinal} — caption`}
        onChange={(e) => setCaption(e.target.value)}
        onBlur={() => {
          if (caption !== (photo.caption ?? '')) {
            void updateCaption({ businessId, reportId, photoId: photo._id, caption })
          }
        }}
        className="h-9 w-full rounded-lg bg-surface-3 px-2 text-[13px] text-ink outline-none focus:ring-2 focus:ring-blue"
      />

      <span className="flex items-center justify-between">
        <span className="flex">
          <button
            type="button"
            disabled={index === 0}
            aria-label={`Move ${label} photo ${ordinal} up`}
            onClick={() =>
              void move({ businessId, reportId, photoId: photo._id, direction: 'up' })
            }
            className="flex size-7 items-center justify-center rounded-full text-muted transition active:scale-[.95] disabled:opacity-30"
          >
            <ChevronUp size={15} strokeWidth={2} />
          </button>
          <button
            type="button"
            disabled={index === total - 1}
            aria-label={`Move ${label} photo ${ordinal} down`}
            onClick={() =>
              void move({ businessId, reportId, photoId: photo._id, direction: 'down' })
            }
            className="flex size-7 items-center justify-center rounded-full text-muted transition active:scale-[.95] disabled:opacity-30"
          >
            <ChevronDown size={15} strokeWidth={2} />
          </button>
        </span>
        <button
          type="button"
          aria-label={`Remove ${label} photo ${ordinal}`}
          onClick={() => void remove({ businessId, reportId, photoId: photo._id })}
          className="flex size-7 items-center justify-center rounded-full text-muted transition active:scale-[.95]"
        >
          <Trash2 size={14} strokeWidth={1.8} />
        </button>
      </span>
    </span>
  )
}
