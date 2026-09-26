# PestM8 — Architecture & Product Requirements
**Version:** 2.0 (supersedes Draft v1)
**Owner:** Sujan
**Date:** August 2026
**Design source of truth:** `PestM8_dc.html` (design-partner-validated screen inventory)

---

# Part 1 — Product Foundation

## 1.1 Problem
Small Australian pest control operators (2–15 people, mixing employees and independent subcontractors) choose between generic field-service tools that aren't pest-specific (ServiceM8, Jobber), pest-specific tools priced for larger operators (PestPac, Nexus, Formitize), or nothing at all — wall calendar, paper chemical logs, manual Xero entry. The design-partner owner's exact words: nothing is both genuinely niche to pest control *and* affordable for a small operator.

## 1.2 Product definition
A calendar-first job scheduling and compliance-reporting tool for small Australian pest control businesses. Visually modeled on iOS Calendar for zero learning curve. Two structural decisions distinguish it from every competitor:

1. **Per-subcontractor Xero routing** — each subcontractor invoices the client through their *own* Xero organisation, not a shared business ledger.
2. **Australian-standard report generation** — AS 4349.3, AS 3660.2, and APVMA record-keeping built as first-class document templates, not a generic form builder.

## 1.3 Roles
| Role | Scope |
|---|---|
| **Owner** | All jobs, all calendars, team management, tenant settings. Terence in the design-partner tenant. |
| **Subcontractor** | Own jobs only by default. Can be granted "can view all jobs" per-person by the Owner — grants read visibility of property history, never edit rights on another person's booking. Kevin in the design-partner tenant. |
| **Office/Admin** | Deferred to v1.1 pending owner input (see §7 open questions). |

## 1.4 Compliance boundaries (these are product decisions, not footnotes)
- **No contractor hours, timesheets, or rostering — ever.** Australian sham-contracting law penalises arrangements where an independent contractor is treated like a rostered employee (penalties reaching ~$93,900 per breach, plus back-paid super and personal director liability). These features are deliberately absent. Surface this in the UI and marketing as a designed property.
- **Per-subcontractor Xero** is the positive expression of the same principle: independent invoicing under their own ABN is evidence of genuine contracting.
- **The durable notice cannot be fully automated.** AS 3660.2 / NCC require a physical notice fixed to the building. The app generates the label text; fixing it is a human step, tracked as an explicit manual follow-up task.

---

# Part 2 — Design System (extracted from `PestM8_dc.html`)

> *Amended (2026-09-26):* how to build with this system — which component,
> which token, every screen state, the copy rules — is now
> [`docs/design-system.md`](docs/design-system.md), which is checked against
> the code. This Part stays as the record of why the tokens and screens are
> what they are; where the two differ on how to build something, the guide wins.

## 2.1 Tokens
```
Colour — light / dark. Both themes ship; the app follows the OS unless the
person picks one in Settings → Appearance (§2.2). Only these raw tokens are
re-declared per theme, so nothing else in the system is themed twice.

                 light                  dark
  --ink          #1C1C1E                #FFFFFF    primary text
  --ink-2        #3A3A3C                #E5E5EA    body text
  --muted        #8E8E93                #98989F    secondary text
  --muted-2      #9B9BA1                #8E8E93    section labels
  --hairline     rgba(60,60,67,.10)     rgba(235,235,245,.14)
  --hairline-2   rgba(60,60,67,.07)     rgba(235,235,245,.08)
  --surface      #FFFFFF                #1C1C1E    cards
  --surface-2    #F2F2F7                #2C2C2E    inset cards
  --surface-3    #F4F4F8                #2A2A2C    input fill
  --canvas       #EDEDF1                #000000    app background
  --fill-track   rgba(118,118,128,.08)  rgba(120,120,128,.28)  segmented track
  --chrome       rgba(255,255,255,.92)  rgba(28,28,30,.82)     sticky bars
  --scrim        rgba(0,0,0,.30)        rgba(0,0,0,.60)        sheet backdrop
  --red          #FF3B30                #FF453A    primary action, brand
  --red-fill     #DC2A1F                #DC2A1F    red behind white text (buttons, selected day): 4.8:1
  --blue         #0A84FF                #0A84FF    links, contact actions
  --green        #34C759                #30D158    success
  --amber        #FF9F0A                #FF9F0A    warning accent
  --amber-ink    #985B00                #FFB340    warning text (was #B26B00: 3.98:1)
  --amber-bg     #FFF8EC                #2A1E0A    warning surface
  --amber-line   #FFE2B8                #4D3712    warning border

  Job status ramps (Phase 4.3), one per hue, each a -bg / -line / -ink triple:
  --orange-*  Recurring   --red-*   Pending    --yellow-*  Booked
  --green-*   Completed   --blue-*  Invoiced   --grey-*    Cancelled
  Every -ink clears 7:1 on its -bg (grey 6.3:1) and every -line 3:1 on the
  card, in both themes — checked against this file by statusColours.test.ts.
  Which status takes which hue is decided once, in src/lib/statusColours.ts.
  --overdue / --overdue-ink = --ink / --surface: overdue carries no hue.

  Three signals share a job card, so each keeps its own form: a solid mark
  with no text is a PERSON (the technician colour, convex/lib/colours.ts —
  the owner sets it in Settings → Team); a bordered tinted pill with a word is
  a STATUS; ink with no hue is OVERDUE; and amber with a pale border stays a
  WARNING. Completed is green since 4.3 — the "raise the invoice" prompt
  lives on Analytics' Awaiting invoice figure, which links to those jobs.

  Dark inverts the elevation model: --canvas is black and cards sit *above* it,
  where light has white cards on a grey canvas. --blue and --amber do not move
  because the light palette already uses iOS's *dark* systemBlue/systemOrange.
  Printed surfaces do not follow the theme — the report preview pins itself
  light so it goes on matching the PDF (ReportDocument.tsx).

Typography — -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui
  H1 page title      28px / 700 / -.024em
  Sheet title        21–22px / 700 / -.024em
  Metric (large)     36px / 700 / -.032em
  Metric (medium)    32px / 700 / -.032em
  Metric (small)     26px / 700 / -.024em
  Row title          16–17px / 600 / -.015em
  Body               15px / 400
  Secondary          13–14px / 400
  Section label      11px / 700 / .07em / uppercase
  Tab label          10px / 600
  Mono (notice/PDF)  ui-monospace, SFMono-Regular, Menlo

Radius     card 18–22px · input 12px · segmented 8–9px · pill 100px · sheet 22px top
Elevation  0 1px 2px rgba(16,17,26,.04), 0 10px 24px -16px rgba(16,17,26,.26)
Red button 0 1px 2px rgba(255,59,48,.22), 0 8px 18px -10px rgba(255,59,48,.55)
Motion     sheetUp .26s cubic-bezier(.32,.72,0,1) · fadeIn .2s · button active scale(.975)
Chrome     sticky header + tab bar, var(--chrome) + backdrop-filter blur(24px) saturate(180%)
Numerals   font-variant-numeric: tabular-nums globally
Shell      max-width 460px centred on canvas
```

