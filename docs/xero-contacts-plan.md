# Xero contacts sync — plan (DRAFT v1, 2026-10-01)

> **Superseded where it differs by the approved plan of 2026-10-06** (every
> connected org gets the whole book; Connect Xero is a tap). This draft is
> kept for its research: the Xero facts (§2), the field mapping (§5) and the
> review fixes (§11b). Where they differ, the approved plan wins:
>
> - **Every connected organisation gets the whole client book** — the
>   business's and each member's own — not only the clients of jobs a member
>   leads (§1, §3, §11 routing). Leads wait until their first job is booked.
>   §11b.13's owner switch for member orgs is dropped: members start syncing
>   the same day as the business.
> - **Connect Xero is a tap** (`docs/design-system.md`, Hold to act, amended);
>   Open in Xero stays a hold.
> - **Releases** are R1 connect, R2 match, R3a a hook refactor with no change
>   in behaviour, then R3 sync for every organisation at once; there is no
>   Release 4 (§9).
> - **The tables** are as `convex/schema.ts` has them, not §6's sketch.
>
> The current record is `ARCHITECTURE.md` (§1.2, §1.4, §4.2, §4.5, dated
> 2026-10-06) and the runbook `docs/xero.md`.

Status: draft for review. Nothing is built. Research sources are in the session
scratchpad (`research/*.json`); every Xero fact below was re-checked against
developer.xero.com, the Xero OpenAPI spec and the 2026 pricing/terms pages.

---

## 1. The ask, and the recommendation in one paragraph

> Whenever a client or a job is created here, the client is created or updated
> as a contact in Xero. Contacts only for now. The client book stays shared.
> Every staff member and the owner can link Xero through OAuth; contractors and
> subcontractors who keep their own books connect their own Xero organisation.

**Recommendation.** One-way sync, PestM8 → Xero, for contacts only.

- The **owner connects the business's Xero organisation**. It receives every
  client in the shared book.
- **Any contractor or subcontractor may connect their own organisation**. It
  receives a client only when that person leads a job (or a Recurring Job) for
  that client — the customers they will invoice, not the whole book. Once a
  client is in their organisation, later edits flow there too.
- Sync runs a few seconds after a save, in the background. It sends only what
  changed, so a bookkeeper's edits in Xero to fields PestM8 doesn't own are never
  overwritten.
- On first connect PestM8 **reads the Xero organisation and matches the clients
  it already has** before creating anything, so Terence's existing Xero contacts
  are linked, not duplicated. The owner reviews the matches and presses
  **Start syncing**.

No new npm dependency (plain `fetch`, no `xero-node`), no Convex component
(house outbox + lease pattern), additive schema only.

---

## 2. Xero facts that shape the design

