import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { PenLine } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'
import { RowPending } from '#/components/shell/Pending'
import { LoadFailed } from '#/components/primitives/EmptyState'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'
import {
  DANGER_ROW_CLASS,
  DangerGroup,
  ROW_CLASS,
  RowBody,
  SettingsBody,
  SettingsGroup,
} from '#/components/settings/ui'
import { SigningScreen } from '#/components/signature/SigningScreen'
import type { Drawn } from '#/components/signature/SigningScreen'
import { isOffline } from '#/lib/online'
import { useHydrated } from '#/lib/useHydrated'

/**
 * My signature: the one a technician may put on their own reports with a
 * tap, seen, drawn again, or removed.
 *
 * It is used only when they choose it on a report ("Sign with my saved
 * signature"), never on its own. Replacing or removing it changes no report
 * already signed with it: each keeps the image it was signed with.
 */
export function MySignature({ businessId }: { businessId: Id<'businesses'> }) {
  const hydrated = useHydrated()
  const saved = useQuery(
    convexQuery(api.reports.mySavedSignature, { businessId }),
  )
  const [drawing, setDrawing] = useState(false)
  const [removing, setRemoving] = useState(false)

  const getUploadUrl = useConvexMutation(api.reports.generateUploadUrl)
  const convexSet = useConvexMutation(api.reports.setMySavedSignature)
  const convexClear = useConvexMutation(api.reports.clearMySavedSignature)

  const set = useMutation({
    mutationFn: async ({ png }: Drawn) => {
      if (isOffline()) throw new Error('offline')
      const url = await getUploadUrl({ businessId })
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: png,
      })
      if (!res.ok) throw new Error('upload failed')
      const { storageId } = (await res.json()) as {
        storageId: Id<'_storage'>
      }
      await convexSet({ businessId, storageId })
    },
    onSuccess: () => setDrawing(false),
  })
  const clear = useMutation({
    mutationFn: async () => {
      if (isOffline()) throw new Error('offline')
      await convexClear({ businessId })
    },
  })

  const failure = (error: Error | null) =>
    error === null
      ? undefined
      : error.message === 'offline'
        ? 'No signal. Tap Done again when you have signal.'
        : 'Could not save your signature. Tap Done again.'

  const has = saved.data != null

  return (
    <>
      <SettingsBody>
        <SettingsGroup footer="Put on a report only when you tap “Sign with my saved signature” there. Drawing a new one, or removing it, changes no report already signed.">
          {saved.isPending ? (
            <RowPending
              label="Finding your signature"
              className="px-3.5 py-3"
            />
          ) : saved.isError ? (
            <div className="px-3.5 py-3">
              <LoadFailed
                what="your signature"
                onRetry={() => void saved.refetch()}
              />
            </div>
          ) : saved.data ? (
            <div className="px-3.5 py-3">
              {/* Paper in both themes: it is printed on white. */}
              <img
                src={saved.data.url}
                alt="My saved signature"
                className="h-32 w-full rounded-xl border border-hairline bg-paper object-contain"
              />
            </div>
          ) : (
            <p className="px-3.5 py-3 text-body text-ink-2">
              No saved signature. Draw one here, or tick “Keep for next time”
              when you sign a report.
            </p>
          )}
          <button
            type="button"
            disabled={!hydrated || saved.isPending}
            onClick={() => {
              set.reset()
              setDrawing(true)
            }}
            className={`${ROW_CLASS} border-t border-hairline disabled:opacity-50`}
          >
            <RowBody
              icon={PenLine}
              tint="blue"
              title={has ? 'Draw a new one' : 'Draw my signature'}
            />
          </button>
        </SettingsGroup>

        {has && (
          <DangerGroup>
            <button
              type="button"
              disabled={!hydrated}
              onClick={() => {
                clear.reset()
                setRemoving(true)
              }}
              className={DANGER_ROW_CLASS}
            >
              Remove my signature
            </button>
          </DangerGroup>
        )}
      </SettingsBody>

      {drawing && (
        <SigningScreen
          title="My signature"
          busy={set.isPending}
          error={failure(set.error)}
          onDone={(drawn) => set.mutate(drawn)}
          onClose={() => setDrawing(false)}
        />
      )}

      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title="Remove your saved signature?"
        body="Reports ask you to draw it each time until you save one again. Reports already signed keep it."
        confirm="Remove"
        pending={clear.isPending}
        pendingLabel="Removing…"
        closeOnConfirm={false}
        error={
          clear.error
            ? clear.error.message === 'offline'
              ? 'No signal. Try again when you have signal.'
              : 'Could not remove it. Try again in a moment.'
            : undefined
        }
        onConfirm={() =>
          clear.mutate(undefined, { onSuccess: () => setRemoving(false) })
        }
      />
    </>
  )
}
