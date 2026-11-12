import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { signedInUserId } from '#/lib/rootState'
import { useHydrated } from '#/lib/useHydrated'
import { outbox } from './outbox'
import { onPhoneLine, unsentByBusiness } from './leaveAsk'
import type { UnsentHere } from './leaveAsk'
import { peekOutbox, readOutboxNow } from './outboxStore'

/**
 * What the screens outside a day's list say of the bookings on this phone,
 * not sent yet: the sign-in screens' line, and how many of the person's
 * wait in each business (SwitchBanner, the business switcher). Apart from
 * useOutbox.ts so the sign-in page and the shell load only the outbox and
 * its store, which the root has loaded already, and none of New Job's.
 *
 * Neither says anything while hydrating (the server knows nothing of them),
 * nor before the phone's bookings have been read.
 */

/** The outbox's revision, or -1 while hydrating. */
function useRevision(): number {
  return useSyncExternalStore(
    outbox.subscribe,
    () => outbox.revision(),
    () => -1,
  )
}

/**
 * The sign-in screens' line (`onPhoneLine`): "Kevin has 2 jobs on this phone
 * not sent yet. …", read from the phone, which needs no sign-in. Null with
 * none, while hydrating, and until read; read again whenever the phone's
 * bookings change (another tab's sign-out among them).
 *
 * Read afresh once this tab has read them (`readOutboxNow`): a session ended
 * elsewhere brings the page here without a reload, and the page load's read
 * (`peekOutbox`) still holds what this tab has sent, swept or discarded
 * since, which would be said to be on the phone. A page that hasn't read
 * them yet takes that first read, and so does one whose storage doesn't
 * answer the fresh one: a line that may be out of date, over none at all
 * while someone else could sign in and discard them.
 */
export function useOnPhoneLine(): string | null {
  const hydrated = useHydrated()
  const revision = useRevision()
  const [line, setLine] = useState<string | null>(null)
  useEffect(() => {
    if (!hydrated) return
    let live = true
    const read = outbox.readable()
      ? readOutboxNow().then((found) =>
          found === 'error' ? peekOutbox() : found,
        )
      : peekOutbox()
    void read.then((found) => {
      if (live) setLine(found === 'error' ? null : onPhoneLine(found))
    })
    return () => {
      live = false
    }
  }, [hydrated, revision])
  return hydrated ? line : null
}

/** How often the counts are taken again while a booking is waiting: one can
 * wait too long to go by itself with nothing on the phone changing. */
const RELOOK_MS = 60_000

/**
 * How many of the signed-in person's bookings not sent yet wait in each
 * business, by business id (`unsentByBusiness`: those that go by
 * themselves, and those that need a look first, one waiting too long among
 * them): whatever the account they are working in, as they are all theirs.
 * Null while hydrating and until the phone's bookings have been read.
 */
export function useUnsentByBusiness(): ReadonlyMap<string, UnsentHere> | null {
  const hydrated = useHydrated()
  const revision = useRevision()
  const [relook, setRelook] = useState(0)
  const waiting =
    hydrated &&
    revision >= 0 &&
    outbox.readable() &&
    outbox.all().some((item) => item.state === 'waiting')
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => setRelook((n) => n + 1), RELOOK_MS)
    return () => clearInterval(timer)
  }, [waiting])
  return useMemo(() => {
    if (!hydrated || revision < 0 || !outbox.readable()) return null
    const userId = signedInUserId()
    if (userId === null) return new Map<string, UnsentHere>()
    return unsentByBusiness(outbox.all(), userId, Date.now())
    // `revision` is what says the outbox changed, `relook` that time has.
  }, [hydrated, revision, relook])
}
