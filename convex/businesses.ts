import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { getAuthUserId, requireMembership } from './lib/access'
import { DEFAULT_GRANTS } from './lib/capabilities'
import { MEMBER_COLOURS } from './lib/colours'
import { forSelf, recordAudit } from './lib/audit'
import { requireActor, requireCapability } from './lib/actor'
import { abnDigits, formatAbn, normaliseAbn } from './lib/abn'
import { normaliseEmail } from './lib/email'
import { normalisePhone } from './lib/phone'
import { MFA_ENROLMENT_REQUIRED } from './lib/mfa'

/**
 * The business's own ABN as stored: checked by the ATO's rule (INVALID_ABN)
 * and written the way the ATO prints it, "51 824 753 556", because this one
 * is printed as stored on every report and certificate — unlike a client's,
 * which is kept as digits and formatted where it is shown. Absent when blank.
 */
function businessAbn(raw: string | undefined): string | undefined {
  const digits = normaliseAbn(raw)
  return digits === undefined ? undefined : formatAbn(digits)
}

/**
 * Whether a sent ABN is the stored one sent back. Either exactly what is
 * stored, or the same eleven digits and nothing else: a form that keeps what
 * was typed sends "51824753556" back after the server stored
 * "51 824 753 556". Only when the digits are the WHOLE value, though —
 * comparing every digit found in it made "N/A" (no digits) match a business
 * with no ABN, and "ABN 51824753556 (old)" match the stored one, and either
 * was then stored, unchecked, as the ABN every report prints.
 */
function sameAbn(raw: string, stored: string | undefined): boolean {
  if (!edited(raw, stored)) return true
  const digits = abnDigits(raw)
  return digits !== null && digits === abnDigits(stored ?? '')
}

function slugify(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

export const listForUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx)

    const memberships = await ctx.db
      .query('memberships')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()

    const active = memberships.filter((m) => m.status === 'active')

    return Promise.all(
      active.map(async (m) => {
        const business = await ctx.db.get(m.businessId)
        return {
          membershipId: m._id,
          role: m.role,
          // Live for the sidebar's own-colour dot, which otherwise read the
          // route context's snapshot and kept an old colour after a change.
          colour: m.colour,
          canViewAllJobs: m.canViewAllJobs,
          businessId: m.businessId,
          name: business?.name ?? '',
          slug: business?.slug ?? '',
        }
      }),
    )
  },
})

export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const business = await ctx.db
      .query('businesses')
      .withIndex('by_slug', (q) => q.eq('slug', slug))
      .unique()

    // Resolving the slug before membership would let a non-member probe which
    // slugs exist, so a miss and a non-membership return the same shape.
    if (!business) return null

    try {
      const membership = await requireMembership(ctx, business._id)
      const logoUrl = business.logoStorageId
        ? await ctx.storage.getUrl(business.logoStorageId)
        : null
      return {
        _id: business._id,
        name: business.name,
        slug: business.slug,
        state: business.state,
        timezone: business.timezone,
        abn: business.abn,
        addressLine: business.addressLine,
        suburb: business.suburb,
        postcode: business.postcode,
        phone: business.phone,
        email: business.email,
        licenceNumber: business.licenceNumber,
        logoUrl,
        membership: {
          _id: membership._id,
          role: membership.role,
          canViewAllJobs: membership.canViewAllJobs,
          colour: membership.colour,
          licenceNumber: membership.licenceNumber,
          phone: membership.phone,
        },
      }
    } catch (error) {
      // Not an answer about this business, so not folded into "no such
      // business": the layout has to send this person to set up two-step
      // sign-in, and a null here would show them "Not found" instead.
      if (isMfaEnrolmentError(error)) throw error
      return null
    }
  },
})

function isMfaEnrolmentError(error: unknown): boolean {
  return error instanceof ConvexError && error.data === MFA_ENROLMENT_REQUIRED
}

export const create = mutation({
  args: {
    name: v.string(),
    state: v.string(),
    timezone: v.string(),
    abn: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx)

    const base = slugify(args.name)
    if (!base) throw new ConvexError('INVALID_NAME')

    let slug = base
    let n = 1
    while (
      await ctx.db
        .query('businesses')
        .withIndex('by_slug', (q) => q.eq('slug', slug))
        .unique()
    ) {
      slug = `${base}-${++n}`
    }

    // Refused before anything is written: it goes on the header of every
    // compliance document this business issues.
    const abn = businessAbn(args.abn)

    const now = Date.now()
    const businessId = await ctx.db.insert('businesses', {
      name: args.name,
      slug,
      state: args.state,
      timezone: args.timezone,
      ...(abn !== undefined && { abn }),
      subscriptionStatus: 'trialing',
      createdAt: now,
    })

    await ctx.db.insert('memberships', {
      userId,
      businessId,
      role: 'owner',
      canViewAllJobs: true,
      // Written rather than left to be derived. `grantsFromMembership` would
      // fill these in from `canViewAllJobs`, which is the fallback the
      // migration exists to stop needing — a row created after it ran would
      // otherwise put the deployment straight back into the state it just
      // left, and the legacy column could never be dropped.
      grants: DEFAULT_GRANTS.owner,
      colour: MEMBER_COLOURS[0],
      status: 'active',
      createdAt: now,
    })

    return { businessId, slug }
  },
})

