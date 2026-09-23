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
