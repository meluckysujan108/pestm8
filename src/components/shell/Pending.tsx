import type { ReactNode } from 'react'

/**
 * Placeholders shown while something is loading.
 *
 * Before these existed, no route had a pending component, so the only Suspense
 * boundary was the root Outlet's — whose fallback is nothing. A page that
 * suspended on its data took the header, the sidebar and the dock down with
 * it, and a cold tab switch blanked the whole app for up to a second.
 * `PagePending` is the router's `defaultPendingComponent`, which gives every
 * route its own boundary, so a page loads inside a shell that stays put.
 *
 * What the end-to-end suite relies on, and so what these must never contain:
 * a heading, a button, a <header> or <nav>, a tab, or any visible text. Specs
 * take a page's heading, or a control turning enabled, as the sign it has
 * loaded, and a placeholder carrying one would pass that check early. The one
 * exception is a sheet's own title, which `SheetPending` is handed: it is the
 * dialog's accessible name and is known before anything else in the sheet.
 * Only the page-level placeholder is a `status` region — deliveries.spec.ts
 * reads a sheet's `status` as its search results.
 *
 * Sized to what they stand in for, so nothing jumps when the content lands.
 * `PagePending` is in the entry chunk (the router imports it), so it stays
 * small.
 */

export function Bone({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`block rounded-md bg-surface-2 motion-safe:animate-pulse ${className}`}
    />
  )
}

/** A route loading: PageHeader's exact box, then a few card-sized rows. */
export function PagePending() {
  return (
    <div role="status">
      <span className="sr-only">Loading</span>
      <div
        aria-hidden
        className="chrome-blur sticky top-0 z-30 flex items-end justify-between gap-3 border-b border-hairline px-4 pb-3 pt-[calc(12px+env(safe-area-inset-top))]"
      >
        {/* PageHeader's sidebar toggle, so the title does not shift on lg. */}
        <Bone className="mb-1 hidden size-8 shrink-0 lg:block" />
        <div className="min-w-0 flex-1">
          {/* The kicker's line box: `section-label` sets no line-height, so
              it inherits 1.5 — 16.5px at 11px, not the glyph height. */}
          <div className="mb-0.5 flex h-[16.5px] items-center">
            <Bone className="h-[11px] w-24" />
          </div>
          <Bone className="h-8 w-40" />
        </div>
        <Bone className="size-9 shrink-0 rounded-full" />
      </div>
      <CardRows count={4} className="px-4 pt-4" />
    </div>
  )
}

/** List or board rows, as the schedule and clients draw them. */
export function CardRows({
  count,
  className = '',
}: {
  count: number
  className?: string
}) {
  return (
    <div
      aria-hidden
      className={`flex flex-col gap-2.5 md:grid md:grid-cols-2 ${className}`}
    >
      {Array.from({ length: count }, (_, i) => (
        <Bone key={i} className="h-[88px] rounded-2xl" />
      ))}
    </div>
  )
}

/** A form section loading: Settings between segments. */
export function SectionPending() {
  return (
    <div aria-hidden className="flex flex-col gap-3">
      <div className="flex h-[16.5px] items-center">
        <Bone className="h-[11px] w-28" />
      </div>
      <Bone className="h-12 rounded-xl" />
      <Bone className="h-12 rounded-xl" />
      <Bone className="h-12 rounded-xl" />
    </div>
  )
}

/**
 * A bottom sheet's body loading. The sheet itself slides up at once, which is
 * the acknowledgement; this holds its height so the drawer does not animate
 * twice as the form arrives. `title` is the sheet's real title element (a
 * `Drawer.Title`, passed in so vaul stays out of the entry chunk), in the
 * place the loaded sheet draws it.
 */
export function SheetPending({ title }: { title: ReactNode }) {
  return (
    <div className="flex min-h-[85vh] flex-1 flex-col gap-3 px-4 pb-[calc(24px+env(safe-area-inset-bottom))] pt-3">
      {title}
      <Bone className="h-12 rounded-xl" />
      <Bone className="h-12 rounded-xl" />
      <Bone className="h-12 rounded-xl" />
      <Bone className="h-24 rounded-xl" />
    </div>
  )
}

/**
 * A month's days loading, cell for cell: the same leading blanks and the same
 * number of rows as the month it stands in for, each cell the day button's
 * height (a 36px date over its dots and count), so the grid neither shrinks
 * nor grows when the counts arrive.
 */
export function MonthDaysPending({ cells }: { cells: Array<string | null> }) {
  return (
    <div aria-hidden className="mt-1 grid grid-cols-7 gap-1">
      {cells.map((dayKey, i) =>
        dayKey ? (
          <span key={dayKey} className="flex flex-col items-center py-1.5">
            <Bone className="size-9 rounded-full" />
            <span className="h-6" />
          </span>
        ) : (
          <span key={`pad-${i}`} />
        ),
      )}
    </div>
  )
}
