import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { InlineNotesSection, useMentionRoster } from './InlineNotes'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * What the team already knows about this site and client, read before
 * turning up ("Before you arrive").
 *
 * The job sheet used to add "Notes for this visit" below it. The owner asked
 * for it gone (Phase 5.3): the Notes section is now mainly personal notes,
 * and site notes are what a job needs in front of it. Notes already attached
 * to a visit are kept — they are in Notes → Jobs, in search, and on the
 * client's sheet.
 */
export function JobNotesSection({
  businessId,
  businessSlug,
  timezone,
  propertyId,
  addressLine,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  timezone: string
  propertyId: Id<'properties'>
  addressLine: string
}) {
  const [openId, setOpenId] = useState<Id<'notes'> | null>(null)
  const members = useMentionRoster(businessId)

  const { data: context } = useQuery(
    convexQuery(api.notes.listForProperty, { businessId, propertyId }),
  )

  const convexCreate = useConvexMutation(api.notes.create)
  const create = useMutation({
    mutationFn: () =>
      convexCreate({
        businessId,
        template: 'siteAccess',
        title: addressLine,
        propertyId,
      }),
    onSuccess: (id) => setOpenId(id),
  })

  return (
    <InlineNotesSection
      businessId={businessId}
      businessSlug={businessSlug}
      timezone={timezone}
      label="Before you arrive"
      notes={context?.site}
      members={members}
      empty="Nothing on file for this site yet — gate code, dog, where the key lives."
      addLabel="Site note"
      adding={create.isPending}
      onAdd={() => create.mutate()}
      openId={openId}
      onOpen={setOpenId}
    />
  )
}
