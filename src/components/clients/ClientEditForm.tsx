import { useId, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import {
  SHEET_BODY_ABOVE_FOOTER,
  SHEET_FOOTER,
  useSheetLock,
} from '#/components/primitives/Sheet'
import { api } from '../../../convex/_generated/api'
import { AbnInput } from '#/components/clients/AbnInput'
import { EmailInput } from '#/components/forms/EmailInput'
import { FieldMessage } from '#/components/forms/FieldMessage'
import { FormAlert } from '#/components/forms/FormAlert'
import { FormField } from '#/components/forms/FormField'
import { PhoneInput } from '#/components/forms/PhoneInput'
import {
  SaveWarningsPanel,
  SaveWarningsProvider,
  useLatest,
  useSaveWarnings,
} from '#/components/forms/SaveWarnings'
import { VerifiedAddressFields } from '#/components/forms/VerifiedAddressFields'
import { Segmented } from '#/components/primitives/Segmented'
import { useHydrated } from '#/lib/useHydrated'
import { useLineDown } from '#/lib/offline/useLineDown'
import { editSaveWaits } from '#/lib/editSaveWaits'
import { formatAbn } from '../../../convex/lib/abn'
import { isNameCorrection, sameName } from '../../../convex/lib/contactNames'
import type { Id } from '../../../convex/_generated/dataModel'
import type { ErrorCopy } from '#/components/forms/describeError'
import type { AddressValue } from '#/lib/addressVerify'
import {
  PRIMARY_BUTTON_COMPACT,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'
import {
  TagInput,
  clientNumberLabel,
} from '#/components/clients/ClientRecordBits'
import { rq } from '#/lib/routeQueries'
import { clientNumberFromText } from '../../../convex/lib/clientRecord'
import type { ClientStatus } from '../../../convex/lib/clientRecord'
import { KIND_CHOICES } from '#/lib/clientFilters'
import type { ClientKind } from '#/lib/clientFilters'
import { TextInput, WrappedField } from '#/components/clients/clientFormFields'
import { changed } from '#/components/clients/clientEdits'
import { clientEditArgs } from '#/components/clients/clientEditArgs'
import type {
  ClientEditArgs,
  ClientEditBase,
} from '#/components/clients/clientEditArgs'

/**
 * A client's own details, edited: the client sheet's Edit, and the job
 * sheet's Edit → Client. In a module of its own, so the job sheet can load
 * it without the client sheet's notes and reports.
 */
export function ClientEditForm({
  businessId,
  businessState,
  client: openedWith,
  contactPerson: prefilledContactPerson,
  canRenumber,
  onDone,
  header,
}: {
  /** The owner, who alone may change the client number. */
  canRenumber: boolean
  /** The sheet's own heading, drawn above the fields. */
  header: React.ReactNode
  businessId: Id<'businesses'>
  /** Where the business works: suggestions lean there, an address elsewhere
   * is pointed out, and a number missing its area code gets this state's. */
  businessState: string
  client: ClientEditBase & { status?: ClientStatus }
  /** The primary contact's name, '' when there is none, or undefined while
   * the client's contacts are still on their way. */
  contactPerson: string | undefined
  onDone: () => void
}) {
  // The client as the form opened it, which every field is compared with:
  // the client sheet passes the live record, and a field the office changes
  // meanwhile, left alone here, would otherwise read as changed here and be
  // put back by Save.
  const [client] = useState(openedWith)
  const [kind, setKind] = useState<ClientKind>(client.kind)
  const [name, setName] = useState(client.name)
  const [phone, setPhone] = useState(client.phone ?? '')
  const [email, setEmail] = useState(client.email ?? '')
  const [address, setAddress] = useState<AddressValue>({
    addressLine: client.addressLine ?? '',
    suburb: client.suburb ?? '',
    // Blank until chosen. It used to start on the first state in the list,
    // ACT, and was saved with every business edit, so reports printed "ACT"
    // as the address of clients that never had one.
    state: client.state ?? '',
    postcode: client.postcode ?? '',
  })
  const [abn, setAbn] = useState(client.abn ? formatAbn(client.abn) : '')
  const [contactPerson, setContactPerson] = useState(
    prefilledContactPerson ?? '',
  )
  // What the field opened with, not the live primary: a contact person
  // changed elsewhere meanwhile isn't read as one changed here.
  const [knownBefore, setKnownBefore] = useState(prefilledContactPerson)
  // Contacts that arrive after the form opened are what it opened with, and
  // fill the field unless something was typed there first. Until then (no
  // signal, say), the field starts blank.
  if (knownBefore === undefined && prefilledContactPerson !== undefined) {
    setKnownBefore(prefilledContactPerson)
    if (contactPerson === '') setContactPerson(prefilledContactPerson)
  }
  const contactPersonBefore = knownBefore ?? ''
  const [numberText, setNumberText] = useState(
    client.clientNumber === undefined ? '' : String(client.clientNumber),
  )
  const [tags, setTags] = useState<Array<string>>(client.tags ?? [])
  // The business's tags, offered as one is typed: counted on the server for
  // the Clients page's header and filters (`clients.overview`), the same
  // cache entry, rather than every client sent down for their tags.
  const { data: overview } = useQuery(rq.clientOverview(businessId))
  const suggestions = (overview?.tags ?? []).map((t) => t.tag)
  const wantedNumber = clientNumberFromText(numberText)
  const numberProblem =
    numberText.trim() !== '' && wantedNumber === null
      ? 'A client number is a whole number, like 1916.'
      : null

  // What the record has saved, as the save below compares with: a value left
  // as it is is not sent, so it is never refused here either, however it
  // fails today's rules — only warned about.
  const savedAddress: AddressValue = {
    addressLine: client.addressLine ?? '',
    suburb: client.suburb ?? '',
    state: client.state ?? '',
    postcode: client.postcode ?? '',
  }

  const hydrated = useHydrated()
  const id = useId()
  const warnings = useSaveWarnings()

  const convexUpdate = useConvexMutation(api.clients.update)
  const save = useMutation({
    mutationFn: (args: ClientEditArgs) => convexUpdate(args),
    onSuccess: onDone,
  })

  // Each field only when changed (clientEditArgs).
  const args = () =>
    clientEditArgs({
      businessId,
      client,
      value: {
        kind,
        name,
        phone,
        email,
        address,
        abn,
        contactPerson,
        tags,
        clientNumber: wantedNumber,
      },
      contactPersonBefore,
      canRenumber,
    })
  // Read when the save goes, which can be after the checks at Save have
  // answered: what is in the fields then, not when Save was pressed.
  const latestArgs = useLatest(args)

  const kindId = `${id}-kind`
  const phoneId = `${id}-phone`
  const emailId = `${id}-email`
  const abnId = `${id}-abn`
  const addressHeadingId = `${id}-address-heading`
  const formId = `${id}-form`

  // Anything changed? The sheet then asks before a close throws it away; it
  // is locked against a swipe while the form is open either way.
  const pending = args()
  const [openedNumber] = useState(numberText)
  // Judged by what the person changed, not by what a save would write: a
  // lone saved state ("ACT" with no street) is mended by any save, and
  // opening the form must not count as changing it.
  const hasChanges =
    kind !== client.kind ||
    name.trim() !== client.name.trim() ||
    numberText !== openedNumber ||
    (kind === 'business' && changed(address.state, savedAddress.state)) ||
    Object.keys(pending).some(
      (key) =>
        !['businessId', 'clientId', 'kind', 'name', 'state'].includes(key),
    )
  // Not "Discard your changes?" while it saves: a save waiting for signal
  // still lands, so they would not be discarded. ✕ just closes the sheet.
  useSheetLock(hasChanges && !save.isPending)
  const lineDown = useLineDown()
  const lineDownId = useId()

  return (
    <SaveWarningsProvider value={warnings}>
      <div className={`${SHEET_BODY_ABOVE_FOOTER} pt-3`}>
        {header}
        <form
          id={formId}
          className="mt-3 flex flex-col gap-3 pb-2"
          onSubmit={(e) => {
            if (numberProblem) {
              e.preventDefault()
              return
            }
            return warnings.guard(e, () =>
              save.mutateAsync(latestArgs.current()),
            )
          }}
        >
          {/* Not a WrappedField: its <label> would name only the first
            segment. */}
          <div className="flex flex-col gap-1.5">
            <span id={kindId} className="section-label">
              Client type
            </span>
            <Segmented
              kind="choice"
              labelledBy={kindId}
              value={kind}
              onChange={setKind}
              options={KIND_CHOICES}
            />
          </div>
          <WrappedField
            label={kind === 'business' ? 'Company name' : 'Client name'}
          >
            <TextInput value={name} onChange={setName} required />
          </WrappedField>
          {/* Given automatically. Only the owner changes one, to match the
            number an old system gave the client; everyone else sees it. */}
          {canRenumber ? (
            <>
              <WrappedField label="Client number">
                <TextInput
                  value={numberText}
                  onChange={setNumberText}
                  inputMode="numeric"
                />
              </WrappedField>
              {numberProblem ? (
                <FieldMessage tone="error" className="-mt-1.5">
                  {numberProblem}
                </FieldMessage>
              ) : (
                <p className="-mt-1.5 text-caption text-muted">
                  Given automatically. Change it only to match another system.
                </p>
              )}
            </>
          ) : (
            client.clientNumber !== undefined && (
              <div className="flex flex-col gap-1.5">
                <span className="section-label">Client number</span>
                <p className="flex h-11 items-center rounded-xl bg-surface-3 px-3.5 text-[16px] tabular-nums text-ink">
                  {clientNumberLabel(client.clientNumber)}
                </p>
              </div>
            )
          )}
          <div className="flex flex-col gap-1.5">
            <span className="section-label">Tags (optional)</span>
            <TagInput
              value={tags}
              onChange={setTags}
              suggestions={suggestions}
              label="Tags"
            />
          </div>
          {kind === 'business' && (
            <>
              <FormField id={abnId} label="ABN (optional)" size="md">
                <AbnInput
                  id={abnId}
                  value={abn}
                  onChange={setAbn}
                  initial={client.abn ? formatAbn(client.abn) : ''}
                  size="md"
                />
              </FormField>
              <WrappedField label="Contact person (optional)">
                <TextInput value={contactPerson} onChange={setContactPerson} />
              </WrappedField>
              {/* Outside the label, which it would otherwise become part of. What
                saving will do to the person already in the field, when it is not
                simply correcting their name: they are never removed. */}
              {contactPersonBefore.trim() !== '' &&
                !sameName(contactPerson, contactPersonBefore) &&
                !isNameCorrection(contactPersonBefore, contactPerson) && (
                  <p className="-mt-1.5 text-caption text-muted">
                    {contactPerson.trim() === ''
                      ? `${contactPersonBefore.trim()} stays in Contacts, no longer the contact person.`
                      : `${contactPerson.trim()} becomes the contact person. ${contactPersonBefore.trim()} stays in Contacts.`}
                  </p>
                )}
            </>
          )}
          <FormField
            id={phoneId}
            label={
              kind === 'business' ? 'Main phone (optional)' : 'Phone (optional)'
            }
            size="md"
          >
            <PhoneInput
              id={phoneId}
              value={phone}
              onChange={setPhone}
              initial={client.phone ?? ''}
              businessState={businessState}
              size="md"
            />
          </FormField>
          <FormField
            id={emailId}
            label={
              kind === 'business' ? 'Main email (optional)' : 'Email (optional)'
            }
            size="md"
          >
            <EmailInput
              id={emailId}
              value={email}
              onChange={setEmail}
              initial={client.email ?? ''}
              size="md"
            />
          </FormField>
          {kind === 'business' && (
            // Named as a group, each field by its placeholder's word: the
            // four stacked labels of the new-client sheet would make this
            // small edit form mostly headings.
            <div
              role="group"
              aria-labelledby={addressHeadingId}
              className="flex flex-col gap-2.5"
            >
              <p id={addressHeadingId} className="section-label -mb-1">
                Company address (optional)
              </p>
              <VerifiedAddressFields
                idPrefix={`${id}-address`}
                value={address}
                onChange={(patch) => setAddress((a) => ({ ...a, ...patch }))}
                workState={businessState}
                initial={savedAddress}
                size="md"
                labels="placeholders"
                required={false}
              />
            </div>
          )}
          <SaveWarningsPanel />
        </form>
      </div>

      {/* Pinned below the fields, so Save is in reach with the keyboard up,
          and a failed save says why just above it, where it is seen. */}
      <div className={`${SHEET_FOOTER} flex flex-col gap-2`}>
        <FormAlert
          error={save.isError ? save.error : null}
          copy={CLIENT_RECORD_COPY}
        />
        {lineDown && (
          <p id={lineDownId} className="text-caption text-ink-2">
            {editSaveWaits('client')[lineDown]}
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            disabled={save.isPending}
            onClick={onDone}
            className={`${SECONDARY_BUTTON_COMPACT} flex-1`}
          >
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            disabled={save.isPending || !hydrated}
            aria-describedby={lineDown ? lineDownId : undefined}
            className={`${PRIMARY_BUTTON_COMPACT} flex-1`}
          >
            {save.isPending ? 'Saving…' : warnings.saveLabel('Save')}
          </button>
        </div>
      </div>
    </SaveWarningsProvider>
  )
}

const CLIENT_RECORD_COPY: ErrorCopy = {
  NO_ACCESS:
    'Could not save: only the business owner can change a client number.',
  CLIENT_NUMBER_TAKEN:
    'Could not save: another client already has that number. Choose another.',
  INVALID_CLIENT_NUMBER:
    'Could not save: a client number is a whole number, like 1916.',
  TOO_MANY_TAGS: 'Could not save: a client can have up to 20 tags.',
  TAG_TOO_LONG: 'Could not save: a tag can be up to 40 letters.',
}
