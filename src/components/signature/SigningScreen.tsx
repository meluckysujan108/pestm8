import { useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties, ReactNode, SyntheticEvent } from 'react'
import { Dialog } from 'radix-ui'
import { useBlocker, useRouter } from '@tanstack/react-router'
import { RotateCcw, Trash2 } from 'lucide-react'
import {
  PRIMARY_BUTTON_COMPACT,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'
import { SheetCloseButton } from '#/components/primitives/Sheet'
import { FIELD } from '#/components/forms/FormField'
import { turnsForSigning } from '#/lib/signature/ink'
import type { StrokesFile } from '#/lib/signature/ink'
import { SignaturePad } from './SignaturePad'
import type { SignaturePadHandle } from './SignaturePad'

/** What Done hands over: the image, the strokes it was drawn from, and when. */
export type Drawn = { png: Blob; strokes: StrokesFile; drawnAt: number }

/**
 * Signing, on the whole screen.
 *
 * The pad used to sit in a sheet, and a sheet is something a downward swipe
 * closes: the first downward stroke of a signature dragged it, pad and line
 * and all, and a quick one closed it with the ink. It was also as wide as the
 * sheet and 224 points tall. Here nothing moves but the pen.
 *
 * On a phone held upright the screen is laid out a quarter turn round
 * (`turnsForSigning`), so it reads the right way up with the phone turned on
 * its side and the signature gets the long side of the screen: a signature
 * is wide, and an iPhone cannot be made to turn its screen for a web app, nor
 * will it with its rotation lock on. A phone already on its side, a tablet
 * and a computer get it as it is. So does a pad that asks the signer's name:
 * the keyboard rises along the phone's own bottom edge, turned or not.
 *
 * It is a full-screen layer (`z-[80]`, with the document viewer), so it asks
 * before throwing a signature away in place rather than through
 * `ConfirmDialog`, which would open behind it: on ✕, on Escape, and on the
 * phone's Back.
 */
export function SigningScreen({
  title,
  statement,
  name,
  busy,
  error,
  keptOnPhone = false,
  extra,
  onDone,
  onClose,
}: {
  /** What is being signed: "Technician's Signature". */
  title: string
  /** The words being agreed to, shown above the pad. */
  statement?: string
  /** Asks who is signing — on an upright screen, where the keyboard fits. */
  name?: { value: string; onChange: (value: string) => void }
  /** Saving: Done says so, and nothing closes the screen until it is over. */
  busy: boolean
  /** Why the last Done did not save. */
  error?: ReactNode
  /**
   * What the last Done tried to save is kept on the phone (`kept.ts`): while
   * the pad still holds just that, closing loses nothing and is not asked
   * about.
   */
  keptOnPhone?: boolean
  /**
   * The slot beside Done — a saved signature to use, or the choice to keep
   * this one — given whether the pad holds a signature. It is the same size
   * whatever is in it, so nothing moves as the first stroke lands.
   */
  extra?: (signed: boolean) => ReactNode
  /**
   * The pad's signature as a PNG cut to its ink, with its strokes, and the
   * moment Done was tapped — the time it was signed, however late it saves.
   */
  onDone: (drawn: Drawn) => void
  /** Closed without a signature: ✕, Escape or Back, or Discard. */
  onClose: () => void
}) {
  const pad = useRef<SignaturePadHandle>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const [root, setRoot] = useState<HTMLElement | null>(null)
  const [ink, setInk] = useState({ signed: false, marked: false })
  const [asking, setAsking] = useState<'close' | 'back' | null>(null)
  const [exporting, setExporting] = useState(false)
  const [unreadable, setUnreadable] = useState(false)
  // When the last Done was tapped, while the pad has not changed since: a
  // second Done on the same drawing is the same signature, signed then, and
  // only that drawing is the one kept on the phone.
  const [doneAt, setDoneAt] = useState<number | null>(null)
  const kept = keptOnPhone && doneAt !== null
  const back = useRef<{ proceed: () => void; reset: () => void } | null>(null)
  const turned = useTurned(name !== undefined)
  // Drawn where there is no router too: the UI harness.
  const router = useRouter({ warn: false }) as
    ReturnType<typeof useRouter> | undefined
  // Focus goes back to what opened the screen — the row's Sign button —
  // when it closes, however it closes.
  const [returnTo] = useState(() =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  )
  useBodyLock(root)

  /** Saving, or drawing the image to save: nothing else may happen. */
  const working = busy || exporting

  /** ✕ or Escape: asks first if there is a signature to lose. */
  function requestClose() {
    if (working) return
    if (ink.signed && !kept) setAsking('close')
    else onClose()
  }

  function keep() {
    if (asking === 'back') back.current?.reset()
    back.current = null
    setAsking(null)
  }

  function discard() {
    const pending = asking === 'back' ? back.current : null
    back.current = null
    setAsking(null)
    if (!pending) {
      onClose()
      return
    }
    // Back goes on; a screen opened from state rather than the address is
    // still open on the page Back lands on, so it is closed once the move
    // has landed.
    const stop = router?.subscribe('onResolved', () => {
      stop?.()
      onClose()
    })
    pending.proceed()
  }

  // Back from the question to the screen: focus on its ✕, not lost.
  const wasAsking = useRef(false)
  useEffect(() => {
    if (wasAsking.current && asking === null) closeRef.current?.focus()
    wasAsking.current = asking !== null
  }, [asking])

  async function done() {
    if (working) return
    // Drawing the saved image takes a moment before Saving… shows: a second
    // tap on Done, or ✕, in that moment would have saved it twice or offered
    // to discard what was already on its way.
    setExporting(true)
    setUnreadable(false)
    try {
      const drawnAt = doneAt ?? Date.now()
      const saved = await pad.current?.save()
      if (saved) {
        setDoneAt(drawnAt)
        onDone({ ...saved, drawnAt })
      } else {
        setUnreadable(true)
      }
    } finally {
      setExporting(false)
    }
  }

  const nameMissing = name !== undefined && name.value.trim() === ''
  const problem = unreadable
    ? 'Could not read the signature. Tap Done again.'
    : error

  return (
    <Dialog.Root open onOpenChange={(open) => !open && requestClose()}>
      <Dialog.Portal>
        <Dialog.Content
          ref={setRoot}
          aria-modal="true"
          onOpenAutoFocus={(event) => {
            // Focus stays off the name field, so a keyboard does not rise
            // over the pad on its own.
            event.preventDefault()
            closeRef.current?.focus()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (returnTo?.isConnected) returnTo.focus()
          }}
          // Full screen, so "outside" is only ever something layered over it.
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            if (asking) keep()
            else requestClose()
          }}
          // Portalled, but React events still bubble to whatever rendered it
          // — a field's label, a section. They stop here.
          onClick={stopBubbling}
          onPointerDown={stopBubbling}
          onPointerUp={stopBubbling}
          onTouchStart={stopBubbling}
          onTouchEnd={stopBubbling}
          className="fixed z-[80] flex flex-col bg-canvas text-ink outline-none"
          style={turned ? TURNED : UPRIGHT}
        >
          <div className="flex min-h-0 flex-1 flex-col" inert={asking !== null}>
            <div className="relative px-4 pr-14 pt-4">
              <Dialog.Title className="text-sheet-title text-ink">
                {title}
              </Dialog.Title>
              {statement ? (
                <Dialog.Description
                  data-signing-scroll
                  // On its side the screen is short, so three lines and the
                  // rest a scroll away; upright, a quarter of the screen.
                  className={`mt-1 overflow-y-auto text-caption text-ink-2 ${turned ? 'max-h-[3lh]' : 'max-h-[25dvh]'}`}
                >
                  {statement}
                </Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">
                  Sign with a finger or a stylus, then tap Done.
                </Dialog.Description>
              )}
              <SheetCloseButton ref={closeRef} onClick={requestClose} />
            </div>

            {name && (
              <label className="mx-4 mt-2 flex flex-col gap-1.5">
                <span className="section-label">Name</span>
                <input
                  value={name.value}
                  onChange={(event) => name.onChange(event.target.value)}
                  onKeyDown={(event) => {
                    // Return puts the keyboard away, uncovering the pad
                    // and Done — not a tap on the pad, which would be ink.
                    if (event.key === 'Enter') event.currentTarget.blur()
                  }}
                  autoComplete="name"
                  enterKeyHint="done"
                  placeholder="Who is signing"
                  className={FIELD}
                />
              </label>
            )}

            {/* Paper in both themes: what is drawn here is printed on white. */}
            <div
              data-theme="light"
              className="relative mx-4 my-3 min-h-32 flex-1 overflow-hidden rounded-xl border border-hairline bg-paper"
            >
              {/* The line a signature goes on, as on a paper form. A typed ×,
                  not the ✕ glyph, which means close everywhere else. */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-6 bottom-[26%] border-b border-muted pb-0.5 text-body text-muted"
              >
                ×
              </div>
              <p
                aria-hidden
                className={`pointer-events-none absolute inset-x-6 bottom-[26%] translate-y-full pt-1.5 text-caption text-muted transition-opacity ${ink.marked ? 'opacity-0' : ''}`}
              >
                Sign above the line
              </p>
              <SignaturePad
                ref={pad}
                label={title}
                turned={turned}
                onChange={setInk}
                onEdit={() => setDoneAt(null)}
              />
              {/* Over the pad rather than above it: a line coming and going
                  would change the pad's size under the signature. */}
              {problem && (
                <p
                  role="alert"
                  className="pointer-events-none absolute inset-x-3 top-3 z-10 rounded-xl border border-hairline bg-surface px-3 py-2 text-caption text-amber-ink"
                >
                  {problem}
                </p>
              )}
            </div>

            <div className="flex items-center gap-2 px-4 pb-3">
              <button
                type="button"
                aria-label="Clear the signature"
                disabled={!ink.marked || working}
                onClick={() => pad.current?.clear()}
                className={`${SECONDARY_BUTTON_COMPACT} flex w-11 shrink-0 items-center justify-center`}
              >
                <Trash2 size={15} strokeWidth={2} />
              </button>
              <button
                type="button"
                aria-label="Undo the last stroke"
                disabled={!ink.marked || working}
                onClick={() => pad.current?.undo()}
                className={`${SECONDARY_BUTTON_COMPACT} flex w-11 shrink-0 items-center justify-center`}
              >
                <RotateCcw size={15} strokeWidth={2} />
              </button>
              <div className="flex h-11 min-w-0 flex-1 items-center">
                {extra?.(ink.signed)}
              </div>
              <button
                type="button"
                // Nothing drawn is not a signature, and a disabled Done says
                // so more honestly than accepting a blank image would.
                disabled={!ink.signed || working || nameMissing}
                onClick={() => void done()}
                className={`${PRIMARY_BUTTON_COMPACT} shrink-0 px-6`}
              >
                {busy ? 'Saving…' : 'Done'}
              </button>
            </div>
          </div>

          {asking && <DiscardSignature onKeep={keep} onDiscard={discard} />}
          {/* The phone's Back, while there is a signature to lose. */}
          {router && ink.signed && !working && !kept && (
            <BackGuard
              onBlocked={(pending) => {
                back.current = pending
                setAsking('back')
              }}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * The screen as it is: the whole window, inside its safe areas.
 */
const UPRIGHT: CSSProperties = {
  inset: 0,
  paddingTop: 'env(safe-area-inset-top)',
  paddingRight: 'env(safe-area-inset-right)',
  paddingBottom: 'env(safe-area-inset-bottom)',
  paddingLeft: 'env(safe-area-inset-left)',
}

/**
 * The screen a quarter turn round: as wide as the window is tall and as tall
 * as it is wide, hung from the window's top-right corner and turned clockwise
 * about it — so its top runs down the right edge, which is the top once the
 * phone is turned anticlockwise onto its side. Sized by the window in CSS,
 * not in script, so a page left pinch-zoomed does not shrink it. The safe
 * areas turn with it: the notch is the turned screen's left, the home bar its
 * right.
 */
const TURNED: CSSProperties = {
  top: 0,
  left: '100%',
  width: '100dvh',
  height: '100dvw',
  transform: 'rotate(90deg)',
  transformOrigin: 'top left',
  paddingTop: 'env(safe-area-inset-right)',
  paddingRight: 'env(safe-area-inset-bottom)',
  paddingBottom: 'env(safe-area-inset-left)',
  paddingLeft: 'env(safe-area-inset-top)',
}

/**
 * Whether the screen is laid out turned, decided again as the phone turns.
 * From the layout's size (`clientWidth`), not the window's visible part
 * (`innerWidth`), which a pinch-zoom shrinks.
 */
function useTurned(upright: boolean): boolean {
  const [turned, setTurned] = useState(readTurned)
  useEffect(() => {
    const update = () => setTurned(readTurned())
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
    }
  }, [])
  return turned && !upright
}

function readTurned(): boolean {
  const { clientWidth, clientHeight } = document.documentElement
  return turnsForSigning(
    { width: clientWidth, height: clientHeight },
    { width: window.screen.width, height: window.screen.height },
  )
}

/**
 * The page under the screen holds still. Overflow stops it scrolling on a
 * computer and Android; on iOS a fixed layer can still drag the page behind
 * it — or rubber-band itself — from anywhere that does not scroll, so a
 * one-finger move outside the statement and the name is cancelled too. The
 * pad cancels its own (`touch-none`). Two fingers are let through: a page
 * left pinch-zoomed can be pinched back out.
 */
function useBodyLock(root: HTMLElement | null) {
  useEffect(() => {
    if (!root) return
    const { documentElement: html, body } = document
    const previous = [html.style.overflow, body.style.overflow]
    html.style.overflow = 'hidden'
    body.style.overflow = 'hidden'
    const onTouchMove = (event: TouchEvent) => {
      if (!event.cancelable || event.touches.length > 1) return
      const target = event.target
      if (
        target instanceof Element &&
        target.closest('[data-signing-scroll], input')
      ) {
        return
      }
      event.preventDefault()
    }
    root.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => {
      html.style.overflow = previous[0]
      body.style.overflow = previous[1]
      root.removeEventListener('touchmove', onTouchMove)
    }
  }, [root])
}

function stopBubbling(event: SyntheticEvent) {
  event.stopPropagation()
}

/**
 * "Discard this signature?", asked in place: this screen sits above the
 * app's dialogs. The screen behind it is inert while it asks.
 */
function DiscardSignature({
  onKeep,
  onDiscard,
}: {
  onKeep: () => void
  onDiscard: () => void
}) {
  const titleId = useId()
  const bodyId = useId()
  const keepRef = useRef<HTMLButtonElement>(null)
  useEffect(() => keepRef.current?.focus(), [])
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-scrim px-6">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="w-[min(92%,380px)] rounded-2xl bg-canvas p-4 shadow-elevation"
      >
        <h3 id={titleId} className="text-row-title text-ink">
          Discard this signature?
        </h3>
        <p id={bodyId} className="mt-1.5 text-body text-ink-2">
          What you drew hasn’t been saved. Discarding leaves the report as it
          was.
        </p>
        <div className="mt-4 flex gap-2">
          <button
            ref={keepRef}
            type="button"
            onClick={onKeep}
            className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
          >
            Keep signing
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className={`${PRIMARY_BUTTON_COMPACT} flex-1`}
          >
            Discard
          </button>
        </div>
      </div>
    </div>
  )
}

function blockBack({ action }: { action: string }) {
  return action === 'BACK' || action === 'FORWARD' || action === 'GO'
}

/**
 * The phone's Back, caught only as Back, while a signature is on the pad. It
 * hands the waiting move to the screen, which asks: Keep signing undoes it,
 * Discard lets it go on.
 */
function BackGuard({
  onBlocked,
}: {
  onBlocked: (pending: { proceed: () => void; reset: () => void }) => void
}) {
  const blocker = useBlocker({
    shouldBlockFn: blockBack,
    withResolver: true,
    // A reload is deliberate, and the browser's own "Leave site?" box is
    // not this app's.
    enableBeforeUnload: false,
  })
  // The latest of each, read once the move is caught.
  const latest = useRef({ blocker, onBlocked })
  useEffect(() => {
    latest.current = { blocker, onBlocked }
  })
  useEffect(() => {
    const current = latest.current.blocker
    if (current.status !== 'blocked') return
    latest.current.onBlocked({
      proceed: current.proceed,
      reset: current.reset,
    })
  }, [blocker.status])
  return null
}
