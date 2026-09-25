import { memo } from 'react'
import { teammateColour } from './markupColour'
import { cachedPathData } from './markupStroke'
import type { PendingMark } from './pendingMarks'
import type { MarkupStroke } from './types'

/**
 * One page's marks, over the page — an SVG, not a canvas.
 *
 * iOS caps the memory every canvas on the page may hold between them
 * (`canvasLimits` in `layout.ts`), and the pages' own canvases already spend
 * that budget; a second full-page canvas per page for a few red circles would
 * blank pages out at 5x. Vectors cost next to nothing and stay sharp at any
 * zoom without a redraw.
 *
 * The SVG's box is the page's (0–1 in both directions, stretched to fit), so
 * a stroke's stored fractions are its coordinates as they stand. The lines
 * are `non-scaling-stroke`: 3 CSS pixels wide at every committed zoom, as a
 * pen line is on iOS, rather than swelling into a marker at 5x.
 * (During a pinch the whole stage is scaled by a CSS transform, and the lines
 * scale with it until the fingers lift, like everything else on the page.)
 *
 * Memoised on the page's own arrays, which only change when that page's marks
 * do, so scrolling and zooming never rebuild a path.
 */

/** A pen line's width, in CSS pixels at any zoom. */
const LINE_WIDTH = 3

export const PageMarkup = memo(function PageMarkup({
  index,
  strokes,
  pending,
  marking,
}: {
  /** 0-based. */
  index: number
  strokes: ReadonlyArray<MarkupStroke> | undefined
  pending: ReadonlyArray<PendingMark> | undefined
  /** Markup mode: this layer takes one-finger touches as the pen. */
  marking: boolean
}) {
  if (!marking && !strokes?.length && !pending?.length) return null
  return (
    <div
      // The pen's hit target (see `useMarkupInput`). Outside markup mode it
      // lets every touch through to the page, whose taps show and hide the
      // bars; inside it, `touch-action: none` keeps one finger from
      // scrolling, while two still reach the scroller's pinch.
      data-markup-page={index}
      className={
        marking
          ? 'absolute inset-0 cursor-crosshair [touch-action:none]'
          : 'pointer-events-none absolute inset-0'
      }
    >
      <svg
        aria-hidden
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        fill="none"
        strokeWidth={LINE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="pointer-events-none absolute inset-0 size-full overflow-hidden"
      >
        {strokes?.map((stroke) => {
          // Yours in the pen's red; a teammate's in their member colour, or
          // one neutral grey when it is not known — or when it is a red that
          // would pass for the pen's (`markupColour.ts`). Grey-line is the
          // same in both themes, as the paper is.
          const theirs = stroke.mine ? undefined : teammateColour(stroke.color)
          return (
            <path
              key={stroke.id}
              data-markup-stroke={stroke.mine ? 'mine' : 'theirs'}
              d={cachedPathData(stroke.points)}
              vectorEffect="non-scaling-stroke"
              className={
                stroke.mine
                  ? 'stroke-red'
                  : theirs
                    ? undefined
                    : 'stroke-grey-line'
              }
              style={theirs ? { stroke: theirs } : undefined}
            />
          )
        })}
        {pending?.map((mark) => (
          <path
            key={mark.key}
            data-markup-pending=""
            d={cachedPathData(mark.points)}
            vectorEffect="non-scaling-stroke"
            className="stroke-red"
          />
        ))}
        {marking && (
          // The stroke under the finger, drawn by `useMarkupInput` straight
          // into `d` a frame at a time. React renders it once, with no `d`,
          // and never touches it again.
          <path
            data-markup-live=""
            vectorEffect="non-scaling-stroke"
            className="stroke-red"
          />
        )}
      </svg>
    </div>
  )
})
