import { useId, useState } from 'react'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { FormAlert } from '#/components/forms/FormAlert'
import { PhoneInput } from '#/components/forms/PhoneInput'
import {
  SaveWarningsPanel,
  SaveWarningsProvider,
  useLatest,
  useSaveWarnings,
} from '#/components/forms/SaveWarnings'
import { authClient } from '#/lib/auth-client'
import { forgetCachedPages } from '#/lib/rootState'
import type { Id } from '../../../convex/_generated/dataModel'
import { useHydrated } from '#/lib/useHydrated'
import { rq } from '#/lib/routeQueries'
import { saveUserName } from './saveUserName'

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

export function ProfileSection({
  businessId,
  membershipId,
  licenceNumber,
  phone: initialPhone,
  state,
}: {
  businessId: Id<'businesses'>
  membershipId: Id<'memberships'>
  licenceNumber?: string
  phone?: string
  state: string
}) {
  const { data: user } = useSuspenseQuery(rq.currentUser())

  const [name, setName] = useState(user.name)
  const [phone, setPhone] = useState(initialPhone ?? '')
  const [licence, setLicence] = useState(licenceNumber ?? '')

  const hydrated = useHydrated()
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

  const convexSetLicence = useConvexMutation(api.memberships.setLicence)
  const saveLicence = useMutation({
    mutationFn: (args: {
      businessId: Id<'businesses'>
      membershipId: Id<'memberships'>
      licenceNumber: string
    }) => convexSetLicence(args),
  })

  return (
    <>
      <h2 className="section-label mb-2">Your details</h2>
      <SaveWarningsProvider value={warnings}>
        <form
          className="flex flex-col gap-3 rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation"
          onSubmit={(e) =>
            warnings.guard(e, () =>
              Promise.all([
                saveName.mutateAsync(latest.current.name),
                saveProfile.mutateAsync({
                  businessId,
                  membershipId,
                  phone: latest.current.phone.trim() || undefined,
                }),
              ]),
            )
          }
        >
          <label className="flex flex-col gap-1.5">
            <span className="section-label">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="section-label">Email</span>
            <p className="flex h-12 w-full items-center rounded-xl bg-surface-3 px-3.5 text-[16px] text-muted">
              {user.email}
            </p>
          </label>
          {/* Printed on the reports this person signs ("Contact the
            Inspector") and dialled from them, so it gets the same checks as
            a client's number. Label by htmlFor: the lines under the input
            and their fix button must not become part of its name. */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={phoneId} className="section-label">
              Phone (optional)
            </label>
            <div>
              <PhoneInput
                id={phoneId}
                value={phone}
                onChange={setPhone}
                initial={initialPhone ?? ''}
                businessState={state}
              />
            </div>
          </div>
          <FormAlert
            error={
              saveProfile.isError
                ? saveProfile.error
                : saveName.isError
                  ? saveName.error
                  : null
            }
          />
          <SaveWarningsPanel />
          <button
            type="submit"
            disabled={saveName.isPending || saveProfile.isPending || !hydrated}
            className="h-11 w-full rounded-xl bg-surface-2 text-[16px] font-semibold text-ink transition active:scale-[.975] disabled:opacity-50"
          >
            {saveName.isPending || saveProfile.isPending
              ? 'Saving…'
              : warnings.saveLabel(
                  // Both halves, not either: a name refused beside a phone
                  // saved is not "Saved".
                  saveName.isSuccess && saveProfile.isSuccess
                    ? 'Saved'
                    : 'Save',
                )}
          </button>
        </form>
      </SaveWarningsProvider>

      <h2 className="section-label mb-2 mt-6">Your licence</h2>
      <form
        className="rounded-2xl border border-hairline bg-surface p-3.5 shadow-elevation"
        onSubmit={(e) => {
          e.preventDefault()
          saveLicence.mutate({
            businessId,
            membershipId,
            licenceNumber: licence,
          })
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="section-label">
            {LICENCE_LABEL[state] ?? 'Licence number'}
          </span>
          <input
            value={licence}
            onChange={(e) => setLicence(e.target.value)}
            className="h-12 w-full rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
          />
        </label>
        <p className="mt-2 text-caption text-muted">
          Printed on every report and certificate you finalise.
        </p>
        <FormAlert
          error={saveLicence.isError ? saveLicence.error : null}
          className="mt-3"
        />
        <button
          type="submit"
          disabled={saveLicence.isPending || !hydrated}
          className="mt-3 h-11 w-full rounded-xl bg-surface-2 text-[16px] font-semibold text-ink transition active:scale-[.975] disabled:opacity-50"
        >
          {saveLicence.isPending
            ? 'Saving…'
            : saveLicence.isSuccess
              ? 'Saved'
              : 'Save'}
        </button>
      </form>

      <button
        type="button"
        onClick={async () => {
          await authClient.signOut()
          await forgetCachedPages()
          // A full reload, not a soft navigation, so every cached query and
          // component tied to the old identity is gone rather than briefly
          // visible to whoever signs in next on this device.
          window.location.href = '/login'
        }}
        className="mt-6 h-12 w-full rounded-xl bg-surface-2 text-[17px] font-semibold text-red transition active:scale-[.975]"
      >
        Sign out
      </button>
    </>
  )
}
