/**
 * Whose jobs not sent yet are on this phone, on the screens where someone
 * signs in (plan part 2c §11.4, S13, D26): "Kevin has 2 jobs on this phone
 * not sent yet. They’re kept until Kevin signs in again and sends them.
 * Signing in as anyone else discards them." Signing in as someone else
 * drops them, and this is what says so first. Nothing when there are none,
 * including those a sign-out has discarded.
 *
 * The page reads the line (`useOnPhoneLine`) and hands it in with an `id`,
 * which its sign-in button names in `aria-describedby` while the line shows,
 * so a screen reader hears it with the button, wherever the line sits.
 *
 * Taking no room: the sign-in screens are centred, and the phone is read
 * only once the page has hydrated, so a line that came in would move the
 * form under a thumb. It is laid over something on the page that gives way
 * to it while it shows (`invisible`, keeping its room), so nothing moves and
 * the line is where the person looks, never below the fold under a long
 * form. Every sign-in screen has it `over`, at the top of the `relative` box
 * it is put in, over what that box holds: the line under the title
 * (`/login`'s subtitle, the join and start pages' line saying what the link
 * is), so the smallest phone shows it. Without `over` it hangs below the
 * line above it, over what follows, which under the join and start pages'
 * forms was below the fold on an iPhone SE. In `text-caption text-ink-2`.
 */
export function OutboxOnPhoneLine({
  line,
  id,
  over = false,
}: {
  /** `useOnPhoneLine`'s: null with none, while hydrating, and until read. */
  line: string | null
  /** For the sign-in button's `aria-describedby`. */
  id: string
  /** Laid over the `relative` box it is put in, from its top, rather than
   * hung below the line above it. */
  over?: boolean
}) {
  if (line === null) return null
  if (over) {
    return (
      <p id={id} className="absolute inset-x-0 top-0 text-caption text-ink-2">
        {line}
      </p>
    )
  }
  return (
    <div className="relative h-0">
      <p
        id={id}
        className="absolute inset-x-0 top-0 pt-4 pb-6 text-caption text-ink-2"
      >
        {line}
      </p>
    </div>
  )
}
