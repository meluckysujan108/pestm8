import { useState } from 'react'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useConvexMutation } from '@convex-dev/react-query'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../convex/_generated/api'
import { AU_STATES, TIMEZONE_BY_STATE } from '#/lib/au'
import { useHydrated } from '#/lib/useHydrated'

export const Route = createFileRoute('/onboarding')({
  beforeLoad: ({ context }) => {
    if (!context.isAuthenticated) throw redirect({ to: '/login' })
  },
  component: OnboardingPage,
})

function OnboardingPage() {
  const hydrated = useHydrated()

  const router = useRouter()
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

        <label className="flex flex-col gap-1.5">
          <span className="section-label">ABN (optional)</span>
          <input
            value={abn}
            inputMode="numeric"
            onChange={(e) => setAbn(e.target.value)}
            className="h-12 rounded-xl bg-surface-3 px-3.5 text-[16px] text-ink outline-none focus:ring-2 focus:ring-blue"
          />
        </label>

        {createBusiness.isError && (
          <p
            role="alert"
            className="rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-amber-ink"
          >
            Could not create the business. Check the name and try again.
          </p>
        )}

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
