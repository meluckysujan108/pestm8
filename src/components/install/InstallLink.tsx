import { Component, Suspense, lazy, useEffect, useRef, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { isHandheld } from '#/lib/installMethod'
import type { InstallMethod } from '#/lib/installMethod'
import { useInstallMethod } from '#/lib/installPrompt'

// The sign-in screen carries no sheet of its own, so the sheet (and vaul
// with it) is left out of its chunk and fetched only on a phone that could
// use it — warmed as soon as the link shows, so a tap opens it at once.
const loadSheet = () => import('#/components/install/InstallSheet')
const InstallSheet = lazy(() =>
  loadSheet().then((m) => ({ default: m.InstallSheet })),
)

/**
 * "Put PestM8 on your Home Screen", under Sign in — where someone who
 * deleted the app lands, because an iPhone's Home Screen app keeps its sign-in
 * apart from Safari's and takes it with it when it goes.
 *
 * Only on a phone or tablet, and not in the installed app. Which one this is
 * is known only after hydration, so the row is always there and always this
 * tall: the form is centred on the screen, and a row arriving late would move
 * Sign in just as it started to work.
 */
export function InstallLink({
  method: given,
}: {
  /** Pinned, for the UI harness: it runs in a desktop browser. */
  method?: InstallMethod
} = {}) {
  const detected = useInstallMethod()
  const method = given ?? detected
  const offer = method !== null && isHandheld(method)
  const [open, setOpen] = useState(false)
  // Kept once opened, so closing plays the sheet's slide down.
  const [mounted, setMounted] = useState(false)
  const button = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (offer) void loadSheet().catch(() => {})
  }, [offer])

  return (
    <div className="flex min-h-11 flex-col items-center justify-center">
      {offer && (
        <button
          ref={button}
          type="button"
          onClick={() => {
            setMounted(true)
            setOpen(true)
          }}
          className="flex min-h-11 items-center justify-center text-body text-blue"
        >
          Put PestM8 on your Home Screen
        </button>
      )}
      {mounted && (
        <SheetBoundary>
          <Suspense fallback={null}>
            <InstallSheet
              open={open}
              onClose={() => setOpen(false)}
              returnFocusRef={button}
              method={given}
            />
          </Suspense>
        </SheetBoundary>
      )}
    </div>
  )
}

/**
 * The sheet's code not arriving — no signal, or a deploy since this page
 * loaded that replaced the chunk. React.lazy remembers the failure, so only
 * a reload tries again; the sign-in form above is untouched either way.
 */
class SheetBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(
      'The install steps failed to load',
      error,
      info.componentStack,
    )
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <p role="alert" className="pb-2 text-center text-caption text-amber-ink">
        Could not open the steps. Check your signal, then reload this page.
      </p>
    )
  }
}
