import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../../convex/_generated/api'
import { IMPORT_UNDO_DAYS } from '../../../../convex/lib/clientImport'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'
import type { ErrorCopy } from '#/components/forms/describeError'
import type { Id } from '../../../../convex/_generated/dataModel'

/**
 * Undo, as both places that offer it ask it — Recent imports, and the Done
 * screen straight after — so the promise made before the red button is the
 * same wherever it is pressed.
 */

const DAY = 24 * 60 * 60 * 1000

/**
 * Whether an import is still inside its week. The page's to work out:
 * `clientImports.list` says who may undo, and leaves the clock to the
 * browser, because a query that read the time would be cached past the
 * moment the week ran out. The server checks again when it is asked.
 */
export function withinUndoWindow(createdAt: number, now: number): boolean {
  return now - createdAt < IMPORT_UNDO_DAYS * DAY
}

export const UNDO_ERROR_COPY: ErrorCopy = {
  ALREADY_UNDONE: 'This import has already been undone.',
  UNDO_EXPIRED: `It’s more than ${IMPORT_UNDO_DAYS} days since this import, so it can’t be undone any more.`,
  NO_ACCESS:
    'Only the person who ran this import, or the business owner, can undo it.',
  NOT_FOUND: 'That import isn’t there any more.',
  offline:
    'Couldn’t undo: this device is offline. Try again when you have signal.',
  default: 'Couldn’t undo the import. Check your connection and try again.',
}

export function useUndoImport(businessId: Id<'businesses'>) {
  const undo = useConvexMutation(api.clientImports.undo)
  const mutation = useMutation({
    mutationFn: (importId: Id<'clientImports'>) =>
      undo({ businessId, importId }),
  })
  /** The import the dialog is asking about, or null while it is shut. */
  const [asking, setAsking] = useState<Id<'clientImports'> | null>(null)
  return { mutation, asking, ask: setAsking }
}

/**
 * The question before an undo. What stays is said plainly: undo keeps
 * whatever has been worked on since — a job, a report, a note someone wrote
 * — so nobody's work goes with the list it came in on.
 */
export function UndoDialog({
  undo,
}: {
  undo: ReturnType<typeof useUndoImport>
}) {
  const { asking, ask, mutation } = undo
  return (
    <ConfirmDialog
      open={asking !== null}
      onOpenChange={(open) => !open && ask(null)}
      title="Undo this import?"
      body="The clients and sites it brought in go, unless a job, report or note has been made for them since — those stay."
      confirm="Undo import"
      cancel="Keep it"
      onConfirm={() => {
        if (asking) mutation.mutate(asking)
        ask(null)
      }}
    />
  )
}
