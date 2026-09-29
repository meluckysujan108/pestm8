import type { RefObject } from 'react'
import type { InstallMethod } from '#/lib/installMethod'
import { InstallGuide } from '#/components/install/InstallGuide'
import { Sheet } from '#/components/primitives/Sheet'
import { SECONDARY_BUTTON } from '#/components/primitives/buttons'

/**
 * The install steps in a sheet, for the places that can't give them a page:
 * the sign-in screen, where someone who deleted the app lands signed out,
 * and the schedule's card. Settings → Install app shows the same steps
 * inline.
 */
export function InstallSheet({
  open,
  onClose,
  returnFocusRef,
  method,
}: {
  open: boolean
  onClose: () => void
  returnFocusRef?: RefObject<HTMLElement | null>
  /** Pinned, for the UI harness. */
  method?: InstallMethod
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Install PestM8"
      returnFocusRef={returnFocusRef}
      footer={
        <button
          type="button"
          onClick={onClose}
          className={`${SECONDARY_BUTTON} w-full`}
        >
          Done
        </button>
      }
    >
      <div className="rounded-xl border border-hairline bg-surface p-3.5">
        <InstallGuide method={method} />
      </div>
      <p className="mt-3 px-1 text-caption text-grey-ink">
        It opens full screen, and keeps your licence and products on this phone
        for sites with no signal.
      </p>
    </Sheet>
  )
}
