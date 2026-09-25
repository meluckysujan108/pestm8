import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

/**
 * `contractor` is new: a member who has a team of subcontractors, sees their
 * own jobs, dispatches to their team, and can be given read-write access to
 * their team's accounts. Widening a union is additive — every row already
 * stored is still valid — so this deploys ahead of anything that writes it.
 *
 * `subcontractor` is deliberately unchanged rather than renamed. A rename
 * would rewrite every membership row before any new code could read it, and
 * the old PWA would then fail to validate its own members mid-session.
 */
export const role = v.union(
  v.literal('owner'),
  v.literal('contractor'),
  v.literal('subcontractor'),
)

/**
 * The four per-person toggles, stored as one object rather than four columns.
 *
 * One object, because `recomputeGrants` in lib/capabilities.ts computes all
 * four together from the member and their parent: a grant is only ever valid
 * relative to who gave it, so writing one toggle without re-deriving the rest
 * is how a stale grant survives. The write matches the function.
 *
 * Absent means "legacy row, not migrated yet" — a single unambiguous check,
 * where four independent optional booleans would leave a half-written row
 * indistinguishable from a deliberately-all-off one.
 *
 * `switchInto` holds the CONTRACTOR'S id, not `true`. See the long note in
 * lib/capabilities.ts: an id names who granted it, so moving a subcontractor
 * to another team makes the grant inert by construction rather than by
 * remembering to run cleanup.
 */
export const grants = v.object({
  switchInto: v.union(v.null(), v.id('memberships')),
  clientDirectory: v.boolean(),
  prices: v.boolean(),
  otherSchedules: v.boolean(),
})
export const membershipStatus = v.union(
  v.literal('active'),
  v.literal('invited'),
  v.literal('removed'),
)

/**
 * What a person may set a job to: every status but `recurring`. `pending` is
 * where every job booked by hand starts.
 *
 * `inProgress` was retired on 2026-09-22. A deployment still holding rows
 * with it cannot take this schema until convex/migrations/jobStatusV1.ts has
 * run — its header has the sequence.
 */
export const settableJobStatus = v.union(
  v.literal('pending'),
  v.literal('booked'),
  v.literal('completed'),
  v.literal('invoiced'),
  v.literal('cancelled'),
)

/**
 * `recurring` marks a visit the recurrence engine projected onto the calendar
 * and nobody has acted on yet — the job-shaped equivalent of a draft order.
 * Only the engine writes it, and only when it inserts the visit; once a job
 * moves to any other status it can never move back (convex/lib/jobStatus.ts).
 */
