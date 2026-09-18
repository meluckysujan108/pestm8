import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { Link, useRouteContext } from '@tanstack/react-router'
import { Popover } from 'radix-ui'
import {
  Bell,
  Check,
  LogOut,
  Monitor,
  Moon,
  Settings,
  Sun,
  User,
} from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { useAccess } from '#/lib/access'
import { useHydrated } from '#/lib/useHydrated'
import { useThemePref } from '#/lib/useTheme'
import type { LucideIcon } from 'lucide-react'
import type { ThemePref } from '#/lib/theme'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * The header's account menu — whose account you are in, the accounts you may
 * work in, a Settings shortcut (intentionally redundant with the sidebar and
 * mobile-tab entries, per its own design), and a notifications bell that is a
 * UI shell only for now.
 *
 * The list comes from `accountSwitches.targets`, which filters by the same
 * rule the mutation enforces — so the menu cannot offer something that would
 * then be refused, and the owner is absent from it for everyone.
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

  // Per src/lib/useHydrated.ts: this button only opens a popover, so before
  // hydration it does nothing at all — silently. It is also the readiness
  // signal e2e waits on instead of a timeout.
  const hydrated = useHydrated()
  const access = useAccess()
  const { data: targets } = useQuery(
    convexQuery(api.accountSwitches.targets, { businessId }),
  )

  const convexStart = useConvexMutation(api.accountSwitches.start)
  const start = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      targetMembershipId: Id<'memberships'>
    }) => convexStart(args),
    onSuccess: () => setOpen(false),
  })

  const convexStop = useConvexMutation(api.accountSwitches.stop)
  const stop = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'> }) => convexStop(args),
    onSuccess: () => setOpen(false),
  })

  // Nothing to invalidate afterwards. `access.me` and every gated query resolve
  // through `requireActor`, which reads the switch row — so the socket re-pushes
  // them the moment one is written, and the whole UI follows on its own.
  const others = targets ?? []

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
        disabled={!hydrated}
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
              <div className="px-2.5 py-2">
                <p className="truncate text-row-title text-ink">
                  {access.actingAs
                    ? `${access.actingAs.name}’s account`
                    : 'Your account'}
                </p>
                <p className="text-caption capitalize text-muted">
                  {access.role}
                </p>
              </div>

              {access.actingAs ? (
                <button
                  type="button"
                  disabled={stop.isPending}
                  onClick={() => stop.mutate({ businessId })}
                  className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-row-title text-amber-ink transition hover:bg-surface-2 disabled:opacity-50"
                >
                  <LogOut size={16} strokeWidth={1.7} />
                  Switch back to your account
                </button>
              ) : (
                others.length > 0 && (
                  <>
                    {/* "Work in" rather than "view as": what follows is
                        writing under their name, not looking at their rows. */}
                    <p className="section-label px-2.5 pb-1 pt-2">
                      Work in another account
                    </p>
                    {others.map((a) => (
                      <button
                        key={a.membershipId}
                        type="button"
                        disabled={start.isPending}
                        onClick={() =>
                          start.mutate({
                            businessId,
                            targetMembershipId: a.membershipId,
                          })
                        }
                        className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition hover:bg-surface-2 disabled:opacity-50"
                      >
                        <span
                          aria-hidden
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: a.colour }}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-row-title text-ink">
                            {a.name}
                          </span>
                          <span className="block text-caption capitalize text-muted">
                            {a.role}
                          </span>
                        </span>
                      </button>
                    ))}
                  </>
                )
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

              <div className="my-1 border-t border-hairline" />
              <ThemeRows />
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

const THEMES: Array<{ value: ThemePref; label: string; icon: LucideIcon }> = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
]

/**
 * Three rows rather than the `Segmented` control §2.3 asks for on a ternary
 * choice: that primitive takes labels only, and an appearance picker reads far
 * faster with the icons. Rows also match every other item in this menu.
 *
 * The menu deliberately stays open on a choice — the whole app repaints behind
 * it, which is the confirmation.
 *
 * No hydration guard of its own: the menu cannot be opened before the trigger
 * hydrates, so nothing here is reachable early.
 */
function ThemeRows() {
  const { theme } = useRouteContext({ from: '__root__' })
  const [pref, setTheme] = useThemePref(theme)

  return (
    <>
      <p className="section-label px-2.5 pb-1 pt-2">Appearance</p>
      <div role="radiogroup" aria-label="Appearance">
        {THEMES.map(({ value, label, icon: Icon }) => {
          const selected = value === pref
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setTheme(value)}
              className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-row-title text-ink transition hover:bg-surface-2 disabled:opacity-50"
            >
              <Icon size={16} strokeWidth={1.7} />
              <span className="flex-1">{label}</span>
              {selected && (
                <Check size={16} strokeWidth={2} className="text-blue" />
              )}
            </button>
          )
        })}
      </div>
    </>
  )
}
