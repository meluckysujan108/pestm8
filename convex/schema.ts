import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export const role = v.union(v.literal('owner'), v.literal('subcontractor'))
export const membershipStatus = v.union(
  v.literal('active'),
  v.literal('invited'),
  v.literal('removed'),
)

export const jobStatus = v.union(
  v.literal('booked'),
  v.literal('completed'),
  v.literal('invoiced'),
  v.literal('cancelled'),
)

export const reportTemplate = v.union(
  v.literal('treatmentRecord'),
  v.literal('timberPestInspection'),
  v.literal('termiteManagementCert'),
)

export const reportStatus = v.union(v.literal('draft'), v.literal('finalised'))

export const frequency = v.union(
  v.literal('monthly'),
  v.literal('quarterly'),
  v.literal('sixMonthly'),
  v.literal('yearly'),
)

/**
 * Phases 1–2 (ARCHITECTURE.md §6.1–6.2): tenancy plus the core scheduling
 * loop. Reports, invoices, notes and tasks land in Phase 3.
 */
export default defineSchema({
  businesses: defineTable({
    name: v.string(),
    slug: v.string(),
    state: v.string(),
    abn: v.optional(v.string()),
    timezone: v.string(),
    stripeCustomerId: v.optional(v.string()),
    subscriptionStatus: v.optional(v.string()),
    plan: v.optional(v.string()),
    createdAt: v.number(),
  }).index('by_slug', ['slug']),

  memberships: defineTable({
    userId: v.string(),
    businessId: v.id('businesses'),
    role,
    canViewAllJobs: v.boolean(),
    licenceNumber: v.optional(v.string()),
    colour: v.string(),
    status: membershipStatus,
    createdAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_business', ['businessId'])
    .index('by_user_business', ['userId', 'businessId']),

  // First-class, deliberately NOT derived from job history: reports must stay
  // findable by address years later, whether or not the original job survives.
  /**
   * Invitations are keyed by email, not userId: an owner inviting a
   * subcontractor knows their email address and nothing else, and the person
   * may not have an account yet. The membership is created when they claim it.
   */
  invitations: defineTable({
    businessId: v.id('businesses'),
    email: v.string(),
    role,
    invitedByMembershipId: v.id('memberships'),
    claimedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index('by_email', ['email'])
    .index('by_business', ['businessId']),

  properties: defineTable({
    businessId: v.id('businesses'),
    clientName: v.string(),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    addressLine: v.string(),
    suburb: v.string(),
    state: v.string(),
    postcode: v.string(),
    lat: v.optional(v.number()),
    lng: v.optional(v.number()),
    notes: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index('by_business', ['businessId'])
    .searchIndex('search', {
      searchField: 'addressLine',
      filterFields: ['businessId', 'suburb', 'clientName'],
    }),

  jobs: defineTable({
    businessId: v.id('businesses'),
    propertyId: v.id('properties'),
    assignedMembershipId: v.id('memberships'),
    jobType: v.string(),
    price: v.number(), // cents
    scheduledAt: v.number(),
    durationMinutes: v.number(),
    status: jobStatus,
    recurrenceId: v.optional(v.id('recurrences')),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index('by_business_date', ['businessId', 'scheduledAt'])
    .index('by_assignee_date', ['assignedMembershipId', 'scheduledAt'])
    .index('by_property', ['propertyId'])
    .index('by_business_status', ['businessId', 'status'])
    // Materialising recurrences must be idempotent, which means asking "does
    // this occurrence already exist" on every cron run.
    .index('by_recurrence', ['recurrenceId']),

  recurrences: defineTable({
    businessId: v.id('businesses'),
    propertyId: v.id('properties'),
    assignedMembershipId: v.id('memberships'),
    frequency,
    jobType: v.string(),
    price: v.number(),
    anchorDate: v.number(),
    active: v.boolean(),
  }).index('by_business', ['businessId']),

  reports: defineTable({
    businessId: v.id('businesses'),
    jobId: v.optional(v.id('jobs')),
    propertyId: v.id('properties'),
    authorMembershipId: v.id('memberships'),
    template: reportTemplate,
    legalBasis: v.string(),
    status: reportStatus,
    // Template-shaped; validated by Zod at the edge before it reaches here.
    // The client owns this and replaces it wholesale on every save, so nothing
    // server-managed may live inside it.
    data: v.any(),
    photoIds: v.array(v.id('_storage')),
    // Kept out of `data` deliberately: it lived there once and every finalise
    // silently discarded the photos by overwriting the blob.
    photoSlots: v.optional(v.record(v.string(), v.id('_storage'))),
    finalisedAt: v.optional(v.number()),
    pdfStorageId: v.optional(v.id('_storage')),
    createdAt: v.number(),
  })
    .index('by_business', ['businessId'])
    // "find the 2024 report for this address" — the reason properties are a
    // table rather than something derived from jobs.
    .index('by_property', ['propertyId'])
    .index('by_job', ['jobId']),

  // Manual follow-ups. The AS 3660.2 durable notice is physical: the app can
  // generate the label text but a human must fix it to the building (§1.4).
  tasks: defineTable({
    businessId: v.id('businesses'),
    jobId: v.optional(v.id('jobs')),
    reportId: v.optional(v.id('reports')),
    kind: v.union(v.literal('durableNotice'), v.literal('other')),
    label: v.string(),
    detail: v.optional(v.string()),
    done: v.boolean(),
    doneAt: v.optional(v.number()),
    assignedMembershipId: v.optional(v.id('memberships')),
    createdAt: v.number(),
  }).index('by_business_done', ['businessId', 'done']),

  notes: defineTable({
    businessId: v.id('businesses'),
    authorMembershipId: v.id('memberships'),
    jobId: v.optional(v.id('jobs')),
    propertyId: v.optional(v.id('properties')),
    text: v.string(),
    createdAt: v.number(),
  })
    .index('by_business', ['businessId'])
    .index('by_job', ['jobId']),

  auditLog: defineTable({
    businessId: v.id('businesses'),
    actorMembershipId: v.id('memberships'),
    action: v.string(),
    entityType: v.string(),
    entityId: v.string(),
    meta: v.optional(v.any()),
    at: v.number(),
  }).index('by_business', ['businessId']),
})
