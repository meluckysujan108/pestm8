/**
 * A link that opens an address in a maps app, for the job card's Map button.
 *
 * Google's cross-platform "search" URL rather than a platform scheme: it opens
 * the Google Maps app where one is installed (Android, and iPhones that have
 * it) and the website everywhere else, and it needs no guess at the device —
 * a guess the server render could not make anyway.
 *
 * The postcode stands in for the state. It is state-specific, and it is typed
 * with the address, whereas a property's state is a dropdown that defaults to
 * WA whatever the address is. "Australia" pins a suburb that shares its name
 * with somewhere overseas. The address is built from the row's own fields —
 * never the business's state, which is wrong for every job across a border.
 */
export function mapsUrl(address: {
  addressLine?: string
  suburb?: string
  postcode?: string
}): string | null {
  const parts = [address.addressLine, address.suburb, address.postcode]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
  if (parts.length === 0) return null

  const query = [...parts, 'Australia'].join(', ')
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
}

/** The part of a window `openMapTab` needs, so a test can hand it a fake. */
type TabOpener = {
  open: (url: string, target: string) => { opener: unknown } | null
  navigator: { userActivation?: { isActive: boolean } }
}

/**
 * Opens the map in a new tab, and says whether it did.
 *
 * Never by navigating this window: that unloads the installed app, and the
 * technician comes back to a cold start. A new tab is only allowed from the
 * user's own gesture — for touch, the finger lifting — which is why the Map
 * hold acts on the lift (src/lib/holdGesture.ts). Where the browser still
 * says no, this returns false and the caller offers a plain link, which a
 * tap always opens.
 *
 * Deliberately without the 'noopener' feature: with it `open` returns null
 * whether or not the tab opened, and null is the only sign of a block. The
 * opener is cut by hand instead, while the new tab is still about:blank.
 */
export function openMapTab(url: string, win: TabOpener = window): boolean {
  // Known to be refused: skip straight to the link, and spare Chrome its
  // "pop-up blocked" bar.
  if (win.navigator.userActivation?.isActive === false) return false
  const tab = win.open(url, '_blank')
  if (tab === null) return false
  try {
    tab.opener = null
  } catch {
    // Already navigated away from about:blank; nothing left to cut.
  }
  return true
}
