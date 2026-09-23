import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { RadioGroup } from 'radix-ui'
import { Check } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import {
  COLOUR_NAME,
  MEMBER_COLOURS,
  isMemberColour,
  normaliseColour,
} from '../../../convex/lib/colours'
import type { Id } from '../../../convex/_generated/dataModel'

const SWATCH =
  'group flex size-11 items-center justify-center rounded-full outline-none transition active:scale-[.95] focus-visible:ring-2 focus-visible:ring-blue'
// The ring follows the item's own checked state, which Radix keeps.
const CHIP =
  'flex size-8 items-center justify-center rounded-full ring-offset-2 ring-offset-surface group-data-[state=checked]:ring-2 group-data-[state=checked]:ring-ink'

/**
 * A technician's colour, chosen by the owner (Phase 4.2). It is the mark on
 * every calendar the team shares — the rail down a job card, the dots under a
 * day — so it is picked from the palette only (convex/lib/colours.ts), each
 * of which stays visible as a rail in both themes.
 *
 * Two people may share a colour; the swatch says who already has it, since
 * two identical rails on one day are two people nobody can tell apart. A
 * colour from before the palette (the old red, say) stays selected and shown
 * until the owner picks another, rather than silently vanishing from the row.
 *
 * A radio group moves its selection with the arrow keys, so arrowing across
 * to Cyan passes through every colour between. The choice shows at once and
 * is saved a moment after the last move — one change and one audit row, not
 * eight — and the group is never disabled meanwhile: a disabled radio cannot
 * hold focus, and the keyboard user would be dropped back to the page.
 */
export function ColourPicker({
  businessId,
  membershipId,
  name,
  colour,
  others,
}: {
  businessId: Id<'businesses'>
  membershipId: Id<'memberships'>
  name: string
  colour: string
  /** The rest of the team, for "also Kevin". */
  others: Array<{ name: string; email?: string; colour: string }>
}) {
  const convexSetColour = useConvexMutation(api.memberships.setColour)
  const save = useMutation({
    mutationFn: (next: string) =>
      convexSetColour({ businessId, membershipId, colour: next }),
  })

  const current = normaliseColour(colour) ?? colour
  const offered = isMemberColour(current)

  // The choice not yet confirmed by the server. Cleared once the save
  // settles: on success the roster already carries the new colour (a Convex
  // mutation resolves after its reads have updated), and on failure the
  // stored colour shows again beside the error.
  const [chosen, setChosen] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  const choose = (next: string) => {
    setChosen(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      // Only its own choice: a newer one made meanwhile stays shown until
      // its own save settles.
      save.mutate(next, {
        onSettled: () => setChosen((shown) => (shown === next ? null : shown)),
      })
    }, 500)
  }
  const selected = chosen ?? current

  const holders = (swatch: string) =>
    others
      .filter((o) => normaliseColour(o.colour) === swatch)
      .map((o) => o.name || o.email || 'someone else')

  const sharedWith = holders(current)

  return (
    <div>
      <p className="section-label">Colour</p>
      <RadioGroup.Root
        aria-label={`Colour for ${name}`}
        value={selected}
        onValueChange={choose}
        className="mt-1 flex flex-wrap gap-0.5"
      >
        {!offered && (
          <RadioGroup.Item
            value={current}
            aria-label="Current colour, no longer offered"
            className={SWATCH}
          >
            <span className={CHIP} style={{ backgroundColor: current }}>
              <RadioGroup.Indicator>
                <Check
                  size={16}
                  strokeWidth={3}
                  className="text-white"
                  aria-hidden
                />
              </RadioGroup.Indicator>
            </span>
          </RadioGroup.Item>
        )}
        {MEMBER_COLOURS.map((swatch) => {
          const also = holders(swatch)
          return (
            <RadioGroup.Item
              key={swatch}
              value={swatch}
              aria-label={
                also.length > 0
                  ? `${COLOUR_NAME[swatch]}, also ${also.join(' and ')}`
                  : COLOUR_NAME[swatch]
              }
              className={SWATCH}
            >
              <span className={CHIP} style={{ backgroundColor: swatch }}>
                <RadioGroup.Indicator>
                  <Check
                    size={16}
                    strokeWidth={3}
                    className="text-white"
                    aria-hidden
                  />
                </RadioGroup.Indicator>
              </span>
            </RadioGroup.Item>
          )
        })}
      </RadioGroup.Root>
      {!offered && (
        <p className="mt-1 text-caption text-ink-2">
          Their current colour is no longer offered. Pick one of these.
        </p>
      )}
      {sharedWith.length > 0 && (
        <p className="mt-1 text-caption text-ink-2">
          {sharedWith.join(' and ')} {sharedWith.length === 1 ? 'has' : 'have'}{' '}
          this colour too, so their jobs look the same on the schedule.
        </p>
      )}
      {save.isError && (
        <p role="alert" className="mt-1.5 text-caption text-amber-ink">
          Could not change the colour. Check your connection and try again.
        </p>
      )}
    </div>
  )
}
