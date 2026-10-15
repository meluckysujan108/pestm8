# Xero

PestM8 links Xero over OAuth and keeps Xero's contacts in step with the client
book, one way, PestM8 → Xero. **Contacts only**; invoices are a later phase.

Every Xero organisation connected in a business receives the whole client book
and every change after that. That is the business's own organisation, which the
owner connects on Settings → Xero, and each contractor's or subcontractor's
own, which they connect on Settings → My Xero. Leads wait until their first job
is booked, nothing in the Recycle bin is sent, and PestM8 never deletes or
archives anything in Xero. The owner sees which organisation a member connected
but cannot disconnect it; removing the member does. Clients already copied stay
in their Xero. Why it is built this way is `ARCHITECTURE.md` §1.2, §1.4 and
§4.5; the research behind it is `docs/xero-contacts-plan.md`.

| Release | What                                                                                                                              | Writes contacts to Xero? |
| ------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| R0      | The owner's set-up, below                                                                                                         | —                        |
| R1      | **Connect**: the two Settings pages, tokens and refresh, disconnect, offboarding, the crons, `/login?next=`, `/terms`, `/privacy` | No                       |
| R2      | **Match your clients**: reads every Xero contact and links the ones PestM8 already has                                            | No (reads only)          |
| R3      | **Sync**: the send queue, Start syncing, the client sheet's Xero line, the kill switch, a dry run                                 | Yes, after Start syncing |

R1's only calls to Xero are the token endpoint (exchange, refresh, revoke),
`GET` and `DELETE /connections`, and `GET /Organisation`.

## Setting up (R0, the owner's steps)

1. **A Xero developer account** at developer.xero.com, under an address the
   business controls rather than a personal one. Whoever creates it holds its
   Owner role.
2. **A Web app named "PestM8"** for prod. The name can't contain "Xero".
   - Redirect URI: `https://rare-retriever-156.convex.site/xero/callback`,
     exactly. The token exchange sends the identical string, and Xero refuses
     any difference.
   - Company or application URL: `https://pestm8.vercel.app` (prod's
     `SITE_URL`).
   - "Will you use Xero data to train … an AI model?": **No** (the privacy
     page says so too).
   - "Do you agree to meet Xero's minimum security requirements?": **Yes**.
     What meets them: tokens encrypted with AES-256-GCM under a key held apart
     from the data, the callback answering with a 302, TLS throughout, and
     two-step sign-in required of whoever connects (`XERO_TWO_STEP_REQUIRED`,
     below).
   - Terms and privacy URLs: prod's `SITE_URL` + `/terms` and `/privacy`. Both
     pages are drafts for the owner to approve first (step 6).
   - Generate a client secret. Xero shows it once.
3. **A second Web app, "PestM8 Dev"**, for dev, with redirect URIs
   `https://acoustic-schnauzer-237.convex.site/xero/callback` and, for a local
   backend, `http://localhost:3211/xero/callback` (Xero refuses `127.0.0.1`).
   It has to be a separate app. Xero issues one token set per Xero user and
   app, and a new consent supersedes the last, so with one app a connect on dev
   would kill prod's tokens for the same Xero login.
4. **A token key per deployment**: `openssl rand -base64 32`, set as
   `XERO_TOKEN_KEYS=1:<key>`. It encrypts the stored tokens (AES-256-GCM). Keep
   each in the password manager; it is not `BETTER_AUTH_SECRET` and never
   shares a value with it.
5. **Set the env vars**, after confirming the target. `.env.local`'s
   `CONVEX_DEPLOYMENT` must name `acoustic-schnauzer-237`, never the duplicate
   project's deployments (`CLAUDE.md`).
   ```sh
   npx convex env set XERO_CLIENT_ID '<PestM8 Dev client id>'
   npx convex env set XERO_CLIENT_SECRET '<PestM8 Dev secret>'
   npx convex env set XERO_TOKEN_KEYS '1:<dev key>'
   ```
   Prod is the same with `--prod` and the "PestM8" app's values, at the R1
   deploy. The Convex dashboard's environment variables page does the same
   without leaving the secret in shell history. The e2e deployment gets
   **nothing**: its tests are of the screens a deployment without Xero shows.
6. **Approve `/terms` and `/privacy`**, with advice. They disclose that the
   whole client book is copied into every connected organisation, members' own
   included, and stays there after a member leaves. That is a disclosure of the
   business's clients to other businesses (APP 6, and Xero's data
   pass-through terms). A contractor agreement should say what happens to the
   copies when someone leaves. When either page changes what it says about
   Xero, bump `XERO_TERMS_VERSION` in `convex/lib/xeroConfig.ts`: each
   connection records the version it was made under.
