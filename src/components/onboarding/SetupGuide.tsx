import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { Check, ChevronRight } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { FormAlert } from '#/components/forms/FormAlert'
import { Sheet } from '#/components/primitives/Sheet'
import { useCan } from '#/lib/access'
import { rq } from '#/lib/routeQueries'
import { useHydrated } from '#/lib/useHydrated'
import type { SetupGuideItem } from '../../../convex/setupGuide'
import type { Id } from '../../../convex/_generated/dataModel'

/** What each item asks, and why it is worth doing — one line each. */
const COPY: Record<SetupGuideItem, { title: string; hint: string }> = {
  business: {
    title: 'Create your business',
    hint: 'Done — welcome to PestM8.',
  },
  letterhead: {
    title: 'Add your logo and contact details',
    hint: 'They head every report and certificate you send.',
  },
  licence: {
    title: 'Add your licence number',
    hint: 'Certificates and inspection reports can’t be finalised without it.',
  },
  firstJob: {
    title: 'Book your first job',
    hint: 'Put a real job on the schedule.',
  },
  firstReport: {
    title: 'Finish your first report',
    hint: 'Fill it in on site and finalise it.',
  },
  team: {
    title: 'Invite your team',
    hint: 'Each person gets their own account and their own jobs.',
  },
}

/** Putting the guide away needs the server, like any change. */
const HIDE_COPY = {
  offline:
    'Could not hide the guide: this device is offline. Try again when you have signal.',
  default: 'Could not hide the guide. Check your connection and try again.',
}

type Progress = NonNullable<ReturnType<typeof useGuide>['data']>

function useGuide(businessId: Id<'businesses'>) {
  // The owner's to do. Asked of no one else, so nobody else waits on it.
  const canManage = useCan('business.manage')
  // Warmed by the schedule's and Settings' loaders, so it is there on
  // arrival rather than pushing the page down after it.
  return useQuery({ ...rq.setupGuide(businessId), enabled: canManage })
}

/**
 * The set-up guide, at the top of the schedule: how far set-up has got and
 * what is next, one tap from a checklist whose items each go straight to
 * where that thing is done.
 *
 * It ticks itself — every item is read off the business, live — and it goes
 * when the owner says so, not before: finished, it says "You're all set" and
 * waits for Done. Nothing at all for anyone but the owner, or for a business
 * that was running before set-up existed.
 */
export function SetupGuideCard({
  businessId,
  businessSlug,
  onBookJob,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  /** New Job, on the screen this sits on. */
  onBookJob: () => void
}) {
  const hydrated = useHydrated()
  const { data } = useGuide(businessId)
  const [open, setOpen] = useState(false)
  const setHidden = useConvexMutation(api.setupGuide.setHidden)
  const hide = useMutation({
    mutationFn: () => setHidden({ businessId, hidden: true }),
    onSuccess: () => setOpen(false),
  })

  if (!data || data.hidden) return null

  const done = data.items.filter((item) => item.done).length
  const total = data.items.length
  const complete = done === total
  const next = data.items.find((item) => !item.done)

  return (
    <div className="px-4 pb-3 pt-3 lg:pb-0 lg:pt-4">
      <div className="flex items-center gap-3 rounded-2xl border border-hairline bg-surface p-3 shadow-elevation">
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={!hydrated}
          aria-label={`Set-up guide: ${done} of ${total} done`}
          className="flex min-w-0 flex-1 items-center gap-3 text-left transition active:opacity-70"
        >
          <ProgressRing done={done} total={total} />
          <span className="min-w-0 flex-1">
            <span className="block text-[16px] font-semibold text-ink">
              {complete ? 'You’re all set' : 'Finish setting up'}
            </span>
            <span className="block truncate text-caption text-muted">
              {complete
                ? 'Everything a new business needs is in place.'
                : next && `Next: ${COPY[next.key].title}`}
            </span>
          </span>
          {!complete && (
            <ChevronRight
              aria-hidden
              size={18}
              strokeWidth={2.2}
              className="shrink-0 text-muted-2"
            />
          )}
        </button>
        {complete && (
          <button
            type="button"
            onClick={() => hide.mutate()}
            disabled={!hydrated || hide.isPending}
            className="min-h-11 shrink-0 rounded-xl bg-surface-2 px-3.5 text-[15px] font-semibold text-blue transition active:scale-[.98] disabled:opacity-50"
          >
            Done
          </button>
        )}
      </div>

      {!open && (
        <FormAlert
          error={hide.isError ? hide.error : null}
          copy={HIDE_COPY}
          className="mt-2"
        />
      )}

      <Sheet open={open} onClose={() => setOpen(false)} title="Get set up">
        <GuideChecklist
          data={data}
          businessSlug={businessSlug}
          onClose={() => setOpen(false)}
          onBookJob={onBookJob}
          onHide={() => hide.mutate()}
          hiding={hide.isPending}
          hideError={hide.isError ? hide.error : null}
        />
      </Sheet>
    </div>
  )
}

