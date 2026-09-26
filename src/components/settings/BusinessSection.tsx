import { useId, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { Camera } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { normaliseProductUrl } from '../../../convex/lib/products'
import { FieldRow, SaveBar, SettingsGroup } from './ui'
import { AbnInput } from '#/components/clients/AbnInput'
import { EmailInput } from '#/components/forms/EmailInput'
import { FormAlert } from '#/components/forms/FormAlert'
import { fieldInputClass, fieldLabelText } from '#/components/forms/FormField'
import { PhoneInput } from '#/components/forms/PhoneInput'
import {
  SaveWarningsPanel,
  SaveWarningsProvider,
  useLatest,
  useSaveCheck,
  useSaveWarnings,
} from '#/components/forms/SaveWarnings'
import { VerifiedAddressFields } from '#/components/forms/VerifiedAddressFields'
import { AU_STATES, TIMEZONE_BY_STATE } from '#/lib/au'
import { prepareUpload } from '#/lib/images/prepareUpload'
import { rq } from '#/lib/routeQueries'
import { useHydrated } from '#/lib/useHydrated'
import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import type { AddressValue } from '#/lib/addressVerify'
import type { Id } from '../../../convex/_generated/dataModel'
import { LINK_BUTTON_COMPACT } from '#/components/primitives/buttons'
import { useSavedFlash } from './useJustSaved'

/** The business as the layout's route context carries it. */
export type BusinessRecord = NonNullable<
  FunctionReturnType<typeof api.businesses.getBySlug>
>

/** Everything the form edits, as it shows in the fields. */
type Draft = {
  name: string
  tradingName: string
  state: string
  abn: string
  licenceNumber: string
  address: AddressValue
  phone: string
  email: string
  website: string
}

type UpdateArgs = FunctionArgs<typeof api.businesses.update>

/** How long "Saved" stays on the button once a save lands. */
const SAVED_SHOWN_MS = 2500

/**
 * The address block as rows of the Letterhead card. VerifiedAddressFields
 * spaces its three parts (street, suburb, postcode) with a top margin each and
 * labels them in group-heading capitals, both right for the full-page forms it
 * was made for; here each part becomes a row like FieldRow's (padded, divided
 * by a hairline) and its labels take the field-label style, so the card reads
 * as one list rather than a form set inside it. Restyled from outside so the
 * shared component, and every other form using it, is left as it is.
 */
const ADDRESS_ROWS =
  'divide-y divide-hairline [&>div]:mt-0 [&>div]:px-3.5 [&>div]:py-3 [&_label]:text-caption [&_label]:font-medium [&_label]:tracking-normal [&_label]:text-ink-2 [&_label]:normal-case'

/**
 * The business as it prints: who issued the document (the Business group)
 * and the letterhead (logo, address, phone, email, website). The logo and the
 * contact lines head every report (reportTemplates/documentModel.ts); the
 * address does not — it prints in the body of the inspection report and the
 * certificate (and any custom form that asks for it). The page renders this
 * only for someone with `business.manage`; the server refuses everyone else
 * anyway.
 *
 * The business licence number here is the business's own — distinct from a
 * technician's licence on `memberships`, which is theirs to keep on the
 * Licence page.
 *
 * The address, phone and email print on what the business issues, so they
 * get the same checks as a client's (field verification). The
 * address has no State field: a business's state is the one chosen above it,
 * and the printed address is in it.
 *
 * One form and one Save for all of it, shown only once something has changed.
 * The logo is the exception: picking one uploads it there and then, as there
 * is nothing to type and nothing to take back.
 */
export function BusinessSection({
  business: snapshot,
}: {
  business: BusinessRecord
}) {
  const hydrated = useHydrated()
  const id = useId()
  const warnings = useSaveWarnings()

  // Live, not the route's snapshot. Route context is taken once on the way
  // in, so after a save it would still hold the old values, and the form,
  // comparing against them, would go on offering Save for what is already
  // saved. The layout's beforeLoad already holds this query (and keeps it
  // live), so reading it here costs nothing — and a new logo shows as soon
  // as the update lands, without the local preview the old form kept.
  const { data: live } = useQuery(
    convexQuery(api.businesses.getBySlug, { slug: snapshot.slug }),
  )
  const business = live ?? snapshot
  const businessId = business._id

  // The trading name and website are not in `getBySlug`, which every page
  // load runs and which carries only what the shell needs. Until this answers
  // those two fields wait, disabled, and are left out of a save: a save sent
  // before it would otherwise write them blank.
  const { data: printedOrNull } = useQuery(rq.reportSettings(businessId))
  const printed = printedOrNull ?? undefined

  // `state` rides along in the address only for the checks;
  // `businesses.update` has no address state to write.
  const saved: Draft = {
    name: business.name,
    tradingName: printed?.tradingName ?? '',
    state: business.state,
    abn: business.abn ?? '',
    licenceNumber: business.licenceNumber ?? '',
    address: {
      addressLine: business.addressLine ?? '',
      suburb: business.suburb ?? '',
      state: business.state,
      postcode: business.postcode ?? '',
    },
    phone: business.phone ?? '',
    email: business.email ?? '',
    website: printed?.website ?? '',
  }

  // Only what has been typed. Every other field shows the saved value, live,
  // so a change made elsewhere (or this form's own save) comes through.
  const [edits, setEdits] = useState<Partial<Draft>>({})
  const values: Draft = { ...saved, ...edits }
  const dirty = DRAFT_KEYS.some((key) => !sameValue(values[key], saved[key]))
  const set =
    <TKey extends keyof Draft>(key: TKey) =>
    (value: Draft[TKey]) =>
      setEdits((prev) => ({ ...prev, [key]: value }))

  const flash = useSavedFlash(SAVED_SHOWN_MS)

  const convexUpdate = useConvexMutation(api.businesses.update)
  const save = useMutation({
    mutationFn: ({ args }: { sent: Draft; args: UpdateArgs }) =>
      convexUpdate(args),
    onSuccess: (_, { sent }) => {
      // What was saved is now the saved value, which the live query already
      // shows (the server's own formatting of it included), so those edits
      // go. Anything typed while the save was out stays: it has not been
      // saved.
      setEdits((prev) => {
        const next: Partial<Draft> = {}
        for (const key of Object.keys(prev) as Array<keyof Draft>) {
          const value = prev[key]
          if (value !== undefined && !sameValue(value, sent[key])) {
            Object.assign(next, { [key]: value })
          }
        }
        return next
      })
      flash.mark()
    },
  })

  // Read when the save goes, after any checks at Save have answered, not
  // when Save was pressed: a number put right while the address was still
  // being looked up is what the field shows and what "Saved" claims, so it
  // is what goes.
  const latestArgs = useLatest((): { sent: Draft; args: UpdateArgs } => {
    const trading = values.tradingName.trim()
    const website = values.website.trim()
    return {
      sent: values,
      args: {
        businessId,
        name: values.name,
        state: values.state,
        timezone: TIMEZONE_BY_STATE[values.state],
        // Blank clears a saved ABN (the server drops it); leaving it out, as
        // this did, kept the old one while the button said "Saved". Left out
        // when there was none, so nothing writes an empty ABN.
        abn: values.abn.trim() || (business.abn ? '' : undefined),
        licenceNumber: values.licenceNumber,
        addressLine: values.address.addressLine,
        suburb: values.address.suburb,
        postcode: values.address.postcode,
        phone: values.phone,
        email: values.email,
        // These two only when they have been read and have changed. Unread,
        // sending them would write them blank; unchanged, the server would
        // still write them and log a change to what the report says issued
        // it that nobody made.
        //
        // A cleared trading name is sent as the legal name rather than as
        // blank. The report falls back to the legal name only when there is
        // no trading name at all, and `update` cannot take one away: a blank
        // one would print as an empty "issued by" on every report and
        // certificate, the AS forms' Inspection Provider line included.
        ...(printed && trading !== (printed.tradingName ?? '').trim()
          ? { tradingName: trading || values.name.trim() }
          : {}),
        // Blank is fine for this one: the letterhead leaves out an empty
        // line.
        ...(printed && website !== (printed.website ?? '').trim()
          ? { website }
          : {}),
      },
    }
  })

  const fileInput = useRef<HTMLInputElement>(null)
  const [logoBusy, setLogoBusy] = useState(false)
  const [logoFailed, setLogoFailed] = useState(false)
  const getUploadUrl = useConvexMutation(api.businesses.generateUploadUrl)

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
      await convexUpdate({
        businessId,
        logoStorageId: storageId as Id<'_storage'>,
      })
    } catch {
      setLogoFailed(true)
    } finally {
      setLogoBusy(false)
    }
  }

  const timezone = TIMEZONE_BY_STATE[values.state]
  const showSaveBar =
    dirty || save.isPending || flash.recently || warnings.checking

  return (
    <SaveWarningsProvider value={warnings}>
      <form
        onSubmit={(e) =>
          warnings.guard(e, () => save.mutateAsync(latestArgs.current()))
        }
      >
        <SettingsGroup
          id={`${id}-business-heading`}
          title="Business"
          footer={`State sets your timezone (${timezone}) and how licence fields are labelled.`}
        >
          <FieldRow id={`${id}-name`} label="Legal name">
            <input
              id={`${id}-name`}
              value={values.name}
              onChange={(e) => set('name')(e.target.value)}
              required
              className={fieldInputClass()}
            />
          </FieldRow>

          {/* What the report's header says issued it, when that is not the
              legal name. */}
          <FieldRow id={`${id}-trading`} label="Trading name (optional)">
            <input
              id={`${id}-trading`}
              value={values.tradingName}
              onChange={(e) => set('tradingName')(e.target.value)}
              disabled={!printed}
              placeholder="Same as legal name"
              className={`${fieldInputClass()} disabled:opacity-50`}
            />
          </FieldRow>

          <FieldRow id={`${id}-state`} label="State">
            <select
              id={`${id}-state`}
              value={values.state}
              onChange={(e) => set('state')(e.target.value)}
              className={fieldInputClass()}
            >
              {AU_STATES.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </select>
          </FieldRow>

          {/* Printed on every compliance document, so a newly typed one must
              pass the ATO check; the one already saved, left alone, is never
              refused (the seed's own ABNs fail it). */}
          <FieldRow id={`${id}-abn`} label="ABN (optional)">
            <AbnInput
              id={`${id}-abn`}
              value={values.abn}
              onChange={set('abn')}
              initial={saved.abn}
            />
          </FieldRow>

          <FieldRow id={`${id}-licence`} label="Business licence number">
            <input
              id={`${id}-licence`}
              value={values.licenceNumber}
              onChange={(e) => set('licenceNumber')(e.target.value)}
              className={fieldInputClass()}
            />
          </FieldRow>
        </SettingsGroup>

        <SettingsGroup
          id={`${id}-letterhead-heading`}
          title="Letterhead"
          footer="Logo and contact details head every report; the address prints on inspection reports and certificates."
          // The street's suggestions open below it, over the rows beneath,
          // and a card that clips its contents would cut them off. Nothing
          // in this one paints to its edges, so it has nothing to clip.
          className="[&>div]:overflow-visible"
        >
          <div className="px-3.5 py-3">
            <div className="flex items-center gap-3">
              {/* Pinned light: this previews artwork bound for a white PDF
                  page, and business logos are overwhelmingly
                  dark-on-transparent PNGs that would vanish against a dark
                  tile. */}
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
                  <Camera size={22} strokeWidth={1.7} className="text-muted" />
                )}
              </span>
              <span className="min-w-0 flex-1 text-body text-ink">Logo</span>
              <button
                type="button"
                disabled={logoBusy || !hydrated}
                onClick={() => fileInput.current?.click()}
                className={`${LINK_BUTTON_COMPACT} shrink-0 px-3.5`}
              >
                {logoBusy
                  ? 'Uploading…'
                  : business.logoUrl
                    ? 'Change logo'
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
                Upload failed. Check your signal and try again.
              </p>
            )}
          </div>

          {/* Optional: plenty of businesses print no street address. Checked
              against the state chosen above, which is the one it will be
              saved under. */}
          <div className={ADDRESS_ROWS}>
            <VerifiedAddressFields
              idPrefix={`${id}-business`}
              value={values.address}
              onChange={(patch) =>
                setEdits((prev) => ({
                  ...prev,
                  address: { ...(prev.address ?? saved.address), ...patch },
                }))
              }
              workState={values.state}
              initial={saved.address}
              required={false}
              showState={false}
            />
          </div>

          <FieldRow id={`${id}-phone`} label="Phone">
            <PhoneInput
              id={`${id}-phone`}
              value={values.phone}
              onChange={set('phone')}
              initial={saved.phone}
              businessState={values.state}
            />
          </FieldRow>

          <FieldRow id={`${id}-email`} label="Email">
            <EmailInput
              id={`${id}-email`}
              value={values.email}
              onChange={set('email')}
              initial={saved.email}
            />
          </FieldRow>

          <FieldRow id={`${id}-website`} label="Website (optional)">
            <WebsiteInput
              id={`${id}-website`}
              value={values.website}
              onChange={set('website')}
              initial={saved.website}
              disabled={!printed}
            />
          </FieldRow>
        </SettingsGroup>

        <FormAlert error={save.isError ? save.error : null} className="mt-4" />
        <SaveWarningsPanel className="mt-4" />

        <SaveBar
          visible={showSaveBar}
          pending={save.isPending}
          disabled={!hydrated || !dirty}
          label={warnings.saveLabel(
            dirty || !flash.recently ? 'Save' : 'Saved',
          )}
        />
      </form>
    </SaveWarningsProvider>
  )
}

