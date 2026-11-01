import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { emailKeys, nameKey, phoneKeys } from '../../../convex/lib/contactKeys'
import { FIX_ARM_MS, stillArmed } from '#/components/forms/saveWarningRules'
import type { FieldFix } from '#/components/forms/FieldMessage'

/** The fields of New client whose value may say who the caller is, as they
 * are left. */
export type NewClientMatchField = 'clientName' | 'phone' | 'email'

/** The line under one of them: who already has what was typed, with up to
 * two fixes ("Book at 12 Wattle St"; "Show them" · "New site for Ray White
 * Bayswater"). */
export type NewClientMatchLine = {
  text: string
  fix?: FieldFix
  fix2?: FieldFix
}

/** What the line is decided from: the three fields as they are now. */
export type MatchLineValues = Record<NewClientMatchField, string>

/**
 * What a field's line is decided by: its match keys (`phoneKeys`,
 * `emailKeys`, `nameKey`), so the same number or email written another way
 * ("0491570161", then PhoneInput's own "Use 0491 570 161") is the same, and
 * keeps its line. Where there are none, what was typed.
 */
export function matchKeyOf(
  field: NewClientMatchField,
  value: string,
  areaCode: string,
): string {
  const keys =
    field === 'phone'
      ? phoneKeys(value, areaCode)
      : field === 'email'
        ? emailKeys(value)
        : [nameKey(value)].filter((key) => key !== '')
  return keys.length > 0 ? `k:${keys.join(',')}` : `v:${value.trim()}`
}

/** Something on screen whose place can be read, and whose scrolling
 * ancestors can be found: an element, or a test's stand-in. */
export type Placed = {
  getBoundingClientRect: () => { top: number }
  parentElement: Placed | null
  scrollTop?: number
  scrollHeight?: number
  clientHeight?: number
}

/** The nearest ancestor that scrolls (a sheet's body), else the page. */
function scrollerOf(el: Placed): Placed | null {
  const style = typeof getComputedStyle === 'function' ? getComputedStyle : null
  for (let at = el.parentElement; at; at = at.parentElement) {
    const overflow = style?.(at as unknown as Element).overflowY
    if (
      (overflow === 'auto' || overflow === 'scroll') &&
      (at.scrollHeight ?? 0) > (at.clientHeight ?? 0)
    ) {
      return at
    }
  }
  return typeof document === 'undefined' ? null : document.scrollingElement
}

/**
 * Keeps `el` where it was on screen (`before`, its top then) as something
 * goes in above it: what scrolls it is scrolled by as much as it moved, so a
 * field just tapped stays under the thumb that tapped it and the line goes
 * in above, where the field left was. Before the browser paints, so nothing
 * is seen to move.
 */
export function keepInPlace(el: Placed, before: number): void {
  const moved = el.getBoundingClientRect().top - before
  if (Math.abs(moved) < 1) return
  const scroller = scrollerOf(el)
  if (scroller) scroller.scrollTop = (scroller.scrollTop ?? 0) + moved
}

type Shown = {
  /** What the field held as it was decided, and its keys (`keyOf`). */
  said: string
  keys: string
  line: NewClientMatchLine
  at: number
}

/** What a line's fixes are, by their labels: the same fixes, or others. */
function fixesOf(line: NewClientMatchLine): string {
  return JSON.stringify([line.fix?.label ?? null, line.fix2?.label ?? null])
}

/** Where focus is now, if there is a page. */
function focused(): Placed | null {
  return typeof document === 'undefined' ? null : document.activeElement
}

/**
 * The lines under Name, Phone and Email (NewClientFields): each decided as
 * its field is left for another field, shown while the field holds what it
 * was decided for: the same keys (`keyOf`, `matchKeyOf`), so a tidier way of
 * writing the same number keeps it, said again as the number now reads.
 * The lines under Phone and Email rest on the Name too (whether it agrees
 * makes a fix one tap, or only Show them), so they are decided again as the
 * Name is changed to another.
 *
 * Nothing moves under a thumb (the matching plan's RK14): the field focus
 * is in is kept where it was on screen as a line goes in above it, or goes,
 * or is said again (`keepInPlace`), and a line's fixes take no tap for
 * FIX_ARM_MS after it came in (`held`, for their `aria-disabled`), as the
 * panel's do.
 *
 * Without `matchLine` (the client list not read yet, in Clients → New
 * client), a field left is remembered, and its line is decided once
 * `matchLine` comes, if the field still holds what was left in it.
 */
