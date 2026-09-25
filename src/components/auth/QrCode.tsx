import { useMemo } from 'react'
import { encode } from 'uqr'

/**
 * A QR code drawn as one SVG path, from `uqr` (zero dependencies, ~12 kB).
 *
 * Only ever shown on a wider screen, for someone setting up at a desk: a
 * phone cannot scan its own screen, so on a phone the "Add to authenticator
 * app" link does this job instead. Drawn from the module matrix rather than
 * `renderSVG`'s string, so nothing is injected as HTML.
 *
 * Always dark on white, whatever the theme — a light-on-dark QR code is one
 * many scanners refuse.
 */
export function QrCode({ value, label }: { value: string; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = encode(value, { ecc: 'M', border: 2 })
    let d = ''
    qr.data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`
      }),
    )
    return { size: qr.size, path: d }
  }, [value])

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="size-48 rounded-xl bg-white"
    >
      <path d={path} fill="#000" />
    </svg>
  )
}
