import { v } from 'convex/values'
import { query } from './_generated/server'
import { requireMembership } from './lib/access'
import {
  checkClientRequestId,
  jobMadeBy,
  propertyMadeBy,
  seriesMadeBy,
} from './lib/clientRequest'

/**
 * What a request id made in this business, if anything (lib/clientRequest.ts).
 *
 * For a phone holding a send that went unanswered: the answer it never heard.
 * It names the kind of record it is settling — a booking a job, a Recurring
 * Job a series, a new client or a new site the site — and only that table is
 * asked, as the mutation that kind calls asks it. So a key some other member
 * read off the record and sent with another kind can never answer for it.
 *
 * A record means the send landed and the draft is done, whether that record
 * is live, in the Recycle bin, or since wiped from it for good (then only its
 * id is left, and nothing opens it). Null means nothing was ever made under
 * this id, so the draft may be changed or discarded. Only reads.
 */
export const find = query({
  args: {
    businessId: v.id('businesses'),
    clientRequestId: v.string(),
    kind: v.union(v.literal('job'), v.literal('series'), v.literal('site')),
  },
  returns: v.union(
    v.object({ kind: v.literal('job'), id: v.id('jobs') }),
    v.object({ kind: v.literal('series'), id: v.id('recurrences') }),
    v.object({ kind: v.literal('site'), id: v.id('properties') }),
    v.null(),
  ),
  handler: async (ctx, { businessId, clientRequestId, kind }) => {
    await requireMembership(ctx, businessId)
    const requestId = checkClientRequestId(clientRequestId)

    switch (kind) {
      case 'job': {
        const made = await jobMadeBy(ctx, businessId, requestId)
        return made && { kind, id: made.id }
      }
      case 'series': {
        const made = await seriesMadeBy(ctx, businessId, requestId)
        return made && { kind, id: made.id }
      }
      case 'site': {
        const made = await propertyMadeBy(ctx, businessId, requestId)
        return made && { kind, id: made.id }
      }
    }
  },
})