| Fact (checked 2026-10-01)                                                                                                                                                                 | Consequence                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standard OAuth2 authorization-code flow for a "Web app"; code valid 5 min, single use                                                                                                     | Callback is a Convex HTTP action; it must finish fast and never be retried                                                                                                   |
| Access token 30 min; refresh token 60 days, **rotates on every refresh**, old one usable for 30 min                                                                                       | One refresh at a time per token set (DB lease); a daily cron refreshes idle token sets well before 60 days                                                                   |
| **Tokens belong to a Xero user + our app, not to an organisation.** One token set reaches every org that Xero user connected; a new consent supersedes the old set                        | Store tokens once per Xero user (`xeroGrants`), with a separate row per (membership, organisation). ARCHITECTURE.md §4.2's per-membership token row is wrong and is replaced |
| Revoking a token removes **all** of that Xero user's connections; `DELETE /connections/{id}` removes one                                                                                  | Disconnect = DELETE one connection; revoke only when no PestM8 row still uses the grant                                                                                      |
| Connections persist forever (even with dead tokens) and count toward the plan cap until deleted. No webhook on disconnect                                                                 | Delete connections on disconnect/offboarding; detect Xero-side disconnects from 403 / `invalid_grant`                                                                        |
| Scopes: new apps get granular scopes. Contacts scope unchanged: `accounting.contacts`. `GET /Organisation` needs `accounting.settings.read`                                               | Request `offline_access openid profile email accounting.contacts accounting.settings.read`. Invoices later need `accounting.invoices` → one re-consent per user then         |
| Pricing since 2 Mar 2026: **Starter free, 5 organisations app-wide**; Core $35 AUD/mo, 50; Plus $245, 1,000 (certification). Several users on the same org count once                     | Terence's org + up to 4 contractors' own orgs = free. A 6th distinct org needs a card (Core)                                                                                 |
| Each Xero org can connect at most **two uncertified apps** (Starter/Core are uncertified)                                                                                                 | Connect error copy must explain this                                                                                                                                         |
| Rate limits per org: 5 concurrent, 60/min, **1,000/day on Starter** (5,000 Core+); 10,000/min app-wide                                                                                    | One worker per org at a time, ≤1 call/s, batch 50 contacts per call, honour `Retry-After`                                                                                    |
| Contact `Name` must be **unique among active contacts**; no plans to change. PUT = create only (fails loudly on a name clash); POST without an ID may silently update a same-name contact | Create with PUT, update with `POST /Contacts/{ContactID}`. Never upsert by name                                                                                              |
| Omitted fields are left unchanged on update                                                                                                                                               | Send only the fields PestM8 owns and that changed                                                                                                                            |
| Contacts can't be deleted, only archived; merged contacts stay archived with `MergedToContactID`; `GDPRREQUEST` contacts are frozen                                                       | Never auto-archive; relink merged contacts; stop for GDPR                                                                                                                    |
| `Idempotency-Key`: ≤128 chars, kept 6 min, per app (not per org), cached errors replay                                                                                                    | Key minted per sync attempt (not derived from the payload); lost-response recovery after 6 min uses a lookup by AccountNumber                                                |
| `ContactPersons`: max 5, names + email only; `TaxNumber` = ABN; `AccountNumber` ≤50, editable in Xero; `ContactNumber` API-only, unique even among archived                               | See the mapping in §5. PestM8 doesn't write `ContactNumber`                                                                                                                  |
| Accounting API returns XML unless `Accept: application/json`                                                                                                                              | Always send it                                                                                                                                                               |
| Xero Developer Terms: app must have its own terms + privacy policy and record agreement; refresh tokens AES-encrypted, key held apart; callback must 302; no AI training on Xero data     | Prerequisites in §10                                                                                                                                                         |

---

## 3. Who connects what, and which clients go where

### Connections

| Who                        | Connects                              | Where in Settings   | Gate                                                             |
| -------------------------- | ------------------------------------- | ------------------- | ---------------------------------------------------------------- |
| Owner                      | The **business organisation**         | Business → **Xero** | `business.manage` (owner; dropped while switched)                |
| Contractor / subcontractor | **Their own** organisation (optional) | You → **My Xero**   | any active member, refused while switched (like `canSetLicence`) |

- A member may not connect the organisation the business already has connected
  ("That's the business's Xero — it's already connected").
- The owner sees each member's Xero status (connected to _Org name_ / needs
  reconnecting / not connected) on Settings → Team → member, read only — the
  licences-wallet rule. The owner cannot disconnect a member's own books; removing
  the member does (sham-contracting stance, ARCHITECTURE.md §1.4).
- **Removing a member** (team.offboard) disconnects their Xero in the same step.

### Routing (data decides, never the button-presser)

| Event                                                   | Business org               | Member's own org                                   |
| ------------------------------------------------------- | -------------------------- | -------------------------------------------------- |
| Client created (any role, any screen, import)           | create                     | —                                                  |
| Client / contact person / first site edited             | update if linked           | update if linked                                   |
| Job created / Recurring Job created                     | ensure exists + up to date | ensure exists in the **lead's** org (if connected) |
| Job lead changed, or job moved to another client's site | ensure exists              | ensure exists in the **new lead's** org            |
| Team offboarding hands work to a successor              | —                          | ensure the successor's org has those clients       |
| Nightly recurrence engine, status changes, "also going" | nothing                    | nothing                                            |

Because routing reads the job's lead, an owner switched into Kevin's account who
books Kevin's job pushes to Kevin's org (and the business org) — never to the
owner's — and the switch can't change where data goes.

