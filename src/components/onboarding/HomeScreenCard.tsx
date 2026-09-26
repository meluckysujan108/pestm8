import { useEffect, useState } from 'react'
import { Share, SquarePlus } from 'lucide-react'
import {
  isAppleMobile,
  isStandalone,
  useInstallPrompt,
} from '#/lib/installPrompt'
import type { ReactNode } from 'react'

/**
 * "Put PestM8 on your Home Screen", at the end of set-up — the moment it has
 * earned the space, and before anything that needs it.
 *
 * On an iPhone it can only show the way (there is no prompt to raise); where
 * the browser has offered to install, one tap does it; already installed, or
 * a browser with neither, it shows nothing. Decided after hydration: the
 * server cannot know which phone it is.
 */
/**
 * What there is to offer this device: the Share steps on an iPhone, the
 * browser's own prompt where it has made one, or nothing — installed
 * already, or a browser with neither. `pending` until hydration: the server
 * cannot know which phone it is.
 */
export type HomeScreenOffer = 'pending' | 'apple' | 'install' | 'none'

export function useHomeScreenOffer(): HomeScreenOffer {
  const install = useInstallPrompt()
  const [device, setDevice] = useState<'installed' | 'apple' | 'other' | null>(
    null,
  )
  useEffect(() => {
    setDevice(
      isStandalone() ? 'installed' : isAppleMobile() ? 'apple' : 'other',
    )
  }, [])

  if (device === null) return 'pending'
  if (device === 'apple') return 'apple'
  if (device === 'other' && install) return 'install'
  return 'none'
}

export function HomeScreenCard({
  bare = false,
}: {
  /** Just the way to do it, under a page that has already said why. */
  bare?: boolean
} = {}) {
  const install = useInstallPrompt()
  const offer = useHomeScreenOffer()
  if (offer !== 'apple' && offer !== 'install') return null
  const device = offer === 'apple' ? 'apple' : 'other'

  return (
    <section className="rounded-2xl border border-hairline bg-surface p-4 shadow-elevation">
      {!bare && (
        <>
          <h2 className="text-[16px] font-semibold text-ink">
            Put PestM8 on your Home Screen
          </h2>
          <p className="mt-1 text-caption text-muted">
            It opens full screen like an app, and keeps your licence and
            products on this phone for sites with no signal.
          </p>
        </>
      )}

      {device === 'apple' ? (
        <ol className={`space-y-2 text-body text-ink ${bare ? '' : 'mt-3'}`}>
          <Step n={1}>
            In Safari, tap{' '}
            <Share
              aria-label="Share"
              size={17}
              strokeWidth={2}
              className="mx-0.5 inline -translate-y-px text-blue"
            />{' '}
            — under ••• if you don’t see it
          </Step>
          <Step n={2}>
            Choose{' '}
            <span className="font-semibold">
              Add to Home Screen{' '}
              <SquarePlus
                aria-hidden
                size={16}
                strokeWidth={2}
                className="inline -translate-y-px"
              />
            </span>
          </Step>
          <Step n={3}>
            Tap <span className="font-semibold">Add</span>, then open PestM8
            from your Home Screen
          </Step>
        </ol>
      ) : (
        <button
          type="button"
          onClick={() => void install?.()}
          className={`h-11 w-full rounded-xl bg-surface-2 text-[16px] font-semibold text-blue transition active:scale-[.975] ${bare ? '' : 'mt-3'}`}
        >
          Install PestM8
        </button>
      )}
    </section>
  )
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden
        className="mt-px flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-caption font-semibold text-ink-2"
      >
        {n}
      </span>
      <span className="min-w-0">{children}</span>
    </li>
  )
}
