import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { AlertTriangle, Check } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * Manual follow-ups, chiefly the AS 3660.2 durable notice. This card is the
 * whole point of tracking them: a compliance step the app cannot perform is
 * only handled if someone is reminded it is outstanding (§1.4).
 */
export function FollowUpTasks({
  businessId,
}: {
  businessId: Id<'businesses'>
}) {
  const { data: tasks } = useSuspenseQuery(
    convexQuery(api.tasks.listOpen, { businessId }),
  )

  const convexComplete = useConvexMutation(api.tasks.complete)
  const complete = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'>; taskId: Id<'tasks'> }) =>
      convexComplete(args),
  })

  if (tasks.length === 0) return null

  return (
    <section className="md:col-span-3">
      <h2 className="section-label mb-2">Follow-ups</h2>
      <div className="flex flex-col gap-2">
        {tasks.map((task) => (
          <div
            key={task._id}
            className="flex items-start gap-3 rounded-2xl border border-amber-line bg-amber-bg p-3.5"
          >
            <AlertTriangle
              size={17}
              strokeWidth={2}
              className="mt-0.5 shrink-0 text-amber-ink"
            />
            <div className="min-w-0 flex-1">
              <p className="text-row-title text-amber-ink">{task.label}</p>
              {task.detail && (
                <p className="mt-0.5 text-caption text-amber-ink/85">
                  {task.detail}
                </p>
              )}
            </div>
            <button
              type="button"
              aria-label={`Mark done: ${task.label}`}
              disabled={complete.isPending}
              onClick={() => complete.mutate({ businessId, taskId: task._id })}
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface text-amber-ink transition active:scale-[.95] disabled:opacity-50"
            >
              <Check size={16} strokeWidth={2.4} />
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}
