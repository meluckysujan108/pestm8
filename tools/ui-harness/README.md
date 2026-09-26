# UI harness

Renders the app's real components — sheets, cards, forms, dialogs — with
sample data and no backend, and screenshots them at phone width in both
themes. It is how a UI change is seen before it ships when there is no Convex
deployment to run the app against (a cloud session, CI, a fresh checkout).

It is not the app: there is no router tree, no auth, no live queries. Each
component's Convex queries are answered from `fixtures.ts`; mutations resolve
to nothing. A component whose query has no fixture shows its loading state,
and the query's name is logged, which is how you find what to add.

## Use

```bash
pnpm ui:harness            # serves on :5200 (PORT=… to change)
pnpm ui:shots              # every specimen, light + dark, into tools/ui-harness/shots/
pnpm ui:shots out sheet    # just some specimens, into ./out
```

Open `http://localhost:5200/` for the list of specimens, or
`/?s=jobdetail&theme=dark` for one. `&debug=1` outlines every `tap-target`
hit area, so a 44px target can be seen.

In a cloud session Playwright's browser is preinstalled; point the script at
it: `CHROMIUM_PATH=/opt/pw-browsers/chromium pnpm ui:shots`.

## Before and after

Render the base branch beside your change with a second server over a
worktree of it:

```bash
git worktree add ../pestm8-base origin/main
ln -s "$PWD/node_modules" ../pestm8-base/node_modules
HARNESS_REPO=../pestm8-base PORT=5201 pnpm ui:harness   # "before"
pnpm ui:harness                                        # "after", :5200
PORT=5201 pnpm ui:shots before && pnpm ui:shots after
```

Tailwind scans this checkout's `src` for classes, so a class that exists only
in the base worktree may be missing from the "before" render.

## Adding a specimen

1. Write a component in `specimens.tsx` that renders the real thing inside
   `<Phone>`, and add it to `SPECIMENS`.
2. Add fixtures for any query it logs as missing, in `fixtures.ts`, keyed by
   Convex function name (`"jobs:get"`). Shape them like the query's return —
   read the query, don't guess.
3. Add it to `PLAN` in `shoot.mjs`, with a `before` step if it needs a tap or
   a wait to reach the state worth seeing.
