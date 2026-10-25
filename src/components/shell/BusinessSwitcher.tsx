import { useEffect, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Popover } from 'radix-ui'
import { api } from '../../../convex/_generated/api'
import { useAccess } from '#/lib/access'
import { confirmLeave } from '#/lib/offline/leaveGuard'
import { lineDown as lineDownNow, useLineDown } from '#/lib/offline/useLineDown'
import { rq } from '#/lib/routeQueries'
import type { MouseEvent } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import type { Id } from '../../../convex/_generated/dataModel'
import type { ShellBusiness, ShellMembership } from './AppShell'

/**
 * Whether `target` can be entered from what this phone already holds: the
 * three answers `$businessSlug`'s guard waits on. Without all three, a switch
 * with the line down waits on a line that isn't there, on the page it came
 * from, with nothing to say why.
 */
export function canSwitchWithoutSignal(
  queryClient: QueryClient,
  target: { slug: string; businessId: Id<'businesses'> },
): boolean {
  // Null is an answer, but not one the guard can enter with: it asks the
  // server again, and with no line that is "Not found".
  const business = queryClient.getQueryData(
    convexQuery(api.businesses.getBySlug, { slug: target.slug }).queryKey,
  )
  return (
    business != null &&
    queryClient.getQueryData(rq.access(target.businessId).queryKey) !==
      undefined &&
    queryClient.getQueryData(
      convexQuery(api.businesses.listForUser, {}).queryKey,
    ) !== undefined
  )
}

/** A plain click: one that would follow the link in this tab. */
const followsHere = (e: MouseEvent) =>
  e.button === 0 && !(e.metaKey || e.altKey || e.ctrlKey || e.shiftKey)

export function BusinessSwitcher({
  current,
  membership,
}: {
  current: ShellBusiness
  membership: ShellMembership
}) {
  const { data: businesses } = useSuspenseQuery(
    convexQuery(api.businesses.listForUser, {}),
  )
  // Live, not the route-context snapshot beside it: that is resolved once in
  // `beforeLoad` and cannot follow a role change or a switch. The colour is
  // live too since the owner can change it (Settings → Team); the snapshot is
  // the fallback for a backend that does not send it yet.
  const { role } = useAccess()
  const colour =
    businesses.find((b) => b.slug === current.slug)?.colour ?? membership.colour
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const lineDown = useLineDown()
  // A switch just refused for want of signal, said until the line is back
  // or the list is closed.
  const [refused, setRefused] = useState(false)
  useEffect(() => {
    if (!lineDown) setRefused(false)
  }, [lineDown])

  const trigger = (
    // Collapsed, this reduces to the membership colour dot centred in the
    // rail — the business name has nowhere to go at 52px, and a clipped
    // "Coasta" reads as a rendering fault rather than as a name.
    <div className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
      <span
        aria-hidden
        className="size-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: colour }}
      />
      <span className="min-w-0 flex-1 group-data-[collapsible=icon]:sr-only">
        <span className="block truncate text-row-title text-ink">
          {current.name}
        </span>
        <span className="block text-caption capitalize text-muted">{role}</span>
      </span>
    </div>
  )

  if (businesses.length <= 1) return trigger

  /**
   * Another business, in this tab. Refused at once with the line down and
   * the business not already on this phone. Otherwise whatever would be
   * lost by leaving asks first (lib/offline/leaveGuard.ts), and the line is
   * asked about again after, since an answer can take a while.
   */
  function switchTo(e: MouseEvent, target: (typeof businesses)[number]) {
    if (target.slug === current.slug || !followsHere(e)) return
    e.preventDefault()
    const ready = () =>
      lineDownNow() === null || canSwitchWithoutSignal(queryClient, target)
    if (!ready()) {
      setRefused(true)
      return
    }
    void confirmLeave('switchBusiness').then((go) => {
      if (!go) return
      if (!ready()) {
        setRefused(true)
        return
      }
      void navigate({
        to: '/$businessSlug/schedule',
        params: { businessSlug: target.slug },
      })
    })
  }

  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (!open) setRefused(false)
      }}
    >
      <Popover.Trigger className="flex w-full items-center rounded-xl transition hover:bg-surface-2">
        {trigger}
        <ChevronsUpDown
          size={16}
          strokeWidth={2.2}
          className="mr-2 text-muted group-data-[collapsible=icon]:hidden"
        />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 w-60 rounded-2xl border border-hairline bg-surface p-1.5 shadow-elevation"
        >
          {businesses.map((b) => (
            <Link
              key={b.businessId}
              to="/$businessSlug/schedule"
              params={{ businessSlug: b.slug }}
              onClick={(e) => switchTo(e, b)}
              className="flex items-center gap-2 rounded-xl px-2.5 py-2 transition hover:bg-surface-2"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-row-title text-ink">
                  {b.name}
                </span>
                <span className="block text-caption capitalize text-muted">
                  {b.role}
                </span>
              </span>
              {b.slug === current.slug && (
                <Check size={16} strokeWidth={2.2} className="text-red" />
              )}
            </Link>
          ))}
          {/* After the list, so nothing in it moves. */}
          {refused && (
            <p
              role="alert"
              className="px-2.5 pb-1.5 pt-1 text-caption text-amber-ink"
            >
              Switching business needs signal.
            </p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
