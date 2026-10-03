import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { Check, CircleAlert, PenLine } from 'lucide-react'
import { ReportSigning } from './ReportSigning'
import { useSignatureSaving } from './useSignatureSaving'
import { api } from '../../../../convex/_generated/api'
import { useHydrated } from '#/lib/useHydrated'
import type { Id } from '../../../../convex/_generated/dataModel'
import {
  SECONDARY_BUTTON,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'
import { formatWhen } from '#/lib/format'
import { isOffline } from '#/lib/online'
import { forgetSignature, keptSignature } from '#/lib/signature/kept'
import type { KeptSignature } from '#/lib/signature/kept'
import { useBusinessTimezone } from '#/lib/useBusinessTimezone'

/**
 * A signature in the form: what was signed, or the way to sign it.
 *
 * The pad itself has a screen of its own — see `ReportSigning` for why — so what stays on
 * the form is the evidence: the signature as an image once there is one, and
 * one button when there is not. Two more things it may say:
 *
 * - A technician with a saved signature signs their own slot with one tap —
 *   never automatically: each report is signed on purpose — or draws instead.
 * - A drawing this phone kept because it could not be saved (`kept.ts`) is
 *   shown here until it is saved or discarded. One the report has a newer
 *   signature than is forgotten: it was saved after all, or signed again.
 */
export function SignatureRow({
  businessId,
  reportId,
  slot,
  label,
  statement,
  askName,
  ownSignature,
  signedAt,
  onSigned,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  slot: string
  label: string
  statement?: string
  askName?: boolean
  ownSignature: boolean
  signedAt?: number
  onSigned: (signedAt: number | undefined) => void
}) {
  const [signing, setSigning] = useState(false)
  const hydrated = useHydrated()
  const timezone = useBusinessTimezone()

  const { data: urls } = useQuery(
    convexQuery(api.reports.signatureUrls, { businessId, reportId }),
  )
  const existing = urls?.[slot]

  const { data: saved } = useQuery({
    ...convexQuery(api.reports.mySavedSignature, { businessId }),
    enabled: hydrated && ownSignature,
  })
  const { saveDrawn, applySaved } = useSignatureSaving({
    businessId,
    reportId,
    ownSignature,
  })
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  // A drawing kept on this phone for this slot, read again each time the
  // signing screen closes: that is when one may have been left behind.
  const [waiting, setWaiting] = useState<KeptSignature | null>(null)
  useEffect(() => {
    if (!hydrated || signing) return
    let live = true
    void keptSignature(reportId, slot).then((kept) => {
      if (!live) return
      if (kept && signedAt !== undefined && kept.drawnAt <= signedAt) {
        // The report holds one at least as new: this one is done with.
        void forgetSignature(reportId, slot)
        setWaiting(null)
        return
      }
      setWaiting(kept)
    })
    return () => {
      live = false
    }
  }, [hydrated, signing, reportId, slot, signedAt])

  const waitingUrl = useObjectUrl(waiting?.png)
  const [discarding, setDiscarding] = useState(false)

  async function run(work: () => Promise<number>) {
    setBusy(true)
    setProblem(null)
    try {
      onSigned(await work())
      setWaiting(null)
    } catch {
      setProblem(
        isOffline()
          ? 'No signal. Try again when you have signal.'
          : 'Could not save the signature. Try again in a moment.',
      )
    } finally {
      setBusy(false)
    }
  }

  const offerSaved = ownSignature && saved && !existing && !waiting

  return (
    <span className="flex flex-col gap-2">
      {existing && (
        <img
          src={existing}
          alt={`${label} — signed`}
          // Paper: a signature is dark ink on a transparent PNG.
          className="h-24 w-full rounded-xl border border-hairline bg-paper object-contain"
        />
      )}

      {waiting && (
        <span className="flex flex-col gap-2 rounded-xl border border-amber-line bg-amber-bg p-3">
          {waitingUrl && (
            <img
              src={waitingUrl}
              alt={`${label} — not saved yet`}
              className="h-24 w-full rounded-lg border border-hairline bg-paper object-contain"
            />
          )}
          <span className="flex items-start gap-1.5 text-caption text-amber-ink">
            <CircleAlert size={14} strokeWidth={2} className="mt-px shrink-0" />
            <span>
              Not saved yet. Drawn on this phone{' '}
              {formatWhen(waiting.drawnAt, timezone)}, and kept here until it
              is.
            </span>
          </span>
          <span className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => saveDrawn(waiting))}
              className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
            >
              {busy ? 'Saving…' : 'Save it'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setDiscarding(true)}
              className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
            >
              Discard
            </button>
          </span>
        </span>
      )}

      {offerSaved ? (
        <>
          <button
            type="button"
            disabled={!hydrated || busy}
            onClick={() =>
              void run(() =>
                applySaved({ slot, storageId: saved.storageId, statement }),
              )
            }
            className={`${SECONDARY_BUTTON} flex items-center justify-center gap-2`}
          >
            <PenLine size={16} strokeWidth={2} />
            {busy ? 'Signing…' : 'Sign with my saved signature'}
          </button>
          <button
            type="button"
            disabled={!hydrated || busy}
            aria-label={`${label} — draw instead`}
            onClick={() => setSigning(true)}
            className={SECONDARY_BUTTON_COMPACT}
          >
            Draw instead
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={!hydrated || busy}
          // Named by which signature it is: a form with a technician's and a
          // client's pad has two of these, and "Sign" alone says nothing about
          // whose name is going on the document.
          aria-label={
            existing ? `${label} — signed, sign again` : `${label} — sign`
          }
          onClick={() => setSigning(true)}
          className={`${SECONDARY_BUTTON} flex items-center justify-center gap-2`}
        >
          {existing ? (
            <>
              <Check size={16} strokeWidth={2.2} className="text-green" />
              Signed — sign again
            </>
          ) : (
            <>
              <PenLine size={16} strokeWidth={2} />
              Sign
            </>
          )}
        </button>
      )}

      {problem && (
        <span role="alert" className="text-caption text-amber-ink">
          {problem}
        </span>
      )}

      <ReportSigning
        open={signing}
        onClose={() => setSigning(false)}
        businessId={businessId}
        reportId={reportId}
        slot={slot}
        label={label}
        statement={statement}
        askName={askName}
        ownSignature={ownSignature}
        onSigned={onSigned}
      />

      <ConfirmDialog
        open={discarding}
        onOpenChange={setDiscarding}
        title="Discard this signature?"
        body="It was never saved to the report, and it can’t be got back."
        confirm="Discard"
        onConfirm={() => {
          void forgetSignature(reportId, slot)
          setWaiting(null)
        }}
      />

      {signedAt !== undefined && !existing && !waiting && (
        // The answers say this was signed but storage has no image: a report
        // in this state cannot be finalised, and saying so beats a silent gap.
        <span role="alert" className="text-caption text-amber-ink">
          This signature did not save. Sign again before finalising.
        </span>
      )}
    </span>
  )
}

/** A URL for bytes kept on the phone, for as long as they are shown. */
function useObjectUrl(bytes: ArrayBuffer | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!bytes) {
      setUrl(null)
      return
    }
    const next = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [bytes])
  return url
}
