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

## 2.1 Tokens
```
Colour
  --ink          #1C1C1E   primary text
  --ink-2        #3A3A3C   body text
  --muted        #8E8E93   secondary text
  --muted-2      #9B9BA1   section labels
  --hairline     rgba(60,60,67,.10)
  --hairline-2   rgba(60,60,67,.07)
  --surface      #FFFFFF
  --surface-2    #F2F2F7   inset cards
  --surface-3    #F4F4F8   input fill
  --canvas       #EDEDF1   app background
  --fill-track   rgba(118,118,128,.08)  segmented control track
  --red          #FF3B30   primary action, selected date, brand
  --blue         #0A84FF   links, contact actions, secondary buttons
  --green        #34C759   invoiced / success
  --amber        #FF9F0A   completed-awaiting-invoice
  --amber-ink    #B26B00   warning text
  --amber-bg     #FFF8EC   warning surface
  --amber-line   #FFE2B8   warning border

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
Chrome     sticky header + tab bar, rgba(255,255,255,.92) + backdrop-filter blur(24px) saturate(180%)
Numerals   font-variant-numeric: tabular-nums globally
Shell      max-width 460px centred on canvas
```

## 2.2 Screen inventory
**Tabs (6):** Dashboard · Schedule · Clients · Invoices · Reports · Notes

**Settings:** reached via avatar in header (not a tab), 3 segments — Profile / Team / Preferences

**Modal sheets (5):**
1. Month picker — bottom sheet, month grid, job-count dots, "Today"
2. Job detail — bottom sheet, 92vh max, property/assignment/recurrence/actions
3. Client detail — bottom sheet, contact + job history
4. Template picker — bottom sheet, 3 report templates + job attachment
5. Report builder — full-screen, dynamic field renderer, Save draft / Finalise & lock
6. Report document — full-screen, rendered document preview + PDF export

**Cross-cutting:** preview-as banner (sticky, dark, top), toast (bottom centre)

## 2.3 Interaction patterns worth naming
- **Hold-to-call / hold-to-email** — pointer-down starts a fill animation, pointer-up before completion cancels. Prevents pocket-dialling a client mid-job. Uses `onPointerDown/Up/Leave/Cancel`, `touch-action:none`, `user-select:none`.
- **Segmented controls** for all binary/ternary filters — never dropdowns.
- **Week strip with per-subcontractor dots** — colour-coded, so the Owner sees whose day is loaded at a glance.
- **Suburb on list rows, full address in detail/report** — deliberate: schedule scanning wants suburb, legal documents require full street address. *Amended:* the schedule's job card now has two variants, and the rule holds per-variant rather than per-surface — the compact **list** row still shows suburb alone, while the richer **board** card shows the full street address. A board card is being read, not scanned past, and at that size the address is the fastest way to recognise a job. `JobCard.tsx` is the only place this applies; every other list row is unchanged.
- **Locked boilerplate blocks** — report disclaimers render in a grey inset card, visibly non-editable.

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
  status: "booked" | "completed" | "invoiced" | "cancelled",
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

