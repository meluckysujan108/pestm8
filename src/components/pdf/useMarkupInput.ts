import { useEffect, useLayoutEffect, useRef } from 'react'
import { addPoint, pagePoint, pathData } from './markupStroke'
import { IDLE, scrolledAt, stepInput } from './markupInput'
import type { RefObject } from 'react'
import type { InputEvent, InputState, OwnScroll } from './markupInput'
import type { MarkupPoint } from './types'

/**
 * The pen: pointer input over the pages while markup mode is on, turned into
 * strokes (the rules are `markupInput.ts`'s; this is the DOM around them).
 *
 * Native listeners on the stage — the element every page slot sits in — so
 * they run before the scroller's own, which are further up: a pointer event
 * that lands on a page's markup layer is stopped there, and the scroller's
 * tap and double-tap code never sees a drawing touch. Without that, a dot
 * would also toggle the bars, and two quick strokes would zoom to 2.5x.
 *
 * Only pointer events are stopped. Touch events go on up untouched, because
 * the scroller's pinch is driven by `touchstart`/`touchmove` with two touches:
 * a second finger ends the stroke here and starts the pinch there. They are
 * listened to as well, on the document, for how many fingers are down — the
 * pinch's own count, bars included (see `markupInput.ts`).
 *
 * The stroke in progress is drawn straight into a `<path>`'s `d`, once a
 * frame, never through React state: a state update per pointer event would
 * re-render every page slot sixty to a hundred and twenty times a second.
 */