## 2.2 Screen inventory
**Tabs (6):** Dashboard · Schedule · Clients · Invoices · Reports · Notes

**Settings:** reached via avatar in header (not a tab), 3 segments — Profile / Team / Preferences

*Amended (reports Phase 6):* a fourth segment, **Reports**, owner-only. It holds the business's option libraries — the nineteen vocabularies the forms draw on — one card per list opening a sheet that adds, renames, reorders, stars the usual few, archives and restores. The forms' wording is reproduced verbatim and is not the business's to change; the lists of answers ARE, and until this existed changing one needed a developer.

*Amended (Settings redesign):* the segments are gone. Settings is now a hub — a grouped list, iOS-style — whose rows each open their own page: **You** (My details, Licence, Two-step sign-in), **Business** (Business details, Team → one page per member, Reports → Answer lists; each row shown only to whoever holds the capability its page needs), About, and Sign out. Old `?seg=` links redirect to the page that replaced the tab. The building blocks (groups with headings outside the card, field rows, the Save bar that shows only while there is something to save, the red last group) are `src/components/settings/ui.tsx`.

*Amended (Appearance moves to Settings):* the header's account button is gone. Its Appearance picker (Light / Dark / System) is now the hub's **Appearance** page, beside About — saved per device, as before. Its "Work in another account" list is now a group near the top of the hub, for contractors and granted subcontractors only; the owner keeps the view menu beside the +. Its Notifications entry was a placeholder with nothing behind it, and was removed with it; a bell comes back in the header when notifications are built.

**Modal sheets (5):**
1. Month picker — bottom sheet, month grid, job-count dots, "Today"
2. Job detail — bottom sheet, 92vh max, property/assignment/recurrence/actions
3. Client detail — bottom sheet, contact + job history
4. Template picker — bottom sheet, 3 report templates + job attachment
5. Report builder — full-screen, dynamic field renderer, Save draft / Finalise & lock
6. Report document — full-screen, rendered document preview + PDF export

*Amended (reports Phase 3):* the builder is no longer one scroll. A report opens
on an **overview** of its sections and is filled **one section at a time**, with
the open section in the URL (`?s=<section id>`) so the phone's back gesture
leaves a section rather than the report. On `lg` a standing section rail sits
beside a 720px content column — the page had been stretching every field across
the whole 1280px shell. A seventh sheet joined the list: the **answer picker**,
which a list of more than twelve options opens instead of stacking rows, and
which every cell of a repeating row uses whatever its length.

*Amended (reports Phases 4–5):* three more sheets, all from
`primitives/Sheet.tsx`: the **finalise sheet**, which reads a report back
before it locks; the **send sheet**, which offers the recipients the form
itself asked for; and the **template settings sheet**, where an owner changes
the parts of a built-in form that are theirs. The reports list became a
library — server-paginated, server-searched (client, street, form name or
report number), with a Recently Deleted segment for drafts. The report page's
Email tab is now the send sheet plus a delivery history, and its Logs tab an
activity timeline with actor names.

**Cross-cutting:** preview-as banner (sticky, dark, top), toast (bottom centre)

