import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { InlineNotesSection, useMentionRoster } from './InlineNotes'
import type { Id } from '../../../convex/_generated/dataModel'

/** Everything written about a client: their own notes, their sites, their visits. */
export function ClientNotesSection({
  businessId,
  businessSlug,
  timezone,
  clientId,
  clientName,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  timezone: string
  clientId: Id<'clients'>
  clientName: string
}) {
  const [openId, setOpenId] = useState<Id<'notes'> | null>(null)
  const members = useMentionRoster(businessId)
  const { data: notes } = useQuery(convexQuery(api.notes.listForClient, { businessId, clientId }))

  const convexCreate = useConvexMutation(api.notes.create)
  const create = useMutation({
    mutationFn: () => convexCreate({ businessId, clientId, template: 'blank', title: clientName }),
    onSuccess: (id) => setOpenId(id),
  })

  return (
    <InlineNotesSection
      businessId={businessId}
      businessSlug={businessSlug}
      timezone={timezone}
      label="Notes"
      notes={notes}
      members={members}
      empty="Billing quirks, who to call, how they like to be contacted."
      addLabel="Add note"
      adding={create.isPending}
      onAdd={() => create.mutate()}
      openId={openId}
      onOpen={setOpenId}
    />
  )
}