export const jobStatus = v.union(
  v.literal('recurring'),
  ...settableJobStatus.members,
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

/**
 * The four fixed intervals a Recurring Job could be sold on before custom
 * ones existed. Retired by convex/migrations/recurringIntervalV1.ts, which
 * rewrites every row as an `intervalCount`/`intervalUnit` pair; kept here
 * only so rows written before that migration still validate, and so the
 * migration itself has a name for what it is reading. Nothing writes it.
 */
export const frequency = v.union(
  v.literal('monthly'),
  v.literal('quarterly'),
  v.literal('sixMonthly'),
  v.literal('yearly'),
)

/** How a Recurring Job's repeat interval is counted. */
export const intervalUnit = v.union(
  v.literal('day'),
  v.literal('week'),
  v.literal('month'),
  v.literal('year'),
)

export const clientKind = v.union(v.literal('person'), v.literal('business'))

/**
 * How a property's address was last entered: 'picked' from the address
 * suggestions and unchanged when saved, or 'typed' (by hand, or a suggestion
 * changed afterwards — autofill rewrites a suburb or postcode after the pick).
 * Only a record of how the form saw it; nothing is refused on it.
 */
export const addressCheck = v.union(v.literal('picked'), v.literal('typed'))

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
    /**
     * The contractor this subcontractor works under — the only representation
     * of "a contractor has a team". Null/absent for the owner, for
     * contractors, and for subcontractors nobody has placed yet (who see only
     * their own work, which is the safe default).
     *
     * Self-reference into this same table, so an id is enough; there is no
     * separate teams table to drift out of step with the memberships.
     */
    parentMembershipId: v.optional(v.id('memberships')),
    /** The four toggles. Absent = a row from before this model existed; see
     * `grants` above and `recomputeGrants` in lib/capabilities.ts. Readers
     * fall back to the legacy `canViewAllJobs` / `canViewOtherAccounts`
     * fields until the migration has run. */
    grants: v.optional(grants),
    /**
     * The name attribution prints, frozen on the membership rather than read
     * live from the Better Auth user.
     *
     * Read live, someone who leaves and renames their account would rewrite
     * their own name wherever attribution shows one. Absent means "no snapshot
     * yet, read the user", which is still today's behaviour: no reader has
     * been moved onto this column yet. It is captured now because a name can
     * only be frozen while it is still true — the per-person activity view is
     * what will read it. A signed report is already safe by a different route,
     * freezing the technician into `reports.contextSnapshot` at finalise.
     */
    displayName: v.optional(v.string()),
    licenceNumber: v.optional(v.string()),
    /**
     * When `licenceNumber` stops being valid. Absent means unknown, and
     * `licenceStatus` in lib/capabilities.ts reads unknown as valid rather
     * than expired — nobody is locked out of finalising by a field that has
     * never been filled in.
     */
    licenceExpiresOn: v.optional(v.number()),
    /**
     * The licence itself (Phase 8.1): a photo of the card or the regulator's
     * PDF, uploaded by its holder from Profile. See `convex/licences.ts` for
     * who may read it — the holder and the owner, nobody else.
     *
     * Optional and additive, so no migration: absent means none uploaded.
     * Replacing or removing it drops this pointer and nothing else — the old
     * file stays in storage, as every file in this app does (`products.ts`
     * has the reasoning).
     */
    licenceFile: v.optional(
      v.object({
        storageId: v.id('_storage'),
        /** Which viewer opens it: the PDF viewer or the image viewer. */
        kind: v.union(v.literal('pdf'), v.literal('image')),
        /** As claimed: application/pdf, image/png or image/jpeg. */
        contentType: v.string(),
        /** Tidied, ending in the extension of what it is. */
        fileName: v.string(),
        /** Bytes, from storage — never from the client. */
        size: v.number(),
        /** Also the identity of this version of the file, for the copy kept
         * on the holder's phone. */
        uploadedAt: v.number(),
      }),
    ),
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
    // Offboarding. `status: 'removed'` existed from the start but nothing ever
    // wrote it — there was no way to remove anyone — so these record who cut
    // access off and when, which is the part a compliance dispute asks about.
    removedAt: v.optional(v.number()),
    removedByMembershipId: v.optional(v.id('memberships')),
  })
    .index('by_user', ['userId'])
    .index('by_business', ['businessId'])
    .index('by_user_business', ['userId', 'businessId'])
    // "Who is on my team" on every dispatch, roster and switch-target read.
    // Without it that answer is a full scan of the business filtered in
    // memory, which is also how an owner-row leak gets written by accident.
    .index('by_business_parent', ['businessId', 'parentMembershipId'])
    // "Is this upload already someone's licence?" — asked before any feature
    // claims a file, so one file is never two people's, and before anything
    // deletes one. The table is a business's handful of people, so the
    // backfill on deploy is nothing.
    .index('by_licenceFile_storageId', ['licenceFile.storageId']),

  /**
   * My licences: every licence a person holds — pest management, fumigation,
   * a white card, a driver's licence — each named by them, with an optional
   * number and expiry, and up to six files (`memberLicenceFiles`). See
   * `convex/memberLicences.ts` for who may do what: the holder writes, the
   * owner reads, nobody else sees them.
   *
   * SEPARATE from `memberships.licenceNumber`, which prints on reports and
   * decides whether one may be finalised. Nothing here feeds that.
   *
   * Per membership, like the rest of a person's standing in a business: the
   * same person in two businesses keeps two wallets. New table, so nothing to
   * migrate but the Phase 8.1 document (`migrations/licenceWalletV1`).
   */
  memberLicences: defineTable({
    businessId: v.id('businesses'),
    /** The holder — who may change it, and the only one. */
    membershipId: v.id('memberships'),
    /** As the holder calls it, tidied (`cleanLicenceName`): 1–80 characters. */
    name: v.string(),
    /** Up to 60 characters; absent when there is none. */
    number: v.optional(v.string()),
    /**
     * The last day it is good for, as a calendar date `YYYY-MM-DD`
     * (`checkExpiresOn`) — never a timestamp, so it is the same day wherever
     * it is read. Absent when unknown or it does not expire.
     */
    expiresOn: v.optional(v.string()),
    createdAt: v.number(),
    /** Any change to it, its files included. */
    updatedAt: v.number(),
  })
    // A person's wallet — capped at MAX_LICENCES, so always a short read.
    .index('by_membership', ['membershipId'])
    .index('by_business', ['businessId']),

  /**
   * A licence's files: the card photographed front and back, the regulator's
   * PDF. One row per file, not an array on the licence, so adding one never
   * rewrites the others. Capped at MAX_LICENCE_FILES per licence.
   *
   * The same shape and the same claim as `memberships.licenceFile`
   * (`claimLicenceFile` in lib/licenceClaims.ts), and never deleted with its
   * row — no `ctx.storage.delete` for a licence, ever (`licences.ts`).
   */
  memberLicenceFiles: defineTable({
    /** Copied from the licence, so a row answers who may read it by itself. */
    businessId: v.id('businesses'),
    membershipId: v.id('memberships'),
    licenceId: v.id('memberLicences'),
    storageId: v.id('_storage'),
    /** Which viewer opens it: the PDF viewer or the image viewer. */
    kind: v.union(v.literal('pdf'), v.literal('image')),
    /** As claimed: application/pdf, image/png or image/jpeg. */
    contentType: v.string(),
    /** Tidied, ending in the extension of what it is. */
    fileName: v.string(),
    /** Bytes, from storage — never from the client. */
    size: v.number(),
    /** Also the identity of this version of the file, for a copy kept on the
     * holder's phone. */
    uploadedAt: v.number(),
  })
    // A licence's files, in the order they were added.
    .index('by_licence', ['licenceId', 'uploadedAt'])
    // "Is this upload already someone's licence?" (`heldAsLicence`) — asked
    // before any feature claims a file and before anything deletes one.
    .index('by_storage', ['storageId']),

  // First-class, deliberately NOT derived from job history: reports must stay
  // findable by address years later, whether or not the original job survives.
  /**
   * An invitation is a single-use capability, not a name on a list.
   *
   * It used to be claimed by matching the signed-in user's email address,
   * automatically, on every visit to "/". Since email verification is off and
   * sign-up was open, whoever registered an invited address first joined the
   * business — so an invitation was really an offer to the whole internet.
   *
   * Now the link itself is the credential: 32 random bytes generated in an
   * action, of which only the SHA-256 hash is stored, so a database read
   * cannot mint a working link. The email is kept as a binding (the invitee
   * must sign up with that address) and as the thing the owner recognises.
   */
  invitations: defineTable({
    businessId: v.id('businesses'),
    email: v.string(),
    role,
    invitedByMembershipId: v.id('memberships'),
    claimedAt: v.optional(v.number()),
    createdAt: v.number(),
    // Optional through EXPAND: rows written before token invites have none,
    // and `inviteState` treats a row with no hash as legacy/unusable rather
    // than as a valid open invitation.
    tokenHash: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    // Soft revoke. A hard delete left no record of how someone joined, or of
    // an invite an owner deliberately withdrew.
    revokedAt: v.optional(v.number()),
    // Who actually redeemed it, and what membership that produced — so the
    // team roster can answer "how did this person get in?" years later.
    claimedByUserId: v.optional(v.string()),
    claimedMembershipId: v.optional(v.id('memberships')),
  })
    .index('by_email', ['email'])
    .index('by_business', ['businessId'])
    .index('by_token_hash', ['tokenHash']),

  properties: defineTable({
    businessId: v.id('businesses'),
    clientId: v.id('clients'),
    addressLine: v.string(),
    suburb: v.string(),
    state: v.string(),
    postcode: v.string(),
    lat: v.optional(v.number()),
    lng: v.optional(v.number()),
    // The person on site at a business client's property (Prompt 6.3): the
    // store manager, the caretaker, the tenant who lets the technician in.
    // Their number is what the job card's Call dials for a visit here, over
    // the client's main line — see convex/lib/siteContact.ts. Absent when
    // blank; a person client's are kept but not shown or dialled.
    siteContactName: v.optional(v.string()),
    siteContactPhone: v.optional(v.string()),
    // Written only when a form says how the address was entered (see
    // `addressCheck` above), with when. Absent on every property saved
    // before field verification, and on any saved by an older screen.
    addressCheck: v.optional(addressCheck),
    addressCheckedAt: v.optional(v.number()),
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
    // The CUSTOMER's ABN, a business-kind client's (Prompt 6.1): eleven
    // digits, checksum-valid (convex/lib/abn.ts). Not `businesses.abn`, which
    // is the pest business's own. Kept, not shown, if the client is switched
    // to a person. Its contact person is its primary `clientContacts` row.
    abn: v.optional(v.string()),
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
     * For a visit of a Recurring Job: the instant the engine PROJECTED it
     * onto, which stops being `scheduledAt` the moment anybody moves it.
     *
     * The engine has to answer "does this occurrence already exist?" on every
     * cron run, and it used to ask by matching `scheduledAt` exactly. Move a
     * projected visit two hours later — an ordinary edit, and the job detail
     * sheet offers it — and the original instant is free again, so the next
     * run books a second visit there. The property is double-booked and the
     * series grows a phantom visit per reschedule. Matching on this instead
     * means a moved visit still occupies its occurrence.
     *
     * Optional: visits projected before this field existed have none, and
     * `?? scheduledAt` reads them exactly as the old code did.
     */
    occurrenceAt: v.optional(v.number()),
    /**
     * When work actually began, stamped the moment a job moved to the retired
     * `inProgress` status. A report started from the job seeds its "Start
     * Time:" from this as a fact; without it the report offers `scheduledAt`
     * as a suggestion to confirm. Nothing writes it since `inProgress` was
     * retired (2026-09-22) — the jobs that reached it keep theirs.
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
    /**
     * The client's own reference for this visit — a facilities company's work
     * order or PO number — which their accounts team needs on the invoice
     * before they will pay it. Free text, trimmed, absent when there is none
     * (`lib/workOrder.ts`). Locked with the other details once a job is
     * invoiced, since the invoice already carries it.
     */
    workOrder: v.optional(v.string()),
  })
    .index('by_business_date', ['businessId', 'scheduledAt'])
    .index('by_assignee_date', ['assignedMembershipId', 'scheduledAt'])
    .index('by_property', ['propertyId'])
    .index('by_business_status', ['businessId', 'status'])
    // The Job tab lists jobs newest-BOOKED first, which neither date index can
    // answer: both order by `scheduledAt`. Convex appends `_creationTime` to
    // every index, so a businessId/assignee-only index read descending is
    // exactly "most recently created first". One per scope, because a
    // subcontractor's list is read the same way as the owner's.
    .index('by_business', ['businessId'])
    .index('by_assignee', ['assignedMembershipId'])
    // The Job tab's list by status, per assignee — the counterpart of
    // `by_business_status` for a subcontractor or a team. Newest-created first
    // within a status, like every index here (`_creationTime` is appended),
    // so the Job tab can ask for booked work without reading the projections
    // (`jobsNewestFirst` in lib/jobScope.ts).
    .index('by_assignee_status', ['assignedMembershipId', 'status'])
    // Materialising recurrences must be idempotent, which means asking "does
    // this occurrence already exist" on every cron run.
    .index('by_recurrence', ['recurrenceId']),

  // A Recurring Job: the standing arrangement, of which each `jobs` row
  // carrying this row's id is one visit.
  recurrences: defineTable({
    businessId: v.id('businesses'),
    propertyId: v.id('properties'),
    assignedMembershipId: v.id('memberships'),
    /**
     * How often it repeats, as a whole number of `intervalUnit`s — "every 2
     * weeks", "every 15 years". Optional only for the expand phase of
     * convex/migrations/recurringIntervalV1.ts; every row written since
     * carries both, and `intervalOf` (convex/lib/recurrence.ts) is what reads
     * them so no caller has to know about the gap.
     */
    intervalCount: v.optional(v.number()),
    intervalUnit: v.optional(intervalUnit),
    /** Retired. See `frequency` above and the migration's header. */
    frequency: v.optional(frequency),
    jobType: v.string(),
    price: v.number(),
    anchorDate: v.number(),
    active: v.boolean(),
    /**
     * The work order every visit of the series is booked under — commercial
     * contracts are mostly a quarterly or monthly service against one standing
     * PO. Copied onto each visit as it is projected, like `jobType` and
     * `price`; a visit's own copy is then edited on its own.
     */
    workOrder: v.optional(v.string()),
  })
    .index('by_business', ['businessId'])
    // The Recurring Job view counts active series, not projected visits, so
    // it asks this question on every load for every business.
    .index('by_business_active', ['businessId', 'active']),

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
     * Which issue of this report number this document is.
     *
     * A finalised report is never edited — that is the whole point of
     * finalising — so a correction is a NEW report that supersedes the old
     * one and carries the same `reportNumber` at a higher version. The client
     * keeps whatever they were sent; the footer says which issue it is, and
     * the superseded document says on its face that it was replaced.
     *
     * Absent means 1, which is what every report issued before amendments
     * existed was.
     */
    version: v.optional(v.number()),
    /** The report this one corrects. Set on the amendment. */
    supersedesReportId: v.optional(v.id('reports')),
    /** The amendment that replaced this one. Set on the original. */
    supersededByReportId: v.optional(v.id('reports')),
    /**
     * Why it was reissued, in the owner's words. Printed on the amendment,
     * because a client holding two documents with the same number is owed an
     * explanation of the difference.
     */
    amendmentReason: v.optional(v.string()),
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
     * Rows written before this held a plain storage id. They were converted
     * by `migrations/signatureRecords` (prod and dev both reported zero bare
     * ids), and the bare-id arm of this validator was then dropped — the
     * contract step of that migration.
     */
    signatureSlots: v.optional(
      v.record(
        v.string(),
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
    finalisedAt: v.optional(v.number()),
    /**
     * Who pressed Finalise, which is not always whose report it is.
     *
     * `authorMembershipId` and `contextSnapshot.technician` are the account
     * the report belongs to — the licensed name the certificate prints. This
     * records the human. On an unswitched finalise they are the same person
     * and this is still written, so "absent" means only "finalised before
     * this field existed", never "nobody knows".
     *
     * Regulated templates additionally refuse to finalise while switched at
     * all (`canFinaliseReport`), so on those this equals the holder by
     * construction — the field is what lets that be audited rather than
     * assumed.
     */
    finalisedByMembershipId: v.optional(v.id('memberships')),
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
     * SUPERSEDED by `templateSnapshotId`: nothing writes or reads it, and
     * `migrations/reportsContract:clearCustomSnapshots` empties it. Still
     * declared on purpose. Dropping the line would refuse the push to any
     * deployment still holding an old row — the shared e2e deployment among
     * them — and the migration that empties them would have to go with it,
     * all to delete one optional field that is always absent.
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
     * Backfilled to 1 on every row that predated it, then made required once
     * prod and dev both reported none missing, so "was this written before or
     * after the rewrite?" is answerable without guessing from dates.
     */
    templateVersion: v.number(),
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
   *
   * `visibility` is separate from what a note is about. Absent, a note is
   * shared as above — every note written before it existed. `'private'` is a
   * personal note (Phase 5.3, the owner's amendment to knowledge-first): read
   * and written by its author, read — never written — by the business owner,
   * and by nobody else, whatever their job scope or @mentions. A personal note
   * is never linked to a job, site or client; it is shared first.
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
    visibility: v.optional(v.literal('private')),
  })
    .index('by_business_updated', ['businessId', 'updatedAt'])
    // "My notes": one person's personal notes, newest edited first.
    .index('by_authorMembershipId_and_visibility_and_updatedAt', [
      'authorMembershipId',
      'visibility',
      'updatedAt',
    ])
    // The owner's "Everyone's notes": every personal note in the business.
    .index('by_businessId_and_visibility_and_updatedAt', [
      'businessId',
      'visibility',
      'updatedAt',
    ])
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
    // Only the rest of that day: MET Norway, standing in for Open-Meteo,
    // forecasts from the current hour. Shown on the card as such, refetched
    // sooner, and never used as a report's weather (reports.cachedForecast).
    partial: v.optional(v.boolean()),
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
   * A suburb the geocoder has no populated place for, in that state — a typo
   * ("Fannybay"), a test entry, or a name it does not know. Remembered for a
   * day so every view of a job there does not ask again. Only a genuine "no
   * such place" is written: a refused or failed request is not an answer.
   */
  geocodeMisses: defineTable({
    suburbKey: v.string(),
    state: v.string(),
    missedAt: v.number(),
  }).index('by_suburb_state', ['suburbKey', 'state']),

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

  /**
   * An open "acting in someone else's account" session.
   *
   * Keyed by the Better Auth SESSION id, not the user or the membership, and
   * that is the whole design:
   *
   *  - Signing out ends it. There is no switch state that outlives the
   *    credential it was started with.
   *  - Each device is independent. A contractor working in a sub's account on
   *    the office iPad does not silently redirect what they tap on their own
   *    phone — which, with writes attributed to the account, is how the wrong
   *    person's name ends up on a report.
   *
   * A row is permission to *attempt*, never permission itself: every read and
   * every write re-evaluates `canSwitchInto` against the live memberships, so
   * revoking a toggle or moving a team takes effect on the next request
   * whether or not anything deletes this row. Deletion is hygiene, not
   * security. `expiresAt` is the same kind of belt-and-braces (12 hours) —
   * it only stops a forgotten switch living overnight on a shared phone.
   */
  accountSwitches: defineTable({
    sessionId: v.string(),
    businessId: v.id('businesses'),
    realMembershipId: v.id('memberships'),
    targetMembershipId: v.id('memberships'),
    startedAt: v.number(),
    expiresAt: v.number(),
  })
    // The hot path: resolved once per request, before anything else runs.
    .index('by_session', ['sessionId'])
    // Both directions of cleanup — removing a member, or revoking the grant
    // that let someone into their account.
    .index('by_real', ['realMembershipId'])
    .index('by_target', ['targetMembershipId']),

  /**
   * The owner's chosen view on one device: "Just my jobs" instead of the whole
   * business. No row is God view, which is the default.
   *
   * Keyed by the Better Auth SESSION, like `accountSwitches`, and for the same
   * reason: the phone in a roof void and the desktop in the office are
   * different places to be looking from. His phone can sit on his own jobs all
   * day while the office machine keeps showing everyone's.
   *
   * It narrows what a LIST shows, never what anyone may do — see `listScope`
   * in lib/actor.ts — so a stale or orphaned row can cost nothing but a
   * narrower schedule, and deleting one is hygiene. Rows die with their
   * session (`views.sweepEnded`) or their membership (`team.offboard`).
   */
  sessionViews: defineTable({
    sessionId: v.string(),
    businessId: v.id('businesses'),
    realMembershipId: v.id('memberships'),
    mode: v.literal('mine'),
    updatedAt: v.number(),
  })
    .index('by_session', ['sessionId'])
    .index('by_real', ['realMembershipId']),

  auditLog: defineTable({
    businessId: v.id('businesses'),
    /** The human who actually did it — always the real person, never the
     * account they were working in. */
    actorMembershipId: v.id('memberships'),
    /**
     * Set only when the two differ: the account the change was made in.
     * Present means "actor on behalf of this member"; absent means they were
     * working as themselves, which is every row written before switching
     * existed.
     *
     * This is the field that makes the account holder's own history
     * answerable — "what was changed in my account, by whom" — which is the
     * thing that makes handing someone access to your account reasonable at
     * all.
     */
    onBehalfOfMembershipId: v.optional(v.id('memberships')),
    action: v.string(),
    entityType: v.string(),
    entityId: v.string(),
    meta: v.optional(v.any()),
    at: v.number(),
  })
    .index('by_business', ['businessId'])
    .index('by_entity', ['entityType', 'entityId'])
    // "Everything done in this account, newest first" — the holder-facing
    // view, and the owner's per-member activity view, are the same query.
    .index('by_account', ['onBehalfOfMembershipId', 'at']),

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
    /**
     * Work in progress, not yet issued to anybody.
     *
     * The columns above are the PUBLISHED form — what `reports.create` starts
     * a report against and what the builder fills in. This is the owner's
     * uncommitted edit of them, and the split exists for two reasons.
     *
     * One: a form being edited is half-built by definition, and a half-built
     * form must not become the one a technician opens in a driveway. Two:
     * `sections` is validated on write, so autosaving an edit through it
     * refused every keystroke that left the draft momentarily invalid — a
     * dragged field, a half-typed condition — and the refusal surfaced as
     * "check your connection", about a connection that was fine.
     *
     * So this is stored UNVALIDATED (`sections` is `v.any()` here and means
     * it), and `publish` is where the shape is checked and the issues are
     * named. Absent means there is nothing unpublished.
     */
    draft: v.optional(
      v.object({
        name: v.string(),
        shortName: v.string(),
        legalBasis: v.string(),
        blurb: v.string(),
        sections: v.any(),
        boilerplate: v.string(),
        savedAt: v.number(),
        savedByMembershipId: v.id('memberships'),
      }),
    ),
    /**
     * Which issue of this form the published columns are. Absent means 1:
     * every row that existed before publishing was a separate act from saving
     * had been issued exactly once.
     */
    publishedVersion: v.optional(v.number()),
    publishedAt: v.optional(v.number()),
    updatedByMembershipId: v.optional(v.id('memberships')),
    createdByMembershipId: v.id('memberships'),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_business', ['businessId']),

  /**
   * Every issue of a business-authored form, appended at publish.
   *
   * Distinct from `reportTemplateSnapshots`, which is content-addressed and
   * keyed to what a FINALISED REPORT was signed against. This is the form's
   * own history: what the business was issuing between one publish and the
   * next, who published it, and what it said — so "what did this form look
   * like in March?" is answerable even for a version no report was ever
   * finalised against.
   */
  customReportTemplateVersions: defineTable({
    businessId: v.id('businesses'),
    templateId: v.id('customReportTemplates'),
    version: v.number(),
    name: v.string(),
    shortName: v.string(),
    legalBasis: v.string(),
    blurb: v.string(),
    sections: v.any(),
    boilerplate: v.string(),
    terms: v.optional(v.any()),
    print: v.optional(printSpec),
    publishedByMembershipId: v.id('memberships'),
    publishedAt: v.number(),
  }).index('by_template', ['templateId', 'version']),

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
    /**
     * Who asked for it: whoever pressed Send, or — when the form asked, at
     * finalise — whoever finalised it with "Send copy…" ticked, which was
     * their instruction. It counts toward that person's send limit either way.
     */
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
   * The three forms have twenty-eight of them between them — twenty-three on
   * the Timber report alone, one per conducive condition — and the sentences that
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

  /**
   * The Products page (Phase 7.1): the tins, drums and baits a business
   * keeps, each with the things a technician reaches for on site — a photo of
   * the label, the maker's page, and one PDF (the safety data sheet, usually)
   * to open, save or send to a client who asks what went in their roof.
   *
   * Reference material and nothing more. A product links to no job, report or
   * stock level, and is NOT the `products` option set (`optionSets`, key
   * 'products'): that one is a vocabulary a report prints as an answer, owned
   * by the owner and frozen into signed documents. Renaming or deleting a row
   * here changes no report, and nothing a report says depends on this table.
   *
   * One list for the whole business. Any active member may add to it — a
   * product is something a technician has in the van, and the person who
   * found the new SDS is the one who should save it. Changing or removing one
   * is its creator's, or the owner's (`templates.manage`, as for a phrase in
   * `reportSnippets`): someone else's product is someone else's work.
   *
   * Files are never deleted with a row, or when replaced; see the note at the
   * top of `convex/products.ts` for why that cannot be done safely here.
   */
  products: defineTable({
    businessId: v.id('businesses'),
    /** As typed, trimmed. Shown as the product's title. */
    name: v.string(),
    /**
     * `name` folded (`nameKeyOf` in lib/products.ts): the list's order, and
     * the duplicate check — "Termidor" and "termidor " are one product.
     */
    nameKey: v.string(),
    description: v.optional(v.string()),
    /** Always http(s), canonical (`normaliseProductUrl`). */
    url: v.optional(v.string()),
    photoStorageId: v.optional(v.id('_storage')),
    pdfStorageId: v.optional(v.id('_storage')),
    /** The PDF's name as offered when it is saved or shared; always ends in
     * `.pdf`. Present exactly when `pdfStorageId` is. */
    pdfFileName: v.optional(v.string()),
    /** Bytes, from the stored file — so the page can say "2.4 MB" before
     * anyone commits a phone's data to opening it. */
    pdfSize: v.optional(v.number()),
    /** The REAL person who added it — never an account they were switched
     * into — which is also who may change it. */
    createdByMembershipId: v.id('memberships'),
    updatedByMembershipId: v.id('memberships'),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_businessId_and_nameKey', ['businessId', 'nameKey'])
    // "Does any product already hold this file?" — asked before a product
    // claims one, so one upload can never end up on two products.
    .index('by_pdfStorageId', ['pdfStorageId'])
    .index('by_photoStorageId', ['photoStorageId']),

  /**
   * Wrong two-step codes per ACCOUNT, across every sign-in — the cap Better
   * Auth's own lockout would keep, if it could run here (see `twoStep()` in
   * convex/auth.ts: its two columns are not in the auth component's schema).
   *
   * Without it the only limit is five codes per password sign-in, and a new
   * sign-in costs one request to someone holding the password: about 67,000
   * sign-ins find a code by chance, which is an hour's scripting. With it, ten
   * codes in a row that are not right lock the account's code check for 15
   * minutes, however many sign-ins and IP addresses they are spread over.
   *
   * One row per account that has got a code wrong since its last right one;
   * a right code deletes it. `userId` is the Better Auth user's id, a string
   * (that table lives in the component). New table, so nothing to migrate.
   */
  twoStepAttempts: defineTable({
    userId: v.string(),
    /** Codes tried since the last right one — counted as each check starts,
     * so parallel guesses cannot all slip in under the limit. */
    attempts: v.number(),
    /** Set once `attempts` reaches the limit; ms since epoch. */
    lockedUntil: v.optional(v.number()),
  }).index('by_userId', ['userId']),

  /**
   * Which session made each account's current two-step key — the claim that
   * lets the set-up screen carry on with a key it already showed, and only
   * the screen that showed it (convex/lib/twoFactorSetup.ts has the why: a
   * key nobody has proven yet can be made by anyone holding the password).
   *
   * Written by the auth after-hook once `/two-factor/enable` has made its
   * key, and only if the row it finds is the one that request made
   * (convex/twoStepSetups.ts). One row per account, replaced by the next
   * enable; a claim whose `twoFactorId` no longer names the account's row
   * counts for nothing, so a reset or a turn-off needs no clean-up here.
   * `userId`, `sessionId` and `twoFactorId` are Better Auth ids, strings
   * (those tables live in the component). New table, so nothing to migrate —
   * a key made before this existed has no claim and reads as `elsewhere`,
   * which starts again with a new key and a warning.
   */
  twoStepSetups: defineTable({
    userId: v.string(),
    sessionId: v.string(),
    twoFactorId: v.string(),
  }).index('by_userId', ['userId']),
})