## 2.3 Interaction patterns worth naming
- **Hold-to-call / hold-to-email** — pointer-down starts a fill animation, pointer-up before completion cancels. Prevents pocket-dialling a client mid-job. Uses `onPointerDown/Up/Leave/Cancel`, `touch-action:none`, `user-select:none`. *Amended (Phase 4):* on a job card the same hold sits in a list the thumb scrolls, so there it uses `touch-action:pan-y` instead — the browser may take a vertical drag, and when it does it cancels the pointer, which cancels the hold. A scroll never dials; a still thumb still has to hold. The sheets keep `touch-action:none`.
- **Segmented controls** for all binary/ternary filters — never dropdowns.
- **Week strip with per-subcontractor dots** — colour-coded, so the Owner sees whose day is loaded at a glance.
- **Suburb on list rows, full address in detail/report** — deliberate: schedule scanning wants suburb, legal documents require full street address. The job card follows it too. *History:* a list/board split once had the board card print the full street address; the variants went in Phase 2, and in Phase 4 the card went back to the suburb alone, as the day table's row showed it (the table itself was retired later). Its Map button carries the street address to the maps app, so the address no longer has to be read off the card to be used. The job detail sheet and the report still print it in full.
- **Locked boilerplate blocks** — report disclaimers render in a grey inset card, visibly non-editable.
- **A delivery is a record, not an event** — every attempt to send a report is a `reportDeliveries` row, written before the provider is called and naming the `reportPdfs` row it attached, so "which file did the client receive?" has an answer after the renderer has moved on. `sent` means the provider accepted it; the Resend webhook moves a row to `bounced` later, and the report's Sent bucket with it.
- **Who a report may be sent to** — a technician may send to addresses already on the client record; anywhere else is `pendingApproval` until an owner says yes, unless the business turns the restriction off. The held row IS the request, so approving is a decision about something real. Twenty sends an hour per member, counted from the delivery rows rather than a separate token bucket.
- **Suggested answers** — an answer the app worked out (the forecast, the booked start time) is marked "Suggested" and blocks finalising until the technician confirms it, which pressing Next on that section does. Facts read off a record are never marked: a technician confirming what their own client record says is a tax on being helpful.
- **One tap for a clean group** — a section or heading may declare `quick`, offering a single explicit tap that answers a whole group with its "nothing found" values. Never a stored default, never over an existing answer, and never over the form's mandatory gate (`semantic: 'safetyGate'`).
- **The lock is two acts, not one** — `Finalise & lock` opens a sheet that reads the report back (what was applied, whether it was safe, who signed, how many photos, who the form says gets a copy) before anything is locked. Which answers are read back is the template's call, via `summary: true` on a field or a repeater column. Not a hold-to-confirm gesture: long presses misfire through gloves, and the guard a technician needs is knowing what is about to be locked, not being asked whether they are sure. The button is never greyed for an *incomplete* report — pressing it is how you find out what is missing — but it does wait for the report's evidence to load, because signatures and photos live outside `data` and a check run before they arrive reads "not loaded" as "not there".
- **Bottom sheets come from `primitives/Sheet.tsx`** — seven screens had each hand-rolled the same root/portal/overlay/content/handle/close block before the pickers needed an eighth.

## 2.4 Responsive strategy
The design file is a 460px mobile shell. Desktop is an adaptive re-layout of the same components, not a separate app:

| Element | Mobile (<768px) | Desktop (≥1024px) |
|---|---|---|
| Navigation | Fixed bottom tab bar | Left sidebar, 240px, labels always visible |
| Shell | 460px centred | Fluid, max 1280px, content column + detail pane |
| Job detail | Bottom sheet | Right-side drawer or split pane (no re-navigation) |
| Schedule | Week strip + day list | Full 7-column week grid with time gutter |
| Report builder | Full-screen takeover | Centred modal, 720px, two-column field groups |
| Dashboard | Single-column stack | 3-column metric grid |
| Hold-to-call | Hold gesture | Plain click (no accidental-dial risk with a mouse) |

Breakpoint policy: mobile-first Tailwind, `md:` for tablet re-flow, `lg:` for sidebar + split panes.

---

# Part 3 — Component Libraries

