import { useState } from 'react'
import {
  Check,
  EllipsisVertical,
  LoaderCircle,
  Menu,
  MonitorDown,
  Share,
  SquarePlus,
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { InstallMethod } from '#/lib/installMethod'
import type { InstallProgress } from '#/lib/installPrompt'
import { copyText } from '#/lib/pdfFiles'
import { LINK_BUTTON_COMPACT } from '#/components/primitives/buttons'
import { useSavedFlash } from '#/components/settings/useJustSaved'

/**
 * How to put PestM8 on this device, for each way there is
 * (lib/installMethod.ts): numbered steps naming the buttons the phone
 * actually has, one tap where the browser offers its own prompt, or the way
 * out of an app's browser that can't install anything.
 *
 * Pure, so Settings, the sign-in sheet, set-up and the UI harness all show
 * the same words. It is only ever drawn once the device is known — after
 * hydration, or inside a sheet the person opened — so its controls need no
 * `disabled={!hydrated}`: there is no moment they are on screen and inert.
 */
export function InstallSteps({
  method,
  canPrompt,
  onInstall,
  progress,
}: {
  method: InstallMethod
  /** Chrome has offered its install prompt, and it has not been used. */
  canPrompt: boolean
  onInstall: () => void
  /** An install from this page, accepted or arrived (lib/installPrompt.ts). */
  progress: InstallProgress | null
}) {
  if (method === 'installed') {
    return <Done>You’re using the installed app.</Done>
  }
  if (progress === 'installed') {
    return <Done>Installed. Open PestM8 from your {homeOf(method)}.</Done>
  }
  if (progress === 'installing') {
    return (
      <p role="status" className="flex items-center gap-2.5 text-body text-ink">
        <LoaderCircle
          aria-hidden
          size={18}
          strokeWidth={1.7}
          className="shrink-0 animate-spin text-muted"
        />
        Installing PestM8…
      </p>
    )
  }
  if (canPrompt) {
    return (
      <button
        type="button"
        onClick={onInstall}
        className={`${LINK_BUTTON_COMPACT} w-full`}
      >
        Install PestM8
      </button>
    )
  }

  switch (method) {
    case 'ios-safari':
      return (
        <>
          <IphoneSteps />
          <Hint>Don’t see Add to Home Screen? Open this page in Safari.</Hint>
        </>
      )
    case 'ios-browser':
      return (
        <>
          <IphoneSteps from="browser" />
          <Hint>Don’t see Add to Home Screen? Open this page in Safari.</Hint>
        </>
      )
    case 'ios-in-app':
      return <OpenElsewhere browser="Safari" />
    case 'android-in-app':
      return <OpenElsewhere browser="Chrome" />
    case 'android-chrome':
      return (
        <>
          <ol className={STEPS}>
            <Step n={1}>
              Tap <Glyph icon={EllipsisVertical} label="Menu" /> — the browser’s
              menu
            </Step>
            <Step n={2}>
              Choose <Word>Add to Home screen</Word> — or{' '}
              <Word>Install app</Word>
            </Step>
            <Step n={3}>
              Tap <Word>Install</Word>
            </Step>
            <OpenStep n={4} />
          </ol>
          <Hint>Don’t see it? Open this page in Chrome.</Hint>
        </>
      )
    case 'android-samsung':
      return (
        <>
          <ol className={STEPS}>
            <Step n={1}>
              Tap <Glyph icon={Menu} label="Menu" /> — the browser’s menu
            </Step>
            <Step n={2}>
              Choose <Word>Add page to</Word>, then <Word>Home screen</Word>
            </Step>
            <Step n={3}>
              Tap <Word>Add</Word>
            </Step>
            <OpenStep n={4} />
          </ol>
          <Hint>Don’t see it? Open this page in Chrome.</Hint>
        </>
      )
    case 'android-firefox':
      return (
        <>
          <ol className={STEPS}>
            <Step n={1}>
              Tap <Glyph icon={EllipsisVertical} label="Menu" /> — the browser’s
              menu
            </Step>
            <Step n={2}>
              Choose <Word>Install</Word> — or <Word>Add to Home screen</Word>
            </Step>
            <Step n={3}>
              Tap <Word>Add</Word>
            </Step>
            <OpenStep n={4} />
          </ol>
          <Hint>Don’t see it? Open this page in Chrome.</Hint>
        </>
      )
    case 'android-other':
      return (
        <>
          <p className="text-body text-ink">
            Open this browser’s menu and choose <Word>Add to Home screen</Word>{' '}
            or <Word>Install app</Word>.
          </p>
          <Hint>Don’t see it? Open this page in Chrome.</Hint>
        </>
      )
    case 'desktop-chromium':
      return (
        <ol className={STEPS}>
          <Step n={1}>
            Click the install icon <Glyph icon={MonitorDown} /> at the right of
            the address bar — or find <Word>Install</Word> in the browser’s menu
          </Step>
          <Step n={2}>
            Click <Word>Install</Word>
          </Step>
          <Step n={3}>
            PestM8 opens in its own window, and stays in your apps
          </Step>
        </ol>
      )
    case 'mac-safari':
      return (
        <>
          <ol className={STEPS}>
            <Step n={1}>
              In the menu bar, choose <Word>File</Word>, then{' '}
              <Word>Add to Dock</Word>
            </Step>
            <Step n={2}>
              Click <Word>Add</Word>
            </Step>
            <Step n={3}>PestM8 opens from the Dock, in its own window</Step>
          </ol>
          {/* Safari 17 also runs on macOS Monterey and Ventura, which have
              no Add to Dock, and the user agent can't tell them apart. */}
          <Hint>
            No Add to Dock? It needs macOS Sonoma or later — or open PestM8 in
            Chrome or Edge.
          </Hint>
        </>
      )
    case 'unsupported':
      return (
        <p className="text-body text-ink">
          This browser can’t install PestM8. Open it in Chrome or Edge, and
          install it from there.
        </p>
      )
  }
}

/**
 * Share, then Add to Home Screen: the only way onto an iPhone's Home Screen.
 * The toggle in step 3 is iOS 26's, on the same screen as Add; left off, it
 * makes a bookmark that opens in Safari, which loses the storage a Home
 * Screen app keeps.
 */
export function IphoneSteps({
  from = 'safari',
}: {
  from?: 'safari' | 'browser'
}) {
  return (
    <ol className={STEPS}>
      <Step n={1}>
        Tap <Word>Share</Word> <Glyph icon={Share} />
        {from === 'safari' ? (
          <> — under {MORE} if you don’t see it</>
        ) : (
          <> — in the address bar, or under {MORE}</>
        )}
      </Step>
      <Step n={2}>
        Choose{' '}
        <Word>
          Add to Home Screen <Glyph icon={SquarePlus} />
        </Word>{' '}
        — scroll down if you need to
      </Step>
      <Step n={3}>
        Leave <Word>Open as Web App</Word> on, if you see it, then tap{' '}
        <Word>Add</Word>
      </Step>
      <OpenStep n={4} />
    </ol>
  )
}

const STEPS = 'space-y-2.5 text-body text-ink'

/** Safari's ••• button, which a screen reader calls More. */
const MORE = (
  <>
    <span aria-hidden>•••</span>
    <span className="sr-only">More</span>
  </>
)

export function Step({ n, children }: { n: number; children: ReactNode }) {
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

/** On an iPhone the Home Screen app keeps a sign-in of its own, apart from
 * Safari's; on Android it shares Chrome's. Either way, "if it asks". */
function OpenStep({ n }: { n: number }) {
  return (
    <Step n={n}>Open PestM8 from your Home Screen, and sign in if it asks</Step>
  )
}

function Word({ children }: { children: ReactNode }) {
  return <span className="font-semibold">{children}</span>
}

/**
 * The glyph on the button a step names, so it can be matched to what is on
 * screen. Grey, as a glyph that does nothing here: blue would read as a link.
 */
function Glyph({
  icon: Icon,
  label,
}: {
  icon: typeof Share
  /** Said by a screen reader, where the step has no word for it. */
  label?: string
}) {
  return (
    <>
      <Icon
        aria-hidden
        size={16}
        strokeWidth={2}
        className="mx-0.5 inline -translate-y-px text-ink-2"
      />
      {label && <span className="sr-only">{label}</span>}
    </>
  )
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-caption text-grey-ink">{children}</p>
}

function Done({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2.5 text-body text-ink">
      <Check
        aria-hidden
        size={18}
        strokeWidth={2}
        className="mt-0.5 shrink-0 text-green"
      />
      <span>{children}</span>
    </p>
  )
}

function homeOf(method: InstallMethod): string {
  return method === 'desktop-chromium' || method === 'mac-safari'
    ? 'apps'
    : 'Home Screen'
}

/**
 * An app's own browser — the link opened from Gmail, Outlook or Facebook —
 * can't add anything to the Home Screen. The page has to be opened in the
 * phone's browser first: most of these apps offer that in their menu, and
 * the link can be copied across for the rest. Copied the way every copy in
 * the app is (`copyText`), which falls back to a selection where an app's
 * browser refuses the clipboard.
 */
function OpenElsewhere({ browser }: { browser: 'Safari' | 'Chrome' }) {
  const copied = useSavedFlash()
  const [failed, setFailed] = useState(false)
  // Drawn only in a browser, but rendered by tests and the server too.
  const address = (globalThis as { location?: Location }).location?.origin ?? ''

  return (
    <div>
      <p className="text-body text-ink">
        Open this page in {browser} first. This app’s own browser can’t add
        PestM8 to your Home Screen.
      </p>
      <p className="mt-2 text-caption text-grey-ink">
        Look for <Word>Open in {browser}</Word> in its menu, or copy the link
        and paste it into {browser}.
      </p>
      <button
        type="button"
        onClick={() => {
          setFailed(false)
          void copyText(address).then((ok) =>
            ok ? copied.mark() : setFailed(true),
          )
        }}
        className={`${LINK_BUTTON_COMPACT} mt-3 flex w-full items-center justify-center gap-1.5`}
      >
        <span aria-live="polite" className="flex items-center gap-1.5">
          {copied.recently ? (
            <>
              <Check aria-hidden size={16} strokeWidth={2.2} />
              Copied
            </>
          ) : (
            'Copy link'
          )}
        </span>
      </button>
      {failed && (
        <p role="alert" className="mt-2 text-caption text-amber-ink">
          Could not copy it. Type {address} into {browser} instead.
        </p>
      )}
    </div>
  )
}
