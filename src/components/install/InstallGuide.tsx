import type { InstallMethod } from '#/lib/installMethod'
import {
  useInstallMethod,
  useInstallProgress,
  useInstallPrompt,
} from '#/lib/installPrompt'
import { InstallSteps } from '#/components/install/InstallSteps'
import { Bone } from '#/components/shell/Pending'

/**
 * The install steps for this device, wired to the browser: its method, the
 * prompt Chrome may be holding, and how far an install from here has got.
 *
 * Until hydration nobody knows which phone this is, so a server render and
 * the first client render show numbered bones where the steps will be.
 */
export function InstallGuide({
  method: given,
}: {
  /** Pinned, for the UI harness: it runs in a desktop browser. */
  method?: InstallMethod
} = {}) {
  const detected = useInstallMethod()
  const prompt = useInstallPrompt()
  const progress = useInstallProgress()
  const method = given ?? detected

  if (!method) return <StepsPending />
  return (
    <InstallSteps
      method={method}
      canPrompt={prompt !== null}
      onInstall={() => void prompt?.()}
      progress={progress}
    />
  )
}

/**
 * Four numbered steps of two lines each and the hint under them — an
 * iPhone's, the most any device is shown — so what follows on the page
 * doesn't move when they arrive.
 */
function StepsPending() {
  return (
    <div role="status">
      <span className="sr-only">Loading</span>
      <div aria-hidden className="space-y-2.5">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-start gap-3">
            <Bone className="size-6 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2 pt-0.5">
              <Bone className="h-4 w-full" />
              <Bone className="h-4 w-2/3" />
            </div>
          </div>
        ))}
        <Bone className="mt-3 h-3.5 w-4/5" />
      </div>
    </div>
  )
}