## 3.1 Chosen stack
| Concern | Library | Why this one |
|---|---|---|
| Framework | **TanStack Start** (React 19, Vite) | Explicit server boundaries and typed route loaders — materially easier for Claude Code to trace than implicit RSC boundaries. Convex sponsors and maintains first-party integration. |
| Backend/DB | **Convex** | Reactive queries, TypeScript-native functions, no ORM/migration layer. Live-updating schedule comes free. |
| Data bridge | **@convex-dev/react-query** + `@tanstack/react-query` + `@tanstack/react-router-ssr-query` | Official Convex↔TanStack integration; SSR on first paint, live updates after hydration. |
| Auth | **Better Auth** via `@convex-dev/better-auth` | Convex Auth is still beta; Better Auth has a mature organisations plugin and Convex publishes the component + a TanStack Start framework guide. Multi-business membership is exactly what its org model handles. |
| Styling | **Tailwind CSS v4** | Design tokens map cleanly to `@theme` CSS variables. |
| Component primitives | **shadcn/ui** (Radix under the hood) | Copy-in, not a dependency — you own and restyle the code. Critical here because the iOS aesthetic requires overriding defaults, and shadcn is the only major library where that isn't a fight. |
| Bottom sheets | **Vaul** | Purpose-built iOS-style drawer: drag handle, snap points, velocity dismissal, scroll-lock. Replicates the five sheets natively instead of hand-rolling `sheetUp`. shadcn ships a Vaul-based Drawer. |
| Icons | **Lucide React** | Matches the design file's 1.7 stroke-width outline geometry. |
| Dates | **date-fns** + **@internationalized/date** | date-fns for formatting/arithmetic; the latter for timezone-correct calendar math (Australia/Perth, no DST — but tenants in other states have DST, so don't hand-roll this). |
| Forms | **TanStack Form** + **Zod** | Report builder is a dynamic, template-driven schema — Zod defines each template's shape once and drives both validation and TypeScript types. Same-ecosystem as router/query. |
| Tables (desktop) | **TanStack Table** | Headless — desktop client/invoice lists without fighting a styled grid. |
| PDF generation | **@react-pdf/renderer** | Report templates as React components: same mental model as the UI, reviewable in-browser, deterministic output. Avoids a headless-Chrome dependency. |
| PWA service worker | **Serwist** (`@serwist/vite`) | `vite-plugin-pwa` currently fails to emit the service worker in TanStack Start production builds (Vite 6 environment API gap). Serwist is the fork that works. **Verify `sw.js` exists in build output before shipping.** |
| Animation | **Motion** (ex-Framer Motion) | Only where Vaul doesn't cover it: toast entry, fill animation on hold-to-call, tab transitions. |
| Photo handling | **Convex file storage** + `browser-image-compression` | Compress client-side before upload — field techs on mobile data uploading inspection photos. |
| Email | **Resend** + **React Email** | Report delivery to clients; React components again. |
| SMS | **Twilio** | Called from a Convex action. |
| Billing | **Stripe** (subscriptions) | Already in your stack. Not Connect — you aren't routing contractor money. |
| Xero | **xero-node** | OAuth2 per subcontractor, called from Convex actions. |
| Testing | **Vitest** + **Playwright** | Playwright specifically for the access-control matrix (see §6.4). |
| Errors | **Sentry** | |

## 3.2 Explicitly rejected
- **MUI / Chakra / Mantine** — opinionated visual defaults you'd spend more time overriding than writing from scratch. The iOS look needs primitives, not a design language.
- **FullCalendar / react-big-calendar** — heavy, desktop-first, and their visual model fights the week-strip design. Build the week strip from a `date-fns` grid; it's ~150 lines.
- **Prisma / Drizzle + Postgres** — duplicates what Convex provides.
- **Clerk** — a paid dependency for something Better Auth + Convex covers.
- **Puppeteer for PDF** — a headless Chrome binary in your deployment for something react-pdf does natively.
- **`vite-plugin-pwa`** — known broken with TanStack Start production builds today.

---

# Part 4 — Backend Architecture (Convex)

## 4.1 Multi-tenancy model
Every business is a tenant. A user can belong to **multiple** businesses with a different role in each — Terence is Owner of his own business and could be a Subcontractor in someone else's. This is the `memberships` table, not a field on `users`.

**Isolation rule (non-negotiable):** every query and mutation resolves the caller's active membership first and filters by `businessId`. No exceptions, no "convenience" queries that skip it. Enforced by a shared `requireMembership()` helper that every function calls as its first statement — never by remembering to add a filter.

## 4.2 Schema
```ts
// convex/schema.ts

businesses: {
  name, slug, state,                    // state drives licence-field labelling
  abn?, timezone,                       // e.g. "Australia/Perth"
  stripeCustomerId?, subscriptionStatus, plan,
  createdAt
}
.index("by_slug", ["slug"])

memberships: {
  userId, businessId,
  role: "owner" | "subcontractor",
  canViewAllJobs: boolean,              // owner-granted, default false
  licenceNumber?,                       // free text — state-based, per business
  colour,                               // calendar layer colour
  status: "active" | "invited" | "removed",
  createdAt
}
.index("by_user", ["userId"])
.index("by_business", ["businessId"])
.index("by_user_business", ["userId", "businessId"])

properties: {                            // first-class, NOT derived from jobs
  businessId,
  clientName, phone?, email?,
  addressLine, suburb, state, postcode,
  lat?, lng?,
  notes?, createdAt
}
.index("by_business", ["businessId"])
.searchIndex("search", { searchField: "addressLine",
                         filterFields: ["businessId", "suburb", "clientName"] })

jobs: {
  businessId, propertyId,
  assignedMembershipId,
  jobType,                              // "General Pest Control" | "Rodents" | "Termite Inspection" | ...
  price,                                // cents
  scheduledAt, durationMinutes,
  status: "recurring" | "pending" | "booked"
        | "completed" | "invoiced" | "cancelled",
                                        // new by hand = pending; "recurring" only
                                        // from the recurrence engine, one-way out
                                        // (convex/lib/jobStatus.ts)
  recurrenceId?,                        // null = one-off
  completedAt?, createdAt
}
.index("by_business_date", ["businessId", "scheduledAt"])
.index("by_assignee_date", ["assignedMembershipId", "scheduledAt"])
.index("by_property", ["propertyId"])
.index("by_business_status", ["businessId", "status"])

recurrences: {
  businessId, propertyId, assignedMembershipId,
  frequency: "monthly" | "quarterly" | "sixMonthly" | "yearly",
  jobType, price, anchorDate, active
}
.index("by_business", ["businessId"])

// *Amended (reports Phases 1-6).* The row below is the v1 design; the live
// shape is convex/schema.ts. What was added, and why, in one line each:
//   templateSnapshotId, templateVersion  what this report was SIGNED against
//   contextSnapshot                      the client/site/business facts, frozen
//   prefill                              which answers the app guessed
//   signatureSlots                       the drawn images, outside `data`
//   reportNumber, version                the "Submission ID:" the client quotes
//   pdfStatus/StorageId/RenderVersion    the render claim and its current file
//   deletedAt, updatedAt, searchText     Recently Deleted, ordering, search
//   + by_business_updated, by_deletedAt, by_business_status_template, search
// `photoIds` survives as a write-only array nothing reads (see migrations.md).
reports: {
  businessId, jobId, propertyId, authorMembershipId,
  template: "serviceReport" | "timberPestInspection" | "termiteManagementCert"
          | "treatmentRecord" | "custom",
  legalBasis,                           // "APVMA" | "AS 4349.3-2010" | "AS 3660.2-2017"
  status: "draft" | "finalised",
  data: v.any(),                        // template-shaped, validated by Zod at the edge
  photoIds: v.array(v.id("_storage")),
  finalisedAt?, pdfStorageId?,
  createdAt
}
.index("by_business", ["businessId"])
.index("by_property", ["propertyId"])       // "find the 2024 report for this address"
.index("by_job", ["jobId"])

// Superseded by the Field Notes rebuild; the live shape is convex/schema.ts.
// The body lives in the prosemirror-sync component; the row holds links
// (job / property / client — what the note is about) and derived metadata.
// `visibility: 'private'` (Phase 5.3, 2026-09-24) makes a PERSONAL note:
// read and written by its author, read only by the business owner, by
// nobody else whatever their job scope, lens or @mentions; never linked,
// never tagging. Absent = shared (knowledge-first), as every older note is.
notes: {
  businessId, authorMembershipId,
  jobId?, propertyId?, clientId?,
  visibility?,
  text, createdAt
}
.index("by_business", ["businessId"])
.index("by_job", ["jobId"])

// NOT BUILT (reports Phase 7 note). No `tasks` table exists in
// convex/schema.ts and no convex/tasks.ts exists. The durable-notice
// follow-up it was designed for became `features: ['durableNotice']`, an
// optional printed extra; the SGAR 35-day evaluation became an offer on the
// finished report (`sgarFollowUp`) rather than a queued task. Kept here
// because a follow-up table is still the right home if one is ever wanted.
tasks: {                                 // manual follow-ups (durable notice etc.)
  businessId, jobId?, reportId?,
  kind: "durableNotice" | "other",
  label, detail?,
  done: boolean, doneAt?,
  assignedMembershipId?, createdAt
}
.index("by_business_done", ["businessId", "done"])

xeroConnections: {                       // per-user, per-tenant — never shared
  membershipId, businessId,
  xeroTenantId, tenantNameCache,
  accessToken, refreshToken, expiresAt,   // encrypted at rest
  status: "connected" | "expired" | "revoked",
  connectedAt
}
.index("by_membership", ["membershipId"])

invoices: {
  businessId, jobId, membershipId,
  xeroInvoiceId?, xeroStatus?,
  amount, sentAt?, lastSyncAt?,
  error?
}
.index("by_job", ["jobId"])
.index("by_business", ["businessId"])

smsLog: { businessId, jobId, phone, kind: "reminder" | "receipt",
          providerSid?, status, sentAt }
.index("by_job", ["jobId"])

auditLog: {                              // finalised reports + access changes
  businessId, actorMembershipId, action, entityType, entityId,
  meta?, at
}
.index("by_business", ["businessId"])
```

**Note on `properties`:** the earlier prototype derived clients from job history. That breaks the legal requirement that reports be findable by address years later, independent of whether the original job record still exists. Properties are their own table.

## 4.3 Function layer
```
convex/
  schema.ts
  auth.ts                    Better Auth wiring
  http.ts                    auth routes, Xero OAuth callback, Stripe webhook
  lib/
    access.ts                requireMembership, requireOwner, canEditJob, visibleJobFilter
    money.ts                 cents-only arithmetic
    dates.ts                 tenant-timezone helpers
  businesses.ts              create, update, listForUser (business switcher)
  memberships.ts             invite, setRole, setCanViewAllJobs, setLicence
  properties.ts              search, upsert, get, jobHistory
  jobs.ts                    listWeek, listDay, get, create, update, complete, cancel
  recurrences.ts             create, materialise, skipOccurrence, reschedule
  reports.ts                 create, saveDraft, finalise, get, listByProperty, search
  reportPdf.ts               [action] render via react-pdf, store, return storageId
  *Amended (reports Phases 4–5):* `reports.ts` also owns the paginated
  `list`/`search`/`counts` the library reads, the soft-delete trio
  (`softDelete`/`restore`/`remove`) and its nightly `purgeExpired`, the
  render claim (`claimPdf`/`setPdf`/`failPdf`) and the caller-less projections
  scheduled work reads (`getForRender`, `photosForRender`). `reportPdf.ts` is
  now a thin wrapper over `reportPipeline.tsx`, which owns the single render
  path. `deliveries.ts` and `templateSettings.ts` are new; `http.ts` gained
  its first hand-written route, the Resend webhook.
  *Amended (reports Phase 6):* `optionSets.ts` gained the owner mutations the
  settings screen needs and two queries a technician's builder reads —
  `editable` for the editor, `usual` for what a picker offers first (the
  business's starred options unioned with this member's own recents, kept in
  `memberships.reportPrefs`). `snippets.ts` is new: saved wording for the
  long-answer boxes, writable by any member. `reports.ts` gained
  `lastAtProperty`/`copyFromLastVisit`, which fill a return visit in from the
  last report at the same address.
  notes.ts                   list (folders incl. mine / everyone), search, create,
                             setVisibility, listForProperty, listForJob (legacy)
  tasks.ts                   NOT BUILT — see the `tasks` table note in §4.2
  xero.ts                    [action] beginOAuth, completeOAuth, refresh, pushInvoice
  invoices.ts                createFromJob, syncStatus
  sms.ts                     [action] sendReminder, sendReceipt
  weather.ts                 [action] fetch + cache per suburb/day
  stripe.ts                  [action] checkout, portal; webhook handler
  crons.ts                   materialise recurrences, SMS reminders, Xero token refresh,
                             invoice status sync
```

**Queries vs actions:** anything touching an external API (Xero, Twilio, weather, Stripe, PDF render) is an **action**, never a query or mutation — Convex queries must stay deterministic. Actions write results back through mutations.

## 4.4 Access-control helper (the load-bearing piece)
```ts
// convex/lib/access.ts

export async function requireMembership(ctx, businessId) {
  const user = await getAuthUser(ctx);
  if (!user) throw new ConvexError("UNAUTHENTICATED");
  const m = await ctx.db.query("memberships")
    .withIndex("by_user_business", q =>
      q.eq("userId", user._id).eq("businessId", businessId))
    .unique();
  if (!m || m.status !== "active") throw new ConvexError("NO_ACCESS");
  return m;
}

// Read visibility: own jobs, or all if owner / granted
export function jobVisibility(m) {
  return (m.role === "owner" || m.canViewAllJobs)
    ? { scope: "business" as const, businessId: m.businessId }
    : { scope: "assignee" as const, membershipId: m._id };
}

// Write is stricter than read — granted view never implies edit
export function canEditJob(m, job) {
  return m.role === "owner" || job.assignedMembershipId === m._id;
}
```

Every function's first line is `const m = await requireMembership(ctx, args.businessId)`. Code review rule: a function body that touches `ctx.db` without a preceding `requireMembership` is a bug, regardless of whether it currently leaks.

## 4.5 Xero integration flow
1. Subcontractor taps "Connect Xero" → Convex action returns Xero OAuth2 authorise URL with `state` bound to `membershipId`.
2. Xero redirects to a Convex HTTP endpoint → exchange code for tokens → store in `xeroConnections` keyed to that membership, encrypted.
3. Invoice send: resolve job → assigned membership → *that membership's* connection → upsert client as a Xero contact → create invoice in **their** organisation → store `xeroInvoiceId` → set job `status: "invoiced"`.
4. Cron refreshes tokens before expiry; on refresh failure set `status: "expired"` and surface the amber "Xero not connected" state the design file already specifies.
5. **Guardrail:** the Xero module exposes no function that writes to a business-level or shared Xero organisation. There is no such code path to accidentally call.

---

# Part 5 — Frontend Architecture

## 5.1 Route tree
```
src/routes/
  __root.tsx                      Convex + Query providers, theme, toaster
  index.tsx                       → redirect to /$businessSlug/dashboard
  login.tsx
  onboarding.tsx                  create first business
  api/auth/$.ts                   Better Auth handler proxy

  $businessSlug/
    route.tsx                     tenant guard + membership context + shell
    dashboard.tsx
    schedule.tsx                  ?date= &filter= &layers=
    clients/
      index.tsx                   ?q=
      $propertyId.tsx
    invoices.tsx                  ?seg=
    reports/
      index.tsx                   ?q= &seg=  (all|draft|finalised|sent|trash)
      new.tsx                     template picker
      $reportId.tsx               builder (draft) or document (finalised); ?s= section
      templates/                  owner-only: built-in settings, custom templates
    notes.tsx                     ?filter=
    settings/
      index.tsx                   the hub; ?seg= (old tabs) redirects
      details.tsx  licence.tsx  sign-in.tsx  business.tsx  about.tsx
      team/index.tsx  team/$memberId.tsx
      reports/index.tsx  reports/answers.tsx
```

Filter/date state lives in **validated search params**, not `useState` — the schedule day a tech is looking at survives refresh and is shareable.

## 5.2 Component tree
```
src/components/
  shell/
    AppShell.tsx                  bottom tabs (mobile) ⇄ sidebar (desktop)
    PageHeader.tsx                kicker + title + action + view menu
    BusinessSwitcher.tsx          multi-tenant picker
    PreviewBanner.tsx             "Previewing as … / Exit"
  primitives/                     shadcn, restyled to tokens
    Segmented.tsx  Toggle.tsx  Sheet.tsx (Vaul)  Card.tsx
    StatusPill.tsx  Avatar.tsx  Toast.tsx  EmptyState.tsx
    HoldButton.tsx                pointer-driven fill; click-through on desktop
  schedule/
    WeekStrip.tsx  DayDots.tsx  MonthPickerSheet.tsx
    JobCard.tsx                   one card, four surfaces; Map top right, Call/Text/Email below, all holds (§2.3)
    WeekView.tsx                  the Week View's own job blocks, not JobCard — check card rules here too
    WeatherStrip.tsx              per-card forecast: values, never advice
    JobDetailSheet.tsx  LayersPanel.tsx  WeatherBanner.tsx
    WeekGrid.tsx                  desktop-only
  dashboard/
    RevenueCard.tsx  MetricCard.tsx  PipelineCard.tsx  FollowUpTasks.tsx
  clients/
    ClientRow.tsx  ClientSheet.tsx  PropertyHistory.tsx
  invoicing/
    InvoiceCard.tsx  XeroRouteRow.tsx  ScopeNotice.tsx
  reports/
    ReportBuilder.tsx             renders from template definition
    ReportOverview.tsx            the hub: sections, progress, last-visit offer
    fields/                       registry + one control per kind, PickerSheet,
                                  RowSheet, SignSheet, PhrasesSheet, RepeaterGrid
    FinaliseSheet.tsx  SendSheet.tsx  InlineReports.tsx  ReportsLibrary.tsx
    BoilerplateBlock.tsx          locked disclaimer
    DurableNoticePreview.tsx      an optional extra behind `features`
    ReportDocument.tsx            on-screen rendered document
    pdf/                          ONE painter (ReportPdf) + CoverPage, layout,
                                  tables, theme, RichTextPdf (server-side only)
    ReportPdfCard.tsx  ReportPdfViewer.tsx  DraftPreviewViewer.tsx
                                  the PDF tab, and a report (with the team's
                                  marks) or a draft's preview in the in-app
                                  viewer (components/pdf, via pdf/host)
  notes/
    NotesLibrary.tsx  NotesRail.tsx  NoteList.tsx  NoteEditor.tsx
    NoteEditorHeader.tsx  JobNotesSection.tsx ("Before you arrive" only)
  settings/
    ui.tsx                        SettingsGroup, rows, FieldRow, SaveBar, DangerGroup
    MyDetails.tsx  MyLicence.tsx  LicenceDocument.tsx  ShowMyLicence.tsx
    TwoStepSection.tsx  BusinessSection.tsx  ReportSettingsForm.tsx
    TeamSection.tsx  MemberAccessRow.tsx (MemberSettings)  OptionLibrariesSection.tsx

src/lib/
  reportTemplates/                THE compliance layer — see §5.3
    serviceReport.ts  timberPestInspection.ts  termiteManagementCert.ts
    treatmentRecord.ts            retired from the picker; kept so old reports render
    legacy/                       v1 modules a pre-rewrite report resolves to
    documentModel.ts  present.ts  visibility.ts  validate.ts  progress.ts
    seed.ts  optionSets.ts  lastVisit.ts  snippets.ts  settings.ts  resolve.ts
    index.ts                      registry + shared Zod fragments
  access.ts                       client-side mirror of server rules (UI only)
  format.ts  useMediaQuery.ts  toast.ts
```

## 5.3 Report templates as data (the most important frontend decision)
Each template is a declarative definition — sections of typed fields, with the
printed framing beside them. The builder UI is a generic renderer over it.
Adding a state-specific variant or a fourth document type becomes a new file,
not a UI rewrite.

*Rewritten (reports Phase 7).* The shape below had drifted so far from the code
that it described a different system: a `pdf` component per template, an
`onFinalise` hook returning `tasks` rows, three template ids, and six field
kinds. None of those exist. The authoring guide is
`docs/reports/templates.md`; this is the contract.

```ts
export type ReportTemplate = {
  id: TemplateId | 'custom'        // 4 built-ins + business-authored
  version: number                  // bump on ANY wording change
  name, shortName, legalBasis, blurb: string
  sections: SectionDef[]           // not a flat field list
  terms?: RichDoc                  // the printed terms pages
  print?: PrintSpec                // cover, headings, footer name, numbering
  features?: Array<'durableNotice'>
  corrections?: Correction[]       // every deliberate departure from the source
  validationNotes?: string[]
}
```

Four things about it are load-bearing, and each replaces something the old
shape got wrong:

**There is no `pdf` component.** One pure `buildReportModel()` holds no React,
so the Convex Node action, the browser and a vitest build the identical model;
`ReportDocument.tsx` and `pdf/ReportPdf.tsx` do nothing but draw it. Two
painters deciding layout separately is how a PDF comes to disagree with the
screen it was approved on.

**There is no `schema` property and no `onFinalise` hook.** Validation is
derived from the fields (`deriveSchema`), and the Certificate's durable notice
is a `features` flag no template currently sets rather than a callback that
writes a `tasks` row — there is no `tasks` table.

**22 field kinds, in three classes.** Answered-and-stored-in-`data`; answered
but stored in `reportPhotos` / `signatureSlots` (`photos`, `gallery`, `cover`,
`signature`); and not questions at all (`note`, `heading`, `derived`).
`isDataField()` is the one guard every data-handling walk runs — `pruneHidden`,
`deriveSchema`, `sectionProgress`, `seedData`, `present`. Miss it and a printed
paragraph is treated as an unanswered question, and the report becomes
permanently unfinalisable with an error pointing at nothing.

**A finalised report never resolves the live template.** It dereferences
`reportTemplateSnapshots` through `templateSnapshotId`, which is why correcting
`Chemical Aplication Method` to `Application` does not alter a document signed
last year. `resolveReportTemplate` merges, in order: the built-in module →
the business's option libraries → its template settings — or a frozen snapshot,
which wins and ignores both overlays.

Business-authored templates additionally split **saving from issuing**:
`saveDraft` keeps unvalidated work in progress, `publish` validates it and
bumps `publishedVersion`, and `reports.create` reads only what is published.

The per-template content that used to sit here was a research note from before
the forms were transcribed, and it described fields the real documents do not
have. What the three Pest M8 forms actually say, clause by clause, is
`docs/reports/fidelity.md`; what the standards require of them is
`docs/reports/compliance.md`.

## 5.4 Data-fetching pattern
- Route loaders `ensureQueryData` for anything needed to render (schedule day, report being opened) — no loading spinner on first paint.
- `useSuspenseQuery` inside components for co-located live data.
- Convex subscriptions keep the schedule live: a job the Owner reschedules appears on the subcontractor's device without a refresh. This is a genuine differentiator over the competitors' polling apps — don't undercut it with manual refetch logic.
- Mutations are optimistic for local-feeling actions (toggling access, marking a task done) and pessimistic for anything with an external side effect (Xero send, SMS).

## 5.5 PWA & offline
- **Serwist** service worker: precache the app shell, `NetworkFirst` for navigation, `StaleWhileRevalidate` for static assets.
- Convex caches last-known query results client-side, so **today's schedule renders offline** — the realistic field case (someone's backyard, no signal).
- **Mutations require connectivity.** There is no offline mutation queue in v1. A tech can read the schedule offline and submit the report when back in range. Do not market this as fully offline-capable.
- *Amended (reports Phase 4):* **a report draft's answers also live on the device that typed them.** `src/lib/draftMirror.ts` keeps one IndexedDB record per report, written as soon as an answer differs from the server's copy and deleted the moment the server acknowledges it — so what is left behind is exactly the work a tab killed mid-save would otherwise lose. On the next open the builder offers it back; it is never applied on its own, because another device may have saved since. This is still not an offline queue: nothing retries, photos are not queued, and a second device editing the same draft is last-writer-wins by design. Every call is best-effort, since IndexedDB is unavailable in a private window and can refuse a write on quota, and none of that should cost a technician the network path that works.
- Install prompt: `manifest.webmanifest`, maskable icons, `display: standalone`, `theme-color: #FF3B30`.
- **Build gate:** `pnpm build` fails if `sw.js` is missing or empty (`scripts/build-sw.ts`), and then fails again unless the built server actually *serves* it (`scripts/check-sw.mjs` boots `.output/server` and requests `/sw.js`). Both halves are needed: a worker written after Nitro baked its static-asset manifest existed on disk while every local production run answered `/sw.js` with a redirect to /login, so nothing about the worker could be tested before it reached Vercel.

