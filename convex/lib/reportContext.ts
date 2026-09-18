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

export const MAX_MEMBERS = 100

/**
 * A member's name from the auth component, or '' when it cannot be read. A
 * report page must never fail to open because one identity lookup did; the
 * member then prints by licence alone.
 */
export async function memberName(
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

/** The keys of the form's `member` fields, in form order. */
export async function memberFieldKeys(
  ctx: QueryCtx | MutationCtx,
  report: Doc<'reports'>,
): Promise<Array<string>> {
  return (await fieldsForReport(ctx, report))
    .filter((field) => field.kind === 'member')
    .map((field) => field.key)
}

/**
 * Who the document says did the work: whoever the form's first member field
 * names. The author stands in ONLY on a form with no member field at all: on a
 * form that asks who did the work and got no answer, printing the author's
 * licence would credit someone the document never named.
 *
 * One function for both readers — the context a report prints, and the check
 * `reports.finalise` makes before it may be signed — so the person whose
 * licence is checked is the person whose licence prints.
 */
export async function namedTechnician(
  ctx: QueryCtx | MutationCtx,
  report: Doc<'reports'>,
  data: Record<string, unknown>,
  memberKeys: ReadonlyArray<string>,
): Promise<Doc<'memberships'> | null> {
  if (memberKeys.length === 0) return ctx.db.get(report.authorMembershipId)

  for (const key of memberKeys) {
    const value = data[key]
    if (typeof value !== 'string') continue
    const id = ctx.db.normalizeId('memberships', value)
    const member = id ? await ctx.db.get(id) : null
    // A removed member still counts: they print on a report that chose them.
    if (member && member.businessId === report.businessId) return member
  }
  return null
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

  const memberKeys = await memberFieldKeys(ctx, report)

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

  const technicianMembership = await namedTechnician(
    ctx,
    report,
    data,
    memberKeys,
  )
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
          // Each falls back to the one above it: a business that has never
          // opened the branding settings still prints a coherent header and a
          // coherent title band, both reading its own name.
          tradingName: business.tradingName ?? business.name,
          brandName:
            business.reportBrandName ?? business.tradingName ?? business.name,
          website: business.website,
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
      // The footer's "Submitted by:" — who pressed Finalise, which on this
      // form is often not who the document names as the technician. Frozen,
      // because a person who leaves the business still submitted it.
      name: author ? await memberName(ctx, author.userId) : undefined,
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
