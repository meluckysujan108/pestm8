import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { Link } from '@tanstack/react-router'
import { Popover } from 'radix-ui'
import { Bell, Settings, User } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * The header's account menu — current account, every other account the
 * caller may switch their own view to (read-only "view as", never a session
 * change — see convex/viewAs.ts), a Settings shortcut (intentionally
 * redundant with the sidebar/mobile-tab entries, per its own design), and a
 * notifications bell that is a UI shell only for now.
 */
export function AccountMenu({
  businessId,
  businessSlug,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
}) {
  const [open, setOpen] = useState(false)
  const [showNotifications, setShowNotifications] = useState(false)

  const { data: accounts } = useQuery(
    convexQuery(api.viewAs.listSwitchable, { businessId }),
  )

  const convexSetViewingAs = useConvexMutation(api.memberships.setViewingAs)
  const setViewingAs = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'>; targetMembershipId?: Id<'memberships'> }) =>
      convexSetViewingAs(args),
    onSuccess: () => setOpen(false),
  })

  const self = accounts?.find((a) => a.isSelf)
  const others = accounts?.filter((a) => !a.isSelf) ?? []

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setShowNotifications(false)
      }}
    >
      <Popover.Trigger
        type="button"
        aria-label="Account menu"
        className="flex size-9 items-center justify-center rounded-full bg-surface-2 text-ink-2 transition active:scale-[.95]"
      >
        <User size={18} strokeWidth={1.7} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-50 w-64 rounded-2xl border border-hairline bg-surface p-1.5 shadow-elevation"
        >
          {showNotifications ? (
            <div className="p-2">
              <p className="section-label mb-2 px-1">Notifications</p>
              <p className="rounded-xl bg-surface-2 px-3 py-6 text-center text-body text-muted">
                No notifications yet.
              </p>
              <button
                type="button"
                onClick={() => setShowNotifications(false)}
                className="mt-2 flex h-9 w-full items-center justify-center rounded-xl text-caption font-semibold text-blue"
              >
                Back
              </button>
            </div>
          ) : (
            <>
              {self && (
                <div className="px-2.5 py-2">
                  <p className="truncate text-row-title text-ink">{self.name}</p>
                  <p className="text-caption capitalize text-muted">{self.role}</p>
                </div>
              )}

              {others.length > 0 && (
                <>
                  <p className="section-label px-2.5 pb-1 pt-2">View as</p>
                  {others.map((a) => (
                    <button
                      key={a.membershipId}
                      type="button"
                      disabled={setViewingAs.isPending}
                      onClick={() =>
                        setViewingAs.mutate({ businessId, targetMembershipId: a.membershipId })
                      }
                      className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition hover:bg-surface-2 disabled:opacity-50"
                    >
                      <span
                        aria-hidden
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: a.colour }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-row-title text-ink">{a.name}</span>
                        <span className="block text-caption capitalize text-muted">{a.role}</span>
                      </span>
                    </button>
                  ))}
                </>
              )}

              <div className="my-1 border-t border-hairline" />

              <Link
                to="/$businessSlug/settings"
                params={{ businessSlug }}
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 rounded-xl px-2.5 py-2 text-row-title text-ink transition hover:bg-surface-2"
              >
                <Settings size={16} strokeWidth={1.7} />
                Settings
              </Link>
              <button
                type="button"
                onClick={() => setShowNotifications(true)}
                className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-row-title text-ink transition hover:bg-surface-2"
              >
                <Bell size={16} strokeWidth={1.7} />
                Notifications
              </button>
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
