import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { PenLine } from 'lucide-react'
import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import { SECONDARY_BUTTON_COMPACT } from '#/components/primitives/buttons'
import { SigningScreen } from '#/components/signature/SigningScreen'

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
 * pad worth signing on, and one Done that commits exactly once — one upload,
 * one mutation, and only if the pen actually drew something.
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
  onSigned: (signedAt: number) => void
}) {
  const [name, setName] = useState('')
  const [keepMine, setKeepMine] = useState(true)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  // Every opening starts without the last one's failure. The pad itself is
  // new each time: the screen is not drawn at all while closed.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setFailed(false)
  }

  const { data: saved } = useQuery({
    ...convexQuery(api.reports.mySavedSignature, { businessId }),
    // Only ever offered for the signer's own slot: applying someone else's
    // saved signature is forgery with extra steps, however convenient.
    enabled: open && ownSignature,
  })

  const getUploadUrl = useConvexMutation(api.reports.generateUploadUrl)
  const convexAttach = useConvexMutation(api.reports.attachSignature)
  const attach = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      reportId: Id<'reports'>
      storageId: Id<'_storage'>
      slot: string
      signedBy?: string
      statement?: string
      method?: 'drawn' | 'saved'
      saveForMember?: boolean
    }) => convexAttach(args),
  })

  async function commit(storageId: Id<'_storage'>, method: 'drawn' | 'saved') {
    await attach.mutateAsync({
      businessId,
      reportId,
      storageId,
      slot,
      method,
      ...(name.trim() ? { signedBy: name.trim() } : {}),
      ...(statement ? { statement } : {}),
      // Saving it is the signer's own choice, and only ever their own.
      ...(method === 'drawn' && ownSignature && keepMine
        ? { saveForMember: true }
        : {}),
    })
    onSigned(Date.now())
    onClose()
  }

  async function done(png: Blob) {
    setBusy(true)
    setFailed(false)
    try {
      // One upload, one write — the whole reason signing has a Done rather
      // than a pad that commits on every pen lift.
      const uploadUrl = await getUploadUrl({ businessId })
      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: png,
      })
      if (!res.ok) throw new Error('upload failed')
      const { storageId } = (await res.json()) as { storageId: Id<'_storage'> }
      await commit(storageId, 'drawn')
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  async function useSaved() {
    if (!saved) return
    setBusy(true)
    setFailed(false)
    try {
      await commit(saved.storageId, 'saved')
    } catch {
      setFailed(true)
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
      error={
        failed
          ? 'Could not save the signature. Check your signal and tap Done again.'
          : undefined
      }
      extra={
        ownSignature
          ? (signed) =>
              signed ? (
                <label className="flex h-full min-w-0 items-center gap-2.5 text-body text-ink-2">
                  <input
                    type="checkbox"
                    checked={keepMine}
                    onChange={(event) => setKeepMine(event.target.checked)}
                    className="size-4 shrink-0 accent-red"
                  />
                  <span className="truncate">Save this as my signature</span>
                </label>
              ) : saved ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void useSaved()}
                  className={`${SECONDARY_BUTTON_COMPACT} flex w-full min-w-0 items-center justify-center gap-2 px-3`}
                >
                  <PenLine size={16} strokeWidth={2} />
                  <span className="truncate">Use my saved signature</span>
                </button>
              ) : null
          : undefined
      }
      onDone={(png) => void done(png)}
      onClose={onClose}
    />
  )
}
