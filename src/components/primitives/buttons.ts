/**
 * The app's buttons, written once. Every screen used to spell its buttons out
 * by hand, and the copies drifted: 14, 15, 16 and 17px labels on buttons of
 * one height, some without a press-in, disabled at 40% or 50%, the same job
 * drawn red on one screen, black on another and blue on a third.
 *
 * What each colour means — the rule the constants below carry:
 *
 * - PRIMARY (red): the one action on a screen or sheet that saves or commits
 *   something — Save, Add, Book, Finalise & lock, Remove in a confirm.
 * - NEUTRAL (ink): the main action when nothing is saved — moving to the next
 *   step, starting, opening, sending on: Next section, Start report, Send,
 *   Share, View PDF. The reports builder drew this distinction first, keeping
 *   red for the lock.
 * - SECONDARY (grey, ink label): the alternatives beside those — Cancel, Back,
 *   Clear, Other…
 * - LINK_BUTTON (grey, blue label): goes somewhere else — Start from the top,
 *   an empty screen's "Add a product". Blue is for links; no button is filled
 *   blue.
 *
 * Two sizes each, and only two: 48px for a screen's or a sheet's own action,
 * 44px where the button shares a row or sits in a dialog or a card. A button
 * adds only where it sits (`w-full`, `mt-5`, `flex-1`) and how it lays out
 * its own content (`flex items-center justify-center gap-2` beside an icon).
 *
 * The red is `red-fill`, not the brand `red`: white on the brand red is 3.5:1,
 * and these labels are 15–17px (styles.css has the numbers). The grey is
 * `fill-secondary`, a translucent grey as iOS draws its grey buttons, so the
 * button reads on a white card and on the grey canvas alike — the opaque
 * surface-2 it replaces all but vanished on the canvas.
 */

const BASE =
  'rounded-xl font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-blue active:scale-[.975] disabled:opacity-50'
const FULL = 'h-12 text-[17px]'
const COMPACT = 'h-11 text-body'

const RED = 'bg-red-fill text-white shadow-red'
const INK = 'bg-ink text-surface'
const GREY = 'bg-fill-secondary text-ink'
const GREY_LINK = 'bg-fill-secondary text-blue'

export const PRIMARY_BUTTON = `${FULL} ${RED} ${BASE}`
export const PRIMARY_BUTTON_COMPACT = `${COMPACT} ${RED} ${BASE}`

export const NEUTRAL_BUTTON = `${FULL} ${INK} ${BASE}`
export const NEUTRAL_BUTTON_COMPACT = `${COMPACT} ${INK} ${BASE}`

export const SECONDARY_BUTTON = `${FULL} ${GREY} ${BASE}`
export const SECONDARY_BUTTON_COMPACT = `${COMPACT} ${GREY} ${BASE}`

export const LINK_BUTTON = `${FULL} ${GREY_LINK} ${BASE}`
export const LINK_BUTTON_COMPACT = `${COMPACT} ${GREY_LINK} ${BASE}`
