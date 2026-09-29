import { useEffect, useState } from 'react'
import { hideInstallCard } from '#/lib/installMethod'
import {
  browserStorage,
  currentInstallMethod,
  isAppleMobile,
  isStandalone,
  useInstallPrompt,
} from '#/lib/installPrompt'
import { InstallSteps } from '#/components/install/InstallSteps'
import { LINK_BUTTON_COMPACT } from '#/components/primitives/buttons'

/**
 * "Put PestM8 on your Home Screen", at the end of set-up — the moment it has
 * earned the space, and before anything that needs it.
 *
 * On an iPhone it can only show the way (there is no prompt to raise); where
 * the browser has offered to install, one tap does it; already installed, or
 * a browser with neither, it shows nothing. Decided after hydration: the
 * server cannot know which phone it is.
 *
 * The steps are Settings → Install app's own (components/install/), which
 * covers every other device too; set-up stays with these two, so a computer
 * goes straight on to its jobs.
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
  const offered = offer === 'apple' || offer === 'install'

  // Set-up has just shown the way, so the schedule it leads to doesn't ask
  // again with its own card (components/install/InstallCard) for a while.
  useEffect(() => {
    if (offered) hideInstallCard(browserStorage(), Date.now())
  }, [offered])

  if (!offered) return null
  const device = offer === 'apple' ? 'apple' : 'other'

  return (
    <section className="rounded-2xl border border-hairline bg-surface p-4 shadow-elevation">
      {!bare && (
        <>
          <h2 className="text-[16px] font-semibold text-ink">
            Put PestM8 on your Home Screen
          </h2>
          <p className="mt-1 text-caption text-grey-ink">
            It opens full screen like an app, and keeps your licence and
            products on this phone for sites with no signal.
          </p>
        </>
      )}

      {device === 'apple' ? (
        <div className={bare ? '' : 'mt-3'}>
          {/* This iPhone's own steps: Safari's, another browser's, or — for
              an invitation opened in Gmail's or Outlook's own browser, which
              can't install anything — the way out to Safari. Only drawn
              after hydration (`offer`), so the device can be read here. */}
          <InstallSteps
            method={currentInstallMethod()}
            canPrompt={false}
            onInstall={() => {}}
            progress={null}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void install?.()}
          className={`${LINK_BUTTON_COMPACT} w-full ${bare ? '' : 'mt-3'}`}
        >
          Install PestM8
        </button>
      )}
    </section>
  )
}
