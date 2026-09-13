import { authComponent } from '../auth'
import { withClient } from '../properties'
import { fieldsOf, templateFor } from '../../src/lib/reportTemplates'
import { printedMemberName } from '../../src/lib/reportTemplates/memberName'
import type { Infer } from 'convex/values'
import type { reportContextSnapshot } from '../schema'
import type { FieldDef } from '../../src/lib/reportTemplates'
import type { PresentContext } from '../../src/lib/reportTemplates/present'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'

export type ReportContextSnapshot = Infer<typeof reportContextSnapshot>

export type RosterEntry = {
  _id: Id<'memberships'>
  name: string
  printed: string
  status: Doc<'memberships'>['status']
  licence?: string
  phone?: string
}

const MAX_MEMBERS = 100

/**
 * A member's name from the auth component, or '' when it cannot be read. A
 * report page must never fail to open because one identity lookup did; the
 * member then prints by licence alone.
 */
async function memberName(
  ctx: QueryCtx | MutationCtx,
  userId: string,
): Promise<string> {
  try {
    const user = await authComponent.getAnyUserById(ctx, userId)
    return user?.name ?? ''
  } catch (error) {
    console.error(`member name lookup failed for ${userId}`, error)
    return ''
  }
}

const joined = (...parts: Array<string | undefined>) =>
  parts.filter((part) => part && part.trim() !== '').join(' ')

/**
 * The fields of the form this report is filling in, for the one question the
 * context needs answered: which `member` field names the technician.
 */
async function fieldsForReport(
  ctx: QueryCtx | MutationCtx,
  report: Doc<'reports'>,
): Promise<Array<FieldDef>> {
  if (report.template !== 'custom') {
    return fieldsOf(templateFor(report.template, report.templateVersion))
  }
  if (!report.customTemplateId) return []
  const custom = await ctx.db.get(report.customTemplateId)
  const sections = (custom?.sections ?? []) as Array<{ fields: Array<FieldDef> }>
  return sections.flatMap((section) => section.fields)
}

/**
 * Everything a report prints from a record rather than a typed answer, read
 * live: the client, the site, the business, the technician and the names of
 * the team members the form can name.
 *
 * `finalise` freezes exactly this into `reports.contextSnapshot`; `reports.get`
 * serves it live for a draft. One builder, so a signed report and the draft it
 * came from cannot describe the same client differently.
 */
