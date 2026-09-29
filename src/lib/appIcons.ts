import screens from './launchScreens.json'

/**
 * The app as a phone shows it outside a page: the browser tab's icon, the Home
 * Screen icon, and what an iPhone or iPad shows while the Home Screen app
 * opens. The files are drawn from the logo mark (public/icon.svg) by
 * scripts/build-icons.mjs and committed; `pnpm icons` redraws them. The
 * manifest names its own icons (public/manifest.webmanifest).
 */

/** An iOS screen size, from src/lib/launchScreens.json. */
export interface LaunchScreen {
  /** In points, as held upright: CSS's device-width and device-height. */
  width: number
  height: number
  /** Pixels per point. */
  ratio: number
  /** An iPad, which can open the app sideways and needs a screen for that. */
  landscape?: boolean
  /** Which devices have this screen, for whoever next updates the list. */
  devices: string
}

export type Orientation = 'portrait' | 'landscape'
export type LaunchTheme = 'light' | 'dark'

export const LAUNCH_SCREENS: ReadonlyArray<LaunchScreen> = screens

/** Where scripts/build-icons.mjs writes the image for a screen. */
export function launchScreenHref(
  screen: LaunchScreen,
  orientation: Orientation,
  theme: LaunchTheme,
): string {
  const across = screen.width * screen.ratio
  const down = screen.height * screen.ratio
  const [w, h] = orientation === 'portrait' ? [across, down] : [down, across]
  return `/splash/${w}x${h}-${theme}.png`
}

/**
 * What iOS matches a launch screen by: the exact screen, or nothing shows.
 * device-width and device-height keep their upright values in landscape.
 */
export function launchScreenMedia(
  screen: LaunchScreen,
  orientation: Orientation,
  theme: LaunchTheme,
): string {
  const query = `(device-width: ${screen.width}px) and (device-height: ${screen.height}px) and (-webkit-device-pixel-ratio: ${screen.ratio}) and (orientation: ${orientation})`
  return theme === 'dark' ? `(prefers-color-scheme: dark) and ${query}` : query
}

/**
 * Without one of these for its exact screen, an iPhone opens a Home Screen
 * app on black and stays there until the first paint; iOS reads nothing from
 * the manifest for it. With one, it shows the icon on the app's own canvas
 * colour instead.
 *
 * The light links come first and carry no colour-scheme condition, and the
 * dark ones follow: iOS takes the last link that matches, so a phone in dark
 * mode gets the dark screen and every other phone the light one. iOS keeps
 * the image it was given when the app was added to the Home Screen, so a
 * change here reaches a phone only once the app is removed and added again.
 */
export function launchScreenLinks() {
  const links = []
  for (const theme of ['light', 'dark'] as const) {
    for (const screen of LAUNCH_SCREENS) {
      const orientations: Array<Orientation> = screen.landscape
        ? ['portrait', 'landscape']
        : ['portrait']
      for (const orientation of orientations) {
        links.push({
          rel: 'apple-touch-startup-image',
          href: launchScreenHref(screen, orientation, theme),
          media: launchScreenMedia(screen, orientation, theme),
        })
      }
    }
  }
  return links
}

export const APP_ICON_LINKS = [
  // `sizes`, so that Chrome takes the SVG below rather than the .ico.
  { rel: 'icon', href: '/favicon.ico', sizes: '32x32' },
  { rel: 'icon', href: '/icon.svg', type: 'image/svg+xml' },
  { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
  ...launchScreenLinks(),
]
