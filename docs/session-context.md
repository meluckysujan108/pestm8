# PestM8 — Session Context

A snapshot for starting a coding session: what the product is, how the code
is laid out, the rules the codebase follows, where the work stands, and
what is still open. Written 2026-09-26 against `main` @ `408ed9e` (PR #55),
from the code, the git history (233 commits) and all 55 PRs.

The source of truth for the product and architecture is still
[ARCHITECTURE.md](../ARCHITECTURE.md). Deploy rules are in
[CLAUDE.md](../CLAUDE.md). This file summarises both and adds progress.

---

## 1. Product and vision

**PestM8** is a calendar-first job-scheduling and compliance-reporting PWA for
**small Australian pest-control businesses** (2–15 people, a mix of employees
and independent subcontractors). It is modelled visually on iOS Calendar and
Settings. The design partner is a WA business (Terence is the owner,
Kevin a subcontractor). Their success criteria:

- They replace their current calendar and manual Xero workflow entirely.
- Booking a job is faster than their paper/wall-calendar process.
- No invoice ever lands in the wrong Xero organisation.
- They produce at least one AS 4349.3 report in the field and deliver it to a client.

Two things set it apart from competitors:

1. **Per-subcontractor Xero routing.** Each subcontractor invoices through
   their own Xero organisation. _Not built yet._
2. **Australian-standard reports** as first-class templates: AS 4349.3,
   AS 3660.2 and APVMA records. _Built, and the most mature area._

Compliance boundaries are product decisions:

- **Never** build hours, timesheets or rostering, because of sham-contracting law.
- The AS 3660.2 durable notice is a manual human step.
- Certificates are signed only under the signer's own licence.

**Principles you see in every PR:**

- Access control is tested at the Convex function level, not only by hiding buttons.
- Tenant isolation is non-negotiable.
- Field-first UX for technicians: hold-to-call, big targets, offline reading, the iPhone Home Screen app.
- Copy is plain-English and Australian (finalise, licence, colour).
- Every PR goes through an adversarial review, has mutation-checked tests and states its deploy order.

## 2. Stack

| Layer       | Choice                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| Frontend    | TanStack Start (Vite 8, Nitro 3 beta), React 19, TanStack Router/Query/Form, Zod 4                    |
| Backend     | Convex 1.32, with components `betterAuth` and `prosemirrorSync`                                       |
| Auth        | Better Auth 1.6.30 via `@convex-dev/better-auth`: email+password, optional TOTP 2FA, invite-only mode |
| UI          | Tailwind 4 with tokens in `src/styles.css`, Radix/shadcn copied in, Vaul sheets, Lucide, Recharts     |
| Rich text   | Tiptap 3 (Field Notes), synced through prosemirror-sync                                               |
| PDF         | `@react-pdf/renderer` renders server-side; `pdfjs-dist` is the in-app viewer (markup, search, zoom)   |
| PWA         | Serwist (`src/sw.ts`, built by `scripts/build-sw.ts`, checked by `scripts/check-sw.mjs`)              |
| Email       | Resend over `fetch` (`convex/email.ts`), Svix-verified webhook                                        |
| Weather     | Open-Meteo, falling back to MET Norway. Address lookup is Photon plus offline G-NAF locality tables   |
| Tests       | Vitest + convex-test (edge-runtime) for units and the permission matrix; Playwright for journeys      |
| Hosting     | Vercel builds the frontend from `main`; Convex is deployed separately                                 |
| Package mgr | pnpm 10.33 (`packageManager` pinned). Import alias `#/*` → `src/*`                                    |

Not built yet: Xero, Stripe billing, Twilio SMS, Sentry and invoices. The
`stripeCustomerId` field exists, and the invoice/Xero rows of the access
matrix are `test.fixme` at `e2e/access-control.spec.ts:432-433`.

## 3. Environments and deploy (read CLAUDE.md before any deploy)

- **Prod Convex:** `rare-retriever-156` (team `sujan-neupane`, project `pestm8`).
- **Personal dev:** `acoustic-schnauzer-237`.
- **E2E:** project `pestm8-e2e`, deployment `warmhearted-cricket-924`.
- **Decoy project:** `joyous-otter-223` and `efficient-lemming-413` are an accidentally created, empty project. If `.env.local` names either, **stop**.
- **Commands:** prefix every prod command with `CONVEX_DEPLOYMENT=prod:rare-retriever-156`. Never use `--prod` from a worktree. Run `--dry-run` first.
- **Frontend and backend go together.** Before `npx convex deploy`, check that Vercel's newest _successful_ build is the tip of `main`. A changed function signature on a stale frontend shows as a bare "Server Error". This is how the notes rewrite broke prod.
- **Lockfile:** a change to `package.json` means regenerating `pnpm-lock.yaml` in the same commit. Check with `pnpm install --frozen-lockfile --lockfile-only`. A stale lockfile fails Vercel silently, and the old build keeps being served.
- **Schema over existing rows:** expand → migrate → contract. The worked example is `convex/migrations/notesV2.ts`. Take a snapshot first with `npx convex export --prod --path x.zip`.
- **Order per release:** each backend PR states whether the frontend or the backend goes first. See `docs/deploy-owner-views.md` (Releases A/B/C) and `docs/deploy-access-v3.md`.
- **Env switches:**
  - Set on prod only: `AUTH_INVITE_ONLY=on`, `AUTH_RATE_LIMIT=on`.
  - Set on e2e only: `AUTH_BREACH_CHECK=off`.
  - Set nowhere yet: `AUTH_MFA_REQUIRED=on`.
- **Email:**
  - Only prod has `RESEND_API_KEY`, and it uses the test sender `onboarding@resend.dev`. It delivers only to the Resend account owner, so a domain needs verifying.
  - Every other deployment throws `EMAIL_NOT_CONFIGURED`.
  - `RESEND_WEBHOOK_SECRET` is unset, so the webhook returns 404 and deliveries never move past "sent".
- **Read-only prod inspection:** `npx convex run --prod --inline-query '…'`. Add `--component betterAuth` to read the Better Auth users.

## 4. Commands

```bash
pnpm install --frozen-lockfile
npx convex dev            # terminal 1 (dev deployment)
pnpm dev                  # terminal 2, :3000
pnpm typecheck            # tsc for app + convex/tsconfig.json
pnpm test                 # vitest + convex-test, no deployment needed
pnpm lint / pnpm format / pnpm check
pnpm build                # also copies pdfjs assets, builds + verifies sw.js
pnpm test:e2e             # Playwright; needs a dev: deployment + a PRODUCTION build
pnpm generate-routes      # after adding a route file
pnpm check:dates / check:travel
```

CI (`.github/workflows/ci.yml`, Node 20) runs:

1. Frozen install.
2. Typecheck.
3. Vitest.
4. Prettier, only on changed files that were already clean at the base.
5. ESLint `--max-warnings 0` on changed files.

**CI does not run Playwright.** Run the relevant specs locally against
`pnpm build && npx vite preview --port 3000`.

The e2e guards:

- `e2e/fixtures.ts` refuses the prod names and anything that is not a `dev:` deployment.
- `e2e/globalSetup.ts` refuses if MFA is compulsory or if the target isn't a production build.
- A run creates about 150 accounts and never cleans them up.

## 5. Backend map (`convex/`)

Before editing Convex code, read `convex/_generated/ai/guidelines.md`. CLAUDE.md requires it.

### Data model (`schema.ts`, ~1770 lines)

`businesses` is the tenant root. Almost every row carries `businessId`.

- **Team:**
  - `memberships` holds role `owner | contractor | subcontractor`, status and colour.
  - `grants {switchInto, clientDirectory, prices, otherSchedules}`.
  - `parentMembershipId` links a subcontractor to their contractor's team.
  - `joinSeenAt` supports join notices.
  - Legacy fields still present: `canViewAllJobs`, `canViewOtherAccounts`, `viewingAsMembershipId`.
- **Invites:** `invitations` (team links, stored as token hashes) and `businessInvites` (start-a-business links, issued from the CLI).
- **Clients:** `clients` → `clientContacts` and `properties` (sites, site contact, address check).
- **Jobs:** `jobs` (status `recurring|pending|booked|completed|invoiced|cancelled`, price in cents, job number, work order) and `recurrences` (`intervalCount`/`intervalUnit`).
- **Reports:**
  - `reports` holds `data: any` shaped by its template, signature/photo slots, amendments (`supersedes`/`supersededBy`), a frozen `templateSnapshotId` plus `contextSnapshot`, PDF status and soft delete.
  - Related tables: `reportPhotos`, `reportPdfs`, `reportPdfAnnotations` (markup), `reportDeliveries` (one row per send attempt), `reportTemplateSnapshots` (content-hashed), `customReportTemplates` and their versions, `templateSettings`, `optionSets`, `reportSnippets`.
- **Field notes:** `notes` (bodies live in prosemirror-sync; `visibility: 'private'` makes a personal note), `noteMentions` and `noteAttachments`.
- **Other:**
  - Licences and products: `memberLicences` and `memberLicenceFiles` (the licence wallet), `products` (photo plus SDS/label PDF).
  - Weather and places: `weatherCache`, `suburbGeocache`, `geocodeMisses`.
  - Sessions and audit: `jobPhotos`, `accountSwitches` (12-hour "work in another account"), `sessionViews` (the owner's per-device view), `auditLog` (with `onBehalfOf`).
  - Two-step: `twoStepAttempts`, `twoStepSetups`.
- **Better Auth users** live in the component's tables, not the app's.

### Access control (the load-bearing part)

- **`lib/capabilities.ts`** is pure. It holds the `ROLE_POLICY` table, mapping each role and capability to `always`, `never` or `{byGrant}`.
  - Capabilities: `business.manage`, `templates.manage`, `team.manage`, `clients.manage`, `jobs.dispatch`, `prices.see`, `clients.directory`, `schedules.seeOthers`, `accounts.switch`.
  - It also has the scope and decision helpers: `canEditJob`, `canDispatchTo`, `canManageMember`, `canInviteAs`, and so on.
- **`lib/actor.ts`** is the current entry point.
  - `requireActor(ctx, businessId)` is for reads and fails open on a bad switch.
  - `requireWriteActor` is for writes. It fails closed and returns a branded `WriteActor`.
  - Then `requireCapability(env, cap)`, and filter by `env.scope`/`listScope`.
  - Admin capabilities drop while you are switched into another account.
- `lib/access.ts` is the **older** layer (`requireMembership`/`requireOwner`/`requireAuthUser`). Some modules still use it. Prefer the actor layer in new code.
- Domain guards follow the `requireX` naming: `lib/jobAccess.ts` (`requireEditableJob`, `requireBookable`), `lib/noteAccess.ts`, `lib/clientScope.ts`, `lib/jobScope.ts`.
- `lib/prices.ts` strips prices from anyone without `prices.see`.
- **Errors:**
  - Errors are `ConvexError('SCREAMING_SNAKE')` codes, such as `NOT_FOUND`, `NO_ACCESS`, `REPORT_FINALISED`, `INVALID_ASSIGNEE` and `MFA_ENROLMENT_REQUIRED`.
  - A cross-tenant or not-a-member request gets `NOT_FOUND`, so nothing about the business leaks.
  - The client maps codes to copy in `src/components/forms/describeError.ts`.
- **Queries never read `Date.now()`** (they pass `now=0` so results stay cacheable). Mutations check expiries and crons sweep them.
- **Client mirror:** `src/lib/access.tsx` (`useCan`, `useActing`, `useViewMode`) reads `api.access.me`. It is for the UI only; the server is the authority.

### Modules (one line each)

- **Access:** `access` (the `me` query), `accountSwitches`, `views` (owner view: everyone / mine / someone's account), `viewAs` (legacy).
- **Auth:** `auth.ts` (~1080 lines: Better Auth config, breach check, 2FA, invite-only, 400-day sessions), `twoStepAttempts`, `twoStepSetups`, `adminInvite` (a CLI escape hatch).
- **Business and onboarding:** `businesses`, `businessInvites`, `setupGuide`, `teamJoins`.
- **Team:** `invitations`, `memberships`, `team` (offboarding, roster, `releaseTeam`), `memberLicences`.
- **Clients and jobs:** `clients`, `clientContacts`, `properties`, `jobs` (~1000 lines), `recurrences` (materialises 180 days ahead).
- **Reports:** `reports.ts` (~2940 lines: the whole lifecycle), `reportAnnotations`, `reportPdf.tsx` and `reportPipeline.tsx` (render behind a claim), `deliveries`, `email`, `customTemplates`, `templateSettings`, `optionSets`, `snippets`.
- **Other:** `notes` and `notesSync`, `products`, `weather`, `analytics`, `dashboard`, `auditLog`.
- **`http.ts`:** the Better Auth routes plus `POST /resend/webhook`.
- **`crons.ts`** (times are UTC):
  - `materialiseAll` daily at 18:00.
  - Notes purge at 19:00; reports purge at 19:20 (30-day bin).
  - Switch and view sweeps every hour.
- **`migrations/`:** hand-run `internalMutation`s. Each header holds its runbook.
  - accessV3, jobStatusV1, memberColoursV1, notesV2, propertyFixesV1.
  - recurringIntervalV1, reportSnapshotsV1, reportsContract, reportsLibrary.
- **`demo/`:** a seeder for the "Swan River Pest Co" demo business, with cleanup that needs `confirmSlug`.

## 6. Frontend map (`src/`)

**Routes:**

- **Top level:** `login` (sign-in only), `join.$token` (team invite, works signed out), `start.$token` (start a business), `onboarding` (business → brand → licence → team → ready), `welcome` (for new joiners), `two-step`, `api/auth/$` (Better Auth proxy with a Set-Cookie workaround).
- **`$businessSlug/`:**
  - `route.tsx` is the tenant guard and shell.
  - Main pages: `schedule` (day, week and month views, weather), `job/` (list plus `recurring`), `clients/`, `notes`, `products`, `analytics`, and `leads` (a placeholder).
  - `reports/`: `index` (the library), `new`, `$reportId` (builder or PDF, section in `?s=`), and `templates/` (owner editor).
  - `settings/`: an iOS-style hub with pages `details`, `licence/…`, `sign-in`, `appearance`, `about`, `business`, `team/…` and `reports/answers`.

**Navigation:** a mobile bottom dock with four tabs plus a burger menu, and a desktop sidebar. The owner's view menu sits beside the +. Contractors and granted subcontractors get a "Work in another account" group in Settings, and an amber banner shows while switched.

**Components:** `schedule/` (JobCard, WeekView, MonthCalendar, sheets, weather), `reports/` (ReportBuilder, field registry, FinaliseSheet, SendSheet, `pdf/` painter), `pdf/` (pdf.js viewer with markup), `notes/`, `settings/` (`ui.tsx` building blocks), `onboarding/`, `shell/`, `primitives/` (Sheet, HoldButton, Segmented, Combobox, StatusPill), `forms/`, `clients/`, `products/` and `auth/`.

**Report templates as data:** `src/lib/reportTemplates/`.

- The built-ins are the service report, timber pest inspection and termite certificate. `treatmentRecord` is retired.
- `spec/*.generated.ts` holds the verbatim form strings.
- One pure `buildReportModel()` feeds both the screen and the PDF.
- A finalised report always resolves its frozen snapshot.
- `isDataField()` must guard every walk over the fields.
- The authoring guide is `docs/reports/templates.md`. See also `docs/reports/{compliance,fidelity,migrations}.md`.

**Data-fetching and offline:**

- Route loaders call `ensureQueryData`, and components use `useSuspenseQuery` over `@convex-dev/react-query`.
- `HandoverConvexClient` (`src/lib/convexClient.ts`) holds the socket through sign-in hand-overs and token refreshes.
- The app works offline for reading only; there is no mutation queue.
- Report drafts are mirrored to IndexedDB (`draftMirror.ts`), and product and licence PDFs can be kept on the device.

**Design tokens:** light and dark themes, per ARCHITECTURE §2.1. There is a status colour ramp per job status (`src/lib/statusColours.ts`), and technician colours come from `convex/lib/colours.ts`.

## 7. How the work has gone (timeline)

The repo is about 5 weeks old, from 2026-08-19 to 2026-09-26. 50 PRs are merged.

| Dates      | Work                                                                                                                                                                                                                                                                                   | PRs          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Aug–Sep 11 | Scaffold, desktop calendar, report engine (6 → 14 field kinds), Pest Service Report ported from Formitize                                                                                                                                                                              | #2, #3       |
| Sep 16–18  | **Access v3**: capability table, actor resolution, token invites, account switching, offboarding. Themes. **Reports rebuild, Phases 3–7** (sectioned builder, finalise sheet, send sheet, library, option sets, custom templates, snapshots)                                           | #5–#9        |
| Sep 18–22  | **Owner views**: Release A (owner on the roster), B (view menu), C (write as the actor). Reports contract step                                                                                                                                                                         | #10, #12–#18 |
| Sep 22–23  | **Job plan Phases 1–4**: new status set; Job section and burger nav; recurring jobs on any interval with overdue carry-forward; job card redesign; colour palette; Week View; hold-to-act Map/Call/Text/Email; navigation performance (bundle 1354 → 821 KB)                           | #19–#30      |
| Sep 24     | **Phases 5–7.1**: client picker, work orders, personal notes, card dates and MET weather fallback, demo seeder, **ABN/contacts/address lookup**, **field verification**, **Products + pdf.js viewer**. Resend live on prod                                                             | #31–#38      |
| Sep 25     | **Phase 8**: licence upload (8.1), optional TOTP 2FA (8.3), 400-day sessions. Reports on the new viewer with markup. Contractor team-scope hardening (#41 closed a privilege-escalation hole), orphaned-team release, socket sign-in fixes                                             | #39–#45      |
| Sep 26     | Invitees join the inviter's team. Settings hub redesign plus the **My licences** wallet. `memberships.licenceFile` retired. **Onboarding Phases 1–4** (start-a-business links, 4-step set-up, set-up guide, joiner welcome, join notices, role choice). Appearance moved into Settings | #46–#55      |

**Plan numbering:**

- **Job plan:** Phases 1–8, with prompts `N.x`. 8.2 and 7.2+ have not appeared yet.
- **Reports rebuild:** Phases 1–7 plus a contract step.
- **Onboarding:** Phases 1–4.
- **Owner views:** Releases A/B/C.

## 8. Open PRs (none on `main`, none reviewed)

- **#1: Deploy runbook + env-var build gate** (Aug 19).
  - Adds `DEPLOYMENT.md` and `scripts/check-env.mjs`.
  - Very stale. Worth salvaging the idea of the env gate.
- **#4: Formatting/lint/CI/CD setup** (Sep 11).
  - 180 files, with husky, CODEOWNERS and a nightly backup workflow.
  - Its Vercel preview failed, probably on `VITE_*` vars or the Node 22 pin.
  - Heavily conflicted. Part of it has already landed separately as `ci.yml`.
- **#11: SW cache pinning + version-skew self-reload** (Sep 22).
  - It fixes a **live prod bug**: runtime caches can pin old builds and block sign-in.
  - It adds `vite:preloadError` recovery.
  - It has conflicts; its seed-fix half was superseded by #20.
  - **This is the highest-value open item.**
- #24 was closed without merging (a branch rename). Its content landed as #25.

## 9. Known gaps, decisions and follow-ups

**Features not built:**

- Xero per-subcontractor invoicing, invoices, Stripe billing, SMS, Sentry, Leads and a notifications bell.
- The `tasks` table was never built. The durable notice became `features: ['durableNotice']`.
- Client ABN and site contact are not yet report tokens.

**Contract steps still owed:**

- Access v3 still needs its contract step: drop `canViewAllJobs`, `canViewOtherAccounts`, `viewingAsMembershipId` and `lib/access.ts`. It is blocked on having no client build telemetry.
- The "can see all clients" toggle stays inert until then.
- `recurringIntervalV1`'s contract step (dropping the legacy `frequency`) has no PR.

**Deploy state not recorded:**

- #41, #44, #46 and #50 were merged "not deployed".
- It is unknown whether `propertyFixesV1`, `jobStatusV1` and `recurringIntervalV1` have run on prod.
- Check prod read-only before assuming either.

**Correctness gaps:**

- Finalise sends the whole screen, so a concurrent edit can be lost (#10).
- `canSetLicence` and `memberships.setLicence` disagree (#43).
- A skipped welcome doesn't resume (#54).
- Sign-up doesn't verify email; the 7-day link expiry is the mitigation (#51).

**Privacy decision for the owner:** contractors can read every member's email, phone and licence number (#41, #43).

**Other decisions for the owner:**

- Termite certificates with two installers can't be finalised (#12).
- The owner can edit anyone's draft (#10).
- Existing owners need a start link to create a second business (#51).
- Status colour sign-offs are pending: the draft pill is at 3.98:1, weather amber sits near orange, and the Analytics chart puts Pending red next to Completed green (#29).

**Operations:**

- Resend needs a verified domain and `RESEND_WEBHOOK_SECRET`.
- Open-Meteo's free tier is for non-commercial use only, which is a licence risk (#32).
- There is no second geocoder.
- Check the Vercel proxy's client IP before turning on `AUTH_RATE_LIMIT`.

**Performance:**

- NoteEditor and reportTemplates still load up front on Clients (#28).
- Page one could render from the cache (#26).
- Backend auth lookups could be trimmed by about 25–70 ms (#23).

**Tests:**

- `e2e/annotation.spec.ts:17` flakes, and has since before these PRs.
- No e2e covers an overdue recurring projection.
- Real-iPhone checks are owed for hold-to-act and VoiceOver, the PDF share sheet, the otpauth link, HEIC photos, and the onboarding and welcome flows.

**Stale comments:**

- `scripts/check-dst-boundaries.mjs` and `scripts/check-travel.mjs` say "no Vitest".
- `scripts/seed.mjs` says there are only two roles.

**Open product questions (ARCHITECTURE §7):**

- An Office/Admin role.
- Which states the business operates in.
- The SMS cost model.
- The "live calendar doc".
- Pricing.

## 10. Working conventions for this session

- Read `convex/_generated/ai/guidelines.md` before touching `convex/`.
- **Access checks:**
  - Every function resolves its caller first (`requireActor`/`requireWriteActor` + `requireCapability`).
  - A function that touches `ctx.db` without doing so is a bug.
  - Add convex-test cases for the negative cases: wrong tenant, wrong role, and while switched.
- Errors are string codes. Add the copy to `describeError.ts`.
- **Schema changes to live tables** go expand → migrate → contract. A migration is an `internalMutation` with its runbook in the header.
- **Committing:**
  - Regenerate `convex/_generated` and `routeTree.gen.ts` when you add modules or routes.
  - Regenerate the lockfile together with `package.json`.
- Before a push, run `pnpm typecheck && pnpm test` plus lint/prettier on the changed files. Run the affected Playwright specs against a production build (CI won't).
- **Writing:**
  - Australian spelling.
  - Commit subjects say what changed for the user ("Stay signed in after…").
  - Module headers explain _why_ and cite ARCHITECTURE sections and Phase/Prompt numbers.
  - Amend ARCHITECTURE.md with a dated _Amended (…)_ note when behaviour departs from it.
- State the deploy order (frontend first or backend first) in every PR that touches `convex/`.
