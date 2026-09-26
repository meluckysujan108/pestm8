import { abnDigits, formatAbn } from '../../../convex/lib/abn'
import { LICENCE_LABEL, TIMEZONE_BY_STATE } from '#/lib/au'

/** The part of the preview the current step is filling in. */
export type PreviewFocus = 'name' | 'brand' | 'licence' | null

/**
 * The top of a report as this business's will print — drawn live as set-up
 * fills it in, so each answer is seen landing where a client will read it.
 *
 * A likeness, not the document: it follows the real PDF's header
 * (components/reports/pdf/layout.tsx — logo left, the business and its
 * contact lines right, in that order: name, email, website, phone) and its
 * red title band, and says nothing it would not. Pinned light, because it
 * is paper.
 */
export function ReportPreview({
  name,
  logoUrl,
  email,
  phone,
  abn,
  state,
  licenceNumber,
  focus,
  className = '',
}: {
  name: string
  logoUrl?: string | null
  email?: string
  phone?: string
  abn?: string
  state: string
  licenceNumber?: string
  focus: PreviewFocus
  className?: string
}) {
  const shownName = name.trim() || 'Your business'
  const lines = [email, phone]
    .map((line) => line?.trim())
    .filter((line): line is string => Boolean(line))
  // As the server will store and print it: "51 824 753 556".
  const digits = abn ? abnDigits(abn) : null
  const shownAbn = digits ? formatAbn(digits) : abn?.trim()
  // The business's own day, as the report dates its work — the same on the
  // server's render as on the phone's, wherever either is.
  const date = new Date().toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: TIMEZONE_BY_STATE[state],
  })

  return (
    <figure
      data-theme="light"
      aria-label="How the top of your reports will look"
      className={`select-none overflow-hidden rounded-2xl border border-hairline bg-surface text-ink shadow-elevation ${className}`}
    >
      <div
        className={`m-2 flex items-start justify-between gap-3 rounded-xl p-2.5 transition-shadow duration-300 ${focus === 'brand' || focus === 'name' ? 'ring-2 ring-blue/35' : 'ring-0 ring-transparent'}`}
      >
        <div className="flex h-9 w-[92px] shrink-0 items-center">
          {logoUrl ? (
            <img
              src={logoUrl}
              alt=""
              className="max-h-full max-w-full object-contain object-left"
            />
          ) : (
            <span className="flex size-full items-center justify-center rounded-md border border-dashed border-muted/60 text-[10px] text-muted">
              Your logo
            </span>
          )}
        </div>
        <div className="min-w-0 text-right">
          <p className="truncate text-caption font-semibold leading-tight">
            {shownName}
          </p>
          {lines.map((line) => (
            <p
              key={line}
              className="truncate text-[11px] leading-snug text-ink-2"
            >
              {line}
            </p>
          ))}
        </div>
      </div>

      {/* The printed PDF's own band, drawn as it prints (brand red). */}
      <div className="mx-4 flex items-center gap-2 bg-red-fill px-2.5 py-1.5 text-[11px] font-semibold leading-tight text-white">
        <span className="line-clamp-2 min-w-0 flex-1">
          {shownName} Service Report
        </span>
        <span aria-hidden className="h-3 w-px shrink-0 bg-white/90" />
        {/* Server and phone read the clock a moment apart; at midnight the
            day can turn over between the two. */}
        <span className="shrink-0" suppressHydrationWarning>
          {date}
        </span>
      </div>

      <dl className="mx-2 mb-2 mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-2.5 py-2 text-[11px]">
        <div
          className={`col-span-2 -mx-2 grid grid-cols-subgrid rounded-lg px-2 py-1 transition-shadow duration-300 ${focus === 'licence' ? 'ring-2 ring-blue/35' : 'ring-0 ring-transparent'}`}
        >
          <dt className="text-ink-2">{LICENCE_LABEL[state] ?? 'Licence'}</dt>
          <dd className="truncate text-right font-medium">
            {licenceNumber?.trim() || (
              <span className="font-normal text-muted">Your number</span>
            )}
          </dd>
        </div>
        <div className="col-span-2 -mx-2 grid grid-cols-subgrid px-2 py-1">
          <dt className="text-ink-2">ABN</dt>
          <dd className="truncate text-right font-medium">
            {shownAbn || <span className="font-normal text-muted">—</span>}
          </dd>
        </div>
      </dl>

      <div aria-hidden className="space-y-1.5 px-4 pb-4">
        <span className="block h-1.5 w-full rounded-full bg-surface-3" />
        <span className="block h-1.5 w-4/5 rounded-full bg-surface-3" />
        <span className="block h-1.5 w-3/5 rounded-full bg-surface-3" />
      </div>
    </figure>
  )
}
