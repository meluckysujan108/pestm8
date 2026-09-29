import { useRef, useState, useSyncExternalStore } from 'react'
import { useRouter } from '@tanstack/react-router'
import { X } from 'lucide-react'
import type { RefObject } from 'react'
import type { InstallMethod } from '#/lib/installMethod'
import {
  hideInstallCard,
  offerInstallCard,
  rememberInstalled,
} from '#/lib/installMethod'
import {
  browserStorage,
  cameByHistory,
  currentInstallMethod,
  useInstallProgress,
  useInstallPrompt,
} from '#/lib/installPrompt'
import { InstallSheet } from '#/components/install/InstallSheet'
import { LINK_BUTTON_COMPACT } from '#/components/primitives/buttons'

const noSubscription = () => () => {}

/**
 * Whether this visit to the schedule shows the card, and for which device —
 * decided on the card's first render and kept for as long as it is mounted.
 *
 * Never while the page hydrates. That is the moment the day's controls start
 * to work, and a card arriving then would push the week strip and the first
 * job down about 140px, under a thumb already on its way to them. So a full
 * page load (opening the app, signing in) shows no card, and coming back to
 * the schedule from another tab shows it from its first frame, where nothing
 * moves. `useSyncExternalStore`'s server snapshot is what a hydrating render
 * sees; a render that starts in the browser sees the other.
 *
 * Nor after Back or Forward: the router puts the scroll back where it was,
 * and a card that was not there then would put the day 140px off it.
 */
export function useInstallCardOffer(): InstallMethod | null {
  const router = useRouter()
  const clientRender = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  )
  const [method] = useState<InstallMethod | null>(() => {
    if (!clientRender) return null
    const found = currentInstallMethod()
    const storage = browserStorage()
    // The installed app on Android shares Chrome's storage, so this is how
    // Chrome learns not to ask again. (An iPhone's does not; ✕ is for that.)
    if (found === 'installed') rememberInstalled(storage)
    if (cameByHistory(router.state.location.state.__TSR_key)) return null
    return offerInstallCard(found, storage, Date.now()) ? found : null
  })
  return method
}

/**
 * "Put PestM8 on your Home Screen", on the schedule of a phone using PestM8
 * in its browser — for the technician who deleted the app, or never had it.
 * One tap installs it where Chrome offers to; elsewhere it shows the steps.
 * ✕ puts it away for 30 days on that phone (lib/installMethod.ts), and it
 * goes as soon as an install is accepted.
 */
export function InstallCard() {
  const method = useInstallCardOffer()
  const prompt = useInstallPrompt()
  const progress = useInstallProgress()
  const [dismissed, setDismissed] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [sheetMounted, setSheetMounted] = useState(false)
  const action = useRef<HTMLButtonElement>(null)

  if (!method) return null
  return (
    <>
      {!dismissed && progress === null && (
        <InstallCardView
          canPrompt={prompt !== null}
          actionRef={action}
          onAction={() => {
            if (prompt) {
              void prompt()
              return
            }
            setSheetMounted(true)
            setSheetOpen(true)
          }}
          onDismiss={() => {
            hideInstallCard(browserStorage(), Date.now())
            setDismissed(true)
          }}
        />
      )}
      {sheetMounted && (
        <InstallSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          returnFocusRef={action}
        />
      )}
    </>
  )
}

/**
 * The card as drawn, for the schedule and the UI harness. Never part of a
 * server render (see `useInstallCardOffer`), so its buttons are never on
 * screen before they work and need no `disabled={!hydrated}`.
 */
export function InstallCardView({
  canPrompt,
  onAction,
  onDismiss,
  actionRef,
}: {
  canPrompt: boolean
  onAction: () => void
  onDismiss: () => void
  actionRef?: RefObject<HTMLButtonElement | null>
}) {
  return (
    <div className="px-4 pt-3 lg:pt-4">
      <div className="rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation">
        <div className="flex items-start gap-3">
          <img
            src="/apple-touch-icon.png"
            alt=""
            width={40}
            height={40}
            className="size-10 shrink-0 rounded-sm"
          />
          <span className="min-w-0 flex-1">
            <span className="block text-row-title text-ink">
              Put PestM8 on your Home Screen
            </span>
            <span className="mt-0.5 block text-caption text-grey-ink">
              It keeps your licence and products on this phone for sites with no
              signal.
            </span>
          </span>
          <button
            type="button"
            aria-label="Dismiss: Put PestM8 on your Home Screen"
            onClick={onDismiss}
            className="-mr-2 -mt-1.5 flex size-11 shrink-0 items-center justify-center self-start rounded-full text-muted transition active:scale-[.95]"
          >
            <X size={17} strokeWidth={2.2} />
          </button>
        </div>
        <button
          ref={actionRef}
          type="button"
          onClick={onAction}
          className={`${LINK_BUTTON_COMPACT} ml-[52px] mt-2 px-3.5`}
        >
          {canPrompt ? 'Install PestM8' : 'Show me how'}
        </button>
      </div>
    </div>
  )
}
