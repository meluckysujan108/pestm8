import { useRouterState } from '@tanstack/react-router'
import { useHydrated } from '#/lib/useHydrated'

/**
 * A thin bar along the top of the screen while a navigation is still working
 * things out — before there is a page to put a skeleton in, which is the one
 * stretch nothing else acknowledges.
 *
 * Rendered for every navigation and shown for almost none: it stays
 * transparent for its first 150 ms (styles.css, `.nav-progress`), and a
 * navigation that answers from cache is over in a few frames. What reaches it
 * is a cold route chunk, a loader, or entering a business — the layout's
 * `beforeLoad` resolves the business before anything of it can render.
 *
 * Gated on hydration because the router is mid-load while it renders on the
 * server, and a bar in the SSR markup would not match the idle client.
 */
export function NavProgress() {
  const hydrated = useHydrated()
  const pending = useRouterState({ select: (s) => s.status === 'pending' })
  if (!hydrated || !pending) return null

  return (
    <div
      aria-hidden
      className="nav-progress pointer-events-none fixed inset-x-0 top-[env(safe-area-inset-top)] z-[60] h-0.5"
    >
      {/* Blue, not the brand red: theme-color tints Android's toolbar and the
          installed app's status bar red, and a red bar against red chrome is
          no bar at all. */}
      <div className="nav-progress-bar h-full bg-blue" />
    </div>
  )
}
