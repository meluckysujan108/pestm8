/**
 * Where a bar fixed or pinned to the bottom of a phone screen sits: directly
 * on the mobile dock (MobileDock), which is 55px tall — its border, padding,
 * glyph and label — plus the home indicator's inset.
 *
 * Not the 68px `main` pads its content by, which leaves room to breathe above
 * the dock: a bar placed there leaves a strip the page scrolls through between
 * the two bars. On a wide screen there is no dock; give the bar its own `lg:`
 * position.
 */
export const ABOVE_DOCK = 'bottom-[calc(55px+env(safe-area-inset-bottom))]'