---

# Part 6 — Delivery Plan

## 6.1 Phase 1 — Foundation (weeks 1–2)
TanStack Start + Convex + Better Auth wired. `businesses` / `memberships` / users. Business switcher. `requireMembership` + the Playwright access-control suite (§6.4) written **before** the features it guards. Design tokens into Tailwind `@theme`. AppShell with responsive nav.

## 6.2 Phase 2 — Core loop (weeks 3–5)
Properties, jobs, recurrences. Week strip, month picker, day list, job cards, job detail sheet, layers panel, hold-to-call. Dashboard. Clients. This is the smallest thing the design partner can actually use — get it in his hands here, before reports or Xero.

## 6.3 Phase 3 — Money & compliance (weeks 6–9)
Xero OAuth per subcontractor + invoice push. Report templates ×3, builder, finalise-and-lock, PDF export, durable-notice task. Notes. SMS reminders. Weather.

## 6.4 Phase 4 — SaaS & hardening (weeks 10–12)
Stripe subscriptions, onboarding, tenant provisioning. PWA. Sentry. Desktop layouts. Audit log surfacing.

## 6.5 The access-control test matrix
Write these as Playwright specs early; they're the tests that matter most, because a leak here is a business-ending trust failure in a product whose selling point is that subcontractors are independent.

