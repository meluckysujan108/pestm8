import { useEffect, useId, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { AbnInput } from '#/components/clients/AbnInput'
import { FormAlert } from '#/components/forms/FormAlert'
import { fieldInputClass } from '#/components/forms/FormField'
import { FieldRow, SettingsGroup } from '#/components/settings/ui'
import { TIMEZONE_BY_STATE, stateFromTimeZone } from '#/lib/au'
import { useHydrated } from '#/lib/useHydrated'
import { ReportPreview } from './ReportPreview'
import { ContinueButton, SetupFrame } from './SetupFrame'
import { StatePicker } from './StatePicker'
import type { ReactNode } from 'react'
import type { BusinessRecord } from '#/components/settings/BusinessSection'

/** Nothing is saved yet when creating, so "Could not create". */
const CREATE_COPY = {
  INVALID_ABN:
    'That ABN does not pass the ATO check. Check its 11 digits, or leave it blank for now.',
  INVALID_NAME: 'Give the business a name with at least one letter or number.',
  BUSINESS_INVITE_REQUIRED:
    'This account has no open link to set up a business. If you’ve set one up already, close this and open PestM8 again to carry on.',
  offline:
    'Could not create the business: this device is offline. Try again when you have signal.',
  default: 'Could not create the business. Check the name and try again.',
}

const UPDATE_COPY = {
  ...CREATE_COPY,
  offline:
    'Could not save: this device is offline. Try again when you have signal.',
  default: 'Could not save. Check the name and try again.',
}

/**
 * Step 1: the business's name, state and ABN — creating it, or, come back to
 * from the next step, changing what was entered.
 *
 * The state starts as the phone's time zone suggests (Perth → WA), since
 * nearly everyone sets up where they work; one tap puts it right. It is read
 * after hydration, because the server's clock is not the phone's.
 */
export function BusinessStep({
  business,
  onDone,
  footer,
}: {
  /** Absent while creating. */
  business: BusinessRecord | null
  onDone: (slug: string) => Promise<void> | void
  footer?: ReactNode
}) {
  const hydrated = useHydrated()
  const nameId = useId()
  const abnId = useId()
  const stateLabelId = useId()

  const [name, setName] = useState(business?.name ?? '')
  const [state, setState] = useState(business?.state ?? 'WA')
  const [abn, setAbn] = useState(business?.abn ?? '')
  const [guessed, setGuessed] = useState(false)
  const chosen = useRef(false)

  useEffect(() => {
    if (business) return
    const guess = stateFromTimeZone(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    )
    if (guess && !chosen.current) {
      setState(guess)
      setGuessed(true)
    }
  }, [business])

  const create = useConvexMutation(api.businesses.create)
  const update = useConvexMutation(api.businesses.update)
  const save = useMutation({
    mutationFn: async (): Promise<string> => {
      const timezone = TIMEZONE_BY_STATE[state]
      const trimmed = name.trim()
      if (!business) {
        const { slug } = await create({
          name: trimmed,
          state,
          timezone,
          abn: abn.trim() || undefined,
          withSetup: true,
        })
        return slug
      }
      await update({
        businessId: business._id,
        name: trimmed,
        state,
        timezone,
        // Blank clears one saved a moment ago; left out when there was none.
        abn: abn.trim() || (business.abn ? '' : undefined),
      })
      return business.slug
    },
    onSuccess: (slug) => onDone(slug),
  })

  return (
    <SetupFrame
      step="business"
      title="What’s your business called?"
      lede="As it should read at the top of every report you send."
    >
      <form
        className="mt-6 flex flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        <ReportPreview
          name={name}
          abn={abn}
          state={state}
          focus="name"
          logoUrl={business?.logoUrl}
          email={business?.email}
          phone={business?.phone}
          licenceNumber={business?.membership.licenceNumber}
        />

        <SettingsGroup className="mt-6">
          <FieldRow id={nameId} label="Business name">
            <input
              id={nameId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoComplete="organization"
              autoCapitalize="words"
              enterKeyHint="next"
              className={fieldInputClass()}
            />
          </FieldRow>
          <FieldRow
            id={abnId}
            label="ABN (optional)"
            hint="Printed on your reports. You can add it later in Settings."
          >
            <AbnInput
              id={abnId}
              value={abn}
              onChange={setAbn}
              initial={business?.abn}
            />
          </FieldRow>
        </SettingsGroup>

        <p id={stateLabelId} className="section-label mb-2 mt-6 px-1">
          Where you work
        </p>
        <StatePicker
          value={state}
          labelId={stateLabelId}
          guessed={guessed}
          onChange={(code) => {
            chosen.current = true
            setGuessed(false)
            setState(code)
          }}
        />

        <FormAlert
          error={save.isError ? save.error : null}
          copy={business ? UPDATE_COPY : CREATE_COPY}
          className="mt-5"
        />

        <ContinueButton
          pending={save.isPending}
          disabled={!hydrated}
          pendingLabel={business ? 'Saving…' : 'Setting up…'}
        />
        {footer}
      </form>
    </SetupFrame>
  )
}
