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

/** Mirrors `OptionSetKey` in src/lib/reportTemplates/types.ts. */
export const optionSetKey = v.union(
  v.literal('treatments'),
  v.literal('products'),
  v.literal('quantities'),
  v.literal('methods'),
  v.literal('nextVisit'),
  v.literal('risks'),
  v.literal('riskActions'),
  v.literal('housekeeping'),
  v.literal('peoplePresent'),
  v.literal('wallConstruction'),
  v.literal('floorType'),
  v.literal('roofType'),
  v.literal('structureType'),
  v.literal('structureHeight'),
  v.literal('facade'),
  v.literal('topography'),
  v.literal('areasTreated'),
  v.literal('limitationFactors'),
  v.literal('noticeLocation'),
)

/** Mirrors `PrintSpec` — a closed shape we own, so validated strictly. */
export const printSpec = v.object({
  formName: v.string(),
  numbering: v.union(v.literal('numbered'), v.literal('unnumbered')),
  headings: v.optional(v.array(v.string())),
  standardsLine: v.optional(v.string()),
  cover: v.optional(
    v.object({ title: v.string(), subtitle: v.optional(v.string()) }),
  ),
  termsHeading: v.optional(v.string()),
  omitEmpty: v.optional(v.boolean()),
})

/**
 * The records a finalised report prints from, as they stood when it was
 * signed. See `reports.contextSnapshot`.
 */