7. **Test organisations**: Xero's **Demo Company (AU)** for the owner's
   connect, and one **trial organisation** for the member and two-users-one-org
   cases.

## Env, per deployment

| Variable                                | prod `rare-retriever-156`                                        | dev `acoustic-schnauzer-237`                                      | e2e `warmhearted-cricket-924` |
| --------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------- |
| `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` | the "PestM8" app's                                               | the "PestM8 Dev" app's                                            | unset, on purpose             |
| `XERO_TOKEN_KEYS`                       | its own key                                                      | its own key                                                       | unset                         |
| `XERO_REDIRECT_URI`                     | unset (→ `https://rare-retriever-156.convex.site/xero/callback`) | unset; a local backend sets `http://localhost:3211/xero/callback` | —                             |
| `XERO_SYNC_PAUSED`                      | unset; `on` stops every write to Xero (R3)                       | as needed                                                         | —                             |
| `XERO_MAX_ORGS`                         | unset (5); `50` once on Core                                     | unset (5)                                                         | —                             |

`SITE_URL`, which every deployment already has for sign-in, is where the
callback sends the browser back to. All three of the client id, the secret and
the key together make a deployment "set up for Xero" (`xeroConfigured()`).
Without them, Settings shows no Xero rows, `xero.startConnect` throws
`XERO_NOT_CONFIGURED`, and `/xero/callback` answers 404. Never paste
`npx convex env list` output anywhere: it prints the secret and the key.

## How connecting works

Connecting needs two-step sign-in on for the person connecting — Xero's
minimum security requirements ask for strong sign-in on whoever links an
organisation, and two-step is otherwise optional in PestM8 (`lib/mfa.ts`). The
page shows "Turn on two-step sign-in" in place of Connect Xero until it is on;
`beginConnect` and `finish` both refuse without it (`XERO_TWO_STEP_REQUIRED`),
so turning it off while at Xero leaves the connect unfinished. Nobody else's
sign-in changes.

Connect Xero (`xero.startConnect`) makes a random `state`, stores only its
hash, bound to the person, their membership and which kind of connection, for
10 minutes, and sends the browser to Xero's sign-in in the same window. Xero
sends it back to `GET /xero/callback` on the deployment's `.convex.site`
(`convex/xeroCallback.ts`). The callback uses the state once, exchanges the
code for tokens, reads the Xero user from the access token and the organisation
from `GET /connections` (organisations only, never a practice), checks the
refusals, encrypts both tokens into `xeroGrants` (one row per Xero user, since
that is how Xero issues them), stores the connection as `pending`, and sends
the browser to the Settings page with a one-time finish token. The page finishes
it (`xero.finishConnect`), which only the same signed-in person and membership
that started can do: a finish link that reaches anyone else is useless to
them. That binds the connect to the person, not to the browser — someone who
completes another person's Xero sign-in link and then hands back the address
they land on has given them their organisation (`convex/xero.ts` has the
trade-off). A connect nobody finished is released after 15 minutes. A
refresh token rotates every time it is used, so refreshes take a 60-second
lease, one at a time; a daily cron refreshes any token set left idle for 30
days, because Xero kills one unused for 60 — and revokes instead any that no
live connection uses (a release at Xero that gave up), so PestM8 never keeps
a sign-in alive for someone who disconnected.

| File                                  | Holds                                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `convex/xero.ts`                      | Status for Settings, connect, finish, disconnect, release at Xero, the sweep, `inspect`      |
| `convex/xeroCallback.ts`              | `GET /xero/callback`                                                                         |
| `convex/xeroTokens.ts`                | The refresh lease, the keep-alive, `accessTokenFor` (every Xero action gets its token there) |
| `convex/lib/xeroConfig.ts`            | The env, scopes, endpoints and `XERO_TERMS_VERSION`                                          |
| `convex/lib/xeroCrypto.ts`            | Token encryption, actions only                                                               |
| `convex/lib/xeroHttp.ts`              | Every Xero request, and `classify`, which sorts every failure                                |
| `convex/lib/xeroHooks.ts`             | `requireConnectionHolder`, `disconnectXeroFor` (called by `team.offboard`)                   |
| `src/components/xero/`                | `XeroPage` (both Settings pages), `MemberXero` (Team → a member), `xeroCopy.ts` (every word) |
| `src/routes/terms.tsx`, `privacy.tsx` | The public pages Xero's developer terms require                                              |

## Running it

