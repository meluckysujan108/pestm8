import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
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
import { NAV_ITEMS, SETTINGS_ITEM } from './navItems'
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

export type ShellMembership = {
  role: 'owner' | 'subcontractor'
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
  children,
}: {
  business: ShellBusiness
  membership: ShellMembership
  children: ReactNode
}) {
  const unread = useUnreadMentions(business._id)

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
                {NAV_ITEMS.map((item) => (
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
        <div className="mx-auto w-full max-w-[460px] md:max-w-[760px] lg:max-w-[1280px]">
          <main className="pb-[calc(68px+env(safe-area-inset-bottom))] lg:pb-0">
            {children}
          </main>
        </div>
      </SidebarInset>

      <MobileDock businessSlug={business.slug} unreadNotes={unread} />
    </SidebarProvider>
  )
}
