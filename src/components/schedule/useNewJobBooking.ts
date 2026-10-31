import { useSheetLock } from '#/components/primitives/Sheet'
import { useBooking } from '#/lib/outbox/useOutbox'
import type { BookingCall } from '#/lib/outbox/outboxItem'

/**
 * New Job's Book for this opening of the sheet (`useBooking`), and the
 * sheet's lock (`useSheetLock`), paired as the booking's rule needs them:
 * the sheet asks "Discard your changes?" while something typed would be
 * lost, and not once the booking is kept on the phone, when closing it loses
 * nothing; and a Discard confirmed is the press's from the moment it is
 * (`BookingSession.discard`), before a Back's move lands, so nothing of a
 * booking discarded is kept or sent, whatever the screen shows by the time
 * the sheet goes. In one hook so the pairing is the one the tests run.
 *
 * `changed`: whether anything in the form has been filled in.
 */
export function useNewJobBooking(
  changed: boolean,
  sheet: { booked?: () => void; close: () => void },
  call: (call: BookingCall) => Promise<unknown>,
): ReturnType<typeof useBooking> {
  const booking = useBooking(sheet, call)
  useSheetLock(changed && !booking.kept, {
    whileUnchanged: false,
    onDiscard: () => booking.session.discard(),
  })
  return booking
}
