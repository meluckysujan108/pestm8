import { useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Drawer } from 'vaul'
import { Smartphone } from 'lucide-react'
import { SHEET_BODY } from '#/components/primitives/Sheet'
import { FormAlert } from '#/components/forms/FormAlert'
import { useAccess } from '#/lib/access'
import { keeper } from '#/lib/offline/keeper'
import { useLineDown } from '#/lib/offline/useLineDown'
import {
  outboxInset,
  outboxProblemCopy,
  savedLine,
} from '#/lib/outbox/outboxInset'
import { chipFor } from '#/lib/outbox/outboxRules'
import { outboxRow } from '#/lib/outbox/outboxRow'
import { sender } from '#/lib/outbox/sender'
import { useOutboxItem } from '#/lib/outbox/useOutbox'
import { rq } from '#/lib/routeQueries'
import { dayKeyOf } from '../../../convex/lib/dates'
import { BOOKING_ERROR_COPY } from './bookingCopy'
import { KeptJobView } from './KeptJobView'
import { OutboxChip } from './OutboxChip'
import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'

type Roster = FunctionReturnType<typeof api.memberships.listForBusiness>

/** A booking's sheet, once it has gone from the phone. */
export const NOT_ON_PHONE =
  'Not on this phone any more: it was sent, or discarded.'

/**
 * A booking on this phone, not sent yet, opened from its card
 * (`?outboxId=`): laid out as its job's sheet will be (`KeptJobView`, from
 * its own row), its chip in the status's place, and under who to call what
 * it says of itself (lib/outbox/outboxInset.ts). Read-only for now.
 */
export function OutboxItemBody({
  businessId,
  localId,
  timezone,
}: {
  businessId: Id<'businesses'>
  localId: string
  timezone: string
}) {
  const item = useOutboxItem(businessId, localId)
  const access = useAccess()
  const queryClient = useQueryClient()
  const roster = queryClient.getQueryData<Roster>(
    rq.roster(businessId).queryKey,
  )
  const down = useLineDown()
  const lineLive = useSyncExternalStore(
    keeper.subscribe,
    () => keeper.lineLive(),
    () => false,
  )
  if (item === null) return null
  if (item === undefined) {
    return (
      <div className="px-4 py-10">
        <Drawer.Title className="text-sheet-title text-ink">Job</Drawer.Title>
        <p className="mt-1 text-body text-ink-2">{NOT_ON_PHONE}</p>
      </div>
    )
  }
  // Drawn only in the browser, once the outbox is read: the phone's clock.
  const todayKey = dayKeyOf(Date.now(), timezone)
  const said = outboxInset({
    item,
    lineLive,
    held: sender.heldReason(localId),
    sendingHere: sender.sendingHere(localId),
    sendingElsewhere: sender.sendingElsewhere(localId),
    storageTrouble: sender.storageNotAnswering(),
    timezone,
    todayKey,
  })
  return (
    <div className={`${SHEET_BODY} pt-3`}>
      <KeptJobView
        job={outboxRow(item, {
          seesPrices: access.caps['prices.see'],
          roster,
        })}
        asOf={item.createdAt}
        down={down}
        timezone={timezone}
        roster={roster}
        outbox={{
          chip: <OutboxChip chip={chipFor(item)} lineLive={lineLive} />,
          inset:
            'problem' in said ? (
              <FormAlert
                className="mt-3"
                error={{ data: said.problem }}
                copy={{
                  ...BOOKING_ERROR_COPY,
                  ...outboxProblemCopy(item, timezone, todayKey),
                }}
              />
            ) : (
              <p className="mt-3 flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2 text-caption text-ink-2">
                <Smartphone
                  aria-hidden
                  size={14}
                  strokeWidth={2}
                  className="mt-0.5 shrink-0"
                />
                <span>
                  {said.words} {savedLine(item, timezone, todayKey)}
                </span>
              </p>
            ),
        }}
      />
    </div>
  )
}