export async function buildReportContext(
  ctx: QueryCtx | MutationCtx,
  report: Doc<'reports'>,
  data: Record<string, unknown>,
): Promise<{ snapshot: ReportContextSnapshot; roster: Array<RosterEntry> }> {
  const rawProperty = await ctx.db.get(report.propertyId)
  const property = rawProperty && (await withClient(ctx, rawProperty))
  const business = await ctx.db.get(report.businessId)
  const author = await ctx.db.get(report.authorMembershipId)

  const memberKeys = (await fieldsForReport(ctx, report))
    .filter((field) => field.kind === 'member')
    .map((field) => field.key)

  // Only a form that can name a team member pays for identity lookups.
  let roster: Array<RosterEntry> = []
  const chosen = new Set(
    memberKeys
      .map((key) => data[key])
      .filter((value): value is string => typeof value === 'string'),
  )
  if (memberKeys.length > 0) {
    const memberships = await ctx.db
      .query('memberships')
      .withIndex('by_business', (q) => q.eq('businessId', report.businessId))
      .take(MAX_MEMBERS)
    roster = await Promise.all(
      memberships
        // A removed member still prints on a report that already chose them.
        .filter((m) => m.status !== 'removed' || chosen.has(m._id))
        .map(async (m) => {
          const name = await memberName(ctx, m.userId)
          return {
            _id: m._id,
            name,
            printed: printedMemberName(name, m.licenceNumber),
            status: m.status,
            licence: m.licenceNumber,
            phone: m.phone,
          }
        }),
    )
  }

  // The technician is whoever the form's first member field names — the person
  // the document says did the work. The author stands in ONLY on a form with no
  // member field at all: on a form that asks who did the work and got no
  // answer, printing the author's licence would credit someone the document
  // never named.
  const technicianId = memberKeys
    .map((key) => data[key])
    .find(
      (value): value is Id<'memberships'> =>
        typeof value === 'string' && roster.some((m) => m._id === value),
    )
  const technicianMembership = technicianId
    ? await ctx.db.get(technicianId)
    : memberKeys.length === 0
      ? author
      : null
  const technicianEntry = roster.find((m) => m._id === technicianMembership?._id)

  const businessAddress = business
    ? joined(
        business.addressLine,
        business.suburb,
        business.state,
        business.postcode,
      )
    : undefined

  const factsOf = (m: RosterEntry) => ({
    name: m.name || undefined,
    licence: m.licence,
    // Printed because the source forms print it ("Contact the Inspector"):
    // it is on the document the client receives.
    phone: m.phone,
    // Members have no address of their own yet; the source forms' inspector
    // address is the business's.
    address: businessAddress || undefined,
  })

  const snapshot: ReportContextSnapshot = {
    capturedAt: Date.now(),
    client: property?.client
      ? {
          name: property.client.name,
          phone: property.client.phone,
          email: property.client.email,
          // A business-kind client's own mailing address, not the service
          // site — a form asking for both means both.
          address:
            joined(
              property.client.addressLine,
              property.client.suburb,
              property.client.state,
              property.client.postcode,
            ) || undefined,
        }
      : null,
    property: property
      ? {
          address: joined(
            property.addressLine,
            property.suburb,
            property.state,
            property.postcode,
          ),
          addressLine: property.addressLine,
          suburb: property.suburb,
          state: property.state,
          postcode: property.postcode,
        }
      : null,
    business: business
      ? {
          name: business.name,
          // No separate trading-name column yet; the business name is what it
          // trades as until one exists.
          tradingName: business.name,
          address: businessAddress || undefined,
          addressLine: business.addressLine,
          suburb: business.suburb,
          postcode: business.postcode,
          phone: business.phone,
          email: business.email,
          abn: business.abn,
          licenceNumber: business.licenceNumber,
          logoStorageId: business.logoStorageId,
        }
      : null,
    technician: technicianMembership
      ? {
          membershipId: technicianMembership._id,
          name: technicianEntry?.name,
          licence: technicianMembership.licenceNumber,
          // Printed because the source forms print it ("Contact the
          // Inspector"): it is on the document the client receives.
          phone: technicianMembership.phone,
          // Members have no address of their own yet; the source forms'
          // inspector address is the business's.
          address: businessAddress || undefined,
        }
      : null,
    author: {
      membershipId: report.authorMembershipId,
      licenceNumber: author?.licenceNumber,
    },
    roster: Object.fromEntries(
      roster.filter((m) => chosen.has(m._id)).map((m) => [m._id, m.printed]),
    ),
    members: Object.fromEntries(
      roster.filter((m) => chosen.has(m._id)).map((m) => [m._id, factsOf(m)]),
    ),
  }

  return { snapshot, roster: roster.map((m) => ({ ...m, facts: factsOf(m) })) }
}

/**
 * A context snapshot, in the shape `present()` reads. A draft passes the whole
 * roster, so choosing a different technician resolves their licence at once
 * rather than after the next save; a signed report reads only what it froze.
 */
export function toPresentContext(
  snapshot: ReportContextSnapshot,
  roster?: Array<RosterEntry & { facts?: Record<string, string | undefined> }>,
): PresentContext {
  return {
    client: snapshot.client,
    property: snapshot.property && { address: snapshot.property.address },
    business: snapshot.business,
    technician: snapshot.technician,
    roster: roster
      ? Object.fromEntries(roster.map((m) => [m._id, m.printed]))
      : snapshot.roster,
    members: roster
      ? Object.fromEntries(roster.map((m) => [m._id, m.facts ?? {}]))
      : snapshot.members,
  }
}
