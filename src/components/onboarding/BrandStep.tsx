import { useId, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { Camera } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { EmailInput } from '#/components/forms/EmailInput'
import { FormAlert } from '#/components/forms/FormAlert'
import { PhoneInput } from '#/components/forms/PhoneInput'
import {
  SaveWarningsPanel,
  SaveWarningsProvider,
  useLatest,
  useSaveWarnings,
} from '#/components/forms/SaveWarnings'
import { VerifiedAddressFields } from '#/components/forms/VerifiedAddressFields'
import { FieldRow, SettingsGroup } from '#/components/settings/ui'
import { prepareUpload } from '#/lib/images/prepareUpload'
import { useHydrated } from '#/lib/useHydrated'
import { ReportPreview } from './ReportPreview'
import { AsideButton, ContinueButton, SetupFrame } from './SetupFrame'
import type { AddressValue } from '#/lib/addressVerify'
import type { BusinessRecord } from '#/components/settings/BusinessSection'
import type { Id } from '../../../convex/_generated/dataModel'
import { LINK_BUTTON_COMPACT } from '#/components/primitives/buttons'

/** The address as card rows — the same restyle Settings' letterhead gives
 * the shared fields (BusinessSection's ADDRESS_ROWS). */
const ADDRESS_ROWS =
  'divide-y divide-hairline [&>div]:mt-0 [&>div]:px-3.5 [&>div]:py-3 [&_label]:text-caption [&_label]:font-medium [&_label]:tracking-normal [&_label]:text-ink-2 [&_label]:normal-case'

const SAVE_COPY = {
  offline:
    'Could not save: this device is offline. Try again when you have signal, or add these later.',
  default: 'Could not save. Check your connection and try again.',
}

/**
 * Step 2: what heads every report — the logo, and how a client reaches the
 * business. All of it optional; "Add later" moves on with none of it.
 *
 * The email starts as the account's own, since that is where most owners
 * want replies. The logo uploads the moment it is picked, as it does in
 * Settings: nothing to type, nothing to take back. On an iPhone the trip to
 * Photos can reload the app before the photo comes back; set-up keeps its
 * place server-side, so they land on this step again to pick it once more —
 * but anything typed and not yet saved is gone with the reload.
 */
export function BrandStep({
  business,
  accountEmail,
  licenceNumber,
  onBack,
  onDone,
  onLater,
}: {
  /** Live: a new logo shows as soon as it lands. */
  business: BusinessRecord
  accountEmail: string | null
  licenceNumber?: string
  onBack: () => void
  onDone: () => Promise<void>
  onLater: () => void
}) {
  const hydrated = useHydrated()
  const id = useId()
  const warnings = useSaveWarnings()

  const savedAddress: AddressValue = {
    addressLine: business.addressLine ?? '',
    suburb: business.suburb ?? '',
    state: business.state,
    postcode: business.postcode ?? '',
  }
  const [phone, setPhone] = useState(business.phone ?? '')
  const [email, setEmail] = useState(business.email ?? accountEmail ?? '')
  const [address, setAddress] = useState<AddressValue>(savedAddress)

  const update = useConvexMutation(api.businesses.update)
  const save = useMutation({
    mutationFn: async (args: {
      phone: string
      email: string
      address: AddressValue
    }) => {
      await update({
        businessId: business._id,
        phone: args.phone,
        email: args.email,
        addressLine: args.address.addressLine,
        suburb: args.address.suburb,
        postcode: args.address.postcode,
      })
      await onDone()
    },
  })
  // What the fields hold when the save goes, after any checks have answered.
  const latest = useLatest(() => ({ phone, email, address }))

  const fileInput = useRef<HTMLInputElement>(null)
  const [logoBusy, setLogoBusy] = useState(false)
  const [logoFailed, setLogoFailed] = useState(false)
  const getUploadUrl = useConvexMutation(api.businesses.generateUploadUrl)

  async function onPickLogo(file: File) {
    setLogoBusy(true)
    setLogoFailed(false)
    try {
      const image = await prepareUpload(file, { maxEdge: 800 })
      const uploadUrl = await getUploadUrl({ businessId: business._id })
      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': image.blob.type },
        body: image.blob,
      })
      if (!res.ok) throw new Error('upload failed')
      const { storageId } = (await res.json()) as { storageId: string }
      await update({
        businessId: business._id,
        logoStorageId: storageId as Id<'_storage'>,
      })
    } catch {
      setLogoFailed(true)
    } finally {
      setLogoBusy(false)
    }
  }

  return (
    <SetupFrame
      step="brand"
      title="Make your reports yours"
      lede="Your logo and contact details head every report and certificate you send."
      onBack={onBack}
      aside={<AsideButton onClick={onLater}>Add later</AsideButton>}
    >
      <SaveWarningsProvider value={warnings}>
        <form
          className="mt-6 flex flex-1 flex-col"
          onSubmit={(e) =>
            warnings.guard(e, () => save.mutateAsync(latest.current()))
          }
        >
          <ReportPreview
            name={business.name}
            logoUrl={business.logoUrl}
            email={email}
            phone={phone}
            abn={business.abn}
            state={business.state}
            licenceNumber={licenceNumber}
            focus="brand"
          />

          <SettingsGroup
            className="mt-6 [&>div]:overflow-visible"
            footer="The address prints on inspection reports and certificates."
          >
            <div className="px-3.5 py-3">
              <div className="flex items-center gap-3">
                <span
                  data-theme="light"
                  className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-surface-3"
                >
                  {business.logoUrl ? (
                    <img
                      src={business.logoUrl}
                      alt="Business logo"
                      className="size-full object-contain"
                    />
                  ) : (
                    <Camera
                      size={22}
                      strokeWidth={1.8}
                      className="text-muted"
                    />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-body text-ink">Logo</span>
                  <span className="block text-caption text-muted">
                    A photo of your sign or card works.
                  </span>
                </span>
                <button
                  type="button"
                  disabled={logoBusy || !hydrated}
                  onClick={() => fileInput.current?.click()}
                  className={`${LINK_BUTTON_COMPACT} shrink-0 px-3.5`}
                >
                  {logoBusy
                    ? 'Uploading…'
                    : business.logoUrl
                      ? 'Change'
                      : 'Add logo'}
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    e.target.value = ''
                    if (file) void onPickLogo(file)
                  }}
                />
              </div>
              {logoFailed && (
                <p role="alert" className="mt-2 text-caption text-amber-ink">
                  Upload failed. Check your connection and try again.
                </p>
              )}
            </div>

            <FieldRow id={`${id}-phone`} label="Phone">
              <PhoneInput
                id={`${id}-phone`}
                value={phone}
                onChange={setPhone}
                initial={business.phone ?? ''}
                businessState={business.state}
              />
            </FieldRow>

            <FieldRow
              id={`${id}-email`}
              label="Email"
              hint="Clients’ replies to your reports come here."
            >
              <EmailInput
                id={`${id}-email`}
                value={email}
                onChange={setEmail}
                initial={business.email ?? ''}
              />
            </FieldRow>

            <div className={ADDRESS_ROWS}>
              <VerifiedAddressFields
                idPrefix={`${id}-address`}
                value={address}
                onChange={(patch) =>
                  setAddress((prev) => ({ ...prev, ...patch }))
                }
                workState={business.state}
                initial={savedAddress}
                required={false}
                showState={false}
              />
            </div>
          </SettingsGroup>

          <SaveWarningsPanel className="mt-4" />
          <FormAlert
            error={save.isError ? save.error : null}
            copy={SAVE_COPY}
            className="mt-4"
          />

          <ContinueButton
            pending={save.isPending}
            disabled={!hydrated || logoBusy}
          >
            {warnings.saveLabel('Continue')}
          </ContinueButton>
        </form>
      </SaveWarningsProvider>
    </SetupFrame>
  )
}