export function useMarkupInput({
  stageRef,
  scrollerRef,
  ownScrollRef,
  enabled,
  onStroke,
}: {
  stageRef: RefObject<HTMLElement | null>
  scrollerRef: RefObject<HTMLElement | null>
  /**
   * Where the scroller last set its own scroll, so a zoom or pan being
   * committed is not taken for a fling (`isOwnScroll`).
   */
  ownScrollRef: RefObject<OwnScroll | null>
  enabled: boolean
  /**
   * A finished stroke on page `index` (0-based). Must put the stroke on
   * screen before it returns — the live path is cleared straight after, and
   * anything later is a blink.
   */
  onStroke: (index: number, points: Array<MarkupPoint>) => void
}) {
  const onStrokeRef = useRef(onStroke)
  useLayoutEffect(() => {
    onStrokeRef.current = onStroke
  })

  useEffect(() => {
    const stage = stageRef.current
    const scroller = scrollerRef.current
    if (!enabled || !stage || !scroller) return

    type Stroke = {
      pointerId: number
      page: number
      slot: HTMLElement
      layer: HTMLElement
      live: SVGPathElement | null
      points: Array<MarkupPoint>
    }

    let state: InputState = IDLE
    let lastScrollAt = Number.NEGATIVE_INFINITY
    let stroke: Stroke | null = null
    let frame = 0

    const scheduleDraw = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (stroke?.live) stroke.live.setAttribute('d', pathData(stroke.points))
      })
    }

    /** Takes the stroke off the live path, and forgets it. */
    const end = (): Stroke | null => {
      const ended = stroke
      stroke = null
      cancelAnimationFrame(frame)
      frame = 0
      return ended
    }

    /** Adds the pointer's positions; false once the stroke is full. */
    const extend = (events: ReadonlyArray<PointerEvent>): boolean => {
      if (!stroke) return true
      // Once per batch: the slot's rectangle includes the stage's gesture
      // transform, and a mouse wheel can scroll the page mid-stroke.
      const box = stroke.slot.getBoundingClientRect()
      for (const event of events) {
        const point = pagePoint(event.clientX, event.clientY, box)
        if (point && addPoint(stroke.points, point, box) === 'full') {
          return false
        }
      }
      return true
    }

    const finish = () => {
      const done = end()
      if (!done) return
      try {
        if (done.points.length > 0) onStrokeRef.current(done.page, done.points)
      } finally {
        // After the caller has drawn it as a pending mark, not before.
        done.live?.removeAttribute('d')
      }
    }

    const discard = () => {
      end()?.live?.removeAttribute('d')
    }

    const start = (event: PointerEvent, layer: HTMLElement, page: number) => {
      const slot = layer.closest<HTMLElement>('[data-page-index]')
      if (!slot) return
      stroke = {
        pointerId: event.pointerId,
        page,
        slot,
        layer,
        live: layer.querySelector<SVGPathElement>('[data-markup-live]'),
        points: [],
      }
      // A touch is captured by where it landed anyway; a mouse or a pencil
      // is not, and a stroke dragged off the page would stop hearing about
      // the pointer and never finish.
      try {
        layer.setPointerCapture(event.pointerId)
      } catch {
        // Capture is a nicety; the stage still hears the events.
      }
      extend([event])
      scheduleDraw()
    }

    const feed = (
      event: PointerEvent,
      input: InputEvent,
      layer: HTMLElement | null,
    ) => {
      const next = stepInput(state, input)
      state = next.state
      switch (next.effect) {
        case 'start':
          if (layer && state.kind === 'drawing') start(event, layer, state.page)
          return
        case 'extend': {
          // Every position since the last event, where the browser keeps
          // them (a fast stroke is otherwise a polygon); Safari before 18.2
          // has no such method.
          const coalesced =
            'getCoalescedEvents' in event ? event.getCoalescedEvents() : []
          if (extend(coalesced.length > 0 ? coalesced : [event])) {
            scheduleDraw()
            return
          }
          // Full: saved as it stands, and the rest of this touch ignored.
          state = stepInput(state, { type: 'full' }).state
          finish()
          return
        }
        case 'finish':
          extend([event])
          finish()
          return
        case 'discard':
          discard()
          return
      }
    }

    /** The markup layer the event is on, if any: the pen's, no one else's. */
    const layerOf = (event: PointerEvent): HTMLElement | null =>
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('[data-markup-page]')
        : null

    const onDown = (event: PointerEvent) => {
      const layer = layerOf(event)
      const page = layer ? Number(layer.dataset.markupPage) : NaN
      feed(
        event,
        {
          type: 'down',
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          page: Number.isInteger(page) ? page : null,
          primaryButton: event.pointerType !== 'mouse' || event.button === 0,
          at: performance.now(),
          lastScrollAt,
        },
        layer,
      )
      if (layer) event.stopPropagation()
    }
    const onMove = (event: PointerEvent) => {
      if (state.kind !== 'idle') {
        feed(event, { type: 'move', pointerId: event.pointerId }, null)
      }
      if (layerOf(event)) event.stopPropagation()
    }
    const onUp = (event: PointerEvent) => {
      feed(event, { type: 'up', pointerId: event.pointerId }, null)
      if (layerOf(event)) event.stopPropagation()
    }
    const onCancel = (event: PointerEvent) => {
      feed(event, { type: 'cancel', pointerId: event.pointerId }, null)
      if (layerOf(event)) event.stopPropagation()
    }
    const onScroll = () => {
      // The browser's scrolling only: the scroll that commits a two-finger
      // pan is the viewer's own, and a finger landing just after it is the
      // next stroke, not a fling being stopped.
      lastScrollAt = scrolledAt(
        lastScrollAt,
        ownScrollRef.current,
        { x: scroller.scrollLeft, y: scroller.scrollTop },
        performance.now(),
      )
    }
    const onFingers = (event: TouchEvent) => {
      const next = stepInput(state, {
        type: 'fingers',
        count: fingersOn(event.touches),
      })
      state = next.state
      if (next.effect === 'discard') discard()
    }
    // `touch-action: none` on the layer is what stops one finger scrolling;
    // this is the belt to those braces, for a WebKit that has not yet picked
    // up a `touch-action` changed a moment ago by entering markup mode. Only
    // while a stroke is being drawn, and only one-finger moves: two are the
    // scroller's, which cancels those itself.
    const onTouchMove = (event: TouchEvent) => {
      if (
        state.kind === 'drawing' &&
        event.touches.length === 1 &&
        event.cancelable
      ) {
        event.preventDefault()
      }
    }

    stage.addEventListener('pointerdown', onDown)
    stage.addEventListener('pointermove', onMove)
    stage.addEventListener('pointerup', onUp)
    stage.addEventListener('pointercancel', onCancel)
    stage.addEventListener('touchmove', onTouchMove, { passive: false })
    scroller.addEventListener('scroll', onScroll, { passive: true })
    // Capturing, so nothing on the way down can hide a finger from the count.
    const watch = { capture: true, passive: true } as const
    document.addEventListener('touchstart', onFingers, watch)
    document.addEventListener('touchend', onFingers, watch)
    document.addEventListener('touchcancel', onFingers, watch)
    return () => {
      stage.removeEventListener('pointerdown', onDown)
      stage.removeEventListener('pointermove', onMove)
      stage.removeEventListener('pointerup', onUp)
      stage.removeEventListener('pointercancel', onCancel)
      stage.removeEventListener('touchmove', onTouchMove)
      scroller.removeEventListener('scroll', onScroll)
      document.removeEventListener('touchstart', onFingers, watch)
      document.removeEventListener('touchend', onFingers, watch)
      document.removeEventListener('touchcancel', onFingers, watch)
      // Leaving markup mode mid-stroke (Escape, with the mouse still down)
      // throws the stroke away rather than saving half of it, and lets go
      // of the pointer so the next click lands where it is aimed.
      const left = stroke
      discard()
      try {
        if (left?.layer.hasPointerCapture(left.pointerId)) {
          left.layer.releasePointerCapture(left.pointerId)
        }
      } catch {
        // Already gone with the element.
      }
    }
  }, [enabled, stageRef, scrollerRef, ownScrollRef])
}

/** A pencil's touch, which iOS reports alongside its pointer events. */
export function isStylus(touch: Touch): boolean {
  return (touch as Touch & { touchType?: string }).touchType === 'stylus'
}

/** Fingers on the glass: every touch but a pencil's. */
function fingersOn(touches: TouchList): number {
  let count = 0
  for (let i = 0; i < touches.length; i++) {
    const touch = touches.item(i)
    if (touch && !isStylus(touch)) count++
  }
  return count
}
