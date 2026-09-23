import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import type { Role } from '../../../convex/lib/capabilities'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
} from '#/components/ui/sidebar.tsx'
import { BusinessSwitcher } from './BusinessSwitcher'
import { MobileDock } from './MobileDock'
import { MORE_NAV, PRIMARY_NAV, SETTINGS_ITEM } from './navItems'
import type { Id } from '../../../convex/_generated/dataModel'
import type { ReactNode } from 'react'

export type ShellBusiness = {
  _id: Id<'businesses'>
  name: string
  slug: string
}

/** Unread @mentions, capped server-side — "9+" is as precise as a badge needs to be. */
export function useUnreadMentions(businessId: Id<'businesses'>): number {
  const { data } = useQuery(convexQuery(api.notes.unreadMentionCount, { businessId }))
  return data ?? 0
}

/**
 * Projected visits that came due and nobody actioned.
 *
 * A badge in the nav, because this is the one number that has to reach
 * somebody who is not looking for it. Showing an overdue visit on today's
 * schedule helps whoever opens the schedule; a business that has stopped
 * opening it is exactly the business quietly failing to treat a customer.
 */
export function useOverdueRecurring(businessId: Id<'businesses'>): number {
  const { data } = useQuery(
    convexQuery(api.jobs.overdueRecurringCount, { businessId }),
  )
  return data ?? 0
}

export type ShellMembership = {
  role: Role
  colour: string
}

/**
 * Desktop is a collapsible sidebar beside an inset content panel; mobile is a
 * bottom dock over a full-bleed column. Both navs are always in the DOM and the
 * switch between them is CSS (`lg:`) — never a conditional render. That is not
 * incidental: a nav that unmounts is a nav that cannot be found by a keyboard,
 * a screen reader, or a test, and the access-control suite reads both.
 */
export function AppShell({
  business,
  membership,
  banner,
  children,
}: {
  business: ShellBusiness
  membership: ShellMembership
  /**
   * Rendered inside the inset, above the content.
   *
   * It used to sit outside the shell entirely, as a sibling of this component —
   * which put it underneath the sidebar's own fixed, z-10 panel on any screen
   * wide enough to show one. The warning that you are writing in someone
   * else's account was invisible on exactly the screens an owner uses.
   */
  banner?: ReactNode
  children: ReactNode
}) {
  const unread = useUnreadMentions(business._id)
  const overdue = useOverdueRecurring(business._id)

  return (
    <SidebarProvider>
      <Sidebar variant="inset" collapsible="icon">
        <SidebarHeader>
          <BusinessSwitcher current={business} membership={membership} />
        </SidebarHeader>

        {/* One `nav`, wrapping both groups. Settings sits in its own group so
            it can be pushed to the bottom, but it stays inside the landmark —
            a "Settings" link outside the navigation is a link nothing looking
            for navigation can find. */}
        <SidebarContent>
          <nav aria-label="Primary" className="flex min-h-0 flex-1 flex-col">
            <SidebarGroup>
              <SidebarMenu>
                {PRIMARY_NAV.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild tooltip={item.label}>
                      <Link
                        to={item.to}
                        params={{ businessSlug: business.slug }}
                        activeProps={{ 'data-active': 'true' }}
                      >
                        <item.icon size={20} strokeWidth={1.7} />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                    {item.label === 'Notes' && unread > 0 && (
                      <SidebarMenuBadge className="rounded-full bg-blue px-1.5 text-[11px] font-bold text-white">
                        {unread >= 10 ? '9+' : unread}
                      </SidebarMenuBadge>
                    )}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>

            {/* What the phone hides behind its burger. A sidebar has the room
                to show them, so it does: the grouping is the same statement
                about which sections are daily ones, without making a desktop
                user open a menu to reach Analytics. */}
            <SidebarGroup>
              <SidebarGroupLabel>More</SidebarGroupLabel>
              <SidebarMenu>
                {MORE_NAV.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild tooltip={item.label}>
                      <Link
                        to={item.to}
                        params={{ businessSlug: business.slug }}
                        activeProps={{ 'data-active': 'true' }}
                      >
                        <item.icon size={20} strokeWidth={1.7} />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                    {/* Amber, not blue: unlike an unread mention, this is
                        work that should already have happened. */}
                    {item.label === 'Job' && overdue > 0 && (
                      <SidebarMenuBadge className="rounded-full bg-amber-ink px-1.5 text-[11px] font-bold text-white">
                        {overdue >= 10 ? '9+' : overdue}
                      </SidebarMenuBadge>
                    )}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>

            <SidebarGroup className="mt-auto">
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild tooltip={SETTINGS_ITEM.label}>
                    <Link
                      to={SETTINGS_ITEM.to}
                      params={{ businessSlug: business.slug }}
                      activeProps={{ 'data-active': 'true' }}
                    >
                      <SETTINGS_ITEM.icon size={20} strokeWidth={1.7} />
                      <span>{SETTINGS_ITEM.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
          </nav>
        </SidebarContent>

        <SidebarRail />
      </Sidebar>

      <SidebarInset>
        {/* The clamp goes on an inner wrapper, not the inset: the inset is the
            white panel and should reach the window edge, while the content
            column inside it stays readable (§2.4). */}
        {banner}
        <div className="mx-auto w-full max-w-[460px] md:max-w-[760px] lg:max-w-[1280px]">
          <main className="pb-[calc(68px+env(safe-area-inset-bottom))] lg:pb-0">
            {children}
          </main>
        </div>
      </SidebarInset>

      <MobileDock
        businessSlug={business.slug}
        unreadNotes={unread}
        overdueJobs={overdue}
      />
    </SidebarProvider>
  )
}
