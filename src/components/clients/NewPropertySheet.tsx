import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { Drawer } from 'vaul'
import { SheetShell } from '#/components/primitives/Sheet'
import { api } from '../../../convex/_generated/api'
import { FormAlert } from '#/components/forms/FormAlert'
import {
  SaveWarningsPanel,
  SaveWarningsProvider,
  useLatest,
  useSaveWarnings,
} from '#/components/forms/SaveWarnings'
import {
  EMPTY_NEW_CLIENT,
  NEW_CLIENT_ERROR_COPY,
  NewClientFields,
  newClientArgs,
} from './NewClientFields'
import type { NewClientArgs, NewClientFieldsValue } from './NewClientFields'
import type { Id } from '../../../convex/_generated/dataModel'
import { useHydrated } from '#/lib/useHydrated'
import { PRIMARY_BUTTON } from '#/components/primitives/buttons'

/**
 * Creates a client and its first property together in one step — a client
 * without at least one address is meaningless in this domain, so splitting
 * "new client" from "add first property" into two screens would cost a step
 * for zero benefit.
 */
export function NewPropertySheet({
  businessId,
  open,
  onClose,
}: {
  businessId: Id<'businesses'>
  open: boolean
  onClose: () => void
}) {
  const businessState = useRouteContext({
    from: '/$businessSlug',
    select: (context) => context.business.state,
  })
  // Starts in the business's own state, as "Add another property" does: a
  // Darwin address typed by hand and left on WA is how prod came to hold
  // "Fannybay WA".
  const empty: NewClientFieldsValue = {
    ...EMPTY_NEW_CLIENT,
    state: businessState || EMPTY_NEW_CLIENT.state,
  }
  const [value, setValue] = useState<NewClientFieldsValue>(empty)
  // Read when the save runs, which may be after the checks at Save have
  // answered: what was typed while they ran is what gets saved.
  const latestValue = useLatest(value)

  const hydrated = useHydrated()
  // The address, email and phone checks at Save: what may be wrong is listed
  // above the button, and a second press saves it as it is.
  const saveWarnings = useSaveWarnings()

  // Warnings about a draft the person walked away from are not news when the
  // sheet opens again; the next press checks afresh.
  function close() {
    saveWarnings.reset()
    onClose()
  }

  const convexCreate = useConvexMutation(api.properties.create)
  const create = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'> } & NewClientArgs) =>
      convexCreate(args),
    onSuccess: () => {
      setValue(empty)
      onClose()
    },
  })

  return (
    <SheetShell open={open} onClose={close}>
      <SaveWarningsProvider value={saveWarnings}>
        <form
          className="flex-1 overflow-y-auto px-4 pb-[calc(24px+env(safe-area-inset-bottom))] pt-3"
          onSubmit={(e) =>
            // mutateAsync, so a save that fails keeps the warnings already
            // confirmed and Retry does not ask about them again.
            saveWarnings.guard(e, () =>
              create.mutateAsync({
                businessId,
                ...newClientArgs(latestValue.current),
              }),
            )
          }
        >
          <Drawer.Title className="text-sheet-title text-ink">
            New client
          </Drawer.Title>

          <NewClientFields
            value={value}
            onChange={(patch) => setValue((v) => ({ ...v, ...patch }))}
            businessState={businessState}
          />

          <FormAlert
            error={create.isError ? create.error : null}
            copy={NEW_CLIENT_ERROR_COPY}
            className="mt-3"
          />
          <SaveWarningsPanel className="mt-3" />

          <button
            type="submit"
            disabled={create.isPending || !hydrated}
            className={`${PRIMARY_BUTTON} mt-5 w-full`}
          >
            {create.isPending
              ? 'Saving…'
              : saveWarnings.saveLabel('Save client')}
          </button>
        </form>
      </SaveWarningsProvider>
    </SheetShell>
  )
}
