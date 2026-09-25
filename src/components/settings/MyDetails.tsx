import { useId, useState } from 'react'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { FormAlert } from '#/components/forms/FormAlert'
import { fieldInputClass } from '#/components/forms/FormField'
import { PhoneInput } from '#/components/forms/PhoneInput'
import {
  SaveWarningsPanel,
  SaveWarningsProvider,
  useLatest,
  useSaveWarnings,
} from '#/components/forms/SaveWarnings'
import { authClient } from '#/lib/auth-client'
import { rq } from '#/lib/routeQueries'
import { useHydrated } from '#/lib/useHydrated'
import { FIELD_LABEL, FieldRow, SaveBar, SettingsGroup } from './ui'
import { saveUserName } from './saveUserName'
import { useJustSaved } from './useJustSaved'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * My details: name, email and phone — the form that needs the signed-in
 * user, so it suspends on it; the page's header renders without it.
 */
export function MyDetailsForm({
  businessId,
  membershipId,
  phone: initialPhone,
  state,
}: {
  businessId: Id<'businesses'>
  membershipId: Id<'memberships'>
  phone?: string
  state: string
}) {
  const { data: user } = useSuspenseQuery(rq.currentUser())

  const [name, setName] = useState(user.name)
  const [phone, setPhone] = useState(initialPhone ?? '')
  // What the fields held at the last save that went through, so Save goes
  // away once they match it. Not the route's membership, which is the one
  // the page opened with and does not follow a save.
  const [saved, setSaved] = useState({
    name: user.name,
    phone: initialPhone ?? '',
  })

  const hydrated = useHydrated()
  const nameId = useId()
  const phoneId = useId()
  const warnings = useSaveWarnings()

  const saveName = useMutation({
    mutationFn: (newName: string) =>
      saveUserName(newName, user.name, (args) => authClient.updateUser(args)),
  })

  const convexSetProfile = useConvexMutation(api.memberships.setProfile)
  const saveProfile = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      membershipId: Id<'memberships'>
      phone?: string
    }) => convexSetProfile(args),
  })

  // Read when the save goes, after any checks at Save have answered, like
  // every other form's.
  const latest = useLatest({ name, phone })

  const dirty = name !== saved.name || phone !== saved.phone
  const pending = saveName.isPending || saveProfile.isPending
  // Both halves, not either: a name refused beside a phone saved is not
  // "Saved".
  const done = saveName.isSuccess && saveProfile.isSuccess
  const justSaved = useJustSaved(done)

  return (
    <SaveWarningsProvider value={warnings}>
      <form
        onSubmit={(e) =>
          warnings.guard(e, async () => {
            const sent = latest.current
            await Promise.all([
              saveName.mutateAsync(sent.name),
              saveProfile.mutateAsync({
                businessId,
                membershipId,
                phone: sent.phone.trim() || undefined,
              }),
            ])
            setSaved(sent)
          })
        }
      >
        <SettingsGroup
          title="Your details"
          footer="Your phone is printed on the reports you sign."
        >
          <FieldRow id={nameId} label="Name">
            <input
              id={nameId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              className={fieldInputClass()}
            />
          </FieldRow>
          {/* Read-only: it is what they sign in with, and not changed
              here. */}
          <div className="flex flex-col gap-1.5 px-3.5 py-3">
            <span className={FIELD_LABEL}>Email</span>
            <p className="break-all text-[16px] text-muted">{user.email}</p>
          </div>
          {/* Printed on the reports this person signs ("Contact the
              Inspector") and dialled from them, so it gets the same checks
              as a client's number. Labelled by htmlFor (FieldRow): the lines
              under the input and their fix button must not become part of
              its name. */}
          <FieldRow id={phoneId} label="Phone (optional)">
            <PhoneInput
              id={phoneId}
              value={phone}
              onChange={setPhone}
              initial={saved.phone}
              businessState={state}
            />
          </FieldRow>
        </SettingsGroup>
        <FormAlert
          error={
            saveProfile.isError
              ? saveProfile.error
              : saveName.isError
                ? saveName.error
                : null
          }
          className="mt-3"
        />
        <SaveWarningsPanel className="mt-3" />
        <SaveBar
          visible={
            dirty ||
            pending ||
            justSaved ||
            warnings.checking ||
            warnings.warnings.length > 0
          }
          pending={pending}
          label={warnings.saveLabel(done && !dirty ? 'Saved' : 'Save')}
          disabled={!hydrated}
        />
      </form>
    </SaveWarningsProvider>
  )
}