---

## 4. How a sync runs

```
any client write ──► markClientForXero(ctx, clientId, {leadMembershipId?})
                      │ skips: demo business, Xero not configured, no connection
                      ▼
                   xeroOutbox row per (connection, client)   — coalesced, rev+1, dueAt=now+5s
                      │ scheduler.runAfter(5s, drain, {connectionId}) only if none pending
                      ▼
drain(connectionId)  [internal action]
   1. claim the connection's sync lease (mutation; one drain per org at a time)
   2. get a fresh access token (grant lease; refresh if <5 min left)
   3. take ≤50 due rows → build payloads (pure mapper, §5) → skip unchanged (hash)
   4. creates: PUT /Contacts?summarizeErrors=false   updates: POST /Contacts/{id}
   5. record results (mutation): link rows, per-field hashes, errors;
      clear a row only if its rev didn't move while in flight
   6. 429 → pausedUntil = Retry-After; 5xx → backoff; more due → reschedule
reconciler cron (every 10 min): due rows, stuck leases, missed writers
```

- **One hook helper**, called at ~18 write sites the code map found
  (properties.ts `insertClientAndProperty`, `insertPropertyForClient`,
  `properties.update`, `clients.update` + `setContactPerson`, `clientContacts`
  create/update/setPrimary, `lib/clientRecord.ts activateLeadAt`, `jobs.create`,
  `jobs.update` (lead/property change), `recurrences.create`, `team.offboard`,
  `clientImports.addBatch` (once per batch), bin delete/restore/wipe, import undo,
  legacy `clients.archive/unarchive`). A unit test fails if any mutation writes
  `clients`, `clientContacts` or `properties` without going through it (except the
  demo seed and finished migrations).
- **Never** hooked into the nightly `materialiseAll` / `insertVisit` — no new
  client–lead pairing appears there.
- Sync state lives in its own tables, never on `clients`, so a sync write can't
  conflict with someone editing the client.

### Matching on first connect (the "Match your clients" step)

1. Read every Xero contact (paged, 1,000 per call — a 3,000-contact org is 3 calls;
   archived ones included so merges are visible).
2. Match each PestM8 client, strongest first:
   1. `AccountNumber` = PestM8 client number (imports from a Xero export already
      carry this) — **linked**
   2. same email (exact, case-insensitive) — **linked** if the name also agrees,
      else **needs a look**
   3. same name (normalised) — **needs a look** (shown with phone/suburb to compare)
   4. nothing — **new** (will be created)
3. Review screen: _Linked N · Needs a look N · New N_. Each "needs a look" row:
   **Same client** (link) / **Different client** (create new).
4. **Start syncing** creates the new ones and fills blanks on the linked ones.
   Linking never overwrites a value already in Xero (the bookkeeper's billing
   email or address may be better); after that only PestM8-side changes are sent.

Until the owner presses Start syncing, nothing is written to Xero.

### Name clashes after go-live

