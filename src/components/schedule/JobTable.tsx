import { Repeat } from 'lucide-react'
import { formatDuration, formatMoney, formatTime } from '#/lib/format'
import { StatusPill } from '#/components/primitives/StatusPill'
import { WeatherGlyph } from './WeatherGlyph'
import { weatherKeyOf } from '#/lib/useDayWeather'
import type { JobRow } from './JobCard'
import type { DayWeather } from '#/lib/useDayWeather'

/**
 * Desktop-only dense alternative to the card list — same jobs, same click
 * target, laid out for scanning many rows at once rather than glancing at
 * one. No table library: a single day's jobs, already chronologically
 * sorted, never gets big enough to need sorting/pagination machinery.
 */
export function JobTable({
  jobs,
  weather,
  selectedKey,
  timezone,
  onOpenJob,
}: {
  jobs: Array<JobRow>
  weather: Record<string, DayWeather>
  selectedKey: string
  timezone: string
  onOpenJob: (jobId: string) => void
}) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-hairline bg-surface shadow-elevation">
      <table className="w-full min-w-[760px] text-left">
        <thead>
          <tr className="border-b border-hairline text-section-label text-muted">
            <th className="px-4 py-2.5 font-bold">#</th>
            <th className="px-2 py-2.5 font-bold">Job type</th>
            <th className="px-2 py-2.5 font-bold">Client</th>
            <th className="px-2 py-2.5 font-bold">Time</th>
            <th className="px-2 py-2.5 font-bold">Duration</th>
            <th className="px-2 py-2.5 font-bold">Location</th>
            <th className="px-2 py-2.5 font-bold">Status</th>
            <th className="px-4 py-2.5 text-right font-bold">Price</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {jobs.map((job) => {
            const dayWeather = weather[weatherKeyOf(job.suburb, job.postcode ?? '', selectedKey)]
            return (
              <tr
                key={job._id}
                onClick={() => onOpenJob(job._id)}
                style={{ borderLeft: `3px solid ${job.assigneeColour}` }}
                className="cursor-pointer transition hover:bg-surface-2"
              >
                <td className="px-4 py-2.5 text-caption font-bold tabular-nums text-ink-2">
                  #{job.jobNumber ?? '—'}
                </td>
                <td className="px-2 py-2.5">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onOpenJob(job._id)
                    }}
                    className="flex items-center gap-1.5 text-left text-row-title text-ink"
                  >
                    {job.jobType}
                    {job.recurrenceId !== undefined && (
                      <Repeat
                        size={13}
                        strokeWidth={1.7}
                        role="img"
                        aria-label="Recurring job"
                        className="shrink-0 text-blue"
                      />
                    )}
                  </button>
                </td>
                <td className="px-2 py-2.5 text-body text-ink-2">{job.clientName}</td>
                <td className="px-2 py-2.5 text-caption tabular-nums text-muted">
                  {formatTime(job.scheduledAt, timezone)}
                </td>
                <td className="px-2 py-2.5 text-caption tabular-nums text-muted">
                  {formatDuration(job.durationMinutes)}
                </td>
                <td className="px-2 py-2.5 text-caption text-muted">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate">{job.suburb}</span>
                    {dayWeather && <WeatherGlyph weather={dayWeather} size={14} />}
                  </span>
                </td>
                <td className="px-2 py-2.5">
                  <StatusPill status={job.status} />
                </td>
                <td className="px-4 py-2.5 text-right text-row-title tabular-nums text-ink">
                  {formatMoney(job.price)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