export const reportContextSnapshot = v.object({
  capturedAt: v.number(),
  client: v.union(
    v.null(),
    v.object({
      name: v.string(),
      phone: v.optional(v.string()),
      email: v.optional(v.string()),
      address: v.optional(v.string()),
    }),
  ),
  property: v.union(
    v.null(),
    v.object({
      address: v.string(),
      addressLine: v.string(),
      suburb: v.string(),
      state: v.string(),
      postcode: v.string(),
    }),
  ),
  business: v.union(
    v.null(),
    v.object({
      name: v.string(),
      tradingName: v.optional(v.string()),
      address: v.optional(v.string()),
      addressLine: v.optional(v.string()),
      suburb: v.optional(v.string()),
      postcode: v.optional(v.string()),
      phone: v.optional(v.string()),
      email: v.optional(v.string()),
      abn: v.optional(v.string()),
      licenceNumber: v.optional(v.string()),
      logoStorageId: v.optional(v.id('_storage')),
    }),
  ),
  technician: v.union(
    v.null(),
    v.object({
      membershipId: v.id('memberships'),
      name: v.optional(v.string()),
      licence: v.optional(v.string()),
      phone: v.optional(v.string()),
      address: v.optional(v.string()),
    }),
  ),
  author: v.object({
    membershipId: v.id('memberships'),
    licenceNumber: v.optional(v.string()),
  }),
  // Membership id -> the name as printed, e.g. "K. Edgar (Licence 4132)".
  // Only the members a `member` field actually chose.
  roster: v.record(v.string(), v.string()),
  // Membership id -> the facts a row bound to that member field prints. Kept
  // per member, because a form can name two different people.
  members: v.optional(
    v.record(
      v.string(),
      v.object({
        name: v.optional(v.string()),
        licence: v.optional(v.string()),
        phone: v.optional(v.string()),
        address: v.optional(v.string()),
      }),
    ),
  ),
})

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
    // Free-text notes used to live here; they are notes in the library now
    // (kind "client"), migrated by convex/migrations/notesV2.ts.
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
    /**
     * SUPERSEDED by `templateSnapshotId` — kept because 31 finalised rows on
     * dev (and an unknown number on prod) still carry it, so removing it from
     * this validator would reject them on the next push. Readers prefer
     * `templateSnapshotId` and fall back to this. It is dropped in a later
     * contract deploy, after every row has been backfilled and patched to
     * `undefined`. See convex/migrations/reportSnapshotsV1.ts.
     */
    customTemplateSnapshot: v.optional(v.any()),
    /**
     * The frozen template a finalised report renders from — every kind, not
     * just custom. Built-ins were exempt while the 4 `.ts` files never
     * changed; the verbatim rewrite ends that, so a signed document has to
     * carry its own wording or it silently re-reads the new one.
     *
     * By reference, not inline, and NOT because of the 1 MB document limit —
     * the worst snapshot is ~12 KB. Inlining a ~10 KB service report onto
     * each of its finalised rows would grow this table roughly fivefold and
     * make every later patch rewrite the whole snapshot. Deduplicated by
     * content hash, hundreds of reports share a handful of rows.
     *
     * Optional forever: Convex cannot say "required only when finalised"
     * without splitting this table into a status-discriminated union.
     */
    templateSnapshotId: v.optional(v.id('reportTemplateSnapshots')),
    /**
     * Which revision of the template this report was created against.
     * Backfilled to 1 on every pre-existing row, so "was this written before
     * or after the rewrite?" is answerable without guessing from dates.
     */
    templateVersion: v.optional(v.number()),
    /**
     * The client, site, business and technician facts this report printed,
     * frozen at finalise.
     *
     * A verbatim template prints the client's name, the site address and the
     * inspector's licence straight from the records rather than from typed
     * answers. Read live, renaming a client next year would rewrite the name on
     * a certificate signed this year — the same retroactive edit the template
     * snapshot exists to prevent, arriving by a different door. Absent on
     * reports finalised before this existed; those keep reading live, which is
     * what they have always done.
     */
    contextSnapshot: v.optional(reportContextSnapshot),
    /**
     * Soft-deleted: hidden from every list and unopenable, never destroyed.
     * Brought forward from the planned Recently Deleted feature so "start
     * again" on a superseded draft can retire the old one without deleting
     * the evidence photos attached to it.
     */
    deletedAt: v.optional(v.number()),
  })
    .index('by_business', ['businessId'])
    // "find the 2024 report for this address" — the reason properties are a
    // table rather than something derived from jobs.
    .index('by_property', ['propertyId'])
    .index('by_job', ['jobId'])
    // "can this custom template be hard-deleted?" — see customTemplates.remove.
    .index('by_custom_template', ['customTemplateId'])
    // "which of this business's drafts might hold an answer being renamed?" —
    // the option-library rename walks only these, never a finalised report.
    .index('by_business_status_template', ['businessId', 'status', 'template']),

  /**
   * The team's shared field knowledge. The note BODY lives in the
   * prosemirror-sync component keyed by this row's `_id` (collaborative,
   * step-merged — never a blob replaced wholesale, which `reports.data`'s
   * history shows this codebase losing data to twice). This row holds what a
   * note is about and the metadata the list/search need, derived from the
   * body on every snapshot.
   *
   * What a note is "about" is read from its links, never a stored kind:
   * a `jobId` makes it a visit note (and carries the job's property + client
   * so a client's sheet finds every note about them in one index); a
   * `propertyId` alone is standing site knowledge (gate code, dog, key);
   * `clientId` alone is about the client; none is a team memo.
   */
  notes: defineTable({
    businessId: v.id('businesses'),
    authorMembershipId: v.id('memberships'),
    lastEditedByMembershipId: v.id('memberships'),
    jobId: v.optional(v.id('jobs')),
    propertyId: v.optional(v.id('properties')),
    clientId: v.optional(v.id('clients')),
    // Derived from the body in notesSync.onSnapshot — never client-written.
    title: v.string(),
    preview: v.string(),
    plainText: v.string(),
    checklistTotal: v.optional(v.number()),
    checklistDone: v.optional(v.number()),
    pinnedAt: v.optional(v.number()),
    // Soft delete → "Recently Deleted", purged by cron after 30 days.
    deletedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_business_updated', ['businessId', 'updatedAt'])
    .index('by_job', ['jobId'])
    .index('by_property', ['propertyId'])
    .index('by_client', ['clientId'])
    // The nightly purge's range scan; undefined sorts below every number.
    .index('by_deletedAt', ['deletedAt'])
    .searchIndex('search', {
      searchField: 'plainText',
      filterFields: ['businessId'],
    }),

  /**
   * One row per (note, @mentioned member). A join table rather than an array
   * on the note so "notes mentioning me" is an indexed query and unread
   * state is per person. Rows are diffed against the body on every snapshot;
   * a surviving mention keeps its `readAt`.
   */
  noteMentions: defineTable({
    businessId: v.id('businesses'),
    noteId: v.id('notes'),
    membershipId: v.id('memberships'),
    mentionedByMembershipId: v.id('memberships'),
    createdAt: v.number(),
    readAt: v.optional(v.number()),
  })
    .index('by_note', ['noteId'])
    .index('by_membership_read', ['membershipId', 'readAt']),

  /** Images referenced from a note body, so a purge can delete the files. */
  noteAttachments: defineTable({
    noteId: v.id('notes'),
    storageId: v.id('_storage'),
    createdAt: v.number(),
  })
    .index('by_note', ['noteId'])
    // One file belongs to one note: the purge must never delete a file
    // something else still references.
    .index('by_storage', ['storageId']),

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
  })
    .index('by_report_field', ['reportId', 'fieldKey'])
    // "which report owns this file?" — the same question `noteAttachments`
    // asks, for the same reason: nothing may delete a stored image that a
    // finalised document still prints.
    .index('by_storage', ['storageId']),

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
    // A verbatim built-in's warranty or terms pages and its printed framing.
    // Copied by `cloneBuiltin`: without them a clone of the Service Report
    // would silently drop its warranty pages, because its `boilerplate` is
    // empty by design.
    terms: v.optional(v.any()),
    print: v.optional(printSpec),
    // Removes it from the "start a new report" picker only — has zero
    // effect on any report already referencing it. Mirrors how
    // `memberships.status` never hard-deletes ('removed' instead) and
    // `recurrences.active` stops future work without erasing history.
    archivedAt: v.optional(v.number()),
    createdByMembershipId: v.id('memberships'),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_business', ['businessId']),

  /**
   * The exact template a finalised report was signed against, stored once per
   * distinct content and shared by every report that used it.
   *
   * Append-only and never deleted: a finalised report dereferences its row
   * forever, so a purge here would blank out a signed document. Rows are not
   * scoped to a business: a built-in that no business has customised is
   * byte-identical across tenants, so a global content hash keeps one row per
   * revision instead of one per tenant. A business that edits one of its option
   * lists (its product list, say) mints its own row on its next finalise, and
   * shares it with nobody unless their content is identical to the byte. Rows
   * are only ever read through a report's `templateSnapshotId`, after the
   * report's own access check — there is no lookup by hash from outside.
   *
   * `hash` is a canonical hash of the printed fields below (see
   * `convex/lib/templateSnapshot.ts`). A collision is harmless by
   * construction: the writer compares the canonical string on a hash hit and
   * inserts a fresh row when they differ.
   */
  reportTemplateSnapshots: defineTable({
    hash: v.string(),
    // Which built-in this froze, or 'custom'. Kept so a snapshot can be read
    // without also loading the report that points at it.
    template: reportTemplate,
    name: v.string(),
    shortName: v.string(),
    legalBasis: v.string(),
    blurb: v.string(),
    // `SectionDef[]`, always normalised through `sectionsOf()` so a flat
    // `fields` built-in and a sectioned one freeze the same shape — including
    // the synthetic `implicit: true` wrapper, which both painters print.
    sections: v.any(),
    boilerplate: v.string(),
    // A RichDoc, validated where it is authored (`richDocSchema`); `v.any()`
    // rather than a second copy of that recursive validator.
    terms: v.optional(v.any()),
    print: v.optional(printSpec),
    features: v.optional(v.array(v.literal('durableNotice'))),
    // The template revision this content came from, mirroring
    // `reports.templateVersion`.
    version: v.number(),
    createdAt: v.number(),
  }).index('by_hash', ['hash']),

  /**
   * A business's own version of a vocabulary its reports print — its product
   * list, the treatments it offers. No row means the verbatim defaults from
   * the built-in templates, which is where every business starts; a row is
   * seeded lazily by the first owner edit.
   *
   * One document per list rather than a row per option: a list is bounded
   * (`MAX_LIVE_OPTIONS`), always read and written whole, and changes rarely.
   */
  optionSets: defineTable({
    businessId: v.id('businesses'),
    key: optionSetKey,
    // `value === label`, enforced by every writer: an answer stores the words
    // it prints, so a report never needs this row to be read.
    options: v.array(v.object({ value: v.string(), label: v.string() })),
    /**
     * Recent renames, newest last and bounded. The draft rewrites a rename
     * schedules run in no guaranteed order; resolving through this log lets
     * A->B and B->C converge on C whichever job runs first.
     */
    renames: v.array(
      v.object({ from: v.string(), to: v.string(), at: v.number() }),
    ),
    // The built-in revision whose defaults seeded this row.
    seedVersion: v.number(),
    updatedAt: v.number(),
    updatedByMembershipId: v.id('memberships'),
  }).index('by_business_key', ['businessId', 'key']),
})
