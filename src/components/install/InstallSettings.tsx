import type { InstallMethod } from '#/lib/installMethod'
import { InstallGuide } from '#/components/install/InstallGuide'
import { SettingsBody, SettingsGroup } from '#/components/settings/ui'

/**
 * Settings → Install app, under its header: this device's steps, and the
 * way to put PestM8 on another. The route adds the header
 * (routes/$businessSlug/settings/install.tsx); the UI harness draws this.
 */
export function InstallSettings({
  method,
}: {
  /** Pinned, for the UI harness. */
  method?: InstallMethod
} = {}) {
  return (
    <SettingsBody>
      <SettingsGroup
        title="This device"
        footer="The app opens full screen, and keeps your licence and products on this device for sites with no signal. A browser can clear them after a week without a visit."
      >
        <div className="px-3.5 py-3.5">
          <InstallGuide method={method} />
        </div>
      </SettingsGroup>
      <SettingsGroup title="Another phone or computer">
        <p className="px-3.5 py-3 text-body text-ink">
          Open PestM8 there and go to Settings → Install app. A phone that isn’t
          signed in has the same steps on its sign-in screen.
        </p>
      </SettingsGroup>
    </SettingsBody>
  )
}
