import { useId, useState } from 'react'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../convex/_generated/api'
import { AbnInput } from '#/components/clients/AbnInput'
import { FormAlert } from '#/components/forms/FormAlert'
import { AU_STATES, TIMEZONE_BY_STATE } from '#/lib/au'
import { useHydrated } from '#/lib/useHydrated'

export const Route = createFileRoute('/onboarding')({
  beforeLoad: async ({ context }) => {
    if (!context.isAuthenticated) throw redirect({ to: '/login' })
    // Creating a business comes after two-step sign-in, like everything
    // else the server does for a signed-in person — asked here rather than
    // discovered on Create, so nobody fills the form in first.
    const status = await context.queryClient.ensureQueryData(
      convexQuery(api.auth.twoFactorStatus, {}),
    )
    if (status.required && !status.enabled) {
      throw redirect({ to: '/two-step', search: { next: '/onboarding' } })
    }
  },
  component: OnboardingPage,
})

/** Nothing is saved yet here, so "Could not create", not "Could not save". */
const CREATE_COPY = {
  INVALID_ABN:
    'Could not create the business: the ABN does not pass the ATO check. Check its 11 digits.',
  offline:
    'Could not create the business: this device is offline. Try again when you have signal.',
  default: 'Could not create the business. Check the name and try again.',
}

function OnboardingPage() {
  const hydrated = useHydrated()

  const router = useRouter()
  const abnId = useId()
  const [name, setName] = useState('')
  const [state, setState] = useState<string>('WA')
  const [abn, setAbn] = useState('')

  // useConvexMutation returns a callable interface carrying extra properties
  // (.withOptimisticUpdate), which defeats TanStack's return-type inference —
  // the plain arrow restores it.
  const convexCreateBusiness = useConvexMutation(api.businesses.create)

  const createBusiness = useMutation({
    mutationFn: (args: {
      name: string
      state: string
      timezone: string
      abn?: string
    }) => convexCreateBusiness(args),
    onSuccess: async ({ slug }) => {
      await router.invalidate()
      await router.navigate({
        to: '/$businessSlug/schedule',
        params: { businessSlug: slug },
      })
    },
  })

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col justify-center px-6">
      <p className="section-label mb-2">Set up</p>
      <h1 className="text-page-title text-ink">Your business</h1>
      <p className="mt-2 text-body text-muted">
        You can invite your team once this is created.
      </p>

      <form
        className="mt-8 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          createBusiness.mutate({
            name,
            state,
            timezone: TIMEZONE_BY_STATE[state],
            abn: abn.trim() || undefined,
          })
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="section-label">Business name</span>
          <input
            value={name}
            required
            onChange={(e) => setName(e.target.value)}
            className="h-12 rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="section-label">State</span>
          <select
            value={state}
            onChange={(e) => setState(e.target.value)}
            className="h-12 rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
          >
            {AU_STATES.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </select>
          <span className="text-caption text-muted">
            Sets your timezone and how licence fields are labelled.
          </span>
        </label>

        {/* Checked as it is typed, with the rule businesses.create enforces:
            it heads every compliance document, and a wrong one here used to
            come back only as "Could not create the business". */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={abnId} className="section-label">
            ABN (optional)
          </label>
          <div>
            <AbnInput id={abnId} value={abn} onChange={setAbn} />
          </div>
        </div>

        <FormAlert
          error={createBusiness.isError ? createBusiness.error : null}
          copy={CREATE_COPY}
        />

        <button
          type="submit"
          disabled={createBusiness.isPending || !hydrated}
          className="mt-2 h-12 rounded-xl bg-red text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
        >
          {createBusiness.isPending ? 'Creating…' : 'Create business'}
        </button>
      </form>
    </main>
  )
}
