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
  v.literal('inProgress'),
  v.literal('completed'),
  v.literal('invoiced'),
  v.literal('cancelled'),
)

export const reportTemplate = v.union(
  v.literal('treatmentRecord'),
  v.literal('timberPestInspection'),
  v.literal('termiteManagementCert'),
  v.literal('serviceReport'),
  // A business-authored template — see `customReportTemplates` below. The 4
  // built-ins above never change; "editing" one clones it into one of these.
  v.literal('custom'),
)

export const reportStatus = v.union(v.literal('draft'), v.literal('finalised'))

export const frequency = v.union(
  v.literal('monthly'),
  v.literal('quarterly'),
  v.literal('sixMonthly'),
  v.literal('yearly'),
)

export const clientKind = v.union(v.literal('person'), v.literal('business'))

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
    // Printed on the report PDF header/cover — distinct from a member's own
    // `memberships.licenceNumber`, which is the technician's personal licence.
    logoStorageId: v.optional(v.id('_storage')),
    addressLine: v.optional(v.string()),
    suburb: v.optional(v.string()),
    postcode: v.optional(v.string()),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    licenceNumber: v.optional(v.string()),
    // The next value `jobs.create` will hand out as that job's `jobNumber`.
    // Lives here rather than a separate counters table since there is
    // exactly one counter today; read-then-patch inside `jobs.create`'s own
    // mutation is race-safe under Convex's transactional guarantees.
    nextJobNumber: v.optional(v.number()),
  }).index('by_slug', ['slug']),

  memberships: defineTable({
    userId: v.string(),
    businessId: v.id('businesses'),
    role,
    canViewAllJobs: v.boolean(),
    // Distinct from canViewAllJobs (a data-scope grant): this governs whether
    // a subcontractor can also view the app through OTHER members' eyes via
    // the header account menu's "view as" — never grantable for viewing the
    // owner, even when this is on (see viewAs.ts's resolveViewScope).
    canViewOtherAccounts: v.optional(v.boolean()),
    // The caller's own current "view as" selection — always self-only to
    // write (see memberships.setViewingAs), and re-validated on every read
    // rather than trusted, so a revoked grant or archived target silently
    // self-heals back to viewing your own account.
    viewingAsMembershipId: v.optional(v.id('memberships')),
    licenceNumber: v.optional(v.string()),
    phone: v.optional(v.string()),
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
    clientId: v.id('clients'),
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
    .index('by_client', ['clientId'])
    .searchIndex('search', {
      searchField: 'addressLine',
      filterFields: ['businessId', 'suburb'],
    }),

  clients: defineTable({
    businessId: v.id('businesses'),
    kind: clientKind,
    name: v.string(),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    notes: v.optional(v.string()),
    // A business-kind client's own head-office/mailing address — independent
    // of any `properties` (service-site) address. Optional and edit-later
    // only: never asked for at client-creation time, since the creation flow
    // already collects one address (the service property's).
    addressLine: v.optional(v.string()),
    suburb: v.optional(v.string()),
    state: v.optional(v.string()),
    postcode: v.optional(v.string()),
    // Soft-delete, mirroring `customReportTemplates.archivedAt`: removes a
    // client from "new job"/"new property" pickers only, with zero effect on
    // any property/job/report that already references it.
    archivedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_business', ['businessId']),

  // A business-kind client's named people (office manager, site contact,
  // accounts payable) — a person-kind client has no need for this table,
  // since their own `clients.phone`/`email` already is the one contact point.
  clientContacts: defineTable({
    businessId: v.id('businesses'),
    clientId: v.id('clients'),
    name: v.string(),
    role: v.optional(v.string()),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    // Exclusive per clientId, mirroring `reportPhotos.isCover` — cleared on
    // every other contact for the same client whenever one is set primary
    // via `clientContacts.setPrimary`. Undefined/false for every other row.
    isPrimary: v.optional(v.boolean()),
    createdAt: v.number(),
  }).index('by_client', ['clientId']),

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
    // A short, human-sayable number ("Job #142") — the Convex `_id` is
    // opaque and useless over the phone or on a paper docket. Assigned once
    // at creation from `businesses.nextJobNumber`; optional because jobs
    // created before this field existed have none, and backfilling history
    // with fabricated numbers would misrepresent when a job was actually
    // booked relative to others.
    jobNumber: v.optional(v.number()),
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
    // Out of `data` for exactly the reason above, and more urgently: autosave
    // rewrites that blob every couple of seconds, so a signature stored inside
    // it would be destroyed by the next keystroke elsewhere on the form.
    signatureSlots: v.optional(v.record(v.string(), v.id('_storage'))),
    finalisedAt: v.optional(v.number()),
    pdfStorageId: v.optional(v.id('_storage')),
    // Set the moment an email actually sends (convex/email.ts). Independent
    // of `status` — a finalised report can be emailed zero, one, or many
    // times, so "sent" is its own axis, not a third status value.
    emailedAt: v.optional(v.number()),
    createdAt: v.number(),
    // Only set when `template === 'custom'`.
    customTemplateId: v.optional(v.id('customReportTemplates')),
    // Frozen at finalise time — the same "becomes permanently valid" story
    // `data` itself already has. Undefined while draft, since a draft reads
    // the *live* `customReportTemplates` doc via `customTemplateId` instead
    // (nothing is legally binding yet, so picking up a concurrent edit to
    // the template is fine); always undefined for a built-in-templated
    // report.
    customTemplateSnapshot: v.optional(v.any()),
  })
    .index('by_business', ['businessId'])
    // "find the 2024 report for this address" — the reason properties are a
    // table rather than something derived from jobs.
    .index('by_property', ['propertyId'])
    .index('by_job', ['jobId'])
    // "can this custom template be hard-deleted?" — see customTemplates.remove.
    .index('by_custom_template', ['customTemplateId']),

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

  /**
   * Cached per suburb and day (§4.3). A five-person business opening the app
   * all morning should not hit the forecast API once per person per refresh.
   */
  weatherCache: defineTable({
    suburbKey: v.string(), // "bayswater-6053"
    dayKey: v.string(),
    maxTempC: v.optional(v.number()),
    minTempC: v.optional(v.number()),
    rainMm: v.optional(v.number()),
    windKmh: v.optional(v.number()),
    code: v.optional(v.number()),
    fetchedAt: v.number(),
  }).index('by_suburb_day', ['suburbKey', 'dayKey']),

  /**
   * Suburb centroids resolved once from the geocoding API, keyed exactly like
   * `weatherCache.suburbKey`. Two callers need them and neither should pay for
   * a lookup twice: the forecast fetch (which previously re-geocoded every
   * time its 3-hour forecast cache expired) and the schedule's travel hints.
   *
   * Deliberately NOT written onto `properties.lat`/`lng`: the geocoder
   * resolves a whole suburb, so storing its centroid against a street address
   * would claim a precision the number does not have. Kept at the granularity
   * it is actually accurate to.
   */
  suburbGeocache: defineTable({
    suburbKey: v.string(), // "bayswater-6053"
    state: v.string(),
    lat: v.number(),
    lng: v.number(),
    fetchedAt: v.number(),
  }).index('by_suburb_key', ['suburbKey']),

  /**
   * The `gallery` field kind's photos — as many per field as the technician
   * takes, unlike the fixed-slot `photos` kind's one-per-named-slot. A row per
   * table rather than an array on `reports`, per the guideline against
   * unbounded arrays inside a document: `reports.photoIds` is already one, and
   * a phone taking a dozen inspection photos would make this one worse.
   */
  reportPhotos: defineTable({
    reportId: v.id('reports'),
    // A report can have more than one `gallery` field (a cover photo and a
    // general photo set, say), so rows are scoped to their field, not just
    // their report.
    fieldKey: v.string(),
    storageId: v.id('_storage'),
    caption: v.optional(v.string()),
    order: v.number(),
    isCover: v.boolean(),
    createdAt: v.number(),
  }).index('by_report_field', ['reportId', 'fieldKey']),

  /**
   * Quick site photos attached directly to a job — "before/after" or
   * "found this on site" reference shots, not evidence for a compliance
   * document. Deliberately simpler than `reportPhotos`: no cover flag, no
   * annotation, no field grouping — a job has one photo strip, not several
   * named slots. A separate table rather than a field on `jobs` for the
   * same reason `reportPhotos` isn't an array on `reports`: unbounded,
   * grows over the job's life.
   */
  jobPhotos: defineTable({
    jobId: v.id('jobs'),
    storageId: v.id('_storage'),
    caption: v.optional(v.string()),
    order: v.number(),
    createdAt: v.number(),
  }).index('by_job', ['jobId']),

  auditLog: defineTable({
    businessId: v.id('businesses'),
    actorMembershipId: v.id('memberships'),
    action: v.string(),
    entityType: v.string(),
    entityId: v.string(),
    meta: v.optional(v.any()),
    at: v.number(),
  })
    .index('by_business', ['businessId'])
    .index('by_entity', ['entityType', 'entityId']),

  /**
   * A non-destructive markup layer over the generated report PDF — a
   * technician circling something for a colleague to see, not a change to
   * the document itself. One row per stroke, not one document per page
   * holding a strokes array: this codebase has already been burned twice by
   * wholesale-replace semantics on a blob field (`reports.data` losing
   * photos once, this same file's own history), and a single per-page
   * document replaced on every save would reintroduce exactly that failure
   * the moment two people annotate the same page. Inserts are additive and
   * can't clobber a concurrent writer.
   */
  reportPdfAnnotations: defineTable({
    reportId: v.id('reports'),
    page: v.number(),
    authorMembershipId: v.id('memberships'),
    // Normalized 0–1 against the rendered page's width/height, not raw
    // pixels — a zoom change is then a pure redraw-at-new-scale, and a
    // stroke reads the same on whoever's screen views it later.
    points: v.array(v.object({ x: v.number(), y: v.number() })),
    createdAt: v.number(),
  }).index('by_report_page', ['reportId', 'page']),

  /**
   * A business-authored report template — the runtime, per-tenant sibling
   * of the 4 hardcoded templates in `src/lib/reportTemplates`. Never edited
   * in place from a built-in; "editing" one clones its current shape into a
   * new row here first, so the 4 `.ts` files (and any report already
   * finalised against them) never change.
   *
   * `sections` is `FieldDef[]`/`SectionDef[]`-shaped but stored as `v.any()`
   * and validated at the edge by a Zod schema
   * (`src/lib/reportTemplates/customTemplateSchema.ts`) — the same contract
   * `reports.data` already uses, per that field's own comment. A full Convex
   * validator mirroring the 15-way `FieldDef` union would duplicate the type
   * system for no runtime benefit.
   */
  customReportTemplates: defineTable({
    businessId: v.id('businesses'),
    name: v.string(),
    shortName: v.string(),
    legalBasis: v.string(),
    blurb: v.string(),
    sections: v.any(),
    boilerplate: v.string(),
    // Removes it from the "start a new report" picker only — has zero
    // effect on any report already referencing it. Mirrors how
    // `memberships.status` never hard-deletes ('removed' instead) and
    // `recurrences.active` stops future work without erasing history.
    archivedAt: v.optional(v.number()),
    createdByMembershipId: v.id('memberships'),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_business', ['businessId']),
})
