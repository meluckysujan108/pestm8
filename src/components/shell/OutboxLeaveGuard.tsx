import { useEffect, useRef, useState } from 'react'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'
import { FIX_ARM_MS } from '#/components/forms/saveWarningRules'
import { registerLeaveGuard } from '#/lib/offline/leaveGuard'
import { leaveGuardFor } from '#/lib/outbox/leaveAsk'
import { browserLocks } from '#/lib/outbox/outboxLocks'
import { OUTBOX_ENABLED } from '#/lib/outbox/outboxSet'
import { keptBefore, retryOutbox } from '#/lib/outbox/outboxStore'
import { holdSends, holdSendsHere } from '#/lib/outbox/switchGate'
import { signedInUserId } from '#/lib/rootState'
import type { Keeper } from '#/lib/offline/keeper'
import type { LeaveFacts, LeaveQuestion } from '#/lib/outbox/leaveAsk'
import type { OutboxModel } from '#/lib/outbox/outbox'
import type { Sender } from '#/lib/outbox/sender'

/**
 * Asks before leaving loses the bookings on this phone, not sent yet (plan
 * part 2c §11): "Sign out and discard 2 jobs not sent yet?" before any of
 * the six ways to sign out (`useSignOut`), and "Switch with 2 jobs not sent
 * yet?" before the business switcher leaves this business's behind. Mounted
 * once, at the root, so it is there outside a business too (the no-business,
 * set-up, two-step, join and start screens). What it asks, and when it
 * doesn't, is `leaveQuestion`'s (lib/outbox/leaveAsk.ts).
 *
 * It owns one `ConfirmDialog`, opened by the guard (`leaveGuardFor`) and
 * answered by the person: Discard and sign out (or Switch) goes, and the way
 * out, Escape or a tap on the scrim stays. A second ask while one is out is
 * answered stay: nothing is thrown away on a question nobody saw. Each
 * question comes up held for FIX_ARM_MS (`ConfirmDialog`'s `held`): it lands
 * a moment after the tap that asked, or where the last one's Discard and
 * sign out was when it asks again, so a double tap is no answer.
 *
 * The root hands in its outbox, sender and keeper (as `ConnectionNotice`
 * has its keeper and sender), so nothing here loads them a second time.
 */
export function OutboxLeaveGuard({
  outbox,
  sender,
  keeper,
}: {
  outbox: Pick<OutboxModel, 'readable' | 'all' | 'subscribe' | 'refreshed'>
  sender: Pick<Sender, 'inflight'>
  keeper: Pick<Keeper, 'enteredBusiness'>
}) {
  const [asking, setAsking] = useState<LeaveQuestion | null>(null)
  const [held, setHeld] = useState(false)
  const answer = useRef<((go: boolean) => void) | null>(null)

  useEffect(() => {
    if (!held) return
    const release = setTimeout(() => setHeld(false), FIX_ARM_MS)
    return () => clearTimeout(release)
  }, [held, asking])

  useEffect(() => {
    const facts: LeaveFacts = {
      storage: typeof indexedDB !== 'undefined' && browserLocks() !== null,
      enabled: OUTBOX_ENABLED,
      keptBefore,
      readable: () => outbox.readable(),
      readFresh: () => {
        retryOutbox()
        return outbox.refreshed()
      },
      subscribe: outbox.subscribe,
      items: () => outbox.all(),
      inflight: () => sender.inflight(),
      holdSends: (waitMs) => holdSends(waitMs),
      holdHere: holdSendsHere,
      userId: signedInUserId,
      businessId: () => keeper.enteredBusiness()?._id ?? null,
    }
    const stop = registerLeaveGuard(
      leaveGuardFor(
        facts,
        (question) =>
          new Promise<boolean>((resolve) => {
            answer.current = (go) => {
              answer.current = null
              setAsking(null)
              setHeld(false)
              resolve(go)
            }
            setHeld(true)
            setAsking(question)
          }),
      ),
    )
    return () => {
      stop()
      answer.current?.(false)
    }
  }, [outbox, sender, keeper])

  return (
    <ConfirmDialog
      open={asking !== null}
      onOpenChange={(open) => {
        if (!open) answer.current?.(false)
      }}
      title={asking?.title ?? ''}
      body={asking?.body ?? ''}
      confirm={asking?.confirm ?? ''}
      cancel={asking?.cancel ?? ''}
      onConfirm={() => answer.current?.(true)}
      held={held}
      labelInset
    />
  )
}
