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
  termsBreak: v.optional(v.boolean()),
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
      brandName: v.optional(v.string()),
      website: v.optional(v.string()),
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
    // Who submitted it, for the footer. Optional: reports finalised before
    // the footer printed a name have no record of it, and inventing one from
    // today's membership would credit whoever holds that row now.
    name: v.optional(v.string()),
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
    /**
     * The three names one business prints under, which are not the same name.
     *
     * `name` is the entity. `tradingName` is what the document's header says
     * issued it ("Pest M8 South"), and `reportBrandName` is what its title
     * band calls the product ("Pest M8 Service Report for 2026"). The source
     * documents carry all three, and each falls back to the one above it, so
     * a business that never sets them still prints a coherent page.
     */
    tradingName: v.optional(v.string()),
    reportBrandName: v.optional(v.string()),
    website: v.optional(v.string()),
    /**
     * Where the business keeps its own copy of every report it sends. Falls
     * back to `email`; a business that wants no copy sets neither.
     */
    reportCopyEmail: v.optional(v.string()),
    /**
     * Let a technician send a report to an address that is on nobody's
     * record. Off by default: a compliance document emailed to a typo is
     * gone, and the owner is the one who would notice.
     */
    allowTechnicianRecipients: v.optional(v.boolean()),
    /**
     * Refuse to mark a job complete until its report is finalised.
     *
     * Off by default, because it is a policy and not a fact: plenty of jobs
     * genuinely issue no report. A business that does issue one every time
     * turns it on, and the WA requirement to make the record within two
     * business days stops depending on somebody remembering.
     *
     * Applied only to jobs whose TYPE has a form — `suggestTemplate` decides,
     * the same function that offers one at the start. A quote visit or a
     * callback is not what this exists for, and blocking it would teach the
     * business to turn the policy off.
     */
    requireReportToComplete: v.optional(v.boolean()),
    // The next value `jobs.create` will hand out as that job's `jobNumber`.
    // Lives here rather than a separate counters table since there is
    // exactly one counter today; read-then-patch inside `jobs.create`'s own
    // mutation is race-safe under Convex's transactional guarantees.
    nextJobNumber: v.optional(v.number()),
    /**
     * The next value `reports.finalise` will stamp as a report's
     * `reportNumber` — the number the finished document prints beside
     * "Submission ID:", and the one a client quotes on the phone.
     *
     * Allocated at finalise rather than at create, because a draft that is
     * never finished should not consume a number from a sequence a client may
     * later ask about.
     */
    nextReportNumber: v.optional(v.number()),
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
    /**
     * This member's own signature, saved once and reused on their own reports.
     *
     * Only ever applied by its owner: `reports.attachSignature` checks that the
     * caller is the membership this belongs to. A saved signature applied by
     * anyone else is forgery with extra steps, however convenient.
     */
    savedSignatureStorageId: v.optional(v.id('_storage')),
    /**
     * What this member last reached for in each option library, most recent
     * first — the other half of a picker's "Usually" group, alongside the
     * business's own `usual` flags.
     *
     * Per member and not per business, because the list a rodent technician
     * uses every day is not the one the termite crew uses, and neither of them
     * should have to say so in Settings. Bounded hard: at most five values per
     * key over the nineteen keys, written only when a picker closes on a
     * changed answer, so it never grows and rarely churns.
     */
    reportPrefs: v.optional(
      v.object({ recent: v.record(v.string(), v.array(v.string())) }),
    ),
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
    /**
     * When work actually began, stamped the moment the job moves to
     * `inProgress`. A report started from the job seeds its "Start Time:" from
     * this — a fact, unlike `scheduledAt`, which is only when it was booked to
     * begin. Optional: jobs that reached `inProgress` before this existed, and
     * jobs that go straight to `completed`, have none.
     */
    startedAt: v.optional(v.number()),
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
    /**
     * A short, human-sayable number for the finished document, allocated from
     * the business's own sequence when it is locked. Optional because a draft
     * has none, and because reports finalised before this existed were never
     * given one — a fabricated number would misrepresent the order documents
     * were actually issued in.
     */
    reportNumber: v.optional(v.number()),
    /**
     * Which answers the app worked out rather than read off a record — the
     * forecast, the booked start time — and when the technician confirmed
     * each. Its own column, never inside `data`: the client replaces that
     * blob wholesale every couple of seconds, so provenance stored there
     * would be destroyed by the next keystroke.
     *
     * An answer listed here and not yet confirmed blocks finalise. That is
     * the whole point: a guess must never print under a signature unseen.
     */
    prefill: v.optional(
      v.record(
        v.string(),
        v.object({
          source: v.union(
            v.literal('forecast'),
            v.literal('scheduled'),
            v.literal('lastVisit'),
            v.literal('history'),
          ),
          confirmedAt: v.optional(v.number()),
        }),
      ),
    ),
    // Kept out of `data` deliberately: it lived there once and every finalise
    // silently discarded the photos by overwriting the blob.
    photoSlots: v.optional(v.record(v.string(), v.id('_storage'))),
    // Out of `data` for exactly the reason above, and more urgently: autosave
    // rewrites that blob every couple of seconds, so a signature stored inside
    // it would be destroyed by the next keystroke elsewhere on the form.
    /**
     * What was signed, by whom, and against which words.
     *
     * A signature is evidence, so it carries its own provenance: the image in
     * storage, when it was drawn, the statement printed above it and the
     * revision of the form that statement belongs to. Under the Electronic
     * Transactions Act what makes a signature stand up is the link between the
     * person, the act and the document — a bare storage id records none of it.
     *
     * The union is the expand step of a migration: rows written before this
     * hold a plain storage id. Read both through `signatureOf()`.
     */
    signatureSlots: v.optional(
      v.record(
        v.string(),
        v.union(
          v.id('_storage'),
          v.object({
            storageId: v.id('_storage'),
            signedAt: v.number(),
            /** Drawn here, or the technician's own saved signature reused. */
            method: v.union(v.literal('drawn'), v.literal('saved')),
            /** The name typed by whoever signed, where the form asks for one. */
            signedBy: v.optional(v.string()),
            /** The words agreed to, frozen: terms can be edited afterwards. */
            statement: v.optional(v.string()),
            templateVersion: v.optional(v.number()),
            /** Whose device captured it — not necessarily who signed. */
            capturedByMembershipId: v.optional(v.id('memberships')),
          }),
        ),
      ),
    ),
    finalisedAt: v.optional(v.number()),
    /**
     * The current rendered file, denormalised from the newest `reportPdfs`
     * row so a download is one read. The rows are the record; this is the
     * pointer.
     */
    pdfStorageId: v.optional(v.id('_storage')),
    /**
     * Where a render is up to. `generating` is a claim, taken before the work
     * starts, so two tabs opening the PDF tab at once do not both render and
     * leave one blob orphaned in storage forever.
     */
    pdfStatus: v.optional(
      v.union(
        v.literal('pending'),
        v.literal('generating'),
        v.literal('ready'),
        v.literal('failed'),
      ),
    ),
    /** Which renderer drew the current file — see `RENDER_VERSION`. */
    pdfRenderVersion: v.optional(v.number()),
    pdfGeneratedAt: v.optional(v.number()),
    /**
     * A watermarked render of this draft, for looking at before locking.
     *
     * At most one per report: each preview deletes the last one, and finalise
     * deletes it altogether. A preview is a throwaway of a document that does
     * not exist yet, and keeping every one a technician asked for would fill
     * storage with files nobody can tell apart.
     */
    previewStorageId: v.optional(v.id('_storage')),
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
    /**
     * Last touched — an answer typed, a photo added, a lock closed.
     *
     * The library orders by this, because a technician looking for "the one I
     * was filling in" means the one they last touched, not the one they
     * started first. Optional only because rows written before it exist;
     * `migrations/reportsLibrary.ts` backfills them to `finalisedAt ??
     * createdAt` so nothing sorts below everything forever.
     */
    updatedAt: v.optional(v.number()),
    /**
     * What the search box matches: the client, the suburb, the form's name and
     * the report number, in one string.
     *
     * Denormalised because none of those live on this row — they are resolved
     * at read time from the property, the client and the template — and a
     * search index can only see fields it holds. Written at create, refreshed
     * whenever the report is attached to a job or locked. A client renamed
     * mid-draft therefore stays findable under the name it had until the
     * report is finalised, which is the trade for not rewriting every draft
     * of a client whenever their name changes.
     */
    searchText: v.optional(v.string()),
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
    .index('by_business_status_template', ['businessId', 'status', 'template'])
    // The library's own order, paginated.
    .index('by_business_updated', ['businessId', 'updatedAt'])
    // The nightly purge's range scan; undefined sorts below every number.
    .index('by_deletedAt', ['deletedAt'])
    .searchIndex('search', {
      searchField: 'searchText',
      filterFields: ['businessId'],
    }),

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
    /**
     * The shape of the image, as uploaded.
     *
     * Recorded so a document can print a photo at its own aspect instead of
     * centre-cropping it into a fixed box — on evidence, a crop can remove the
     * very thing the photo was taken to show. Optional: rows written before
     * this, and images this browser could not decode, have no dimensions, and
     * a reader that cannot tell falls back to the fixed box rather than
     * guessing a shape.
     */
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    bytes: v.optional(v.number()),
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
   * A business's own settings for a form it did not write.
   *
   * The three Pest M8 forms are reproduced word for word and stay that way —
   * their wording is the contract. But a few things on the page belong to the
   * business rather than the form: what its cover says, what its footer calls
   * it, and who has to sign before it can be locked. Changing those used to
   * mean cloning the whole template into a custom one, which forks the wording
   * too and loses every later correction to it.
   *
   * Structural changes still go through `cloneBuiltin`. This is only for the
   * parts a business owns.
   */
  templateSettings: defineTable({
    businessId: v.id('businesses'),
    /** A built-in's id today; a custom template's id when those want settings. */
    templateRef: v.string(),
    /**
     * Overrides merged over the form's own `PrintSpec`. Only the keys a
     * business owns — nothing here can change a printed question or answer.
     */
    print: v.optional(
      v.object({
        cover: v.optional(
          v.object({
            title: v.optional(v.string()),
            subtitle: v.optional(v.string()),
          }),
        ),
        /** What the running footer and the title band call this form. */
        formName: v.optional(v.string()),
      }),
    ),
    /**
     * Which signature slots must hold an image before a report can lock.
     *
     * The forms barely validate; the app added "the technician must sign",
     * which is right for most businesses and wrong for the ones where the
     * office locks reports the next morning. An empty array means the form's
     * own `required` flags stand.
     */
    requiredSigners: v.optional(v.array(v.string())),
    updatedByMembershipId: v.id('memberships'),
    updatedAt: v.number(),
  }).index('by_business_template', ['businessId', 'templateRef']),

  /**
   * Every attempt to send a report to somebody, and what was attached.
   *
   * A row is written BEFORE the provider is called, so a send that dies
   * mid-flight leaves a record rather than nothing. It names the
   * `reportPdfs` row it attached, which is what makes "which file did the
   * client receive on 28 August?" a question with an answer once the
   * renderer has moved on.
   *
   * `pendingApproval` is the recipient rule: a technician may send to the
   * addresses already on the client's record, and anywhere else waits for an
   * owner. The row exists either way, so an approval is a decision about a
   * real request rather than a fresh one typed from memory.
   */
  reportDeliveries: defineTable({
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    /** Absent only if the render failed before anything could be attached. */
    pdfId: v.optional(v.id('reportPdfs')),
    to: v.array(v.string()),
    cc: v.array(v.string()),
    subject: v.string(),
    /** The form's own send-copy toggle, or someone pressing Send. */
    trigger: v.union(v.literal('finalise'), v.literal('manual')),
    status: v.union(
      v.literal('queued'),
      v.literal('pendingApproval'),
      v.literal('sent'),
      v.literal('failed'),
      v.literal('bounced'),
    ),
    /** Resend's id, for matching a webhook back to this row. */
    providerMessageId: v.optional(v.string()),
    error: v.optional(v.string()),
    /** Who asked for it. Absent when the form asked, at finalise. */
    sentByMembershipId: v.optional(v.id('memberships')),
    approvedByMembershipId: v.optional(v.id('memberships')),
    createdAt: v.number(),
    /** Set when the provider accepted it, which is what "Sent" means here. */
    sentAt: v.optional(v.number()),
  })
    .index('by_report', ['reportId'])
    // The owner's approval queue, and nothing else reads by status.
    .index('by_business_status', ['businessId', 'status'])
    // "how many has this person sent in the last hour" — the send limit.
    .index('by_sender', ['sentByMembershipId', 'createdAt'])
    // A provider webhook arrives knowing only its own message id.
    .index('by_provider_message', ['providerMessageId']),

  /**
   * Every PDF this report has ever been rendered as, newest last.
   *
   * Append-only, and superseded files are kept rather than deleted. A client
   * who was emailed a report in August must still be able to be shown the file
   * they were actually sent, whatever the renderer does afterwards — and once
   * deliveries record which row they attached (Phase 5), "which file did they
   * receive?" has an answer instead of an assumption.
   *
   * `reports.pdfStorageId` is the denormalised pointer at the newest row.
   */
  reportPdfs: defineTable({
    businessId: v.id('businesses'),
    reportId: v.id('reports'),
    storageId: v.id('_storage'),
    /** The painter that drew it. A bump re-renders on next open. */
    rendererVersion: v.number(),
    /** The wording it was drawn from, mirroring `reports.templateVersion`. */
    templateVersion: v.optional(v.number()),
    /** The report's own amendment version — 1 until amendments exist. */
    version: v.number(),
    bytes: v.number(),
    createdAt: v.number(),
  }).index('by_report', ['reportId']),

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
    options: v.array(
      v.object({
        value: v.string(),
        label: v.string(),
        /**
         * The handful this business reaches for. A picker puts them first,
         * which is the difference between scrolling thirteen products and
         * tapping the one used on nine jobs out of ten.
         *
         * Never reaches the template: `loadOverrides` maps to `{value,label}`
         * explicitly, because an extra field would mint a new snapshot row at
         * finalise for a change that prints nothing.
         */
        usual: v.optional(v.boolean()),
      }),
    ),
    /**
     * Options this business has stopped offering.
     *
     * Kept rather than deleted: reports that already chose one still print it
     * (an answer stores its own words), and a product coming back off the
     * shelf is common enough that retyping it exactly — including the active
     * constituent in brackets — is a needless chance to get it wrong.
     */
    archived: v.optional(
      v.array(v.object({ value: v.string(), label: v.string() })),
    ),
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

  /**
   * Wording a business reuses in the long-answer boxes.
   *
   * The three forms have fifty-one of them between them — twenty-three on the
   * Timber report alone, one per conducive condition — and the sentences that
   * go in are the same sentences, visit after visit, typed with one thumb in
   * somebody's back garden. A phrase is offered, never applied: it goes in
   * when it is tapped and can be edited afterwards like anything typed.
   *
   * Shared across the business rather than kept per member, so an owner can
   * write the wording they want issued once and everyone has it. Any member
   * may add one — this is text a technician could type anyway, so saving it
   * grants no authority the form did not already give them. Unlike an option
   * library, which IS the answer, a phrase is only a head start on one.
   */
  reportSnippets: defineTable({
    businessId: v.id('businesses'),
    /** The field it was written for — wording belongs to the question. */
    fieldKey: v.string(),
    text: v.string(),
    createdByMembershipId: v.id('memberships'),
    /** The order they are offered in: what gets used rises. */
    usedCount: v.number(),
    lastUsedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index('by_business_field', ['businessId', 'fieldKey']),
})