/**
 * The report-level settings an owner sets, read back.
 *
 * Separate from `getBySlug`, which every page load runs and which deliberately
 * projects only what the shell needs: these are read on one settings screen by
 * one role, and widening the query the whole app depends on to carry them
 * would put them in every route's payload forever.
 */
export const reportSettings = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    requireCapability(await requireActor(ctx, businessId), 'business.manage')

    const business = await ctx.db.get(businessId)
    if (!business) return null

    return {
      tradingName: business.tradingName,
      reportBrandName: business.reportBrandName,
      website: business.website,
      reportCopyEmail: business.reportCopyEmail,
      allowTechnicianRecipients: business.allowTechnicianRecipients === true,
      requireReportToComplete: business.requireReportToComplete === true,
      /** Falls back to the business address, which is what the header prints. */
      email: business.email,
    }
  },
})

export const update = mutation({
  args: {
    businessId: v.id('businesses'),
    name: v.optional(v.string()),
    state: v.optional(v.string()),
    timezone: v.optional(v.string()),
    abn: v.optional(v.string()),
    logoStorageId: v.optional(v.id('_storage')),
    addressLine: v.optional(v.string()),
    suburb: v.optional(v.string()),
    postcode: v.optional(v.string()),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    licenceNumber: v.optional(v.string()),
    tradingName: v.optional(v.string()),
    reportBrandName: v.optional(v.string()),
    website: v.optional(v.string()),
    reportCopyEmail: v.optional(v.string()),
    allowTechnicianRecipients: v.optional(v.boolean()),
    requireReportToComplete: v.optional(v.boolean()),
  },
  handler: async (ctx, { businessId, ...patch }) => {
    const env = await requireActor(ctx, businessId)
    requireCapability(env, 'business.manage')
    const actor = env.actor.real

    const fields = Object.fromEntries(
      Object.entries(patch as Record<string, unknown>).filter(
        ([, value]) => value !== undefined,
      ),
    )

    // The printed contact details are checked only when this save changes
    // them. The settings forms send every field on every save, and a
    // business whose ABN or number was saved before these rules (the seed's
    // ABNs fail the ATO's check) must still be able to change its name.
    //
    // One sent back unchanged is left out of the patch rather than written
    // as sent: the form holds it as it was typed, so writing it would undo
    // the formatting the server gave it ("51 824 753 556" back to
    // "51824753556" on the next save of the business name), on a value
    // every report prints as stored.
    const business = await ctx.db.get(businessId)
    if (!business) throw new ConvexError('NOT_FOUND')
    if (patch.abn !== undefined) {
      if (sameAbn(patch.abn, business.abn)) delete fields.abn
      else fields.abn = businessAbn(patch.abn)
    }
    for (const key of ['email', 'reportCopyEmail'] as const) {
      const raw = patch[key]
      if (raw === undefined) continue
      if (edited(raw, business[key])) fields[key] = normaliseEmail(raw)
      else delete fields[key]
    }
    if (patch.phone !== undefined) {
      if (edited(patch.phone, business.phone)) {
        fields.phone = normalisePhone(patch.phone)
      } else delete fields.phone
    }

    if (Object.keys(fields).length > 0) {
      await ctx.db.patch(businessId, fields)

      // ABN, licence number and trading name are printed on compliance
      // documents. Who changed them, and when, is part of the record.
      await recordAudit(ctx, forSelf(actor._id), {
        businessId,
        action: 'business.update',
        entityType: 'businesses',
        entityId: businessId,
        meta: { fields: Object.keys(fields) },
        at: Date.now(),
      })
    }
  },
})

/** Whether a saved detail is being changed, not just sent back as it was. */
function edited(raw: string, stored: string | undefined): boolean {
  return raw.trim() !== (stored ?? '').trim()
}

/** Short-lived upload URL for the business logo — owner-gated, since only the
 * owner can change branding via `update` above. */
export const generateUploadUrl = mutation({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    requireCapability(await requireActor(ctx, businessId), 'business.manage')
    return ctx.storage.generateUploadUrl()
  },
})
