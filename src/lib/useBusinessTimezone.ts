import { useRouteContext } from '@tanstack/react-router'

/**
 * The business's time zone, for a component deep inside a business page that
 * formats a moment ("sent Fri 25 Sept, 9:30am") and was not handed one.
 *
 * Read from the `$businessSlug` route's context, where the tenant guard puts
 * the business. Never the device's own zone inside a business: a report sent
 * at 9:30 in Perth is not "11:30am" because the owner reading it is in
 * Sydney. Outside a business route (a preview, the UI harness) there is no
 * business to ask, and the device's zone is the only answer there is.
 */
export function useBusinessTimezone(): string {
  const timezone = useRouteContext({
    strict: false,
    select: (context) =>
      (context as { business?: { timezone?: string } }).business?.timezone,
  })
  return timezone ?? deviceTimezone()
}

/** The phone's own zone — for what is deliberately local to the device, such
 * as when a GPS reading was taken on site. */
export function deviceTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}