reports: {
  businessId, jobId, propertyId, authorMembershipId,
  template: "treatmentRecord" | "timberPestInspection" | "termiteManagementCert",
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

notes: {
  businessId, authorMembershipId,
  jobId?, propertyId?,
  text, createdAt
}
.index("by_business", ["businessId"])
.index("by_job", ["jobId"])

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
  notes.ts                   list, create, listForJob
  tasks.ts                   listOpen, complete, createDurableNoticeTask
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
      index.tsx                   ?q=
      new.tsx                     template picker
      $reportId.tsx               builder (draft) or document (finalised)
    notes.tsx                     ?filter=
    settings.tsx                  ?seg=profile|team|prefs
```

Filter/date state lives in **validated search params**, not `useState` — the schedule day a tech is looking at survives refresh and is shareable.

## 5.2 Component tree
```
src/components/
  shell/
    AppShell.tsx                  bottom tabs (mobile) ⇄ sidebar (desktop)
    PageHeader.tsx                kicker + title + action + avatar
    BusinessSwitcher.tsx          multi-tenant picker
    PreviewBanner.tsx             "Previewing as … / Exit"
  primitives/                     shadcn, restyled to tokens
    Segmented.tsx  Toggle.tsx  Sheet.tsx (Vaul)  Card.tsx
    StatusPill.tsx  Avatar.tsx  Toast.tsx  EmptyState.tsx
    HoldButton.tsx                pointer-driven fill; click-through on desktop
  schedule/
    WeekStrip.tsx  DayDots.tsx  MonthPickerSheet.tsx
    JobCard.tsx                   list | board variants (§2.3)
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
    TemplatePicker.tsx
    ReportBuilder.tsx             renders from template definition
    fields/                       Text Area Select Chips AreasChecklist Photos
    BoilerplateBlock.tsx          locked disclaimer
    DurableNoticePreview.tsx      mono label + manual-task warning
    ReportDocument.tsx            on-screen rendered document
    pdf/                          @react-pdf templates ×3
  notes/
    NoteComposer.tsx  NoteCard.tsx  JobPill.tsx
  settings/
    ProfileSection.tsx  TeamSection.tsx  MemberAccessRow.tsx  PrefsSection.tsx

src/lib/
  reportTemplates/                THE compliance layer — see §5.3
    treatmentRecord.ts  timberPestInspection.ts  termiteManagementCert.ts
    index.ts                      registry + shared Zod fragments
  access.ts                       client-side mirror of server rules (UI only)
  format.ts  useMediaQuery.ts  toast.ts
```

## 5.3 Report templates as data (the most important frontend decision)
Each template is a declarative definition — field list, Zod schema, locked boilerplate, PDF component. The builder UI is a generic renderer over it. Adding a state-specific variant or a fourth document type becomes a new file, not a UI rewrite.

```ts
export type ReportTemplate = {
  id: "treatmentRecord" | "timberPestInspection" | "termiteManagementCert";
  name: string;
  shortName: string;
  legalBasis: string;                    // shown as a tag in the picker
  blurb: string;
  fields: FieldDef[];                    // drives the builder
  schema: z.ZodType;                     // validates draft → finalise
  boilerplate: string;                   // locked, rendered read-only
  pdf: React.ComponentType<{ report; property; author; business }>;
  onFinalise?: (ctx) => TaskSpec[];      // TMC returns the durable-notice task
};

type FieldDef =
  | { kind: "text";   key; label; placeholder?; required? }
  | { kind: "area";   key; label; placeholder?; rows? }
  | { kind: "select"; key; label; options: {value,label}[] }
  | { kind: "chips";  key; label; options: {value,label}[] }   // multi-select
  | { kind: "areas";  key; label; rows: string[]; note? }      // inspected / no-access + reason
  | { kind: "photos"; key; label; slots: string[] };
```

**Template field content (from the compliance research):**

*Treatment Record (APVMA):* product, active constituent, APVMA reg no., batch number, dilution rate, target pest, treated areas (chips), weather conditions, technician + licence (auto), before/after photos.

*Timber Pest Inspection (AS 4349.3-2010):* areas checklist — roof void, subfloor, interior, exterior cladding, decking/fencing, grounds — each Inspected or No access **with a required reason**; evidence of activity; evidence of damage; conducive conditions; re-inspection interval; photos. Boilerplate: visual inspection only, ~7-day validity, not a structural inspection, not a safety or compliance inspection.

*Termite Management Certificate (AS 3660.2-2017 / NCC):* system type (chemical barrier / physical barrier / baiting), product, APVMA reg no., batch, life expectancy per label, install date, installer + licence (auto), re-inspection interval. Generates the durable-notice label preview and, on finalise, a `tasks` row: *"Fix durable notice in meter box"*.

## 5.4 Data-fetching pattern
- Route loaders `ensureQueryData` for anything needed to render (schedule day, report being opened) — no loading spinner on first paint.
- `useSuspenseQuery` inside components for co-located live data.
- Convex subscriptions keep the schedule live: a job the Owner reschedules appears on the subcontractor's device without a refresh. This is a genuine differentiator over the competitors' polling apps — don't undercut it with manual refetch logic.
- Mutations are optimistic for local-feeling actions (toggling access, marking a task done) and pessimistic for anything with an external side effect (Xero send, SMS).

## 5.5 PWA & offline
- **Serwist** service worker: precache the app shell, `NetworkFirst` for navigation, `StaleWhileRevalidate` for static assets.
- Convex caches last-known query results client-side, so **today's schedule renders offline** — the realistic field case (someone's backyard, no signal).
- **Mutations require connectivity.** There is no offline mutation queue in v1. A tech can read the schedule offline and submit the report when back in range. Do not market this as fully offline-capable.
- Install prompt: `manifest.webmanifest`, maskable icons, `display: standalone`, `theme-color: #FF3B30`.
- **Build gate:** CI must assert `sw.js` exists in the client output. This plugin combination has a known failure mode where it silently produces no service worker.

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
