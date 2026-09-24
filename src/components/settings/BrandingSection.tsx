import { useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { Camera } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { useHydrated } from '#/lib/useHydrated'
import { prepareUpload } from '#/lib/images/prepareUpload'
import { EmailInput } from '#/components/forms/EmailInput'
import { FormAlert } from '#/components/forms/FormAlert'
import { fieldInputClass } from '#/components/forms/FormField'
import { PhoneInput } from '#/components/forms/PhoneInput'
import {
  SaveWarningsPanel,
  SaveWarningsProvider,
  useSaveWarnings,
} from '#/components/forms/SaveWarnings'
import { VerifiedAddressFields } from '#/components/forms/VerifiedAddressFields'
import type { AddressValue } from '#/lib/addressVerify'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * Printed on the report PDF header/cover — a business-level licence, distinct
 * from a technician's own licence on `memberships` (see `ProfileSection`).
 *
 * The address, phone and email here head every report and certificate the
 * business issues, so they get the same checks as a client's (field
 * verification). The address has no State field: a business's state is the
 * one it registered with (Prefs), and the printed address is in it.
 */
export function BrandingSection({
  businessId,
  business,
}: {
  businessId: Id<'businesses'>
  business: {
    logoUrl?: string | null
    state: string
    addressLine?: string
    suburb?: string
    postcode?: string
    phone?: string
    email?: string
    licenceNumber?: string
  }
}) {
  const hydrated = useHydrated()
  const input = useRef<HTMLInputElement>(null)
  const [logoBusy, setLogoBusy] = useState(false)
  const [logoFailed, setLogoFailed] = useState(false)
  // `business` is a snapshot from the route loader, not a live subscription —
  // a successful upload has to be reflected locally or the preview would only
  // ever update after a full page reload.
  const [logoPreview, setLogoPreview] = useState<string | null>(null)
  const logoUrl = logoPreview ?? business.logoUrl

  // `state` rides along only for the checks; `businesses.update` has no
  // address state to write.
  const savedAddress: AddressValue = {
    addressLine: business.addressLine ?? '',
    suburb: business.suburb ?? '',
    state: business.state,
    postcode: business.postcode ?? '',
  }
  const [address, setAddress] = useState<AddressValue>(savedAddress)
  const [phone, setPhone] = useState(business.phone ?? '')
  const [email, setEmail] = useState(business.email ?? '')
  const [licenceNumber, setLicenceNumber] = useState(
    business.licenceNumber ?? '',
  )

  const id = useId()
  const warnings = useSaveWarnings()

  const convexUpdate = useConvexMutation(api.businesses.update)
  const save = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      addressLine: string
      suburb: string
      postcode: string
      phone: string
      email: string
      licenceNumber: string
    }) => convexUpdate(args),
  })

  const getUploadUrl = useConvexMutation(api.businesses.generateUploadUrl)
  const setLogo = useConvexMutation(api.businesses.update)

  async function onPickLogo(file: File) {
    setLogoBusy(true)
    setLogoFailed(false)
    try {
      // A logo prints a few centimetres wide on a letterhead, so it keeps its
      // own smaller budget rather than a report photo's.
      const image = await prepareUpload(file, { maxEdge: 800 })
      const uploadUrl = await getUploadUrl({ businessId })
      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': image.blob.type },
        body: image.blob,
      })
      if (!res.ok) throw new Error('upload failed')
      const { storageId } = (await res.json()) as { storageId: string }
      await setLogo({
        businessId,
        logoStorageId: storageId as Id<'_storage'>,
      })
      setLogoPreview(URL.createObjectURL(image.blob))
    } catch {
      setLogoFailed(true)
    } finally {
      setLogoBusy(false)
    }
  }

  return (
    <>
      <h2 className="section-label mb-2">Branding</h2>

      <div className="rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation">
        <span className="flex items-center gap-3">
          {/* Pinned light: this previews artwork bound for a white PDF
              page, and business logos are overwhelmingly dark-on-transparent
              PNGs that would vanish against a dark tile. */}
          <span
            data-theme="light"
            className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-surface-3"
          >
            {logoUrl ? (
              <img
                src={logoUrl}
                alt="Business logo"
                className="size-full object-contain"
              />
            ) : (
              <Camera size={22} strokeWidth={1.8} className="text-muted" />
            )}
          </span>
          <button
            type="button"
            disabled={logoBusy || !hydrated}
            onClick={() => input.current?.click()}
            className="h-11 flex-1 rounded-xl bg-surface-2 text-[15px] font-semibold text-ink transition active:scale-[.98] disabled:opacity-50"
          >
            {logoBusy
              ? 'Uploading…'
              : logoUrl
                ? 'Change logo'
                : 'Add logo'}
          </button>
          <input
            ref={input}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void onPickLogo(file)
            }}
          />
        </span>
        {logoFailed && (
          <p role="alert" className="mt-2 text-caption text-amber-ink">
            Upload failed. Check your connection and try again.
          </p>
        )}
        <p className="mt-2 text-caption text-muted">
          Printed on report and certificate PDFs.
        </p>
      </div>

      <SaveWarningsProvider value={warnings}>
        {/* Spaced like the address block's own fields (mt-4 each), so the
            form reads as one column rather than two spacings. */}
        <form
          className="mt-3 rounded-2xl border border-hairline bg-surface px-3.5 pb-3.5 shadow-elevation"
          onSubmit={(e) =>
            warnings.guard(e, () =>
              save.mutateAsync({
                businessId,
                addressLine: address.addressLine,
                suburb: address.suburb,
                postcode: address.postcode,
                phone,
                email,
                licenceNumber,
              }),
            )
          }
        >
          {/* Optional: plenty of businesses print no street address. */}
          <VerifiedAddressFields
            idPrefix={`${id}-business`}
            value={address}
            onChange={(patch) => setAddress((prev) => ({ ...prev, ...patch }))}
            workState={business.state}
            initial={savedAddress}
            required={false}
            showState={false}
          />

          <Field id={`${id}-phone`} label="Phone">
            <PhoneInput
              id={`${id}-phone`}
              value={phone}
              onChange={setPhone}
              initial={business.phone ?? ''}
              businessState={business.state}
            />
          </Field>

          <Field id={`${id}-email`} label="Email">
            <EmailInput
              id={`${id}-email`}
              value={email}
              onChange={setEmail}
              initial={business.email ?? ''}
            />
          </Field>

          <Field id={`${id}-licence`} label="Business licence number">
            <input
              id={`${id}-licence`}
              value={licenceNumber}
              onChange={(e) => setLicenceNumber(e.target.value)}
              className={fieldInputClass()}
            />
          </Field>

          <FormAlert
            error={save.isError ? save.error : null}
            className="mt-4"
          />
          <SaveWarningsPanel className="mt-4" />

          <button
            type="submit"
            disabled={save.isPending || !hydrated}
            className="mt-4 h-11 w-full rounded-xl bg-surface-2 text-[16px] font-semibold text-ink transition active:scale-[.975] disabled:opacity-50"
          >
            {save.isPending
              ? 'Saving…'
              : warnings.saveLabel(save.isSuccess ? 'Saved' : 'Save')}
          </button>
        </form>
      </SaveWarningsProvider>
    </>
  )
}

/** A label and its control. The label names the control by `htmlFor` and
 * holds only its text: the phone and email lines under their inputs (and
 * their fix buttons) must not become part of the field's name. */
function Field({
  id,
  label,
  children,
}: {
  id: string
  label: string
  children: ReactNode
}) {
  return (
    <div className="mt-4 flex flex-col gap-1.5">
      <label htmlFor={id} className="section-label">
        {label}
      </label>
      <div>{children}</div>
    </div>
  )
}
