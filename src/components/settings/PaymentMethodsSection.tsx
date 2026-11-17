import { useId, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import {
  MAX_CARD_MACHINE_LENGTH,
  OFFERABLE_METHODS,
} from '../../../convex/lib/paymentLimits'
import { FormAlert } from '#/components/forms/FormAlert'
import { fieldInputClass } from '#/components/forms/FormField'
import { LoadFailed } from '#/components/primitives/EmptyState'
import { ListPending } from '#/components/shell/Pending'
import { PAYMENT_METHOD } from '#/lib/payments'
import { rq } from '#/lib/routeQueries'
import { useHydrated } from '#/lib/useHydrated'
import { ReportSwitchRow } from './ReportSwitchRow'
import { FieldRow, SaveBar, SettingsGroup } from './ui'
import { useSavedFlash } from './useJustSaved'
import type { OfferableMethod } from '../../../convex/lib/paymentLimits'
import type { ErrorCopy } from '#/components/forms/describeError'
import type { Id } from '../../../convex/_generated/dataModel'

/** What each way says under its name, where its name alone isn't enough. */
const METHOD_LINE: Partial<Record<OfferableMethod, string>> = {
  card: 'On your own EFTPOS machine. PestM8 only records it.',
  bankTransfer: 'Usually for an invoice',
  other: 'Anything else, with a reference',
}

const MACHINE_ERROR_COPY: ErrorCopy = {
  TOO_LONG: `Could not save: keep the name to ${MAX_CARD_MACHINE_LENGTH} characters.`,
}

/** "Square Terminal", as the server will keep it. */
const tidy = (name: string) => name.trim().replace(/\s+/g, ' ')

/**
 * Settings → Payments: the ways of being paid the job sheet offers, and what
 * the card machine is called (`payments.methodSettings`). Each way saves the moment
 * it is switched, as a report setting does; the machine's name has a Save.
 * Invoice and No charge are always offered, and turning a way off takes
 * nothing away from payments already taken that way.
 */
export function PaymentMethodsSection({
  businessId,
}: {
  businessId: Id<'businesses'>
}) {
  const query = useQuery(rq.paymentMethods(businessId))
  const data = query.data

  if (data === undefined) {
    return query.isError ? (
      <LoadFailed
        what="your payment settings"
        onRetry={() => void query.refetch()}
      />
    ) : (
      <ListPending label="Loading payment settings" count={5} />
    )
  }
  if (data === null) return null

  const on = new Set(data.methods)
  const onlyOne = data.methods.length === 1

  return (
    <>
      <SettingsGroup
        title="Ways to be paid"
        footer={
          onlyOne
            ? 'One way always stays on. Invoice and No charge are always offered.'
            : 'The job sheet offers these, with Invoice and No charge. Payments already taken keep how they were paid.'
        }
      >
        {OFFERABLE_METHODS.map((method) => (
          <MethodSwitch
            key={method}
            businessId={businessId}
            method={method}
            offered={on.has(method)}
            // The last one on can't go: nothing would say money came in.
            locked={onlyOne && on.has(method)}
          />
        ))}
      </SettingsGroup>

      <CardMachineForm businessId={businessId} saved={data.cardMachine ?? ''} />
    </>
  )
}

function MethodSwitch({
  businessId,
  method,
  offered,
  locked,
}: {
  businessId: Id<'businesses'>
  method: OfferableMethod
  offered: boolean
  locked: boolean
}) {
  const hydrated = useHydrated()
  const convexSet = useConvexMutation(api.payments.setMethodOffered)
  const set = useMutation({
    mutationFn: (next: boolean) =>
      convexSet({ businessId, method, offered: next }),
  })
  return (
    <ReportSwitchRow
      title={PAYMENT_METHOD[method].label}
      description={METHOD_LINE[method]}
      checked={offered}
      disabled={!hydrated || set.isPending || locked}
      failed={set.isError}
      onCheckedChange={(next) => set.mutate(next)}
    />
  )
}

/** The machine's name, shown under Card on the job sheet. */
function CardMachineForm({
  businessId,
  saved,
}: {
  businessId: Id<'businesses'>
  saved: string
}) {
  const id = useId()
  const hydrated = useHydrated()
  // Only what has been typed; otherwise the saved name, live.
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? saved
  const dirty = tidy(value) !== saved
  const flash = useSavedFlash()

  const convexSet = useConvexMutation(api.payments.setCardMachine)
  const save = useMutation({
    mutationFn: (name: string) => convexSet({ businessId, name }),
    onSuccess: (_, sent) => {
      // Typed again while it saved: that stays, as it isn't saved yet.
      setDraft((now) => (now === sent ? null : now))
      flash.mark()
    },
  })

  return (
    // The group is the form's first child, so its own top margin (first:mt-0)
    // is the form's to give.
    <form
      noValidate
      className="mt-6"
      onSubmit={(event) => {
        event.preventDefault()
        if (dirty && !save.isPending) save.mutate(value)
      }}
    >
      <SettingsGroup
        title="Card"
        footer="Shown under Card on the job sheet, so everyone knows which machine. Left blank, it says “EFTPOS machine”."
      >
        <FieldRow id={`${id}-machine`} label="Card machine (optional)">
          <input
            id={`${id}-machine`}
            value={value}
            onChange={(event) => {
              save.reset()
              setDraft(event.target.value)
            }}
            disabled={!hydrated}
            maxLength={MAX_CARD_MACHINE_LENGTH}
            autoComplete="off"
            enterKeyHint="done"
            placeholder="Square, Tyro, Zeller…"
            className={`${fieldInputClass()} disabled:opacity-50`}
          />
        </FieldRow>
      </SettingsGroup>
      {save.isError && (
        <FormAlert error={save.error} copy={MACHINE_ERROR_COPY} />
      )}
      <SaveBar
        visible={dirty || save.isPending || flash.recently}
        pending={save.isPending}
        label={!dirty && flash.recently ? 'Saved' : 'Save'}
        disabled={!dirty}
      />
    </form>
  )
}
