import {
  Check,
  Clock,
  LoaderCircle,
  Smartphone,
  TriangleAlert,
} from 'lucide-react'
import { CHIP_WORDS } from '#/lib/outbox/outboxRules'
import { OUTBOX_CHIP, OUTBOX_LOOK_CHIP } from '#/lib/statusColours'
import type { OutboxChip as Chip } from '#/lib/outbox/outboxRules'

/**
 * A booking on the phone, not sent yet, where its card and its sheet put the
 * job number and the status pill (lib/outbox/): "Not sent yet" with a
 * phone, "Sending…" with a spinner while the line is live (a clock while it
 * isn't), "Sent" with a tick, all a quiet grey chip (`OUTBOX_CHIP`); and
 * "Needs a look" in amber, bordered, with the warning glyph
 * (`OUTBOX_LOOK_CHIP`). Sized as `StatusPill` is, so the row it sits in
 * keeps its height, and with its word always: the glyph only adds to it.
 */
export function OutboxChip({
  chip,
  lineLive,
}: {
  chip: Chip
  /** Whether the line is live: a "Sending…" spins only then. */
  lineLive: boolean
}) {
  const icon = {
    waiting: <Smartphone size={12} strokeWidth={2.4} aria-hidden />,
    sending: lineLive ? (
      <LoaderCircle
        size={12}
        strokeWidth={2.4}
        aria-hidden
        className="animate-spin"
      />
    ) : (
      <Clock size={12} strokeWidth={2.4} aria-hidden />
    ),
    needsLook: <TriangleAlert size={12} strokeWidth={2.4} aria-hidden />,
    sent: <Check size={12} strokeWidth={2.4} aria-hidden />,
  }[chip]
  return (
    <span
      // Bordered as a status pill is, the grey chip's border unseen: so the
      // two are one size, and nothing moves when one becomes the other.
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-[3px] text-[12px] font-semibold ${chip === 'needsLook' ? OUTBOX_LOOK_CHIP : `border border-transparent ${OUTBOX_CHIP}`}`}
    >
      {icon}
      {CHIP_WORDS[chip]}
    </span>
  )
}
