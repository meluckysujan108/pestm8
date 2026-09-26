import { createFileRoute, useRouteContext } from '@tanstack/react-router'
import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { PageHeader } from '#/components/shell/PageHeader'
import {
  BackLink,
  ROW_CLASS,
  RowBody,
  SettingsBody,
  SettingsGroup,
} from '#/components/settings/ui'
import { THEME_LABEL } from '#/lib/theme'
import { useHydrated } from '#/lib/useHydrated'
import { useThemePref } from '#/lib/useTheme'
import type { LucideIcon } from 'lucide-react'
import type { ThemePref } from '#/lib/theme'
import type { Tint } from '#/components/settings/ui'

export const Route = createFileRoute('/$businessSlug/settings/appearance')({
  component: AppearancePage,
})

const THEMES: Array<{ value: ThemePref; icon: LucideIcon; tint: Tint }> = [
  { value: 'light', icon: Sun, tint: 'orange' },
  { value: 'dark', icon: Moon, tint: 'blue' },
  { value: 'system', icon: Monitor, tint: 'grey' },
]

/**
 * Light, Dark or System. Three rows rather than the `Segmented` control §2.3
 * asks for on a ternary choice: that primitive takes labels only, and an
 * appearance picker reads far faster with the icons.
 *
 * Applied the moment it is tapped, with no Save: the whole app repaints
 * behind the list, which is the confirmation. It is kept in a cookie on this
 * device (src/lib/theme.ts), not on the account, so a phone and a desktop can
 * each have their own — which the footer says, since a setting on the same
 * list as My details would otherwise be expected to follow the person.
 */
function AppearancePage() {
  const { business } = Route.useRouteContext()
  const { businessSlug } = Route.useParams()
  const { theme } = useRouteContext({ from: '__root__' })
  const [pref, setTheme] = useThemePref(theme)
  // Per src/lib/useHydrated.ts: before hydration a tap here does nothing.
  const hydrated = useHydrated()

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        title="Appearance"
        back={
          <BackLink to="/$businessSlug/settings" params={{ businessSlug }}>
            Settings
          </BackLink>
        }
      />

      <SettingsBody>
        <SettingsGroup footer="System follows this device’s light or dark setting. Your choice is saved on this device only.">
          <div role="radiogroup" aria-label="Appearance">
            {THEMES.map(({ value, icon, tint }) => {
              const selected = value === pref
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={!hydrated}
                  onClick={() => setTheme(value)}
                  // The card's hairlines are drawn between its direct
                  // children, and the radiogroup is its only one.
                  className={`${ROW_CLASS} border-hairline disabled:opacity-50 [&:not(:first-child)]:border-t`}
                >
                  <RowBody icon={icon} tint={tint} title={THEME_LABEL[value]} />
                  {selected && (
                    <Check
                      aria-hidden
                      size={18}
                      strokeWidth={2.4}
                      className="shrink-0 text-blue"
                    />
                  )}
                </button>
              )
            })}
          </div>
        </SettingsGroup>
      </SettingsBody>
    </>
  )
}