export function useMatchLines(
  values: MatchLineValues,
  matchLine:
    | ((
        field: NewClientMatchField,
        values: MatchLineValues,
      ) => NewClientMatchLine | null)
    | undefined,
  keyOf: (field: NewClientMatchField, value: string) => string = (_, v) => v,
): {
  lineOf: (field: NewClientMatchField) => NewClientMatchLine | null
  /** `field` left for another field, `next` (where focus went). */
  leaving: (field: NewClientMatchField, next: Placed | null) => void
  /** `field` is about to hold `next`. */
  changing: (field: NewClientMatchField, next: string) => void
} {
  const [lines, setLines] = useState<
    Partial<Record<NewClientMatchField, Shown>>
  >({})
  // Fields left before there was anything to decide their line from, with
  // what they held then.
  const waiting = useRef<Partial<Record<NewClientMatchField, string>>>({})
  // Where focus was on screen before a line went in above it.
  const anchor = useRef<{ el: Placed; top: number } | null>(null)
  // A line came in, and its fixes are held: drawn again once they aren't.
  const [heldSince, setHeldSince] = useState<number | null>(null)
  const latestValues = useRef(values)
  latestValues.current = values
  const latestMatchLine = useRef(matchLine)
  latestMatchLine.current = matchLine
  const latestKeyOf = useRef(keyOf)
  latestKeyOf.current = keyOf

  const hold = (el: Placed | null | undefined) => {
    anchor.current = el ? { el, top: el.getBoundingClientRect().top } : null
  }

  const show = (found: Partial<Record<NewClientMatchField, Shown | null>>) => {
    const at = Date.now()
    setLines((before) => {
      const next = { ...before }
      for (const [field, line] of Object.entries(found)) {
        next[field as NewClientMatchField] = line ?? undefined
      }
      return next
    })
    if (Object.values(found).some(Boolean)) setHeldSince(at)
  }

  const decide = (field: NewClientMatchField, decideWith = matchLine) => {
    const said = latestValues.current[field]
    const line = decideWith?.(field, latestValues.current) ?? null
    return line
      ? { said, keys: keyOf(field, said), line, at: Date.now() }
      : null
  }

  function leaving(field: NewClientMatchField, next: Placed | null) {
    if (!matchLine) {
      waiting.current[field] = values[field]
      return
    }
    const line = decide(field)
    // Only a line going in moves anything.
    hold(line ? next : null)
    show({ [field]: line })
  }

  function changing(field: NewClientMatchField, next: string) {
    const keys = keyOf(field, next)
    const left = waiting.current[field]
    if (left !== undefined && keyOf(field, left) !== keys) {
      delete waiting.current[field]
    }
    const now = { ...latestValues.current, [field]: next }
    const found: Partial<Record<NewClientMatchField, Shown | undefined>> = {}
    const shown = lines[field]
    if (shown && shown.said !== next) {
      // The same number or email, written another way: the line stays,
      // said again as it now reads, its fixes held only as long as they
      // were. Anything else, and it goes.
      const line =
        keys === shown.keys ? (matchLine?.(field, now) ?? null) : null
      found[field] = line ? { said: next, keys, line, at: shown.at } : undefined
    }
    // Another name: the lines under Phone and Email were decided with the
    // name as it was, and whether it agrees is what makes a fix one tap (a
    // mobile on one client's record with no name agreeing is only shown:
    // Show them). They are decided again with the name as it is now: kept,
    // said again, or gone. A fix that changed takes no tap for as long as a
    // new line's doesn't.
    let fresh = false
    if (
      field === 'clientName' &&
      keys !== keyOf('clientName', latestValues.current.clientName)
    ) {
      for (const other of ['phone', 'email'] as const) {
        const was = lines[other]
        if (!was || keyOf(other, now[other]) !== was.keys) continue
        const line = matchLine?.(other, now) ?? null
        const same = line !== null && fixesOf(line) === fixesOf(was.line)
        // Said as it was: nothing to draw again.
        if (same && line.text === was.line.text) continue
        if (line !== null && !same) fresh = true
        found[other] = line
          ? {
              said: now[other],
              keys: was.keys,
              line,
              at: same ? was.at : Date.now(),
            }
          : undefined
      }
    }
    if (Object.keys(found).length === 0) return
    // Whatever goes, or is said again, focus stays where it is on screen.
    hold(focused())
    setLines((before) => ({ ...before, ...found }))
    if (fresh) setHeldSince(Date.now())
  }

  // The client list has come: the fields left meanwhile get their lines now,
  // if they still hold what was left in them.
  const ready = matchLine !== undefined
  useEffect(() => {
    if (!ready) return
    const left = waiting.current
    waiting.current = {}
    const found: Partial<Record<NewClientMatchField, Shown | null>> = {}
    for (const [field, said] of Object.entries(left)) {
      const key = field as NewClientMatchField
      const keyOfNow = latestKeyOf.current
      if (keyOfNow(key, latestValues.current[key]) !== keyOfNow(key, said)) {
        continue
      }
      found[key] = decide(key, latestMatchLine.current)
    }
    if (!Object.values(found).some(Boolean)) return
    hold(focused())
    show(found)
    // `decide` and `show` read the latest values through refs.
  }, [ready])

  // As the line is drawn, before it is painted: focus stays where it was.
  useLayoutEffect(() => {
    const at = anchor.current
    anchor.current = null
    if (at) keepInPlace(at.el, at.top)
  }, [lines])

  useEffect(() => {
    if (heldSince === null) return
    const left = Math.max(0, FIX_ARM_MS - (Date.now() - heldSince))
    const done = setTimeout(() => setHeldSince(null), left)
    return () => clearTimeout(done)
  }, [heldSince])

  const held = (fix: FieldFix | undefined, since: number) =>
    fix && {
      label: fix.label,
      held: heldSince !== null && stillArmed(since, Date.now(), FIX_ARM_MS),
      onApply: () => {
        // Just came in, where a thumb may still be: a tap now is not a
        // choice.
        if (stillArmed(since, Date.now(), FIX_ARM_MS)) return
        fix.onApply()
      },
    }

  function lineOf(field: NewClientMatchField): NewClientMatchLine | null {
    const shown = lines[field]
    if (!shown || keyOf(field, values[field]) !== shown.keys) return null
    const fix = held(shown.line.fix, shown.at)
    const fix2 = held(shown.line.fix2, shown.at)
    return {
      text: shown.line.text,
      ...(fix ? { fix } : {}),
      ...(fix2 ? { fix2 } : {}),
    }
  }

  return { lineOf, leaving, changing }
}
