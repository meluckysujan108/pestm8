import { useId, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import {
  SHEET_BODY_ABOVE_FOOTER,
  SHEET_FOOTER,
  useSheetLock,
} from '#/components/primitives/Sheet'
import { api } from '../../../convex/_generated/api'
import { FormAlert } from '#/components/forms/FormAlert'
import {
  SaveWarningsPanel,
  SaveWarningsProvider,
  useLatest,
  useSaveWarnings,
} from '#/components/forms/SaveWarnings'
import type { AddressCheck } from '#/components/forms/VerifiedAddressFields'
import {
  PRIMARY_BUTTON_COMPACT,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'
import { PropertyFields } from '#/components/clients/PropertyFields'
import type { PropertyFieldsValue } from '#/components/clients/PropertyFields'
import { changed } from '#/components/clients/clientEdits'
import {
  propertyEditArgs,
  propertyFieldsOf,
} from '#/components/clients/propertyEditArgs'
import type { PropertyEditArgs } from '#/components/clients/propertyEditArgs'
import { useHydrated } from '#/lib/useHydrated'
import { useLineDown } from '#/lib/offline/useLineDown'
import { editSaveWaits } from '#/lib/editSaveWaits'
import type { Doc, Id } from '../../../convex/_generated/dataModel'

/**
 * A property's own details as a whole-sheet edit: the job sheet's Edit →
 * Property details. The client sheet's property card on a sheet of its own
 * — the same `PropertyFields`, with visible labels — and never a Delete,
 * which would bin the very job it was opened from.
 */
export function PropertyEditMode({
  businessId,
  businessState,
  clientKind,
  property,
  header,
  onDone,
}: {
  businessId: Id<'businesses'>
  /** Where the business works: the address is checked against it. */
  businessState: string
  /** A business's property has a site contact; a homeowner's doesn't. */
  clientKind: Doc<'clients'>['kind']
  /** As it was when the form opened, so a change made elsewhere meanwhile
   * to a field left alone here is not sent back. */
  property: Pick<
    Doc<'properties'>,
    | '_id'
    | 'addressLine'
    | 'suburb'
    | 'state'
    | 'postcode'
    | 'siteContactName'
    | 'siteContactPhone'
  >
  /** The sheet's own heading, drawn above the fields. */
  header: React.ReactNode
  onDone: () => void
}) {
  const [saved] = useState(() => propertyFieldsOf(property))
  const [value, setValue] = useState<PropertyFieldsValue>(saved)
  const [addressCheck, setAddressCheck] = useState<AddressCheck>('typed')
  const hydrated = useHydrated()
  const warnings = useSaveWarnings()
  const lineDown = useLineDown()
  const lineDownId = useId()
  const formId = useId()

  const convexUpdate = useConvexMutation(api.properties.update)
  const save = useMutation({
    mutationFn: (args: PropertyEditArgs) => convexUpdate(args),
    onSuccess: onDone,
  })
  // Read when the save goes, after any checks at Save have answered.
  const latestArgs = useLatest(() =>
    propertyEditArgs({ businessId, property, value, addressCheck, clientKind }),
  )
  // Not "Discard your changes?" while it saves: a save waiting for signal
  // still lands, so they would not be discarded. ✕ just closes the sheet.
  useSheetLock(
    (Object.keys(saved) as Array<keyof PropertyFieldsValue>).some((key) =>
      changed(value[key], saved[key]),
    ) && !save.isPending,
  )

  return (
    <SaveWarningsProvider value={warnings}>
      <div className={`${SHEET_BODY_ABOVE_FOOTER} pt-3`}>
        {header}
        <form
          id={formId}
          className="flex flex-col pb-2"
          onSubmit={(e) =>
            warnings.guard(e, () => save.mutateAsync(latestArgs.current()))
          }
        >
          <PropertyFields
            value={value}
            onChange={(patch) => setValue((v) => ({ ...v, ...patch }))}
            initial={saved}
            clientKind={clientKind}
            businessState={businessState}
            onCheckChange={setAddressCheck}
            labels="visible"
          />
          {/* Not fields here: a site note shows before every visit, where
              a line on the property would be missed. Grey, not muted, to be
              read in sun. */}
          <p className="mt-4 text-caption text-grey-ink">
            Gate codes, keys and dogs go in a site note, under Notes, so they
            show before every visit here.
          </p>
          <SaveWarningsPanel className="mt-4" />
        </form>
      </div>

      {/* Pinned below the fields, so Save is in reach with the keyboard up,
          and a failed save says why just above it, where it is seen. */}
      <div className={`${SHEET_FOOTER} flex flex-col gap-2`}>
        <FormAlert error={save.isError ? save.error : null} />
        {lineDown && (
          <p id={lineDownId} className="text-caption text-ink-2">
            {editSaveWaits('property')[lineDown]}
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            // Not while it saves: the form would close and the save land
            // anyway, a cancel that did not cancel.
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
