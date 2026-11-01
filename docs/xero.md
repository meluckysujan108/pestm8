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
`GET` and `DELETE /connections`, and `GET /Organisation`. R2 adds one more,
`GET /Contacts`, and still writes nothing. R3 writes, and only contacts: `PUT
/Contacts` adds them, `POST /Contacts` updates them, and `GET /Contacts?IDs=`
and `?where=Name==` read the ones it is about to touch. Nothing is written to
an organisation until its holder presses **Start syncing**.

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
     staff access to the deployments kept to the owner. They don't include
     two-step sign-in in the app itself: Xero asks for that only past 1,000
     connected organisations, or for its Practice Manager, Tax and HQ APIs
     (its security standard for API consumers, checked 1 Nov 2026). PestM8
     holds at most `XERO_MAX_ORGS` (below).
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
   **Then check the keys before anyone connects:**
   ```sh
   npx convex run [--prod] xero:checkApp
   ```
   `{ ok: true }` means Xero accepts the client id and secret. `invalid_client`
   is a wrong secret (or the other app's), and `invalid_request` means Xero
   could not read the keys at all — a secret over 100 characters, which is
   what a secret pasted twice looks like (prod, 15 Oct 2026: a 143-character
   value, the real 48-character secret with text between two copies of it).
   A connect against bad keys comes back as `?xero=app_setup`, and the log
   names this command.
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
| `XERO_TWO_STEP_REQUIRED`                | unset; `on` refuses a connect without two-step sign-in           | unset                                                             | —                             |

`SITE_URL`, which every deployment already has for sign-in, is where the
callback sends the browser back to. All three of the client id, the secret and
the key together make a deployment "set up for Xero" (`xeroConfigured()`).
Without them, Settings shows no Xero rows, `xero.startConnect` throws
`XERO_NOT_CONFIGURED`, and `/xero/callback` answers 404. Never paste
`npx convex env list` output anywhere: it prints the secret and the key.

## How connecting works

Connecting needs no two-step sign-in in PestM8 (since 1 Nov 2026, the
owner's call; it was required from R1 until then). Xero doesn't ask for it
below 1,000 connected organisations (step 2 above), and whoever approves the
connection signs in to Xero itself, which has its own two-step sign-in. Two-step
stays optional everywhere in PestM8 (`lib/mfa.ts`); the page suggests it under
Connect Xero, with a link to turn it on, for anyone who hasn't.

What a password alone could do is told instead of refused. A connect (not a
reconnect of the same organisation) emails, from the account sender
(`RESEND_ACCOUNT_FROM_EMAIL`, noreply@):

- **whoever's account connected it** — "Xero is connected to {business} in
  PestM8": which organisation, when, what is copied once Start syncing is
  pressed, and, if it wasn't them, to choose a new password with "Forgot
  password?" (which signs every device out) and disconnect it;
- **the owner, when a member connects their own Xero** (My Xero) — "{member}
  connected their Xero to {business}": every client goes there and stays
  there if they leave; to undo it, remove them in Settings → Team, which
  disconnects it.

Both are queued in `finish`'s own transaction (`queueXeroConnected` in
`convex/accountEmails.ts`) and sent like a password reset. A reconnect is only
`finish` completing the very row it set out to reconnect: Reconnect pressed and
the connection disconnected before Xero sends the browser back makes a new
connection (to whichever organisation was chosen), which is told of like any
connect. A deployment with no account sender connects just the same and sends
nothing. Neither email asks anyone to reply or write in. The privacy page says
so (`XERO_TERMS_VERSION` 2026-11-01).

Rolling the backend back to before these emails means deleting the
`accountEmails` rows of kind `xeroConnected` and `memberXeroConnected` first:
the older schema doesn't know them, and the push is refused.

`XERO_TWO_STEP_REQUIRED=on` puts the old rule back without a code change: the
page shows "Turn on two-step sign-in" in place of Connect Xero (and Reconnect
Xero) until it is on, and `beginConnect` and `finish` both refuse without it
(`XERO_TWO_STEP_REQUIRED`), so turning it off while at Xero leaves the connect
unfinished. The emails are sent either way.

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

| File                                  | Holds                                                                                                                                                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `convex/xero.ts`                      | Status for Settings (with the match's counts), connect, finish (which starts the first match), disconnect, release at Xero, the sweep, `inspect`                                                                |
| `convex/xeroCallback.ts`              | `GET /xero/callback`                                                                                                                                                                                            |
| `convex/xeroTokens.ts`                | The refresh lease, the keep-alive, `accessTokenFor` (every Xero action gets its token there)                                                                                                                    |
| `convex/lib/xeroConfig.ts`            | The env, scopes, endpoints and `XERO_TERMS_VERSION`                                                                                                                                                             |
| `convex/lib/xeroCrypto.ts`            | Token encryption, actions only                                                                                                                                                                                  |
| `convex/lib/xeroHttp.ts`              | Every Xero request, and `classify`, which sorts every failure                                                                                                                                                   |
| `convex/lib/xeroHooks.ts`             | `requireConnectionHolder`, `disconnectXeroFor` (called by `team.offboard`), the match's counts (R2), and the four hooks every client write calls (R3)                                                           |
| `convex/lib/xeroMatch.ts`             | The matcher (R2): `nameKey`, `accountNumberKey`, `matchClients`. Pure, so every rule is tested without Convex                                                                                                   |
| `convex/xeroMatch.ts`                 | The match run and its tenant lease, the match page's query (with who holds each candidate), Same / Different / Share / Give / Unlink, Check Xero again (R2)                                                     |
| `convex/clientMerge.ts`               | Merging one client into another (`merge`), and the preview its confirm reads (`mergePreview`): [When the contact is already another client's](#when-the-contact-is-already-another-clients)                     |
| `convex/lib/xeroContact.ts`           | The mapper (R3): which clients go, what each field is, the field hashes and `diff`. Pure, like the matcher                                                                                                      |
| `convex/xeroSync.ts`                  | The send (R3): Start syncing, the drain, the reconciler, the client sheet's lines, Send PestM8’s details, and the tools below                                                                                   |
| `convex/xeroHooks.test.ts`            | Reads the source and fails any write to a client, contact or site that doesn't call a hook (R3)                                                                                                                 |
| `src/components/xero/`                | `XeroPage` (both Settings pages), `MatchReview`, `MatchCard` and `SameCustomerSheet` (Match your clients), `MemberXero` (Team → a member), `ClientXeroLines` (a client's sheet, R3), `xeroCopy.ts` (every word) |
| `src/routes/terms.tsx`, `privacy.tsx` | The public pages Xero's developer terms require                                                                                                                                                                 |

## How matching works (R2)

An organisation that has been invoicing for years already holds most of the
client book. Before anything is sent, PestM8 reads its contacts and works out
which PestM8 client each one is, so that Release 3 updates the contact a client
already has instead of adding a second. Xero contacts can't be deleted — a
duplicate made by mistake stays in someone's books — so a client is linked on
strong evidence only, and anything weaker is put to the holder. **R2 never
writes to Xero.** What it makes are PestM8's own rows, `xeroContactLinks`, which
Release 3 acts on.

A match (`xeroMatch.run`) runs:

- when a connect is finished, unless this connection has a match finished less
  than 7 days ago (so a reconnect inside a week doesn't read everything again);
- when the holder presses **Check Xero again**.

The answers are the holder's to give, as connecting is: the owner's for the
business's organisation (Settings → Xero → Match your clients), and a member's
for their own (Settings → My Xero → Match your clients), and only through a
live connection. The owner never sees a member's matches, nor a member the
business's, while the other holds the organisation.

What the answers say belongs to the organisation, not to whoever gave them:
which of this business's clients is which of its contacts. So they pass with
it. If a member disconnects an organisation and the owner then connects the
same one as the business's (or the other way round), the new holder finds the
old answers and may change them; the Matched list says "Matched by hand"
rather than "Matched by you" for an answer they didn't give. The old holder's
disconnected connection reads nothing (`NOT_FOUND`). Anyone who can connect
an organisation is a Xero user on it, so none of this shows them a contact
they couldn't see in Xero.

### What it reads

- **Xero's contacts:** all of them, 1,000 a call (`includeArchived=true`), at
  least 1.1 seconds apart, because Starter allows an organisation 60 calls a
  minute. A 3,000-contact organisation is three calls. It keeps each contact's
  name, email, account number, status, first phone and the city of its first
  address, and nothing else. Only `ACTIVE` contacts are ever candidates:
  `ARCHIVED` and `GDPRREQUEST` ones never are. More than 50 pages (50,000
  contacts) fails the run as `too_many_contacts`.
- **The client book,** 500 at a time, less what is never sent: leads (counted,
  as "Leads waiting", and matched by the first run after their first job is
  booked), clients in the Recycle bin, and clients archived before the Recycle
  bin existed (`archivedAt`). A client's emails are its own and, for a
  business client, its primary contact's.

### The rules

Names, account numbers and emails are compared as keys
(`convex/lib/xeroMatch.ts`):

- **A name** is lower-cased, `&` reads as "and", punctuation goes, a trailing
  "Pty Ltd", "Pty Limited", "Ltd", "Limited" or "Pty" goes, and the words are
  sorted. "Smith, John" is "John Smith"; "Acme Pty Ltd" is "ACME".
- **An account number** is Xero's `AccountNumber` read as a number when it is
  all digits, and compared with the client's number: "0042" is client #42.
  Anything else in it is not a number and is ignored.
- **An email** is lower-cased.

An account number two or more contacts hold is ignored, and so is an email as
evidence (those contacts can still be found by name). Then, strongest first:

| Evidence (`ACTIVE` contacts only)                                          | Result                                | `reason`              | The card says                                           |
| -------------------------------------------------------------------------- | ------------------------------------- | --------------------- | ------------------------------------------------------- |
| The account number is the client's number, and the name or an email agrees | Matched                               | —                     | —                                                       |
| The account number is the client's number, and nothing else agrees         | To check                              | `account_number_only` | Same account number, different name                     |
| …unless another contact has an email only it has, and the name, too        | Matched, to that other contact        | —                     | —                                                       |
| An email only one contact has, and the name agrees                         | Matched                               | —                     | —                                                       |
| An email only one contact has, and the name doesn't                        | To check                              | `email_only`          | Same email, different name                              |
| The name                                                                   | To check, with phone and place shown  | `name_only`           | Same name                                               |
| The name, which two or more contacts have                                  | To check, against one of them (below) | `name_shared`         | Same name — Xero has more than one contact by this name |
| One contact proposed for two or more clients                               | To check, every one of them           | `contested`           | More than one of your clients matches this contact      |
| A contact another client was already matched to by hand                    | To check                              | `contested`           | More than one of your clients matches this contact      |
| Nothing                                                                    | New to Xero                           | —                     | —                                                       |

The same book and the same contacts always give the same answer (ties go by
client id), so running it again with nothing changed proposes nothing new.

- **The account number, against an email and a name.** Xero's `AccountNumber`
  is a free field. When the client's number is on a stranger but another
  contact has the client's own unique email and its name, the client is
  linked to that other contact: asked about the stranger, the holder would say
  Different, and Release 3 would add a second contact for someone Xero already
  holds. (The first spec asked about the numbered contact; this is the change.)
  The stranger still has the number, and Xero refuses an `AccountNumber`
  another contact has, so **Release 3 must not copy the client's number into a
  linked contact while another contact holds it.**
- **A name more than one contact has.** Contacts already another client's by
  the holder's word are passed over while any is free (Same on one could only
  be refused); of the rest, the one whose phone (its last eight digits) or
  place agrees with the client's phone or suburb, if just one does; else the
  first by contact id. Once the holder has answered one client of a name,
  Check Xero again offers its namesakes the contacts left.

### What a link means

One row per business, organisation and client. It is keyed by the
organisation, not the connection, so a reconnect, or a disconnect and a later
connect to the same organisation — by whoever — finds every answer still
there. Disconnecting keeps them. Two businesses connected to one organisation
each have their own.

**One Xero contact is one client** per business and organisation, after every
batch a run saves and not only once it is done: a run that stops part-way
never leaves two clients linked to one contact. A run linking a client to a
contact an earlier run linked to someone else moves it (the earlier row goes:
the run, which sees every client at once, gave the contact to this one); one
the holder linked by their word is never moved, and the run's proposal is put
to them as `contested` instead. A client in the Recycle bin, or archived,
holds nothing: whoever is linked to its contact next — by a run, or by Same —
takes it, and its link goes, so if it is restored it is matched afresh. A
client may _share_ another client's contact (`shared`, below) without holding
it: the holder still has it alone, and only the holder is sent.

| `state`        | On screen      | Means                                                                                                                                   | Release 3                                               |
| -------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `linked`       | Matched        | This client is that Xero contact. `how`: `matched` by the rules, or `chosen` by the holder                                              | Sends the client's changes to that contact              |
| `needs_review` | To check       | A candidate (`candidate`, with its `reason`) for the holder to answer                                                                   | Sends nothing for it until it is answered               |
| `separate`     | Different      | The holder said it isn't that contact, or unlinked it                                                                                   | Adds it as a new contact                                |
| `new`          | New to Xero    | Nothing in Xero matched                                                                                                                 | Adds it as a new contact                                |
| `shared`       | Shared contact | The holder said this client is the same customer as another (`sharedWithClientId`), and it uses that client's contact (`xeroContactId`) | Sends nothing for it: the client it shares with is sent |

Xero won't hold two contacts with one name, so a Different client whose name
Xero already has is added with its suburb after the name, "John Smith
(Nightcliff)" (Release 3).

Release 3 adds three states, which the client's sheet shows, and two more
`how`s: `created` (PestM8 added the contact) and `relinked` (the client's
contact was merged into another in Xero, and the link followed it — or,
since 16 Oct 2026, the client took the contact over from a client merged
into it in PestM8).

| `state`            | On the client's sheet        | Means                                                                                      | Release 3                                              |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `archived_in_xero` | Archived in Xero             | Someone archived the contact in Xero, without merging it                                   | Sends nothing more for it to that organisation         |
| `gdpr`             | Removed in Xero, for privacy | Xero holds a privacy request on the contact (`GDPRREQUEST`)                                | Stops for good, and never adds the client again        |
| `failed`           | Not sent                     | Xero refused the contact for a reason a retry won't fix (`problem.code`, worded on screen) | Tries again when the client next changes, or is booked |

A link also carries what the send needs to compare (`sent`, `seen`,
`different`, below), its `problem` if any, and `lastSentAt`.

### Same, Different, Unlink

- **Same client** (`xeroMatch.decide`, `same`) links the client to the contact
  (`how: chosen`). One Xero contact is one client: if that contact is already
  matched to another client in the book, it is refused (`CONTACT_TAKEN`). The
  card never offers Same for such a contact — it offers the answers under
  [When the contact is already another client's](#when-the-contact-is-already-another-clients)
  instead — so the refusal is only met when another client took the contact
  after the page loaded. (One in the Recycle bin gives the contact up
  instead, above.)
- **Different client** (`different`) makes it `separate`. The candidate stays
  on the row, for reference and for Match again.
- **Unlink** (`xeroMatch.unlink`), on a matched client, does the same as
  Different, whether the rules matched it or the holder did. The contact it
  was linked to is kept as its candidate (`reason: unlinked`). On a client
  sharing another's contact (Shared contact), it does the same: the client
  stops sharing, and is added to Xero as a contact of its own.
- **Match again** (`xeroMatch.reopen`), on the Different list, takes either
  back: the client is undecided again, To check against the same contact.
  Different saves on one tap, so it must be undoable; this is how.

Each answer records when and by whom (`decidedAt`, `decidedByMembershipId`),
and a decided client is never proposed again: no later match changes it, and
the contact it was matched to is held for it. Match again clears both. Each is
audited against the real person (`xero.link`, `xero.separate`, `xero.unlink`,
`xero.reopen`, `xero.share`, `xero.give`, with the organisation's name and the
contact's id) and moves the counts on Settings at once. A link the rules made
is not an answer: the next run proposes it afresh, so a contact whose email
changed in Xero since can move to To check.

The counts follow the lists without a run in other ways too: a client put in
the Recycle bin or archived leaves them (its links stay, for a restore), a
restore or an unarchive puts it back, and a client wiped for good, taken back
by an import's undo, or merged into another client takes its links with it —
a merge first handing its contact to the client it went into wherever that
one has none (`lib/xeroHooks.ts` `countXeroLinksOf`, `dropXeroLinksForClient`,
`handOverContacts`).

### When the contact is already another client's

One Xero contact is held by one client per business and organisation. When
PestM8 finds a client like a contact another client already holds, what
happens depends on how alike they are and who holds it:

1. **The holder is in the Recycle bin, or archived.** It holds nothing:
   Same, or a run, takes the contact, and the holder's link goes (above).
2. **A sync finds a weak likeness** — an email, a name or an account number
   alone — to a contact another client holds: an agency's shared office
   email, a namesake. That is no question. The client is matched again
   against the contacts nobody holds, and added if nothing there is like it,
   a clashing name taking its suburb (`preMatch` in `convex/xeroSync.ts`,
   since 16 Oct 2026).
3. **Anything else** — a strong likeness (the same name, and the same email or
   number: two PestM8 records of one customer, most likely), a run's proposal
   of a contact the holder matched to another client by hand, a contact
   merged in Xero into one another client has — goes To check. The card says
   who has the contact (`reviewPage`'s `heldBy`: that client's name, number,
   suburb, email and phone, read when the page is), and offers answers that
   can all be carried out, never a Same that could only be refused.

`heldBy` is worked out as the page is read, for every To check card: the
client in the book (not in the Recycle bin, not archived), other than the
card's own, linked to the candidate in this business and organisation. So a
card shows it whatever put the client To check, and loses it when the holder
lets go.

Below, {B} is the card's client and {A} the client with the contact. A card
with `heldBy` is answered one of these ways. All of them are the
organisation holder's, through a live connection and not switched, like every
other answer here; Merge also needs `clients.manage`.

| Answer                                                                 | Call                            | PestM8                                                                                                                                                                                     | Xero, once syncing                                                                                                        |
| ---------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| **Different customers**                                                | `xeroMatch.decide`, `different` | The client is Different (`separate`), as Different client always was. One tap; Match again takes it back                                                                                   | Added as a contact of its own, its suburb after its name if Xero has the name                                             |
| **Same customer…** → Merge {B} into {A}                                | `clientMerge.merge`             | One client: {B}'s sites, jobs, contact people and notes move to {A}, and {B} goes to the Recycle bin as "Merged into {A}" (below)                                                          | {A} keeps its contact. Where {A} has none and {B} has one, {A} takes {B}'s over; where both have one, {B}'s stays in Xero |
| **Same customer…** → Keep both, use {A}’s Xero contact                 | `xeroMatch.decide`, `share`     | Both stay. {B} is `shared`, with {A}'s contact and `sharedWithClientId` {A}, listed under Shared contact, where Unlink takes it back                                                       | Nothing is sent for {B}. {A}'s changes still are                                                                          |
| **Same customer…** → {A} is the wrong match — give this contact to {B} | `xeroMatch.decide`, `give`      | In one mutation, {A} is unlinked exactly as Unlink does it (`separate`, the contact kept as its candidate, `unlinked`), and {B} is linked (`how: chosen`)                                  | {B} fills in blanks on the contact, as Same does. {A} is added as a contact of its own, through the clash rules           |
| **Open {B}**                                                           | —                               | Opens {B}'s client sheet, whose Edit puts right what made it look like {A} (an agency's office email on a tenant, say). Editing answers nothing: the card still waits for one of the above | Nothing, until the card is answered                                                                                       |

**Keep both (`share`)** is for one customer kept as two records on purpose —
a landlord's two portfolios, a business booked under two names — where the
books should have one contact. Only {A} is sent. Nothing is queued for {B},
anything already waiting for it is let go by the drain as nothing to send,
and its eligibility says so from then on (`shared`, below), so a drain never
adds {B} nor writes {B}'s details over {A}'s: two clients writing one
contact would undo each other. {B} doesn't hold the contact, and a match run
neither proposes for {B} nor offers {B}'s contact to anyone (it only counts
it, `shared`): if someone else is later proposed for the contact, it is {A}
they are told has it. A share needs the candidate held by another client in
the book (`NOT_HELD` otherwise: the page is behind, and Same will do now),
and the card To check (`NOT_FOUND`). Audited `xero.share`, with who it is
shared with.

**Give (`give`)** is for when {A} was matched to the wrong contact: the contact
is really {B}'s. {A} is unlinked exactly as Unlink does it — its contact kept
as its candidate, anyone sharing it back To check (`was_shared`, below) —
and {B} is linked to the contact in its place, as Same would, all in one
mutation. It is allowed even when PestM8 made the contact for {A} (`how:
created`), where Unlink alone isn't offered: giving it away doesn't add {A}
a second time beside its own contact, it gives {A} a contact of its own, and
the confirm says so. Both clients are queued once syncing. It needs the
candidate held (`NOT_HELD`), like a share. One audit row, `xero.give`, from
{A} to {B}: {A}'s unlink isn't audited on its own.

**Merge (`clientMerge.merge`)** makes {B} and {A} one client, everywhere in
PestM8, at once. It is the client book's own operation, offered where the
duplicate shows itself: nothing about it is Xero's, and nothing waits for
Start syncing. It needs `clients.manage` (the owner, or a contractor, the same
people who may delete a client) as themselves: a switch drops it, and a
subcontractor holding their own Xero is told who can. The sheet and its
confirm read `clientMerge.mergePreview`, which refuses exactly as the merge
would, so the confirm never promises a merge that is then refused — a
refusal that will stand (too big, a business into a person, changed since)
is said in the Merge option's place, which is then not a button. It counts
what moves (sites, contact people and notes, and the jobs, recurring
services and reports at those sites, none of them in the Recycle bin) and,
for each organisation the person sees on a client's sheet (the business's
for whoever manages the business, their own as a member), what happens to
{B}'s contact there (`lib/xeroHooks.ts` `mergeOutcome`): `takes_over` ({A}
takes it over), `stays` (it stays in Xero beside {A}'s), or `none` ({B} has
no contact of its own there).

- **What moves to {A}:** {B}'s sites not in the Recycle bin (a site deleted on
  its own stays {B}'s, and goes with it), and with them everything that hangs
  off a site, untouched: jobs, recurring services, reports and photos. A
  moved site loses its import mark (`importId`, not `importedFrom`), so an
  import's Undo can't take it back from {A}; so does {A} itself, so an Undo
  of the import that brought {A} can't delete it with what it took from
  {B} ({A}'s own untouched imported sites still go). {B}'s contact people not in the
  bin: {A} keeps its contact person, and {B}'s stays one only if {A} has
  none. The notes about {B}, Recently deleted ones too (one brought back is
  then on {A}), except those about a site that stays {B}'s.
- **What {A} takes from {B}:** only blanks — an email, a phone, an ABN (both
  businesses), a mailing address (all four lines together, only when {A} has
  none), and {B}'s tags after its own, up to `MAX_TAGS`. {A}'s name, kind,
  number and status stay, except that a lead becomes active when {B} is: the
  booked work came with {B}'s sites.
- **{B}** goes to the Recycle bin through the bin's own `putInBin`, marked
  `mergedIntoClientId` {A}, with no `bin.delete` row (the merge audits
  itself). The bin lists it as "Merged into {A}", and it can't be restored
  (`MERGED`): its sites and jobs are {A}'s now, and it would come back an
  empty duplicate. The same goes for a site or contact person of {B}'s that
  was already in the bin, and for a job or recurring service deleted on its
  own at such a site (`MERGED`, never "restore the property first"). It is
  deleted for good after 30 days like anything else there.
- **Xero,** organisation by organisation, every one {B} has a link in
  (connected or not: links outlive a disconnect):
  - **{B} is a contact of its own there and {A} is none** (no link, new, To
    check, Different, not added, or sharing a contact — {B}'s among them):
    {A} takes {B}'s contact over, before {B} goes in the bin
    (`handOverContacts` in `lib/xeroHooks.ts`, owner's decision of 16 Oct
    2026). {B}'s link becomes {A}'s: the same contact and state (linked; or
    archived or erased in Xero, so {A} is never added there with {B}'s
    details either), `how: relinked`, decided by whoever merged, so no
    later match undoes it. What was sent and seen carries over — it
    describes the contact — so compare before set sends what of {A} differs
    from what {B} last sent where Xero still holds that (a renamed {A}'s
    name, say), and leaves the bookkeeper's own changes alone; a contact
    matched but never sent only has its blanks filled. Anyone sharing
    {B}'s contact there follows it to {A}, still shared. Without this {A}
    would be added as a new contact beside {B}'s: one customer twice in
    the books, the invoices split.
  - **Both are contacts of their own there:** {A} keeps its own. {B}'s link
    goes (`dropXeroLinksForClient`, after the bin, which took {B} out of
    the counts; it drops the send the bin queued too), its contact stays in
    Xero linked to nothing — PestM8 never deletes there — and anyone
    sharing it goes back To check (`was_shared`).
  - **{B} has no contact of its own there** (new, To check, Different, or
    sharing another's): its link goes, and {A} keeps whatever it has.

  {A} is queued, so what it took from {B} goes (compare before set, as
  always).

- **Refused:** the same client twice (`SAME_CLIENT`); either one not in the
  book (`NOT_FOUND`); a business into a person (`KIND_MISMATCH`) when the
  business has what a person's record never shows — contact people, a site
  contact at a site that would move, an ABN or an office address — which
  would be kept on {A} but never shown, dialled or sent, and gone with
  {B}'s wipe: make {A} a business first, or keep both; and `MERGE_TOO_BIG`
  when {B} has more than 500 sites and
  contact people together, more than 500 notes, or more jobs, recurring
  services and reports at its sites than deleting a client may take (the
  bin's `MAX_GROUP_ROWS`). One transaction moves it all, so it is all or
  nothing; nobody has a client that big.
- Audited `clients.merge`, on {A}, with {B}'s id and number and what moved:
  ids and numbers only, since the log outlives {B}'s wipe. The merge can't
  be undone, so the row says enough to tell later which of {A}'s records
  were {B}'s: the ids of the sites, contact people and notes that moved,
  which of {A}'s fields were filled from {B} (`filled`), and in Xero the
  contacts {A} took over, {B}'s links dropped (organisation, state,
  contact) and the clients put back To check. Nothing is
  scheduled or rebooked — a job is at a site, not a client — so the schedule
  and the recurrence engine never notice.

**When the client shared with lets go (`was_shared`).** A shared client
follows its holder. When {A} stops holding the contact — unlinked, gave it
away, put in the Recycle bin, archived, wiped (or taken back by an import's
undo), merged into a client with a contact of its own there (into one with
none, the contact goes with it, and so do they), its contact archived or held for privacy
in Xero, or put To check itself — every client sharing it in that
organisation goes back To check against the same contact (`needs_review`,
reason `was_shared`: "Shared {A}’s contact, which {A} no longer has" — the
row keeps `sharedWithClientId`, which `reviewPage` returns as `sharedWith`, so
the card can name {A} — or "Shared another client’s contact, which that
client no longer has" once {A} is wiped). Same, Keep both or Give replaces
it; Different keeps it with the candidate. It is never quietly linked to the
contact instead: the holder's "same customer" was about {A}. Nothing is sent
for it until the holder answers again, and a restore of {A} doesn't take it
back. One helper does it all, `releaseSharesOf` in `lib/xeroHooks.ts`,
called from every one of those paths, so the counts move with it.

What isn't letting go: when Xero merges {A}'s contact into another and {A}'s
link follows it (`relinked`), or Xero renames it, the clients sharing it
follow too, still shared (`moveSharesOf`): it is the same customer's contact.

The eight clients left To check on prod by the backfill of 15 Oct 2026 (weak
likenesses, before `preMatch` passed them over) were not cleared
automatically: the product owner's call, 16 Oct 2026. Each card now says who
has its contact, and Different customers is one tap.

### Check Xero again

`xeroMatch.rematch` is the holder's, on a connected organisation, and is
refused while a run is still reading under a live lease
(`XERO_MATCH_RUNNING`), and once the organisation has started syncing
(`SYNC_STARTED`): from then its contacts are kept in step one client at a time,
and `xeroSync:resyncAll` walks the book again when that is needed
([How syncing works](#how-syncing-works-r3)). Match again stays, and so do Same
and Different on a client still to check. The page shows "Reading the contacts
in {org}…" at once,
and the run it schedules reads everything again: every decision stands, every
undecided client is proposed afresh, and an undecided row the run didn't
propose again (its client binned since, say) is deleted (`finishMatch`, the
rows whose `runId` isn't this run's). Press it after tidying Xero — merging
duplicates, filling in account numbers — or the client book.

### The tenant lease

Xero's limits (60 calls a minute, 5 at once, a daily allowance) are per
organisation, and one organisation can be connected in more than one business.
So one match run (R2) or one send (Release 3's drain) works on an organisation
at a time, across every business. A run claims `xeroSyncState.lease` on its own
connection's row for 5 minutes, and only when no row for the same organisation
(`by_tenant`) holds a live one. A run that finds one held tries again in 60
seconds, up to 10 times, then fails as `busy`. The lease is released when the
run ends, however it ends; if the run itself dies, it lapses after its 5
minutes. Every write checks the lease is still the run's (`LEASE_LOST`), so a
run that outlived it can't overwrite a newer run's proposals.

### What a match's state means

`xeroSyncState.match`, one per connection, which is what Settings shows.

| `state`   | Means                                                                                                                                                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reading` | A run is reading Xero and matching, or is about to (`runId` empty until it takes the organisation). The page shows "Reading the contacts in {org}…"                                                                                                                                               |
| `ready`   | Finished. Counts: `contacts` (`ACTIVE` contacts read), `linked`, `review`, `fresh` (clients Release 3 will add as new contacts: New to Xero and Different), `different` (the Different ones among them), `shared` (sharing another client's contact) and `leads`. Every answer moves them at once |
| `failed`  | `problem` says why: `reconnect` (the sign-in is dead, and the connection shows Reconnect), `busy` (the organisation was held throughout), `too_many_contacts`, `rate_limited`, `xero_unavailable`, `paused`, `disconnected`, or `failed`                                                          |

A run that dies without saying so — killed by a deploy, past the action time
limit — leaves the match `reading`. `xero.status` gives a time after which
that is past believing (`staleAfter`, `xeroMatch.matchStaleAfter`): the run's
lease's end, plus two minutes, or 15 minutes after the ask for a run that
never took the organisation (every busy retry, and more). The page compares it
with its own clock — a query mustn't read one — and from then shows the read
as stopped, with Check Xero again, which the server accepts because the lease
has lapsed. A run asked for while connected that finds the connection needs
reconnecting, or disconnected, when it starts fails the match as `reconnect`
or `disconnected` rather than leave it reading. A connection with no match at
all was connected before matching existed (a connect asks for one in the same
write), and is offered Check Xero again.

A client binned since the last run is left out of the next one: an undecided
proposal for it goes, and a decision stays for a restore — unless another
client takes its contact meanwhile. A client wiped from the Recycle bin, or
taken back by an import's undo, takes its links with it (`bin.ts`,
`clientImports.ts`, each marked `// xero:`).

### Running a match by hand

Add `--prod` for prod, after confirming the target:

```sh
# Read and match one connection now: Check Xero again without the holder
# check. Reads only, and waits its turn if another run holds the organisation.
npx convex run xeroMatch:run '{"connectionId": "…"}'

# Every connection's match and lease
npx convex run --inline-query 'return (await ctx.db.query("xeroSyncState").collect()).map((s) => ({ connectionId: s.connectionId, tenantId: s.tenantId, match: s.match, lease: s.lease }))'

# How many links are in each state, per business and organisation
npx convex run --inline-query 'const n = {}; for (const l of await ctx.db.query("xeroContactLinks").collect()) { const k = `${l.businessId} ${l.tenantId} ${l.state}`; n[k] = (n[k] ?? 0) + 1 } return n'

# Clients sharing another client's contact, and whose
npx convex run --inline-query 'return (await ctx.db.query("xeroContactLinks").collect()).filter((l) => l.state === "shared").map((l) => ({ tenantId: l.tenantId, clientId: l.clientId, sharedWithClientId: l.sharedWithClientId, xeroContactId: l.xeroContactId }))'

# Clients merged into another, waiting in the Recycle bin
npx convex run --inline-query 'return (await ctx.db.query("clients").collect()).filter((c) => c.mergedIntoClientId !== undefined).map((c) => ({ id: c._id, mergedIntoClientId: c.mergedIntoClientId, deletedAt: c.deletedAt }))'
```

A match left showing "Reading" — its run killed by a deploy, say — shows as
stopped once its `staleAfter` has passed, and the holder's Check Xero again
reads it afresh; `xeroMatch:run` does the same by hand. Not once the
organisation is syncing: a run then does nothing, since it would replace the
links being sent, and it is `xeroSync:resyncAll` (below).

## How syncing works (R3)

Release 3 adds the client book to each organisation's contacts and keeps them
in step: one way, PestM8 → Xero, to every organisation connected in the
business whose holder has pressed Start syncing. Nothing Xero holds is copied
back into PestM8. Xero is read only to see what a contact holds before it is
changed.

### Start syncing

Nothing is queued for an organisation, and nothing written to it, until its
holder presses **Start syncing** at the foot of Match your clients: the owner
for the business's organisation, each member for their own
(`xeroSync.startSyncing`, the holder and not switched, as for every other
answer). It asks first:

> **Start syncing with Xero?** PestM8 adds {new} clients to {org} and fills in
> blanks on the {matched} it matched. Contacts added to Xero stay there, even
> if you disconnect.

It is refused while the match isn't `ready`, or when Xero was read more than
7 days ago (`MATCH_STALE`): Xero may have changed since, so Check Xero again
first. It records when and by whom (`syncStartedAt`,
`syncStartedByMembershipId`), audits `xero.start` with the match's counts, and
starts the first sync, the **backfill**. The backfill walks the whole book in
pages (`backfillCursor`). It adds the New to Xero and Different clients as
contacts and fills in blanks on the Matched ones. Settings shows "Adding your
clients…" until it is done (`backfillDoneAt`).

After that, Check Xero again is refused (`SYNC_STARTED`), but the match page
stays. A client still To check can be answered there, and the answer is sent
like any other change: Same fills in blanks on that contact, and Different adds
a new one. Match again still works.

A reconnect keeps `syncStartedAt` and carries on where it was. A disconnect
followed by a new connect is a new connection, which matches and starts again;
it finds its links by organisation, so nothing is added twice. Members press
Start syncing on My Xero the same day as the owner (the plan's decision 7):
there is no staging.

### How a change reaches Xero

Every write to a client, one of its contacts or one of its sites calls a hook
from `lib/xeroHooks.ts` in the same mutation, so the change and its place in
the queue commit together:

| Hook                                       | Called by                                                                                                                                                                | Does                                                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `markClientForXero` / `markClientsForXero` | Every edit of a client, a contact or a site; the Recycle bin's delete and restore; an import; the legacy archive and unarchive; a lead's first booking                   | Queues the client for every organisation of its business that is connected and has started syncing                                                |
| `ensureClientInXero`                       | Work booked for a client who isn't a lead (`activateLeadAt` in `convex/properties.ts`, from `jobs.create`, `jobs.update`, `recurrences.create`, `convertJobToRecurring`) | Queues it only for an organisation that has no contact for it yet, or failed to make one. Booking for a client already in Xero costs Xero nothing |
| `dropXeroLinksForClient`                   | A client wiped from the Recycle bin, or taken back by an import's undo, before its row goes                                                                              | Deletes its links and queued rows in every organisation, and moves the counts. Its contacts stay in Xero                                          |

`convex/xeroHooks.test.ts` reads the source with the TypeScript compiler. It
fails on any `ctx.db.insert`, `patch`, `replace` or `delete` on `clients`,
`clientContacts` or `properties` that doesn't name its table
(`ctx.db.patch('clients', id, …)`), or whose function calls none of the four.
A write that needn't call one (it only clears `importId`, say, or its client is
marked elsewhere in the same mutation) carries a comment just above it, and
the test requires the reason:

```ts
// xero: exempt — restore already marks every restored contact's client
```

The test skips `_generated/`, tests, `migrations/`, `demo/` and `lib/xero*`,
and proves it bites against a made-up source. The recurrence engine
(`materialiseAll`, `insertVisit`) never calls a hook: nobody booked the visits
it projects.

The hooks queue; they never judge. There is one row per organisation and
client (`xeroOutbox`), however often the client changes. Each change adds 1 to
its `rev` and makes it due 5 seconds on, so a burst of edits goes as one. A row
first queued more than 60 seconds ago keeps its time, so a client edited all
afternoon still goes within about a minute. The first row due for an
organisation schedules its drain 5 seconds later. On a deployment without Xero
the hooks do nothing; with the kill switch on, they still queue.

Whether the client belongs in Xero at all is decided when its row is sent,
from the client as it is then (`eligibility`, `lib/xeroContact.ts`). So a
status that changes between the two is never missed:

| Eligibility | When                                                             | Sent                                       |
| ----------- | ---------------------------------------------------------------- | ------------------------------------------ |
| `gone`      | The client no longer exists                                      | Nothing                                    |
| `binned`    | In the Recycle bin                                               | Nothing. Its link stays, for a restore     |
| `archived`  | Archived the old way (`archivedAt`)                              | Nothing                                    |
| `stopped`   | Its contact in this organisation is `archived_in_xero` or `gdpr` | Nothing                                    |
| `shared`    | It shares another client's contact (`shared`)                    | Nothing. The client it shares with is sent |
| `review`    | Its link is To check                                             | Nothing until the holder answers           |
| `lead`      | A lead with no contact in this organisation                      | Nothing until work is booked for it        |
| `create`    | No contact yet: New to Xero, Different, or an add that `failed`  | Added                                      |
| `update`    | Linked                                                           | Whatever changed, if anything              |

An inactive client is sent like an active one. A linked client made a lead
again keeps syncing: `lead` is only for a client Xero has never had.

### The drain

`xeroSync.drain` sends one organisation's queue. It runs only when Xero is set
up, the kill switch is off, the business isn't the demo, and the connection is
connected and has started syncing. It takes the organisation's tenant lease,
the same one a match takes ([above](#the-tenant-lease)). So a drain and a
match never overlap, and two businesses connected to one organisation never
send to it at once. It gets a token (`accessTokenFor`) and works in batches,
at most 10 batches or 2 minutes a run:

1. **What's next** (`nextWork`): up to 50 clients. Rows due now come first,
   then the backfill's next page (clients after `backfillCursor` with no row of
   their own). Live edits always go ahead of the backfill.
2. **Adds** go in one `PUT /Contacts?summarizeErrors=false`, with only what
   PestM8 owns. Ten or more in one batch (the backfill, or an import after
   go-live) first read every Xero contact once and run R2's matcher over them.
   A client the rules link is updated instead, and one they put To check waits
   for its holder. So an import never duplicates contacts Xero already has.
3. **Updates** first read the contacts as Xero holds them now
   (`GET /Contacts?IDs=`, 50 a call), for what each one is (merged, archived,
   held for privacy: below) and what each field holds. Only the fields that
   should change go, in one `POST /Contacts?summarizeErrors=false`, with the
   `ContactID` on every element. `buildUpdateBatch` throws on an element
   without one, because a POST without it can update a contact of the same
   name. A client with nothing changed costs no call at all.
4. **Each result** is read item by item. A name clash goes to the clash rules
   (below). Any other refusal makes the link `failed` with a code
   (`email_invalid`, `name_invalid`, `persons_full`, `website_invalid`,
   `unknown`), and Xero's own words go only to the logs (`console.error`). A
   call made for one client alone (a clash looked up, an add or a rename tried
   again) that Xero refuses outright fails that client only (`itemRefused`);
   the rest of the batch goes on. Only what stops the whole organisation (a
   pause, a reconnect, Xero down past its retries) stops the batch.
5. **Recorded** (`recordResults`, only while the drain still holds the lease):
   the link (one contact to one client per business and organisation), the
   hashes of what was sent and of what Xero answered, the counts, `lastSentAt`,
   the day's remaining calls and the backfill's place. A queued row is deleted
   only if its `rev` hasn't moved since it was read, so a change made while its
   batch was in flight goes next time.

Before every write, and at least once a minute between other calls, the drain
renews the lease and checks it may go on (`checkpoint`, `xeroSync.keepGoing`):
a batch slowed by clashes or a slow Xero never outlives the lease, so nothing
else takes the organisation mid-batch. The same check stops a drain at its
next write, not its next batch, once the kill switch is on or the connection
is disconnected or needs reconnecting (`XERO_HALTED`); what it had done is
recorded, and the rest stays queued (or, disconnected, goes).

When the run ends, however it ends, it releases the lease. If anything is
left, it schedules itself again for when the next row is due, even when the
organisation was lost to someone else (it may be a match, or another
business's drain, which leaves this connection's rows where they are).

A cron, "send waiting Xero changes" (`xeroSync.reconcile`, at 5, 15, 25, 35,
45 and 55 minutes past each hour), catches anything a lost schedule left
behind. It finds rows overdue by more than a minute, and organisations whose
backfill isn't done, through indexes only. It starts a drain for each one with
no live lease and no pause.

### What is sent

PestM8 owns a field of a Xero contact, and may change it, only as this table
says (`ownedFields`, `lib/xeroContact.ts`). Everything else on the contact is
left as it is.

| Xero field              | From PestM8                                                                                                                                                                                                                                             | Sent                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Name`                  | The client's name, trimmed, spaces collapsed, control characters and `< >` dropped, at most 230 characters (room for a suffix)                                                                                                                          | Always                                                                                                                                                                                     |
| `FirstName`, `LastName` | A person: their name, split at the last word ("Mary Jane Smith" is "Mary Jane", "Smith"). A business: its contact person's name, split the same way                                                                                                     | Always                                                                                                                                                                                     |
| `EmailAddress`          | The client's email; for a business with none, its contact person's                                                                                                                                                                                      | Unless it has a character outside ASCII, which Xero refuses. Then it isn't sent, and the link's problem says `email_not_ascii`; the rest still goes                                        |
| `Phones`                | The client's phone, read by `checkPhone` with the business's state: a mobile as `MOBILE`, a landline as `DEFAULT` with its area code in its own field, anything else as `DEFAULT`, as typed                                                             | Always. `DDI` and `FAX` are Xero's                                                                                                                                                         |
| `Addresses`             | A business: its company address, as both `POBOX` and `STREET`, only when it has a street or a suburb. Otherwise no address at all, never one of its sites: a real-estate agent's rental isn't its address. A person: their oldest live site as `STREET` | A person's site goes in `POBOX` too (it prints on invoices) only on an add, or while Xero's `POBOX` is blank. Suburb is `City`, state `Region`, postcode `PostalCode`, `Country` Australia |
| `TaxNumber`             | A business's ABN, spaced (`formatAbn`: "51 824 753 556")                                                                                                                                                                                                | Businesses only                                                                                                                                                                            |
| `AccountNumber`         | The client number                                                                                                                                                                                                                                       | On an add, or while Xero's is blank. Never while another active contact holds the number: Xero refuses it, and R2 may have linked the client elsewhere for that reason                     |
| `ContactPersons`        | A business's other named contacts, not its contact person, oldest first, at most 5: name and email, `IncludeInEmails` off                                                                                                                               | Only to contacts PestM8 added (`how: created`), until gate check c (`CONTACT_PERSONS_ON_MATCHED`)                                                                                          |

Never sent: `ContactNumber`, bank details, `IsCustomer` or `IsSupplier`,
contact groups, `ContactStatus` (PestM8 never archives), a contact's phone or
role (Xero's contact persons have no field for them), site contacts, and
nothing of jobs, prices, notes, reports, photos, tags or a client's status.

**Never part of a list.** Xero doesn't say whether an update with one phone
replaces the contact's other phones, one address the other, or one contact
person the rest. So an update never sends part of a list:

- `Phones` go as Xero's four, with PestM8's changed ones replaced;
- `Addresses` go as Xero's `POBOX` and `STREET`, with PestM8's changed one
  replaced, keeping that address's own `AttentionTo` (the bookkeeper's, never
  PestM8's). Its `AddressLine2` to `4` aren't sent: if Xero replaces the
  entry they go with the old address, as they should; if it merges, an old
  line 2 stays under PestM8's new street (gate check b settles which);
- `ContactPersons` go as Xero's people with PestM8's updated or added, matched
  by email (whatever its capitals), else by name. Anyone only Xero has is
  kept. Over Xero's limit of five, PestM8's are left off first, and the link's
  problem says `persons_full`.

An add sends only what PestM8 owns. Gate checks a to c say whether this care is
needed; it is harmless either way.

**Never over a change made in Xero.** A bookkeeper's billing email, or a postal
address typed in Xero, may be better than PestM8's. So each link keeps two
hashes per field: `sent`, of PestM8's value when it was last sent, and `seen`,
of what Xero held just after that (in Xero's own formatting, from its answer)
or when the client was matched. A field goes only when all three of these hold
(`diff`):

1. PestM8's value changed since it was last sent.
2. Xero still holds what PestM8 last saw there, or holds nothing, or the
   contact is being added.
3. PestM8 owns the field (the table above).

When PestM8's value changed and Xero holds something else, Xero is left alone
and the field goes on the link's `different` list. The client's sheet says
Xero has a different email (amber), and the organisation's holder may press
**Send PestM8’s details** (`xeroSync.overwrite`, audited `xero.overwrite`).
That takes Xero's current value as seen, so the next send replaces it. It is
offered only when PestM8 has a value for every field on `different`: one
cleared in PestM8 can't be sent (below), so it stays Different with no button.
Nothing else overwrites a value changed in Xero: not a resync, and not `force`,
which keeps `sent` for a field on `different` (or one Send PestM8’s details was
pressed for) and never moves `seen` to a value Xero holds now that it didn't
when last seen (`nextHashes`).

A contact Release 2 matched has no hashes on record. Its first pass fills in
what Xero holds blank, leaves every field Xero has filled in as it is (never
`different`), and records both sides (`nextHashes`). From then, a field Xero
has filled in is PestM8's to change only when PestM8's own value next changes,
and then only if Xero still holds what it held at that first pass.

**Never a blank.** Xero leaves alone a field an update doesn't name, and
doesn't say whether `""` clears one. Until gate check d proves it does, PestM8
never sends `""` (`XERO_CLEARS_WITH_EMPTY = false`): a phone or an email
removed in PestM8 stays in Xero, and the field goes on `different`. Removing a
contact, a site or an email in PestM8 removes nothing from Xero.

A hash is cyrb53 over canonical JSON (`fieldHash`), the same in a query, a
mutation and an action. A blank and a missing value hash alike.

### Name clashes

Xero won't hold two active contacts with one name. When it refuses an add, or a
rename, for that reason ("The contact name … is already assigned to another
contact", `isNameClash`; gate check e has the exact text), it is settled so
(`resolveCreateClash`; a rename, `resolveRenameClash`, goes straight to 3):

1. It finds the contact that has the name
   (`GET /Contacts?where=Name=="…"`). If none can be found (renamed in Xero
   meanwhile, or a filter gate check e has yet to settle), the client is tried
   again later (`name_unread`), never added with a suffix on a guess: it could
   be a second contact for a client already there.
2. **It is linked to no client here, is active, carries this client's number,
   and isn't the contact the holder said this client isn't**
   (`ownLostCreate`; Unlink and Different keep that contact as the link's
   candidate). Most likely it is PestM8's own add, whose answer was lost (the
   network dropped it, and Xero's 6 minutes of remembering an
   `Idempotency-Key` had passed), or one the bookkeeper made for this client.
   The client is linked to it as a match is (`matched`): blanks filled,
   nothing of Xero's overwritten, and its people left as they are, since
   PestM8 can't tell which it was.
3. **It is linked to another client here, the holder said this client is a
   different one, or this is a rename.** The name is made unique: "John Smith
   (Nightcliff)", with the suburb of the client's oldest live site, then
   "John Smith #1916", with the client number, the number left off when
   another contact has it. A suffixed name that clashes is looked up as in 1
   and 2, so a suffixed add whose answer was lost is found too. If both are
   taken, the link `failed` (`name_taken`).
4. **It is linked to no client, and nobody has ruled on it.** It may be this
   one. The link goes To check (`name_clash`), the client's sheet says Xero
   may already have them, and the holder answers on Match your clients: Same
   links it, and Different adds the client with the suffix.

A contact PestM8 added (`how: created`) has no Unlink on Match your clients:
unlinking it would only add the client a second time.

A suffixed name is the contact's name in Xero, so it prints on invoices (gate
check i).

### Leads

A lead isn't sent. It waits until work is first booked for it: `jobs.create`,
`recurrences.create`, `recurrences.convertJobToRecurring`, or a job moved to a
lead's property in `jobs.update`. Booking makes the lead active
(`activateLeadAt`, `convex/properties.ts`) and queues it, and the next drain
adds it (or matches it first, with ten or more adds in its batch). The
recurrence engine's projected visits book nothing, so they never send anyone.
Until then a lead's edits are skipped when sent, and a lead with no link at all
isn't queued. A client who was in Xero and is made a lead again stays in step.

### The Recycle bin, restore, wipe and undo

PestM8 never deletes or archives a contact in Xero, whatever happens to the
client.

| In PestM8                                          | In Xero                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A client deleted, to the Recycle bin               | Left as it is, and nothing more is sent. The link stays, for a restore                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| One of a client's sites or contacts deleted        | The client is sent again without it: the next-oldest site becomes a person's street address, say. Nothing is removed from Xero (above)                                                                                                                                                                                                                                                                                                                                                                                   |
| Restored from the Recycle bin                      | Sending resumes, with whatever changed meanwhile. If another client took its contact while it was in the bin (R2), it is added afresh, through the clash rules                                                                                                                                                                                                                                                                                                                                                           |
| Wiped for good (after 30 days, or by hand)         | Its links and queued rows go (`dropXeroLinksForClient`). The contact stays in Xero, linked to nothing                                                                                                                                                                                                                                                                                                                                                                                                                    |
| An import undone                                   | From the moment Undo is confirmed nothing more of the import is sent (`eligibility`: `undoing`), so a list taken back isn't added to Xero while it goes. The clients it made are deleted, with their links and queued rows. Contacts already added for them stay in Xero, and the undo's dialog says how many: "{n} of these clients are already in Xero and stay there." (`xeroSync.importNote`). A client the undo keeps (worked on since) is sent once kept; one the import only gave a site is sent again without it |
| Archived the old way, or unarchived (`archivedAt`) | As the Recycle bin: sending stops, and resumes                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Merged into another client (`clientMerge.merge`)   | Where the client it went into has no contact of its own and it has, that client takes its contact over, with whoever shared it (`handOverContacts`). Elsewhere its links go at once (`dropXeroLinksForClient`), and its contact, if it had one, stays in Xero, linked to nothing. The client it went into is sent again with what it took. In the Recycle bin it can't be restored ([When the contact is already another client's](#when-the-contact-is-already-another-clients))                                        |
| A client whose contact others share lets it go     | Unlinked, given away, binned, archived, wiped, merged into a client with a contact of its own, or its contact archived in Xero: everyone sharing it goes back To check (`was_shared`), and nothing is sent for them till answered. A restore doesn't take them back                                                                                                                                                                                                                                                      |
| Made inactive                                      | Still sent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| A member removed from the team                     | Their Xero is disconnected (R1). What was sent stays in their Xero                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### Merged, archived and held for privacy in Xero

Before every update the drain reads the contact as Xero has it now:

- **Merged** (`ARCHIVED`, with a `MergedToContactID`): someone merged two
  contacts in Xero. The link moves to the one that survived
  (`how: relinked`), and the client is updated there on the next pass. If
  another client here is already linked to it — or another client of the
  same batch is moving to it, two of its contacts merged into one — the
  client goes To check (`contested`) for the holder instead.
- **Archived** (not merged): `archived_in_xero`. Nothing more is sent for that
  client to that organisation, and the client's sheet says "Archived in Xero".
  PestM8 never un-archives a contact.
- **Held for privacy** (`GDPRREQUEST`): `gdpr`, stopped for good. PestM8 never
  adds that client to that organisation again, and the sheet says "Removed in
  Xero", for privacy.

Each is counted under `stopped`. Other organisations carry on. Clients
sharing the contact (`shared`) follow their holder onto a merge's survivor,
still shared (`moveSharesOf`). When the holder is archived or held for privacy
in Xero, or goes To check, they go back To check (`was_shared`,
[above](#when-the-contact-is-already-another-clients)).

### Limits and the day's budget

Xero allows each organisation 60 calls a minute, 5 at once and, on Starter,
1,000 a day (5,000 on Core). PestM8 stays inside them:

- **One drain per organisation**, across every business (the tenant lease),
  with at least 1.1 seconds between its calls.
- **50 contacts a call.** A 2,000-client book's first sync is about 40 adds
  per organisation, or for Matched clients a read and a write per 50 that need
  filling in.
- **Live edits before the backfill,** always.
- **The day's budget.** Xero's `X-DayLimit-Remaining` is kept from each answer
  (`dayRemaining`). Under 200, the backfill waits an hour
  (`backfillHeldUntil`), and live edits carry on with what is left.
- **Told to wait** (429 with `Retry-After`): the organisation is paused until
  then (`pausedUntil`, and `pauseReason` says why: `minute`, `day`, or
  `server` when Xero itself is failing). Settings says when it carries on,
  except for a minute's pause. Too many at once (429 without `Retry-After`)
  is tried again in 5 seconds.
- **Xero or the network failing** (5xx, a timeout): the same request is tried
  again, up to 3 times, 2, 5 and 15 seconds apart, with the same
  `Idempotency-Key`, so Xero never acts twice on one request. Each request
  gets a fresh key; only its own retries reuse it. If it still fails, the
  client's row waits 1 minute, then 5, then 30, and at most 2 hours
  (`attempts`, `lastError`).
- **Signed out** (401): the token is refreshed once and the call tried again.
  When Xero refuses the sign-in, the connection becomes `needs_reconnect`, and
  its queue is kept for when its holder reconnects.

The hooks queue for a connection that needs reconnecting as for a connected
one (`sendingConnections` in `lib/xeroHooks.ts`), but ask for no drain: its
changes wait. The reconnect's `xero.finish` drains them, so nothing has to be
walked again by hand.

### The kill switch

`XERO_SYNC_PAUSED=on` stops every write to Xero, for every organisation on the
deployment, at once:

```sh
npx convex env set --prod XERO_SYNC_PAUSED on   # stop
npx convex env remove --prod XERO_SYNC_PAUSED   # carry on
```

While it is on, a drain returns before it takes the lease, one already
running stops at its next write (`keepGoing`), the reconciler skips, and a
match won't run (`paused`). The hooks still queue, so nothing is
lost: every change waits, one row per client, and goes once it is off, on the
reconciler's next run (within 10 minutes) or at once with `kick`. Settings
says "Sending to Xero is paused. Changes wait here." Connecting and
disconnecting still work.

### What Settings and the client's sheet show

`xeroSyncState.counts`, one set per connection, moved by every send and every
answer; `recount` sets them afresh.

| Count       | Is                                      | On Settings → Xero (or My Xero)                                     |
| ----------- | --------------------------------------- | ------------------------------------------------------------------- |
| `inXero`    | Clients linked to a contact and sending | In Xero                                                             |
| `review`    | To check                                | To check (amber)                                                    |
| `different` | Links with a field on `different`       | Different in Xero (amber)                                           |
| `waiting`   | Queued rows                             | Waiting to send (99+ past 99)                                       |
| `failed`    | Links that `failed`                     | Not sent (amber; each under Recent problems while among the newest) |
| `stopped`   | Links `archived_in_xero` or `gdpr`      | Not a row                                                           |

`recent` keeps the last 20 problems, newest first. Settings lists those that
still stand (the client's link still carries that code: one put right since
goes), one per client, five at most, under Recent problems, with "The newest 5
of {n}." when there are more. Each says "Could not add {client}", "Could not
update {client}" (one in Xero already) or, for something only left off a
contact, the client's name, over why, and opens the client. "Last sent {when}" is
`lastSentAt`. The hub's Xero row carries one badge: "Reconnect", else "{n} to
check", else "{n} different".

A client's sheet has a line per organisation the person looking holds, from
`xeroSync.clientLines`: the business's for the owner (`business.manage`), a
member's own for that member. Its states are `in_xero`, `waiting`, `lead`,
`to_check`, `archived`, `gdpr`, `different`, `failed`, `shared` (in Xero as
another client's contact: "In Xero as {A}’s contact", and that its own
changes aren't sent; `sharedWithName` is null when the person looking can't
see {A}, and the line says "another client’s") and `not_yet` (not in Xero, and nothing
queued), worded by `ClientXeroLines` and `xeroCopy.ts`.
Before Start syncing a client the match found in Xero is already `in_xero`
(with no "sent"), one to check `to_check`, a lead `lead`, and the rest
`not_yet`. Open in Xero opens
`https://go.xero.com/organisationlogin/default.aspx?shortcode={shortCode}&redirecturl=/Contacts/View/{contactId}`,
which signs the person in to the right organisation first. It is shown only
when both are known. Nobody sees a line for an organisation they don't hold,
and a deployment without Xero shows none.

### Running the sync by hand

Add `--prod` for prod, after confirming the target. `dryRun`'s samples are
real clients' names, emails, phones and addresses: read them in the terminal
and paste them nowhere. No command prints a token.

```sh
# What would be sent, without sending: adds, updates and skips (by reason)
# over the queue and the whole book, and up to 10 sample payloads. Writes
# nothing to Xero. It reads Xero's contact list only for 10 or more adds, as
# a drain would.
npx convex run xeroSync:dryRun '{"connectionId": "…"}'

# Walk the whole book again from the start: after a migration that changed
# clients, or a change to what is sent. It compares before it
# sends, so an unchanged client costs nothing.
npx convex run xeroSync:resyncAll '{"connectionId": "…"}'

# The same, forgetting what was last sent, so every field PestM8 owns is
# compared afresh. Still never over a value changed in Xero: what PestM8 last
# saw there is kept, and a field Different in Xero stays so.
npx convex run xeroSync:resyncAll '{"connectionId": "…", "force": true}'

# Start a drain now. It waits its turn for the organisation, and does
# nothing while paused.
npx convex run xeroSync:kick '{"connectionId": "…"}'

# Count the links and the queue again, if Settings' numbers look wrong
npx convex run xeroSync:recount '{"connectionId": "…"}'

# The connection and its sign-in, no secrets
npx convex run xero:inspect '{"connectionId": "…"}'

# Each organisation's sync: pause, day's budget, backfill, counts, lease
npx convex run --inline-query 'return (await ctx.db.query("xeroSyncState").collect()).map((s) => ({ connectionId: s.connectionId, pausedUntil: s.pausedUntil, pauseReason: s.pauseReason, dayRemaining: s.dayRemaining, backfillCursor: s.backfillCursor, backfillHeldUntil: s.backfillHeldUntil, backfillDoneAt: s.backfillDoneAt, counts: s.counts, lastSentAt: s.lastSentAt, lease: s.lease }))'

# The queue: rows per connection, the oldest, and how many are failing
npx convex run --inline-query 'const n = {}; for (const r of await ctx.db.query("xeroOutbox").collect()) { const k = r.connectionId; n[k] = n[k] ?? { rows: 0, oldest: r.firstQueuedAt, failing: 0 }; n[k].rows += 1; n[k].oldest = Math.min(n[k].oldest, r.firstQueuedAt); if (r.attempts > 0) n[k].failing += 1 } return n'
```

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
npx convex run --inline-query 'return (await ctx.db.query("xeroConnections").collect()).map((c) => ({ id: c._id, kind: c.kind, org: c.tenantName, status: c.status, problem: c.problem, reason: c.disconnectReason, syncStartedAt: c.syncStartedAt }))'

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
(about 04:00 in Perth), "sweep Xero sign-ins left half-way" at 50 minutes past
each hour, and "send waiting Xero changes" (R3) at 5, 15, 25, 35, 45 and 55
minutes past each hour.

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

| Code            | Why                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cancelled`     | They cancelled at Xero's sign-in                                                                                                                    |
| `failed`        | Xero returned another error, the code exchange failed, or the callback threw. The logs say which                                                    |
| `app_setup`     | Xero refused PestM8's own keys at the code exchange (`invalid_client`, `invalid_request`, `unauthorized_client`): fix the env, then `xero:checkApp` |
| `no_org`        | The sign-in reached no organisation, only a practice or nothing                                                                                     |
| `ambiguous_org` | Xero listed nothing for this sign-in, and the Xero login has more than one organisation: no guessing which                                          |
| `business_org`  | A member chose the business's own organisation                                                                                                      |
| `member_org`    | The owner chose an organisation a member has connected                                                                                              |
| `taken`         | That organisation is already connected in this business                                                                                             |
| `different_org` | A reconnect came back with another organisation. A connection's organisation never changes: disconnect, then connect                                |
| `org_cap`       | A new organisation when `XERO_MAX_ORGS` are already connected across every business                                                                 |
| `demo`          | The demo business can't connect                                                                                                                     |
| `expired`       | More than 10 minutes at Xero's sign-in                                                                                                              |

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
  makes a handful of calls per connect. R2 reads 1,000 contacts a call, so a
  match is a call or two for most organisations. R3 sends 50 contacts a call,
  so a 2,000-client book is about 40 calls per organisation.
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

## Release 2 checks on dev

Against the Demo Company, with dev clients seeded to pair with its contacts:
one with the same email and name, one with only the name, and one whose number
is a contact's `AccountNumber` under another name. Record each.

| #   | Check                                                                                                                                                                     | Result | Date | By  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---- | --- |
| 1   | Connecting shows "Reading {org}’s contacts…", then the counts; `xeroSyncState.match` agrees with them                                                                     |        |      |     |
| 2   | Same email and name → Matched; the name alone → To check, "Same name", with phone and place; the account number alone → To check, "Same account number, different name"   |        |      |     |
| 3   | Same client, Different client, Unlink and Match again each move the counts on Settings → Xero, and the hub's "to check" badge; Match again puts a Different back to check |        |      |     |
| 4   | Check Xero again keeps every answer, and drops a proposal for a client binned since                                                                                       |        |      |     |
| 5   | A lead is counted under Leads waiting and is on no list                                                                                                                   |        |      |     |
| 6   | The Demo Company's contacts show no change in Xero: nothing edited, nothing added (each contact's History and notes)                                                      |        |      |     |
| 7   | A member's trial organisation matches on My Xero; the owner can't open their match page, nor the member the business's                                                    |        |      |     |
| 8   | Real iPhone, Home Screen app: a to-check card, Same and Different, Unlink's dialog                                                                                        |        |      |     |

## Release 3 checks on dev

With "PestM8 Dev", the Demo Company and a trial organisation, after the R2
checks. Record each.

| #   | Check                                                                                                                                | Result | Date | By  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ------ | ---- | --- |
| 1   | `xeroSync:dryRun` before Start syncing: its adds and updates agree with the match's New, Different and Matched counts                |        |      |     |
| 2   | Start syncing: the New and Different clients appear in Xero; Matched contacts have their blanks filled and nothing they held changed |        |      |     |
| 3   | A phone edited in PestM8 is in Xero within a minute; the client's sheet says when it was sent                                        |        |      |     |
| 4   | An email changed in Xero, then in PestM8: the sheet says Xero has a different email, and Send PestM8’s details replaces it           |        |      |     |
| 5   | A lead is not sent; booking its first job sends it                                                                                   |        |      |     |
| 6   | Recycle bin: nothing more sent; restore: the change made meanwhile goes; wipe: the contact stays in Xero                             |        |      |     |
| 7   | A second "John Smith" goes in as "John Smith ({suburb})", then a third as "John Smith #{number}"                                     |        |      |     |
| 8   | Merge a linked contact into another in Xero: the link follows; archive one: the sheet says Archived in Xero                          |        |      |     |
| 9   | `XERO_SYNC_PAUSED=on`: nothing reaches Xero and Waiting to send counts up; removed, it all goes                                      |        |      |     |
| 10  | A member's trial organisation starts syncing on My Xero; one edit reaches both organisations                                         |        |      |     |
| 11  | Real iPhone, Home Screen app: the client's Xero line, Open in Xero as a hold, the Start syncing dialog                               |        |      |     |

## Same customer checks

With two clients of one customer: {A} already matched or added to a contact,
and {B} To check against it. Record each.

| #   | Check                                                                                                                                                 | Result | Date | By  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---- | --- |
| 1   | The card says who has the contact, with their number, suburb, email and phone, and offers Different customers, Same customer… and Edit; no Same       |        |      |     |
| 2   | Different customers: once syncing, the client is added as its own contact (suffixed if Xero has the name); Match again under Different takes it back  |        |      |     |
| 3   | Keep both: listed under Shared contact; the client's sheet says "In Xero as {A}’s contact"; an edit to {B} sends nothing, an edit to {A} goes         |        |      |     |
| 4   | Unlink {A} while {B} shares it: {B} is back To check, its reason saying it shared a contact {A} no longer has                                         |        |      |     |
| 5   | Give: {A} is under Different, {B} under Matched; once syncing, {A} is added as its own contact and {B} fills in blanks on the one it was given        |        |      |     |
| 6   | Merge: the confirm's counts match what moves; {B}'s sites, jobs and notes are {A}'s; the Recycle bin says "Merged into {A}" and offers no Restore     |        |      |     |
| 7   | Merge where {B} had its own contact: it is still in Xero, unchanged; {A}'s contact is unchanged but for blanks filled                                 |        |      |     |
| 7a  | Merge where {B} had its own contact and {A} none (a member's organisation): the confirm says {A} takes it over; {A} is that contact after, no new one |        |      |     |
| 8   | A subcontractor on My Xero sees why they can't merge; a switched owner is refused                                                                     |        |      |     |
| 9   | Real iPhone, Home Screen app: the held card, the Same customer sheet, both confirms                                                                   |        |      |     |

## Release 3 Demo Company gate

To be filled in on dev against the Demo Company before anyone presses Start
syncing on prod. Checks a to e, h, l and m are Xero's behaviour, not PestM8's: make
them with Xero's API Explorer against the Demo Company. The code ships with the
conservative answer to each, which the "Until then" column says. A result that
allows less care changes a constant in `lib/xeroContact.ts`, in a commit of its
own that quotes the result.

| #   | Check                                                                       | Until then                                                                                    | Result | Date | By  |
| --- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------ | ---- | --- |
| a   | A `MOBILE`-only POST keeps `DEFAULT`                                        | An update sends all four phones, Xero's own kept                                              |        |      |     |
| b   | A `STREET`-only POST keeps `POBOX`                                          | An update sends both addresses, Xero's own kept                                               |        |      |     |
| c   | `ContactPersons`: replaced or merged (decides `CONTACT_PERSONS_ON_MATCHED`) | `false`: people go only to contacts PestM8 added, as Xero's list with PestM8's merged in      |        |      |     |
| d   | `""` clears a field                                                         | `XERO_CLEARS_WITH_EMPTY = false`: never sent, so a value removed in PestM8 stays in Xero      |        |      |     |
| e   | The exact text of a name clash                                              | `isNameClash` (`lib/xeroHttp.ts`) looks for "name" then "already assigned to another contact" |        |      |     |
| f   | A merge in Xero's UI → `ARCHIVED` + `MergedToContactID`                     | The link follows `MergedToContactID`                                                          |        |      |     |
| g   | Archiving in Xero stops the sync                                            | `archived_in_xero`, and nothing more is sent                                                  |        |      |     |
| h   | The same `Idempotency-Key` twice → one contact                              | Only retries of one request reuse its key; an answer lost for 6 minutes is found by number    |        |      |     |
| i   | `AccountNumber` and a suffixed name on a draft invoice                      | — (what a customer sees)                                                                      |        |      |     |
| j   | Open in Xero, on a computer and an iPhone                                   | —                                                                                             |        |      |     |
| k   | Two users, one organisation (the trial organisation)                        | One drain per organisation, across every business                                             |        |      |     |
| l   | `where=Name=="…"` with a `"` in the name, and in other capitals             | `\"` escaping, an exact match kept; a clash not found is tried again later (`name_unread`)    |        |      |     |
| m   | A `STREET` sent with only line 1: Xero's `AddressLine2` and `AttentionTo`   | `AttentionTo` sent back as Xero had it; lines 2 to 4 not sent                                 |        |      |     |

## Release 3 first sync on prod

Once the gate is filled in, with Terence, for Pest M8 Pest Control's
organisation:

1. **Confirm the target and the build.** `.env.local` and every command name
   `rare-retriever-156` (`CLAUDE.md`). Vercel's newest successful production
   build is `main` with Release 3, and the backend was deployed from the same
   commit.
2. **Snapshot:** `npx convex export --prod --path before-xero-sync.zip`.
3. **Terence answers every To check** on Settings → Xero → Match your
   clients, and spot-checks five Matched clients against Xero. If Xero was read
   more than 7 days ago, Check Xero again first: Start syncing would be
   refused.
4. **A dry run, read together:**
   `npx convex run --prod xeroSync:dryRun '{"connectionId": "…"}'`, with the id
   from the connections query under [Running it](#running-it). Its adds,
   updates and skips by reason should agree with the match's counts. Read the
   sample payloads: names, addresses, ABNs. Paste them nowhere.
5. **Start syncing**, by Terence, on Match your clients.
6. **Watch it go in.** Settings shows "Adding your clients…", and the sync
   state query (above) shows the backfill moving and `dayRemaining` falling.
7. **Check ten contacts in Xero:** a business with a company address, one
   without (no address at all), a person (their oldest site as the street
   address), a suffixed name, and a Matched client whose blanks were filled
   and whose other fields weren't touched. Check each one's account number.
8. **If anything is wrong:** `npx convex env set --prod XERO_SYNC_PAUSED on`.
   Writes stop at once and the queue keeps every change. Fix it, dry-run again,
   then remove the variable.

Members press Start syncing on My Xero the same day (the plan's decision 7),
each after answering their own To check and a dry run of their connection.
