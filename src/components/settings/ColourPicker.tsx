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
  'group flex size-11 items-center justify-center rounded-full outline-none transition active:scale-[.95] focus-visible:ring-2 focus-visible:ring-blue disabled:opacity-60'
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
  // Shown as chosen while the save is in flight, so the tap lands at once.
  const selected = save.isPending && save.variables ? save.variables : current

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
        disabled={save.isPending}
        onValueChange={(next) => save.mutate(next)}
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