const DRAFT_KEYS: ReadonlyArray<keyof Draft> = [
  'name',
  'tradingName',
  'state',
  'abn',
  'licenceNumber',
  'address',
  'phone',
  'email',
  'website',
]

/** One field's value against another's. An address is the three parts that
 * are saved; its state is the business's, compared on its own. */
function sameValue(a: Draft[keyof Draft], b: Draft[keyof Draft]): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b
  return (
    a.addressLine === b.addressLine &&
    a.suburb === b.suburb &&
    a.postcode === b.postcode
  )
}

/**
 * The business's website, as the letterhead prints it: exactly as typed, so
 * "baysidepest.com.au" stays that and does not become a link's
 * "https://baysidepest.com.au/".
 *
 * Plain text rather than type="url": the browser's own check refuses an
 * address with no "https://", which is how nearly every letterhead writes
 * one, and would stop the whole form at a field the server takes as it is.
 * One that could not be a web address at all is pointed out at Save, by the
 * rule a product's link is held to — a warning, never a refusal, since the
 * server keeps whatever it is given.
 */
function WebsiteInput({
  id,
  value,
  onChange,
  initial,
  disabled,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  /** The saved value. Left as it was, it is not questioned again. */
  initial: string
  disabled: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const typed = value.trim()

  useSaveCheck(id, () => {
    if (typed === '' || typed === initial.trim()) return []
    if (normaliseProductUrl(typed) !== null) return []
    return [
      {
        id: `${id}:shape`,
        label: fieldLabelText(id, 'Website'),
        message:
          'That website address does not look right. It should be like yourbusiness.com.au.',
        focus: () => inputRef.current?.focus(),
      },
    ]
  }, [typed])

  return (
    <input
      ref={inputRef}
      id={id}
      type="text"
      inputMode="url"
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      autoComplete="off"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={`${fieldInputClass()} disabled:opacity-50`}
    />
  )
}
