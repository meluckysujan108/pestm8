import { CalendarClock } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { sgarFollowUp } from '#/lib/reportTemplates/sgar'
import { formatDayLabel } from '#/lib/format'
import { useBusinessTimezone } from '#/lib/useBusinessTimezone'
import { dayKeyOf } from '../../../convex/lib/dates'
import type { ReportTemplate } from '#/lib/reportTemplates'

/**
 * When a rodent treatment has to be gone back to.
 *
 * The APVMA suspended second-generation anticoagulant rodenticides on 24 March
 * 2026 with replacement label instructions, one of which is an evaluation
 * within 35 days. The Service Report's method list carries that instruction
 * verbatim, so a finished report already knows — and the person who needs to
 * act on it is looking at the report, not at a calendar.
 *
 * It says so and links to the day. Booking the visit is a decision with a
 * price and a person attached, and this knows neither.
 */
export function SgarNotice({
  businessSlug,
  template,
  data,
  finalisedAt,
}: {
  businessSlug: string
  /** The wording the report was signed against. */
  template: ReportTemplate
  data: Record<string, unknown>
  finalisedAt?: number
}) {
  const timezone = useBusinessTimezone()
  const due = sgarFollowUp(template, data, finalisedAt)
  if (!due) return null

  const dueDay = dayKeyOf(due.dueBy, timezone)

  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-amber-line bg-amber-bg px-3 py-2.5">
      <CalendarClock
        size={16}
        strokeWidth={2}
        className="mt-0.5 shrink-0 text-amber-ink"
      />
      <div className="min-w-0 flex-1">
        <p className="text-caption text-amber-ink">
          {/* A suspension with replacement label instructions — never a "ban",
              never "new legislation". */}
          This treatment used an SGAR. APVMA label instructions require an
          evaluation within 35 days, so by {formatDayLabel(dueDay)}
          {due.daysRemaining < 0 ? ' — which has passed' : ''}.
        </p>
        <Link
          to="/$businessSlug/schedule"
          params={{ businessSlug }}
          search={{ date: dueDay }}
          className="relative tap-target mt-1 inline-block text-caption font-semibold text-amber-ink underline"
        >
          Open that week
        </Link>
      </div>
    </div>
  )
}