Is a deployment set up? Without a `state`, a configured callback redirects to
the app and an unconfigured one answers 404:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://acoustic-schnauzer-237.convex.site/xero/callback
# 302 = set up, 404 = not
```

Add `--prod` to any of these for prod, after confirming the target:

```sh
# Every connection, without a secret in sight
npx convex run --inline-query 'return (await ctx.db.query("xeroConnections").collect()).map((c) => ({ id: c._id, kind: c.kind, org: c.tenantName, status: c.status, problem: c.problem, reason: c.disconnectReason }))'

# One connection and its sign-in: status, refreshedAt, scopes. No ciphertexts.
npx convex run xero:inspect '{"connectionId": "…"}'

# The nightly keep-alive, by hand
npx convex run xeroTokens:keepAlive

# Refresh one sign-in now (the grantId is in inspect's output)
npx convex run xeroTokens:refreshGrant '{"grantId": "…"}'

# The hourly sweep of connects left half-way, by hand
npx convex run xero:sweep
```

Never `collect()` `xeroGrants` whole into a terminal: project out
`accessCipher` and `refreshCipher`, as `inspect` does.

The crons (`convex/crons.ts`): "refresh idle Xero sign-ins" daily at 20:00 UTC
(about 04:00 in Perth), and "sweep Xero sign-ins left half-way" at 50 minutes
past each hour.

### What a connection's status means

| Status            | Means                                                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pending`         | Xero sent the browser back; the page hasn't finished it yet. Released after 15 minutes (`disconnectReason: 'unfinished'`)                                                                                                                        |
| `connected`       | Working                                                                                                                                                                                                                                          |
| `needs_reconnect` | Xero refused the refresh token (`invalid_grant`): the sign-in is dead (`problem: reconnect`); or Xero refused the organisation to a sign-in it still accepts (`problem: org_gone`). Its holder presses Reconnect Xero, for the same organisation |
| `disconnected`    | Kept as the record of who connected what. `disconnectReason`: `by_hand`, `offboarded`, `unfinished`, `refused`, `xero_side`                                                                                                                      |

`problem.code` is why a connection needs attention, worded on screen by
`src/components/xero/xeroCopy.ts`. `xero_side` means PestM8 couldn't take
itself out of Xero after a disconnect — its sign-in was already dead, or Xero
kept failing the release for about 15 minutes and the sign-in couldn't be
revoked either: the person removes PestM8 in Xero → Settings → Connected apps
themselves, or Xero goes on counting the organisation against the tier's cap.
When no other connection uses that sign-in, PestM8 forgets it either way, so
it can't reach the organisation again.

### What someone sees coming back from Xero

The page reads `?xero=<code>` and shows its words from `XERO_RETURN_COPY`.

| Code            | Why                                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `cancelled`     | They cancelled at Xero's sign-in                                                                                     |
| `failed`        | Xero returned another error, the code exchange failed, or the callback threw. The logs say which                     |
| `no_org`        | The sign-in reached no organisation, only a practice or nothing                                                      |
| `ambiguous_org` | Xero listed nothing for this sign-in, and the Xero login has more than one organisation: no guessing which           |
| `business_org`  | A member chose the business's own organisation                                                                       |
| `member_org`    | The owner chose an organisation a member has connected                                                               |
| `taken`         | That organisation is already connected in this business                                                              |
| `different_org` | A reconnect came back with another organisation. A connection's organisation never changes: disconnect, then connect |
| `org_cap`       | A new organisation when `XERO_MAX_ORGS` are already connected across every business                                  |
| `demo`          | The demo business can't connect                                                                                      |
| `expired`       | More than 10 minutes at Xero's sign-in                                                                               |

A refusal deletes the Xero connection the sign-in made, unless another live
connection, in any business, holds it. Finishing can fail too: `FINISH_EXPIRED`
(more than 15 minutes, or finished already), `NO_ACCESS` (started by someone
else) or `TAKEN`.

In the logs: `XERO_RECONNECT` (the sign-in is dead), `XERO_BUSY` (another
refresh held the lease throughout), `XERO_RETRY` (Xero or the network failed;
try later), `XERO_TOKEN_UNREADABLE` (a ciphertext no key opens) and
`XERO_KEYS_INVALID` (`XERO_TOKEN_KEYS` is malformed; its value is never
logged). No token, code or `Authorization` header is ever logged.

### Changing the token key

1. `openssl rand -base64 32` for the new key.
2. Put it first: `XERO_TOKEN_KEYS=2:<new>,1:<old>`. The first entry encrypts;
   a ciphertext names the key version that made it (`x1.<version>.…`), so the
   old key still opens the old ones.
3. Each sign-in is re-encrypted under the new key the next time it is
   refreshed: when it is next used after its access token has run out, or by
   the keep-alive once it has sat idle for 30 days.