function GuideChecklist({
  data,
  businessSlug,
  onClose,
  onBookJob,
  onHide,
  hiding,
  hideError,
}: {
  data: Progress
  businessSlug: string
  onClose: () => void
  onBookJob: () => void
  onHide: () => void
  hiding: boolean
  hideError: unknown
}) {
  const navigate = useNavigate()
  const done = data.items.filter((item) => item.done).length
  const total = data.items.length
  const params = { businessSlug }

  // The sheet goes first: a settings page can take a moment to arrive, and
  // an open sheet with nothing happening invites a second tap.
  const act = (key: SetupGuideItem) => {
    onClose()
    switch (key) {
      case 'letterhead':
        return navigate({ to: '/$businessSlug/settings/business', params })
      case 'licence':
        return navigate({ to: '/$businessSlug/settings/licence', params })
      case 'firstJob':
        return onBookJob()
      case 'firstReport':
        return navigate({ to: '/$businessSlug/reports/new', params })
      case 'team':
        return navigate({ to: '/$businessSlug/settings/team', params })
      case 'business':
        return
    }
  }

  return (
    <div className="pb-[calc(8px+env(safe-area-inset-bottom))]">
      <div className="flex items-center gap-3">
        <div
          role="progressbar"
          aria-label="Set-up"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3"
        >
          <div
            className="h-full rounded-full bg-green transition-[width] duration-500 ease-out motion-reduce:transition-none"
            style={{ width: `${(done / total) * 100}%` }}
          />
        </div>
        <span className="shrink-0 text-caption text-muted">
          {done} of {total} done
        </span>
      </div>

      <ul className="mt-4 divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-surface">
        {data.items.map((item) => {
          const copy = COPY[item.key]
          return (
            <li key={item.key}>
              <button
                type="button"
                disabled={item.done}
                onClick={() => void act(item.key)}
                className="flex min-h-[60px] w-full items-center gap-3 px-3.5 py-3 text-left transition active:bg-surface-2 disabled:active:bg-transparent"
              >
                <span
                  aria-hidden
                  className={`flex size-6 shrink-0 items-center justify-center rounded-full ${
                    item.done
                      ? 'bg-green text-white'
                      : 'border-2 border-hairline'
                  }`}
                >
                  {item.done && <Check size={14} strokeWidth={3} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={`block text-body ${item.done ? 'text-muted' : 'text-ink'}`}
                  >
                    {copy.title}
                    {item.done && <span className="sr-only"> (done)</span>}
                  </span>
                  <span className="block text-caption text-muted">
                    {copy.hint}
                  </span>
                </span>
                {!item.done && (
                  <ChevronRight
                    aria-hidden
                    size={17}
                    strokeWidth={2.2}
                    className="shrink-0 text-muted-2"
                  />
                )}
              </button>
            </li>
          )
        })}
      </ul>

      <FormAlert error={hideError} copy={HIDE_COPY} className="mt-4" />
      <button
        type="button"
        onClick={onHide}
        disabled={hiding}
        className="mt-4 min-h-11 w-full text-[15px] text-blue transition active:opacity-60 disabled:opacity-50"
      >
        Hide the guide
      </button>
      <p className="text-center text-caption text-muted">
        It’s in Settings if you want it back.
      </p>
    </div>
  )
}

/** How far along, at a glance: a ring that fills as items tick over. */
function ProgressRing({ done, total }: { done: number; total: number }) {
  const r = 17
  const circumference = 2 * Math.PI * r
  const filled = total === 0 ? 0 : done / total
  return (
    <span className="relative flex size-11 shrink-0 items-center justify-center">
      <svg
        viewBox="0 0 44 44"
        className="absolute inset-0 -rotate-90"
        aria-hidden
      >
        <circle
          cx="22"
          cy="22"
          r={r}
          fill="none"
          strokeWidth="4"
          className="stroke-surface-3"
        />
        <circle
          cx="22"
          cy="22"
          r={r}
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - filled)}
          className="stroke-green transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
        />
      </svg>
      <span className="text-[12px] font-semibold text-ink">
        {done}/{total}
      </span>
    </span>
  )
}

/**
 * Settings' way back to a guide that was put away with work still left —
 * for the owner, and only then. A row, not a link: it brings the guide back
 * and then goes to where it lives.
 */
export function useHiddenGuide(businessId: Id<'businesses'>): {
  done: number
  total: number
} | null {
  const { data } = useGuide(businessId)
  if (!data || !data.hidden) return null
  const done = data.items.filter((item) => item.done).length
  if (done === data.items.length) return null
  return { done, total: data.items.length }
}
