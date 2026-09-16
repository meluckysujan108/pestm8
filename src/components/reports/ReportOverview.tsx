import { Check, ChevronRight, FileText, Lock } from 'lucide-react'
import type { ReportProgress, SectionProgress } from '#/lib/reportTemplates/progress'

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
}: {
  progress: ReportProgress
  onOpen: (section: SectionProgress) => void
  onFinalise: () => void
  disabled: boolean
}) {
  return (
    <nav aria-label="Sections" className="mt-5">
      <ul className="overflow-hidden rounded-2xl border border-hairline bg-surface">
        {progress.sections.map((section) => (
          <li key={section.id} className="border-t border-hairline-2 first:border-t-0">
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
                <span className="block truncate text-row-title text-ink">{section.title}</span>
                <SectionStatus section={section} />
              </span>
              <ChevronRight size={18} strokeWidth={1.8} className="shrink-0 text-muted" />
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
          className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-hairline bg-surface text-[15px] font-semibold text-ink transition active:scale-[.99] disabled:opacity-50"
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
        <FileText size={13} strokeWidth={1.8} />
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
    <span className="mt-0.5 flex items-center gap-1 text-caption text-green">
      <Check size={13} strokeWidth={2.4} />
      {/* "Complete" would overclaim on a section whose optional questions are
          all blank: what is true is that nothing is outstanding. */}
      {section.answered > 0 ? 'Done' : 'Nothing needed'}
    </span>
  )
}
