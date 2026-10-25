import { useId, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { Drawer } from 'vaul'
import {
  SHEET_BODY,
  SheetLock,
  SheetShell,
} from '#/components/primitives/Sheet'
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
import { useLineDown } from '#/lib/offline/useLineDown'
import type { LineDown } from '#/lib/offline/useLineDown'
import { PRIMARY_BUTTON } from '#/components/primitives/buttons'

/**
 * Above Save client while the line is down (lib/offline/useLineDown.ts):
 * the save isn't refused, it waits in the Convex client until the line is
 * back, for as long as the app stays open.
 */
const SAVE_WAITS: Record<LineDown, string> = {
  'no-signal':
    'No signal — the client is saved when you have signal. Keep PestM8 open until then.',
  unreachable:
    'Could not reach PestM8 — it’s saved once it can. Keep PestM8 open until then.',
}

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
  const lineDown = useLineDown()
  const lineDownId = useId()
  // The address, email and phone checks at Save: what may be wrong is listed
  // above the button, and a second press saves it as it is.
  const saveWarnings = useSaveWarnings()

  // Closed with nothing typed, or with what was typed discarded (the sheet
  // asks first: SheetLock below). Either way it opens empty next time, and
  // warnings about a draft walked away from are not news then.
  function close() {
    saveWarnings.reset()
    setValue(empty)
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
      {/* Anything typed locks the sheet against a swipe, and ✕ asks. */}
      <SheetLock
        changed={JSON.stringify(value) !== JSON.stringify(empty)}
        whileUnchanged={false}
      />
      <SaveWarningsProvider value={saveWarnings}>
        <form
          className={`${SHEET_BODY} pt-3`}
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

          <div className="mt-5">
            {lineDown && (
              <p id={lineDownId} className="mb-2 text-caption text-ink-2">
                {SAVE_WAITS[lineDown]}
              </p>
            )}
            <button
              type="submit"
              disabled={create.isPending || !hydrated}
              aria-describedby={lineDown ? lineDownId : undefined}
              className={`${PRIMARY_BUTTON} w-full`}
            >
              {create.isPending
                ? 'Saving…'
                : saveWarnings.saveLabel('Save client')}
            </button>
          </div>
        </form>
      </SaveWarningsProvider>
    </SheetShell>
  )
}
