import { useState } from 'react'
import { ImagePlus, Package } from 'lucide-react'
import { useKeptPhotoUrl } from './hooks'
import type { ShownProduct } from './model'

/**
 * A product's photo: from the server when the list is live, from the copy
 * kept on this phone when it is not, and a plain tile when there is neither —
 * or when the picture will not load, which with no signal is often. A broken
 * image icon in a roof void says "the app is broken"; the tile says "no
 * photo", which is closer to the truth.
 */
function usePhotoSrc(
  businessId: string,
  product: ShownProduct,
): { src: string | null; onError: () => void } {
  const kept = useKeptPhotoUrl(
    businessId,
    product.id,
    product.photoUrl === null && product.hasKeptPhoto,
  )
  const src = product.photoUrl ?? kept
  // The URL that failed, not a flag: a new photo gets its own chance.
  const [broken, setBroken] = useState<string | null>(null)
  return {
    src: src !== null && src !== broken ? src : null,
    onError: () => setBroken(src),
  }
}

/** The 56px square on a list card. */
export function ProductThumb({
  businessId,
  product,
}: {
  businessId: string
  product: ShownProduct
}) {
  const { src, onError } = usePhotoSrc(businessId, product)
  return (
    <span className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-surface-2 text-muted">
      {src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={onError}
          className="size-full object-cover"
        />
      ) : (
        <Package aria-hidden size={24} strokeWidth={1.7} />
      )}
    </span>
  )
}

/** The photo across the top of the product sheet, 4:3. */
export function ProductHero({
  businessId,
  product,
  onAddPhoto,
}: {
  businessId: string
  product: ShownProduct
  /** Offered to the people who may edit it, when there is no photo. */
  onAddPhoto?: () => void
}) {
  const { src, onError } = usePhotoSrc(businessId, product)
  if (src) {
    return (
      <img
        src={src}
        alt={`Photo of ${product.name}`}
        decoding="async"
        onError={onError}
        className="aspect-[4/3] w-full rounded-2xl bg-surface-2 object-cover"
      />
    )
  }
  return (
    <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 rounded-2xl bg-surface-2 text-muted">
      <Package aria-hidden size={40} strokeWidth={1.7} />
      <p className="text-caption">No photo</p>
      {onAddPhoto && (
        <button
          type="button"
          onClick={onAddPhoto}
          className="mt-1 flex h-11 items-center gap-1.5 rounded-full bg-surface px-4 text-body font-semibold text-blue shadow-elevation transition active:scale-[.97]"
        >
          <ImagePlus aria-hidden size={16} strokeWidth={2} />
          Add photo
        </button>
      )}
    </div>
  )
}
