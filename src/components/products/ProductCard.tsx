import { FileText, Smartphone } from 'lucide-react'
import { formatBytes } from '#/lib/pdfFiles'
import { ProductThumb } from './ProductPhoto'
import { pdfMeta } from './model'
import type { ReactNode } from 'react'
import type { ShownProduct } from './model'

/**
 * One product on the list: photo, name, the first line of what it is, and
 * whether its PDF is there and on this phone. The whole card is the button —
 * a thumb on a ladder does not aim for a chevron.
 */
export function ProductCard({
  businessId,
  product,
  kept,
  onOpen,
}: {
  businessId: string
  product: ShownProduct
  /** Kept on this phone. Passed rather than read from `product.kept` so the
   * chip can wait for the kept list to be read, and match the server render
   * until it has. */
  kept: boolean
  onOpen: (productId: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(product.id)}
      className="flex w-full items-center gap-3 rounded-2xl border border-hairline bg-surface p-3 text-left shadow-elevation transition active:scale-[.99]"
    >
      <ProductThumb businessId={businessId} product={product} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-row-title text-ink">
          {product.name}
        </span>
        {product.description && (
          <span className="block truncate text-caption text-muted">
            {product.description}
          </span>
        )}
        {(product.pdf || kept) && (
          <span className="mt-1.5 flex flex-wrap gap-1.5">
            {product.pdf && (
              <Chip>
                <FileText
                  aria-hidden
                  size={12}
                  strokeWidth={2.2}
                  className="text-red"
                />
                {pdfMeta(product.pdf.size, formatBytes)}
              </Chip>
            )}
            {kept && (
              <Chip tone="green">
                <Smartphone aria-hidden size={12} strokeWidth={2.2} />
                On this phone
              </Chip>
            )}
          </span>
        )}
      </span>
    </button>
  )
}

export function Chip({
  children,
  tone = 'grey',
}: {
  children: ReactNode
  tone?: 'grey' | 'green'
}) {
  const colours =
    tone === 'green' ? 'bg-green-bg text-green-ink' : 'bg-surface-2 text-ink-2'
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-semibold ${colours}`}
    >
      {children}
    </span>
  )
}
