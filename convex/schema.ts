import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export const role = v.union(v.literal('owner'), v.literal('subcontractor'))
export const membershipStatus = v.union(
  v.literal('active'),
  v.literal('invited'),
  v.literal('removed'),
)

/**
 * Phase 1 scope (ARCHITECTURE.md §6.1): tenancy only. Jobs, properties,
 * reports and the rest of §4.2 land in later phases.
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
