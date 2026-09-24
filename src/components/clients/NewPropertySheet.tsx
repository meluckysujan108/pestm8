import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { Drawer } from 'vaul'
import { X } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import {
  EMPTY_NEW_CLIENT,
  NewClientFields,
  abnRefusal,
  newClientArgs,
} from './NewClientFields'
import type { NewClientArgs, NewClientFieldsValue } from './NewClientFields'
import type { Id } from '../../../convex/_generated/dataModel'
import { useHydrated } from '#/lib/useHydrated'

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

  const hydrated = useHydrated()

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
    <Drawer.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92vh] w-full max-w-[460px] flex-col rounded-t-[22px] bg-canvas outline-none">
          <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-hairline" />

          <form
            className="flex-1 overflow-y-auto px-4 pb-[calc(24px+env(safe-area-inset-bottom))] pt-3"
            onSubmit={(e) => {
              e.preventDefault()
              create.mutate({ businessId, ...newClientArgs(value) })
            }}
          >
            <Drawer.Title className="text-sheet-title text-ink">
              New client
            </Drawer.Title>

            <NewClientFields
              value={value}
              onChange={(patch) => setValue((v) => ({ ...v, ...patch }))}
              biasState={businessState}
            />

            {create.isError && (
              <p
                role="alert"
                className="mt-3 rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-amber-ink"
              >
                {abnRefusal(create.error) ?? 'Could not save this client.'}
              </p>
            )}

            <button
              type="submit"
              disabled={create.isPending || !hydrated}
              className="mt-5 h-12 w-full rounded-xl bg-red text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
            >
              {create.isPending ? 'Saving…' : 'Save client'}
            </button>
          </form>

          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-full bg-surface-2 text-muted"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
