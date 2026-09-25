import { useId, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { FormAlert } from '#/components/forms/FormAlert'
import { fieldInputClass } from '#/components/forms/FormField'
import { useHydrated } from '#/lib/useHydrated'
import { FieldRow, SaveBar, SettingsGroup } from './ui'
import { useJustSaved } from './useJustSaved'
import type { ReactNode } from 'react'
import type { Id } from '../../../convex/_generated/dataModel'

/** Licence field labelling is state-based, so the label follows the tenant. */
const LICENCE_LABEL: Record<string, string> = {
  WA: 'Pest management technician licence',
  NSW: 'Pest management technician licence',
  QLD: 'Pest management technician licence (PMT)',
  VIC: 'Pest control licence',
  SA: 'Pest controller licence',
  TAS: 'Pest control operator licence',
  NT: 'Pest management technician licence',
  ACT: 'Pest management technician licence',
}

/**
 * The licence number printed on this person's reports, and its Save.
 *
 * Needs nothing but the route's membership and business, so it renders with
 * no signal, beside the licence document (`children`), which must not wait
 * on anything either. The two are separate forms: the number saves when Save
 * is pressed, a document the moment it is picked.
 *
 * `children` go between the form and its Save bar, so the bar stays at the
 * foot of the page, pinned above the dock, rather than between two groups.
 */
export function MyLicenceNumber({
  businessId,
  membershipId,
  licenceNumber,
  state,
  children,
}: {
  businessId: Id<'businesses'>
  membershipId: Id<'memberships'>
  licenceNumber?: string
  state: string
  children?: ReactNode
}) {
  const formId = useId()
  const inputId = useId()
  const [value, setValue] = useState(licenceNumber ?? '')
  // The number as last saved, so Save goes away once the field matches it.
  // The route's membership is the one the page opened with and does not
  // follow a save.
  const [saved, setSaved] = useState(licenceNumber ?? '')
  const hydrated = useHydrated()

  const convexSetLicence = useConvexMutation(api.memberships.setLicence)
  const save = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      membershipId: Id<'memberships'>
      licenceNumber: string
    }) => convexSetLicence(args),
    onSuccess: (_result, args) => setSaved(args.licenceNumber),
  })

  const dirty = value !== saved
  const justSaved = useJustSaved(save.isSuccess)

  return (
    <>
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate({ businessId, membershipId, licenceNumber: value })
        }}
      >
        <SettingsGroup
          title="On your reports"
          footer="Printed on every report and certificate you finalise."
        >
          <FieldRow
            id={inputId}
            label={LICENCE_LABEL[state] ?? 'Licence number'}
          >
            <input
              id={inputId}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
              className={fieldInputClass()}
            />
          </FieldRow>
        </SettingsGroup>
        <FormAlert error={save.isError ? save.error : null} className="mt-3" />
      </form>
      {children}
      <SaveBar
        form={formId}
        visible={dirty || save.isPending || justSaved}
        pending={save.isPending}
        label={save.isSuccess && !dirty ? 'Saved' : 'Save'}
        disabled={!hydrated}
      />
    </>
  )
}