4. Drop the old key only once no active grant was last refreshed before the
   change:
   ```sh
   npx convex run --inline-query 'return (await ctx.db.query("xeroGrants").collect()).filter((g) => g.status === "active" && g.refreshedAt < <change time in ms>).length'
   ```

Losing the keys loses every stored sign-in: everyone connects again. Nothing
else is lost, because links to Xero contacts (R2 on) are kept by organisation,
not by sign-in.

## Costs and limits

Checked 2026-10-01 against Xero's pricing and developer pages (pricing since
2 March 2026).

- **Starter is free for 5 distinct organisations across the whole app**:
  every business, the owner's organisation and every member's own. Several
  people on one organisation count once. **Core** ($35 AUD a month) allows 50;
  **Plus** ($245 a month) allows 1,000 and needs certification. The cap is per Xero
  app, so "PestM8 Dev" counts its own five.
- **PestM8 refuses the sixth itself** (`org_cap`) rather than send someone
  through Xero's sign-in for nothing. After moving to Core, set
  `XERO_MAX_ORGS=50` on prod.
- **Xero counts every connection not yet deleted at Xero,** dead ones
  included, where PestM8 counts organisations held by its live connections.
  PestM8 deletes its connection at Xero on every disconnect it can; one it
  couldn't (`xero_side`) counts until it is removed in Xero.
- **Each Xero organisation allows two uncertified apps** (Starter and Core
  apps are uncertified). A contractor whose organisation already has two can't
  add PestM8 until they remove one.
- **Rate limits per organisation:** 5 requests at once, 60 a minute, 1,000 a
  day on Starter (5,000 on Core and up); 10,000 a minute across the app. R1
  makes a handful of calls per connect. R3 sends 50 contacts a call, so a
  2,000-client book is about 40 calls per organisation.
- **Tokens:** an access token lasts 30 minutes. A refresh token lasts 60 days
  unused and rotates every time it is used (the old one works for 30 more
  minutes).
- **The Demo Company resets on its own schedule,** with fresh data, so
  anything linked against it on dev goes stale. If a reset gives it a new
  organisation id, a reconnect is refused (`different_org`): disconnect and
  connect again.

## Release 1 checks on dev

With "PestM8 Dev", the Demo Company and a trial organisation. Record each.

| #   | Check                                                                                                                                | Result | Date | By  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ------ | ---- | --- |
| 1   | The owner connects the Demo Company; Xero → Settings → Connected apps lists PestM8 Dev                                               |        |      |     |
| 2   | Reconnect keeps the same row; a different organisation is refused                                                                    |        |      |     |
| 3   | Disconnect; Connected apps no longer lists it                                                                                        |        |      |     |
| 4   | A member connects the trial organisation on My Xero; the owner sees it on Team                                                       |        |      |     |
| 5   | A member choosing the business's organisation is refused                                                                             |        |      |     |
| 6   | After 30 minutes, `xeroTokens:refreshGrant` succeeds and `xero:inspect` shows a new `refreshedAt`; `keepAlive` runs                  |        |      |     |
| 7   | Removing the member disconnects their Xero; the owner's is untouched                                                                 |        |      |     |
| 8   | **Real iPhone, Home Screen app:** where Xero opens, where the finish lands, whether it asks to sign in, the page updates. An R1 gate |        |      |     |

## Release 3 Demo Company gate

To be filled in on dev against the Demo Company before anyone presses Start
syncing on prod. The code ships with the conservative answer to each.

| #   | Check                                                                       | Result | Date | By  |
| --- | --------------------------------------------------------------------------- | ------ | ---- | --- |
| a   | A `MOBILE`-only POST keeps `DEFAULT`                                        |        |      |     |
| b   | A `STREET`-only POST keeps `POBOX`                                          |        |      |     |
| c   | `ContactPersons`: replaced or merged (decides `CONTACT_PERSONS_ON_MATCHED`) |        |      |     |
| d   | `""` clears a field                                                         |        |      |     |
| e   | The exact text of a name clash                                              |        |      |     |
| f   | A merge in Xero's UI → `ARCHIVED` + `MergedToContactID`                     |        |      |     |
| g   | Archiving in Xero stops the sync                                            |        |      |     |
| h   | The same `Idempotency-Key` twice → one contact                              |        |      |     |
| i   | `AccountNumber` and a suffixed name on a draft invoice                      |        |      |     |
| j   | Open in Xero, on a computer and an iPhone                                   |        |      |     |
| k   | Two users, one organisation (the trial organisation)                        |        |      |     |
