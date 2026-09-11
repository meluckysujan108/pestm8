/**
 * A small segmented intensity bar — five ticks that fill in proportion to
 * `value / max`. Reads at a glance next to a number that most people have no
 * intuition for: "14 km/h" means little on its own, but two lit ticks out of
 * five place it immediately.
 *
 * Partial segments are not drawn; a segment is lit once the value reaches it,
 * so the bar never implies more precision than a rounded forecast has.
 */
export function BarMeter({
  value,
  max,
  segments = 5,
  tint = 'bg-ink-2',
}: {
  value: number
  max: number
  segments?: number
  /** Tailwind background class for a lit segment. */
  tint?: string
}) {
  const ratio = max <= 0 ? 0 : Math.min(Math.max(value / max, 0), 1)
  const lit = Math.round(ratio * segments)

  return (
    <span aria-hidden className="flex items-end gap-[2px]">
      {Array.from({ length: segments }, (_, i) => (
        <span
          key={i}
          className={`h-2.5 w-[3px] rounded-[1px] ${
            i < lit ? tint : 'bg-fill-track'
          }`}
        />
      ))}
    </span>
  )
}