| Scenario | Expected |
|---|---|
| Sub, `canViewAllJobs=false`, own job | full read + edit |
| Sub, `canViewAllJobs=false`, other's job | not in list, direct URL → 404 |
| Sub, `canViewAllJobs=true`, other's job | read-only, edit controls absent, mutation rejected server-side |
| Sub attempts invoice on other's job | rejected server-side, not just hidden in UI |
| Owner, any job in own tenant | full access |
| Any user, job in a tenant they aren't a member of | 404, no existence leak |
| Sub in two businesses | switching context changes visible data; no bleed |
| Xero push on job assigned to A | lands in A's Xero only; B's connection untouched |

Every negative case must be verified at the **Convex function level**, not only by absence of a button.

---

# Part 7 — Open Questions

Blocking build:
1. **Office/Admin role** — needed in v1, or defer? Affects the role enum and every access check.
2. **Photos in inspection reports** — confirmed required? (Assumed yes; it's near-universal in termite work.) Affects storage and mobile upload UX.
3. **Which states** does the design partner operate in? Drives licence-field labelling and whether QLD's two-durable-notice rule matters in v1.

Blocking launch, not build:
4. **SMS cost model** — absorbed into subscription, or metered add-on?
5. **The "live calendar doc"** from the original wireframes — client-facing confirmation, or a share link for someone else? Currently unbuilt; if it's client-facing it becomes true B2B2C and needs a third identity class.
6. **Pricing** — per-user, per-tenant flat, or tiered by job volume?

## Success criteria (design-partner validation)
- Terence and Kevin replace their current calendar + manual Xero workflow entirely
- Job entry is faster than the paper/wall-calendar process it replaces
- Zero invoices routed to the wrong Xero organisation
- At least one AS 4349.3 report produced in the field and delivered to a client without falling back to their old template
