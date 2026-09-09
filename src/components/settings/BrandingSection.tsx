import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { Camera } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { useHydrated } from '#/lib/useHydrated'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * Printed on the report PDF header/cover — a business-level licence, distinct
 * from a technician's own licence on `memberships` (see `ProfileSection`).
 */
export function BrandingSection({
  businessId,
  business,
}: {
  businessId: Id<'businesses'>
  business: {
    logoUrl?: string | null
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

  const [addressLine, setAddressLine] = useState(business.addressLine ?? '')
  const [suburb, setSuburb] = useState(business.suburb ?? '')
  const [postcode, setPostcode] = useState(business.postcode ?? '')
  const [phone, setPhone] = useState(business.phone ?? '')
  const [email, setEmail] = useState(business.email ?? '')
  const [licenceNumber, setLicenceNumber] = useState(
    business.licenceNumber ?? '',
  )

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
      const { default: compress } = await import('browser-image-compression')
      const compressed = await compress(file, {
        maxSizeMB: 0.5,
        maxWidthOrHeight: 800,
        useWebWorker: true,
      })
      const uploadUrl = await getUploadUrl({ businessId })
      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': compressed.type },
        body: compressed,
      })
      if (!res.ok) throw new Error('upload failed')
      const { storageId } = (await res.json()) as { storageId: string }
      await setLogo({
        businessId,
        logoStorageId: storageId as Id<'_storage'>,
      })
      setLogoPreview(URL.createObjectURL(compressed))
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
          <span className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-surface-3">
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
              console.log('DEBUG onChange fired', e.target.files?.length)
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

      <form
        className="mt-3 flex flex-col gap-3 rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate({
            businessId,
            addressLine,
            suburb,
            postcode,
            phone,
            email,
            licenceNumber,
          })
        }}
      >
        <Field label="Address">
          <input
            value={addressLine}
            onChange={(e) => setAddressLine(e.target.value)}
            className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
          />
        </Field>

        <span className="flex gap-3">
          <span className="flex-1">
            <Field label="Suburb">
              <input
                value={suburb}
                onChange={(e) => setSuburb(e.target.value)}
                className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
              />
            </Field>
          </span>
          <span className="w-24 shrink-0">
            <Field label="Postcode">
              <input
                value={postcode}
                onChange={(e) => setPostcode(e.target.value)}
                inputMode="numeric"
                className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
              />
            </Field>
          </span>
        </span>

        <Field label="Phone">
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            type="tel"
            className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
          />
        </Field>

        <Field label="Email">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
          />
        </Field>

        <Field label="Business licence number">
          <input
            value={licenceNumber}
            onChange={(e) => setLicenceNumber(e.target.value)}
            className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
          />
        </Field>

        <button
          type="submit"
          disabled={save.isPending || !hydrated}
          className="h-11 w-full rounded-xl bg-surface-2 text-[16px] font-semibold text-ink transition active:scale-[.975] disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : save.isSuccess ? 'Saved' : 'Save'}
        </button>
      </form>
    </>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="section-label">{label}</span>
      {children}
    </label>
  )
}
