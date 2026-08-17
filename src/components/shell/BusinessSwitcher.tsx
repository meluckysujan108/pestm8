import { Link } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Popover } from 'radix-ui'
import { api } from '../../../convex/_generated/api'
import type { ShellBusiness, ShellMembership } from './AppShell'

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

  const trigger = (
    <div className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left">
      <span
        aria-hidden
        className="size-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: membership.colour }}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-row-title text-ink">
          {current.name}
        </span>
        <span className="block text-caption capitalize text-muted">
          {membership.role}
        </span>
      </span>
    </div>
  )

  if (businesses.length <= 1) return trigger

  return (
    <Popover.Root>
      <Popover.Trigger className="flex w-full items-center rounded-xl transition hover:bg-surface-2">
        {trigger}
        <ChevronsUpDown size={16} strokeWidth={1.7} className="mr-2 text-muted" />
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
              to="/$businessSlug/dashboard"
              params={{ businessSlug: b.slug }}
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
                <Check size={16} strokeWidth={2} className="text-red" />
              )}
            </Link>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
