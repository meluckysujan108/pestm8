import { Link } from '@tanstack/react-router'
import { DOCK_ITEMS } from './navItems'

/**
 * The phone's primary navigation. Six destinations is the most a dock can hold
 * legibly at 390px — which is exactly the width it has to hold them at — so the
 * sizing here is deliberate rather than inherited:
 *
 * - A fixed six-column grid, not `flex-1` children, so "Analytics" and "Notes"
 *   get identical tap targets instead of targets sized by their labels.
 * - The active state is a filled pill behind the icon, not colour alone: at
 *   21px, in daylight, on a phone held at arm's length, a red glyph and a grey
 *   one are not reliably different.
 * - No transition on the link itself. Animating the colour on every route
 *   change made navigation read as lag.
 */
export function MobileDock({
  businessSlug,
  unreadNotes = 0,
}: {
  businessSlug: string
  unreadNotes?: number
}) {
  return (
    <nav
      aria-label="Tabs"
      className="chrome-blur fixed inset-x-0 bottom-0 z-40 grid grid-cols-6 border-t border-hairline pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      {DOCK_ITEMS.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          params={{ businessSlug }}
          // `hold-target` is the app's touch-hygiene utility: no text selection
          // and no double-tap zoom on a control meant to be tapped repeatedly.
          className="hold-target group flex flex-col items-center justify-center gap-0.5 py-1.5 text-tab-label text-muted aria-[current=page]:text-red"
        >
          <span
            aria-hidden
            className="relative flex h-7 w-12 items-center justify-center rounded-full transition-colors group-aria-[current=page]:bg-red/10"
          >
            <item.icon size={21} strokeWidth={1.8} />
            {item.label === 'Notes' && unreadNotes > 0 && (
              <span className="absolute right-2 top-0 min-w-4 rounded-full bg-blue px-1 text-center text-[10px] font-bold leading-4 text-white">
                {unreadNotes >= 10 ? '9+' : unreadNotes}
              </span>
            )}
          </span>
          <span className="max-w-full truncate px-0.5">{item.label}</span>
        </Link>
      ))}
    </nav>
  )
}
