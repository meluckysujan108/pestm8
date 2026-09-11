import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { InlineNotesSection, useMentionRoster } from './InlineNotes'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * Two things a tech wants from a job's notes, in the order they want them:
 * what the team already knows about this site and client ("Before you
 * arrive"), then what has been written about this particular visit.
 */
export function JobNotesSection({
  businessId,
  businessSlug,
  timezone,
  jobId,
  jobType,
  propertyId,
  addressLine,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  timezone: string
  jobId: Id<'jobs'>
  jobType: string
  propertyId: Id<'properties'>
  addressLine: string
}) {
  const [openId, setOpenId] = useState<Id<'notes'> | null>(null)
  const members = useMentionRoster(businessId)

  const { data: context } = useQuery(
    convexQuery(api.notes.listForProperty, { businessId, propertyId }),
  )
  const { data: visit } = useQuery(convexQuery(api.notes.listForJob, { businessId, jobId }))

  const convexCreate = useConvexMutation(api.notes.create)
  const create = useMutation({
    mutationFn: (args: {
      template: 'siteAccess' | 'jobVisit'
      title: string
      jobId?: Id<'jobs'>
      propertyId?: Id<'properties'>
    }) => convexCreate({ businessId, ...args }),
    onSuccess: (id) => setOpenId(id),
  })

  return (
    <>
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
        onAdd={() => create.mutate({ template: 'siteAccess', title: addressLine, propertyId })}
        openId={openId}
        onOpen={setOpenId}
      />
      <InlineNotesSection
        businessId={businessId}
        businessSlug={businessSlug}
        timezone={timezone}
        label="Notes for this visit"
        notes={visit}
        members={members}
        empty="Findings, treatment applied, follow-ups."
        addLabel="Add note"
        adding={create.isPending}
        onAdd={() => create.mutate({ template: 'jobVisit', title: jobType, jobId })}
        openId={openId}
        onOpen={setOpenId}
      />
    </>
  )
}
