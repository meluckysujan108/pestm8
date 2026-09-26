/**
 * The app's red primary button, written once.
 *
 * Every screen had spelled it out by hand, and the copies had drifted: 17px
 * and 16px labels on the same 48px button, one without its shadow, two that
 * did not press in, two that faded to 40% when disabled where the rest faded
 * to 50%. These hold the look; a button adds only where it sits (`w-full`,
 * `mt-5`, `flex-1`) and how it lays out its own content (`flex … gap-2` for
 * an icon beside the label).
 *
 * The fill is `red-fill`, not the brand `red`: white on the brand red is
 * 3.5:1, and these labels are 15–17px (styles.css has the numbers).
 *
 * Two sizes, and only two: the full 48px one for a page's or a sheet's main
 * action, and the 44px one where it shares a row or sits in a dialog.
 */
export const PRIMARY_BUTTON =
  'h-12 rounded-xl bg-red-fill text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50'

export const PRIMARY_BUTTON_COMPACT =
  'h-11 rounded-xl bg-red-fill text-[15px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50'