A new PestM8 client whose name is already taken in Xero (PUT fails with "already
assigned"):

- the Xero contact isn't linked to any PestM8 client → **Needs a look** on that
  client: "Xero already has a _John Smith_" → **Same client** / **Different
  client**;
- it's linked to another PestM8 client → create it as _John Smith (Nightcliff)_
  (primary site's suburb; then client number if still taken). _(Question Q4.)_

### Lifecycle

| PestM8                                       | Xero                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Lead created                                 | nothing until the first job is booked _(Question Q2)_                                                  |
| Client inactive                              | stays; still synced                                                                                    |
| Recycle bin delete                           | **left alone**; syncing stops (archiving in Xero blocks invoicing and can't always be undone)          |
| Restore                                      | syncing resumes; pending changes sent                                                                  |
| Wiped for good                               | link rows deleted; Xero contact stays                                                                  |
| Import undone                                | links dropped; contacts PestM8 created stay in Xero (the undo dialog says how many)                    |
| Archived or merged by the bookkeeper in Xero | merged → relink to the surviving contact; archived → "Archived in Xero", syncing stops for that client |
| GDPR request in Xero                         | stopped for good, never recreated                                                                      |

---

## 5. Field mapping (PestM8 → Xero)

| Xero field               | From                                                                                        | Notes                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `Name`                   | `clients.name`                                                                              | trim, collapse spaces, strip `< >`, ≤255                   |
| `FirstName` / `LastName` | person: the name split at the last word; business: the primary contact person               |                                                            |
| `EmailAddress`           | `clients.email`; a business with none → primary contact's email                             | reject non-ASCII before sending (Xero refuses umlauts)     |
| `Phones`                 | `clients.phone` → `MOBILE` if `lib/phone` says mobile, else `DEFAULT` (area code split out) | DDI/FAX left alone                                         |
| `Addresses` `POBOX`      | business head-office address if filled, else the oldest live site                           | `Region` = state, `Country` = Australia                    |
| `Addresses` `STREET`     | the oldest live site                                                                        | not each job's site (real-estate clients have many)        |
| `TaxNumber`              | `clients.abn`, business clients only, `51 824 753 556`                                      |                                                            |
| `AccountNumber`          | `clientNumber` as a string                                                                  | set on create; on a linked contact only if Xero's is blank |
| `ContactPersons`         | a business client's other contacts, primary first, max 5, `IncludeInEmails` false           | phone and role have no Xero field                          |
| not sent                 | `ContactNumber`, `BankAccountDetails`, `IsCustomer`, tags, status                           |                                                            |

Field-level change detection: a hash per field of what was last pushed; an update
sends only fields whose PestM8 value changed since then. Clearing a value in
PestM8 sends `""` for that field (to be confirmed against the Demo Company).

---

## 6. Data model (all new tables; nothing existing changes)

```
xeroGrants        (internal-only; never returned by a query)
  xeroUserId, accessCipher, accessExpiresAt, refreshCipher, keyVersion,
  scopes[], refreshedAt, leaseHolder?, leaseUntil?, status active|dead
  index by_xeroUserId, by_refreshedAt

xeroConnections   (what Settings reads — no secrets, no churn)
  businessId, membershipId, kind business|member, grantId, tenantId,
  xeroConnectionId, tenantName, shortCode, status pending|connected|
  needs_reconnect|disconnected, connectedAt, lastSyncAt?, pausedUntil?,
  problem?: {code, at}
  index by_business_kind, by_membership, by_tenant, by_grant

xeroOAuthStates   stateHash, finishHash?, userId, membershipId, businessId, kind,
                  returnPath, expiresAt, usedAt?          index by_stateHash, by_finishHash

xeroContactLinks  businessId, tenantId, clientId, xeroContactId?, state linked|
                  needs_review|archived_in_xero|gdpr|stopped, candidateContactId?,
                  xeroName, fieldHashes, lastPushedAt, linkedHow match|created|manual
                  index by_business_tenant_client, by_client, by_tenant_contact

xeroOutbox        connectionId, clientId, rev, dueAt, attempts, lastError?, claimedAt?
                  index by_connection_due, by_client

xeroSyncLeases    connectionId, holder, until                (keeps lease churn off the UI row)
```

Links are keyed by **organisation (tenant)**, not by connection, so reconnecting
(or a new token set) never duplicates contacts.

---

## 7. Security

- **Connect flow.** Settings calls an authenticated action → it mints a random
  `state` (stored hashed, 10 min, single use, bound to user + membership + kind) →
  the browser goes to `login.xero.com` in the same window (no pop-up, per Xero) →
  Xero calls back `https://<deployment>.convex.site/xero/callback` → code exchange,
  `GET /connections?authEventId=…`, tokens encrypted, connection saved as
  **pending** → `302` to `SITE_URL/<slug>/settings/xero?finish=<one-time token>`.
  The page calls `xero.finishConnect({token})`; it succeeds only for **the same
  signed-in PestM8 user** who started. That blocks the "send someone your connect
  link" hijack and works for the iPhone home-screen app (the page updates
  reactively). Unfinished pending connections are deleted at Xero after 15 min.
- **Tokens**: AES-256-GCM (Web Crypto) in actions only, random IV, additional data
  binds the ciphertext to its row, key from `XERO_TOKEN_KEYS` (versioned, separate
  from `BETTER_AUTH_SECRET`). Never in a query result, scheduler argument or log.
- **Every Xero call** names its tenant explicitly from the connection row and
  checks it belongs to that connection's business before sending.
- Switched owners can't connect/disconnect; business org requires `business.manage`.
- **Demo business** (`plan === 'demo-seed'`) never enqueues — the real Pest M8
  people have memberships there.
- **Unconfigured deployment** (no `XERO_*` env: e2e, local, unit tests): nothing is
  enqueued; Settings says Xero isn't set up here.
- Separate Xero apps for prod and dev — a shared app would let a dev connect
  silently supersede prod's token for the same Xero login.
- Audit: connect, disconnect, revoke-on-offboarding, Start syncing. Not every push.

---

## 8. Screens

- **Settings → Business → Xero** (owner): Connect Xero · connected org + status ·
  Match your clients / Start syncing · counts (In Xero · Waiting · Needs a look) ·
  Needs a look list · recent problems ("Couldn't add 3 clients — Xero says …") ·
  Disconnect Xero (ConfirmDialog). Amber badge on the hub row when reconnecting is
  needed.
- **Settings → You → My Xero** (contractors, subcontractors): same page, own org.
- **Client sheet → Details → Xero** row: "In Xero · Pest M8 Pest Control · 2 min
  ago" / "Waiting to sync" / "Lead — added to Xero when first booked" / amber
  "Needs a look" with the two choices / "Archived in Xero". **Open in Xero** link
  (deep link via the org short code).
- **Team → member** (owner): read-only Xero status line.
- Button: plain neutral **Connect Xero** (Xero's branding allows a plain button
  without the logo; keeps lucide-only icons). Not hold-to-act: it reaches no
  client.

---

## 9. Releases

| #     | Release                                                                                                                        | Writes to Xero?   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| 0     | Prereqs (you): Xero developer account, two Web apps, env vars, terms + privacy page                                            | —                 |
| 1     | **Connect**: tables, OAuth, encryption, refresh lease, disconnect, offboarding, Settings pages, owner's read-only view, crons  | no                |
| 2     | **Match your clients**: read Xero contacts, auto-link, review screen                                                           | no                |
| 3     | **Sync**: outbox, all hook points, mapper, creates/updates, name clashes, client-sheet row, Start syncing backfill, reconciler | yes, business org |
| 4     | **Member orgs**: job-lead routing, offboarding successor, member backfill                                                      | yes, member orgs  |
| later | Two-way (Xero webhooks for contact edits), invoices (`accounting.invoices`, re-consent)                                        |                   |

Each release: convex-test suite with a fake Xero (negative authz cases included),
e2e of the unconfigured screens, manual run against the Xero Demo Company on dev
(and a trial org for the two-users-one-org case), adversarial review, deploy
backend first.

---

## 10. Things only you can do (prerequisites)

1. Create a Xero developer account (developer.xero.com) under an address the
   business controls; you hold its Owner role.
2. Create two **Web apps**: "PestM8" (prod) and "PestM8 Dev" (name can't contain
   "Xero"). Redirect URIs: `https://rare-retriever-156.convex.site/xero/callback`
   (prod); `https://acoustic-schnauzer-237.convex.site/xero/callback` and
   `http://localhost:3211/xero/callback` (dev).
3. Put each app's client id + secret into Convex env (`XERO_CLIENT_ID`,
   `XERO_CLIENT_SECRET`) — or send them to me to set; I generate `XERO_TOKEN_KEYS`.
4. Terms of use + privacy policy pages (Xero's developer terms require them, and
   PestM8 has neither). I can draft them as app pages.
5. Accept that a 6th distinct Xero org means Xero's Core tier ($35 AUD/mo).

---

## 11. ARCHITECTURE.md changes (dated Amended notes)

- §1.2/§1.4: the business's own Xero receives the shared client book; members'
  own orgs stay theirs (invoices later still go to the job lead's org).
- §3.1: plain `fetch`, not `xero-node` (Node-only, would force `"use node"`).
- §4.2: `xeroConnections` per membership with tokens → `xeroGrants` (per Xero user)
  - `xeroConnections` (per membership + org) + links + outbox.
- §4.5 guardrail replaced: "writes go only to an organisation chosen by data — the
  business org for every client, a member's own org only for clients of jobs they
  lead — and every call names its tenant from that connection".

---

## 11b. Changes from the adversarial review (verified, 2026-10-01) — these override §2–§9

1. **Batch updates.** `POST /Contacts?summarizeErrors=false` with ≤50 elements, every
   element carrying its `ContactID` (never one without). Creates stay on PUT. Live
   edits go before backfill; backfill holds when `X-DayLimit-Remaining` < ~200.
2. **AccountNumber alone never links.** Auto-link only when the number matches
   (compared as integers) _and_ the normalised name or email also agrees; ignore an
   AccountNumber held by two Xero contacts. Everything else → Needs a look. The
   review screen lists Linked rows with Unlink before Start syncing.
3. **One Xero contact ↔ one PestM8 client per org** (enforced in the link mutation).
4. **Don't clobber billing details.** Before an update batch, `GET /Contacts?IDs=`
   (1 call per 50): overwrite email/phones/addresses only if Xero still holds what
   PestM8 last pushed; otherwise leave Xero alone and raise "Xero has a different
   email for {client}". Linking sets the baseline hashes to PestM8's current values,
   so booking a job on a just-linked client makes zero Xero calls.
5. **Addresses.** POBOX (prints on invoices) only from a business's head office; a
   person client's site goes to POBOX only on create or when Xero's is blank. A
   business with no head office sends no address — never a rental property.
6. **ContactPersons** written only on contacts PestM8 created, until a Demo Company
   test proves replace-vs-merge behaviour (Release 3 gate, with Addresses/Phones).
7. **Merges/archives** detected from `ContactStatus` in every write result → GET →
   relink to `MergedToContactID`, or mark archived_in_xero / gdpr.
8. **Reconnect rules.** Callback upserts tokens into `xeroGrants` immediately; falls
   back to unfiltered `GET /connections`; ORGANISATION tenants only. A connection's
   tenant never changes — a different org is a new connection through Match.
9. **DELETE /connections/{id}** (pending sweep, refused finish, disconnect,
   offboard) goes through one mutation that skips it while any other row, in any
   business, holds the same Xero connection. Revoke only with zero references.
10. **One live connection per tenant per business**; sync lease and pause keyed by
    tenant.
11. **Demo business:** connecting is refused outright (not just enqueueing).
12. **Who decides:** link choices and Start syncing for the business org need
    `business.manage`, on Settings → Xero only. The client-sheet business line and
    Open in Xero are owner-only; members see their own org's line.
13. **Owner consent for member orgs:** Team → member switch "Send clients of
    {name}'s jobs to their Xero", off until the owner turns it on (audited) —
    customer data lands in another business's books (APP 6 / Xero data-passthrough).
14. **Imports after go-live** run the matcher before any create; created contacts
    from an undone import stay in Xero (the dialog says so).
15. **`syncStartedAt`** per org: nothing is enqueued before Start syncing.
16. **Reconciler** does indexed work only (due rows, expired leases).
    `xeroSync:resyncAll` (and a `dryRun`) are internal tools run by hand.
17. **iPhone finish:** `/login?next=` (validated with `safeNext`) so a signed-out
    finish page signs in and completes; real-iPhone test is a Release 1 gate.
18. **Hook guarantee:** writes to clients/clientContacts/properties move to the
    explicit-table form so a source test can enforce the helper; bin's generic
    loop is split per table.
19. **One `classify(response)`** for every Xero error: retry / pause / reconnect /
    needs a look / stop.
20. Kill switch env `XERO_SYNC_PAUSED`; crons use `crons.cron`, not `crons.daily`.

## 12. Questions (see chat)

Q1 routing · Q2 leads · Q3 first connect · Q4 duplicate names — plus the
defaults in §3/§4 (bin = leave Xero alone, owner sees member status read-only,
offboarding disconnects, contacts-only scopes) unless you say otherwise.
