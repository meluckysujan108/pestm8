import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { PenLine } from 'lucide-react'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import { SECONDARY_BUTTON_COMPACT } from '#/components/primitives/buttons'
import { SigningScreen } from '#/components/signature/SigningScreen'
import type { Drawn } from '#/components/signature/SigningScreen'
import { isOffline } from '#/lib/online'
import { keepSignature } from '#/lib/signature/kept'
import type { KeptSignature } from '#/lib/signature/kept'
import { useSignatureSaving } from './useSignatureSaving'

/**
 * Signing a report: the signing screen, and what Done does with what was
 * drawn there.
 *
 * Signing inline on the form went wrong three ways. The pad uploaded on every
 * pen lift, so a five-stroke signature was five uploads and five writes, any
 * of which could half-fail. A 128px strip between other questions is not
 * something anyone signs their name on. And handing the phone to a client
 * left them looking at the whole form, editable, with the statement they
 * were agreeing to somewhere above the fold.
 *
 * So: a screen of its own (`SigningScreen`) that shows the statement and a
 * pad worth signing on, and one Done that commits exactly once — and only if
 * the pen actually drew something. The drawing is kept on the phone first
 * (`kept.ts`), so a Done that cannot reach the server loses nothing: the
 * screen says so, and the report offers to save it later (`SignatureRow`).
 */
export function ReportSigning({
  open,
  onClose,
  businessId,
  reportId,
  slot,
  label,
  statement,
  askName,
  /** Whose signature this is, for the "use my saved one" offer. */
  ownSignature,
  templateVersion,
  onSigned,
}: {
  open: boolean
  onClose: () => void
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  slot: string
  label: string
  /** The words being agreed to, frozen with the signature. */
  statement?: string
  /** Client signatures are signed by a person who must say who they are. */
  askName?: boolean
  ownSignature: boolean
  /** The form's version being signed (`KeptSignature.templateVersion`). */
  templateVersion?: number
  onSigned: (signedAt: number) => void
}) {
  const [name, setName] = useState('')
  // Unset until the signer chooses: the default follows whether they have a
  // saved signature yet (below), which arrives after the screen opens.
  const [keepChoice, setKeepChoice] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<Failure | null>(null)

  // Every opening starts without the last one's failure or choice. The pad
  // itself is new each time: the screen is not drawn at all while closed.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setFailed(null)
      setKeepChoice(null)
    }
  }

  const { data: saved } = useQuery({
    ...convexQuery(api.reports.mySavedSignature, { businessId }),
    // Only ever offered for the signer's own slot: applying someone else's
    // saved signature is forgery with extra steps, however convenient.
    enabled: open && ownSignature,
  })
  // A first drawing is kept for next time unless they say not; a later one
  // replaces the saved signature only if they say so. Not known yet (no
  // signal), nothing is kept: a saved signature replaced without a word is
  // worse than one not saved.
  const keepMine = keepChoice ?? saved === null

  const { saveDrawn, applySaved } = useSignatureSaving({
    businessId,
    reportId,
    ownSignature,
  })

  async function done(drawn: Drawn) {
    setBusy(true)
    setFailed(null)
    const kept: KeptSignature = {
      reportId,
      slot,
      png: await drawn.png.arrayBuffer(),
      strokes: drawn.strokes,
      drawnAt: drawn.drawnAt,
      ...(templateVersion !== undefined ? { templateVersion } : {}),
      ...(name.trim() ? { signedBy: name.trim() } : {}),
      ...(statement ? { statement } : {}),
      keepAsMine: ownSignature && keepMine,
    }
    // On the phone before anything is sent: from here a failure loses
    // nothing. Not every browser can keep it (a private window), and then
    // the screen stays as it always did, the signature on the pad.
    const held = await keepSignature(kept)
    try {
      onSigned(await saveDrawn(kept))
      onClose()
    } catch {
      setFailed({ held, offline: isOffline() })
    } finally {
      setBusy(false)
    }
  }

  async function signWithSaved() {
    if (!saved) return
    setBusy(true)
    setFailed(null)
    try {
      onSigned(
        await applySaved({ slot, storageId: saved.storageId, statement }),
      )
      onClose()
    } catch {
      setFailed({ held: false, offline: isOffline() })
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <SigningScreen
      title={label}
      statement={statement}
      name={askName ? { value: name, onChange: setName } : undefined}
      busy={busy}
      error={failed ? failureText(failed) : undefined}
      keptOnPhone={failed?.held === true}
      extra={
        ownSignature
          ? (signed) =>
              signed ? (
                <label className="flex h-full min-w-0 items-center gap-2.5 text-body text-ink-2">
                  <input
                    type="checkbox"
                    checked={keepMine}
                    // Until it is known whether there is one to replace.
                    disabled={saved === undefined}
                    onChange={(event) => setKeepChoice(event.target.checked)}
                    className="size-4 shrink-0 accent-red"
                  />
                  <span className="truncate">
                    {saved
                      ? 'Replace my saved signature'
                      : 'Keep for next time'}
                  </span>
                </label>
              ) : saved ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void signWithSaved()}
                  className={`${SECONDARY_BUTTON_COMPACT} flex w-full min-w-0 items-center justify-center gap-2 px-3`}
                >
                  <PenLine size={16} strokeWidth={2} />
                  <span className="truncate">Use my saved signature</span>
                </button>
              ) : null
          : undefined
      }
      onDone={(drawn) => void done(drawn)}
      onClose={onClose}
    />
  )
}

/** Why the last Done did not save: was there signal, and is the drawing
 * kept on the phone? */
type Failure = { held: boolean; offline: boolean }

function failureText({ held, offline }: Failure): string {
  if (held) {
    return offline
      ? 'No signal. The signature is kept on this phone: tap Done when you have signal, or save it from the report later.'
      : 'Could not save the signature. It is kept on this phone: tap Done again, or save it from the report later.'
  }
  return offline
    ? 'No signal. Tap Done again when you have signal.'
    : 'Could not save the signature. Check your signal and tap Done again.'
}
