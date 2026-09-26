import { useState } from 'react'
import { Link, useLocation } from '@tanstack/react-router'
import { Drawer } from 'vaul'
import { Menu } from 'lucide-react'
import { JOB_TO, MORE_ITEMS, NOTES_TO, PRIMARY_NAV } from './navItems'
import { OVERDUE_CHIP } from '#/lib/statusColours'
import { SheetShell } from '#/components/primitives/Sheet'

/**
 * The phone's primary navigation. Five cells is the most a dock can hold
 * legibly at 390px — which is exactly the width it has to hold them at — so the
 * sizing here is deliberate rather than inherited:
 *
 * - A fixed five-column grid, not `flex-1` children, so "Schedule" and "Notes"
 *   get identical tap targets instead of targets sized by their labels.
 * - The active state is a filled pill behind the icon, not colour alone: at
 *   21px, in daylight, on a phone held at arm's length, a red glyph and a grey
 *   one are not reliably different.
 * - No transition on the link itself. Animating the colour on every route
 *   change made navigation read as lag.
 *
 * Four destinations plus a burger: the sections a technician does not open
 * every day live in the sheet rather than stealing a sixth of the bar.
 */
export function MobileDock({
  businessSlug,
  unreadNotes = 0,
  overdueJobs = 0,
}: {
  businessSlug: string
  unreadNotes?: number
  /** Projected visits that came due and were never actioned. */
  overdueJobs?: number
}) {
  const [moreOpen, setMoreOpen] = useState(false)

  // The sections behind the burger have no cell of their own, so while one
  // is open the burger is the lit cell — otherwise nothing in the dock says
  // where you are.
  const pathname = useLocation({ select: (location) => location.pathname })
  const inMore = MORE_ITEMS.some((item) => {
    const path = item.to.replace('$businessSlug', businessSlug)
    return pathname === path || pathname.startsWith(`${path}/`)
  })

  const cell =
    'hold-target group flex flex-col items-center justify-center gap-0.5 rounded-xl py-1.5 text-tab-label text-muted outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue'
  const glyph =
    'relative flex h-7 w-12 items-center justify-center rounded-full transition-colors'

  return (
    <>
      <nav
        aria-label="Tabs"
        className="chrome-blur fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-hairline pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        {PRIMARY_NAV.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            params={{ businessSlug }}
            // `hold-target` is the app's touch-hygiene utility: no text selection
            // and no double-tap zoom on a control meant to be tapped repeatedly.
            className={`${cell} aria-[current=page]:text-red`}
          >
            <span
              aria-hidden
              className={`${glyph} group-aria-[current=page]:bg-red/10`}
            >
              <item.icon size={21} strokeWidth={1.7} />
              {item.to === NOTES_TO && unreadNotes > 0 && (
                <span className="absolute right-2 top-0 min-w-4 rounded-full bg-blue px-1 text-center text-[10px] font-bold leading-4 text-white">
                  {unreadNotes >= 10 ? '9+' : unreadNotes}
                </span>
              )}
            </span>
            <span className="max-w-full truncate px-0.5">{item.label}</span>
            {/* The badge above is hidden with its glyph; the count is read
                out here instead, as part of the tab's name. */}
            {item.to === NOTES_TO && unreadNotes > 0 && (
              <span className="sr-only">, {unreadNotes} unread</span>
            )}
          </Link>
        ))}

        {/* A button, not a link: it opens the sheet below rather than going
            anywhere, and the sheet is what holds the remaining sections. */}
        <button
          type="button"
          // The count is part of the name: a badge drawn on a button is not
          // read out on its own.
          aria-label={overdueJobs > 0 ? `More, ${overdueJobs} overdue` : 'More'}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(true)}
          data-active={inMore || undefined}
          className={`${cell} data-[active]:text-red`}
        >
          <span className={`${glyph} group-data-[active]:bg-red/10`}>
            <Menu size={21} strokeWidth={1.7} aria-hidden />
            {/* On the burger, not just on the Job row inside the sheet: Job
                lives behind this button, so a badge in there is only seen by
                someone who already went looking. */}
            {overdueJobs > 0 && (
              <span
                aria-hidden
                className={`absolute right-2 top-0 min-w-4 rounded-full px-1 text-center text-[10px] font-bold leading-4 ${OVERDUE_CHIP}`}
              >
                {overdueJobs >= 10 ? '9+' : overdueJobs}
              </span>
            )}
          </span>
          <span className="max-w-full truncate px-0.5">More</span>
        </button>
      </nav>

      <SheetShell
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        className="pb-[calc(16px+env(safe-area-inset-bottom))]"
      >
        <Drawer.Title className="px-4 pb-1 pr-14 pt-3 text-sheet-title text-ink">
          More
        </Drawer.Title>
        <Drawer.Description className="sr-only">
          The sections that are not on the tab bar.
        </Drawer.Description>
        <nav aria-label="More sections" className="flex flex-col p-2">
          {MORE_ITEMS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              params={{ businessSlug }}
              onClick={() => setMoreOpen(false)}
              className="hold-target flex items-center gap-3 rounded-xl px-3 py-3 text-body text-ink transition active:scale-[.99] aria-[current=page]:bg-surface-2 aria-[current=page]:text-red"
            >
              <item.icon size={20} strokeWidth={1.7} />
              <span>{item.label}</span>
              {item.to === JOB_TO && overdueJobs > 0 && (
                <span
                  className={`ml-auto min-w-5 rounded-full px-1.5 text-center text-caption font-bold leading-5 ${OVERDUE_CHIP}`}
                >
                  {overdueJobs >= 10 ? '9+' : overdueJobs}
                  <span className="sr-only"> overdue</span>
                </span>
              )}
            </Link>
          ))}
        </nav>
      </SheetShell>
    </>
  )
}
