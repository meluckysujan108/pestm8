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
  JavaScript. A redirect or HTML means the worker is not being served — see
  "Known issue" below. The build gate in `scripts/build-sw.mjs` asserts the
  file exists on disk, which is not the same as it being reachable.
- **Confirm the auth proxy is live.** `/api/auth/*` must be served by the Nitro
  server. If the host is serving `.output/public` statically and ignoring
  `.output/server`, this 404s and no session ever persists.

---

## Known issue: the service worker is not served on `node-server`

`scripts/build-sw.mjs` writes `sw.js` into `.output/public` _after_ Nitro has
assembled the build. Nitro freezes its static-asset manifest during the build,
so it never learns the file exists and the request falls through to the SSR
router, which redirects unauthenticated traffic to `/login`.

Reproduced against `node .output/server/index.mjs`:

| Request                                           | Result         |
| ------------------------------------------------- | -------------- |
| `sw.js` (written after the Nitro build)           | `307 → /login` |
| `manifest.webmanifest` (present during the build) | `200`          |
| `icon-192.png` (present during the build)         | `200`          |

A scratch file dropped into `.output/public` post-build behaves like `sw.js`,
and `sw.js` appears zero times in `.output/server/index.mjs` while
`manifest.webmanifest` appears in the embedded manifest — so this is asset
registration, not anything specific to the worker.

The effect is that registration fails and the PWA silently does nothing:
`navigator.serviceWorker.register('/sw.js')` receives an HTML redirect with the
wrong content type. Offline schedule reading — the field case ARCHITECTURE.md
§5.5 is built around — does not work in a deployed build. It works in `vite
dev`, which serves from disk on demand, which is why it survived to here.

**This is confirmed only for the `node-server` preset.** Hosts that upload
`.output/public` to a CDN fronting the server function — Vercel, Netlify — may
serve the file before the request ever reaches the router. Verify with the
`curl` check above on whichever host you pick rather than assuming either way.

---

## What is not set up

- **No CI.** Nothing builds or deploys on push; both steps above are manual.
- **No preview deployments.** Convex supports preview deployments per branch;
  wiring them to the host's preview builds is unconfigured.
- **No error reporting.** Sentry is listed in Phase 4 (ARCHITECTURE.md §6.4)
  and is not installed, though `vite.config.ts` already externalises `@sentry/*`
  in the Nitro rollup config.
