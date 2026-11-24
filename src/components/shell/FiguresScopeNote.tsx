import { useViewMode } from '#/lib/access'
import { useHydrated } from '#/lib/useHydrated'
import { useSetView } from '#/lib/useSetView'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * Said under totals that cover less than the whole business, so nobody takes
 * their own figures for everyone's: Analytics and Payments.
 *
 * In My jobs it carries the way out, "Switch to Overview", where the figures
 * are — everyone opens in My jobs, and an owner reading his own unpaid work
 * as the business's would miss everyone else's. In a contractor's Overview
 * the figures are their team's, still not the whole business's. Anyone else
 * whose figures are their own has no Overview to go to.
 *
 * `scope` is the server's answer for these figures (`wireScope` in
 * convex/lib/jobScope.ts), so it is never ahead of or behind the view.
 */
export function FiguresScopeNote({
  businessId,
  scope,
  className = '',
}: {
  businessId: Id<'businesses'>
  scope: 'business' | 'assignee' | undefined
  className?: string
}) {
  const mode = useViewMode()
  const hydrated = useHydrated()
  const setView = useSetView(businessId)

  if (scope !== 'assignee') return null

  return (
    <p className={`text-caption text-muted ${className}`}>
      {mode === 'everyone'
        ? 'These figures cover your team’s jobs.'
        : 'These figures cover your own jobs.'}
      {mode === 'mine' && (
        <>
          {' '}
          <button
            type="button"
            disabled={!hydrated || setView.isPending}
            onClick={() => setView.mutate({ kind: 'everyone' })}
            className="relative tap-target font-semibold text-blue disabled:opacity-50"
          >
            Switch to Overview
          </button>
        </>
      )}
    </p>
  )
}
