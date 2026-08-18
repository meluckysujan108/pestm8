# Deploying PestM8

Two pieces deploy separately:

| Piece        | Runs on     | Contains                                                                                                  |
| ------------ | ----------- | --------------------------------------------------------------------------------------------------------- |
| **Backend**  | Convex      | Schema, queries/mutations/actions, file storage, Better Auth component, HTTP routes on the `.site` domain |
| **Frontend** | An SSR host | The Nitro server build — SSR, route loaders, and the `/api/auth/*` proxy                                  |

**The frontend cannot go on Convex hosting.** Convex hosting serves static
assets; this app builds a Nitro server (`vite.config.ts` runs `nitro()` beside
`tanstackStart()`) and `src/routes/api/auth/$.ts` registers real server
handlers. Those handlers are not optional — see the comment at the top of that
file: this Nitro build emits only the last `Set-Cookie` on a response, so the
proxy exists to drop the Convex JWT cookie and keep the session cookie. Serve
the app statically and nobody can sign in.

Any Nitro-supported host works: Vercel, Netlify, Cloudflare Workers, Fly,
Railway, or a plain Node box. Nitro detects the platform during the build and
switches preset; with nothing to detect it emits `node-server`, which you run
with `node .output/server/index.mjs`.

---

## Environment variables

`VITE_`-prefixed variables reach the client by being **inlined at build time**,
not read at runtime. The same two variables are also read at runtime by the
server (`src/lib/auth-server.ts`). So they must be present **when the build
runs**, not merely in the runtime environment.

Set them only at runtime and you get a half-working deploy: the server
authenticates fine while every page throws in the browser. `npm run build`
gates on this (`scripts/check-env.mjs`) so it fails at build time instead.

### On the frontend host

| Variable               | Needed at                                      | Value                                                                      |
| ---------------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| `VITE_CONVEX_URL`      | build **and** runtime                          | `https://<deployment>.convex.cloud`                                        |
| `VITE_CONVEX_SITE_URL` | build **and** runtime                          | `https://<deployment>.convex.site` — same deployment, `.site` not `.cloud` |
| `CONVEX_DEPLOY_KEY`    | build only, if the host builds the backend too | Production deploy key from the Convex dashboard                            |

Both URLs point at the **production** deployment, not the dev one `npx convex
dev` created.

### On the Convex deployment

Set with `npx convex env set --prod <NAME> <value>`:

| Variable             | Value                                                                         |
| -------------------- | ----------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` — generate a fresh one; do not reuse the dev secret |
| `SITE_URL`           | The origin the frontend is served from, e.g. `https://pestm8.vercel.app`      |

`SITE_URL` must match the frontend origin exactly — scheme, host, no trailing
slash. Better Auth rejects callbacks from origins that don't match, which
presents as sign-in appearing to work and then bouncing back to `/login`.

`.env.example` also lists `VITE_SITE_URL`. Nothing in the codebase reads it
today; leave it or drop it, but don't expect it to configure anything.

---

## First deploy

There's a sequencing knot: `SITE_URL` on the Convex deployment must be the
frontend's origin, but you don't know that origin until the frontend has
deployed once. So the first pass runs in this order, and the first deploy is
expected to fail auth until step 4.

**1. Push the backend to production Convex.**

```bash
npx convex deploy
```

This creates the production deployment if it doesn't exist and prints its URL.
Note it — both frontend variables derive from it.

**2. Set the backend secrets.**

```bash
npx convex env set --prod BETTER_AUTH_SECRET "$(openssl rand -base64 32)"
```

**3. Deploy the frontend.** On Vercel, import the repo and set
`VITE_CONVEX_URL` and `VITE_CONVEX_SITE_URL` in project settings **before** the
first build — the build inlines them. Build command `npm run build`, output
directory `.output`. Netlify and Cloudflare are the same shape; Nitro handles
the preset.

**4. Close the loop.** Take the URL the host assigned and point the backend at
it:

```bash
npx convex env set --prod SITE_URL https://<your-deployed-origin>
```

Sign-in works from here. Repeat this step whenever the frontend origin changes
— a custom domain, or moving hosts.

---

## Verifying a deploy

The failure modes are all quiet, so check them directly:

- **Load any route.** A blank page with `VITE_CONVEX_URL is not set` in the
  console means the build ran without the variables inlined. Re-run the build
  with them set; a redeploy of the same artifact won't fix it.
- **Sign in.** Bouncing back to `/login` after apparently-successful
  credentials means `SITE_URL` on the deployment doesn't match the origin.
- **Check the service worker.** `curl https://<origin>/sw.js` should return
  JavaScript, not a redirect or HTML. Existing on disk and being reachable are
  different things here — see "How the service worker gets served" below.
- **Confirm the auth proxy is live.** `/api/auth/*` must be served by the Nitro
  server. If the host is serving `.output/public` statically and ignoring
  `.output/server`, this 404s and no session ever persists.

---

## How the service worker gets served

Worth knowing, because it is load-bearing and not obvious from reading the
build script alone.

Nitro bakes a manifest of `.output/public` into the server bundle at build time
— `#nitro/virtual/public-assets-data` inside `.output/server/index.mjs` — and
serves only the files that manifest lists. `scripts/build-sw.mjs` has to run
_after_ Nitro has assembled the build (its header comment explains why: any
earlier and the precache manifest is computed from the previous build's
assets). So the worker is written to disk after Nitro has stopped looking, and
nothing registers it.

Left alone, `/sw.js` falls through to the SSR router and answers `307 → /login`
while sitting on disk the whole time. Registration then fails, because the
browser gets an HTML redirect where it expected JavaScript, and the PWA
silently does nothing — including the offline schedule reading ARCHITECTURE.md
§5.5 is built around. It works under `vite dev`, which serves from disk on
demand, so this only ever appears in a built app.

`build-sw.mjs` therefore appends the manifest entry itself after writing the
worker, using Nitro's own entry shape and etag algorithm. Serving reads `size`
for `Content-Length`, so the entry is computed from the bytes just written — a
stale one truncates the response rather than failing cleanly.

Verified against `node .output/server/index.mjs`: `/sw.js` returns `200` with
`content-type: text/javascript; charset=utf-8`, a body byte-identical to the
file on disk, and `304` for a conditional request carrying the etag.

If a Nitro upgrade renames or restructures that virtual module, the build fails
with a message pointing here rather than shipping an unreachable worker again.
That is the failure to expect if `npm run build` starts complaining about the
public asset manifest.

---

## What is not set up

- **No CI.** Nothing builds or deploys on push; both steps above are manual.
- **No preview deployments.** Convex supports preview deployments per branch;
  wiring them to the host's preview builds is unconfigured.
- **No error reporting.** Sentry is listed in Phase 4 (ARCHITECTURE.md §6.4)
  and is not installed, though `vite.config.ts` already externalises `@sentry/*`
  in the Nitro rollup config.
