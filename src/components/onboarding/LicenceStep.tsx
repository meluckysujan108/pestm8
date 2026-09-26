import { useId, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { FormAlert } from '#/components/forms/FormAlert'
import { fieldInputClass } from '#/components/forms/FormField'
import { FieldRow, SettingsGroup } from '#/components/settings/ui'
import { LICENCE_LABEL } from '#/lib/au'
import { useHydrated } from '#/lib/useHydrated'
import { ReportPreview } from './ReportPreview'
import { AsideButton, ContinueButton, SetupFrame } from './SetupFrame'
import type { BusinessRecord } from '#/components/settings/BusinessSection'

const SAVE_COPY = {
  offline:
    'Could not save: this device is offline. Try again when you have signal, or add it later.',
  default: 'Could not save. Check your signal and try again.',
}

/**
 * Step 3: the owner's own licence number — the one printed on what they sign
 * (`memberships.licenceNumber`, set as Settings → My licence sets it).
 *
 * Asked here because it is the one gap that stops work: a termite
 * certificate or a timber pest report will not finalise without it, and
 * finding that out on site, at the last step, is the worst time to. It is
 * not the licence wallet (photos of cards, expiry dates), which is the
 * person's own and lives in Settings.
 */
export function LicenceStep({
  business,
  onBack,
  onDone,
  onLater,
}: {
  business: BusinessRecord
  onBack: () => void
  onDone: () => Promise<void>
  onLater: () => void
}) {
  const hydrated = useHydrated()
  const inputId = useId()
  const saved = business.membership.licenceNumber ?? ''
  const [value, setValue] = useState(saved)

  const setLicence = useConvexMutation(api.memberships.setLicence)
  const save = useMutation({
    mutationFn: async (licenceNumber: string) => {
      // Written when changed — cleared too, if they clear it. Blank with
      // nothing saved moves on without writing anything.
      if (licenceNumber.trim() !== saved.trim()) {
        await setLicence({
          businessId: business._id,
          membershipId: business.membership._id,
          licenceNumber,
        })
      }
      await onDone()
    },
  })

  return (
    <SetupFrame
      step="licence"
      title="What’s your licence number?"
      lede="Printed on every report and certificate you sign. Termite certificates, timber pest inspections and your own custom forms can’t be finalised without it."
      onBack={onBack}
      aside={<AsideButton onClick={onLater}>Add later</AsideButton>}
    >
      <form
        className="mt-6 flex flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate(value)
        }}
      >
        <ReportPreview
          name={business.name}
          logoUrl={business.logoUrl}
          email={business.email}
          phone={business.phone}
          abn={business.abn}
          state={business.state}
          licenceNumber={value}
          focus="licence"
        />

        <SettingsGroup
          className="mt-6"
          footer="Yours, as it is on your card. Each person you invite adds their own."
        >
          <FieldRow
            id={inputId}
            label={LICENCE_LABEL[business.state] ?? 'Licence number'}
          >
            <input
              id={inputId}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              enterKeyHint="done"
              maxLength={64}
              className={fieldInputClass()}
            />
          </FieldRow>
        </SettingsGroup>

        <FormAlert
          error={save.isError ? save.error : null}
          copy={SAVE_COPY}
          className="mt-4"
        />

        <ContinueButton pending={save.isPending} disabled={!hydrated} />
      </form>
    </SetupFrame>
  )
}
