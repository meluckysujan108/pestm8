## What and why

<!-- What changes, and what problem it solves. -->

## How it was verified

<!-- What you actually ran or clicked. "CI is green" is not verification of
     behaviour — say what you checked. -->

- [ ] `pnpm verify` passes
- [ ] Checked on the Vercel preview (required for anything touching auth,
      cookies, SSR, or the service worker — these differ from localhost)

## Risk

- [ ] Touches `convex/schema.ts` — if so, is it additive? See CONTRIBUTING.md
- [ ] Touches auth, `convex/lib/access.ts`, or tenant scoping — if so, does
      `e2e/access-control.spec.ts` still cover it?
- [ ] Needs a new environment variable — if so, it is documented in
      DEPLOYMENT.md and set in every environment

## Rollback

<!-- Anything beyond "revert this commit"? Say so here rather than working it
     out during an incident. -->
