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
    .index('by_business_status', ['businessId', 'status']),

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
