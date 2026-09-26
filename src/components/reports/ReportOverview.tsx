import { Check, ChevronRight, FileText, History, Lock } from 'lucide-react'
import type {
  ReportProgress,
  SectionProgress,
} from '#/lib/reportTemplates/progress'
import { SECONDARY_BUTTON_COMPACT } from '#/components/primitives/buttons'
import { useBusinessTimezone } from '#/lib/useBusinessTimezone'
import { dateTimeFormat } from '../../../convex/lib/dates'

/**
 * Where a report is up to, and the way into it.
 *
 * The form is answered a section at a time, so this is the hub the technician
 * comes back to. Every row says the same thing the section screen will say —
 * one `reportProgress` feeds both — because a list that claims "Complete" and
 * then refuses to lock is worse than no list at all.
 */
export function ReportOverview({
  progress,
  onOpen,
  onFinalise,
  disabled,
  lastVisit,
}: {
  progress: ReportProgress
  onOpen: (section: SectionProgress) => void
  onFinalise: () => void
  disabled: boolean
  /** The offer to fill this in from the last report at the same address. */
  lastVisit?: LastVisitOffer
}) {
  return (
    // Named apart from the desktop rail below: two landmarks called "Sections"
    // is a screen reader saying the same thing about two different things.
    <nav aria-label="Report sections" className="mt-5">
      {lastVisit && <LastVisitCard offer={lastVisit} />}

      <ul className="overflow-hidden rounded-2xl border border-hairline bg-surface">
        {progress.sections.map((section) => (
          <li
            key={section.id}
            className="border-t border-hairline-2 first:border-t-0"
          >
            <button
              type="button"
              onClick={() => onOpen(section)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left transition active:bg-surface-2"
            >
              {/* The form's own numbering, so "section 3" means the same thing
                  on screen as it does on the printed document. */}
              <span className="w-5 shrink-0 text-caption tabular-nums text-muted">
                {section.number ?? ''}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-row-title text-ink">
                  {section.title}
                </span>
                <SectionStatus section={section} />
              </span>
              <ChevronRight
                size={18}
                strokeWidth={2}
                className="shrink-0 text-muted"
              />
            </button>
          </li>
        ))}
      </ul>

      {/* Always here, never greyed out. A technician who believes the report is
          finished can say so and be told what is missing, instead of being left
          to guess why the button will not press. */}
      {!progress.complete && (
        <button
          type="button"
          disabled={disabled}
          onClick={onFinalise}
          className={`${SECONDARY_BUTTON_COMPACT} mt-3 flex w-full items-center justify-center gap-2`}
        >
          <Lock size={15} strokeWidth={2} />
          Finalise &amp; lock
        </button>
      )}
    </nav>
  )
}

function SectionStatus({ section }: { section: SectionProgress }) {
  if (section.readingOnly) {
    return (
      <span className="mt-0.5 flex items-center gap-1 text-caption text-muted">
        <FileText size={13} strokeWidth={2} />
        To read
      </span>
    )
  }

  if (section.toConfirm.length > 0) {
    return (
      <span className="mt-0.5 block text-caption text-amber-ink">
        {section.toConfirm.length === 1
          ? '1 answer to confirm'
          : `${section.toConfirm.length} answers to confirm`}
      </span>
    )
  }

  if (section.missing.length > 0) {
    return (
      <span className="mt-0.5 block text-caption text-muted">
        {section.missing.length} to go
      </span>
    )
  }

  return (
    <span className="mt-0.5 flex items-center gap-1 text-caption text-green-ink">
      <Check size={13} strokeWidth={2.2} />
      {/* "Complete" would overclaim on a section whose optional questions are
          all blank: what is true is that nothing is outstanding. */}
      {section.answered > 0 ? 'Done' : 'Nothing needed'}
    </span>
  )
}

export type LastVisitOffer = {
  /** When the report it would copy from was signed. */
  finalisedAt: number
  /** The questions it would answer, in the form's own words. */
  labels: Array<string>
  onCopy: () => void
  pending: boolean
}

/**
 * The second visit to a site, offered rather than assumed.
 *
 * A quarterly service is usually last quarter's treatment at the same house,
 * and typing it again is the biggest tax on a return visit. It is still only
 * an offer: what it fills in arrives marked as a suggestion, and the
 * technician passes each section and agrees to it before anything prints.
 */
function LastVisitCard({ offer }: { offer: LastVisitOffer }) {
  const timezone = useBusinessTimezone()
  // Named rather than counted: "Copy 6 answers" tells a technician nothing
  // about whether they want them.
  const named = offer.labels.slice(0, 2).join(' and ')
  const rest = offer.labels.length - 2

  return (
    <div className="mb-3 flex items-center gap-3 rounded-2xl border border-hairline bg-surface px-4 py-3 shadow-elevation">
      <History size={17} strokeWidth={2} className="shrink-0 text-blue" />
      <p className="min-w-0 flex-1 text-caption text-muted">
        <span className="block text-row-title text-ink">
          Copy from {visitDate(offer.finalisedAt, timezone)}?
        </span>
        {named}
        {rest > 0 ? ` and ${rest} more` : ''}
      </p>
      <button
        type="button"
        disabled={offer.pending}
        onClick={offer.onCopy}
        className="h-9 shrink-0 rounded-xl bg-surface-2 px-3.5 text-caption font-semibold text-ink transition active:scale-[.97] disabled:opacity-50"
      >
        {offer.pending ? 'Copying…' : 'Copy'}
      </button>
    </div>
  )
}

function visitDate(at: number, timezone: string) {
  return dateTimeFormat('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: timezone,
  }).format(new Date(at))
}

/**
 * The same sections as a standing list, for a screen with room for one.
 *
 * On a phone the overview IS the screen and a section replaces it; on a
 * desktop there is space to keep the whole form in view beside the section
 * being filled, so the technician can see what is left without leaving what
 * they are doing.
 */
export function SectionNav({
  progress,
  currentId,
  onOpen,
  onOverview,
}: {
  progress: ReportProgress
  currentId: string | null
  onOpen: (section: SectionProgress) => void
  onOverview: () => void
}) {
  return (
    <nav aria-label="Sections" className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={onOverview}
        data-active={currentId === null}
        className="rounded-lg px-3 py-2 text-left text-body text-muted transition data-[active=true]:bg-surface data-[active=true]:font-semibold data-[active=true]:text-ink"
      >
        Overview
      </button>

      {progress.sections.map((section) => (
        <button
          key={section.id}
          type="button"
          onClick={() => onOpen(section)}
          data-active={section.id === currentId}
          className="flex flex-col rounded-lg px-3 py-2 text-left transition data-[active=true]:bg-surface"
        >
          <span className="flex gap-2 text-body text-ink">
            <span className="tabular-nums text-muted">
              {section.number ?? ''}
            </span>
            <span className="min-w-0 flex-1 truncate">{section.title}</span>
          </span>
          <SectionStatus section={section} />
        </button>
      ))}
    </nav>
  )
}
